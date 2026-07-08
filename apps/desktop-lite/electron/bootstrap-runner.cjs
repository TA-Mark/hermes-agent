'use strict'

/**
 * bootstrap-runner.cjs (Hermes-Lite)
 *
 * Drives the first-launch install of Hermes Agent on a clean machine by
 * spawning scripts/install.ps1 (Windows) / install.sh (posix) stage-by-stage
 * and streaming progress events to a caller-supplied `onEvent` sink. In
 * desktop-lite that sink pipes into main.cjs's loading page (no renderer IPC).
 *
 * Ported near-verbatim from apps/desktop/electron/bootstrap-runner.cjs: that
 * file is already pure node (fs/https/child_process, zero Electron/renderer
 * coupling) and drives the SAME renderer-independent install script. We keep it
 * a standalone copy so this shell never couples to that churned tree.
 *
 * Wired from electron/main.cjs:
 *   const { runBootstrap } = require('./bootstrap-runner.cjs')
 *   const result = await runBootstrap({
 *     installStamp,        // loadInstallStamp() from hermes-paths.cjs (may be null in dev)
 *     activeRoot,          // ACTIVE_HERMES_ROOT
 *     sourceRepoRoot,      // repo root (for dev install.ps1 lookup)
 *     hermesHome,          // HERMES_HOME
 *     logRoot,             // HERMES_HOME/logs
 *     onEvent: ev => {...},// event sink (streams into loading page)
 *     writeMarker,         // writeBootstrapMarker from hermes-paths.cjs
 *   })
 *
 * Emits events with shape:
 *   { type: 'manifest',  stages: [{name, title, category, needs_user_input}, ...] }
 *   { type: 'stage',     name, state: 'running'|'succeeded'|'skipped'|'failed',
 *                        json?, durationMs?, error? }
 *   { type: 'log',       stage?, line, stream: 'stdout'|'stderr' } // raw line from install script
 *   { type: 'complete',  marker: <written marker payload> }
 *   { type: 'failed',    stage?, error }     // bootstrap aborted
 *
 * Resolves with the same shape as the final 'complete' or 'failed' event so
 * callers can await either way.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const { spawn, spawnSync } = require('node:child_process')

const IS_WINDOWS = process.platform === 'win32'

function hiddenWindowsChildOptions(options = {}) {
  if (!IS_WINDOWS || Object.prototype.hasOwnProperty.call(options, 'windowsHide')) {
    return options
  }
  return { ...options, windowsHide: true }
}

const STAMP_COMMIT_RE = /^[0-9a-f]{7,40}$/i

// Repository the packaged app clones / fetches install.ps1 from. Defaults to
// NousResearch upstream; overridden per-build by the install-stamp's
// repoOwner/repoName so a fork build installs the fork's code (custom web/
// pages included). Single source of truth for both the raw-script fetch and
// the pre-seed clone.
const DEFAULT_REPO_OWNER = 'NousResearch'
const DEFAULT_REPO_NAME = 'hermes-agent'

// Stages flagged needs_user_input=true in the manifest are skipped by the
// runner (passed -NonInteractive to install.ps1, which the install script
// itself handles by emitting skipped=true frames). We let install.ps1's own
// -NonInteractive logic drive this rather than filtering client-side --
// single source of truth.

// ---------------------------------------------------------------------------
// install.ps1 source resolution
// ---------------------------------------------------------------------------

function installScriptName() {
  return process.platform === 'win32' ? 'install.ps1' : 'install.sh'
}

function installScriptKind() {
  return process.platform === 'win32' ? 'powershell' : 'posix'
}

function resolveLocalInstallScript(sourceRepoRoot) {
  if (!sourceRepoRoot) return null
  const candidate = path.join(sourceRepoRoot, 'scripts', installScriptName())
  try {
    fs.accessSync(candidate, fs.constants.R_OK)
    return candidate
  } catch {
    return null
  }
}

function bootstrapCacheDir(hermesHome) {
  return path.join(hermesHome, 'bootstrap-cache')
}

// The install.sh / install.ps1 that ships inside the already-installed agent
// checkout under HERMES_HOME/hermes-agent. Used as a last-resort fallback when
// the pinned commit can't be fetched from GitHub (e.g. a locally-built desktop
// app stamped to an unpushed HEAD).
function installedAgentInstallScript(hermesHome) {
  if (!hermesHome) return null
  const candidate = path.join(hermesHome, 'hermes-agent', 'scripts', installScriptName())
  try {
    fs.accessSync(candidate, fs.constants.R_OK)
    return candidate
  } catch {
    return null
  }
}

function cachedScriptPath(hermesHome, commit) {
  return path.join(bootstrapCacheDir(hermesHome), `install-${commit}.${process.platform === 'win32' ? 'ps1' : 'sh'}`)
}

// HTTP statuses worth retrying: request timeout / too-early, throttling, and
// transient server-side faults. A 404 (unpushed commit) is NOT here — retrying
// it is futile and should fall through to the installed-agent fallback fast.
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const DOWNLOAD_MAX_ATTEMPTS = 4
const DOWNLOAD_BASE_BACKOFF_MS = 800
const DOWNLOAD_MAX_BACKOFF_MS = 8000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null.
function parseRetryAfterMs(value) {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(value)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return null
}

// One download attempt. Resolves destPath on HTTP 200. Rejects with an Error
// whose `.transient` flag says whether a retry could plausibly help (429/5xx
// and network-level errors are transient; a 404 is not) and `.retryAfterMs`
// carries a parsed Retry-After hint when the server sent one.
function downloadInstallScriptOnce(commit, destPath, opts = {}) {
  const owner = opts.repoOwner || DEFAULT_REPO_OWNER
  const repo = opts.repoName || DEFAULT_REPO_NAME
  const scriptName = installScriptName()
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/scripts/${scriptName}`
  // A real User-Agent materially lowers raw.githubusercontent throttling versus
  // an empty/anonymous UA (which 429s aggressively).
  const reqOpts = { headers: { 'User-Agent': 'hermes-lite-bootstrap', Accept: '*/*' } }
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const tmpPath = destPath + '.tmp'

    const fail = (err, { statusCode, retryAfterMs } = {}) => {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        void 0
      }
      if (statusCode != null) err.statusCode = statusCode
      // No statusCode → network-level error (ECONNRESET/ETIMEDOUT/…): transient.
      err.transient = statusCode == null || TRANSIENT_HTTP_STATUS.has(statusCode)
      if (retryAfterMs != null) err.retryAfterMs = retryAfterMs
      reject(err)
    }

    const onResponse = (res, sourceUrl) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        // GitHub raw shouldn't redirect for a SHA URL, but follow once defensively.
        res.resume()
        https
          .get(res.headers.location, reqOpts, r2 => onResponse(r2, res.headers.location))
          .on('error', e => fail(e))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        fail(new Error(`Failed to download ${scriptName}: HTTP ${res.statusCode} from ${sourceUrl}`), {
          statusCode: res.statusCode,
          retryAfterMs: parseRetryAfterMs(res.headers['retry-after']),
        })
        return
      }
      const out = fs.createWriteStream(tmpPath)
      res.pipe(out)
      out.on('finish', () => {
        out.close()
        try {
          fs.renameSync(tmpPath, destPath)
          resolve(destPath)
        } catch (e) {
          fail(e)
        }
      })
      out.on('error', e => fail(e))
    }

    https.get(url, reqOpts, res => onResponse(res, url)).on('error', e => fail(e))
  })
}

// Fetch install.ps1/install.sh from GitHub raw at the pinned (immutable) commit,
// retrying transient failures (429 throttling, 5xx, network blips) with
// exponential backoff. Without this, a single rate-limit response bricks the
// first-launch install on a clean machine (there's no installed-agent checkout
// to fall back to yet). `_attempt`/`_sleep`/`maxAttempts` are injectable for tests.
async function downloadInstallScript(commit, destPath, opts = {}) {
  const attempt = opts._attempt || downloadInstallScriptOnce
  const sleepFn = opts._sleep || sleep
  const maxAttempts = opts.maxAttempts || DOWNLOAD_MAX_ATTEMPTS
  let lastErr
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await attempt(commit, destPath, opts)
    } catch (err) {
      lastErr = err
      if (!err.transient || i === maxAttempts) throw err
      const backoff =
        err.retryAfterMs != null
          ? Math.min(err.retryAfterMs, DOWNLOAD_MAX_BACKOFF_MS)
          : Math.min(DOWNLOAD_BASE_BACKOFF_MS * 2 ** (i - 1), DOWNLOAD_MAX_BACKOFF_MS)
      if (typeof opts.onRetry === 'function') {
        opts.onRetry({ attempt: i, maxAttempts, delayMs: backoff, error: err })
      }
      await sleepFn(backoff)
    }
  }
  throw lastErr
}

async function resolveInstallScript({
  installStamp,
  sourceRepoRoot,
  hermesHome,
  emit,
  _download = downloadInstallScript
}) {
  // 1. Dev shortcut: prefer a local checkout's installer so we can iterate
  //    without pushing. sourceRepoRoot comes from main.cjs (REPO_ROOT).
  const localScript = resolveLocalInstallScript(sourceRepoRoot)
  if (localScript) {
    emit({ type: 'log', line: `[bootstrap] using local ${installScriptName()} at ${localScript}` })
    return { path: localScript, source: 'local', kind: installScriptKind() }
  }

  // 2. Packaged path: download from GitHub at the pinned commit (build stamp).
  if (!installStamp || !installStamp.commit || !STAMP_COMMIT_RE.test(installStamp.commit)) {
    throw new Error(
      `Cannot resolve ${installScriptName()}: no sourceRepoRoot and no install stamp. ` +
        'This packaged build was produced without a valid build-time stamp.'
    )
  }

  const cached = cachedScriptPath(hermesHome, installStamp.commit)
  try {
    await fsp.access(cached, fs.constants.R_OK)
    emit({
      type: 'log',
      line: `[bootstrap] using cached ${installScriptName()} for ${installStamp.commit.slice(0, 12)}`
    })
    return { path: cached, source: 'cache', commit: installStamp.commit, kind: installScriptKind() }
  } catch {
    // not cached; download
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] fetching ${installScriptName()} for ${installStamp.commit.slice(0, 12)} from ` +
      `${installStamp.repoOwner || DEFAULT_REPO_OWNER}/${installStamp.repoName || DEFAULT_REPO_NAME}`
  })
  try {
    await _download(installStamp.commit, cached, {
      repoOwner: installStamp.repoOwner,
      repoName: installStamp.repoName,
      onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
        emit({
          type: 'log',
          line:
            `[bootstrap] download attempt ${attempt}/${maxAttempts} failed ` +
            `(${error.message}); retrying in ${Math.round(delayMs / 1000)}s`
        })
      },
    })
    emit({ type: 'log', line: `[bootstrap] saved to ${cached}` })
    return { path: cached, source: 'download', commit: installStamp.commit, kind: installScriptKind() }
  } catch (err) {
    // The pinned commit may not be fetchable from GitHub -- most commonly a
    // locally-built desktop app stamped to an unpushed HEAD (see
    // write-build-stamp.cjs fromLocalGit). Fall back to the installer that
    // ships inside the already-installed agent checkout so dev/self-builds can
    // still bootstrap instead of dying with a fatal 404.
    const installed = installedAgentInstallScript(hermesHome)
    if (installed) {
      emit({
        type: 'log',
        line:
          `[bootstrap] GitHub fetch failed (${err.message}); ` +
          `falling back to installed agent ${installScriptName()} at ${installed}`
      })
      try {
        fs.mkdirSync(path.dirname(cached), { recursive: true })
        fs.copyFileSync(installed, cached)
        return { path: cached, source: 'installed-agent', commit: installStamp.commit, kind: installScriptKind() }
      } catch {
        // Cache copy failed (read-only FS, etc.) -- use the source path directly.
        return { path: installed, source: 'installed-agent', commit: installStamp.commit, kind: installScriptKind() }
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// powershell wrapper
// ---------------------------------------------------------------------------

// Canonical PowerShell 5.1 location under a Windows root (%SystemRoot%).
function powershellUnderRoot(root) {
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// Resolve the PowerShell interpreter to spawn.
//
// Spawning bare 'powershell.exe' trusts PATH to contain
// %SystemRoot%\System32\WindowsPowerShell\v1.0. On machines whose PATH was
// trimmed, truncated, or stored as a non-expanding REG_SZ (so %SystemRoot%
// never expands), that lookup fails and the spawn dies with ENOENT before
// install.ps1 ever runs — the installer stalls at "0 of 0 steps". Resolve by
// absolute path first, then fall back to PATH (powershell 5.1, then pwsh 7),
// then a bare name as a last resort.
function resolveWindowsPowerShell() {
  for (const v of ['SystemRoot', 'windir']) {
    const root = process.env[v]
    if (root) {
      const candidate = powershellUnderRoot(root)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        void 0
      }
    }
  }
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, exe)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        void 0
      }
    }
  }
  return 'powershell.exe'
}

function spawnPowerShell(scriptPath, args, { emit, stageName, abortSignal, hermesHome } = {}) {
  return new Promise((resolve, reject) => {
    const ps = process.platform === 'win32' ? resolveWindowsPowerShell() : 'pwsh'
    const fullArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]

    const child = spawn(
      ps,
      fullArgs,
      hiddenWindowsChildOptions({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Pass HERMES_HOME through so install.ps1 respects the caller's
          // choice rather than re-computing the default.
          HERMES_HOME: hermesHome || process.env.HERMES_HOME || ''
        }
      })
    )

    let stdout = ''
    let stderr = ''
    let killed = false

    const onAbort = () => {
      killed = true
      try {
        child.kill('SIGTERM')
      } catch {
        void 0
      }
    }
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    // Stream stdout line-by-line so the loading page sees progress in real time.
    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuf += chunk
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line) emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      stderr += chunk
      stderrBuf += chunk
      let nl
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)
        if (line) emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
      }
    })

    child.on('error', err => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      // Flush any trailing bytes
      if (stdoutBuf) emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' })
      if (stderrBuf) emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' })
      resolve({ stdout, stderr, code, signal, killed })
    })
  })
}

function spawnBash(scriptPath, args, { emit, stageName, abortSignal, hermesHome } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HERMES_HOME: hermesHome || process.env.HERMES_HOME || ''
      }
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const onAbort = () => {
      killed = true
      try {
        child.kill('SIGTERM')
      } catch {
        void 0
      }
    }
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuf += chunk
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line) emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      stderr += chunk
      stderrBuf += chunk
      let nl
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)
        if (line) emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
      }
    })

    child.on('error', err => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      if (stdoutBuf) emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' })
      if (stderrBuf) emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' })
      resolve({ stdout, stderr, code, signal, killed })
    })
  })
}

// ---------------------------------------------------------------------------
// Fork pre-seed clone
// ---------------------------------------------------------------------------
//
// install.ps1 / install.sh hardcode NousResearch as the clone URL and expose no
// -RepoUrl flag. But their repository stage takes an UPDATE path (git fetch
// origin) when the install dir is already a valid git repo — it never touches
// the hardcoded URL then. So to install a FORK we clone it into place ourselves
// BEFORE the repository stage runs; the installer then just fetches/checks out
// against origin=fork. Nothing in the upstream installer is modified.

// Resolve a usable git executable. Prefer the PortableGit the install's `git`
// stage just dropped under HERMES_HOME (its bin isn't on our frozen PATH),
// then fall back to PATH git. Returns null if none works.
function resolveGitExe(hermesHome) {
  const candidates = []
  if (hermesHome) {
    if (IS_WINDOWS) {
      candidates.push(path.join(hermesHome, 'git', 'cmd', 'git.exe'))
      candidates.push(path.join(hermesHome, 'git', 'bin', 'git.exe'))
    } else {
      candidates.push(path.join(hermesHome, 'git', 'bin', 'git'))
    }
  }
  candidates.push(IS_WINDOWS ? 'git.exe' : 'git')
  for (const exe of candidates) {
    try {
      const r = spawnSync(exe, ['--version'], { stdio: 'ignore', timeout: 8000, windowsHide: true })
      if (r.status === 0) return exe
    } catch {
      void 0
    }
  }
  return null
}

// Download a GitHub archive ZIP for a ref (commit preferred, else branch) and
// extract it into destDir, then `git init` + set origin so the installer's
// update path works afterwards. Only reached when `git clone` fails.
function downloadRepoZip({ owner, repo, commit, branch, destPath }) {
  const ref = commit || branch
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${ref}`
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const out = fs.createWriteStream(destPath)
    const get = u =>
      https
        .get(u, res => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            res.resume()
            get(res.headers.location)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            reject(new Error(`ZIP download HTTP ${res.statusCode} from ${u}`))
            return
          }
          res.pipe(out)
          out.on('finish', () => {
            out.close()
            resolve(destPath)
          })
          out.on('error', reject)
        })
        .on('error', reject)
    get(url)
  })
}

// Extract a GitHub archive ZIP (which nests everything under a single
// "<repo>-<ref>/" top dir) so its CONTENTS land directly in destDir.
function extractRepoZip({ zipPath, destDir, gitExe }) {
  const tmpOut = destDir + '.zip-extract'
  fs.rmSync(tmpOut, { recursive: true, force: true })
  fs.mkdirSync(tmpOut, { recursive: true })
  let r
  if (IS_WINDOWS) {
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    r = spawnSync(ps, ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpOut}' -Force`], {
      stdio: 'ignore', windowsHide: true, timeout: 120000,
    })
  } else {
    r = spawnSync('unzip', ['-q', zipPath, '-d', tmpOut], { stdio: 'ignore', timeout: 120000 })
    if (r.status !== 0) r = spawnSync('tar', ['-xf', zipPath, '-C', tmpOut], { stdio: 'ignore', timeout: 120000 })
  }
  if (!r || r.status !== 0) throw new Error('ZIP extraction failed (no Expand-Archive/unzip/tar)')
  const entries = fs.readdirSync(tmpOut).filter(n => fs.statSync(path.join(tmpOut, n)).isDirectory())
  if (entries.length !== 1) throw new Error(`unexpected ZIP layout (${entries.length} top dirs)`)
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  fs.renameSync(path.join(tmpOut, entries[0]), destDir)
  fs.rmSync(tmpOut, { recursive: true, force: true })
}

// Pre-seed ACTIVE_HERMES_ROOT with a clone of the fork so the installer's
// repository stage takes the fetch-origin update path. No-op when a repo is
// already present or when there's no fork URL (dev / v1 stamp → upstream).
async function ensureForkCheckout({ activeRoot, repoUrl, repoOwner, repoName, branch, commit, hermesHome, emit }) {
  const log = line => emit && emit({ type: 'log', line })
  if (!repoUrl) return { seeded: false, reason: 'no-repo-url' }
  if (fs.existsSync(path.join(activeRoot, '.git'))) {
    log('[bootstrap] fork checkout already present — installer will fetch origin')
    return { seeded: false, reason: 'already-present' }
  }

  const gitExe = resolveGitExe(hermesHome)
  const ref = branch || 'main'

  if (gitExe) {
    log(`[bootstrap] pre-seeding fork clone: ${repoUrl} (${ref}) → ${activeRoot}`)
    fs.mkdirSync(path.dirname(activeRoot), { recursive: true })
    const r = spawnSync(gitExe, ['clone', '--depth', '1', '--branch', ref, repoUrl, activeRoot], {
      stdio: 'ignore', windowsHide: true, timeout: 600000,
    })
    if (r.status === 0) {
      log('[bootstrap] fork clone ok')
      return { seeded: true, method: 'clone' }
    }
    log(`[bootstrap] git clone failed (status ${r.status}); trying ZIP archive`)
  } else {
    log('[bootstrap] no git found for pre-seed; trying ZIP archive')
  }

  // ZIP fallback: download + extract, then git init + origin so future updates
  // fetch the fork (mirrors install.ps1's own ZIP fallback).
  const owner = repoOwner || DEFAULT_REPO_OWNER
  const repo = repoName || DEFAULT_REPO_NAME
  const zipPath = path.join(os.tmpdir(), `hermes-fork-${owner}-${repo}-${(commit || ref).slice(0, 12)}.zip`)
  try {
    fs.rmSync(activeRoot, { recursive: true, force: true })
    await downloadRepoZip({ owner, repo, commit, branch: ref, destPath: zipPath })
    extractRepoZip({ zipPath, destDir: activeRoot, gitExe })
    if (gitExe) {
      spawnSync(gitExe, ['-C', activeRoot, 'init'], { stdio: 'ignore', windowsHide: true, timeout: 60000 })
      spawnSync(gitExe, ['-C', activeRoot, 'remote', 'add', 'origin', repoUrl], { stdio: 'ignore', windowsHide: true, timeout: 60000 })
    }
    log('[bootstrap] fork ZIP extracted')
    return { seeded: true, method: 'zip' }
  } catch (err) {
    throw new Error(
      `Không tải được code fork (${repoUrl}). Clone và ZIP đều thất bại: ${err.message}. ` +
        'Kiểm tra: đã push nhánh/commit lên fork chưa, và máy có mạng không.'
    )
  } finally {
    fs.rmSync(zipPath, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Manifest + stage dispatch
// ---------------------------------------------------------------------------

// Build the install.ps1 pin args (-Commit / -Branch) from the install-stamp
// so the repository stage clones the exact SHA the .exe was tested with
// instead of falling back to install.ps1's default ($Branch = "main").
function buildPinArgs(installStamp) {
  const args = []
  if (installStamp && installStamp.commit) {
    args.push('-Commit', installStamp.commit)
  }
  if (installStamp && installStamp.branch) {
    args.push('-Branch', installStamp.branch)
  }
  return args
}

function buildPosixPinArgs({ installStamp, activeRoot, hermesHome }) {
  const args = ['--dir', activeRoot, '--hermes-home', hermesHome]
  if (installStamp && installStamp.branch) {
    args.push('--branch', installStamp.branch)
  }
  if (installStamp && installStamp.commit) {
    args.push('--commit', installStamp.commit)
  }
  return args
}

async function fetchManifest({ scriptPath, installerKind, emit, hermesHome, activeRoot, installStamp }) {
  const isPosix = installerKind === 'posix'
  const args = isPosix
    ? ['--manifest', ...buildPosixPinArgs({ installStamp, activeRoot, hermesHome })]
    : ['-Manifest', ...buildPinArgs(installStamp)]
  const result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
    emit,
    stageName: '__manifest__',
    hermesHome
  })
  if (result.code !== 0) {
    throw new Error(
      `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} failed: exit ${result.code}\n${result.stderr || result.stdout}`
    )
  }
  // The manifest is the LAST JSON line on stdout (install.ps1 may print
  // banner / info lines first depending on Console.OutputEncoding effects).
  // Find the last line that parses as JSON with a `stages` field.
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && Array.isArray(parsed.stages)) {
        return parsed
      }
    } catch {
      void 0
    }
  }
  throw new Error(
    `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} produced no parseable JSON payload\n${result.stdout}`
  )
}

// Parse the JSON result frame from a stage run. The protocol guarantees
// exactly one JSON line per stage in -Json or -Stage mode.
function parseStageResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed
      }
    } catch {
      void 0
    }
  }
  return null
}

async function runStage({ scriptPath, installerKind, stage, emit, hermesHome, activeRoot, abortSignal, installStamp }) {
  const startedAt = Date.now()
  emit({ type: 'stage', name: stage.name, state: 'running' })

  const isPosix = installerKind === 'posix'
  const args = isPosix
    ? [
        '--stage',
        stage.name,
        '--non-interactive',
        '--json',
        ...buildPosixPinArgs({ installStamp, activeRoot, hermesHome })
      ]
    : ['-Stage', stage.name, '-NonInteractive', '-Json', ...buildPinArgs(installStamp)]
  const result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
    emit,
    stageName: stage.name,
    abortSignal,
    hermesHome
  })

  const durationMs = Date.now() - startedAt

  if (result.killed) {
    const ev = { type: 'stage', name: stage.name, state: 'failed', durationMs, error: 'cancelled by user' }
    emit(ev)
    return ev
  }

  const json = parseStageResult(result.stdout)

  if (!json) {
    const ev = {
      type: 'stage',
      name: stage.name,
      state: 'failed',
      durationMs,
      error: `${isPosix ? 'install.sh --stage' : 'install.ps1 -Stage'} ${stage.name} produced no JSON result frame (exit=${result.code})`,
      json: null
    }
    emit(ev)
    return ev
  }

  if (json.ok && json.skipped) {
    const ev = { type: 'stage', name: stage.name, state: 'skipped', durationMs, json }
    emit(ev)
    return ev
  }
  if (json.ok) {
    const ev = { type: 'stage', name: stage.name, state: 'succeeded', durationMs, json }
    emit(ev)
    return ev
  }
  const ev = {
    type: 'stage',
    name: stage.name,
    state: 'failed',
    durationMs,
    json,
    error: json.reason || `exit code ${result.code}`
  }
  emit(ev)
  return ev
}

// ---------------------------------------------------------------------------
// Per-run log file
// ---------------------------------------------------------------------------

function openRunLog(logRoot) {
  fs.mkdirSync(logRoot, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logRoot, `bootstrap-${ts}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  return { path: logPath, stream }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

async function runBootstrap(opts) {
  const {
    installStamp,
    activeRoot,
    sourceRepoRoot,
    hermesHome,
    logRoot,
    onEvent,
    abortSignal,
    writeMarker // callback to write the bootstrap-complete marker; main.cjs provides
  } = opts

  // Bail before spawning anything if the user already cancelled — otherwise an
  // already-aborted signal would still fetch the manifest (a spawn) before the
  // in-loop abort check fires.
  if (abortSignal && abortSignal.aborted) {
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type: 'failed', error: 'bootstrap cancelled by user' })
      } catch {
        void 0
      }
    }
    return { ok: false, cancelled: true }
  }

  const runLog = openRunLog(logRoot || path.join(hermesHome, 'logs'))

  // Tee every event to the runLog AND the caller's onEvent. This gives us a
  // forensic trail per bootstrap run AND lets the loading page subscribe live.
  const emit = ev => {
    try {
      runLog.stream.write(JSON.stringify(ev) + '\n')
    } catch {
      void 0
    }
    try {
      if (typeof onEvent === 'function') onEvent(ev)
    } catch (err) {
      // Don't let a subscriber bug crash the bootstrap
      runLog.stream.write(`emit error: ${err && err.message}\n`)
    }
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] starting at ${new Date().toISOString()}; ` +
      `activeRoot=${activeRoot}; ` +
      `stamp=${installStamp ? installStamp.commit.slice(0, 12) : '<none>'}; ` +
      `runLog=${runLog.path}`
  })

  try {
    // 1. Resolve the platform installer.
    const scriptInfo = await resolveInstallScript({ installStamp, sourceRepoRoot, hermesHome, emit })
    const installerKind = scriptInfo.kind || 'powershell'

    // 2. Fetch manifest
    const manifest = await fetchManifest({
      scriptPath: scriptInfo.path,
      installerKind,
      emit,
      hermesHome,
      activeRoot,
      installStamp
    })
    emit({
      type: 'manifest',
      stages: manifest.stages,
      protocolVersion: manifest.protocol_version || manifest.protocolVersion || null
    })

    // 3. Iterate stages in order. Stages flagged needs_user_input are still
    //    invoked -- install.ps1's own -NonInteractive handler in those stages
    //    emits skipped=true. We trust the protocol rather than filtering
    //    client-side.
    for (const stage of manifest.stages) {
      if (abortSignal && abortSignal.aborted) {
        emit({ type: 'failed', error: 'bootstrap cancelled by user' })
        return { ok: false, cancelled: true }
      }
      // Pre-seed the fork clone just before the repository stage. The `git`
      // stage (earlier in the manifest) has already installed PortableGit by
      // now, so resolveGitExe finds it. Once seeded, the repository stage takes
      // the installer's fetch-origin update path against the fork.
      if (stage.name === 'repository') {
        await ensureForkCheckout({
          activeRoot,
          repoUrl: installStamp ? installStamp.repoUrl : null,
          repoOwner: installStamp ? installStamp.repoOwner : null,
          repoName: installStamp ? installStamp.repoName : null,
          branch: installStamp ? installStamp.branch : null,
          commit: installStamp ? installStamp.commit : null,
          hermesHome,
          emit,
        })
      }
      const ev = await runStage({
        scriptPath: scriptInfo.path,
        installerKind,
        stage,
        emit,
        hermesHome,
        activeRoot,
        abortSignal,
        installStamp
      })
      if (ev.state === 'failed') {
        emit({ type: 'failed', stage: stage.name, error: ev.error || 'stage failed' })
        return { ok: false, failedStage: stage.name, error: ev.error }
      }
    }

    // 4. Write the bootstrap-complete marker.
    const markerPayload = {
      pinnedCommit: installStamp ? installStamp.commit : null,
      pinnedBranch: installStamp ? installStamp.branch : null
    }
    const marker = typeof writeMarker === 'function' ? writeMarker(markerPayload) : markerPayload
    emit({ type: 'complete', marker })
    return { ok: true, marker }
  } catch (err) {
    emit({ type: 'failed', error: err.message || String(err) })
    return { ok: false, error: err.message || String(err) }
  } finally {
    try {
      runLog.stream.end()
    } catch {
      void 0
    }
  }
}

module.exports = {
  runBootstrap,
  // Exposed for testability
  parseStageResult,
  resolveLocalInstallScript,
  resolveInstallScript,
  installedAgentInstallScript,
  cachedScriptPath,
  ensureForkCheckout,
  resolveGitExe,
  downloadInstallScript
}
