// HERMES_HOME + install-stamp + bootstrap-marker paths for Hermes-Lite.
//
// Minimal port of apps/desktop/electron/main.cjs:244-366 (loadInstallStamp,
// resolveHermesHome, ACTIVE_HERMES_ROOT, VENV_ROOT, BOOTSTRAP_COMPLETE_MARKER).
// Standalone (not imported from apps/desktop) so this shell never couples to
// that churned tree. Layout matches scripts/install.ps1 / install.sh exactly so
// a desktop-lite user and a CLI user share one install under HERMES_HOME.
//
// Simplification vs apps/desktop: we skip the Windows live-registry HERMES_HOME
// probe (readWindowsUserEnvVar) — it covers a setx-after-login edge case and
// would need another ported file. env var + %LOCALAPPDATA%\hermes default is
// enough for v1.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'
const INSTALL_STAMP_SCHEMA_VERSION = 2
// Oldest stamp schema this reader still accepts. v1 stamps lack repo fields and
// fall back to upstream; v2 adds repoUrl/Owner/Name for fork bootstrap.
const INSTALL_STAMP_MIN_SCHEMA_VERSION = 1
const BOOTSTRAP_MARKER_SCHEMA_VERSION = 1

function directoryExists(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function normalizeHermesHomeRoot(root) {
  return path.resolve(String(root).replace(/[\\/]+$/, ''))
}

// HERMES_HOME — user-facing root. Windows: %LOCALAPPDATA%\hermes (matches
// install.ps1). macOS/Linux: ~/.hermes (matches install.sh). Honors an existing
// legacy ~/.hermes on Windows so we don't orphan a prior setup.
function resolveHermesHome() {
  if (process.env.HERMES_HOME) return normalizeHermesHomeRoot(process.env.HERMES_HOME)
  if (IS_WIN && process.env.LOCALAPPDATA) {
    const localappdata = path.join(process.env.LOCALAPPDATA, 'hermes')
    const legacy = path.join(os.homedir(), '.hermes')
    if (!directoryExists(localappdata) && directoryExists(legacy)) return legacy
    return localappdata
  }
  return path.join(os.homedir(), '.hermes')
}

const HERMES_HOME = resolveHermesHome()
// ACTIVE_HERMES_ROOT — the canonical mutable install, same path install.ps1/sh
// use, so desktop-lite and CLI users share one checkout.
const ACTIVE_HERMES_ROOT = path.join(HERMES_HOME, 'hermes-agent')
// VENV_ROOT — venv lives inside the checkout, exactly like install.ps1 does it.
const VENV_ROOT = path.join(ACTIVE_HERMES_ROOT, 'venv')
// Marker lives INSIDE the checkout so deleting the checkout also clears it.
const BOOTSTRAP_COMPLETE_MARKER = path.join(ACTIVE_HERMES_ROOT, '.hermes-bootstrap-complete')

// Resolve the venv's hermes executable (the post-bootstrap install path).
function venvHermesExe() {
  const sub = IS_WIN ? 'Scripts' : 'bin'
  const exe = IS_WIN ? 'hermes.exe' : 'hermes'
  return path.join(VENV_ROOT, sub, exe)
}

// True when a prior bootstrap finished: marker present with a valid schema AND
// the venv hermes actually exists on disk (marker without binary = stale).
function isBootstrapComplete() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOOTSTRAP_COMPLETE_MARKER, 'utf8'))
    if (!parsed || parsed.schemaVersion !== BOOTSTRAP_MARKER_SCHEMA_VERSION) return false
  } catch {
    return false
  }
  return fs.existsSync(venvHermesExe())
}

// Write the bootstrap-complete marker. Passed as `writeMarker` to runBootstrap.
function writeBootstrapMarker(payload = {}) {
  const marker = {
    schemaVersion: BOOTSTRAP_MARKER_SCHEMA_VERSION,
    pinnedCommit: payload.pinnedCommit || null,
    pinnedBranch: payload.pinnedBranch || null,
    completedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(BOOTSTRAP_COMPLETE_MARKER), { recursive: true })
  fs.writeFileSync(BOOTSTRAP_COMPLETE_MARKER, JSON.stringify(marker, null, 2) + '\n', 'utf8')
  return marker
}

// Load install-stamp.json (packaged: resourcesPath; local: build/). Tells the
// bootstrap which commit/branch to clone. Null when absent (dev-from-checkout
// doesn't need it — bootstrap-runner falls back to the local install script).
function loadInstallStamp(appRoot) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'install-stamp.json') : null,
    appRoot ? path.join(appRoot, 'build', 'install-stamp.json') : null,
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed.commit === 'string' && parsed.commit.length >= 7) {
        // Accept any schema >= 1: v1 has no repo fields (→ null → upstream
        // fallback in bootstrap-runner), v2+ adds repoUrl/Owner/Name pointing
        // at the fork. Rejecting on exact-match would break older stamps.
        if (!(parsed.schemaVersion >= INSTALL_STAMP_MIN_SCHEMA_VERSION)) continue
        return Object.freeze({
          schemaVersion: parsed.schemaVersion,
          commit: parsed.commit,
          branch: parsed.branch || null,
          builtAt: parsed.builtAt || null,
          dirty: Boolean(parsed.dirty),
          source: parsed.source || null,
          repoUrl: parsed.repoUrl || null,
          repoOwner: parsed.repoOwner || null,
          repoName: parsed.repoName || null,
          path: p,
        })
      }
    } catch {
      // ENOENT or malformed — try next candidate.
    }
  }
  return null
}

module.exports = {
  HERMES_HOME,
  ACTIVE_HERMES_ROOT,
  VENV_ROOT,
  BOOTSTRAP_COMPLETE_MARKER,
  venvHermesExe,
  isBootstrapComplete,
  writeBootstrapMarker,
  loadInstallStamp,
  resolveHermesHome,
  INSTALL_STAMP_SCHEMA_VERSION,
  INSTALL_STAMP_MIN_SCHEMA_VERSION,
  BOOTSTRAP_MARKER_SCHEMA_VERSION,
}
