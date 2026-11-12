#!/usr/bin/env node
// Team for Claude Code
// Copyright 2026 Mohammed Abdo. Licensed under the Apache License 2.0 (see LICENSE and NOTICE).
// https://github.com/Engmohammedabdo/team
//
// team.mjs — runs the Claude + Codex team for the `team` skill.
//
// The coordinator (a Claude Code session following SKILL.md) calls these commands.
// The two colleagues are separate headless sessions (`claude -p` and `codex exec`);
// this script starts and resumes them, keeps their conversations, logs everything
// under .team/runs/<id>/, and handles git worktrees for parallel work.
// Every command prints a single JSON object.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SCRIPT), '..');
const PROMPTS_DIR = path.join(SKILL_DIR, 'prompts');
const IS_WIN = process.platform === 'win32';

// Who made this. It travels with every run (state.json), every merge commit and every report.
const ORIGIN = Object.freeze({
  name: 'Team for Claude Code',
  author: 'Mohammed Abdo',
  url: 'https://github.com/Engmohammedabdo/team',
  id: 'tm-6427816b',
});
const SIGNATURE = {
  ar: `اتعمل بـ ${ORIGIN.name} من ${ORIGIN.author} · ${ORIGIN.url}`,
  en: `Made with ${ORIGIN.name} by ${ORIGIN.author} · ${ORIGIN.url}`,
};

const DEFAULT_WAIT_SEC = 540; // stays under the 10-minute tool timeout
const MAX_REVIEW_ROUNDS = 3;
const AGENTS = ['claude', 'codex'];
const OTHER = { claude: 'codex', codex: 'claude' };
const NAME = { claude: 'Claude', codex: 'Codex' };
const LENS = {
  claude:
    'product and architecture: user experience, scope, overall structure, module boundaries, naming and API ergonomics, maintainability',
  codex:
    'engineering and reliability: implementation feasibility, performance, edge cases, error handling, security, data integrity, testing strategy',
};
const TIMEOUT_MIN = {
  propose: 30, critique: 30, draft: 30, signoff: 20, revise: 30, edits: 30,
  implement: 90, review: 30, fix: 60, consult: 20, ask: 60,
};

// Shell commands a Claude colleague may run in read-only steps (reviewers may run tests).
const CLAUDE_READ_ALLOW = [
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git ls-files*)',
  'Bash(git rev-parse*)', 'Bash(git branch*)', 'Bash(ls*)',
  'Bash(npm test*)', 'Bash(npm run test*)', 'Bash(npm run lint*)', 'Bash(npm run build*)', 'Bash(npm run typecheck*)',
  'Bash(node --test*)', 'Bash(npx vitest*)', 'Bash(npx jest*)', 'Bash(npx tsc*)', 'Bash(pnpm test*)', 'Bash(yarn test*)',
  'Bash(pytest*)', 'Bash(python -m pytest*)', 'Bash(go test*)', 'Bash(cargo test*)',
];

// Session/desktop variables that must not leak into the colleagues' own sessions.
const KEEP_ENV = new Set([
  'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);
const DROP_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_PREVIEW_|CODEX_THREAD_ID$|CODEX_SANDBOX)/;

const USAGE = `node team.mjs <command> [options]   (run from the project root; --run <dir> picks a run explicitly)
  doctor                                   check git, Claude CLI, Codex CLI
  new --request-file <f|-> --title <slug> [--lang Arabic] [--quick | --small [--implementer codex|claude] [--setup cmd] [--verify cmd]]
  propose | critique | draft | signoff | revise           discussion rounds (--quick: propose, draft)
  edits --file <f|->                        drafter applies the owner's decisions to design.md
  plan                                      parse the team-plan block of design.md
  prepare [--snapshot]                      one git worktree + branch per lane, run setup
  implement [--lane id]                     lanes build in parallel
  review [--lane id] [--force]              each lane reviewed by the other agent
  fix --lane id [--lane id] [--input-file f]  implementer addresses the review (or an agreed change)
  consult --lane id [--issue-file f|-]      the other agent weighs in on a DESIGN_ISSUE
  ask --agent claude|codex --mode read|write --cwd repo|lane:<id>|<dir> --prompt-file <f|->
      [--thread name] [--attach file]... [--out rel.md] [--title "transcript title"]
  merge [--continue]                        squash-merge each lane into the current branch
  verify [--lane id]                        run the plan's verify commands
  finish [--keep]                           remove worktrees and branches, mark the run done
  status                                    where the run is and what comes next
  wait [--max seconds]                      wait for the colleagues currently working
  serve [--port 4477] [--open]              live web view of the team for the owner (keeps running)
Steps that start colleagues wait up to ${DEFAULT_WAIT_SEC}s (change with --wait N); if "state" is "running", call wait.`;

// ---------------------------------------------------------------- basics

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(message, extra = {}) {
  emit({ ok: false, error: message, ...extra });
  process.exit(1);
}

function now() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write with retries: readers (the wait poller) may hold the file briefly on Windows.
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = JSON.stringify(obj, null, 2);
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (e) {
      if (i >= 40) {
        fs.writeFileSync(p, data);
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return;
      }
      sleepSync(50);
    }
  }
}

function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function readInput(spec, what) {
  if (!spec || spec === true) fail(`Missing ${what}`);
  if (spec === '-') return fs.readFileSync(0, 'utf8');
  const p = path.resolve(String(spec));
  if (!fs.existsSync(p)) fail(`File not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

function list(v) {
  if (v === undefined || v === null || v === true) return [];
  return [].concat(v).map(String);
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      let key = a.slice(2);
      let val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !(argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) {
        val = argv[++i];
      }
      opt[key] = opt[key] === undefined ? val : [].concat(opt[key], val);
    } else {
      pos.push(a);
    }
  }
  return { pos, opt };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function isArabic(text) {
  return /[؀-ۿ]/.test(text || '');
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// Drives without ownership info (exFAT, FAT32, some network shares) make git refuse to work
// ("dubious ownership"). When that happens we allow it for this process and the colleagues'
// processes only, through GIT_CONFIG_* variables; the owner's git config is never changed.
let GIT_SAFE = false;

function withGitSafe(env) {
  if (!GIT_SAFE) return env;
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'safe.directory',
    [`GIT_CONFIG_VALUE_${n}`]: '*',
  };
}

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (!KEEP_ENV.has(k) && DROP_ENV.test(k)) delete env[k];
  }
  return withGitSafe(env);
}

// ---------------------------------------------------------------- git

function git(cwd, args, { allowFail = false } = {}) {
  const runGit = () =>
    spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: withGitSafe(process.env) });
  let r = runGit();
  if (r.error) throw r.error;
  if (r.status !== 0 && !GIT_SAFE && /dubious ownership/i.test(r.stderr || '')) {
    GIT_SAFE = true;
    r = runGit();
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function repoRoot(dir) {
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.code === 0 && r.out ? path.resolve(r.out) : null;
}

function identityArgs(cwd) {
  const email = git(cwd, ['config', 'user.email'], { allowFail: true }).out;
  const name = git(cwd, ['config', 'user.name'], { allowFail: true }).out;
  return email && name ? [] : ['-c', 'user.name=AI Team', '-c', 'user.email=ai-team@localhost'];
}

function dirtyFiles(cwd) {
  return git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain']).out.split('\n').filter(Boolean);
}

function ensureExcluded(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']).out;
  const ex = path.resolve(root, common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = readText(ex);
  if (!/^\/?\.team\/?\s*$/m.test(cur)) {
    fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}.team/\n`);
  }
}

function globToRegex(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/[*?]/.test(g)) {
    const lit = g.replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${lit}(/.*)?$`);
  }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function staticPrefix(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  const i = g.search(/[*?[{]/);
  return i < 0 ? g : g.slice(0, i);
}

function patternsOverlap(a, b) {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa === pb || pa.startsWith(pb.endsWith('/') || !pb ? pb : `${pb}/`) || pb.startsWith(pa.endsWith('/') || !pa ? pa : `${pa}/`);
}

// ---------------------------------------------------------------- finding the CLIs

function runVersion(cmd, pre) {
  try {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: childEnv() });
    return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}

function parseVer(s) {
  const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(s || '');
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function findOnPath(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  const found = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) found.push(path.normalize(p));
      } catch { /* not here */ }
    }
  }
  return [...new Set(found)];
}

// A way to start the CLI without a shell (paths with spaces and Arabic text stay intact).
function launcherFor(p, jsParts) {
  const ext = path.extname(p).toLowerCase();
  if (IS_WIN && ext !== '.exe') {
    const js = path.join(path.dirname(p), 'node_modules', ...jsParts);
    return fs.existsSync(js) ? { cmd: process.execPath, pre: [js] } : null;
  }
  return { cmd: p, pre: [] };
}

function resolveCodex() {
  const cands = [];
  if (process.env.TEAM_CODEX_BIN) cands.push({ cmd: process.env.TEAM_CODEX_BIN, pre: [], source: 'TEAM_CODEX_BIN' });
  if (IS_WIN && process.env.LOCALAPPDATA) {
    // The Codex desktop app ships a newer CLI than npm; it knows the newest models.
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      for (const d of fs.readdirSync(bin)) {
        const exe = path.join(bin, d, 'codex.exe');
        if (fs.existsSync(exe)) cands.push({ cmd: exe, pre: [], source: 'codex-desktop-app' });
      }
    } catch { /* no desktop app */ }
  }
  for (const p of findOnPath('codex')) {
    const l = launcherFor(p, ['@openai', 'codex', 'bin', 'codex.js']);
    if (l) cands.push({ ...l, source: p });
  }
  let best = null;
  const seen = new Set();
  for (const c of cands) {
    const key = [c.cmd, ...c.pre].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = runVersion(c.cmd, c.pre);
    const pv = parseVer(version);
    if (!pv) continue;
    if (process.env.TEAM_CODEX_BIN && c.source === 'TEAM_CODEX_BIN') return { ...c, version };
    if (!best || cmpVer(pv, best.pv) > 0) best = { ...c, version, pv };
  }
  if (best) delete best.pv;
  return best;
}

function resolveClaude() {
  const cands = [];
  if (process.env.TEAM_CLAUDE_BIN) cands.push({ cmd: process.env.TEAM_CLAUDE_BIN, pre: [], source: 'TEAM_CLAUDE_BIN' });
  for (const p of findOnPath('claude')) {
    const l = launcherFor(p, ['@anthropic-ai', 'claude-code', 'cli.js']);
    if (l) cands.push({ ...l, source: p });
  }
  const local = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) cands.push({ cmd: local, pre: [], source: local });
  for (const c of cands) {
    const version = runVersion(c.cmd, c.pre);
    if (version) return { ...c, version };
  }
  return null;
}

function loadConfig() {
  const cfg = readJSON(path.join(SKILL_DIR, 'config.json'), {}) || {};
  const pick = (agent, key, envName) => process.env[envName] || cfg?.[agent]?.[key] || null;
  return {
    codex: {
      model: pick('codex', 'model', 'TEAM_CODEX_MODEL'),
      effort: pick('codex', 'effort', 'TEAM_CODEX_EFFORT'),
      lite: process.env.TEAM_CODEX_LITE ? process.env.TEAM_CODEX_LITE !== '0' : cfg?.codex?.lite !== false,
    },
    claude: { model: pick('claude', 'model', 'TEAM_CLAUDE_MODEL'), effort: pick('claude', 'effort', 'TEAM_CLAUDE_EFFORT') },
    // Minutes without any output before the watchdog treats a colleague as hung.
    stallMin: Number(process.env.TEAM_STALL_MINUTES || cfg.stall_minutes || 15),
  };
}

// The checks a project obviously supports, for when the design does not name any.
function detectChecks(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    const scripts = readJSON(path.join(dir, 'package.json'), {})?.scripts || {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const cmds = [];
    if (scripts.typecheck) cmds.push(`${pm} run typecheck`);
    if (scripts.lint) cmds.push(`${pm} run lint`);
    if (scripts.test && !/no test specified/i.test(scripts.test)) cmds.push(`${pm} test`);
    if (!cmds.length && scripts.build) cmds.push(`${pm} run build`);
    return cmds;
  }
  if (has('go.mod')) return ['go build ./...', 'go test ./...'];
  if (has('Cargo.toml')) return ['cargo test'];
  if (has('pytest.ini') || has('conftest.py') || /pytest/.test(readText(path.join(dir, 'pyproject.toml')))) return ['python -m pytest -q'];
  return [];
}

// Install commands a fresh worktree needs before those checks can run.
function detectSetup(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    const pkg = readJSON(path.join(dir, 'package.json'), {}) || {};
    const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    if (!deps) return [];
    if (has('pnpm-lock.yaml')) return ['pnpm install --frozen-lockfile'];
    if (has('yarn.lock')) return ['yarn install --frozen-lockfile'];
    return [has('package-lock.json') ? 'npm ci' : 'npm install'];
  }
  return [];
}

// Codex extras that slow every call and that code work does not need. Image generation is
// deliberately not in this list: the team uses Codex to make images Claude cannot.
const CODEX_LITE_DISABLE = [
  'plugins', 'apps', 'remote_plugin', 'memories',
  'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use',
];

// ---------------------------------------------------------------- running one colleague turn

function quotaLike(text) {
  return /usage limit|hit your limit|limit reached|rate.?limit|quota|too many requests|\b429\b|insufficient_quota|exceeded your|out of credits/i.test(
    text || '',
  );
}

// Kill a process tree and make sure it is really gone, so a stopped colleague can never keep
// writing into a lane while someone else takes over.
function killTreeAndConfirm(pid) {
  killTree(pid);
  for (let i = 0; i < 20 && pidAlive(pid); i++) sleepSync(250);
  return !pidAlive(pid);
}

function runProcess({ cmd, args, cwd, input, logPath, timeoutMs, stallMs, onLine, keepStdout, extraEnv }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    log.write(`\n=== ${now()}  ${path.basename(cmd)} ${args.join(' ')}\n=== cwd: ${cwd}\n`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...childEnv(), ...(extraEnv || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log.end(`spawn failed: ${e.message}\n`);
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false, stalled: false, seconds: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let stalled = false;
    let lastActivity = Date.now();
    let killConfirmed = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killConfirmed = killTreeAndConfirm(child.pid);
    }, timeoutMs);
    // Watchdog: a colleague that prints nothing for stallMs is treated as hung.
    const watchdog = stallMs
      ? setInterval(() => {
        if (Date.now() - lastActivity > stallMs && !timedOut && !stalled) {
          stalled = true;
          log.write(`\n=== watchdog: no output for ${Math.round(stallMs / 60000)} min, stopping\n`);
          killConfirmed = killTreeAndConfirm(child.pid);
        }
      }, Math.min(15000, Math.max(1000, stallMs / 2)))
      : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      lastActivity = Date.now();
      log.write(d);
      if (keepStdout) stdout += d;
      if (onLine) {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    });
    child.stderr.on('data', (d) => {
      lastActivity = Date.now();
      log.write(d);
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      if (onLine && buf.trim()) onLine(buf);
      const seconds = Math.round((Date.now() - started) / 1000);
      log.end(`\n=== exit ${code} after ${seconds}s${killConfirmed === false ? ' (WARNING: process may still be running)' : ''}\n`);
      resolve({ code, stdout, stderr, timedOut, stalled, killConfirmed, seconds });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function stoppedResult(r, session, text) {
  const why = r.stalled ? `no output for a long time (watchdog), stopped after ${r.seconds}s` : `timed out after ${r.seconds}s`;
  return { status: r.stalled ? 'stalled' : 'timeout', session, text, error: why, seconds: r.seconds };
}

async function codexTurn({ bin, mode, cwd, session, prompt, logPath, timeoutMs, stallMs, cfg }) {
  if (!bin) return { status: 'error', error: 'Codex CLI not found (install Codex or set TEAM_CODEX_BIN).', seconds: 0 };
  const sandbox = mode === 'write' ? 'workspace-write' : 'read-only';
  const args = session
    ? ['exec', 'resume', session, '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandbox}`]
    : ['exec', '--json', '--skip-git-repo-check', '-s', sandbox];
  if (cfg.model) args.push('-m', cfg.model);
  if (cfg.effort) args.push('-c', `model_reasoning_effort=${cfg.effort}`);
  if (cfg.lite) {
    for (const f of CODEX_LITE_DISABLE) args.push('--disable', f);
    args.push('-c', 'mcp_servers={}'); // no MCP servers to start for a coding turn
  }
  args.push('-');
  let thread = session || null;
  let last = null;
  let failed = null;
  const errors = [];
  const r = await runProcess({
    cmd: bin.cmd, args: [...bin.pre, ...args], cwd, input: prompt, logPath, timeoutMs, stallMs,
    onLine: (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
      else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') last = ev.item.text;
      else if (ev.type === 'turn.failed') failed = ev.error?.message || 'turn failed';
      else if (ev.type === 'error') errors.push(ev.message || JSON.stringify(ev));
    },
  });
  if (r.timedOut || r.stalled) return stoppedResult(r, thread, last);
  if (failed || r.code !== 0 || !last) {
    const msg = (failed || errors.join('\n') || r.stderr.slice(-1500) || `exit code ${r.code}`).slice(0, 2000);
    return { status: quotaLike(failed || errors.join(' ')) ? 'quota' : 'error', session: thread, text: last, error: msg, seconds: r.seconds };
  }
  return { status: 'ok', session: thread, text: last, seconds: r.seconds };
}

async function claudeTurn({ bin, mode, cwd, session, prompt, logPath, timeoutMs, stallMs, cfg, relaxed }) {
  if (!bin) return { status: 'error', error: 'Claude Code CLI not found (set TEAM_CLAUDE_BIN).', seconds: 0 };
  const sid = session || crypto.randomUUID();
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', // streamed, so the live view can follow along
    '--setting-sources', 'project,local', // no user plugins or hooks in colleague sessions
    '--strict-mcp-config', // no MCP servers
    '--disable-slash-commands', // no skills
    '--permission-prompts', 'none',
    session ? '--resume' : '--session-id', sid,
  ];
  if (mode === 'write') {
    args.push('--permission-mode', 'auto');
  } else if (relaxed) {
    // Reviews run in a throwaway worktree: let the reviewer run the tests however it needs,
    // but never edit files (anything it changes there is reverted afterwards).
    args.push('--permission-mode', 'auto', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit');
  } else {
    args.push('--permission-mode', 'dontAsk', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', '--allowedTools', ...CLAUDE_READ_ALLOW);
  }
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.effort) args.push('--effort', cfg.effort);
  const r = await runProcess({
    cmd: bin.cmd, args: [...bin.pre, ...args], cwd, input: prompt, logPath, timeoutMs, stallMs, keepStdout: true,
    // A colleague in a worktree would otherwise save auto-memories into the owner's project memory.
    extraEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  });
  let res = null;
  try {
    res = JSON.parse(r.stdout.trim());
  } catch {
    for (const line of r.stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const j = JSON.parse(line);
        if (j && j.type === 'result') { res = j; break; }
      } catch { /* not json */ }
    }
  }
  if (r.timedOut || r.stalled) return stoppedResult(r, sid, res?.result || null);
  if (!res || res.is_error || r.code !== 0) {
    const msg = String(res?.result || res?.error || r.stderr || r.stdout || `exit code ${r.code}`).slice(0, 2000);
    return { status: quotaLike(msg) ? 'quota' : 'error', session: sid, text: res?.result || null, error: msg, seconds: r.seconds };
  }
  return { status: 'ok', session: res.session_id || sid, text: res.result || '', seconds: r.seconds, cost_usd: res.total_cost_usd ?? null };
}

// ---------------------------------------------------------------- prompts

function loadPrompt(name) {
  // Drop the copyright comment at the top of each prompt file; the colleagues don't need it.
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/^<!--[\s\S]*?-->\r?\n/, '');
}

function render(tpl, vars) {
  return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

// Prompt for one turn. `agent` is who actually runs it; `role` is whose part it is
// (they differ when one agent covers for the other).
function buildPrompt(state, job, agent, role, isNewSession) {
  const base = {
    AGENT_NAME: NAME[agent],
    TEAMMATE: NAME[OTHER[role]],
    LENS: LENS[role],
    OTHER_LENS: LENS[OTHER[role]],
    LANGUAGE: state.language,
    REPO: state.repo,
    CWD: job.cwd,
    COVER_NOTE:
      agent === role
        ? ''
        : `\nNote: ${NAME[role]} is unavailable right now, so you are covering ${NAME[role]}'s part in this step. Apply ${NAME[role]}'s lens above.${job.mode === 'write' ? ' The working directory may already contain partial changes from them; continue from that state.' : ''}\n`,
    ...(job.vars || {}),
  };
  const rules = render(loadPrompt(job.mode === 'write' ? '_write-rules' : '_read-rules'), base);
  let text = render(loadPrompt('_team'), { ...base, MODE_RULES: rules });
  text += `\n\n${job.template ? render(loadPrompt(job.template), base) : render(job.body || '', base)}`;
  const attach = [...(job.attach || [])];
  // Codex reads AGENTS.md by itself; give it the project's CLAUDE.md when that is all there is.
  if (agent === 'codex' && isNewSession) {
    const claudeMd = path.join(state.repo, 'CLAUDE.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(path.join(state.repo, 'AGENTS.md'))) {
      attach.push({ label: "Project instructions (the project's CLAUDE.md)", path: claudeMd });
    }
  }
  for (const a of attach) {
    if (!a?.path || !fs.existsSync(a.path)) continue;
    text += `\n\n---\n### Attached: ${a.label}\n\n${fs.readFileSync(a.path, 'utf8').trim()}\n`;
  }
  return text;
}

const TITLES = {
  ar: {
    propose: (a) => `الجولة 1: تصوّر ${a} المستقل`,
    critique: (a) => `الجولة 2: رد ${a} على زميله`,
    draft: (a) => `الجولة 3: مسودة التصميم المشترك (كتبها ${a})`,
    signoff: (a) => `الجولة 3: مراجعة ${a} للمسودة`,
    revise: (a) => `الجولة 4: النسخة النهائية من التصميم (${a})`,
    edits: (a) => `تطبيق قرارات صاحب المشروع (${a})`,
    implement: (a, l) => `التنفيذ: ${a} (${l})`,
    review: (a, l, r) => `مراجعة ${a} (${l}) - الجولة ${r}`,
    fix: (a, l, r) => `تصليحات ${a} (${l}) - الجولة ${r}`,
    consult: (a) => `رأي ${a} في مشكلة تصميم ظهرت أثناء التنفيذ`,
    header: 'محضر نقاش الفريق',
    request: 'المطلوب',
    covering: (a, b) => `${a} (بدل ${b})`,
  },
  en: {
    propose: (a) => `Round 1: ${a}'s independent proposal`,
    critique: (a) => `Round 2: ${a} responds`,
    draft: (a) => `Round 3: joint design draft (written by ${a})`,
    signoff: (a) => `Round 3: ${a}'s sign-off review`,
    revise: (a) => `Round 4: final design (${a})`,
    edits: (a) => `Owner's decisions applied (${a})`,
    implement: (a, l) => `Implementation: ${a} (${l})`,
    review: (a, l, r) => `${a} reviews (${l}), round ${r}`,
    fix: (a, l, r) => `${a} fixes (${l}), round ${r}`,
    consult: (a) => `${a} on a design issue found during implementation`,
    header: 'Team discussion log',
    request: 'Request',
    covering: (a, b) => `${a} (covering for ${b})`,
  },
};

function titles(state) {
  return TITLES[state.ui || 'en'];
}

// ---------------------------------------------------------------- runs, state, batches

function resolveRun(opt) {
  if (opt.run && opt.run !== true) {
    const r = path.resolve(String(opt.run));
    if (!fs.existsSync(path.join(r, 'state.json'))) fail(`No team run at ${r}`);
    return r;
  }
  const start = opt.repo && opt.repo !== true ? path.resolve(String(opt.repo)) : process.cwd();
  const root = repoRoot(start);
  if (!root) fail('Not inside a git repository. Run from the project root or pass --run <dir>.');
  const runs = path.join(root, '.team', 'runs');
  const names = fs.existsSync(runs)
    ? fs.readdirSync(runs).filter((n) => fs.existsSync(path.join(runs, n, 'state.json'))).sort()
    : [];
  if (!names.length) fail('No team runs in this project yet. Start one with: new', { repo: root });
  return path.join(runs, names[names.length - 1]);
}

function loadState(run) {
  const s = readJSON(path.join(run, 'state.json'));
  if (!s) fail(`Cannot read ${path.join(run, 'state.json')}`);
  return s;
}

function saveState(run, state) {
  state.updated = now();
  if (GIT_SAFE) state.git_safe = true; // remember it for the worker and the colleagues
  writeJSON(path.join(run, 'state.json'), state);
}

function ctx(opt) {
  const run = resolveRun(opt);
  return { run, state: loadState(run) };
}

function batchFile(run, id) {
  return path.join(run, 'batches', id, 'batch.json');
}

function ensureIdle(run, state) {
  if (!state.running) return;
  const b = readJSON(batchFile(run, state.running.batch));
  const young = b && Date.now() - Date.parse(b.created) < 60000;
  if (b && b.status !== 'done' && (pidAlive(b.pid) || (b.status === 'pending' && young))) {
    fail(`Colleagues are still working on "${state.running.step}". Run: wait`, { running: state.running });
  }
  state.running = null;
  saveState(run, state);
}

function planOf(run) {
  return readJSON(path.join(run, 'plan.json'));
}

function specFile(run) {
  const design = path.join(run, 'design.md');
  return fs.existsSync(design)
    ? { label: 'The approved design (specification)', path: design }
    : { label: 'The task from the owner (specification)', path: path.join(run, 'request.md') };
}

function backup(run, file) {
  const p = path.join(run, file);
  if (!fs.existsSync(p)) return;
  let n = 1;
  while (fs.existsSync(path.join(run, file.replace(/\.md$/, `.v${n}.md`)))) n++;
  fs.copyFileSync(p, path.join(run, file.replace(/\.md$/, `.v${n}.md`)));
}

function nextFileNumber(dir, prefix) {
  if (!fs.existsSync(dir)) return 1;
  return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).length + 1;
}

// Per-agent files are never named plain "claude.md": on Windows that is the same name as
// CLAUDE.md, and Claude Code would load it as project instructions. Older runs used
// "<agent>.md", so reads fall back to that name.
function agentFile(run, dir, agent, suffix) {
  const current = path.join(run, dir, `${agent}-${suffix}.md`);
  const legacy = path.join(run, dir, `${agent}.md`);
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

function startBatch(run, state, step, jobs) {
  const batches = path.join(run, 'batches');
  fs.mkdirSync(batches, { recursive: true });
  const seq = fs.readdirSync(batches).length + 1;
  const id = `${String(seq).padStart(2, '0')}-${step}`;
  writeJSON(batchFile(run, id), {
    id, step, created: now(), status: 'pending', pid: null,
    jobs: jobs.map((j) => ({ ...j, status: 'pending' })),
  });
  state.running = { batch: id, step, started: now() };
  saveState(run, state);
  const child = spawn(process.execPath, [SCRIPT, 'worker', '--run', run, '--batch', id], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: run,
  });
  child.unref();
  return id;
}

async function waitBatch(run, id, maxSec) {
  const end = Date.now() + Math.max(0, maxSec) * 1000;
  for (;;) {
    const b = readJSON(batchFile(run, id));
    if (b?.status === 'done') return summarize(run, b, 'done');
    if (b?.status === 'running' && b.pid && !pidAlive(b.pid)) return summarize(run, b, 'crashed');
    if (b?.status === 'pending' && Date.now() - Date.parse(b.created) > 90000) return summarize(run, b, 'crashed');
    if (Date.now() >= end) return summarize(run, b, 'running');
    await sleep(3000);
  }
}

function summarize(run, b, status) {
  const state = loadState(run);
  const jobs = (b?.jobs || []).map((j) => ({
    id: j.id,
    agent: j.agent,
    ran_as: j.ran_as || null,
    covered_by: j.covered_by || null,
    lane: j.lane || null,
    status: j.status,
    seconds: j.seconds ?? (j.started ? Math.round((Date.now() - Date.parse(j.started)) / 1000) : null),
    out: j.status === 'ok' ? j.out : null,
    markers: j.markers || {},
    commit: j.commit || null,
    checks: j.checks || undefined,
    review_check: j.review_check || undefined,
    ownership_violations: j.violations?.length ? j.violations : undefined,
    error: j.error || null,
    primary_error: j.primary_error || undefined,
  }));
  const allOk = status === 'done' && jobs.every((j) => j.status === 'ok');
  let hint = null;
  if (status === 'running') hint = 'Colleagues are still working. Call wait again (do not restart the step).';
  else if (status === 'crashed') hint = 'The background worker stopped unexpectedly. Re-run the same step command.';
  else if (!allOk) hint = 'Some jobs failed even after the fallback. See "error" and the .log files in the batch folder.';
  return {
    ok: allOk,
    state: status,
    step: b?.step || null,
    batch: b?.id || null,
    batch_dir: b ? path.join(run, 'batches', b.id) : null,
    run,
    jobs,
    next: status === 'done' ? nextHint(run, state) : status === 'running' ? 'wait' : 'rerun the step',
    hint,
  };
}

function lastStep(state) {
  return state.history.length ? state.history[state.history.length - 1].step : null;
}

function lastSignoffVerdict(run) {
  const dir = run;
  const files = fs.readdirSync(dir).filter((f) => /^signoff-\d+\.md$/.test(f)).sort();
  if (!files.length) return null;
  return parseMarkers(readText(path.join(dir, files[files.length - 1]))).VERDICT || null;
}

const MAX_CHECK_FIXES = 2;
const REVIEWABLE = new Set([undefined, null, 'FIXED', 'UNKNOWN', 'NEEDS_EVIDENCE', 'UNEARNED']);
const needsCheckFix = (l) => l.last_checks && l.last_checks.ok === false && (l.check_fixes || 0) < MAX_CHECK_FIXES;
const reviewRoundsUsed = (l) => (l.review_round || 0) - (l.review_retries || 0);

// True when both sides said nothing is left in dispute after the debate round.
function debateSettled(run) {
  return AGENTS.every((a) => {
    const m = parseMarkers(readText(agentFile(run, 'critiques', a, 'response')));
    return m.OPEN_DISPUTES !== undefined && /^0\b/.test(m.OPEN_DISPUTES);
  });
}

function nextHint(run, state) {
  if (state.running) return 'wait';
  const last = lastStep(state);
  switch (state.phase) {
    case 'discussion': {
      if (!last) return 'propose';
      if (state.mode === 'quick') return last === 'propose' ? 'draft' : 'plan, then the owner checkpoint';
      if (last === 'propose') return 'critique';
      if (last === 'critique') return 'draft';
      if (last === 'draft') return debateSettled(run) ? 'plan, then the owner checkpoint (no open disputes, so no sign-off round)' : 'signoff';
      if (last === 'signoff') {
        const v = lastSignoffVerdict(run) || '';
        return /OBJECTION/i.test(v) ? 'revise' : 'plan, then the owner checkpoint';
      }
      return 'plan, then the owner checkpoint';
    }
    case 'checkpoint':
      return "owner checkpoint: show design.md and ask; then prepare (or edits + plan if they changed something)";
    case 'implementation': {
      const lanes = Object.values(state.lanes || {});
      if (!lanes.length) return 'prepare';
      const notBuilt = lanes.filter((l) => !l.implemented).map((l) => l.id);
      if (notBuilt.length) return `implement${notBuilt.length < lanes.length ? ` --lane ${notBuilt[0]}` : ''}`;
      const failing = lanes.filter(needsCheckFix);
      if (failing.length) return `fix${failing.map((l) => ` --lane ${l.id}`).join('')} (the automatic checks failed)`;
      const needReview = lanes.filter((l) => REVIEWABLE.has(l.last_verdict));
      if (needReview.length) return `review${needReview.length < lanes.length ? needReview.map((l) => ` --lane ${l.id}`).join('') : ''}`;
      const changes = lanes.filter((l) => l.last_verdict === 'CHANGES_REQUESTED');
      const fixable = changes.filter((l) => reviewRoundsUsed(l) < MAX_REVIEW_ROUNDS);
      if (fixable.length) return `fix${fixable.map((l) => ` --lane ${l.id}`).join('')}`;
      return 'merge';
    }
    case 'merging':
      return state.merge_pending ? 'resolve the conflict, git add, then merge --continue' : 'merge';
    case 'merged':
      return 'verify';
    case 'verified':
      return 'finish';
    case 'done':
      return 'done: write report.md and tell the owner';
    default:
      return 'status';
  }
}

function parseMarkers(text) {
  const out = {};
  if (!text) return out;
  const images = [...text.matchAll(/^[\s>*_`-]*IMAGE_REQUEST[*_`]*\s*:\s*(.+)$/gim)]
    .map((m) => m[1].replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim())
    .filter((x) => x && !/^(none|no)\b/i.test(x));
  if (images.length) out.IMAGE_REQUEST = images;
  for (const key of ['VERDICT', 'STATUS', 'DESIGN_ISSUE', 'DECISION', 'OWNER_IMPACT', 'OPEN_DISPUTES', 'ESCALATE', 'SPLIT']) {
    const re = new RegExp(`^[\\s>*_\`-]*${key}[*_\`]*\\s*:\\s*(.+)$`, 'gim');
    let m;
    let last = null;
    while ((m = re.exec(text))) last = m[1];
    if (last) out[key] = last.replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim();
  }
  if (out.VERDICT) {
    if (/CHANGES/i.test(out.VERDICT)) out.VERDICT = 'CHANGES_REQUESTED';
    else if (/OBJECTION/i.test(out.VERDICT)) out.VERDICT = 'OBJECTIONS';
    else if (/APPROVE/i.test(out.VERDICT)) out.VERDICT = 'APPROVE';
  }
  for (const k of ['DESIGN_ISSUE', 'ESCALATE', 'SPLIT']) {
    if (out[k] && /^(none|no|لا يوجد|لا)\b/i.test(out[k])) delete out[k];
  }
  return out;
}

// ---------------------------------------------------------------- worker (runs detached)

async function worker(opt) {
  const run = path.resolve(String(opt.run));
  const id = String(opt.batch);
  const bp = batchFile(run, id);
  const dir = path.dirname(bp);
  const sessionsPath = path.join(run, 'sessions.json');
  const update = (fn) => {
    const b = readJSON(bp);
    fn(b);
    writeJSON(bp, b);
  };
  const updateJob = (jobId, patch) => update((b) => Object.assign(b.jobs.find((x) => x.id === jobId), patch));

  update((b) => { b.status = 'running'; b.pid = process.pid; b.started = now(); });
  try {
    const state = loadState(run);
    if (state.git_safe) GIT_SAFE = true;
    const cfg = loadConfig();
    const bins = {};
    const binFor = (agent) => {
      if (!(agent in bins)) bins[agent] = agent === 'codex' ? resolveCodex() : resolveClaude();
      return bins[agent];
    };
    const batch = readJSON(bp);
    // Probe each working folder once, so a drive without ownership info (exFAT) is detected
    // before the colleagues start and need git there.
    for (const j of batch.jobs) git(j.cwd, ['rev-parse', '--git-dir'], { allowFail: true });

    const runOne = async (job) => {
      const order = job.fallback === false ? [job.agent] : [job.agent, OTHER[job.agent]];
      let result = null;
      let primaryError = null;
      for (const agent of order) {
        const covering = agent !== job.agent;
        const thread = covering ? `${agent}-covering-${job.thread}` : job.thread;
        const tries = covering ? 1 : 2;
        for (let t = 0; t < tries; t++) {
          const sessions = readJSON(sessionsPath, {}) || {};
          const sess = sessions[thread]?.agent === agent ? sessions[thread].id : null;
          const prompt = buildPrompt(state, job, agent, job.agent, !sess);
          fs.writeFileSync(path.join(dir, `${job.id}.${agent}.prompt.md`), prompt);
          updateJob(job.id, { status: 'running', ran_as: agent, thread, started: now() });
          const turn = agent === 'codex' ? codexTurn : claudeTurn;
          result = await turn({
            bin: binFor(agent),
            mode: job.mode,
            cwd: job.cwd,
            session: sess,
            prompt,
            logPath: path.join(dir, `${job.id}.${agent}.log`),
            timeoutMs: (job.timeout_min || 30) * 60000,
            stallMs: cfg.stallMin * 60000,
            cfg: cfg[agent],
            relaxed: job.kind === 'review',
          });
          if (result.session) {
            const s2 = readJSON(sessionsPath, {}) || {};
            s2[thread] = { agent, id: result.session, cwd: job.cwd, updated: now() };
            writeJSON(sessionsPath, s2);
          }
          if (result.status !== 'error') break;
          if (sess) {
            // The resume itself may be what failed: retry once in a fresh session.
            const s3 = readJSON(sessionsPath, {}) || {};
            delete s3[thread];
            writeJSON(sessionsPath, s3);
          }
        }
        if (result.status === 'ok') {
          if (covering) result.covered_by = agent;
          break;
        }
        if (!covering) primaryError = `${NAME[agent]}: ${result.status}: ${result.error || ''}`.slice(0, 600);
      }
      const patch = {
        status: result.status,
        finished: now(),
        seconds: result.seconds,
        error: result.status === 'ok' ? null : result.error || null,
        covered_by: result.covered_by || null,
        primary_error: result.covered_by ? primaryError : undefined,
        markers: parseMarkers(result.text),
      };
      if (result.status === 'ok' && job.out) {
        fs.mkdirSync(path.dirname(job.out), { recursive: true });
        fs.writeFileSync(job.out, `${result.text.trim()}\n`);
        Object.assign(patch, await afterJob(run, job, patch));
      }
      updateJob(job.id, patch);
      return { job, result };
    };

    const results = await Promise.all(batch.jobs.map((j) => runOne(j)));

    // Discussion log, in a stable order.
    const s = loadState(run);
    const t = titles(s);
    const logPath = path.join(run, 'discussion.md');
    for (const { job, result } of results) {
      if (!job.transcript || result.status !== 'ok') continue;
      const who = result.covered_by ? t.covering(NAME[result.covered_by], NAME[job.agent]) : NAME[job.agent];
      const title = job.transcript.replace('{AGENT}', who);
      fs.appendFileSync(logPath, `\n\n## ${title}\n\n> ${who} · ${result.seconds}s · ${now().slice(0, 16).replace('T', ' ')}\n\n${result.text.trim()}\n`);
    }
    const final = readJSON(bp);
    s.running = null;
    s.history.push({
      batch: id,
      step: final.step,
      finished: now(),
      jobs: final.jobs.map((j) => ({ id: j.id, agent: j.agent, ran_as: j.ran_as, covered_by: j.covered_by || null, status: j.status, seconds: j.seconds })),
    });
    saveState(run, s);
    update((b) => { b.status = 'done'; b.finished = now(); });
  } catch (e) {
    update((b) => { b.status = 'done'; b.finished = now(); b.error = e.stack || e.message; });
    const s = loadState(run);
    s.running = null;
    saveState(run, s);
  }
}

// Bookkeeping right after a successful job (runs inside the worker).
async function afterJob(run, job, patch) {
  const extra = {};
  if (!job.lane) return extra;
  let state = loadState(run);
  let lane = state.lanes?.[job.lane];
  if (!lane) return extra;
  if (job.commit) {
    try {
      extra.commit = commitWorktree(lane, job.commit);
      extra.violations = ownershipViolations(state, lane);
    } catch (e) {
      extra.commit_error = e.message;
    }
  }
  // Build and test the lane right away, so reviewers never spend a turn on code that fails.
  let checks = null;
  if (job.kind === 'implement' || job.kind === 'fix') checks = await runLaneChecks(run, lane, planOf(run), job.kind);
  let review = null;
  if (job.kind === 'review') review = validateReview(readText(job.out), lane.worktree);

  // Re-read the state after the awaits: the other lane may have saved it meanwhile.
  state = loadState(run);
  lane = state.lanes[job.lane];
  if (checks) {
    lane.last_checks = { ok: checks.ok, file: checks.file, after: job.kind, at: now() };
    extra.checks = { ok: checks.ok, failed: checks.failed, file: checks.file };
  }
  if (job.kind === 'implement') lane.implemented = true;
  if (job.kind === 'fix') lane.last_verdict = 'FIXED';
  if (job.kind === 'review') {
    lane.review_round = job.round;
    const verdict = patch.markers?.VERDICT || 'UNKNOWN';
    lane.last_verdict = verdict;
    // Evidence over agreement, enforced: a change request whose serious findings cannot be
    // verified, or an approval with no attempt to break the code, gets one more review.
    if (verdict === 'CHANGES_REQUESTED' && review.serious > 0 && review.verifiedSerious === 0 && !(lane.evidence_retries >= 1)) {
      lane.last_verdict = 'NEEDS_EVIDENCE';
      lane.evidence_retries = (lane.evidence_retries || 0) + 1;
      lane.review_retries = (lane.review_retries || 0) + 1;
    } else if (verdict === 'APPROVE' && review.attacks === 0 && !(lane.unearned_retries >= 1)) {
      lane.last_verdict = 'UNEARNED';
      lane.unearned_retries = (lane.unearned_retries || 0) + 1;
      lane.review_retries = (lane.review_retries || 0) + 1;
    }
    if (review.notes.length) {
      fs.appendFileSync(job.out, `\n\n## Coordinator check of this review\n\n${review.notes.map((n) => `- ${n}`).join('\n')}\n`);
    }
    extra.review_check = { findings: review.findings, serious: review.serious, verified_serious: review.verifiedSerious, attacks: review.attacks, verdict_used: lane.last_verdict };
    // A review is read-only: put back anything the reviewer touched by accident.
    if (dirtyFiles(lane.worktree).length) {
      git(lane.worktree, ['checkout', '--', '.'], { allowFail: true });
      extra.reviewer_touched_files = true;
    }
  }
  saveState(run, state);
  return extra;
}

function runShell(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, { cwd, shell: true, env: childEnv(), windowsHide: true });
    const timer = setTimeout(() => { out += '\n[timed out]'; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function runLaneChecks(run, lane, plan, after) {
  const cmds = plan?.verify || [];
  if (!cmds.length) return null;
  const results = [];
  for (const cmd of cmds) {
    const r = await runShell(cmd, lane.worktree, 15 * 60000);
    results.push({ cmd, exit: r.code, tail: r.out.slice(-3000) });
  }
  const ok = results.every((r) => r.exit === 0);
  const dir = path.join(run, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lane.id}-${nextFileNumber(dir, `${lane.id}-`)}.md`);
  const body = results.map((r) => `## \`${r.cmd}\` → exit ${r.exit}\n\n\`\`\`\n${r.tail.trim()}\n\`\`\``).join('\n\n');
  fs.writeFileSync(file, `# Automatic checks: lane ${lane.id} (after ${after})\n\nResult: ${ok ? 'PASSED' : 'FAILED'}\n\n${body}\n`);
  return { ok, file, failed: results.filter((r) => r.exit !== 0).map((r) => r.cmd) };
}

// Checks a review's findings against the code: the cited file and line must exist, each
// finding needs an Evidence line, and a quoted snippet must really be in that file.
function validateReview(text, cwd) {
  const lines = String(text || '').split(/\r?\n/);
  const findings = [];
  let current = null;
  for (const line of lines) {
    const f = /FINDING\s+(\d+)\s*\[(blocker|major|minor)\]\s*`?([^\s`:]+(?:\.[A-Za-z0-9]+)?):(\d+)/i.exec(line);
    if (f) {
      current = { n: f[1], severity: f[2].toLowerCase(), file: f[3], line: Number(f[4]), evidence: null };
      findings.push(current);
      continue;
    }
    if (/^\s*[*_-]*\s*(ATTACK|VERDICT)\b/i.test(line)) current = null;
    const ev = /^\s*[*_-]*\s*Evidence\s*[*_]*\s*:\s*(.+)$/i.exec(line);
    if (ev && current && !current.evidence) current.evidence = ev[1];
  }
  const notes = [];
  let serious = 0;
  let verifiedSerious = 0;
  for (const f of findings) {
    const problems = [];
    const full = path.isAbsolute(f.file) ? f.file : path.join(cwd, f.file);
    let content = null;
    if (!fs.existsSync(full)) problems.push(`\`${f.file}\` does not exist`);
    else {
      content = readText(full);
      const count = content.split(/\r?\n/).length;
      if (!(f.line >= 1 && f.line <= count)) problems.push(`line ${f.line} is outside \`${f.file}\` (${count} lines)`);
    }
    if (!f.evidence) problems.push('no Evidence line');
    else if (content && !/\bran\b|`(npm|node|pnpm|yarn|pytest|python|go|cargo|npx)\b/i.test(f.evidence)) {
      // A quoted piece of code must be found in the cited file.
      const quotes = [...f.evidence.matchAll(/["“`]([^"”`]{8,})["”`]/g)].map((m) => m[1]).filter((q) => !/^[\w./\\-]+:\d+/.test(q));
      const squash = (s) => s.replace(/\s+/g, '');
      if (quotes.length && !quotes.some((q) => squash(content).includes(squash(q)))) problems.push('the quoted code is not in that file');
    }
    const isSerious = f.severity === 'blocker' || f.severity === 'major';
    if (isSerious) serious++;
    if (problems.length) notes.push(`FINDING ${f.n} [${f.severity}] could not be verified: ${problems.join('; ')}.`);
    else if (isSerious) verifiedSerious++;
  }
  const attacks = lines.filter((l) => /^\s*[*_-]*\s*ATTACK\s*[*_]*\s*:/i.test(l)).length;
  if (!attacks) notes.push('No ATTACK lines: the review shows no attempt to break the code.');
  return { findings: findings.length, serious, verifiedSerious, attacks, notes };
}

function commitWorktree(lane, message) {
  const wt = lane.worktree;
  const pathspec = ['--', '.', ...(lane.exclude || []).map((e) => `:(exclude)${e}`)];
  git(wt, ['add', '-A', ...pathspec]);
  const staged = git(wt, ['diff', '--cached', '--name-only']).out;
  if (!staged) return null;
  git(wt, [...identityArgs(wt), 'commit', '-q', '-m', message]);
  return git(wt, ['rev-parse', '--short', 'HEAD']).out;
}

function ownershipViolations(state, lane) {
  if (!lane.files?.length || lane.files.some((f) => f === '**' || f === '**/*' || f === '.')) return [];
  const changed = git(lane.worktree, ['-c', 'core.quotePath=false', 'diff', '--name-only', state.base, 'HEAD']).out
    .split('\n')
    .filter(Boolean);
  const res = lane.files.map(globToRegex);
  return changed.filter((f) => !res.some((r) => r.test(f)));
}

// ---------------------------------------------------------------- commands: setup

async function doctor(opt) {
  const codex = resolveCodex();
  const claude = resolveClaude();
  const gitV = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  let codexLogin = null;
  if (codex) {
    const r = spawnSync(codex.cmd, [...codex.pre, 'login', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: childEnv() });
    codexLogin = `${(r.stdout || '').trim()} ${(r.stderr || '').trim()}`.trim().split('\n').slice(-1)[0] || null;
  }
  const root = repoRoot(opt.repo && opt.repo !== true ? path.resolve(String(opt.repo)) : process.cwd());
  emit({
    ok: !!(codex && claude && gitV.status === 0),
    node: process.version,
    git: (gitV.stdout || '').trim() || null,
    claude: claude ? { version: claude.version, path: claude.pre[0] || claude.cmd } : null,
    codex: codex ? { version: codex.version, path: codex.pre[0] || codex.cmd, source: codex.source, login: codexLogin } : null,
    repo: root,
    repo_dirty: root ? dirtyFiles(root).length > 0 : null,
    config: loadConfig(),
    origin: ORIGIN,
  });
}

async function cmdNew(opt) {
  const request = (
    opt['request-file'] !== undefined
      ? readInput(opt['request-file'], '--request-file')
      : typeof opt.request === 'string'
        ? opt.request
        : fail('Missing --request-file <file|-> (the owner\'s request, verbatim).')
  ).trim();
  if (!request) fail('The request is empty.');
  const start = opt.repo && opt.repo !== true ? path.resolve(String(opt.repo)) : process.cwd();
  const setup = [];
  let root = repoRoot(start);
  if (!root) {
    git(start, ['init', '-q']);
    setup.push('git init');
    root = repoRoot(start);
  }
  ensureExcluded(root);
  if (git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).code !== 0) {
    git(root, ['add', '-A']);
    git(root, [...identityArgs(root), 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit before the first AI team run']);
    setup.push('initial commit of the existing files');
  }
  const small = opt.small === true || opt.small === 'true';
  const quick = !small && (opt.quick === true || opt.quick === 'true');
  const id = `${stamp()}-${slugify(opt.title) || 'task'}`;
  const run = path.join(root, '.team', 'runs', id);
  if (fs.existsSync(run)) fail(`Run already exists: ${run}`);
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'request.md'), `${request}\n`);
  const ar = isArabic(request);
  const language = opt.lang && opt.lang !== true ? String(opt.lang) : ar ? 'Arabic' : 'English';
  const state = {
    origin: ORIGIN.id, id, repo: root, language, ui: ar || /arab/i.test(language) ? 'ar' : 'en', small, git_safe: GIT_SAFE,
    mode: small ? 'small' : quick ? 'quick' : 'full',
    created: now(), phase: small ? 'implementation' : 'discussion',
    drafter: 'codex', signer: 'claude',
    running: null, history: [], lanes: {}, base: null, notes: [],
  };
  if (small) {
    const implementer = AGENTS.includes(opt.implementer) ? opt.implementer : 'codex';
    const firstLine = request.split('\n')[0].slice(0, 100);
    const verify = list(opt.verify).length ? list(opt.verify) : detectChecks(root);
    const setup = list(opt.setup).length ? list(opt.setup) : detectSetup(root);
    writeJSON(path.join(run, 'plan.json'), {
      size: 'small', setup, verify, merge_order: [implementer],
      lanes: [{ id: implementer, agent: implementer, title: firstLine, tasks: [request], files: ['**'] }],
    });
  } else {
    const t = TITLES[state.ui];
    fs.writeFileSync(path.join(run, 'discussion.md'), `# ${t.header}\n\n**${t.request}:**\n\n${request}\n`);
  }
  saveState(run, state);
  const codex = resolveCodex();
  const claude = resolveClaude();
  const warnings = [];
  if (!codex) warnings.push('Codex CLI not found: Claude will cover every Codex job.');
  if (!claude) warnings.push('Claude CLI not found: Codex will cover every Claude job.');
  emit({
    ok: true, run, id, repo: root, mode: state.mode, small, language, setup_actions: setup,
    repo_dirty: dirtyFiles(root),
    codex: codex?.version || null, claude: claude?.version || null,
    warnings, next: small ? 'prepare' : 'propose',
  });
}

// ---------------------------------------------------------------- commands: discussion

function requireFile(p, what) {
  if (!fs.existsSync(p)) fail(`Missing ${what}: ${p}`);
}

async function runStep(opt, run, state, step, jobs) {
  const id = startBatch(run, state, step, jobs);
  const maxSec = opt.wait !== undefined && opt.wait !== true ? Number(opt.wait) : DEFAULT_WAIT_SEC;
  emit(await waitBatch(run, id, maxSec));
}

async function propose(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  if (state.small) fail('This is a small task; it skips the discussion. Next: prepare');
  const request = readText(path.join(run, 'request.md'));
  const t = titles(state);
  const jobs = AGENTS.map((a) => ({
    id: `${a}-propose`, agent: a, mode: 'read', cwd: state.repo, thread: `${a}-design`,
    template: 'propose', vars: { REQUEST: request },
    out: path.join(run, 'proposals', `${a}-proposal.md`), transcript: t.propose('{AGENT}'), timeout_min: TIMEOUT_MIN.propose,
  }));
  await runStep(opt, run, state, 'propose', jobs);
}

async function critique(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const request = readText(path.join(run, 'request.md'));
  for (const a of AGENTS) requireFile(agentFile(run, 'proposals', a, 'proposal'), `${NAME[a]}'s proposal (run propose first)`);
  const t = titles(state);
  const jobs = AGENTS.map((a) => ({
    id: `${a}-critique`, agent: a, mode: 'read', cwd: state.repo, thread: `${a}-design`,
    template: 'critique', vars: { REQUEST: request },
    attach: [
      { label: `${NAME[OTHER[a]]}'s proposal (your teammate)`, path: agentFile(run, 'proposals', OTHER[a], 'proposal') },
      { label: `Your own proposal (for reference)`, path: agentFile(run, 'proposals', a, 'proposal') },
    ],
    out: path.join(run, 'critiques', `${a}-response.md`), transcript: t.critique('{AGENT}'), timeout_min: TIMEOUT_MIN.critique,
  }));
  await runStep(opt, run, state, 'critique', jobs);
}

async function draft(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const by = AGENTS.includes(opt.by) ? opt.by : state.drafter;
  state.drafter = by;
  state.signer = OTHER[by];
  const request = readText(path.join(run, 'request.md'));
  const attach = [];
  for (const a of AGENTS) {
    const p = agentFile(run, 'proposals', a, 'proposal');
    requireFile(p, `${NAME[a]}'s proposal`);
    attach.push({ label: `${NAME[a]}'s proposal`, path: p });
  }
  for (const a of AGENTS) {
    const c = agentFile(run, 'critiques', a, 'response');
    if (fs.existsSync(c)) attach.push({ label: `${NAME[a]}'s response to the other proposal`, path: c });
  }
  backup(run, 'design.md');
  const t = titles(state);
  await runStep(opt, run, state, 'draft', [{
    id: `${by}-draft`, agent: by, mode: 'read', cwd: state.repo, thread: `${by}-design`,
    template: 'draft', vars: { REQUEST: request }, attach,
    out: path.join(run, 'design.md'), transcript: t.draft('{AGENT}'), timeout_min: TIMEOUT_MIN.draft,
  }]);
}

async function signoff(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  requireFile(path.join(run, 'design.md'), 'design.md (run draft first)');
  const signer = state.signer || OTHER[state.drafter];
  const n = fs.readdirSync(run).filter((f) => /^signoff-\d+\.md$/.test(f)).length + 1;
  const t = titles(state);
  await runStep(opt, run, state, 'signoff', [{
    id: `${signer}-signoff-${n}`, agent: signer, mode: 'read', cwd: state.repo, thread: `${signer}-design`,
    template: 'signoff', attach: [{ label: `The joint design draft (by ${NAME[state.drafter]})`, path: path.join(run, 'design.md') }],
    out: path.join(run, `signoff-${n}.md`), transcript: t.signoff('{AGENT}'), timeout_min: TIMEOUT_MIN.signoff,
  }]);
}

async function revise(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const files = fs.readdirSync(run).filter((f) => /^signoff-\d+\.md$/.test(f)).sort();
  if (!files.length) fail('No sign-off review yet. Run signoff first.');
  const by = state.drafter;
  backup(run, 'design.md');
  const t = titles(state);
  await runStep(opt, run, state, 'revise', [{
    id: `${by}-revise`, agent: by, mode: 'read', cwd: state.repo, thread: `${by}-design`,
    template: 'revise',
    attach: [
      { label: `${NAME[state.signer]}'s sign-off review`, path: path.join(run, files[files.length - 1]) },
      { label: 'Your current draft', path: path.join(run, 'design.md') },
    ],
    out: path.join(run, 'design.md'), transcript: t.revise('{AGENT}'), timeout_min: TIMEOUT_MIN.revise,
  }]);
}

async function edits(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  requireFile(path.join(run, 'design.md'), 'design.md');
  const ownerText = readInput(opt.file, '--file with the owner\'s decisions').trim();
  const n = nextFileNumber(run, 'owner-edits-');
  fs.writeFileSync(path.join(run, `owner-edits-${n}.md`), `${ownerText}\n`);
  const by = state.drafter;
  backup(run, 'design.md');
  state.phase = 'discussion';
  const t = titles(state);
  await runStep(opt, run, state, 'edits', [{
    id: `${by}-edits-${n}`, agent: by, mode: 'read', cwd: state.repo, thread: `${by}-design`,
    template: 'edits', vars: { OWNER_EDITS: ownerText },
    attach: [{ label: 'The current design', path: path.join(run, 'design.md') }],
    out: path.join(run, 'design.md'), transcript: t.edits('{AGENT}'), timeout_min: TIMEOUT_MIN.edits,
  }]);
}

function extractPlan(md) {
  const blocks = [...md.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
  const tagged = blocks.filter((b) => /team-plan/i.test(b[1]));
  const candidates = tagged.length ? tagged : blocks.filter((b) => /"lanes"\s*:/.test(b[2]));
  if (!candidates.length) return { error: 'No ```json team-plan block found in design.md.' };
  const raw = candidates[candidates.length - 1][2];
  try {
    return { plan: JSON.parse(raw) };
  } catch (e) {
    return { error: `The team-plan block is not valid JSON: ${e.message}` };
  }
}

function normalizePlan(p) {
  const errors = [];
  const warnings = [];
  if (!p || !Array.isArray(p.lanes) || !p.lanes.length) {
    errors.push('"lanes" must be a non-empty array.');
    return { errors, warnings };
  }
  if (p.lanes.length > 2) errors.push('At most two lanes (one per agent).');
  const byLabel = {};
  for (const l of p.lanes) {
    if (!AGENTS.includes(l.agent)) errors.push(`Lane "${l.id}": agent must be "claude" or "codex".`);
    if (!Array.isArray(l.files) || !l.files.length) errors.push(`Lane "${l.id}": "files" must be a non-empty array.`);
    if (!Array.isArray(l.tasks) || !l.tasks.length) errors.push(`Lane "${l.id}": "tasks" must be a non-empty array.`);
    byLabel[l.id] = l.agent;
    l.label = l.id;
    l.id = l.agent; // lanes are named after their agent: claude / codex
    l.title = String(l.title || l.label || l.agent);
  }
  if (p.lanes.length === 2 && p.lanes[0].agent === p.lanes[1].agent) errors.push('Two lanes must belong to different agents.');
  p.setup = list(p.setup).filter((c) => c.trim() && !/^<.*>$/.test(c.trim()));
  p.verify = list(p.verify).filter((c) => c.trim() && !/^<.*>$/.test(c.trim()));
  const order = Array.isArray(p.merge_order) ? p.merge_order.map((x) => byLabel[x] || x).filter((x) => AGENTS.includes(x)) : [];
  p.merge_order = [...new Set([...order, ...p.lanes.map((l) => l.id)])].filter((id) => p.lanes.some((l) => l.id === id));
  if (p.lanes.length === 2 && !errors.length) {
    const [a, b] = p.lanes;
    for (const fa of a.files) for (const fb of b.files) if (patternsOverlap(fa, fb)) warnings.push(`Both lanes may touch "${fa}" / "${fb}".`);
  }
  return { errors, warnings };
}

async function cmdPlan(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  requireFile(path.join(run, 'design.md'), 'design.md');
  const { plan, error } = extractPlan(readText(path.join(run, 'design.md')));
  if (error) fail(error, { fix: 'Ask the drafter to output the design again with a valid team-plan block (edits --file with the error).' });
  const { errors, warnings } = normalizePlan(plan);
  if (errors.length) fail('The team-plan block has problems.', { problems: errors });
  // The owner should not have to know the test commands: fill in what the project supports.
  if (!plan.verify.length) {
    plan.verify = detectChecks(state.repo);
    if (plan.verify.length) warnings.push(`No verify commands in the design; using the project's own: ${plan.verify.join(', ')}`);
  }
  if (!plan.setup.length && plan.verify.length) plan.setup = detectSetup(state.repo);
  writeJSON(path.join(run, 'plan.json'), plan);
  if (!state.small) state.phase = 'checkpoint';
  saveState(run, state);
  emit({
    ok: true, run, design: path.join(run, 'design.md'), discussion: path.join(run, 'discussion.md'),
    lanes: plan.lanes.map((l) => ({ id: l.id, title: l.title, tasks: l.tasks.length, files: l.files })),
    setup: plan.setup, verify: plan.verify, merge_order: plan.merge_order, warnings,
    repo_dirty: dirtyFiles(state.repo),
    next: 'owner checkpoint: summarize design.md (including "Decisions for the owner"), ask approve / change / stop',
  });
}

// ---------------------------------------------------------------- commands: build

function worktreeDir(state, laneId) {
  return path.join(path.dirname(state.repo), `${path.basename(state.repo)}.team-worktrees`, state.id, laneId);
}

async function prepare(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run);
  if (!plan) fail('No plan.json. Run plan first.');
  const repo = state.repo;
  const dirty = dirtyFiles(repo);
  if (dirty.length && !Object.keys(state.lanes || {}).length) {
    if (!opt.snapshot) {
      fail('The project has uncommitted changes. Ask the owner, then re-run with --snapshot to commit them first.', { dirty });
    }
    git(repo, ['add', '-A']);
    git(repo, [...identityArgs(repo), 'commit', '-q', '-m', `chore: snapshot before AI team run ${state.id}`]);
    state.notes.push(`Committed a snapshot of uncommitted changes before the run (${git(repo, ['rev-parse', '--short', 'HEAD']).out}).`);
  }
  if (!state.base) state.base = git(repo, ['rev-parse', 'HEAD']).out;
  state.branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  state.approved = state.approved || now();
  const setupResults = [];
  for (const l of plan.lanes) {
    const existing = state.lanes[l.id];
    const wt = existing?.worktree || worktreeDir(state, l.id);
    const branch = existing?.branch || `team/${state.id}/${l.id}`;
    if (!fs.existsSync(wt)) {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(repo, ['worktree', 'add', '-q', '-b', branch, wt, state.base]);
    }
    const lane = existing || {
      id: l.id, agent: l.agent, reviewer: OTHER[l.agent], label: l.label || l.id, title: l.title,
      tasks: l.tasks, files: l.files, branch, worktree: wt, exclude: [],
      implemented: false, review_round: 0, last_verdict: null, merged: false,
    };
    if (!existing) {
      for (const cmd of plan.setup) {
        const r = spawnSync(cmd, { cwd: wt, shell: true, encoding: 'utf8', windowsHide: true, timeout: 20 * 60000, maxBuffer: 64 * 1024 * 1024, env: childEnv() });
        const logFile = path.join(run, 'logs', `setup-${l.id}.log`);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `\n$ ${cmd}\n${r.stdout || ''}${r.stderr || ''}\n(exit ${r.status})\n`);
        setupResults.push({ lane: l.id, cmd, exit: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-800) });
      }
      // Whatever setup left untracked (node_modules, venvs, ...) never gets committed.
      lane.exclude = git(wt, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--directory'])
        .out.split('\n').filter(Boolean);
    }
    state.lanes[l.id] = lane;
  }
  state.phase = 'implementation';
  saveState(run, state);
  emit({
    ok: setupResults.every((r) => r.exit === 0),
    base: state.base,
    branch: state.branch,
    lanes: Object.values(state.lanes).map((l) => ({ id: l.id, agent: l.agent, worktree: l.worktree, branch: l.branch, files: l.files })),
    setup: setupResults,
    next: 'implement',
  });
}

function laneVars(state, plan, lane) {
  const others = Object.values(state.lanes).filter((l) => l.id !== lane.id);
  return {
    LANE_ID: lane.id,
    LANE_TITLE: lane.title,
    LANE_TASKS: lane.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    LANE_FILES: lane.files.map((f) => `- ${f}`).join('\n'),
    OTHER_LANES: others.length
      ? `Your teammate ${NAME[others[0].agent]} is building lane "${others[0].id}" (${others[0].title}) at the same time, in a separate copy of the project, and owns: ${others[0].files.join(', ')}. Do not touch those files; rely on the interface fixed in the specification.`
      : '',
    VERIFY: plan.verify.length ? plan.verify.join('  ;  ') : "the project's existing tests and checks, if any",
    BASE: state.base,
    IMPLEMENTER: NAME[lane.agent],
    REVIEWER: NAME[lane.reviewer],
  };
}

function pickLanes(run, state, opt, filter) {
  const wanted = list(opt.lane);
  const lanes = Object.values(state.lanes || {});
  if (!lanes.length) fail('No lanes yet. Run prepare first.');
  for (const w of wanted) if (!state.lanes[w]) fail(`Unknown lane "${w}". Lanes: ${lanes.map((l) => l.id).join(', ')}`);
  const chosen = wanted.length ? wanted.map((w) => state.lanes[w]) : lanes.filter(filter);
  if (!chosen.length) fail('No lane needs this step right now.', { next: nextHint(run, state) });
  return chosen;
}

function latestReport(run, lane) {
  const dir = path.join(run, 'impl');
  if (!fs.existsSync(dir)) return null;
  const first = [`${lane.id}-report.md`, `${lane.id}.md`];
  const files = fs.readdirSync(dir).filter((f) => first.includes(f) || f.startsWith(`${lane.id}-fix`)).sort((a, b) => {
    const n = (f) => (first.includes(f) ? 0 : Number((/fix(\d+)/.exec(f) || [0, 0])[1]));
    return n(a) - n(b);
  });
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

async function implement(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run);
  const lanes = pickLanes(run, state, opt, (l) => !l.implemented);
  const t = titles(state);
  const jobs = lanes.map((lane) => ({
    id: `${lane.agent}-implement-${lane.id}`, kind: 'implement', lane: lane.id,
    agent: lane.agent, mode: 'write', cwd: lane.worktree, thread: `${lane.agent}-impl-${lane.id}`,
    template: 'implement',
    vars: {
      ...laneVars(state, plan, lane),
      ESCALATE_RULE: state.mode === 'small'
        ? 'This was judged a small task. If it turns out to need real design decisions, or many more files than a small fix, do not build it: write `ESCALATE: <why, in one line>` right after your TLDR line and stop.'
        : '',
    },
    attach: [specFile(run)],
    out: path.join(run, 'impl', `${lane.id}-report.md`), transcript: t.implement('{AGENT}', lane.title),
    commit: `team(${state.id}): ${lane.title} [${NAME[lane.agent]}]`, timeout_min: TIMEOUT_MIN.implement,
  }));
  await runStep(opt, run, state, 'implement', jobs);
}

async function review(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run);
  const lanes = pickLanes(run, state, opt, (l) => l.implemented && !needsCheckFix(l) && REVIEWABLE.has(l.last_verdict));
  const t = titles(state);
  const jobs = [];
  for (const lane of lanes) {
    const round = (lane.review_round || 0) + 1;
    if (reviewRoundsUsed(lane) + 1 > MAX_REVIEW_ROUNDS && !opt.force) fail(`Lane "${lane.id}" already had ${MAX_REVIEW_ROUNDS} review rounds. Merge it and list what is left in the report (or pass --force).`);
    const attach = [specFile(run)];
    const rep = latestReport(run, lane);
    if (rep) attach.push({ label: `${NAME[lane.agent]}'s latest report`, path: rep });
    if (lane.last_checks?.file) attach.push({ label: `Automatic checks on this lane (${lane.last_checks.ok ? 'passed' : 'FAILED'})`, path: lane.last_checks.file });
    if (round > 1) {
      const prev = path.join(run, 'reviews', `${lane.id}-r${round - 1}.md`);
      if (fs.existsSync(prev)) attach.push({ label: 'Your previous review', path: prev });
    }
    let previous = round > 1 ? 'This is a re-review: check that every blocker and major finding from your previous review is resolved and that nothing regressed.' : '';
    if (lane.last_verdict === 'NEEDS_EVIDENCE') previous = "Your previous review asked for changes, but none of its blocker or major findings could be verified against the code (see \"Coordinator check\" at the end of it). Re-check each one: cite a real file:line with an exact quote or the command you ran, or drop it.";
    if (lane.last_verdict === 'UNEARNED') previous = 'Your previous review approved without showing any attempt to break the code. Before approving again, try at least two concrete attacks and report them as ATTACK lines.';
    jobs.push({
      id: `${lane.reviewer}-review-${lane.id}-r${round}`, kind: 'review', lane: lane.id, round,
      agent: lane.reviewer, mode: 'read', cwd: lane.worktree, thread: `${lane.reviewer}-review-${lane.id}`,
      template: 'review',
      vars: { ...laneVars(state, plan, lane), ROUND: round, PREVIOUS: previous },
      attach, out: path.join(run, 'reviews', `${lane.id}-r${round}.md`),
      transcript: t.review('{AGENT}', lane.title, round), timeout_min: TIMEOUT_MIN.review,
    });
  }
  await runStep(opt, run, state, 'review', jobs);
}

async function fix(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run);
  if (!list(opt.lane).length) fail('Pass --lane <id> for each lane to fix.');
  const lanes = pickLanes(run, state, opt, () => true);
  const t = titles(state);
  const custom = opt['input-file'] && opt['input-file'] !== true ? readInput(opt['input-file'], '--input-file') : null;
  const jobs = lanes.map((lane) => {
    const round = Math.max(1, lane.review_round || 0);
    const n = nextFileNumber(path.join(run, 'impl'), `${lane.id}-fix`);
    const attach = [];
    const checksFailed = lane.last_checks && lane.last_checks.ok === false;
    if (custom) {
      const input = path.join(run, 'impl', `${lane.id}-change-${nextFileNumber(path.join(run, 'impl'), `${lane.id}-change-`)}.md`);
      fs.mkdirSync(path.dirname(input), { recursive: true });
      fs.writeFileSync(input, custom);
      attach.push({ label: 'The change the team agreed on', path: input });
    } else {
      const review = path.join(run, 'reviews', `${lane.id}-r${round}.md`);
      if (lane.last_verdict === 'CHANGES_REQUESTED' && fs.existsSync(review)) attach.push({ label: `${NAME[lane.reviewer]}'s review (round ${round})`, path: review });
      if (checksFailed) attach.push({ label: 'The automatic checks that FAILED on your lane', path: lane.last_checks.file });
      if (!attach.length) fail(`Nothing to fix on lane "${lane.id}": no failing checks and no review asking for changes.`);
    }
    if (checksFailed) lane.check_fixes = (lane.check_fixes || 0) + 1;
    attach.push(specFile(run));
    return {
      id: `${lane.agent}-fix-${lane.id}-${n}`, kind: 'fix', lane: lane.id, round,
      agent: lane.agent, mode: 'write', cwd: lane.worktree, thread: `${lane.agent}-impl-${lane.id}`,
      template: 'fix', vars: { ...laneVars(state, plan, lane), ROUND: round },
      attach,
      out: path.join(run, 'impl', `${lane.id}-fix${n}.md`), transcript: t.fix('{AGENT}', lane.title, n),
      commit: `team(${state.id}): ${lane.title}: fixes ${n} [${NAME[lane.agent]}]`, timeout_min: TIMEOUT_MIN.fix,
    };
  });
  await runStep(opt, run, state, 'fix', jobs);
}

async function consult(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const laneId = list(opt.lane)[0];
  const lane = state.lanes?.[laneId];
  if (!lane) fail('Pass --lane <id> (the lane whose implementer raised the issue).');
  let issue = opt['issue-file'] && opt['issue-file'] !== true ? readInput(opt['issue-file'], '--issue-file') : '';
  if (!issue.trim()) {
    const rep = latestReport(run, lane);
    issue = rep ? readText(rep) : '';
    if (!issue) fail('No issue text. Pass --issue-file.');
  }
  const other = OTHER[lane.agent];
  const n = nextFileNumber(path.join(run, 'consult'), `${lane.id}-`);
  const t = titles(state);
  await runStep(opt, run, state, 'consult', [{
    id: `${other}-consult-${lane.id}-${n}`, agent: other, mode: 'read', cwd: state.repo, thread: `${other}-design`,
    template: 'consult', vars: { ISSUE: issue.trim(), TEAMMATE: NAME[lane.agent] }, attach: [specFile(run)],
    out: path.join(run, 'consult', `${lane.id}-${n}.md`), transcript: t.consult('{AGENT}'), timeout_min: TIMEOUT_MIN.consult,
  }]);
}

async function ask(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const agent = String(opt.agent || '');
  if (!AGENTS.includes(agent)) fail('--agent must be claude or codex');
  const mode = opt.mode === 'write' ? 'write' : 'read';
  const cwdSpec = opt.cwd && opt.cwd !== true ? String(opt.cwd) : 'repo';
  let cwd = state.repo;
  let laneId = null;
  if (cwdSpec.startsWith('lane:')) {
    laneId = cwdSpec.slice(5);
    if (!state.lanes?.[laneId]) fail(`Unknown lane "${laneId}"`);
    cwd = state.lanes[laneId].worktree;
  } else if (cwdSpec !== 'repo') {
    cwd = path.resolve(cwdSpec);
  }
  const body = readInput(opt['prompt-file'], '--prompt-file');
  const n = nextFileNumber(path.join(run, 'asks'), '');
  const out = opt.out && opt.out !== true ? path.resolve(run, String(opt.out)) : path.join(run, 'asks', `${String(n).padStart(2, '0')}-${agent}.md`);
  const title = opt.title && opt.title !== true ? String(opt.title) : null;
  await runStep(opt, run, state, 'ask', [{
    id: `${agent}-ask-${n}`, kind: 'ask', lane: mode === 'write' ? laneId : null,
    agent, mode, cwd, thread: opt.thread && opt.thread !== true ? String(opt.thread) : `${agent}-ask`,
    body, vars: {}, attach: list(opt.attach).map((p) => ({ label: path.basename(p), path: path.resolve(p) })),
    out, transcript: title ? `${title} ({AGENT})` : null,
    commit: mode === 'write' && laneId ? `team(${state.id}): ${title || 'update'} [${NAME[agent]}]` : null,
    fallback: opt['no-fallback'] ? false : true,
    timeout_min: Number(opt.timeout) || TIMEOUT_MIN.ask,
  }]);
}

// ---------------------------------------------------------------- commands: merge, verify, finish

function mergeMessage(state, lane) {
  return [
    `feat(team): ${lane.title}`,
    '',
    `Built by ${NAME[lane.agent]}, reviewed by ${NAME[lane.reviewer]} (${lane.review_round || 0} review round(s)).`,
    `AI team run: ${state.id}`,
    '',
    `Built-with: ${ORIGIN.name} by ${ORIGIN.author} (${ORIGIN.url})`,
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'Co-Authored-By: Codex <noreply@openai.com>',
  ].join('\n');
}

async function merge(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run);
  const repo = state.repo;
  const merged = [];
  if (opt.continue) {
    const laneId = state.merge_pending;
    if (!laneId) fail('No merge is waiting to be continued.');
    const unmerged = git(repo, ['diff', '--name-only', '--diff-filter=U']).out;
    if (unmerged) fail('Some files still have conflicts. Resolve them and git add them first.', { files: unmerged.split('\n') });
    const lane = state.lanes[laneId];
    git(repo, ['add', '-A']);
    git(repo, [...identityArgs(repo), 'commit', '-q', '-m', mergeMessage(state, lane)]);
    lane.merged = true;
    lane.merge_commit = git(repo, ['rev-parse', '--short', 'HEAD']).out;
    state.merge_pending = null;
    merged.push({ lane: laneId, commit: lane.merge_commit, conflict_resolved: true });
    saveState(run, state);
  } else if (state.merge_pending) {
    fail(`Lane "${state.merge_pending}" is mid-merge. Resolve the conflict, git add, then: merge --continue`);
  }
  state.phase = 'merging';
  saveState(run, state);
  for (const laneId of plan.merge_order) {
    const lane = state.lanes[laneId];
    if (!lane || lane.merged) continue;
    const dirty = dirtyFiles(repo);
    if (dirty.length) fail('The project has uncommitted changes, so merging would mix them in. Ask the owner what to do.', { dirty });
    const r = git(repo, ['merge', '--squash', lane.branch], { allowFail: true });
    const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    if (r.code !== 0 || conflicts.length) {
      state.merge_pending = laneId;
      saveState(run, state);
      emit({
        ok: false, conflict: true, lane: laneId, files: conflicts, merged,
        hint: "Resolve the conflicts in the project (keep both lanes' intent; if it is a real design clash, consult), git add the files, then run: merge --continue",
        detail: (r.err || r.out).slice(-1500),
      });
      return;
    }
    if (!git(repo, ['diff', '--cached', '--name-only']).out) {
      lane.merged = true;
      lane.merge_commit = null;
      merged.push({ lane: laneId, commit: null, note: 'no changes' });
      continue;
    }
    git(repo, [...identityArgs(repo), 'commit', '-q', '-m', mergeMessage(state, lane)]);
    lane.merged = true;
    lane.merge_commit = git(repo, ['rev-parse', '--short', 'HEAD']).out;
    merged.push({ lane: laneId, commit: lane.merge_commit });
    saveState(run, state);
  }
  state.phase = 'merged';
  saveState(run, state);
  emit({ ok: true, merged, branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out, next: 'verify' });
}

async function verify(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const plan = planOf(run) || { verify: [] };
  const laneId = list(opt.lane)[0];
  const cwd = laneId ? state.lanes?.[laneId]?.worktree : state.repo;
  if (!cwd) fail(`Unknown lane "${laneId}"`);
  const results = [];
  for (const cmd of plan.verify) {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024, env: childEnv() });
    results.push({ cmd, exit: r.status, output_tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-2500) });
  }
  const ok = results.every((r) => r.exit === 0);
  if (!laneId && state.phase === 'merged' && ok) state.phase = 'verified';
  state.last_verify = { at: now(), cwd, ok, results: results.map((r) => ({ cmd: r.cmd, exit: r.exit })) };
  saveState(run, state);
  emit({
    ok, cwd, results,
    note: plan.verify.length ? undefined : 'The plan has no verify commands.',
    next: ok ? (laneId ? 'continue' : 'finish') : 'ask the owning agent to fix (ask --mode write --cwd repo), commit, then verify again',
  });
}

async function finish(opt) {
  const { run, state } = ctx(opt);
  ensureIdle(run, state);
  const removed = [];
  if (!opt.keep) {
    for (const lane of Object.values(state.lanes || {})) {
      if (fs.existsSync(lane.worktree)) {
        const r = git(state.repo, ['worktree', 'remove', '--force', lane.worktree], { allowFail: true });
        if (r.code !== 0) fs.rmSync(lane.worktree, { recursive: true, force: true });
      }
      if (lane.merged || opt['drop-unmerged']) git(state.repo, ['branch', '-D', lane.branch], { allowFail: true });
      removed.push(lane.worktree);
    }
    git(state.repo, ['worktree', 'prune'], { allowFail: true });
    const runDir = path.join(path.dirname(state.repo), `${path.basename(state.repo)}.team-worktrees`, state.id);
    for (const d of [runDir, path.dirname(runDir)]) {
      try { if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* keep */ }
    }
  }
  state.phase = 'done';
  state.finished = now();
  saveState(run, state);
  const covered = [];
  for (const h of state.history) for (const j of h.jobs) if (j.covered_by) covered.push({ step: h.step, job: j.id, covered_by: j.covered_by });
  emit({
    ok: true,
    run,
    files: {
      request: path.join(run, 'request.md'),
      design: fs.existsSync(path.join(run, 'design.md')) ? path.join(run, 'design.md') : null,
      discussion: fs.existsSync(path.join(run, 'discussion.md')) ? path.join(run, 'discussion.md') : null,
      report: path.join(run, 'report.md'),
    },
    lanes: Object.values(state.lanes || {}).map((l) => ({
      id: l.id, title: l.title, built_by: NAME[l.agent], reviewed_by: NAME[l.reviewer],
      review_rounds: l.review_round || 0, last_verdict: l.last_verdict, merged: l.merged, commit: l.merge_commit || null,
    })),
    fallbacks: covered,
    last_verify: state.last_verify || null,
    notes: state.notes,
    removed_worktrees: removed,
    steps: state.history.map((h) => ({ step: h.step, jobs: h.jobs.map((j) => `${j.id}:${j.status}:${j.seconds ?? '?'}s`) })),
    signature: SIGNATURE[state.ui] || SIGNATURE.en,
    next: 'write report.md in the run folder (owner\'s language), end it with the signature line verbatim, and give the owner the short version',
  });
}

// ---------------------------------------------------------------- commands: status, wait

async function status(opt) {
  const { run, state } = ctx(opt);
  let running = null;
  if (state.running) {
    const b = readJSON(batchFile(run, state.running.batch));
    running = {
      ...state.running,
      alive: !!b && (pidAlive(b.pid) || b.status === 'pending'),
      jobs: (b?.jobs || []).map((j) => ({ id: j.id, status: j.status, ran_as: j.ran_as || null, seconds: j.started ? Math.round((Date.now() - Date.parse(j.started)) / 1000) : null })),
    };
  }
  const files = ['request.md', 'design.md', 'discussion.md', 'plan.json', 'report.md'].filter((f) => fs.existsSync(path.join(run, f)));
  emit({
    ok: true, run, id: state.id, repo: state.repo, phase: state.phase, small: state.small, language: state.language,
    running,
    steps_done: state.history.map((h) => `${h.step}(${h.jobs.map((j) => `${j.ran_as || j.agent}:${j.status}`).join(',')})`),
    lanes: Object.values(state.lanes || {}).map((l) => ({
      id: l.id, agent: l.agent, implemented: l.implemented, review_round: l.review_round, last_verdict: l.last_verdict, merged: l.merged,
    })),
    merge_pending: state.merge_pending || null,
    files,
    next: nextHint(run, state),
  });
}

async function cmdWait(opt) {
  const { run, state } = ctx(opt);
  const id = opt.batch && opt.batch !== true ? String(opt.batch) : state.running?.batch || state.history[state.history.length - 1]?.batch;
  if (!id) fail('Nothing to wait for.');
  const maxSec = opt.max !== undefined && opt.max !== true ? Number(opt.max) : DEFAULT_WAIT_SEC;
  emit(await waitBatch(run, id, maxSec));
}

// ---------------------------------------------------------------- live view (serve)

function tailLines(file, maxBytes = 400000) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  }
}

function relTo(p, cwd) {
  const s = String(p || '');
  if (!cwd) return s;
  const norm = (x) => x.replace(/\\/g, '/').toLowerCase();
  return norm(s).startsWith(`${norm(cwd)}/`) ? s.slice(cwd.length + 1).replace(/\\/g, '/') : s;
}

// "powershell.exe -Command "rg -n tags src"" → "rg -n tags src"
function shortCmd(cmd, cwd) {
  let c = String(cmd || '');
  const m = /-Command\s+(["'])([\s\S]*)\1\s*$/i.exec(c) || /\s-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(c);
  if (m) c = m[2];
  c = c.replace(/'"'/g, "'").replace(/\\\\/g, '\\');
  if (cwd) c = c.split(cwd).join('.').split(cwd.replace(/\\/g, '/')).join('.');
  c = c.replace(/\s+/g, ' ').trim();
  return c.length > 160 ? `${c.slice(0, 160)}…` : c;
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map((x) => x.replace(/^[#>*\s-]+|[*`]+/g, '').trim()).find(Boolean) || '';
  return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

// What a colleague is doing right now, read from its live log.
function liveActivity(logFile, agent, cwd, ui) {
  const acts = [];
  const byId = new Map();
  for (const line of tailLines(logFile)) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (agent === 'codex') {
      const it = ev.item;
      if (!it) continue;
      if (it.type === 'command_execution') {
        const entry = { kind: ev.type === 'item.completed' ? 'done' : 'run', text: shortCmd(it.command, cwd), code: true, exit: it.exit_code ?? null };
        if (byId.has(it.id)) Object.assign(byId.get(it.id), entry);
        else { byId.set(it.id, entry); acts.push(entry); }
      } else if (ev.type === 'item.completed' && it.type === 'agent_message') {
        acts.push({ kind: 'say', text: firstLine(it.text) });
      } else if (ev.type === 'item.completed' && it.type === 'file_change') {
        acts.push({ kind: 'edit', text: (it.changes || []).map((c) => relTo(c.path, cwd)).join(', '), code: true });
      } else if (ev.type === 'item.completed' && it.type === 'reasoning') {
        acts.push({ kind: 'think', text: firstLine(it.text) });
      } else if (ev.type === 'item.completed' && it.type === 'web_search') {
        acts.push({ kind: 'find', text: it.query || '' });
      }
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) acts.push({ kind: 'say', text: firstLine(c.text) });
        if (c.type !== 'tool_use') continue;
        const i = c.input || {};
        const file = relTo(i.file_path || i.notebook_path || i.path || '', cwd);
        const map = {
          Read: ['read', file, true], Grep: ['find', i.pattern, true], Glob: ['find', i.pattern, true],
          Bash: ['run', shortCmd(i.command, cwd), true], PowerShell: ['run', shortCmd(i.command, cwd), true],
          Edit: ['edit', file, true], MultiEdit: ['edit', file, true], Write: ['edit', file, true], NotebookEdit: ['edit', file, true],
          TodoWrite: ['think', ui === 'ar' ? 'رتّب خطوات شغله' : 'planned its steps', false],
        };
        const [kind, text, code] = map[c.name] || ['tool', c.name, false];
        acts.push({ kind, text: String(text || c.name), code });
      }
    }
  }
  return acts.slice(-12);
}

function parseTranscript(md) {
  const re = /^## (.+)\r?\n\r?\n> ([^\n]*?)\s*·\s*(\d+)s\s*·\s*([^\n]*)\r?\n/gm;
  const heads = [];
  let m;
  while ((m = re.exec(md))) heads.push({ index: m.index, end: re.lastIndex, title: m[1].trim(), who: m[2].trim(), seconds: Number(m[3]), at: m[4].trim() });
  return heads.map((h, i) => {
    let body = md.slice(h.end, i + 1 < heads.length ? heads[i + 1].index : md.length).trim();
    const tl = /^TLDR\s*:\s*(.+)$/m.exec(body);
    if (tl) body = body.replace(tl[0], '').trim();
    const agent = /^Claude/i.test(h.who) ? 'claude' : /^Codex/i.test(h.who) ? 'codex' : 'other';
    return { title: h.title, who: h.who, agent, seconds: h.seconds, at: h.at, tldr: tl ? tl[1].trim() : null, body };
  });
}

function liveSnapshot(run) {
  const state = readJSON(path.join(run, 'state.json'), {}) || {};
  let running = null;
  if (state.running?.batch) {
    const bdir = path.join(run, 'batches', state.running.batch);
    const b = readJSON(path.join(bdir, 'batch.json'));
    if (b) {
      running = {
        step: b.step,
        started: b.started || b.created,
        jobs: (b.jobs || []).map((j) => ({
          id: j.id, agent: j.agent, ran_as: j.ran_as || null, status: j.status, lane: j.lane || null,
          started: j.started || null, seconds: j.seconds ?? null,
          activity: j.ran_as ? liveActivity(path.join(bdir, `${j.id}.${j.ran_as}.log`), j.ran_as, j.cwd, state.ui) : [],
        })),
      };
    }
  }
  const has = (f) => fs.existsSync(path.join(run, f));
  return {
    id: state.id, phase: state.phase, small: !!state.small, mode: state.mode || (state.small ? 'small' : 'full'), ui: state.ui,
    created: state.created, finished: state.finished || null,
    request: readText(path.join(run, 'request.md')).trim(),
    running,
    history: (state.history || []).map((h) => ({ step: h.step, finished: h.finished, jobs: h.jobs })),
    transcript: parseTranscript(readText(path.join(run, 'discussion.md'))),
    lanes: Object.values(state.lanes || {}).map((l) => ({ id: l.id, agent: l.agent, title: l.title, review_round: l.review_round, last_verdict: l.last_verdict, merged: l.merged })),
    files: { request: has('request.md'), design: has('design.md'), report: has('report.md') },
  };
}

function openBrowser(url) {
  try {
    const cmd = IS_WIN ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = IS_WIN ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* the owner can open the link by hand */ }
}

// A small local web page where the owner watches the team: who is working, what they are
// doing right now, and the discussion as a chat. Follows the newest run of the project.
async function serve(opt) {
  const http = await import('node:http');
  const htmlPath = path.join(path.dirname(SCRIPT), 'viewer.html');
  const fixedRun = opt.run && opt.run !== true ? path.resolve(String(opt.run)) : null;
  const root = fixedRun ? null : repoRoot(opt.repo && opt.repo !== true ? path.resolve(String(opt.repo)) : process.cwd());
  if (!fixedRun && !root) fail('Run serve from the project root, or pass --repo <dir> or --run <dir>.');
  const currentRun = () => {
    if (fixedRun) return fixedRun;
    const runs = path.join(root, '.team', 'runs');
    if (!fs.existsSync(runs)) return null;
    const names = fs.readdirSync(runs).filter((n) => fs.existsSync(path.join(runs, n, 'state.json'))).sort();
    return names.length ? path.join(runs, names[names.length - 1]) : null;
  };
  const send = (res, code, body, type) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const handler = (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, readText(htmlPath), 'text/html; charset=utf-8');
      if (url.pathname === '/api/ping') return send(res, 200, JSON.stringify({ team: true, repo: root, run: fixedRun }), 'application/json');
      const run = currentRun();
      if (url.pathname === '/api/live') return send(res, 200, JSON.stringify(run ? liveSnapshot(run) : {}), 'application/json; charset=utf-8');
      if (url.pathname === '/api/file') {
        const files = { design: 'design.md', report: 'report.md', request: 'request.md', discussion: 'discussion.md' };
        const name = files[url.searchParams.get('name')];
        if (!run || !name) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, readText(path.join(run, name)), 'text/markdown; charset=utf-8');
      }
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
    }
  };
  const listen = (port, host) => new Promise((resolve) => {
    const s = http.createServer(handler);
    s.once('error', () => resolve(null));
    s.listen(port, host, () => resolve(s));
  });
  const base = Number(opt.port) || 4477;
  for (let port = base; port < base + 20; port++) {
    if (!(await listen(port, '127.0.0.1'))) continue;
    await listen(port, '::1'); // so "localhost" works whichever address the browser tries first
    const url = `http://localhost:${port}`;
    emit({ ok: true, url, following: fixedRun || path.join(root, '.team', 'runs') });
    if (opt.open) openBrowser(url);
    return;
  }
  fail('No free port for the live view.');
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  doctor, new: cmdNew, propose, critique, draft, signoff, revise, edits, plan: cmdPlan,
  prepare, implement, review, fix, consult, ask, merge, verify, finish, status, wait: cmdWait, serve, worker,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opt } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    emit({ ok: true, usage: USAGE });
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) fail(`Unknown command: ${cmd}`, { usage: USAGE });
  await fn(opt);
}

// Run as a command; when imported (tests), only expose the helpers below.
function isDirectRun() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const [a, b] = [real(process.argv[1]), real(SCRIPT)];
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isDirectRun()) {
  main().catch((e) => {
    emit({ ok: false, error: e.message, where: (e.stack || '').split('\n').slice(1, 4).map((s) => s.trim()) });
    process.exit(1);
  });
}

export { validateReview, detectChecks, detectSetup, parseMarkers, runProcess, globToRegex, patternsOverlap };
