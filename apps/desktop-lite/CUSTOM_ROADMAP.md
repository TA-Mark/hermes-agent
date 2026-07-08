# Hermes Desktop-Lite — Roadmap triển khai (update-safe)

> File custom (KHÔNG thuộc upstream NousResearch). Đặt trong workspace mới
> `apps/desktop-lite/` — toàn bộ code shell là **file mới**, không sửa
> `apps/desktop/`. Xem chiến lược update-safe tổng ở `apps/desktop/CUSTOM_FEATURES.md`.

## Mục tiêu

Thay app Electron nặng (`apps/desktop`, ~140k dòng renderer + ~17k dòng main
process, upstream churn ~9 commit/ngày) bằng **shell Electron mỏng** load thẳng
web dashboard (`web/`) đang chạy từ backend Python cục bộ. Vẫn là **app desktop
thật** (icon riêng, cửa sổ riêng), nhưng UI là `web/` — nên mọi cải tiến upstream
đổ vào `web/` (~232 commit/90 ngày) tự chảy vào app mà không phải port tay.

## Quyết định kiến trúc CỐT LÕI (đã xác minh trực tiếp trên code)

Shell **KHÔNG** bundle `web/dist` rồi load qua `file://`. Phải
`loadURL('http://127.0.0.1:<port>/')` trỏ vào chính backend đang chạy. Bằng chứng:

- CORS chỉ khớp `^https?://(localhost|127\.0\.0\.1)(:\d+)?$`
  (`hermes_cli/web_server.py:291`) → origin `file://` bị chặn cho MỌI REST call.
- Token session chỉ tiêm `window.__HERMES_SESSION_TOKEN__` vào `index.html` khi
  serve tươi qua HTTP, `Cache-Control: no-store` (`web_server.py:13970`) → file
  tĩnh không có token → auth loopback hỏng hoàn toàn.
- WS được cho qua non-http origin (`_ws_host_origin_reason` bỏ qua `file://`),
  nhưng REST thì không → chỉ chat WS sống, mọi trang khác vỡ.
- Kết luận: load vào HTTP thì trang được xem như browser tab thật → auth + CORS
  chạy y nguyên, **không cần sửa gì trong `web/` hay `web_server.py`**.

## Sự thật đã xác minh (Phase 0 done)

| Hạng mục | Sự thật | Nguồn |
|---|---|---|
| Lệnh backend | `hermes serve --host 127.0.0.1 --port 0` (headless; có `--skip-build`, `--no-open`) | `hermes_cli/subcommands/dashboard.py:135-151`, `:25-49` |
| Announce port | `print("HERMES_DASHBOARD_READY port=<N>", flush=True)` ra stdout | `web_server.py:15342` |
| Regex parse port | `/^HERMES_DASHBOARD_READY port=(\d+)/m` | `apps/desktop/electron/backend-ready.cjs:3` |
| CORS | `^https?://(localhost\|127\.0\.0\.1)(:\d+)?$` | `web_server.py:291` |
| Token inject | `window.__HERMES_SESSION_TOKEN__` vào index.html | `web_server.py:13970` |
| WEB_DIST | `hermes_cli/web_dist` hoặc `$HERMES_WEB_DIST` | `web_server.py:121` |
| web build state | **CHƯA build** — `hermes_cli/web_dist` không tồn tại | kiểm tra fs |
| hermes binary | **Không trên PATH** — ở `.venv/Scripts/hermes.exe` | kiểm tra fs |
| Contract version | `DESKTOP_BACKEND_CONTRACT` = soft warn, không hard-fail | `tui_gateway/server.py` |

Hệ quả cho shell:
1. Phải build web trước (`cd web && npm run build` → `hermes_cli/web_dist/`), hoặc
   backend tự build nếu không truyền `--skip-build`.
2. Shell cần chiến lược dò `hermes` binary (venv Scripts → PATH → python -m).

## PHASE 0 — Chuẩn bị & xác nhận giả định ✅ DONE

- [x] Xác nhận lệnh backend, chuỗi announce port, CORS, token inject, WEB_DIST.
- [x] Phát hiện web chưa build + hermes không trên PATH.
- [ ] (thủ công, nên làm trước Phase 1) Mở browser tab thường trỏ
  `http://127.0.0.1:<port>/` sau khi chạy `hermes serve` — xác nhận toàn bộ trang
  (Chat/Sessions/Files/Config/MCP...) chạy, token đúng, WS terminal chạy. Đây là
  baseline "browser tab thật" để so khi chuyển vào Electron webview.

## PHASE 1 — Shell tối thiểu chạy được ✅ DONE (đã verify end-to-end)

Đã tạo & kiểm chứng bằng thực thi thật (không chỉ đọc code):
- `apps/desktop-lite/package.json`, `electron/{main,backend-lifecycle,preload}.cjs`.
- Test backend E2E: spawn `hermes serve --skip-build` → parse `port=54455` →
  HTTP 200, `__HERMES_SESSION_TOKEN__` được tiêm, root div có mặt → `killBackend`
  dọn sạch. **Chứng minh giả thuyết loadURL-vào-HTTP đúng.**
- Smoke-test Electron: `main.cjs` boot không crash, backend announce port, không
  để lại tiến trình orphan sau quit.

Cách chạy (electron chưa cài trong workspace lite; dùng bản đã có ở apps/desktop):
```bash
cd apps/desktop-lite
../desktop/node_modules/.bin/electron.cmd .        # hoặc electron trên máy
# verbose: HERMES_LITE_DEBUG=1 ../desktop/node_modules/.bin/electron.cmd .
```
web PHẢI đã build (`cd web && npm run build` → `hermes_cli/web_dist/`). Nếu chưa,
shell vẫn chạy nhưng bỏ `--skip-build` để backend tự build (lần đầu chậm).

TODO nhỏ còn lại của Phase 1 (không chặn): thêm `electron` vào devDeps của
`apps/desktop-lite` + `npm install` để `npm start` chạy độc lập, thay vì mượn
binary của apps/desktop.

### Thiết kế gốc (giữ để tham chiếu)

Workspace mới `apps/desktop-lite/` (monorepo tự pick up qua `workspaces: ["apps/*"]`).
KHÔNG import từ `apps/desktop/electron/*` — chỉ tham khảo logic để viết bản gọn.

Files tạo mới:
- `apps/desktop-lite/package.json` — tên `hermes-lite`, `main: electron/main.cjs`,
  deps chỉ `electron` + `electron-builder`. KHÔNG kéo `node-pty`/`simple-git`/UI libs.
- `apps/desktop-lite/electron/backend-lifecycle.cjs` — viết mới, tham khảo (không
  import) `apps/desktop/electron/backend-{command,ready,env,probes}.cjs`:
  - `resolveHermesCommand()` — dò binary: `$HERMES_HOME`/venv `Scripts|bin/hermes` →
    PATH `hermes` → `python -m hermes_cli.main`. Trên máy này: `.venv/Scripts/hermes.exe`.
  - `spawnBackend()` — spawn `hermes serve --host 127.0.0.1 --port 0`
    (thêm `--skip-build` NẾU web_dist đã có, tránh chờ npm mỗi lần mở).
  - `waitForReady(child, timeoutMs)` — đọc stdout, regex
    `/^HERMES_DASHBOARD_READY port=(\d+)/m`, tolerant chunk-split, timeout ~90s
    (cold start). Reject nếu child exit sớm.
  - `killBackend()` — gọi khi quit; trên Windows dùng `taskkill /pid /t /f` để kill
    cả cây con, `windowsHide: true`.
- `apps/desktop-lite/electron/main.cjs` — `app.whenReady()` → `spawnBackend()` →
  `waitForReady()` → tạo `BrowserWindow` → `win.loadURL('http://127.0.0.1:'+port+'/')`.
  Handle `window-all-closed` + `before-quit` → `killBackend()`. Màn chờ (loading
  html tĩnh nhỏ) trong lúc backend cold-start.
- `apps/desktop-lite/electron/preload.cjs` — để trống ở v1 (mọi thứ qua HTTP/WS chuẩn).

Rủi ro: nếu `hermes` không dò được / web chưa build → hiện lỗi thân thiện, không crash.

## PHASE 2 — Git review pane trên web/ ✅ DONE (đã verify end-to-end)

**PHÁT HIỆN QUAN TRỌNG (khác giả định ban đầu):** Backend git API **ĐÃ TỒN TẠI
SẴN trong upstream** — `hermes_cli/web_git.py` + 18 route `/api/git/*` mount trực
tiếp trong `web_server.py:2146-2235`, kèm test `tests/hermes_cli/test_web_server_git.py`.
Audit subagent nói "git ABSENT trong web/" chỉ đúng cho phần **UI page**, KHÔNG
đúng cho backend. → Router `dashboard_git.py` tôi viết ban đầu là THỪA, đã revert
sạch (0 thay đổi backend). Bài học: verify backend trực tiếp trước khi code, không
tin audit của subagent về sự vắng mặt của một thứ.

Hệ quả tốt: Phase 2 chỉ còn **frontend**, và điểm chạm upstream giảm từ 2 chỗ
(web_server.py + App.tsx) xuống **CHỈ 1 chỗ** (App.tsx).

Backend upstream sẵn có (KHÔNG đụng): `GET /api/git/status`, `/review/list`,
`/review/diff`, `/file-diff`, `/review/commit-context`, `/review/rev-parse`,
`/review/ship-info`, `/branches`, `POST /review/{stage,unstage,revert,commit,push,create-pr}`,
worktree add/remove, branch/switch. Path confine qua `_fs_path`, lỗi mutation → 400
qua `_git_op`, auth qua middleware sẵn có.

Frontend đã tạo (file mới, lint sạch):
- `web/src/lib/gitReviewApi.ts` — client theo pattern `web/src/lib/api.ts` (fetchJSON).
- `web/src/pages/GitReviewPage.tsx` — trang review: scope (uncommitted/branch),
  danh sách file + counts, diff viewer màu, stage/unstage/revert (có confirm),
  commit / commit&push / tạo PR. Cảnh báo "git chạy trên máy backend". Repo path
  lấy từ `/api/fs/default-cwd`.

Điểm chạm upstream DUY NHẤT — `web/src/App.tsx` (4 dòng): import `GitBranch`,
import `GitReviewPage`, `"/git": GitReviewPage` trong `BUILTIN_ROUTES_CORE`,
nav item `{ path: "/git", label: "Git", icon: GitBranch }`.

Verify E2E (chạy thật trên repo này): status 200 (branch=CustomDesktop, changed=7),
review/list 200 (counts đúng), diff/branches/ship-info 200, no-token → 401. Typecheck
+ lint 2 file mới sạch; web build bundle GitReviewPage OK.

Lỗi lint tồn đọng `App.tsx:917` (`setUpdateConfirmInfo`) là nợ CÓ SẴN của upstream
(dòng 913 trên HEAD), không phải do 4 dòng tôi thêm.

Rủi ro (đã xử lý trong UI): git ops chạy trên máy chạy backend. Remote gateway →
chạy trên máy remote. UI đã cảnh báo rõ.

## PHASE 2.5 — Hệ thống kết nối LLM/Provider (P0) ✅ ĐỔI HƯỚNG: hợp nhất vào Keys tab

> **CẬP NHẬT (đổi hướng sau khi review overlap):** Trang `/providers` custom đã bị GỠ.
> Lý do: ~70% trùng Keys tab (`/env` = `EnvPage.tsx` upstream) — OAuth login đã có sẵn qua
> `OAuthProvidersCard`, nhập/xóa key thô đã có qua provider group, cả hai gọi CÙNG endpoint
> backend. Giá trị riêng còn lại (test key sống + custom OpenAI-compatible endpoint) được hợp
> nhất vào ĐÁY Keys tab qua **PluginSlot `env:bottom`** — KHÔNG sửa `EnvPage.tsx`.
>
> **Đã làm (update-safe, điểm chạm upstream ròng = 1 dòng):**
> - Tạo `web/src/plugins-fork/env-provider-tools.tsx` (fork-owned) — 2 card: (1) Test & lưu API
>   key cho 4 provider probe được (OpenRouter/OpenAI/xAI/Gemini); (2) Custom OpenAI-compatible
>   endpoint (probe `/v1/models` → auto-pick model[0] → `setModelWithKey`). Cuối file gọi
>   `registerSlot("fork-env-provider-tools", "env:bottom", EnvProviderTools)`.
> - `web/src/main.tsx` — thêm 1 dòng `import "./plugins-fork/env-provider-tools";` sau
>   `exposePluginSDK()`. **Đây là điểm chạm upstream DUY NHẤT** còn lại.
> - `web/src/App.tsx` — GỠ 3 dòng wiring `/providers` (import + route + nav). Giữ import `Plug`
>   (còn dùng cho `/mcp`). Net: App.tsx trở về gần upstream hơn.
> - XÓA: `ProvidersPage.tsx`, `ProvidersPage.dialog.tsx`, `useProviderConnect.ts`. GIỮ
>   `providerApi.ts` (fork-owned) — panel mới import `validateProviderCredential` + `setModelWithKey`.
> - i18n: hardcode tiếng Việt (thêm key required vào `types.ts` sẽ buộc sửa cả 16 locale → build fail).
> - `registerSlot` signature THẬT là `(plugin, slot, component)` (slots.ts:125), KHÁC sdk.d.ts.
> - Verify: typecheck ✅ + build ✅ + file mới lint sạch ✅ (33 lỗi lint còn lại là nợ upstream ở
>   `PluginPage.tsx`/`themes/context.tsx`, không phải do thay đổi này).
>
> Phần bên dưới GIỮ để tham chiếu bối cảnh điều tra ban đầu (trước khi đổi hướng).

**Vấn đề phát hiện khi chạy thử:** web/ ModelPickerDialog chỉ LIỆT KÊ + chọn model
của provider đã auth; KHÔNG có cách nhập api_key / base_url / bắt đầu OAuth cho
provider chưa kết nối. Key custom cũ hết hạn → 401, không đổi được qua UI.

**Đã xác minh (đọc apps/desktop/src + backend, trust-but-verify):**
- Desktop app KHÔNG dùng JSON-RPC cho provider/auth — tất cả đi qua REST y hệt
  backend web/ (`window.hermesDesktop.api` chỉ forward REST). → web/ đạt parity
  bằng THUẦN FRONTEND, không cần backend mới.
- Backend REST đã đủ cho MỌI auth type: `/api/providers/oauth/{start,submit,poll,
  DELETE}`, `/api/env` (set/del/reveal), `/api/providers/validate`,
  `/api/model/set` (nhận base_url + api_key), `/api/model/options`,
  `/api/model/recommended-default`.
- 4 auth type: (1) device_code OAuth [nous, openai-codex, minimax-oauth, xai-oauth],
  (2) pkce OAuth [anthropic], (3) external/CLI-delegated [qwen-oauth, copilot,
  claude-code], (4) API-key paste [openrouter, openai, gemini, xai...] + sub-type
  custom/local OpenAI-compatible endpoint (base_url + key + model).

**web/ ĐÃ CÓ sẵn (build ngay):** OAuth wrappers đầy đủ trong `lib/api.ts:753-805`
(getOAuthProviders/start/submit/poll/cancel/disconnect), env wrappers set/del/reveal.

**web/ CÒN THIẾU (nhỏ, xác minh trực tiếp):**
1. `ModelAssignmentRequest` (`lib/api.ts:2150`) THIẾU field `api_key` — backend
   `ModelAssignment` đã nhận (`web_server.py:942`). (Subagent nói đã có — SAI, tôi
   đã verify tận mắt: chỉ có base_url, không có api_key.)
2. Wrapper `POST /api/providers/validate` (probe custom endpoint, discover models).
3. Wrapper `GET /api/model/recommended-default` (optional polish; fallback models[0]).
4. UI kết nối — phần lớn nhất, hiện không tồn tại trong web/.

**Kế hoạch (thuần frontend + điểm chạm nhỏ):**
- `web/src/lib/api.ts`: thêm `api_key` vào `ModelAssignmentRequest`; thêm 2 wrapper
  `validateProviderCredential` + `getRecommendedDefault`. (Sửa file upstream, tối
  thiểu — cân nhắc đặt wrapper ở file riêng nếu muốn 0 chạm.)
- `web/src/pages/ProvidersPage.tsx` (file mới) hoặc `ConnectProviderDialog.tsx`:
  UI kết nối theo 4 auth type, port state machine từ `apps/desktop/src/store/
  onboarding.ts` (startProviderOAuth→pollSession, submitCode, saveLocalEndpoint).
- Điểm chạm App.tsx: 1 route + 1 nav item (như GitReviewPage).
- Chưa làm: chỉ mới điều tra + lên kế hoạch. Chờ duyệt.

## PHASE 3 — Gap (C) ưu tiên (P0-P1, làm dần)

Nguyên tắc: `window.hermesShell?.xxx` với fallback an toàn (ẩn/disable) khi chạy
browser thật hoặc app cũ → mỗi tính năng đúng 1 điểm chạm nhỏ trong web/.

- [P0] Reveal-in-Explorer / Trash — `preload-fs-bridge.cjs` expose
  `revealPath`/`trashPath`; nút chỉ hiện khi `window.hermesShell`.
- [P0] Dialog chọn thư mục native — `selectDirectory`.
- [P0] Mở link ngoài — `main.cjs` `setWindowOpenHandler` → `shell.openExternal`
  (xử lý hoàn toàn tầng Electron, KHÔNG cần chạm web/).
- [P1] Clipboard image / native notification polish — bỏ qua nếu Web API đủ dùng.

## PHASE 4 — Đóng gói & auto-bootstrap ✅ DONE (artifact verified; bootstrap thật chưa test trên máy sạch)

Mô hình: giống apps/desktop — installer KHÔNG bundle Python. Lần đầu chạy trên máy
sạch, app tự cài hermes (uv→python→git clone→venv) qua `scripts/install.ps1` rồi
load dashboard. Dev-from-checkout bỏ qua bootstrap (repo `.venv` sẵn có thắng).

Files (tất cả MỚI trừ 2 file sửa nhẹ):
- `electron/bootstrap-runner.cjs` — copy gần nguyên văn từ apps/desktop (pure node,
  0 coupling renderer). Chạy install.ps1/sh theo stage protocol `-Manifest`/`-Stage`
  `-NonInteractive`/`-Json`/`-Commit`/`-Branch`. Fallback resolve script:
  local checkout → cache → GitHub raw @commit → installed-agent.
- `electron/hermes-paths.cjs` — HERMES_HOME / ACTIVE_HERMES_ROOT / VENV_ROOT /
  marker / loadInstallStamp. Layout khớp install.ps1 để desktop-lite + CLI dùng chung
  một install.
- `electron/backend-lifecycle.cjs` (SỬA) — thêm ứng viên `HERMES_HOME/hermes-agent/
  venv/Scripts/hermes.exe` (kết quả bootstrap) TRƯỚC fallback repo `.venv`.
- `electron/main.cjs` (SỬA) — `boot()` gọi `resolveBackendRoot()`: marker done →
  ACTIVE_HERMES_ROOT; dev/PATH hermes → REPO_ROOT (skip bootstrap); máy sạch →
  `runBootstrap()` với loading page stream log → ACTIVE_HERMES_ROOT.
- `scripts/write-build-stamp.cjs` + `before-build.cjs` — tạo install-stamp.json
  (commit/branch pin) + skip npm collector.
- `package.json` — build block electron-builder rút gọn: `files:["electron/**",
  "!electron/**/*.test.cjs","assets/**","package.json"]`, extraResources
  install-stamp.json, win nsis / mac dmg / linux AppImage. BỎ: asarUnpack, notarize,
  after-pack, msi (không native deps, không renderer bundle).
- `electron/bootstrap-runner.test.cjs` — unit test: mock install script echo JSON
  stage frames → verify parse + marker (2/2 pass).

Đã verify:
- `node --check` mọi .cjs ✅
- Dev regression: boot chọn REPO_ROOT, skip bootstrap ✅
- `npm run build` → install-stamp.json hợp lệ (flag [DIRTY] khi working tree bẩn) ✅
- `npm run dist:win` → `release/Hermes-Lite-0.1.0-win-x64.exe` (NSIS, ~95MB) ✅
- install-stamp.json có mặt trong packaged `resources/` ✅

CHƯA test (rủi ro cao, cần máy sạch / VM):
- Bootstrap THẬT (git clone + tạo venv ở HERMES_HOME) — chỉ test resolution logic
  + parse, KHÔNG chạy thật trên máy này.
- Cài .exe lên máy sạch không có hermes.

Lưu ý phát hành:
- Chỉ build .exe phân phối từ commit ĐÃ PUSH — packaged app fetch install.ps1 từ
  GitHub raw @commit; commit chưa push → 404 → fallback installed-agent (chỉ có nếu
  máy đã từng cài). Build hiện tại stamp `d7efbdcf` branch `CustomDesktop` [DIRTY].
- Code-sign/notarize: bỏ v1 (dùng cá nhân). Cần nếu phát hành rộng.
- Self-update shell: bỏ v1 — build tay; backend/web tự cập nhật qua `hermes update`.

## PHASE 4.1 — Trỏ bootstrap về FORK ✅ DONE (logic verified; clone thật chưa test)

Vấn đề: Phase 4 bootstrap clone/tải từ **NousResearch upstream** (install.ps1 hardcode
URL, không có `-RepoUrl`). → backend chạy code upstream → dashboard trên máy sạch
**thiếu 2 trang custom** `/git` + `/providers` (chúng nằm ở `web/` của fork).

Giải pháp (hướng B): pre-seed clone **fork** `TA-Mark/hermes-agent` vào ACTIVE_HERMES_ROOT
**ngay trước** stage `repository`. Repo đã tồn tại (origin=fork) → installer đi nhánh
*update* (`git fetch origin`), KHÔNG chạm URL hardcode. **KHÔNG sửa install.ps1/sh gốc.**

Files sửa (đều của ta):
- `scripts/write-build-stamp.cjs` — đọc `git remote get-url origin` → ghi
  `repoUrl/repoOwner/repoName` vào install-stamp.json. Bump `schemaVersion` → 2.
- `electron/hermes-paths.cjs` — `loadInstallStamp` passthrough repo fields; chấp nhận
  schema `>= 1` (v1 cũ không có repo fields → null → fallback upstream, không vỡ ngược).
- `electron/bootstrap-runner.cjs`:
  - `downloadInstallScript(commit, dest, {repoOwner, repoName})` — raw URL theo fork;
    default NousResearch nếu thiếu.
  - `ensureForkCheckout()` MỚI — clone fork (`git clone --depth 1 --branch`), gitExe dò
    PortableGit (`HERMES_HOME/git/cmd/git.exe`) → PATH. ZIP fallback (codeload → Expand-
    Archive/unzip/tar → `git init` + remote origin). No-op nếu `.git` đã có hoặc repoUrl
    null. Gọi trong `runBootstrap` ngay trước runStage của stage `repository`.
- `electron/bootstrap-runner.test.cjs` — thêm 4 test (loadInstallStamp v1/v2, download URL
  owner/repo, ensureForkCheckout no-op ×2). **6/6 pass.**

Đã verify (KHÔNG clone/bootstrap thật):
- `node --check` cả 3 file ✅ · 6/6 unit test ✅
- `npm run build` → stamp v2 có `repoUrl/repoOwner/repoName=TA-Mark`, log `@ TA-Mark/hermes-agent` ✅
- download URL: fork→`TA-Mark/…`, default→`NousResearch/…` ✅
- Dev regression: `resolveInstallScript` vẫn ưu tiên local `scripts/install.ps1` (source=local),
  KHÔNG gọi download/clone khi chạy từ checkout ✅

Vòng đời update (KEY):
- **Máy sạch:** .exe (stamp trỏ fork) → clone fork → dashboard đủ tính năng.
- **Máy đã cài:** `hermes update` / chạy lại installer → `git fetch origin`=fork → luôn theo fork.
  **Không cần build lại .exe.**
- **Hút tính năng NousResearch:** `git fetch upstream && merge upstream/main → push origin` →
  (tùy) build .exe mới. Máy đã cài chỉ `hermes update`.

CHƯA test: clone fork thật + bootstrap thật (cần máy sạch/VM).

Lưu ý phát hành (BỔ SUNG):
- **PHẢI `git push` fork trước khi build .exe phân phối.** Stamp pin commit chưa push →
  clone/fetch fork fail. Hiện `d7efbdcfb` **chưa push** (origin/CustomDesktop=`c67aab763`).
- Fork PUBLIC → clone HTTPS không cần credential. Nếu chuyển private → cần token (ngoài phạm vi).

## PHASE 5 — Kiểm thử & rollout (P1, ~1 tuần)

- Chạy song song app cũ + shell mới vài ngày.
- Tiêu chí chuyển hẳn: git review (Phase 2) đủ parity.
- Rollback: hai app độc lập hoàn toàn → chỉ cần ngừng mở shell mới.

## Bảng ưu tiên gap (C) còn lại

- P0: reveal-in-explorer, dialog chọn folder, mở link ngoài.
- P1: clipboard image, native notification action-click.
- P2 (đặc thù, không cốt lõi): multi-window pop-out, pet overlay, terminal tab tự
  do generic, deep-link `hermes://`, custom media protocol, WSL clipboard bridge,
  VS Code theme marketplace proxy.

## Danh sách gap đầy đủ (tham chiếu)

(A) Impossible-in-browser: PTY shell tự do, self-rebuild+relaunch, uninstaller,
Windows registry read, OS keychain, deep-link, media protocol, pet overlay,
multi-window, window-state, native titlebar/vibrancy, `webUtils.getPathForFile`,
WSL clipboard, hidden-window title scrape, YouTube Referer inject, bootstrap installer.

(B) Possible-via-backend-API: **toàn bộ git review pane** (gap lớn nhất), worktree/
branch ops, git-root, repo scan, directory tree sâu, file read/write/rename, file
watch, VS Code theme fetch (chỉ vướng CORS).

(C) Thin-IPC-bridge: dialog folder native, reveal/trash, clipboard image, terminal
tab generic, mở link ngoài, notification routing, mic permission gate.

(D) Đã có trong web/: PTY cho `hermes --tui` (ChatPage), Sessions/Skills/MCP/Cron/
Config/Env/System/Analytics, backend self-update, i18n, markdown/mermaid/katex.
