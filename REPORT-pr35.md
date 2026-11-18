# REPORT：PR-3 / PR-5 设计与最小实现

- 分支：`feature/layered-download-pr35`
- 工作树：`/opt/Octop-worktrees/layered-download-pr35`（未触碰 `/opt/Octop`、其它 worktree、crontab）
- 日期：2026-11-19
- 主交付物：`docs/desktop-runtime-layered-download-pr3-pr5.md`

---

## 1. 已完成

### 1.1 设计文档

`docs/desktop-runtime-layered-download-pr3-pr5.md`，包含任务书要求的全部章节：

| 任务书要求 | 文档位置 |
|---|---|
| 触发点清单（tencent / google / boto / lark） | §4.1 触发矩阵（另补 browser/ocr/embedding） |
| Go 壳与 Python 后端之间传递「缺哪个 part」 | §4.2（结构化错误 `details.part`）+ §4.3 三条链路 |
| 进度面板状态机 / 事件来源 / UI 落点 / 失败取消重试 | §5.1 – §5.5 |
| 与 PR-1 manifest 的契约 | §3（part 字段、id/feature 映射、target 布局、state/升级） |
| 分阶段实施计划与风险 | §6、§8 |
| 需 Windows 真机验证 | §9（12 条） |

### 1.2 代码原型（纯新增，未改任何现有文件）

commit **`b914dad4`** `feat(desktop): 新增 bootstrap.RunParts 按需安装指定分片（PR-5 原型）`

- `desktop/src/bootstrap/run_parts.go`
  - `RunParts(opts Options, partIDs []string) error`
  - 只装有 ID 点名的 part（无论 `required` 真假），复用同一 cache/`state.json`；
  - 拒绝未知 part id；
  - 拒绝两个 part 解压到同一 `Target`；
  - **不修改 `Run()`**，不传 partIDs 的现有调用行为完全不变。
- `desktop/src/bootstrap/run_parts_test.go`（4 个用例）

验证：

```text
$ cd desktop/src
$ gofmt -l bootstrap/            # 无输出
$ go vet ./bootstrap/            # 通过
$ go test ./bootstrap/ -count=1
ok  	octop.desktop/bootstrap	0.029s
```

提交时仓库 pre-commit 全绿（ruff / mypy / smoke pytest 82 passed）。

### 1.3 关键发现（需要上游注意）

1. **`Extract` 先 `os.RemoveAll(dest)`**（`desktop/src/bootstrap/unpack.go:22-27`）。
   任务书 `:92` 计划让多个 part 共用 `target: "packages/"`，按现有代码会互相删除，
   包括 `packages/octop` 与全部核心依赖。设计文档 §3.3 给出两种修正，
   推荐「每 part 独占 `packages/_parts/<id>` + deps-core 带 `octop-parts.pth`」。
2. **运行中安装的模块默认不可 import**：`site.addsitedir()` 只在进程启动时处理
   `.pth`。设计 §4.5 推荐后端 `ensure_*` 显式追加 `sys.path`。
3. **`googleapiclient` 在 `src/octop` 中 0 处 import**，不建议单独发行 part；
   `boto3` 同样 0 处直接 import（来自 harness 链）。
4. **进度事件有丢首帧风险**：`go api.boot()` 早于页面 `Events.On` 注册；
   设计要求壳缓存最近事件并支持页面主动拉快照。

---

## 2. 与 PR-1 manifest 的对接点（给 worker B）

| 对接点 | 约定 |
|---|---|
| 必需 part | `runtime` / `app` / `deps-core`，`required:true`，根 part 排第一 |
| 可选 part id | `deps-browser` / `deps-feishu` / `deps-aws` / `deps-tencent`（+ 可选 `deps-ocr` / `deps-embedding`） |
| 新增字段（可选） | `feature`（与后端 `details.part` 的映射键）、`label`（壳文案 key）、`background`（是否启动后预取，默认 false） |
| target | **每个 part 独立**：`packages/_parts/<part-id>`；`deps-core` 附带 `packages/octop-parts.pth` |
| 校验 | 沿用 `size` + `sha256`（对压缩包） |
| 版本 | 可选 part 跟着 manifest `version` 走；根 part 升级会清空 Root，可选 part 状态归零后按需重装 |
| 平台 | 运行时下载路径需补 `Platform` 校验（现状 `download.go:259-262` 丢弃了 Platform，视频路径 `video_install.go:150-155` 有校验） |

**请不要**让多个 part 使用相同的非空 `target`，除非先改 `Extract` 语义（设计 §3.3 方案 B）。

---

## 3. 仍需人类决策

1. **PR-1 target 方案 A（独立子目录 + .pth）还是 B（改 Extract 为 additive）**。
   推荐 A。
2. **OCR / embedding 是否也上分片**。推荐第一版继续走现有
   `runtime_packages.install_packages`，只对 browser/feishu/tencent 启用分片，
   避免壳下载器与 pip 抢着装同一个包。
3. **新增 `FEATURE_DEPS_MISSING` 错误码**还是复用现有 `*_DEPS_FAILED` + `details.part`。
   新增更清晰，但需要动 `src/octop/infra/errors.py` 与 i18n（本 worker 范围外）。
4. **dashboard 阶段的可选组件进度**：顶部提示条（改 dashboard）还是仅托盘气泡（只改壳）。
5. **是否需要「取消可选下载」**。当前 `bootstrap.Run` 无 `context`，取消需要改
   `Options`；第一版建议只提供启动前「稍后」。
6. **`uv.exe` 是否随 PR-0 拆出 core**。若拆，必须同步
   `runtime_packages.py:42-79` 与 `self_update.py:111-141` 的查找路径。

---

## 4. Windows 真机验证清单

详见设计文档 §9，摘要：

1. 全新 Win10/11 首启：阶段 + 真实百分比 + 速度/ETA，完成后自动进 dashboard。
2. 50% 杀进程 → 重开续传，不重复下载。
3. 首镜像 404 / 断网 → 自动换镜像；全挂时 error 面板可重试且保留 `.part`。
4. 篡改分片 → `PACKAGE_INVALID`、不落盘。
5. 飞书按需安装 → 装完**不重启进程**即可用（验 §4.5 B1）。
6. 腾讯云按需安装 → 云资源页正常。
7. 浏览器：未装 `deps-browser` 时有引导；Chromium 仍走 `POST /api/browser/install`。
8. 可选 part 全 404 → 主流程可用、无死循环重试。
9. 长路径（默认短根 + 一个很深的自定义路径）下 `_parts/` 解压。
10. 升级：DB 备份成功、根 part 替换、可选 part 归零可重装、旧版可回退。
11. Defender 实时防护下的安装耗时与误报。
12. 非管理员账户全程不写 `Program Files`。

---

## 5. 本机无法处理、需汇总到 docs/

> 以下事项超出本 worker 的改动范围（`src/octop/**`、`pyproject.toml`、`uv.lock`、
> PR-1 构建脚本、Windows 真机），按「原因 / 步骤 / 验收标准」列出。

### 5.1 后端依赖探测与结构化错误

- **原因**：需要改 `src/octop/infra/errors.py`、`src/octop/i18n/*.json` 与
  `infra/cloud/tencent.py`、`infra/gateway/bot_creators/feishu_bot_creator.py`、
  `api/routers/browser/env.py` 等，属于其它 worker 范围。
- **步骤**：
  1. 新增 `ErrorCode.FEATURE_DEPS_MISSING` 与 `errors.FEATURE_DEPS_MISSING` 中英文案；
  2. 在 tencent / feishu / browser 的功能入口做 `importlib.util.find_spec` 探测；
  3. 缺失时抛 `OctopError(..., details={"feature": ..., "part": ..., "modules": [...]})`；
  4. 在 `ensure_*` 里把 `packages/_parts/<id>` 追加进 `sys.path`（§4.5 B1）。
- **验收**：`uv run pytest tests/unit -q` 绿；单测覆盖「缺失 → 抛错带 part」
  与「安装后重试成功」；`uv run pytest tests/unit/i18n -q` 键对齐。

### 5.2 PR-1 分片构建脚本与 manifest

- **原因**：`desktop/portable/package-shards.sh`（新脚本）与 CI job 属 PR-1，
  本 worker 不碰打包链。
- **步骤**：按设计 §3.2/§3.3 产出 `runtime` / `app` / `deps-core` / 可选 part；
  每个可选 part 用独立 target；deps-core 生成 `octop-parts.pth`；
  输出 `manifest.json`（`feature`/`label`/`background` 字段可选）。
- **验收**：manifest 通过 `bootstrap.LoadManifest` 解析；
  `RunParts` 能只装某个可选 part；两个可选 part 先后安装后两份文件都在；
  CI 产物 `sha256` 与 manifest 一致。

### 5.3 运行时下载路径补 `Merge` 与 `Platform` 校验

- **原因**：任务书 `:93-95` 要求改 `desktop/src/download.go:259-271`，
  本任务明确「不要修改 download.go」。
- **步骤**：`bootstrapRuntime` 的 `Options` 加 `Merge: true` 并透传
  `manifest.Platform`；`runtimeParts` 保持 manifest 顺序（根 part 第一）。
- **验收**：`desktop/src/portable_download_test.go` 全绿，新增
  「根 part + 子路径 part」用例；`go test ./...` 通过。

### 5.4 壳 UI 与桥接实现（PR-3a/PR-5b 的落地）

- **原因**：需要改 `main.go`、`download.go`、`assets/index.html` 并新增
  `runtime_install.go` / `runtime_bridge.go`；本次只做设计与无侵入原型，
  避免与 worker B 的文件冲突。
- **步骤**：按设计 §5.2/§5.4/§6 实现 `desktop:progress` 事件、事件缓存与
  `GetProgressSnapshot`、`RetryBootstrap`、`window.octopDesktopRuntime` 桥
  （`status` / `install_part` / `retry`），loading 面板接真实进度。
- **验收**：`go test ./...` 绿；壳页面在下载中显示真实百分比；
  页面刷新后能通过快照恢复到当前进度；可选 part 安装不影响主流程。

### 5.5 Windows 真机验证

- **原因**：本机是 Linux，Wails 壳的 WebView2、长路径、Defender、文件锁行为
  无法在本机复现。
- **步骤**：按 §4 清单在 `windows-latest` 之外再用一台真机/虚拟机执行 1–12 项；
  重点验 §4.5 的「装完不重启即可 import」与 §8 的「运行中替换 DLL」。
- **验收**：12 项全部通过，记录每项耗时与日志路径；失败项附 `navlog` 片段。

### 5.6 dashboard 侧的错误码处理与可选组件提示

- **原因**：`dashboard/src/**` 未被本任务禁止，但属于前端改动，需与 §5.1 的
  错误码一起落地，单独提交更清晰。
- **步骤**：在 `api/request.ts` / `apiError.ts` 识别 `FEATURE_DEPS_MISSING`；
  读取 `details.part` → 调 `window.octopDesktopRuntime.request("install_part")`
  → 轮询 `status()` → 重试原请求；无桥时展示安装提示。
- **验收**：`cd dashboard && npx tsc -b && npm run lint && npm test` 绿；
  浏览器模式（无壳）不报错，只显示提示。

---

## 6. 提交记录

| commit | 内容 |
|---|---|
| `b914dad4` | `bootstrap.RunParts` 原型 + 单测（纯新增） |
| `5550e655` | 设计文档 + 本报告 |
