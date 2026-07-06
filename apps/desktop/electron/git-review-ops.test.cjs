'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { gitFor, resolveRenamePath } = require('./git-review-ops.cjs')

test('resolveRenamePath: plain path is unchanged', () => {
  assert.equal(resolveRenamePath('src/a.ts'), 'src/a.ts')
})

test('resolveRenamePath: simple rename resolves to the new path', () => {
  assert.equal(resolveRenamePath('old.ts => new.ts'), 'new.ts')
})

test('resolveRenamePath: brace rename resolves to the new path', () => {
  assert.equal(resolveRenamePath('src/{old => new}/file.ts'), 'src/new/file.ts')
})

test('resolveRenamePath: brace rename collapsing a segment', () => {
  assert.equal(resolveRenamePath('src/{lib => }/file.ts'), 'src/file.ts')
})

// Regression: simple-git v3's custom-binary guard rejects a `binary` path with
// spaces (or other shell-meta chars) unless `unsafe.allowUnsafeCustomBinary` is
// set. On Windows git installs to `C:\Program Files\Git\cmd\git.exe`, so without
// the opt-out gitFor() THREW at construction and every review op was swallowed
// into an empty result ("NO DIFFS"). gitFor must construct without throwing.
test('gitFor: constructs with a spaced (Windows Program Files) binary path', () => {
  assert.doesNotThrow(() => gitFor(process.cwd(), 'C:\\Program Files\\Git\\cmd\\git.exe'))
})

test('gitFor: constructs with the default bare git binary', () => {
  assert.doesNotThrow(() => gitFor(process.cwd()))
})
