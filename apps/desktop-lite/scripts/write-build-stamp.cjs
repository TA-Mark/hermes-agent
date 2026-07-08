"use strict"

/**
 * Writes apps/desktop-lite/build/install-stamp.json with the git ref the
 * Hermes-Lite .exe should pin to at first-launch bootstrap time. This file
 * ships inside the packaged app via electron-builder's extraResources entry
 * and is read by electron/hermes-paths.cjs (loadInstallStamp) to drive the
 * install.ps1 stage bootstrap flow in bootstrap-runner.cjs.
 *
 * Schema (subject to bump via STAMP_SCHEMA_VERSION):
 *   {
 *     "schemaVersion": 2,
 *     "commit":        "<40-char SHA>",
 *     "branch":        "<branch name>",
 *     "builtAt":       "<ISO 8601 UTC timestamp>",
 *     "dirty":         true|false,
 *     "source":        "ci" | "local",
 *     "repoUrl":       "<git remote origin URL, e.g. the fork>" | null,
 *     "repoOwner":     "<GitHub owner parsed from repoUrl>" | null,
 *     "repoName":      "<GitHub repo parsed from repoUrl>" | null
 *   }
 *
 * repoUrl/Owner/Name (v2+) tell the first-launch bootstrap which repository to
 * clone and which GitHub raw host to fetch install.ps1 from. When building from
 * a fork checkout these point at the fork, so the packaged app installs the
 * fork's code (including custom web/ pages) rather than upstream.
 *
 * Source preference order:
 *   1. CI env vars ($GITHUB_SHA / $GITHUB_REF_NAME) -- avoid edge cases with
 *      shallow clones, detached HEADs, etc. in CI.
 *   2. Local `git rev-parse` against the parent repo (../..).
 *
 * Dev / out-of-repo builds without git produce an explicit error rather than
 * silently writing an unstamped manifest -- the packaged app refuses to
 * bootstrap without a stamp.
 */

const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

// v2 adds repoUrl/repoOwner/repoName so bootstrap clones the FORK the .exe was
// built from (not NousResearch upstream) — that's how the custom web/ pages
// reach a clean machine. v1 stamps (no repo fields) still load and fall back to
// upstream, see hermes-paths.cjs loadInstallStamp.
const STAMP_SCHEMA_VERSION = 2

// Parse "owner/repo" out of a GitHub remote URL (ssh or https, .git optional).
function parseGitHubOwnerRepo(url) {
  if (!url) return { owner: null, repo: null }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i)
  if (!m) return { owner: null, repo: null }
  return { owner: m[1], repo: m[2] }
}

const DESKTOP_LITE_ROOT = path.resolve(__dirname, "..")
const REPO_ROOT = path.resolve(DESKTOP_LITE_ROOT, "..", "..")
const OUT_DIR = path.join(DESKTOP_LITE_ROOT, "build")
const OUT_FILE = path.join(OUT_DIR, "install-stamp.json")

function tryExec(cmd, opts) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim()
  } catch {
    return null
  }
}

function fromCI() {
  const sha = process.env.GITHUB_SHA
  if (!sha) return null
  const branch = process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || null
  // GITHUB_REPOSITORY is "owner/repo"; GITHUB_SERVER_URL is "https://github.com".
  let repoUrl = null
  if (process.env.GITHUB_REPOSITORY) {
    const server = process.env.GITHUB_SERVER_URL || "https://github.com"
    repoUrl = `${server.replace(/\/$/, "")}/${process.env.GITHUB_REPOSITORY}.git`
  }
  return {
    commit: sha,
    branch: branch,
    dirty: false, // CI builds from a checkout-of-ref by definition
    source: "ci",
    repoUrl: repoUrl
  }
}

function fromLocalGit() {
  const sha = tryExec("git rev-parse HEAD", { cwd: REPO_ROOT })
  if (!sha) return null
  const branch = tryExec("git rev-parse --abbrev-ref HEAD", { cwd: REPO_ROOT })
  // `git status --porcelain -uno` is empty iff tracked files match HEAD.
  // We exclude untracked files (-uno) intentionally: a developer who's
  // checked out an installer scratch dir alongside the repo shouldn't
  // poison every local build with a [DIRTY] stamp. We DO care about
  // tracked-but-modified files because those mean the .exe content
  // differs from the commit being pinned.
  const status = tryExec("git status --porcelain -uno", { cwd: REPO_ROOT })
  const dirty = status !== null && status.length > 0
  // The remote the bootstrap should clone/fetch from — this is the fork when
  // building from a fork checkout. Null if there's no origin (bootstrap then
  // falls back to upstream).
  const repoUrl = tryExec("git remote get-url origin", { cwd: REPO_ROOT })
  return {
    commit: sha,
    branch: branch === "HEAD" ? null : branch, // detached HEAD -> null
    dirty: dirty,
    source: "local",
    repoUrl: repoUrl || null
  }
}

function main() {
  const stamp = fromCI() || fromLocalGit()
  if (!stamp || !stamp.commit) {
    console.error(
      "[write-build-stamp] ERROR: could not determine git commit.\n" +
        "  - $GITHUB_SHA not set\n" +
        "  - `git rev-parse HEAD` failed at " +
        REPO_ROOT +
        "\n" +
        "Packaged builds require a git ref to pin first-launch install.ps1\n" +
        "against. Run from a git checkout or set $GITHUB_SHA explicitly."
    )
    process.exit(1)
  }

  if (stamp.dirty) {
    console.warn(
      "[write-build-stamp] WARNING: working tree is dirty.\n" +
        "  Pinning to " +
        stamp.commit.slice(0, 12) +
        " but the packaged code may differ from that commit.\n" +
        "  Commit your changes before publishing this build."
    )
  }

  const { owner, repo } = parseGitHubOwnerRepo(stamp.repoUrl)
  const payload = {
    schemaVersion: STAMP_SCHEMA_VERSION,
    commit: stamp.commit,
    branch: stamp.branch,
    builtAt: new Date().toISOString(),
    dirty: stamp.dirty,
    source: stamp.source,
    repoUrl: stamp.repoUrl || null,
    repoOwner: owner,
    repoName: repo
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8")
  console.log(
    "[write-build-stamp] wrote " +
      path.relative(REPO_ROOT, OUT_FILE) +
      " -> " +
      stamp.commit.slice(0, 12) +
      (stamp.branch ? " (" + stamp.branch + ")" : "") +
      (owner && repo ? " @ " + owner + "/" + repo : " @ <no-origin: upstream fallback>") +
      (stamp.dirty ? " [DIRTY]" : "")
  )
}

main()
