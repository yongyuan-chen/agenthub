// Which agent CLI this machine has, at what version, and how to move it
// forward. Exists because "installed or not" turned out to be the wrong
// question: a CLI old enough still runs, still reports healthy, and still
// accepts work — it just builds request bodies the current models reject.
// Found live 2026-09-24: a node sitting on claude 2.1.105 answered every
// `claude-opus-5-5` turn with
//   400 claude-opus-5-5 requires adaptive thinking; omit thinking or use
//       thinking.type=adaptive and output_config.effort
// AgentHub never sends a `thinking` block (session.mjs only sets
// ANTHROPIC_BASE_URL/API_KEY/MODEL) — the CLI builds it, so nothing on this
// side could fix it and nothing on this side could even *see* it. Hence:
// probe the version, report it, and keep it current.
//
// Upgrades always go through the CLI's own `update` subcommand rather than a
// package manager. How these binaries got installed varies per machine and
// per backend — this repo's own dev box has claude as a native build in
// ~/.local/bin and codex as an npm global under nvm, where `npm i -g` would
// be right for exactly one of them — and both CLIs ship `update`, which
// knows its own install layout. Guessing the installer is how you end up
// with two claudes on a PATH.
import { spawn, spawnSync } from 'node:child_process';
// Version parsing/comparison lives in shared/ so the UI reaches the same
// verdict this module does about what "behind" means — see the comment there.
import { parseVersion, isOutdated, BACKENDS } from '../../shared/protocol.mjs';

export { parseVersion, isOutdated };
export { compareVersions } from '../../shared/protocol.mjs';

// Long enough for a cold download over a slow link, bounded so a hung
// installer can't wedge the check loop forever.
export const UPGRADE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

// shell:true on Windows for the .cmd-shim reason session.mjs already spawns
// that way; `bin` comes from this node's own config file, never the wire.
function spawnOpts(timeout) {
  return {
    encoding: 'utf8', timeout,
    shell: process.platform === 'win32',
    maxBuffer: 4 * 1024 * 1024,
  };
}

// {installed, version, output}. installed/version are independent on purpose:
// a CLI that runs but prints something we can't parse is still installed and
// still dispatchable — it just can't be told apart from the latest release, so
// the upgrade logic leaves it alone.
//
// `output` is whatever the probe printed, kept even (especially) when the probe
// failed. Dropping it is how a broken CLI stays broken silently: on 2026-09-25
// a codex upgrade on win10 left the package without its platform binary, so
// `codex --version` died with "Missing optional dependency
// @openai/codex-win32-x64", and with nothing but installed:false to go on the
// upgrade was filed as a success. Five days later the only visible symptom was
// that the node had quietly stopped offering the codex backend.
export function probeCli(bin, { exec = spawnSync } = {}) {
  let r;
  try { r = exec(bin, ['--version'], spawnOpts(PROBE_TIMEOUT_MS)); }
  catch (e) { return { installed: false, version: null, output: e.message }; }
  const output = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.trim();
  if (!r || r.error || r.status !== 0) {
    return { installed: false, version: null, output: output || r?.error?.message || '' };
  }
  return { installed: true, version: parseVersion(output), output };
}

export function binFor(config, backend) {
  return backend === 'codex' ? (config.codexBin || 'codex') : (config.claudeBin || 'claude');
}

export function probeAllClis(config, { exec = spawnSync } = {}) {
  const out = {};
  for (const backend of BACKENDS) out[backend] = probeCli(binFor(config, backend), { exec });
  return out;
}

// Process-level cache, for the same reason availableBackends() has always had
// one: spawning two `--version` calls on every reconnect is wasteful and, on
// a flapping connection, noisy. Unlike before, it can be invalidated — an
// upgrade we just ran ourselves is exactly the case where "probed once at
// boot" would report a stale number forever.
let _cache = null;
export function cliState(config, { exec = spawnSync } = {}) {
  if (!_cache) _cache = probeAllClis(config, { exec });
  return _cache;
}
export function refreshCliState(config, { exec = spawnSync } = {}) {
  _cache = probeAllClis(config, { exec });
  return _cache;
}
export function resetCliStateCache() { _cache = null; }

// {claude:'2.1.105'} — installed-but-unparsable shows up as null rather than
// being dropped, so the UI can say "已安装,版本未知" instead of "未安装".
export function cliVersions(config, opts) {
  const state = cliState(config, opts);
  const out = {};
  for (const [backend, info] of Object.entries(state)) {
    if (info.installed) out[backend] = info.version;
  }
  return out;
}

// Async, unlike the probe above, and that is not a stylistic choice: an
// installer can legitimately run for minutes, and spawnSync would block the
// daemon's event loop for all of it — no heartbeats, so the cloud marks the
// node offline (and the UI shows it as dead) in the middle of an upgrade the
// user just asked for.
export function runUpgrade(bin, { spawnImpl = spawn, timeoutMs = UPGRADE_TIMEOUT_MS, args = ['update'] } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (e) { resolve({ ok: false, output: e.message }); return; }

    let out = '';
    // Keep only the tail: an installer that decides to print a progress bar
    // byte-by-byte shouldn't be able to grow this without bound, and the end
    // is where the error message is anyway.
    const capture = (d) => { out = `${out}${d}`.slice(-100_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, output: out.trim() || `升级超时(${Math.round(timeoutMs / 60_000)} 分钟)` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('error', e => finish({ ok: false, output: out.trim() || e.message }));
    child.on('close', code => finish(code === 0
      ? { ok: true, output: out.trim() }
      : { ok: false, output: out.trim() || `exit code ${code}` }));
  });
}

// Some machines simply cannot be upgraded along the path `update` picks for
// them. Measured across the live fleet on 2026-09-24 — four of five nodes
// failed, in exactly two classes:
//   • claude installed into a root-owned npm prefix (/usr) while the executor
//     runs as an ordinary user: "npm global folder isn't writable", or EACCES
//     renaming under /usr/lib/node_modules.
//   • the npm registry not reachable from that network at all: "Unable to
//     fetch latest version from npm registry".
// Both are properties of the *npm* path, not of the machine. `claude install`
// sidesteps both — it pulls a native build from Anthropic's own CDN into
// ~/.local, no package manager and no sudo — and in the first case it is
// literally what the CLI's own error text tells you to run. The one node that
// upgraded cleanly was already on that native layout, which is the evidence
// this fallback is built on.
//
// claude-only, and not by preference: codex ships `update` but has no
// `install` subcommand (verified against codex 0.147.0), so there is no
// equivalent escape hatch to offer it.
const NATIVE_FALLBACK_PATTERNS = [
  /npm global folder isn'?t writable/i,
  /EACCES/i,
  /permission denied/i,
  /unable to fetch latest version from npm/i,
  /failed to check for updates/i,
];
export function shouldTryNativeInstall(backend, output) {
  if (backend !== 'claude') return false;
  const text = String(output ?? '');
  return NATIVE_FALLBACK_PATTERNS.some(re => re.test(text));
}

// Only used to make one specific failure legible: when the native install
// reports success but the version on PATH doesn't move, something earlier on
// PATH is shadowing the new binary, and the user needs to know which file.
function resolveBin(bin, { exec = spawnSync } = {}) {
  try {
    const r = exec(process.platform === 'win32' ? 'where' : 'which', [bin], spawnOpts(PROBE_TIMEOUT_MS));
    if (r && !r.error && r.status === 0) return String(r.stdout ?? '').trim().split(/\r?\n/)[0] || null;
  } catch { /* not resolvable — the message just omits the path */ }
  return null;
}

// Keep whatever the CLI printed short enough to travel on the wire and read
// as one line in a modal — the user needs the actionable part, not the whole
// installer log.
function briefError(output, fallback = '升级失败,CLI 没有给出原因') {
  const text = String(output ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : (text || fallback);
}

// ---- the upgrade loop ----
//
// The cloud decides *what* the latest version is and *whether* this node is
// allowed to chase it; this class decides *when*. That split is deliberate:
// only the cloud can reach the npm registry cheaply and cache one answer for
// every node (nodes in China reach the registry unreliably, and a per-node
// poll would be N times the traffic for one number), while only the node
// knows whether a turn is mid-generation right now.
//
// Idle-gating matches selfupdate.mjs exactly, and for a stronger reason:
// replacing a binary that a live `claude` process is executing is undefined
// on POSIX and simply refused on Windows. A busy node marks the upgrade
// `pending` and retries on the next tick rather than dropping the request.
export class CliUpgrader {
  /**
   * @param {object} opts
   * @param {object} opts.config          executor config (claudeBin/codexBin)
   * @param {() => boolean} opts.isIdle   false while any turn is generating
   * @param {(payload: object) => void} opts.report  sends {versions, upgrade} to the cloud
   */
  constructor({ config, isIdle, report, exec = spawnSync, spawnImpl = spawn, log = console.log, now = Date.now }) {
    this.config = config;
    this.isIdle = isIdle;
    this.report = report;
    this.exec = exec;              // sync, for `--version` probes
    this.spawnImpl = spawnImpl;    // async, for the installer itself
    this.log = log;
    this.now = now;
    // Cloud-owned policy. Until the first hello_ok lands we know no target
    // version, and isOutdated(x, null) is false — so a node that has never
    // heard from the cloud upgrades nothing, which is the right default.
    this.latest = {};
    this.autoUpgrade = true;
    this.upgrades = {};           // backend -> {state, error?, from?, to?, at}
    this.pending = new Set();     // backends waiting for the node to go idle
    this.running = false;         // one installer at a time, node-wide
    this.lastAutoCheckAt = 0;
  }

  versions() { return cliVersions(this.config, { exec: this.exec }); }

  // Everything the cloud stores about this node's CLIs, in the one shape the
  // wire uses. Sent on hello and again whenever any of it changes.
  snapshot() {
    return { versions: this.versions(), upgrades: this.upgrades };
  }

  _publish() {
    try { this.report?.(this.snapshot()); } catch { /* offline: hello will carry it */ }
  }

  _setState(backend, patch) {
    this.upgrades[backend] = { ...patch, at: this.now() };
    this._publish();
  }

  // Cloud policy push (hello_ok, or a live cli_policy). Applying a newly
  // raised target immediately is the point: a node that stays connected for
  // days would otherwise never notice a release.
  setPolicy({ latest, autoUpgrade }) {
    if (latest && typeof latest === 'object') this.latest = latest;
    if (typeof autoUpgrade === 'boolean') this.autoUpgrade = autoUpgrade;
    this.lastAutoCheckAt = 0;   // re-evaluate against the new policy now
    return this.tick();
  }

  // Which backends are installed, known-versioned, and behind the target.
  outdatedBackends() {
    const versions = this.versions();
    return Object.keys(versions).filter(b => isOutdated(versions[b], this.latest[b]));
  }

  // Manual "立即升级" from the UI. Queues rather than refuses when busy —
  // the button's promise to the user is "this will happen", and a node in the
  // middle of a turn is the common case, not an error.
  request(backend) {
    if (backend && !BACKENDS.includes(backend)) return;
    const targets = backend ? [backend] : Object.keys(this.versions());
    for (const b of targets) {
      if (!this.versions()[b] && !this.cliInstalled(b)) {
        this._setState(b, { state: 'failed', error: `这个节点上没有安装 ${b} CLI` });
        continue;
      }
      this.pending.add(b);
      this._setState(b, { state: 'pending' });
    }
    return this._kick();
  }

  cliInstalled(backend) {
    return !!cliState(this.config, { exec: this.exec })[backend]?.installed;
  }

  // Called from the daemon's existing self-update timer. Rate-limited on its
  // own clock so the CLI check runs far less often than the code check: a
  // release is a once-a-day event at most, and each check costs two spawns.
  tick({ minIntervalMs = 30 * 60_000 } = {}) {
    if (this.autoUpgrade && this.now() - this.lastAutoCheckAt >= minIntervalMs) {
      this.lastAutoCheckAt = this.now();
      for (const backend of this.outdatedBackends()) {
        if (this.upgrades[backend]?.state === 'running') continue;
        this.pending.add(backend);
        if (this.upgrades[backend]?.state !== 'pending') this._setState(backend, { state: 'pending' });
      }
    }
    return this._kick();
  }

  // Fire-and-forget entry point for everything that isn't a test: an
  // installer runs for minutes and no caller should wait on it, but a
  // rejection still has to land somewhere other than 'unhandledRejection'.
  _kick() {
    const p = this._drain();
    if (p) p.catch(e => this.log(`[cli] upgrade crashed: ${e.message}`));
    return p;
  }

  // Returns the in-flight upgrade promise (or null) so tests can await it.
  _drain() {
    if (this.running || !this.pending.size) return null;
    if (!this.isIdle()) return null;   // next tick, once the turn finishes
    const backend = [...this.pending][0];
    this.pending.delete(backend);
    return this._upgrade(backend);
  }

  async _upgrade(backend) {
    const bin = binFor(this.config, backend);
    const from = this.versions()[backend] ?? null;
    const to = this.latest[backend] ?? null;
    // Node-wide rather than per backend: two installers racing for the same
    // npm prefix (or the same ~/.local/bin) is a good way to end up with
    // neither CLI working.
    this.running = true;
    this._setState(backend, { state: 'running', from, to });
    this.log(`[cli] upgrading ${backend} ${from ?? '?'} -> ${to ?? 'latest'} (${bin} update)`);
    let result;
    let viaNative = false;
    try {
      result = await runUpgrade(bin, { spawnImpl: this.spawnImpl });
      if (!result.ok && shouldTryNativeInstall(backend, result.output)) {
        this.log(`[cli] ${backend} update blocked (${briefError(result.output)}) — retrying with the native installer`);
        viaNative = true;
        // `stable`, not `latest`: the same channel the cloud computes the
        // target from, so a node that lands here ends up on the exact version
        // the UI has been promising rather than a few releases past it.
        const native = await runUpgrade(bin, { spawnImpl: this.spawnImpl, args: ['install', 'stable'] });
        // When the fallback fails too, lead with the original error: it is
        // the one that explains why the normal path was unavailable at all.
        result = native.ok ? native : { ok: false, output: `${result.output}\n---\n${native.output}` };
      }
    } catch (e) {
      result = { ok: false, output: e.message };
    } finally {
      // Whatever happened, the version on disk is now unknown — re-probe
      // instead of trusting either the old cache or the target number. An
      // update that reported success but installed something unexpected
      // still gets reported honestly.
      refreshCliState(this.config, { exec: this.exec });
      this.running = false;
    }
    const after = this.versions()[backend] ?? null;
    if (result.ok && viaNative && from !== null && after === from) {
      // The native build installed fine, but this PATH still resolves the old
      // copy — the usual shape is an npm global in /usr/bin ahead of the fresh
      // ~/.local/bin one. Calling that "ok" would park the node on a version
      // the UI reports as current while it keeps sending the request bodies
      // this whole feature exists to stop sending.
      const where = resolveBin(bin, { exec: this.exec });
      const error = `原生安装成功,但 PATH 里仍然是旧版 ${after}${where ? `(${where})` : ''}`
        + ' — 把 ~/.local/bin 排到 PATH 前面,或删掉这个旧文件';
      this.log(`[cli] ${backend} ${error}`);
      this._setState(backend, { state: 'failed', error, from, to });
    } else if (result.ok && after === null) {
      // The installer said it succeeded and then the CLI couldn't tell us what
      // version it is. Reporting that as `ok` is what let win10 sit on a
      // codex install with a missing platform binary from 2026-09-25 to 09-29:
      // the record read state:"ok" with no `to` at all, which is a success
      // nobody can verify. An upgrade is only `ok` if the thing it upgraded
      // still answers `--version`.
      const probe = cliState(this.config, { exec: this.exec })[backend];
      const error = probe?.installed
        ? `升级后读不出版本号,${bin} --version 输出:${briefError(probe.output, '(空)')}`
        : `升级后 ${bin} 已无法运行:${briefError(probe?.output, '--version 退出码非 0,且没有输出')}`;
      this.log(`[cli] ${backend} ${error}`);
      this._setState(backend, { state: 'failed', error, from, to });
    } else if (result.ok) {
      this.log(`[cli] ${backend} is now ${after}${viaNative ? ' (native installer)' : ''}`);
      this._setState(backend, { state: 'ok', from, to: after });
    } else {
      this.log(`[cli] ${backend} upgrade failed: ${result.output}`);
      this._setState(backend, { state: 'failed', error: briefError(result.output), from, to });
    }
    await this._drain();
  }
}
