// Hermes-Lite — thin Electron shell.
//
// Spawns `hermes serve` (headless backend), waits for its port announcement,
// then loads the live web dashboard from http://127.0.0.1:<port>/. We load over
// HTTP (not file://) on purpose: the backend's CORS only allows
// http(s)://127.0.0.1 origins (web_server.py:291) and injects the session token
// into index.html on each live serve (web_server.py:13970) — a file:// origin
// would break both REST auth and CORS. See apps/desktop-lite/CUSTOM_ROADMAP.md.

const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')
const { resolveHermesCommand, spawnBackend, waitForReady, killBackend } = require('./backend-lifecycle.cjs')
const { runBootstrap } = require('./bootstrap-runner.cjs')
const {
  HERMES_HOME,
  ACTIVE_HERMES_ROOT,
  isBootstrapComplete,
  writeBootstrapMarker,
  loadInstallStamp,
} = require('./hermes-paths.cjs')

// apps/desktop-lite/electron/main.cjs → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
// The desktop-lite package dir (holds build/install-stamp.json in local builds).
const APP_ROOT = path.resolve(__dirname, '..')

let backendChild = null
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b0b0e',
    title: 'Hermes Lite',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // No preload bridge in v1: the dashboard talks to the backend over
      // standard HTTP/WS. Phase 3 gaps (reveal/trash/dialog) will add one.
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Open real external links (target=_blank / window.open) in the OS browser
  // instead of a naked Electron window. Handled entirely in the shell — no
  // touch to web/ needed.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

function showFatal(message) {
  const win = mainWindow || createWindow()
  const html =
    'data:text/html,' +
    encodeURIComponent(
      `<html><head><meta charset="utf-8"><style>
         body{background:#0b0b0e;color:#e6e6e6;font:14px/1.6 system-ui,sans-serif;
              margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
         .box{max-width:640px;padding:32px}
         h1{font-size:16px;margin:0 0 12px}
         pre{white-space:pre-wrap;color:#ff9b9b;background:#151519;padding:12px;border-radius:8px}
       </style></head><body><div class="box">
         <h1>Hermes Lite không khởi động được</h1>
         <pre>${String(message).replace(/</g, '&lt;')}</pre>
         <p>Xem log chi tiết: chạy lại với <code>HERMES_LITE_DEBUG=1</code>.</p>
       </div></body></html>`,
    )
  win.loadURL(html)
  win.show()
}

function showSimpleLoading(message) {
  mainWindow.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<html><head><meta charset="utf-8"><style>
           body{background:#0b0b0e;color:#9a9aa2;font:14px system-ui,sans-serif;
                margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
         </style></head><body>${String(message).replace(/</g, '&lt;')}</body></html>`,
      ),
  )
}

// A loading page with a live log tail, used during first-launch bootstrap
// (install can take minutes: it fetches uv/python, clones the repo, builds a
// venv). We load it once, then push each log line via executeJavaScript so the
// view scrolls without flicker.
function showBootstrapLoading() {
  const html =
    'data:text/html,' +
    encodeURIComponent(
      `<html><head><meta charset="utf-8"><style>
         body{background:#0b0b0e;color:#e6e6e6;font:13px system-ui,sans-serif;
              margin:0;padding:28px;height:100vh;box-sizing:border-box;display:flex;flex-direction:column}
         h1{font-size:15px;margin:0 0 4px}
         #status{color:#9a9aa2;margin:0 0 14px}
         #log{flex:1;overflow:auto;white-space:pre-wrap;background:#151519;color:#b9c7d6;
              padding:12px;border-radius:8px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0}
       </style></head><body>
         <h1>Đang cài đặt Hermes (lần đầu)</h1>
         <p id="status">Chuẩn bị…</p>
         <pre id="log"></pre>
         <script>
           window.__status = s => { document.getElementById('status').textContent = s }
           window.__append = line => {
             const pre = document.getElementById('log')
             pre.textContent += line + '\\n'
             pre.scrollTop = pre.scrollHeight
           }
         </script>
       </body></html>`,
    )
  return mainWindow.loadURL(html)
}

// Decide where to run the backend from, bootstrapping first if nothing is
// installed yet. Returns the working directory to spawn `hermes serve` in.
//   1. A completed managed install under HERMES_HOME wins (canonical).
//   2. Otherwise a dev checkout / PATH hermes runs in place — no bootstrap.
//   3. Clean machine: run first-launch bootstrap, then use the managed install.
async function resolveBackendRoot() {
  if (isBootstrapComplete()) return ACTIVE_HERMES_ROOT
  if (resolveHermesCommand(REPO_ROOT)) return REPO_ROOT
  await runBootstrapWithUI()
  return ACTIVE_HERMES_ROOT
}

async function runBootstrapWithUI() {
  await showBootstrapLoading()

  const pushJs = code => {
    if (mainWindow) mainWindow.webContents.executeJavaScript(code).catch(() => {})
  }
  const append = line => pushJs(`window.__append(${JSON.stringify(String(line))})`)
  const status = s => pushJs(`window.__status(${JSON.stringify(String(s))})`)

  const result = await runBootstrap({
    installStamp: loadInstallStamp(APP_ROOT),
    activeRoot: ACTIVE_HERMES_ROOT,
    sourceRepoRoot: REPO_ROOT,
    hermesHome: HERMES_HOME,
    logRoot: path.join(HERMES_HOME, 'logs'),
    writeMarker: writeBootstrapMarker,
    onEvent: ev => {
      if (ev.type === 'log') append(ev.line)
      else if (ev.type === 'manifest') status(`Cài đặt: ${ev.stages.length} bước`)
      else if (ev.type === 'stage') {
        append(`[${ev.state}] ${ev.name}`)
        if (ev.state === 'running') status(`Đang chạy: ${ev.name}`)
      } else if (ev.type === 'complete') status('Cài đặt hoàn tất, đang khởi động…')
      else if (ev.type === 'failed') status(`Lỗi cài đặt: ${ev.error || ''}`)
    },
  })

  if (!result || !result.ok) {
    const detail = result ? result.error || result.failedStage || 'không rõ' : 'không rõ'
    throw new Error(`Bootstrap thất bại (${detail}). Xem log tại ${path.join(HERMES_HOME, 'logs')}.`)
  }
}

async function boot() {
  createWindow()
  showSimpleLoading('Đang khởi động Hermes backend…')

  try {
    const backendRoot = await resolveBackendRoot()
    showSimpleLoading('Đang khởi động Hermes backend…')

    backendChild = spawnBackend(backendRoot)
    backendChild.on('exit', (code, signal) => {
      // If the backend dies after we've loaded the UI, surface it rather than
      // leaving a dead window pointed at a closed port.
      if (mainWindow && !app.isQuiting) {
        showFatal(`Hermes backend đã thoát (${signal || code}).`)
      }
    })

    const port = await waitForReady(backendChild)
    if (!mainWindow) createWindow()
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`)
  } catch (err) {
    showFatal((err && err.message) || String(err))
  }
}

// Single-instance: a second launch just focuses the existing window instead of
// spawning a competing backend.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(boot)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    app.isQuiting = true
    killBackend(backendChild)
  })

  app.on('quit', () => killBackend(backendChild))
}
