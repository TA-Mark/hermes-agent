// Git review pane — CUSTOM (non-upstream), new file only.
//
// The Codex-style review UI the Electron desktop app has, ported to the web
// dashboard. Backend already existed (/api/git/*); this is the missing UI. See
// apps/desktop-lite/CUSTOM_ROADMAP.md, Phase 2.
//
// NOTE: git operations run on the machine hosting the backend, against the
// resolved repo path — for a remote gateway that's the remote host's tree.

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, RefreshCw, Upload, GitPullRequest } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";
import {
  gitReviewApi,
  type GitScope,
  type RepoStatus,
  type ReviewFile,
} from "@/lib/gitReviewApi";

const SCOPES: { value: GitScope; label: string }[] = [
  { value: "uncommitted", label: "Uncommitted" },
  { value: "branch", label: "This branch" },
];

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="p-4 text-xs text-text-tertiary">Không có thay đổi để hiển thị.</div>;
  }
  return (
    <pre className="overflow-auto p-3 text-xs leading-relaxed font-mono">
      {diff.split("\n").map((line, i) => {
        let cls = "text-foreground";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-success";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-destructive";
        else if (line.startsWith("@@")) cls = "text-text-tertiary";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export default function GitReviewPage() {
  const [repoPath, setRepoPath] = useState<string>("");
  const [scope, setScope] = useState<GitScope>("uncommitted");
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [commitMsg, setCommitMsg] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notRepo, setNotRepo] = useState(false);

  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Git Review");
    return () => setTitle(null);
  }, [setTitle]);

  const refresh = useCallback(
    async (path: string, sc: GitScope) => {
      if (!path) return;
      setLoading(true);
      setError(null);
      try {
        const [st, list] = await Promise.all([
          gitReviewApi.status(path),
          gitReviewApi.reviewList(path, sc),
        ]);
        setNotRepo(st === null);
        setStatus(st);
        setFiles(list.files);
        if (list.files.length && !list.files.some((f) => f.path === selected)) {
          setSelected(list.files[0].path);
        } else if (!list.files.length) {
          setSelected(null);
          setDiff("");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [selected],
  );

  // Resolve the default repo path from the backend once on mount.
  useEffect(() => {
    gitReviewApi
      .defaultCwd()
      .then((d) => setRepoPath(d.cwd))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    // Dashboard data pages fetch from effects; mirror FilesPage's accepted
    // pattern until the shared lint profile covers async page loaders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (repoPath) void refresh(repoPath, scope);
  }, [repoPath, scope, refresh]);

  useEffect(() => {
    if (!repoPath || !selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiff("");
      return;
    }
    const file = files.find((f) => f.path === selected);
    gitReviewApi
      .reviewDiff(repoPath, selected, scope, file?.staged ?? false)
      .then((r) => setDiff(r.diff))
      .catch(() => setDiff(""));
  }, [repoPath, selected, scope, files]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh(repoPath, scope);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [repoPath, scope, refresh],
  );

  const dirty = useMemo(() => files.length > 0, [files]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <GitReviewBody
        repoPath={repoPath}
        scope={scope}
        setScope={setScope}
        status={status}
        files={files}
        selected={selected}
        setSelected={setSelected}
        diff={diff}
        commitMsg={commitMsg}
        setCommitMsg={setCommitMsg}
        loading={loading}
        busy={busy}
        error={error}
        notRepo={notRepo}
        dirty={dirty}
        onRefresh={() => refresh(repoPath, scope)}
        run={run}
      />
    </div>
  );
}

interface BodyProps {
  repoPath: string;
  scope: GitScope;
  setScope: (s: GitScope) => void;
  status: RepoStatus | null;
  files: ReviewFile[];
  selected: string | null;
  setSelected: (p: string) => void;
  diff: string;
  commitMsg: string;
  setCommitMsg: (m: string) => void;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notRepo: boolean;
  dirty: boolean;
  onRefresh: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

function GitReviewBody(p: BodyProps) {
  const {
    repoPath, scope, setScope, status, files, selected, setSelected, diff,
    commitMsg, setCommitMsg, loading, busy, error, notRepo, dirty, onRefresh, run,
  } = p;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<GitScope> value={scope} onChange={setScope} options={SCOPES} />
        <Button ghost size="sm" prefix={<RefreshCw />} onClick={onRefresh} disabled={loading || busy}>
          Làm mới
        </Button>
        {status?.branch && (
          <span className="text-xs text-text-secondary">
            <GitBranch className="mr-1 inline size-3" />
            {status.branch}
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        {loading && <Spinner className="size-4" />}
      </div>

      <p className="text-xs text-text-tertiary">
        Thao tác git chạy trên máy backend, repo: <code>{repoPath || "…"}</code>
      </p>

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
      )}
      {notRepo && (
        <div className="rounded-md bg-warning/10 p-2 text-xs text-warning">
          Thư mục này không phải git repo.
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <CardTitle>Thay đổi ({files.length})</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto p-0">
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelected(f.path)}
                className={`flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-card ${
                  selected === f.path ? "bg-card" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-center text-text-tertiary">{f.status}</span>
                  <span className="truncate">{f.path}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className="text-success">+{f.added}</span>{" "}
                  <span className="text-destructive">−{f.removed}</span>
                </span>
              </button>
            ))}
            {!files.length && !loading && (
              <div className="p-4 text-xs text-text-tertiary">Không có thay đổi.</div>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="truncate">{selected || "Diff"}</CardTitle>
            {selected && scope === "uncommitted" && (
              <div className="flex gap-1">
                <Button
                  ghost
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => gitReviewApi.stage(repoPath, selected))}
                >
                  Stage
                </Button>
                <Button
                  ghost
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => gitReviewApi.unstage(repoPath, selected))}
                >
                  Unstage
                </Button>
                <Button
                  ghost
                  destructive
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Hoàn tác thay đổi ở ${selected}? Không thể khôi phục.`))
                      run(() => gitReviewApi.revert(repoPath, selected));
                  }}
                >
                  Revert
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto p-0">
            <DiffView diff={diff} />
          </CardContent>
        </Card>
      </div>

      {scope === "uncommitted" && (
        <div className="flex flex-col gap-2">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message…"
            rows={2}
            className="w-full rounded-md border border-border bg-card p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button
              disabled={busy || !dirty || !commitMsg.trim()}
              onClick={() =>
                run(async () => {
                  await gitReviewApi.commit(repoPath, commitMsg.trim(), false);
                  setCommitMsg("");
                })
              }
            >
              Commit
            </Button>
            <Button
              outlined
              prefix={<Upload />}
              disabled={busy || !dirty || !commitMsg.trim()}
              onClick={() =>
                run(async () => {
                  await gitReviewApi.commit(repoPath, commitMsg.trim(), true);
                  setCommitMsg("");
                })
              }
            >
              Commit &amp; Push
            </Button>
            <Button
              ghost
              prefix={<GitPullRequest />}
              disabled={busy}
              onClick={() => run(() => gitReviewApi.createPr(repoPath))}
            >
              Tạo PR
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
