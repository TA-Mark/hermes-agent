# Custom Desktop Features — Update-Safe Guide

Tài liệu này thuộc về bản cài **gốc** (NousResearch/hermes-agent) nhưng dùng để
phát triển thêm tính năng cho Electron desktop app **mà không mất update gốc**.
Đây là file custom (không thuộc upstream) — đặt tên riêng để `git pull` không
đụng tới nó.

> Mục tiêu cốt lõi: thêm tính năng vào `apps/desktop/` nhưng KHÔNG mất khả năng
> nhận `hermes update` / self-update của desktop.

## Cơ chế update hoạt động thế nào (đọc trước khi sửa gì)

```
hermes update / nút update  →  git pull trên checkout hermes-agent
                            →  hermes desktop --build-only  (tsc + vite build, rebuild tại chỗ, retry-once)
                            →  relaunch nếu execPath nằm dưới release/<plat>-unpacked
```

- Logic ở `apps/desktop/electron/main.cjs` + `electron/update-*.cjs`
  (`update-remote`, `update-marker`, `update-rebuild`, `update-relaunch`, `update-count`).
- Update **KHÔNG** tự xóa file của bạn. Chỉ `git pull` mới có thể đụng, và chỉ
  với file **đã tracked bị sửa ở cả hai phía** (→ merge conflict).
- Rebuild chỉ compile cây nguồn **sau khi** pull. File đã nằm trong cây (đã commit
  hoặc untracked được giữ) sẽ được build vào app.

## Đặt code custom ở đâu (rủi ro từ thấp → cao)

| Cách | Rủi ro update |
|---|---|
| **Thêm FILE MỚI** tên không đụng upstream (vd `custom-*`) — component trong `src/`, IPC trong `electron/custom-*.cjs` | ✅ An toàn nhất. `git pull` giữ file mới; chỉ conflict nếu upstream sau này thêm file trùng tên. |
| **Wiring tối thiểu** vào file upstream (đăng ký IPC ở `main.cjs`/`preload.cjs`, thêm route/nav ở renderer) | ⚠️ Chấp nhận được nếu giữ 1-2 dòng import + gọi hàm từ file custom → conflict khi pull dễ resolve. |
| Sửa nhiều/rải rác trong file core (`main.cjs`, `git-review-ops.cjs`, `tui_gateway/server.py`…) | ❌ Tránh. Mỗi lần upstream đổi cùng file → conflict, bảo trì tốn. |
| Sửa file local mà KHÔNG commit | ❌ Tránh. `git pull` sẽ chặn/conflict, dễ mất code. |

## Quy trình giữ update sạch (bản gốc, không fork)

1. Commit code custom vào branch riêng (vd `CustomDesktop`).
2. Khi muốn update:
   ```bash
   git fetch origin main
   git rebase origin/main        # resolve conflict tại đúng các điểm wiring tối thiểu
   # rồi rebuild:
   hermes desktop --build-only   # hoặc: cd apps/desktop && npm run build
   ```
3. Rebase giữ commit custom nằm **trên cùng**, tách bạch khỏi lịch sử upstream.
4. **Ưu tiên update thủ công (fetch + rebase)** thay vì bấm nút update trong app
   khi branch custom có commit chưa merge — nút đó pull thẳng vào checkout và
   dễ gây merge/conflict.

## Ranh giới desktop bắt buộc tôn trọng (từ AGENTS.md + DESIGN.md)

- **KHÔNG** dựng lại transcript / composer / PTY terminal — đó thuộc `hermes --tui`
  nhúng. Widget phụ (sidebar, inspector, pane mới) thì được, miễn state độc lập
  với PTY child và fail non-destructive.
- Nếu tính năng cần **event/method mới qua JSON-RPC** tới backend → sửa
  `tui_gateway/server.py` và **bump `_DESKTOP_PROTOCOL_VERSION`**
  (comment: "Bump whenever the desktop's backend contract changes") để backend
  cũ + app mới không lệch contract khi update.
- **Design system** (`apps/desktop/DESIGN.md`): dùng primitive có sẵn (`Button`,
  `SearchField`, `SegmentedControl`, `ListRow`, `Loader`, `ErrorState`, `LogView`),
  token thay literal (`--ui-*`, `shadow-nous`, `--stroke-nous`), cập nhật **cả 4
  locale** (en/ja/zh/zh-hant) cho mọi string mới.
- Slash command desktop curate ở `apps/desktop/src/lib/desktop-slash-commands.ts`.
- **Verify trước khi build/PR** (chạy từ `apps/desktop/`):
  ```bash
  npm run typecheck && npm run lint && npm run test:desktop:all
  ```

## Đã có sẵn — kiểm tra trước khi xây mới

`apps/desktop/electron/git-review-ops.cjs` đã là một **Codex-style review pane +
coding rail** (dựa trên `simple-git`):

- Review theo scope: `uncommitted` (staged/unstaged/untracked), `branch`
  (diff vs merge-base của origin/HEAD), `lastTurn` (diff vs baseline lúc bắt đầu turn).
- Diff từng file (`reviewDiff`, `fileDiffVsHead`), synthesize all-add cho untracked.
- Git ops: stage / unstage / revert / commit (auto stage-all) / push (auto upstream),
  tạo PR qua `gh` (`reviewShipInfo`, `reviewCreatePr`).
- AI commit message: `reviewCommitContext` (gom diff + recent commits).
- Coding rail: `repoStatus` (branch, ahead/behind, +/- vs HEAD, đếm untracked).

→ Rất có thể việc cần làm là **mở rộng** cái này (thêm scope/action), không phải
làm mới. Chạy thử review pane hiện tại để chốt còn thiếu gì trước khi code.
