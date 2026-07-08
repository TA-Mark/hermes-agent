// Backend process lifecycle for the thin Hermes-Lite shell.
//
// Standalone reimplementation (NOT imported from apps/desktop/electron/*) so
// this shell never couples to that heavily-churned tree. Logic mirrors the
// shape of apps/desktop/electron/backend-{command,ready}.cjs but stays minimal:
// we assume the user already has a working `hermes` install (venv or PATH),
// matching their "run upstream as-is" setup.

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { venvHermesExe } = require('./hermes-paths.cjs')

const READY_RE = /^HERMES_DASHBOARD_READY port=(\d+)/m
const DEFAULT_READY_TIMEOUT_MS = 90_000
const IS_WIN = process.platform === 'win32'

function debug(...args) {
  if (process.env.HERMES_LITE_DEBUG) console.log('[hermes-lite]', ...args)
}

// Candidate `hermes` executables, most-specific first. Resolves against:
//   1. HERMES_LITE_HERMES_BIN explicit override
//   2. the post-bootstrap install under HERMES_HOME/hermes-agent/venv
//   3. a repo-local .venv (Scripts on Windows, bin on POSIX) — dev checkout
//   4. `hermes` on PATH
//   5. `python -m hermes_cli.main` fallback (needs repo on PYTHONPATH / installed)
function hermesCandidates(repoRoot) {
  const out = []
  const override = process.env.HERMES_LITE_HERMES_BIN
  if (override) out.push({ cmd: override, args: [] })

  // Post-bootstrap install under HERMES_HOME/hermes-agent/venv — the path a
  // packaged install produces (shared with CLI users). Highest priority after
  // an explicit override so a real install wins over an incidental repo .venv.
  out.push({ cmd: venvHermesExe(), args: [], mustExist: true })

  const venvName = IS_WIN ? 'Scripts' : 'bin'
  const exe = IS_WIN ? 'hermes.exe' : 'hermes'
  const venvBin = path.join(repoRoot, '.venv', venvName, exe)
  out.push({ cmd: venvBin, args: [], mustExist: true })

  out.push({ cmd: 'hermes', args: [] })

  const py = IS_WIN ? 'python' : 'python3'
  out.push({ cmd: py, args: ['-m', 'hermes_cli.main'] })
  return out
}

// Probe a candidate cheaply: existing file, or `--version` returns 0.
function candidateWorks(cand) {
  if (cand.mustExist) return fs.existsSync(cand.cmd)
  try {
    const r = spawnSync(cand.cmd, [...cand.args, '--version'], {
      stdio: 'ignore',
      timeout: 8000,
      windowsHide: true,
    })
    return r.status === 0 || r.status === null ? r.error == null : false
  } catch {
    return false
  }
}

function resolveHermesCommand(repoRoot) {
  for (const cand of hermesCandidates(repoRoot)) {
    if (candidateWorks(cand)) {
      debug('resolved hermes command:', cand.cmd, cand.args.join(' '))
      return cand
    }
  }
  return null
}

// True when the web SPA has already been built, so we can pass --skip-build and
// avoid waiting on npm at every launch. WEB_DIST defaults to hermes_cli/web_dist
// (web_server.py:121); honor the HERMES_WEB_DIST override too.
function webIsBuilt(repoRoot) {
  const dist = process.env.HERMES_WEB_DIST
    ? path.resolve(process.env.HERMES_WEB_DIST)
    : path.join(repoRoot, 'hermes_cli', 'web_dist')
  return fs.existsSync(path.join(dist, 'index.html'))
}

function spawnBackend(repoRoot) {
  const cmd = resolveHermesCommand(repoRoot)
  if (!cmd) {
    throw new Error(
      'Không tìm thấy `hermes` (đã thử .venv/Scripts, PATH, python -m hermes_cli.main). ' +
        'Cài Hermes hoặc set HERMES_LITE_HERMES_BIN.',
    )
  }

  const args = [...cmd.args, 'serve', '--host', '127.0.0.1', '--port', '0', '--no-open']
  if (webIsBuilt(repoRoot)) {
    args.push('--skip-build')
    debug('web_dist present → --skip-build')
  } else {
    debug('web_dist missing → backend will build the SPA (slower first launch)')
  }

  debug('spawning:', cmd.cmd, args.join(' '), 'cwd=', repoRoot)
  const child = spawn(cmd.cmd, args, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  child.stderr.on('data', (d) => debug('backend stderr:', d.toString().trimEnd()))
  return child
}

// Watch stdout for `HERMES_DASHBOARD_READY port=<N>` (web_server.py:15342).
// Tolerant of the line arriving split across chunks. Rejects on early exit,
// error, or timeout. A single cleanup() tears down every listener.
function waitForReady(child, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let done = false

    function cleanup() {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    function onData(chunk) {
      const text = chunk.toString()
      debug('backend stdout:', text.trimEnd())
      buf += text
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const m = line.match(READY_RE)
        if (m) {
          cleanup()
          resolve(parseInt(m[1], 10))
          return
        }
      }
    }

    function onExit(code, signal) {
      cleanup()
      reject(new Error(`Hermes backend thoát trước khi announce port (${signal || code})`))
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Quá thời gian chờ Hermes backend announce port (${timeoutMs}ms)`))
    }, timeoutMs)

    child.stdout.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

// Kill the backend and its whole descendant tree. On Windows a plain SIGTERM
// leaves grandchild processes (uvicorn workers, git/gh spawns) orphaned, so use
// taskkill /t. Best-effort — never throws.
function killBackend(child) {
  if (!child || child.killed || child.exitCode != null) return
  try {
    if (IS_WIN && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch (err) {
    debug('killBackend error (ignored):', err && err.message)
  }
}

module.exports = {
  resolveHermesCommand,
  webIsBuilt,
  spawnBackend,
  waitForReady,
  killBackend,
  READY_RE,
  DEFAULT_READY_TIMEOUT_MS,
}
