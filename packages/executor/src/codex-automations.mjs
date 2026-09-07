// Codex "automations" — recurring prompts attached to a specific thread.
//
// Verified against the real 0.144.6 binary: the *CLI* has no automation
// support at all. `automation.toml`, `target_thread_id`, `notification_policy`,
// `next_run`, `RRULE`/`FREQ`/`BYHOUR` all appear exactly 0 times in the native
// binary, and `automation`/`rrule`/`heartbeat` appear 0 times in the
// app-server JSON-RPC schema; the only hits for "automations" are prose inside
// the system prompt pointing at a docs anchor. `target_thread_id` *does* appear
// in /Applications/Codex.app/Contents/Resources/app.asar. So automations are a
// desktop-App-owned feature: `codex app-server` will never fire one, and a
// Codex agent can't create one mid-turn either.
//
// That makes this the mirror image of the claude side (see manager.mjs's CRON_*
// comment, where the agent writes jobs nothing reads). Here the files are
// written by the user in the desktop App, and AgentHub firing them is a genuine
// new capability: the machine keeps the user's automations running without the
// desktop App open, and pushes results to their phone.
//
// File layout: <CODEX_HOME>/automations/<slug>/automation.toml, e.g.
//   version = 1
//   id = "automation"
//   kind = "heartbeat"
//   name = "每日闲鱼订单记账"
//   prompt = "..."
//   status = "ACTIVE"
//   rrule = "FREQ=DAILY;BYHOUR=23;BYMINUTE=0;BYSECOND=0"
//   notification_policy = "failed_runs_only"
//   target_thread_id = "01a01d65-26bd-7881-a75e-fdd80e575457"
//   created_at = 1787304534204          # ms epoch
//   updated_at = 1787304534204
import fs from 'node:fs';
import path from 'node:path';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---- a deliberately tiny, deliberately strict TOML reader ----
// The real file is a flat table of scalars, so a full TOML implementation
// would be all risk and no benefit. Anything this doesn't recognise (a
// [section] header, an array, a multi-line string) makes the whole file
// unparseable rather than silently half-parsed — a half-read automation would
// run the user's real prompt on the wrong schedule.

function unescapeBasicString(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '"') out += '"';
    else if (n === '\\') out += '\\';
    else if (n === 'u' || n === 'U') {
      const len = n === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null;
      out += String.fromCodePoint(parseInt(hex, 16));
      i += len;
    } else return null;
  }
  return out;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"""') || s.startsWith("'''")) return { unsupported: true };
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) return { unsupported: true };
    const v = unescapeBasicString(s.slice(1, -1));
    return v === null ? { unsupported: true } : { value: v };
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return { unsupported: true };
    return { value: s.slice(1, -1) }; // literal string: no escapes at all
  }
  if (s === 'true') return { value: true };
  if (s === 'false') return { value: false };
  if (/^[+-]?\d+$/.test(s.replace(/_/g, ''))) return { value: Number(s.replace(/_/g, '')) };
  return { unsupported: true };
}

/** @returns {object|null} null = not a shape this reader is willing to guess at. */
export function parseAutomationToml(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) return null; // tables/array-of-tables: out of scope
    const eq = line.indexOf('=');
    if (eq < 1) return null;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
    // Strip a trailing comment only when it can't be inside a string.
    let valuePart = line.slice(eq + 1);
    const q = valuePart.trim()[0];
    if (q !== '"' && q !== "'") {
      const hash = valuePart.indexOf('#');
      if (hash >= 0) valuePart = valuePart.slice(0, hash);
    }
    const parsed = parseScalar(valuePart);
    if (parsed.unsupported) return null;
    out[key] = parsed.value;
  }
  return out;
}

// ---- RRULE (RFC 5545 §3.3.10), supported subset ----
//
// Supported: FREQ=MINUTELY|HOURLY|DAILY|WEEKLY, INTERVAL, BYMINUTE, BYHOUR,
// BYDAY (plain weekday codes only), UNTIL. BYSECOND is accepted and ignored —
// AgentHub's sweeper has minute granularity, and BYSECOND only refines *within*
// a minute, so ignoring it never changes which minutes fire.
//
// Everything else — FREQ=SECONDLY/MONTHLY/YEARLY, COUNT, BYMONTH, BYMONTHDAY,
// BYSETPOS, BYWEEKNO, BYYEARDAY, WKST, ordinal BYDAY like "2MO" — is
// deliberately *unsupported* rather than approximated. These prompts run real
// work on the user's own machine; firing one on a schedule we guessed at is
// worse than not firing it, so the caller surfaces a visible "skipped, and
// here's why" message instead. (COUNT specifically could only be honoured by
// enumerating every occurrence since the rule was created on every 60s sweep,
// which is why it's here rather than implemented.)
const SUPPORTED_FREQ = new Set(['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY']);

function parseNumberList(raw, min, max) {
  const out = new Set();
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < min || n > max) return null;
    out.add(n);
  }
  return out.size ? out : null;
}

/**
 * @returns {{freq:string, interval:number, byhour:Set<number>|null,
 *            byminute:Set<number>|null, byday:Set<string>|null,
 *            until:number|null} | {unsupported:string}}
 */
export function parseRrule(rrule) {
  if (typeof rrule !== 'string' || !rrule.trim()) return { unsupported: 'RRULE 为空' };
  // Some writers keep the content-line prefix ("RRULE:FREQ=DAILY;..."); the
  // observed files don't, but stripping it costs nothing.
  const body = rrule.trim().replace(/^RRULE:/i, '');
  const spec = { freq: null, interval: 1, byhour: null, byminute: null, byday: null, until: null };
  for (const part of body.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 1) return { unsupported: `无法解析的片段 "${part}"` };
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    switch (key) {
      case 'FREQ':
        if (!SUPPORTED_FREQ.has(val.toUpperCase())) return { unsupported: `不支持的 FREQ=${val}` };
        spec.freq = val.toUpperCase();
        break;
      case 'INTERVAL': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) return { unsupported: `不支持的 INTERVAL=${val}` };
        spec.interval = n;
        break;
      }
      case 'BYMINUTE': {
        const s = parseNumberList(val, 0, 59);
        if (!s) return { unsupported: `不支持的 BYMINUTE=${val}` };
        spec.byminute = s;
        break;
      }
      case 'BYHOUR': {
        const s = parseNumberList(val, 0, 23);
        if (!s) return { unsupported: `不支持的 BYHOUR=${val}` };
        spec.byhour = s;
        break;
      }
      case 'BYSECOND':
        break; // see the comment above: sub-minute only, safely ignorable
      case 'BYDAY': {
        const s = new Set();
        for (const d of val.split(',')) {
          const code = d.trim().toUpperCase();
          if (!DAY_CODES.includes(code)) return { unsupported: `不支持的 BYDAY=${val}` };
          s.add(code);
        }
        if (!s.size) return { unsupported: 'BYDAY 为空' };
        spec.byday = s;
        break;
      }
      case 'UNTIL': {
        const ms = parseUntil(val);
        if (ms === null) return { unsupported: `不支持的 UNTIL=${val}` };
        spec.until = ms;
        break;
      }
      default:
        return { unsupported: `不支持的 RRULE 组件 ${key}` };
    }
  }
  if (!spec.freq) return { unsupported: '缺少 FREQ' };
  return spec;
}

// "20260901T230000Z" (UTC) or "20260901T230000" / "20260901" (local).
function parseUntil(val) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(val.trim());
  if (!m) return null;
  const [, y, mo, d, hh = '23', mi = '59', ss = '59', z] = m;
  const nums = [Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)];
  const ms = z ? Date.UTC(...nums) : new Date(...nums).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Calendar-unit indices, computed from *local* components so an INTERVAL phase
// stays stable across DST transitions (a plain ms division would drift by an
// hour twice a year).
function dayIndex(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400_000);
}
function hourIndex(d) { return dayIndex(d) * 24 + d.getHours(); }
function minuteIndex(d) { return hourIndex(d) * 60 + d.getMinutes(); }

/**
 * Does `date`'s minute match? `anchorMs` supplies the DTSTART the automation
 * files don't carry — created_at, i.e. when the user made the rule — which is
 * what INTERVAL phases off and what fills in an omitted BYHOUR/BYMINUTE/BYDAY,
 * matching RFC 5545's "derive from DTSTART" default.
 */
export function rruleMatchesDate(spec, date, anchorMs) {
  if (!spec || spec.unsupported) return false;
  if (spec.until !== null && date.getTime() > spec.until) return false;
  const anchor = new Date(anchorMs);

  if (spec.byhour && !spec.byhour.has(date.getHours())) return false;
  if (spec.byminute && !spec.byminute.has(date.getMinutes())) return false;

  switch (spec.freq) {
    case 'MINUTELY': {
      if (spec.byday && !spec.byday.has(DAY_CODES[date.getDay()])) return false;
      if (spec.interval === 1) return true;
      const delta = minuteIndex(date) - minuteIndex(anchor);
      return delta >= 0 && delta % spec.interval === 0;
    }
    case 'HOURLY': {
      const minutes = spec.byminute ?? new Set([anchor.getMinutes()]);
      if (!minutes.has(date.getMinutes())) return false;
      if (spec.byday && !spec.byday.has(DAY_CODES[date.getDay()])) return false;
      if (spec.interval === 1) return true;
      const delta = hourIndex(date) - hourIndex(anchor);
      return delta >= 0 && delta % spec.interval === 0;
    }
    case 'DAILY': {
      const minutes = spec.byminute ?? new Set([anchor.getMinutes()]);
      const hours = spec.byhour ?? new Set([anchor.getHours()]);
      if (!minutes.has(date.getMinutes()) || !hours.has(date.getHours())) return false;
      if (spec.byday && !spec.byday.has(DAY_CODES[date.getDay()])) return false;
      if (spec.interval === 1) return true;
      const delta = dayIndex(date) - dayIndex(anchor);
      return delta >= 0 && delta % spec.interval === 0;
    }
    case 'WEEKLY': {
      const minutes = spec.byminute ?? new Set([anchor.getMinutes()]);
      const hours = spec.byhour ?? new Set([anchor.getHours()]);
      if (!minutes.has(date.getMinutes()) || !hours.has(date.getHours())) return false;
      const days = spec.byday ?? new Set([DAY_CODES[anchor.getDay()]]);
      if (!days.has(DAY_CODES[date.getDay()])) return false;
      if (spec.interval === 1) return true;
      // Weeks counted from the anchor's own weekday, so WKST never matters.
      const delta = Math.floor((dayIndex(date) - dayIndex(anchor)) / 7);
      return delta >= 0 && delta % spec.interval === 0;
    }
    default:
      return false;
  }
}

/** First minute boundary in (fromMs, toMs] the rule matches, or null. Mirrors
 *  manager.mjs's firstCronMatchIn, including its iteration cap. */
export function firstRruleMatchIn(spec, anchorMs, fromMs, toMs) {
  let t = (Math.floor(fromMs / 60_000) + 1) * 60_000;
  for (let i = 0; t <= toMs && i < 120_000; t += 60_000, i++) {
    if (rruleMatchesDate(spec, new Date(t), anchorMs)) return t;
  }
  return null;
}

// ---- reading the directory ----

export function automationsDir(codexHome) {
  return path.join(codexHome, 'automations');
}

/**
 * Every automation on this node, already validated. Entries that couldn't be
 * understood come back in `skipped` with a human-readable reason instead of
 * being silently dropped, so the caller can surface them once per task.
 * @returns {{jobs: Array<object>, skipped: Array<{id:string, reason:string}>}}
 */
export function readAutomations(codexHome) {
  const dir = automationsDir(codexHome);
  const jobs = [];
  const skipped = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { jobs, skipped }; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'automation.toml');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const raw = parseAutomationToml(text);
    if (!raw) { skipped.push({ id: ent.name, reason: '无法解析 automation.toml' }); continue; }
    const id = typeof raw.id === 'string' && raw.id ? raw.id : ent.name;
    if (raw.status && raw.status !== 'ACTIVE') continue; // paused/archived: not an error
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
      skipped.push({ id, reason: '缺少 prompt' });
      continue;
    }
    if (!raw.target_thread_id) { skipped.push({ id, reason: '没有绑定会话(target_thread_id)' }); continue; }
    // Only 'heartbeat' is known to mean "send this prompt to that thread on a
    // schedule". A future kind might mean something else entirely.
    if (raw.kind && raw.kind !== 'heartbeat') { skipped.push({ id, reason: `不支持的 kind=${raw.kind}` }); continue; }
    const spec = parseRrule(raw.rrule);
    if (spec.unsupported) { skipped.push({ id, reason: spec.unsupported }); continue; }
    jobs.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      prompt: raw.prompt,
      threadId: String(raw.target_thread_id),
      spec,
      createdAt: Number.isFinite(raw.created_at) ? raw.created_at : null,
    });
  }
  return { jobs, skipped };
}
