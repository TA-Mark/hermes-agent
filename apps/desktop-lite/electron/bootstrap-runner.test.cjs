'use strict'

// Unit test for bootstrap-runner.cjs. Uses a FAKE install.ps1/install.sh that
// echoes the manifest + per-stage JSON frames the real installer's stage
// protocol produces — so we exercise resolveInstallScript → fetchManifest →
// runStage → writeMarker without git-cloning or building a venv.
//
// Run: node electron/bootstrap-runner.test.cjs

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { runBootstrap, parseStageResult, resolveInstallScript, ensureForkCheckout, downloadInstallScript } =
  require('./bootstrap-runner.cjs')
const { loadInstallStamp } = require('./hermes-paths.cjs')

const IS_WIN = process.platform === 'win32'

function makeFakeInstaller(dir) {
  const scriptsDir = path.join(dir, 'scripts')
  fs.mkdirSync(scriptsDir, { recursive: true })

  if (IS_WIN) {
    // Fake install.ps1 — answers -Manifest with a stage list, and each -Stage
    // with an ok frame. Mirrors install.ps1's -Json single-line contract.
    const ps1 = [
      'param([switch]$Manifest,[string]$Stage,[switch]$NonInteractive,[switch]$Json,[string]$Commit,[string]$Branch)',
      'if ($Manifest) {',
      "  Write-Output '{\"protocol_version\":1,\"stages\":[{\"name\":\"prereqs\",\"title\":\"Prereqs\"},{\"name\":\"repository\",\"title\":\"Repo\"}]}'",
      '  exit 0',
      '}',
      'if ($Stage) {',
      "  Write-Output ('{\"ok\":true,\"stage\":\"' + $Stage + '\",\"skipped\":false}')",
      '  exit 0',
      '}',
      'exit 1',
    ].join('\n')
    fs.writeFileSync(path.join(scriptsDir, 'install.ps1'), ps1, 'utf8')
  } else {
    const sh = [
      '#!/usr/bin/env bash',
      'MANIFEST=0; STAGE=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --manifest) MANIFEST=1;;',
      '    --stage) STAGE="$2"; shift;;',
      '  esac; shift',
      'done',
      'if [ "$MANIFEST" = "1" ]; then',
      '  echo \'{"protocol_version":1,"stages":[{"name":"prereqs","title":"Prereqs"},{"name":"repository","title":"Repo"}]}\'',
      '  exit 0',
      'fi',
      'if [ -n "$STAGE" ]; then',
      '  echo "{\\"ok\\":true,\\"stage\\":\\"$STAGE\\",\\"skipped\\":false}"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n')
    const p = path.join(scriptsDir, 'install.sh')
    fs.writeFileSync(p, sh, 'utf8')
    fs.chmodSync(p, 0o755)
  }
}

test('parseStageResult picks the last valid ok/stage frame', () => {
  assert.deepStrictEqual(parseStageResult('noise\n{"ok":true,"stage":"prereqs"}\n'), {
    ok: true,
    stage: 'prereqs',
  })
  assert.strictEqual(parseStageResult('not json at all'), null)
  // Later valid frame wins over an earlier one.
  const two = '{"ok":false,"stage":"a"}\n{"ok":true,"stage":"b"}'
  assert.deepStrictEqual(parseStageResult(two), { ok: true, stage: 'b' })
})

test('runBootstrap drives the fake installer to completion and writes the marker', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-bs-'))
  makeFakeInstaller(tmp)

  const events = []
  let markerPayload = null

  const result = await runBootstrap({
    installStamp: null, // dev path → resolveLocalInstallScript(sourceRepoRoot)
    activeRoot: path.join(tmp, 'active'),
    sourceRepoRoot: tmp,
    hermesHome: tmp,
    logRoot: path.join(tmp, 'logs'),
    writeMarker: payload => {
      markerPayload = payload
      return { ...payload, schemaVersion: 1, completedAt: 'test' }
    },
    onEvent: ev => events.push(ev),
  })

  assert.strictEqual(result.ok, true, `bootstrap should succeed: ${JSON.stringify(result)}`)

  const manifest = events.find(e => e.type === 'manifest')
  assert.ok(manifest, 'should emit a manifest event')
  assert.strictEqual(manifest.stages.length, 2)

  const succeeded = events.filter(e => e.type === 'stage' && e.state === 'succeeded')
  assert.strictEqual(succeeded.length, 2, 'both stages should succeed')

  assert.ok(events.some(e => e.type === 'complete'), 'should emit complete')
  assert.notStrictEqual(markerPayload, null, 'writeMarker should be called')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('loadInstallStamp: v2 exposes repo fields, v1 loads with nulls (back-compat)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-stamp-'))
  const buildDir = path.join(tmp, 'build')
  fs.mkdirSync(buildDir, { recursive: true })
  const stampPath = path.join(buildDir, 'install-stamp.json')
  const commit = 'd7efbdcfba65e7227408d9705d3350b4c9881eb8'

  // v2 with fork fields
  fs.writeFileSync(stampPath, JSON.stringify({
    schemaVersion: 2, commit, branch: 'CustomDesktop', dirty: false, source: 'local',
    repoUrl: 'https://github.com/TA-Mark/hermes-agent.git', repoOwner: 'TA-Mark', repoName: 'hermes-agent',
  }))
  const v2 = loadInstallStamp(tmp)
  assert.ok(v2, 'v2 stamp should load')
  assert.strictEqual(v2.repoOwner, 'TA-Mark')
  assert.strictEqual(v2.repoName, 'hermes-agent')

  // v1 (no repo fields) must still load, with nulls → upstream fallback
  fs.writeFileSync(stampPath, JSON.stringify({
    schemaVersion: 1, commit, branch: 'main', dirty: false, source: 'local',
  }))
  const v1 = loadInstallStamp(tmp)
  assert.ok(v1, 'v1 stamp should still load (back-compat)')
  assert.strictEqual(v1.repoUrl, null)
  assert.strictEqual(v1.repoOwner, null)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('resolveInstallScript: download URL uses stamp owner/repo, defaults to upstream', async () => {
  const seen = []
  const fakeDownload = (commit, destPath, opts) => {
    seen.push({ commit, opts })
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, '# fake script')
    return Promise.resolve(destPath)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-rslv-'))
  const commit = 'd7efbdcfba65e7227408d9705d3350b4c9881eb8'

  // Fork stamp → owner/repo threaded through to the downloader.
  await resolveInstallScript({
    installStamp: { commit, repoOwner: 'TA-Mark', repoName: 'hermes-agent' },
    sourceRepoRoot: null, hermesHome: tmp, emit: () => {}, _download: fakeDownload,
  })
  assert.strictEqual(seen[0].opts.repoOwner, 'TA-Mark')
  assert.strictEqual(seen[0].opts.repoName, 'hermes-agent')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('ensureForkCheckout: no-op when repoUrl is null (dev / v1 stamp)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-fork-'))
  const activeRoot = path.join(tmp, 'active')
  const r = await ensureForkCheckout({ activeRoot, repoUrl: null, emit: () => {} })
  assert.strictEqual(r.seeded, false)
  assert.strictEqual(r.reason, 'no-repo-url')
  assert.strictEqual(fs.existsSync(activeRoot), false, 'must not create anything')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('ensureForkCheckout: no-op when a repo is already present', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-fork-'))
  const activeRoot = path.join(tmp, 'active')
  fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
  const logs = []
  const r = await ensureForkCheckout({
    activeRoot,
    repoUrl: 'https://github.com/TA-Mark/hermes-agent.git',
    branch: 'CustomDesktop',
    emit: ev => logs.push(ev),
  })
  assert.strictEqual(r.seeded, false)
  assert.strictEqual(r.reason, 'already-present')
  assert.ok(logs.some(e => /already present/.test(e.line)), 'should log the skip')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('downloadInstallScript retries a transient 429 then succeeds', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-lite-retry-'))
  const dest = path.join(tmp, 'install-script')
  const slept = []
  let calls = 0
  const attempt = () => {
    calls += 1
    if (calls < 3) {
      const err = new Error(`Failed to download: HTTP 429`)
      err.statusCode = 429
      err.transient = true
      return Promise.reject(err)
    }
    fs.writeFileSync(dest, '# ok')
    return Promise.resolve(dest)
  }

  const retries = []
  const out = await downloadInstallScript('deadbeef', dest, {
    _attempt: attempt,
    _sleep: ms => {
      slept.push(ms)
      return Promise.resolve()
    },
    onRetry: info => retries.push(info),
  })

  assert.strictEqual(out, dest)
  assert.strictEqual(calls, 3, 'should attempt three times (two 429s + success)')
  assert.strictEqual(slept.length, 2, 'should back off twice')
  assert.ok(slept[1] > slept[0], 'backoff should grow')
  assert.strictEqual(retries.length, 2, 'onRetry fires once per retry')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('downloadInstallScript honors Retry-After over exponential backoff', async () => {
  const dest = path.join(os.tmpdir(), 'nope-retry-after')
  const slept = []
  let calls = 0
  const attempt = () => {
    calls += 1
    if (calls === 1) {
      const err = new Error('HTTP 429')
      err.statusCode = 429
      err.transient = true
      err.retryAfterMs = 2500
      return Promise.reject(err)
    }
    return Promise.resolve(dest)
  }
  await downloadInstallScript('deadbeef', dest, {
    _attempt: attempt,
    _sleep: ms => {
      slept.push(ms)
      return Promise.resolve()
    },
  })
  assert.strictEqual(slept[0], 2500, 'should sleep for the Retry-After hint')
})

test('downloadInstallScript does NOT retry a non-transient 404', async () => {
  const dest = path.join(os.tmpdir(), 'nope-404')
  let calls = 0
  const attempt = () => {
    calls += 1
    const err = new Error('HTTP 404')
    err.statusCode = 404
    err.transient = false
    return Promise.reject(err)
  }
  await assert.rejects(
    () => downloadInstallScript('deadbeef', dest, { _attempt: attempt, _sleep: () => Promise.resolve() }),
    /404/
  )
  assert.strictEqual(calls, 1, 'a 404 should fail fast with no retry')
})

test('downloadInstallScript gives up after maxAttempts transient failures', async () => {
  const dest = path.join(os.tmpdir(), 'nope-exhaust')
  let calls = 0
  const attempt = () => {
    calls += 1
    const err = new Error('HTTP 503')
    err.statusCode = 503
    err.transient = true
    return Promise.reject(err)
  }
  await assert.rejects(
    () =>
      downloadInstallScript('deadbeef', dest, {
        _attempt: attempt,
        _sleep: () => Promise.resolve(),
        maxAttempts: 3,
      }),
    /503/
  )
  assert.strictEqual(calls, 3, 'should stop at maxAttempts')
})
