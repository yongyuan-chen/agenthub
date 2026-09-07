// Codex automations are files the user wrote in the desktop App; AgentHub fires
// them on the server so they keep running with the App closed. That makes every
// mistake here a *real* prompt running on the user's machine at the wrong time,
// which is why the parser refuses to guess: the assertions below are as much
// about what is rejected as about what fires.
//
// All dates are built with the local-time Date constructor, so these hold in any
// timezone — the matcher works off local calendar components on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseAutomationToml,
  parseRrule,
  rruleMatchesDate,
  firstRruleMatchIn,
  readAutomations,
  automationsDir,
} from '../packages/executor/src/codex-automations.mjs';

// A rule plus the anchor (created_at) it phases off, since the files carry no
// DTSTART and RFC 5545 derives the omitted BY* parts from it.
function rule(rrule, anchor = new Date(2026, 0, 1, 9, 30).getTime()) {
  const spec = parseRrule(rrule);
  assert.equal(spec.unsupported, undefined, `expected ${rrule} to be supported: ${spec.unsupported}`);
  return (...dateArgs) => rruleMatchesDate(spec, new Date(...dateArgs), anchor);
}

// ---- TOML ----

test('parseAutomationToml reads the real file shape', () => {
  const parsed = parseAutomationToml(`
version = 1
id = "automation"
kind = "heartbeat"
name = "每日闲鱼订单记账"
prompt = "把今天的订单记到账本里"
status = "ACTIVE"
rrule = "FREQ=DAILY;BYHOUR=23;BYMINUTE=0;BYSECOND=0"
notification_policy = "failed_runs_only"
target_thread_id = "01a01d65-26bd-7881-a75e-fdd80e575457"
created_at = 1787304534204
updated_at = 1787304534204
`);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.name, '每日闲鱼订单记账');
  assert.equal(parsed.created_at, 1787304534204);
  assert.equal(parsed.target_thread_id, '01a01d65-26bd-7881-a75e-fdd80e575457');
});

test('parseAutomationToml handles comments, escapes and literal strings', () => {
  const parsed = parseAutomationToml([
    '# leading comment',
    'version = 1 # trailing comment on a bare value',
    'prompt = "第一行\\n第二行\\u0021"',
    // A literal string: \n and \t stay two characters each, and the # is data.
    "literal = 'C:\\new\\table # not a comment'",
    'flag = true',
    'neg = -3',
  ].join('\n'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.prompt, '第一行\n第二行!');
  assert.equal(parsed.literal, 'C:\\new\\table # not a comment');
  assert.equal(parsed.flag, true);
  assert.equal(parsed.neg, -3);
});

test('parseAutomationToml refuses shapes it would have to guess at', () => {
  // Half-reading a file would run the user's real prompt on a schedule that
  // came from whichever half parsed. Whole-file rejection is the safe failure.
  assert.equal(parseAutomationToml('[schedule]\nrrule = "FREQ=DAILY"'), null, 'table header');
  assert.equal(parseAutomationToml('days = [1, 2, 3]'), null, 'array');
  assert.equal(parseAutomationToml('prompt = """\nmulti\n"""'), null, 'multi-line string');
  assert.equal(parseAutomationToml('prompt = 1.5'), null, 'float');
  assert.equal(parseAutomationToml('created_at = 2026-01-01T00:00:00Z'), null, 'datetime');
  assert.equal(parseAutomationToml('just a line'), null, 'no assignment');
  assert.equal(parseAutomationToml('prompt = "unterminated'), null, 'unterminated string');
  assert.equal(parseAutomationToml('prompt = "bad \\q escape"'), null, 'unknown escape');
});

// ---- RRULE parsing ----

test('parseRrule accepts the documented subset', () => {
  assert.deepEqual(parseRrule('FREQ=DAILY;BYHOUR=23;BYMINUTE=0;BYSECOND=0'), {
    freq: 'DAILY', interval: 1, byhour: new Set([23]), byminute: new Set([0]), byday: null, until: null,
  });
  assert.deepEqual(parseRrule('RRULE:FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=2').byday, new Set(['MO', 'FR']));
  assert.equal(parseRrule('FREQ=WEEKLY;INTERVAL=2').interval, 2);
  assert.equal(parseRrule('freq=hourly').freq, 'HOURLY', 'component names are case-insensitive');
});

test('parseRrule rejects anything it would have to approximate, with a reason', () => {
  // The reason is surfaced to the user as a visible event, so it has to name
  // the actual component rather than just failing.
  const cases = [
    ['FREQ=MONTHLY', /FREQ=MONTHLY/],
    ['FREQ=YEARLY', /FREQ=YEARLY/],
    ['FREQ=SECONDLY', /FREQ=SECONDLY/],
    // COUNT would mean enumerating every occurrence since created_at on every
    // 60s sweep just to know whether the budget is spent.
    ['FREQ=DAILY;COUNT=5', /COUNT/],
    ['FREQ=MONTHLY;BYMONTHDAY=1', /FREQ=MONTHLY/],
    ['FREQ=DAILY;BYSETPOS=-1', /BYSETPOS/],
    ['FREQ=WEEKLY;WKST=MO', /WKST/],
    ['FREQ=WEEKLY;BYDAY=2MO', /BYDAY/],
    ['FREQ=DAILY;BYHOUR=24', /BYHOUR/],
    ['FREQ=DAILY;BYMINUTE=60', /BYMINUTE/],
    ['FREQ=DAILY;INTERVAL=0', /INTERVAL/],
    ['FREQ=DAILY;UNTIL=next tuesday', /UNTIL/],
    ['BYHOUR=9', /FREQ/],
    ['', /空/],
    ['FREQ=DAILY;garbage', /garbage/],
  ];
  for (const [rrule, pattern] of cases) {
    const spec = parseRrule(rrule);
    assert.ok(spec.unsupported, `${rrule} should be unsupported`);
    assert.match(spec.unsupported, pattern);
  }
});

// ---- matching ----

test('DAILY at a fixed hour:minute fires on exactly that minute', () => {
  const m = rule('FREQ=DAILY;BYHOUR=23;BYMINUTE=0;BYSECOND=0');
  assert.equal(m(2026, 8, 1, 23, 0), true);
  assert.equal(m(2026, 8, 2, 23, 0), true, 'every day');
  assert.equal(m(2026, 8, 1, 23, 1), false);
  assert.equal(m(2026, 8, 1, 22, 0), false);
  // BYSECOND only refines within a minute, and the sweeper has minute
  // granularity — so it must not change which minutes match.
  assert.equal(m(2026, 8, 1, 23, 0, 45), true);
});

test('omitted BY* parts come from created_at, per RFC 5545 DTSTART defaults', () => {
  const m = rule('FREQ=DAILY'); // anchor is 09:30 local
  assert.equal(m(2026, 5, 10, 9, 30), true);
  assert.equal(m(2026, 5, 10, 9, 31), false);
  assert.equal(m(2026, 5, 10, 10, 30), false);

  const hourly = rule('FREQ=HOURLY');
  assert.equal(hourly(2026, 5, 10, 3, 30), true, 'the anchor supplies the minute, not the hour');
  assert.equal(hourly(2026, 5, 10, 3, 0), false);

  const weekly = rule('FREQ=WEEKLY'); // 2026-01-01 is a Thursday
  assert.equal(weekly(2026, 0, 8, 9, 30), true);
  assert.equal(weekly(2026, 0, 7, 9, 30), false, 'a Wednesday');
});

test('INTERVAL phases off the anchor and never fires before it', () => {
  const anchor = new Date(2026, 0, 1, 9, 30).getTime();
  const m = rule('FREQ=DAILY;INTERVAL=3', anchor);
  assert.equal(m(2026, 0, 1, 9, 30), true, 'the anchor day itself');
  assert.equal(m(2026, 0, 2, 9, 30), false);
  assert.equal(m(2026, 0, 4, 9, 30), true);
  assert.equal(m(2025, 11, 29, 9, 30), false, 'before the rule existed');

  const every2w = rule('FREQ=WEEKLY;BYDAY=TH;INTERVAL=2', anchor);
  assert.equal(every2w(2026, 0, 1, 9, 30), true);
  assert.equal(every2w(2026, 0, 8, 9, 30), false);
  assert.equal(every2w(2026, 0, 15, 9, 30), true);

  const every15m = rule('FREQ=MINUTELY;INTERVAL=15', anchor);
  assert.equal(every15m(2026, 0, 1, 10, 0), true);
  assert.equal(every15m(2026, 0, 1, 10, 5), false);
  assert.equal(every15m(2026, 0, 1, 10, 45), true);
});

test('UNTIL stops the rule', () => {
  const m = rule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260901T235959Z');
  assert.equal(m(2026, 7, 31, 9, 0), true);
  assert.equal(m(2026, 8, 3, 9, 0), false);

  const localUntil = rule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260901');
  assert.equal(localUntil(2026, 8, 1, 9, 0), true, 'a bare date means end of that local day');
  assert.equal(localUntil(2026, 8, 2, 9, 0), false);
});

test('BYDAY restricts weekdays across frequencies', () => {
  const workdays = rule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0');
  assert.equal(workdays(2026, 0, 5, 9, 0), true, 'Monday');
  assert.equal(workdays(2026, 0, 10, 9, 0), false, 'Saturday');
});

test('an unsupported rule matches nothing rather than approximating', () => {
  assert.equal(rruleMatchesDate(parseRrule('FREQ=MONTHLY'), new Date(2026, 0, 1, 9, 30), Date.now()), false);
  assert.equal(rruleMatchesDate(null, new Date(), Date.now()), false);
});

test('firstRruleMatchIn finds the next minute boundary in an open-closed window', () => {
  const anchor = new Date(2026, 0, 1, 9, 30).getTime();
  const spec = parseRrule('FREQ=DAILY;BYHOUR=23;BYMINUTE=0');
  const from = new Date(2026, 8, 1, 22, 30).getTime();
  const to = new Date(2026, 8, 1, 23, 30).getTime();
  assert.equal(firstRruleMatchIn(spec, anchor, from, to), new Date(2026, 8, 1, 23, 0).getTime());

  // Exclusive lower bound: the minute already swept must not fire twice.
  const at23 = new Date(2026, 8, 1, 23, 0).getTime();
  assert.equal(firstRruleMatchIn(spec, anchor, at23, new Date(2026, 8, 1, 23, 59).getTime()), null);
  assert.equal(firstRruleMatchIn(spec, anchor, from, new Date(2026, 8, 1, 22, 45).getTime()), null);
});

// ---- reading the directory ----

function makeHome(automations) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-home-'));
  for (const [slug, body] of Object.entries(automations)) {
    const dir = path.join(automationsDir(home), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'automation.toml'), body);
  }
  return home;
}

const ok = (over = {}) => Object.entries({
  id: '"a1"',
  kind: '"heartbeat"',
  name: '"每日记账"',
  prompt: '"记账"',
  status: '"ACTIVE"',
  rrule: '"FREQ=DAILY;BYHOUR=23;BYMINUTE=0;BYSECOND=0"',
  target_thread_id: '"th-1"',
  created_at: '1787304534204',
  ...over,
}).filter(([, v]) => v !== null).map(([k, v]) => `${k} = ${v}`).join('\n');

test('readAutomations returns usable jobs and names why the rest were skipped', () => {
  const home = makeHome({
    good: ok(),
    paused: ok({ id: '"paused"', status: '"PAUSED"' }),
    noprompt: ok({ id: '"noprompt"', prompt: null }),
    nothread: ok({ id: '"nothread"', target_thread_id: null }),
    otherkind: ok({ id: '"otherkind"', kind: '"something-else"' }),
    monthly: ok({ id: '"monthly"', rrule: '"FREQ=MONTHLY;BYMONTHDAY=1"' }),
    broken: '[schedule]\nrrule = "FREQ=DAILY"',
  });

  const { jobs, skipped } = readAutomations(home);

  assert.deepEqual(jobs.map(j => j.id), ['a1']);
  assert.equal(jobs[0].name, '每日记账');
  assert.equal(jobs[0].prompt, '记账');
  assert.equal(jobs[0].threadId, 'th-1');
  assert.equal(jobs[0].createdAt, 1787304534204);
  assert.equal(rruleMatchesDate(jobs[0].spec, new Date(2026, 8, 1, 23, 0), jobs[0].createdAt), true);

  const reasons = Object.fromEntries(skipped.map(s => [s.id, s.reason]));
  // A paused automation is a normal state, not a problem to report.
  assert.equal('paused' in reasons, false);
  assert.match(reasons.noprompt, /prompt/);
  assert.match(reasons.nothread, /target_thread_id/);
  assert.match(reasons.otherkind, /kind=something-else/);
  assert.match(reasons.monthly, /FREQ=MONTHLY/);
  assert.match(reasons.broken, /无法解析/);
});

test('readAutomations tolerates a node with no automations at all', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-home-'));
  assert.deepEqual(readAutomations(empty), { jobs: [], skipped: [] });
  assert.deepEqual(readAutomations(path.join(empty, 'nope')), { jobs: [], skipped: [] });

  // Stray files next to the automation directories must not become entries.
  const home = makeHome({ good: ok() });
  fs.writeFileSync(path.join(automationsDir(home), 'README.md'), 'hi');
  fs.mkdirSync(path.join(automationsDir(home), 'no-toml'));
  const { jobs, skipped } = readAutomations(home);
  assert.deepEqual(jobs.map(j => j.id), ['a1']);
  assert.deepEqual(skipped, []);
});
