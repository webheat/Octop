# 后端 MVP v0.1 — 部署记录（fix/backend-mvp-v01-integration）

> 本文件记录**后端**（FastAPI）在本机部署机的上线过程与验证证据。
> 部署凭据（账号、密码、路径等）另见本机不入库的 `docs/deployment-ocbot-videogen.local.md`，**不要把凭据写进本文件**。
> 前端（dashboard）与桌面端（desktop）不在本次范围内。

日期：2026-10-24
分支：`fix/backend-mvp-v01-integration`（跟踪 `origin/fix/backend-mvp-v01-integration`）

## 1. 上线内容

分支相对 `main` 的后端增量（主线 `efb27ac0` 之后）：

| 文件 | 内容 |
|---|---|
| `src/octop/infra/product_library/llm_video_planner.py` | OpenAI 兼容接口的 LLM 分镜规划器，含严格脚本校验（场景类型/时长/素材白名单/总时长 ≤180s） |
| `src/octop/infra/product_library/video_drafts.py` | 按 owner 隔离的草稿存储：`{OCTOP_HOME}/product-library/video-drafts/<user_id>/<project_id>.json`，临时文件 + `os.replace` 原子写、`0600` 权限 |
| `src/octop/api/routers/product_library.py` | 新增 4 个端点（见下） |

新增 API（`/api/product-library/projects/{project_id}/…`）：

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `generate-storyboard` | 调 LLM 生成分镜并落盘草稿；模型不可用返回 502 |
| GET | `storyboard` | 读取本人草稿；无草稿 404 |
| PUT | `storyboard` | 编辑/校验草稿并可标记 `confirmed`；非法脚本 422 |
| GET | `storyboard-package` | 导出已确认草稿为 Studio ZIP；未确认 409 |

另有 `style(video)` 格式化修复（仅 import 排序与换行，无行为变更）。实施任务书已完成历史归档，验收要求以本文 §2 测试证据与 §4 上线验证为准。

## 2. 后端测试证据

前端与桌面端测试全部跳过（部署机不产出客户端产物）。

| 检查 | 命令 | 结果 |
|---|---|---|
| 定向 MVP 测试 | `uv run pytest -q tests/unit/db/test_video_storyboard_drafts.py tests/unit/db/test_video_planner_mvp.py tests/unit/db/test_product_package_export.py` | `9 passed` |
| 全量后端单测 | `uv run pytest -m "not live and not slow" -q tests/unit` | `4188 passed, 4 skipped, 282 deselected`（571.90s） |
| 类型检查 | `uv run mypy src/octop` | `Success: no issues found in 608 source files` |
| Lint / 格式 | `uv run ruff check src tests` + `uv run ruff format --check src tests` | `All checks passed!` / `1262 files already formatted` |
| 格式化后回归 | 受影响的 5 个测试文件 | `35 passed` |
| 提交门禁 | `.githooks/pre-commit`（`make format` / `lint` / `typecheck` / `test-smoke`） | `all checks passed`（`SKIP_FRONTEND=1`，跳过 dashboard 构建） |

未执行：集成测试、`make test` 全量、桌面安装包编译、支付/真实模型调用。

## 3. 部署步骤（本机部署机可复现）

```bash
cd /opt/Octop
git fetch origin
git checkout fix/backend-mvp-v01-integration
git pull --ff-only            # 仅当远端有新提交

# 依赖检查：本次 pyproject.toml / uv.lock 未变化，
# 因此**不要**直接 `uv sync`（会卸载 desktop / local-embedding / knowledge-ocr 等可选 extra）
git diff <上线commit> HEAD -- pyproject.toml uv.lock   # 期望为空

systemctl restart octop.service
systemctl is-active octop.service
curl -s https://ocbot.aixifs.com/videogen/api/health
```

说明：

- 服务为 systemd 单元 `octop.service`，`OCTOP_HOME=/opt/octop-data`、`OCTOP_BASE_PATH=/videogen`，监听 `127.0.0.1:8088`，由 nginx 反代到 `https://ocbot.aixifs.com/videogen`。
- `octop` 以 editable 方式安装在 `/opt/Octop/.venv`，拉分支后重启即生效，无需重新安装。
- `octop-watchdog.timer` 每 120 秒探活，不通会自动重启；维护时先 `systemctl disable --now octop-watchdog.timer`。
- **不要**在本机跑 `dashboard/` 的 vite 构建（2 核 3G 机器会 OOM，见 `.githooks/local.env` 的 `SKIP_FRONTEND=1`）。

## 4. 上线后验证结果

| 项 | 结果 |
|---|---|
| 服务状态 | `active (running)`，`octop-watchdog.timer` active |
| 健康检查 | `{"ok":true,"db":true,"users_loaded":2,"agents_running":2}` |
| journal | 重启后无 error 级日志 |
| OpenAPI | 4 个新端点均出现在 `/api/openapi.json` |
| 未登录访问 | `GET /api/product-library/projects/{id}/storyboard` → **401** |
| 越权/不存在项目 | 登录后访问不存在项目 → **404**（不泄露资源存在性） |
| 登录 | admin 登录接口正常返回 JWT |

## 5. 已知限制

1. **微信开放平台扫码登录未做真机联调**：本阶段未提供 AppID/AppSecret，`wechat_open` 入口在未配置时保持关闭；真实扫码流程尚未验证。
2. **`generate-storyboard` 需要外部模型凭据**：需配置 `OCTOP_VIDEO_LLM_API_KEY`、`OCTOP_VIDEO_LLM_BASE_URL`（必须 HTTPS）、`OCTOP_VIDEO_LLM_MODEL`；未配置时返回 502。本机当前未配置。
3. **草稿落在本地磁盘**（`{OCTOP_HOME}/product-library/video-drafts/<user_id>/…`）：单实例 MVP 可用，多后台节点之间无法共享草稿，不能据此宣称已实现完整多租户存储。
4. **控制台页面 404（既存问题，非本次引入）**：本机 `src/octop/dashboard/` 产物缺少 `index.html` 与 JS bundle（`assets/` 下只有 `mbti`），疑似一次未完成的 vite 构建残留。API 层不受影响。恢复方式：在开发机执行 `cd dashboard && BASE_URL=/videogen npm run build`，再把产物同步到本机 `src/octop/dashboard/`。
5. **多实例部署未验证**：本次仅单机部署，未做多节点/共享存储场景验证。
