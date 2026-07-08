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

const { runBootstrap, parseStageResult, resolveInstallScript, ensureForkCheckout } =
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
