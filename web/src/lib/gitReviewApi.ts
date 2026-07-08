// Git review API client — CUSTOM (non-upstream), new file only.
//
// Thin typed wrappers over the git endpoints ALREADY provided by the backend
// (hermes_cli/web_git.py, routes at web_server.py:2146+, prefix /api/git). The
// backend was complete; only a web UI was missing. See
// apps/desktop-lite/CUSTOM_ROADMAP.md, Phase 2.
//
// Every op takes a repo `path` the backend hardens via _fs_path (confined to
// the managed files root). Resolve a default via GET /api/fs/default-cwd.

import { fetchJSON } from "@/lib/api";

export type GitScope = "uncommitted" | "branch" | "lastTurn";

export interface RepoStatusFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface RepoStatus {
  branch: string | null;
  defaultBranch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changed: number;
  added: number;
  removed: number;
  files: RepoStatusFile[];
}

export interface ReviewFile {
  path: string;
  added: number;
  removed: number;
  status: string;
  staged: boolean;
}

export interface ReviewList {
  files: ReviewFile[];
  base: string | null;
}

export interface ShipInfo {
  ghReady: boolean;
  pr: { url: string; state?: string; number?: number } | null;
}

export interface DefaultCwd {
  cwd: string;
  branch: string;
}

const q = (params: Record<string, string | boolean | undefined>): string => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
};

export const gitReviewApi = {
  defaultCwd: () => fetchJSON<DefaultCwd>("/api/fs/default-cwd"),

  status: (path: string) =>
    fetchJSON<RepoStatus | null>(`/api/git/status${q({ path })}`),

  reviewList: (path: string, scope: GitScope = "uncommitted", base?: string) =>
    fetchJSON<ReviewList>(`/api/git/review/list${q({ path, scope, base })}`),

  reviewDiff: (
    path: string,
    file: string,
    scope: GitScope = "uncommitted",
    staged = false,
    base?: string,
  ) =>
    fetchJSON<{ diff: string }>(
      `/api/git/review/diff${q({ path, file, scope, staged, base })}`,
    ),

  shipInfo: (path: string) =>
    fetchJSON<ShipInfo>(`/api/git/review/ship-info${q({ path })}`),

  stage: (path: string, file?: string) =>
    fetchJSON<{ ok: boolean }>("/api/git/review/stage", {
      method: "POST",
      body: JSON.stringify({ path, file }),
      headers: { "Content-Type": "application/json" },
    }),

  unstage: (path: string, file?: string) =>
    fetchJSON<{ ok: boolean }>("/api/git/review/unstage", {
      method: "POST",
      body: JSON.stringify({ path, file }),
      headers: { "Content-Type": "application/json" },
    }),

  revert: (path: string, file?: string) =>
    fetchJSON<{ ok: boolean }>("/api/git/review/revert", {
      method: "POST",
      body: JSON.stringify({ path, file }),
      headers: { "Content-Type": "application/json" },
    }),

  commit: (path: string, message: string, push = false) =>
    fetchJSON<{ ok: boolean }>("/api/git/review/commit", {
      method: "POST",
      body: JSON.stringify({ path, message, push }),
      headers: { "Content-Type": "application/json" },
    }),

  push: (path: string) =>
    fetchJSON<{ ok: boolean }>("/api/git/review/push", {
      method: "POST",
      body: JSON.stringify({ path }),
      headers: { "Content-Type": "application/json" },
    }),

  createPr: (path: string) =>
    fetchJSON<{ url: string }>("/api/git/review/create-pr", {
      method: "POST",
      body: JSON.stringify({ path }),
      headers: { "Content-Type": "application/json" },
    }),
};
