# PR-3 / PR-5 设计：下载进度面板与可选组件按需补齐

> 状态：**设计稿 + 最小原型**（2026-11-19）
> 前置阅读：`docs/desktop-runtime-layered-download-task.md`（任务书）、
> `docs/desktop-bootstrap-installer.md`（方案权威文档，§5.2 / §6 / §九）
> 代码基线：分支 `feature/layered-download-pr35`，commit `affc8623`

---

## 0. 结论（先读）

1. **下载器本身的复用没有问题**：`bootstrap.Run()` 已具备 manifest / 断点续传 /
   SHA256 / 多镜像 / `state.json`。PR-5 缺的只是「按 ID 只装某几个 part」的入口，
   本设计用 **纯新增** 的 `bootstrap.RunParts(opts, partIDs)` 验证了这条路可行
   （原型已提交、单测通过，见 §7）。
2. **PR-1 的 manifest 设计有一个必须先解决的冲突**：`bootstrap.Extract()` 解压前会
   `os.RemoveAll(dest)`（`desktop/src/bootstrap/unpack.go:22-27`）。如果按任务书
   `:92` 让 `deps-core` / `deps-browser` / `deps-feishu` 都把 `target` 写成 `packages/`，
   **后装的 part 会把先装的整个 `packages/` 删掉**（包括 `packages/octop` 和全部核心依赖）。
   本文 §3.3 给出两种修正方案，推荐「每个 part 独占子目录 + `.pth`」。
3. **进度面板不能只改 HTML**：`desktop:status` 只有一段字符串
   （`desktop/src/main.go:217-222`），真实百分比在 `bootstrap.Progress` 里但当前被
   压成一句文案（`desktop/src/download.go:264-269`）。需要新增结构化的
   `desktop:progress` 事件，并在 `main.go` 侧维护阶段状态。
4. **可选组件的触发必须分两条路**：能由前端发起的功能（浏览器、视频）
   走「dashboard → 注入的 JS 桥 → Go 壳」；服务端先执行的功能（飞书渠道、
   腾讯云路由）必须先由 Python 探测依赖并在错误里带上 `part` 标识，dashboard 再
   回头触发壳安装。**壳是唯一持有 manifest 与下载器的一侧**，
   Python 侧不应重复实现分片下载。
5. **「装完立刻可用」有一个 Python 侧的坑**：`site.addsitedir()` 只在进程启动时
   处理 `.pth`，运行中新增的目录不会自动进 `sys.path`。§4.5 给出三个解法，
   推荐由后端 `ensure_*` 显式追加路径。

---

## 1. 范围

### 做

- **PR-3**：首启下载/安装的真实进度面板（阶段、百分比、速度、失败/重试）。
- **PR-5**：`required:false` 的可选 part 在用户触发相关功能时后台补齐，
  失败不阻塞主流程；桌面壳与 Python 后端之间「缺哪个 part」的信令协议。
- PR-3/PR-5 与 PR-1 manifest 的契约（part id、字段、落盘位置）。

### 不做

- 依赖瘦身（PR-0）与跨仓库 extra（PR-0b）。
- 分片构建脚本本身（PR-1，worker B 范围）。
- 修改 `src/octop/**`、`pyproject.toml`、`uv.lock`（并行 worker 范围）。
  本文只给出「需要后端配合的接口」，不落地后端改动。
- macOS / Linux 瘦安装器（仍只做 Windows）。

---

## 2. 现状核对（代码证据）

### 2.1 下载器能力边界

| 能力 | 位置 | 现状 |
|---|---|---|
| part 结构 | `desktop/src/bootstrap/bootstrap.go:21-39` | `ID/URLs/Size/SHA256/Format/Target/StripRoot/Required` |
| manifest | `bootstrap.go:42-46` | `Version/Platform/Parts` |
| 只装 required | `bootstrap.go:158-162` | `!part.Required` 直接 `continue` |
| 根 part 约束 | `bootstrap.go:171-197` | 至多一个 `Target==""`；merge 模式必须排第一 |
| 断点/校验/缓存 | `bootstrap.go:214-277`、`fetch.go:46-190` | 已生产验证 |
| 进度回调 | `bootstrap.go:48-65`、`fetch.go:210-224` | 有 `PartID/Received/Total`，有 total 时每个整数百分比回调 |
| 多 part 落盘 | `bootstrap.go:280-289` | `Root/<Target>`，`Target==""` 即 Root |

**结论**：`Run()` 层面没有「按 ID 过滤」的入口。最小新增点是
`bootstrap.RunParts()`（§7 原型），不需要改 `Run()` 的语义。

### 2.2 关键约束：`Extract` 会先清空目标目录

```go
// desktop/src/bootstrap/unpack.go:22-27
func Extract(archive, dest, format string, stripRoot bool) error {
	if err := os.RemoveAll(dest); err != nil { ... }
	if err := os.MkdirAll(dest, 0o755); err != nil { ... }
```

视频组件之所以能多 part 共存，是因为 target 互不重叠：
`core.zip` → `""`（运行时根），`browser.zip` → `node_modules/.remotion/chrome-headless-shell`
（`scripts/pack_video_components.py:145-176` 的注释也明确写了「so the two parts never overlap」）。

**由此推出 PR-3/PR-5 的硬约束**：
两个 part 的 `Target` 不能相同，除非改变 `Extract` 语义。
任务书 `:92` 的「各 part 用 target 指向同一 `packages/` 子路径」按当前代码会互相删除，
必须在 PR-1 落地前修正（§3.3）。

### 2.3 进度通道现状

| 通道 | 位置 | 能力 |
|---|---|---|
| `desktop:status` | `main.go:217-222` 发出；`assets/index.html:753-764` 消费 | **纯字符串**，没有阶段/百分比/part |
| 首启状态文案 | `download.go:39-82`、`264-269` | 「正在下载运行环境 N%」一句，百分比来自 `bootstrap.Progress` |
| loading 面板 | `assets/index.html:486-505` | 进度条是 CSS 无限滑动动画（`:385-392`、`:406-413`），**不是真实进度** |
| 视频环境进度 | `video_environment.go:17-24` 状态；`video_bridge.go:29-60` 桥；dashboard 每 1500ms 轮询 `environment_status`（`DesktopVideoJobsContext.tsx:426-436`） | 结构化的 `state/stage/progress/errorCode`，但只服务视频，且是**请求-响应 + 轮询**，不是事件推送 |

两个已知时序问题：
- `go api.boot()`（`main.go:639`）早于页面注册 `Events.On`（`index.html:753`），
  **早期状态事件会丢**，页面只能用 `copy.statusWait` 兜底（`index.html:730-731`）。
- dashboard 导航后（`main.go:351`）嵌入页被替换，`desktop:status` 处理器随之卸载。
  因此「dashboard 可用后继续拉可选组件」的进度**不能**再依赖 loading 面板。

### 2.4 后端按需装包现状

`src/octop/infra/utils/runtime_packages.py` 已有一套成熟的运行时装包：

- `install_packages(spec, is_satisfied=..., import_modules=..., timeout=...)`
  （`:204-241`），返回 `"ready" | "installed"`；
- 优先 `uv pip install --python sys.executable`，再退回 `pip`（`:116-133`）；
- 全局 `_INSTALL_LOCK`（`:226`）串行化，双重 `is_satisfied` 检查保证幂等；
- 失败只抛 `RuntimeError`（`:234-241`）；异步包装 `install_packages_async`（`:244-260`）；
- 调用点：`onnx_service.py:42-49/99-103`（fastembed）、`knowledge/ocr.py:31-38/129-151`
  （rapidocr 等）、`backend/opensandbox_deps.py:9/16-41`、`control/desktop/setup.py:348-356`。

各可选依赖的实际 import 面（已核对）：

| 依赖 | src/octop 内的 import | 触发功能 |
|---|---|---|
| `tencentcloud-sdk-python` | `infra/cloud/tencent.py:31-38` **模块级**；`api/routers/cloud.py:13` 顶层引用 | 云主机列表/监控/操作（`/api/cloud/*`） |
| `lark-oapi` | `infra/gateway/bot_creators/feishu_bot_creator.py:34-39`（子进程） | 飞书渠道创建/机器人创建（`channels.py:818/874/928`） |
| `boto3` / `botocore` | **src/octop 中 0 处直接 import**（`pyproject.toml:39` 核心依赖，来自 harness 链） | S3 系存储后端 / AWS 连接器（间接） |
| `googleapiclient` | **0 处** | 无；建议不单独发行 part |
| `playwright` | `api/routers/browser/env.py:81`（函数内 try/except） | 浏览器功能；Chromium 走 `POST /api/browser/install` |

> `uv.exe` 的查找：`self_update.py:111-141` 优先 `$OCTOP_GREEN_PACKAGES/bin/uv(.exe)`，
> `runtime_packages.py:42-79` 优先 `OCTOP_UV_BIN` → PATH → 常见路径。若把 `uv.exe`
> 从 core 拆成可选 part，这两处查找路径都要同步（见 §8 风险）。

---

## 3. 与 PR-1 manifest 的契约

### 3.1 Part 字段扩展（向后兼容）

`bootstrap.Part` 增加三个可选字段（`encoding/json` 会忽略旧客户端不认识的字段）：

```go
type Part struct {
    // ...现有字段...
    // Feature is the product feature this part unlocks ("browser", "feishu",
    // "aws", "tencent", "ocr", "embedding"). Empty on required parts.
    Feature string `json:"feature,omitempty"`
    // Label is a key into the shell's embedded copy table, not a human string.
    Label string `json:"label,omitempty"`
    // Background means the shell may fetch this part right after the
    // dashboard is up, without waiting for a feature to ask for it.
    Background bool `json:"background,omitempty"`
}
```

> 这三个字段只被 PR-3/PR-5 使用；PR-1 的必需 part 全部留空即可。
> 是否把它们放进 `Part` 结构需要改 `bootstrap.go` —— **本文不代改**，
> 已在 §6 列为「需要与 PR-1 协调的单点改动」。

### 3.2 part 清单与 feature 映射（建议值）

| part id | required | feature | 内容 | 压缩估算 |
|---|---|---|---|---|
| `runtime` | 是 | — | 便携 CPython，target `runtime/` | ~40 MB |
| `app` | 是 | — | `packages/octop/` + dashboard | ~30 MB |
| `deps-core` | 是 | — | 其余核心依赖 + `octop-parts.pth` | ~150 MB |
| `deps-browser` | 否 | `browser` | playwright python 包 | ~50 MB |
| `deps-feishu` | 否 | `feishu` | lark-oapi | ~20 MB |
| `deps-aws` | 否 | `aws` | boto3/botocore/aioboto3 链 | ~25 MB |
| `deps-tencent` | 否 | `tencent` | tencentcloud-sdk-python | ~12 MB |
| `deps-ocr` | 否 | `ocr` | rapidocr/onnxruntime/pymupdf/shapely | ~90 MB |
| `deps-embedding` | 否 | `embedding` | fastembed/huggingface_hub | ~60 MB |

**不发行**：`googleapiclient`（src/octop 0 处 import）。若 harness 侧确实需要，
属于 PR-0b 的 extra 收窄，不在这里加 part。

**边界**：Chromium 运行时**不放进 part**，继续走现有
`POST /api/browser/install` SSE（`api/routers/browser/env.py:128-189`）——
它由 `octop_browser.install_chromium_stream()` 负责，重复实现会引入两套缓存目录。

### 3.3 target 布局（PR-1 必须改）

当前 `Extract` 会清空 dest，所以**两种可行布局**：

**方案 A（推荐，零 Go 解压改动）**：每个可选 part 独占子目录 + 静态 `.pth`

```text
portable/
  runtime/
  packages/
    octop/                          ← app part
    requests/ ... （核心依赖）        ← deps-core part
    octop-parts.pth                 ← deps-core 附带
    _parts/
      deps-browser/                 ← target: packages/_parts/deps-browser
      deps-feishu/
      deps-aws/
```

`octop-parts.pth` 内容（相对路径按 `.pth` 所在目录解析）：

```text
_parts/deps-browser
_parts/deps-feishu
_parts/deps-aws
_parts/deps-tencent
_parts/deps-ocr
_parts/deps-embedding
```

- `launch.py:30-42` 对 `packages/` 调用 `site.addsitedir`，会处理这份 `.pth`；
- 指向不存在目录的行会被 `site` 忽略，装上后**仍需** §4.5 的运行时 `sys.path` 追加；
- 每个可选 part 的 `Extract` 只清空自己的 `_parts/<id>`，互不影响；
- 与视频组件「target 互不重叠」的既有心智模型一致。

**方案 B（要改解压语义）**：给 `Part` 增加 `Additive bool`，`unpack()` 对
additive part 跳过 `RemoveAll`，允许多个 part 共享 `packages/`。
优点是 manifest 简单；缺点是：
- 旧文件不会被清理，升级时可能残留上一版本的文件；
- Windows 上若目标 DLL 正被运行中的 Python 加载，`RemoveAll`/覆盖会失败；
- 改动落在 `bootstrap.go`/`unpack.go`，影响面比 A 大。

> **建议 PR-1 采用 A**。无论 A/B，`RunParts` 原型都会拒绝同 target 的选中集合
> （`run_parts.go:67`），把问题暴露在开发期而不是用户机器上。

### 3.4 state 与升级

- 可选 part 与必需 part 共用 `state.json`（`state.go:23-26`），下载完成后才解压，
  崩溃不会重复下载（`bootstrap.go:265-276`）。
- 版本变更时 `Run` 会重建 state 并清空 `CacheDir/parts`（`bootstrap.go:147-154`），
  但**不会清理解压后的 `Root`**；真正清 Root 的是 `replacePortable`
  → `Extract(target=="")`（`download.go:84-114`、`unpack.go:22`）。
  因此升级后可选目录会随根 part 一起消失，state 里也没有它们的记录，
  下一次触发会重新下载 —— 语义正确，但**要求升级流程必须在根 part 装完后
  再按需补可选 part**，不能沿用旧目录。
- `RunParts` 复用同一 `state.json`：已下载分片直接解压，不重复请求（原型单测
  `TestRunPartsInstallsOnlyTheNamedOptionalPartAndKeepsTheRoot` 已覆盖）。

---

## 4. 触发点设计（PR-5）

### 4.1 触发矩阵

| feature | part | 用户入口（HTTP/页面） | 执行侧 | 触发方式 |
|---|---|---|---|---|
| `browser` | `deps-browser` | 浏览器页 / `browser_tool` / `POST /api/browser/*` | 服务端（playwright 在 Python 进程内） | 后端 import 探测缺失 → 前端触发壳安装 |
| `feishu` | `deps-feishu` | 渠道页新建飞书渠道；`POST /api/agents/{id}/channels/feishu/bot-creator/start`（`channels.py:818`） | **子进程**（`feishu_bot_creator.py`） | 后端探测 `lark_oapi` 缺失 → 前端触发壳安装 |
| `aws` | `deps-aws` | 存储后端 `s3` 系 / AWS 连接器 | harness 间接 | 后端只做探测与错误提示；无直接 import 可探 |
| `tencent` | `deps-tencent` | 云资源页 `GET /api/cloud/*`（`cloud.py:202-346`） | 服务端（`infra/cloud/tencent.py`） | 后端 import 探测缺失 → 前端触发壳安装 |
| `ocr` | `deps-ocr` | 知识库开启 OCR：`PUT /api/knowledge-bases/feature`（`knowledge_bases.py:627-640`） | 服务端 | **优先沿用 `runtime_packages.install_packages`**（已工作） |
| `embedding` | `deps-embedding` | 本地向量模型启用/下载/测试（`knowledge_bases.py:620-626`、`onnx_models.py`） | 服务端 | 同上，沿用 pip 路径 |

**为什么 OCR / embedding 不强制走分片**：它们已有可用的 `runtime_packages` 路径
（PyPI + extras fallback），而分片下载还依赖 PR-1 产物与镜像。第一版只在
`deps-browser` / `deps-feishu` / `deps-tencent` 三个「体积大或 PyPI 装不稳」的
feature 上启用分片，其余保留现状，避免两套机制同时抢着装同一个包（`_INSTALL_LOCK`
无法跨进程保护壳的下载器）。

### 4.2 「缺哪个 part」的信令

**壳是 manifest 的唯一持有者**（URL 由 `-ldflags -X main.portableRuntimeManifestURL`
注入，`build/windows/Taskfile.yml:24/60-61`），Python 侧拿不到分片清单。
因此协议必须让**后端只报「缺哪个 feature/part」，由前端协调壳安装**。

后端侧（需要 `src/octop` 改动，本文不落地）：

```python
# 建议新增（或复用现有 *_DEPS_FAILED 并补 details）
raise OctopError(
    ErrorCode.FEATURE_DEPS_MISSING,
    "Feishu support is not installed",
    details={"feature": "feishu", "part": "deps-feishu", "modules": ["lark_oapi"]},
)
```

`OctopError.to_envelope()` 已经会带 `details`（`infra/errors.py:399-406`），
所以**不需要改信封结构**，只需要新增错误码与 i18n 文案。

前端（dashboard）侧的协调逻辑：

```text
调用 API → 收到 error.code == "FEATURE_DEPS_MISSING"
  → 读 error.details.part
  → 若 window.octopDesktopRuntime 存在：await request("install_part", {partId})
  → 安装成功 → 重试原 API
  → 壳不在（浏览器部署）→ 展示后端给的安装提示（或 pip 兜底按钮）
```

part id 与 feature 的对应关系以 §3.2 表为准；建议在 Go 与 Python 各放一份常量，
并用一个契约测试校验 manifest 里的 `feature` 能映射到后端常量（§9）。

### 4.3 三条链路

1. **dashboard → 壳（主链路，按需）**
   仿照视频桥：`video_bridge.go:77-92` 注入 `window.octopDesktopVideo`，
   页面通过 `window._wails.invoke("wails:event:emit:desktop:video:<nonce>:...")`
   发请求，Go 在 `videoAction`（`video.go:980-993`）分发。
   为运行时分片新增 **`window.octopDesktopRuntime`**：
   - `status()` → `{parts:[{id,feature,required,installed,size,state,progress,errorCode}]}`
   - `install_part({partId})` → 后台启动 `RunParts`，立即返回当前状态
   - `retry({partId})` → 同 `install_part`（state/cache 自动续传）
   - 进度由 dashboard 每 1500ms 轮询 `status()`（与视频环境一致，
     `DesktopVideoJobsContext.tsx:426-436`），不新增推送通道。
   注入点沿用 `installDragOverlay()`（`main.go:415-424`），它在导航完成后反复执行。

2. **壳背景预取（可选，`background:true`）**
   dashboard 可用后（`showDashboard` 之后，`main.go:298`），壳可以按 manifest 顺序
   后台安装 `background:true` 的 part。**默认建议全部为 false**：让用户真正用到时再装，
   避免首启后又偷偷下 100MB，违背 PR-5 的初衷。只给「几乎人人会用且体积小」的片
   打开（目前无）。

3. **后端 pip 兜底（非桌面部署）**
   浏览器/远程 dashboard 没有壳，`runtime_packages.install_packages` 仍是唯一路径。
   对 OCR/embedding 这类 PyPI 可得的依赖保留；对 `deps-feishu`/`deps-tencent` 这类
   分片，后端返回明确错误（"install the desktop build or pip install ..."），不尝试
   自己下载 tar.gz（它不知道 manifest URL）。

### 4.4 端到端时序（以飞书为例）

```text
用户点击「新建飞书渠道」
  └─ dashboard POST /api/agents/{id}/channels/feishu/bot-creator/start
       └─ 后端探测 import lark_oapi → 缺失
            └─ 409 { code: FEATURE_DEPS_MISSING, details:{part:"deps-feishu"} }
  └─ dashboard 发现 desktop runtime 桥
       └─ request("install_part", {partId:"deps-feishu"})
            └─ Go: RunParts(opts, ["deps-feishu"])（后台 goroutine）
                 ├─ LoadManifest 复用启动时缓存的 manifest（缺失则重新拉取）
                 ├─ 下载 → SHA256 → 解压到 packages/_parts/deps-feishu
                 └─ 状态机 done
       └─ dashboard 轮询 status 直到 done
  └─ 重试原 POST → 成功
```

### 4.5 运行中安装的可见性（必须处理）

`launch.py:36` 的 `site.addsitedir(packages)` 只在**进程启动时**执行一次；
`site` 对 `.pth` 中不存在的目录会跳过。因此**服务已经跑起来后再解压出来的模块，
默认不可 import**。三种解法：

| 方案 | 做法 | 评价 |
|---|---|---|
| **B1（推荐）** | 后端 `ensure_feature_deps()` 在探测前把 `packages/_parts/<id>` 追加进 `sys.path` 并 `importlib.invalidate_caches()` | 显式、可测；需要 `src/octop` 小改 |
| B2 | deps-core 构建时预创建空的 `_parts/<id>` 目录，`.pth` 启动即命中 | 对 Python 无改动，但空目录可能被打包工具漏掉；仍需与 B1 配合才稳 |
| B3 | 安装完成后重启 Python 子进程（壳 `stopOctop`/`startOctop`） | 最稳但会打断用户会话，只作为兜底 |

**结论**：B1 为主，B2 作为构建期保险；B3 仅在模块已加载/文件锁冲突时提示用户重启。
Windows 上还有一个更硬的限制：如果某可选 part 的 DLL 已被进程加载，
`Extract` 的 `RemoveAll` 会失败（共享冲突）——因此**升级可选 part 时需要
先停服务，或安装到新目录后原子切换**。第一版建议：可选 part 只增不换
（版本随根 part 一起升级，见 §3.4），避免运行中替换。

---

## 5. 进度面板设计（PR-3）

### 5.1 状态机（壳侧）

```text
idle
 └─ checking            读 manifest / launchReady 判定（download.go:39-46）
     ├─ reusable  ─────────────────────────────► launching
     └─ installing
         ├─ downloading(required)  ← bootstrap.Progress（part 加权）
         ├─ verifying              ← fileSHA256（fetch.go:260-271）
         ├─ extracting             ← Extract
         └─ failed(part, code)
              └─ retry(user) ──────────────────► downloading（续传）
     └─ launching             startOctop（process.go:64-92）
         ├─ waitingHealth ────────────────────► ready（导航 dashboard）
         └─ failed(code) ─────────────────────► error（重试 / 查看日志）

ready
 └─ optional(background / on-demand)
     pending → downloading → verifying → extracting → done
                          └─ failed →（不阻塞）→ 下次触发或手动重试
```

`failed` 的 code 复用视频环境已有的白名单风格
（`video_environment.go:38-45`）：`DOWNLOAD_FAILED` / `PACKAGE_INVALID` /
`ENV_DISK_FULL` / `NO_INSTALLER` / `INTERNAL`。壳 UI 只需按 code 选文案。

### 5.2 事件协议：`desktop:progress`

沿用设计文档 §6.2，并补两个字段（`phase` 区分首启与后台）：

```go
type ProgressEvent struct {
	Phase    string  `json:"phase"`    // bootstrap | optional
	Stage    string  `json:"stage"`    // runtime | app | deps-core | <partId>
	PartID   string  `json:"partId"`
	Label    string  `json:"label"`    // 已本地化展示名（壳侧翻译，不依赖后端 i18n）
	Received int64   `json:"received"`
	Total    int64   `json:"total"`
	SpeedBps float64 `json:"speedBps"`
	State    string  `json:"state"`    // pending | active | verifying | extracting | done | failed | skipped
	Error    string  `json:"error,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}
```

- 发出点：`bootstrapRuntime` 的 `Progress` 回调（`download.go:264-269`）
  与新增的可选 part 安装器，统一走 `a.emitProgress(ev)` → `app.Event.Emit("desktop:progress", ev)`。
  与 `setStatus`（`main.go:217-222`）并列，**保留 `desktop:status` 不删**，
  避免已有壳页面与日志断链。
- 事件可能早于页面注册（§2.3），因此 **壳必须缓存最后一次事件**，
  页面加载后主动 `Call("GetProgressSnapshot")` 拉一次，再订阅增量。
  这是对现有「早期状态会丢」问题的顺手修复。
- 后台可选 part 的进度在 dashboard 阶段改为**轮询桥 `status()`**，
  因为嵌入页已被导航替换，`desktop:progress` 只有壳页面能收到。

### 5.3 进度计算

- 首启总量只统计**将要安装的 required part**：`total = Σ part.Size`
  （`Size` 缺失时退回 `Received/Total` 的单片百分比）。
- 聚合方式与视频一致（`video_install.go:167-195`）：按 part 声明大小加权，
  避免「小片完成时从 30% 跳到 60%」。
- 速度：1 秒滑动窗口的 `Δreceived/Δt`，再对 3 个窗口做 EWMA；ETA = 剩余/速度。
- 阶段推进由 shell 控制：开始某 part 前发 `pending`，收到首个进度发 `active`，
  SHA 校验阶段发 `verifying`，解压阶段发 `extracting`，完成后发 `done`。

### 5.4 UI 落点与交互

改 `desktop/src/assets/index.html`（嵌入壳，双语 `copy` 已在中英两份对象里，
`:567-608`，**不引入后端 i18n**）：

1. **loading 卡片**（`:486-505`）
   - 把 `.loading-bar-fill` 从固定 36% 滑动的装饰条改成真实宽度
     `style.width = percent + '%'`；
   - 状态行改为「阶段 + 已下载/总量 + 速度 + 剩余」：
     `正在下载依赖 123 / 246 MB · 1.2 MB/s · 剩余 2:10`；
   - 阶段列表（可选，推荐）：`runtime` / `app` / `deps-core` 三行，
     每行一个状态图标（pending/active/done/failed）。
2. **可选组件行**（required 完成后出现，不阻塞导航）
   - 文案：`浏览器支持（约 50 MB）` + `[立即下载] [稍后]`；
   - 「稍后」= 本会话不再提示，不写任何持久跳过标记（下次仍可手动装）。
3. **失败态**（复用 `.loading.is-error`，`:400-405`）
   - 错误摘要（`errorCode` 映射到文案）+ `[重试]` + `[查看日志]`；
   - `[重试]` 调 `Call("RetryBootstrap")`（新增 Go 方法，重跑 `ensurePortable`）；
   - `[查看日志]` 打开 `navLog` 文件所在目录（`navlog.go`）。
4. **dashboard 阶段**
   - `window.octopDesktopRuntime` 轮询到的后台进度用**可关闭的顶部提示条**呈现
     （不影响用户操作）；失败时降级为静默 + 设置页可见。
   - 若不做 dashboard 改动，最小版本可只在 Windows 托盘气泡提示一次。

### 5.5 失败 / 取消 / 重试语义

| 场景 | 语义 |
|---|---|
| 必需 part 下载/校验/解压失败 | 停在 error 面板，**不导航**；保留 `.part` 与 state，重试即续传 |
| 可选 part 失败 | 主流程照常可用；记录 `failed`，下次触发/手动重试；不自动无限重试 |
| 单镜像失败 | 已有：退避后换镜像（`fetch.go` + `DefaultBackoff`） |
| 用户关闭窗口 | 下载中断；下次启动 `state.json` + Range 续传（`fetch.go:94-190`） |
| 「取消」必需下载 | **不提供**（取消了也用不了）；关闭窗口即退出，重开续传 |
| 「取消」可选下载 | 第一版不提供真正的取消：`bootstrap.Run` 没有 `context`。只提供启动前的「稍后」。若后续必须取消，需给 `Options` 加 `Context`（列入 §6 的 bootstrap 改动） |
| 重试 | 重跑 `ensurePortable` / `RunParts`；已完成 part 走缓存短路（`bootstrap.go:236-246`），不会重复下载 |

---

## 6. 代码改造清单（分阶段，按风险从低到高）

> 标「新增」的文件与 worker B 不重叠；标「改动」的是与 PR-1 的协调点，
> 需要合并顺序上先到先得，**改动均可回滚**。

### PR-3a：真实进度（低风险）

| 文件 | 改动 |
|---|---|
| `desktop/src/progress.go`（新增） | `ProgressEvent` 结构、聚合器（加权/速度/ETA）、最近事件缓存 |
| `desktop/src/download.go`（改动） | `bootstrapRuntime` 的 `Progress` 回调改为发结构化事件（保留原有 `status` 文案） |
| `desktop/src/main.go`（改动） | `emitProgress`、`GetProgressSnapshot`、`RetryBootstrap` |
| `desktop/src/assets/index.html` | 真实进度条、阶段列表、失败重试 |

### PR-3b：可选组件行与 dashboard 提示（低风险）

| 文件 | 改动 |
|---|---|
| `desktop/src/assets/index.html` | 可选组件行 + 「稍后/下载」 |
| `dashboard/src/...`（可选） | 顶部提示条；若不做则用托盘气泡 |

### PR-5a：manifest 元数据（与 PR-1 协调）

| 文件 | 改动 |
|---|---|
| `desktop/src/bootstrap/bootstrap.go`（改动，**需单独评审**） | `Part` 增加 `Feature/Label/Background` |
| `desktop/portable/package-shards.sh`（PR-1） | target 改为 `packages/_parts/<id>`；deps-core 生成 `octop-parts.pth` |

### PR-5b：按需安装入口（低风险，原型已完成）

| 文件 | 改动 |
|---|---|
| `desktop/src/bootstrap/run_parts.go`（**新增，已提交**） | `RunParts(opts, partIDs)` |
| `desktop/src/bootstrap/run_parts_test.go`（**新增，已提交**） | 4 个用例 |
| `desktop/src/runtime_install.go`（新增） | 单飞（mutex）安装器、状态机、manifest 缓存 |
| `desktop/src/video_bridge.go` 或 `runtime_bridge.go`（新增） | 注入 `window.octopDesktopRuntime` |

### PR-5c：壳与后端的契约（需跨范围协调）

| 文件 | 改动 |
|---|---|
| `src/octop/infra/errors.py` | 新增 `FEATURE_DEPS_MISSING`（**src/octop，非本 worker 范围**） |
| `src/octop/i18n/{en,zh}.json` | 对应文案 |
| 各 feature 的 `ensure_*` | import 探测；缺依赖抛上述错误并带 `details.part` |
| `dashboard/src/api/...` | 识别错误码 → 调 runtime 桥 → 重试 |

---

## 7. 原型与验证

已提交（commit `b914dad4`）：

- `desktop/src/bootstrap/run_parts.go`：纯新增，**不改 `Run()`**。
  - 按 ID 选中 part，强制 `Required=true` 以复用 `Run` 的安装循环；
  - 未知 part id 直接报错；
  - 拒绝两个 part 解压到同一 target（把 §2.2 的冲突挡在开发期）；
  - 复用同一 cache/state，已下载分片不重复请求。
- `desktop/src/bootstrap/run_parts_test.go`：4 个用例
  （只装可选片且不破坏根片 / 缓存复用 / 未知 part / 共享 target）。

验证命令与结果：

```text
$ cd desktop/src && gofmt -l bootstrap/ && go vet ./bootstrap/
（无输出）
$ go test ./bootstrap/ -count=1
ok  	octop.desktop/bootstrap	0.029s
```

> 没有改 `download.go`、`main.go`、`bootstrap.go`；原型可独立回滚（删两个文件即可）。

---

## 8. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `Extract` 清空 target（§2.2） | 共享 `packages/` 的 part 互相删除，核心依赖丢失 | PR-1 采用 §3.3 方案 A；`RunParts` 已加同 target 拒绝 |
| 运行中新增模块不可 import（§4.5） | 装完要重启才生效 | 后端 `ensure_*` 追加 `sys.path`；构建期预创建目录；必要时提示重启 |
| Windows 已加载 DLL 无法替换 | 可选 part 升级失败 | 可选 part 只增不换，版本随根 part 整体升级；失败提示重启 |
| 两处并发安装同一 part | state.json 竞争、重复下载 | 壳侧单飞 mutex；跨进程（壳 vs Python pip）用不同 part，避免同包双装 |
| `uv.exe` 拆到可选 part | `runtime_packages` / `self_update` 找不到 uv，退回 pip 可能不存在 | 保持 `uv.exe` 在 core；若拆，必须同步 `runtime_packages.py:42-79` 与 `self_update.py:111-141` |
| 早期事件丢失（§2.3） | 面板停在默认文案 | 壳缓存最近事件 + 页面主动拉快照 |
| 长路径 MAX_PATH | 解压失败 | 沿用设计文档 §5.3：短根目录 + `\\?\` |
| 杀软扫描 | 解压慢、误报 | 解压到 `.new` 再切换；提示加排除项 |
| 磁盘不足 | 解压中途失败 | 安装前预检（runtime+core ≈ 1.2GB，可选片按其 `Size` 追加） |
| manifest 被篡改 | 装到恶意代码 | SHA256 强校验已就绪；manifest 自身 sha256 由 `PORTABLE_RUNTIME_MANIFEST_SHA256` 注入 |

---

## 9. Windows 真机验证清单

> CI 的 `windows-latest` / `windows-11-arm` 能跑构建与单测，但以下必须真机/虚拟机验。

1. **首启进度面板**：全新 Win10/11 → 安装 slim → 打开即见阶段与真实百分比；
   速度/ETA 不为 0；完成后自动进 dashboard。
2. **断点续传**：下载到 50% 杀进程 → 重开 → 从 50% 继续，不重复下载已完成 part。
3. **断网/镜像故障**：拔网线或把首镜像指向 404 → 自动换镜像；全挂 → error 面板
   可重试，且 `.part` 保留。
4. **校验失败**：篡改分片 → `PACKAGE_INVALID` → 不落盘 → 换镜像。
5. **按需安装（飞书）**：全新环境直接新建飞书渠道 → 返回 `FEATURE_DEPS_MISSING`
   → 安装 `deps-feishu` → 重试成功，**无需重启进程**（验证 §4.5 B1）。
6. **按需安装（腾讯云）**：打开云资源页 → 安装 `deps-tencent` → 列表正常。
7. **浏览器**：不装 `deps-browser` 时浏览器功能给出安装引导；装后可用；
   Chromium 仍走 `POST /api/browser/install`，不与 shard 冲突。
8. **可选失败不阻塞**：把 `deps-feishu` 的 URL 全部指向 404 → 主流程可用，
   仅有提示，不出现死循环重试。
9. **长路径**：安装到默认 `%LOCALAPPDATA%\Octop\portable`（短路径）与一个故意很深的
   自定义路径，确认 `_parts/` 下的嵌套包能解压。
10. **升级**：旧版本运行中 → 新版本启动 → DB 备份成功 → 根 part 替换后
    可选 part 状态归零，再次触发可重装；旧版本仍可回退启动。
11. **杀软**：Defender 实时防护开启下完整安装 + 两个可选 part，记录耗时与误报。
12. **非管理员账户**：确认全程不写 `Program Files`（除安装器本身）。

---

## 10. 需人类决策

1. **PR-1 的 target 方案选 A 还是 B**（§3.3）。推荐 A；若 PR-1 已按「共享
   `packages/`」开工，必须先回退该约定，否则会静默删依赖。
2. **OCR / embedding 是否也走分片**（§4.1）。推荐第一版仍走
   `runtime_packages`，只对 browser/feishu/tencent 启用分片。
3. **是否新增 `FEATURE_DEPS_MISSING` 错误码**，还是复用现有
   `*_DEPS_FAILED` + `details.part`。新增更清晰，但要动 `src/octop` 与 i18n。
4. **dashboard 阶段的可选进度呈现**：顶部提示条（要改 dashboard）还是仅托盘气泡
   （只改壳）。
5. **可选 part 是否需要真正的取消**（要给 `bootstrap.Options` 加 `context`）。
6. **`uv.exe` 是否随 PR-0 拆出 core**（影响两处查找逻辑，§8）。
