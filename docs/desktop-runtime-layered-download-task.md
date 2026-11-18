# 任务书：桌面运行时「分层下载」改造（核心包 + 按需环境包）

> 状态：**PR-0 / PR-1 已实施并合入 `develop`**（2026-11-19）；PR-3 / PR-5 为设计 + 原型，
> 仍待落地。交付报告见 `docs/desktop-runtime-layered-download-report-pr0.md` /
> `-pr1.md` / `-pr35.md`，PR-3·PR-5 设计见 `docs/desktop-runtime-layered-download-pr3-pr5.md`。
> 目标读者：接手的 LLM / 开发
> 关联设计：`docs/desktop-bootstrap-installer.md`（**方案与路线图的权威文档，本文不重复设计，只固化可执行待办与代码证据**）
> 触发背景：slim 客户端首启下载 246MB 全量 Python 运行时包（`Octop-portable-windows-amd64-1.4.0.zip`），用户希望改为「核心包 + 按需环境包」分层下载。

---

## 0. 一句话结论（先读）

**下载器不用开发，瓶颈全在「制品侧」和「依赖定义侧」。**

- 客户端 `bootstrap` 下载器**已 100% 支持多分片 / 断点续传 / SHA256 / 多镜像**，且已在视频组件上生产验证（`core.zip` + `browser.zip` + manifest）。
- 纯把整包切成多片**不减总下载量**；真正减体积要先做依赖瘦身（PR-0）。
- 最大的几项冗余（googleapiclient / boto3）来自外部包 `octop-harness[all]`，**本仓库改不掉**，需 harness 侧发版——这是体积下降的天花板，务必有心理预期。

---

## 1. 现状实测（2026-11-18）

| 项 | 实测值 | 证据 |
|---|---|---|
| 运行时 zip | 246,105,871 字节（≈246MB），207 个 `*.dist-info` | `desktop/portable/release/Octop-portable-windows-amd64-1.4.0.zip` |
| `uv.lock` | 256 个 `[[package]]` | `uv.lock` |
| zip 内体积 Top | playwright 36MB、octop 24MB、`bin/` 18MB、tencentcloud 17.7MB、googleapiclient 14.8MB、botocore 13MB、PIL 6.8MB、numpy.libs 6.4MB | 对 zip 的只读解析 |

**zip 里体积最大的几项**（按可裁剪性排序）：

| 依赖 | 大小 | import 情况 | 能否移出 core |
|---|---|---|---|
| `playwright` | 36MB | 唯一直接 `import playwright` 在 `src/octop/api/routers/browser/env.py:81`，函数内 try/except，惰性；Chromium 本体**本就不在 zip 里**（走 `POST /browser/install` 按需下） | ✅ 最优候选，几乎零改动 |
| `tencentcloud-sdk-python` | 17.7MB | `src/octop/infra/cloud/tencent.py:31-38` **模块级 import**；`api/routers/cloud.py:13` 顶层引用；`api/app.py:292` 注册路由 | ⚠️ 需先改 `tencent.py:31-38` 为函数内惰性 import |
| `uv.exe` | 38MB | 非 Python import；`infra/utils/runtime_packages.py:49`、`infra/setup/self_update.py:115-141` 以 subprocess 调用（在线升级 / 按需装包） | ❌ 不能删；可从首启包拆到可选 part（要同步改查找路径） |
| `googleapiclient` | 14.8MB | `src/octop` 中 **0 处 import**；来自 `octop-harness[all]` 传递依赖（`uv.lock:2825-2836`） | ❌ 本仓库改不了，需 harness 出 `[base]` extra |
| `boto3`/`botocore` | 13MB | `pyproject.toml:39` 直接依赖，`src/octop` 中 0 处 import；同属 harness[all] AWS 链 | ❌ 同上，需 harness 侧处理 |
| `lark-oapi` | 5MB | `infra/gateway/bot_creators/feishu_bot_creator.py:34-35`（飞书渠道专用）；`octop-gateway` 硬依赖 | ⚠️ 需 gateway 同步改造 |

---

## 2. 已有能力（不要重复造）

### 2.1 下载器已就绪
- `desktop/src/bootstrap/bootstrap.go`
  - `:20-39` `Part` 字段：`ID / URLs / Size / SHA256 / Format / Target / StripRoot / Required`
  - `:41-46` `Manifest{Version, Platform, Parts}`
  - `:111-168` `Run()`：遍历 parts，`!Required` 跳过（`:159-162`）
  - `:170-197` `validateParts()`：**只允许一个根 part**（`Target==""`）；非 merge 模式根 part 不能与其它 part 共存（`:190-195`）
  - `:213-277` 断点续传 + 缓存复用 + SHA256 + state
- `desktop/src/bootstrap/manifest.go:19-39` `LoadManifest`（多 URL failover）
- `desktop/src/bootstrap/fetch.go:94-190` HTTP Range 续传；`:259-271` SHA256
- `desktop/src/download.go:279-297` `runtimeParts()`：**有 manifest 就原样返回 `manifest.Parts`**，支持多 part

### 2.2 视频组件是现成分片范例（照抄它）
- 构建：`scripts/pack_video_components.py` → `core.zip` + `browser.zip` + `manifest.json`
- 发布：`scripts/release-video-components.sh:194-234`（打包 + sha256/size 校验）`:236-315`（多盘上传 + 逐台校验）
- 客户端下载：`desktop/src/video_install.go:127-234`，关键在 `:197-207` 的 `bootstrap.Run(bootstrap.Options{..., Merge: true})`

### 2.3 浏览器环境已是按需下载
- `src/octop/api/routers/browser/env.py:128-189` `POST /api/browser/install` → 委托 `octop_browser.install_chromium_stream()`（外部包）
- `src/octop/infra/control/browser/setup.py:367-418` Playwright Chromium 检测

### 2.4 其它按需装包机制（非独立 zip，同类）
- `src/octop/infra/utils/runtime_packages.py`（`uv/pip` 运行时装包），调用方：`onnx_service.py`、`knowledge/ocr.py`、`backend/opensandbox_deps.py`、`backend/tos_backend.py`

---

## 3. 待办（按路线图顺序，收益/风险比从高到低）

> 路线图原文见 `docs/desktop-bootstrap-installer.md:543-554`。PR-2、PR-4 已完成；**缺的是 PR-0 和 PR-1**。

### PR-0：依赖瘦身（最小改动、最大直接收益，不改 Go 代码）

1. **`playwright`（36MB）**：`pyproject.toml:41` 从 `[project] dependencies` 移到 `browser` extra（`:75-77` 已存在）。import 侧已全部惰性（`env.py:81` 的 try/except 保留即可）。Chromium 下载走 `POST /browser/install`，完全解耦。
2. **`tencentcloud-sdk-python`（17.7MB）**：先把 `src/octop/infra/cloud/tencent.py:31-38` 的 8 行模块级 import 改成函数内惰性（注意 `api/routers/cloud.py:13` 顶层引用也要处理，或确认它只 import 模块不 import 符号），再建新 extra。
3. **同步 `uv.lock`**：`package.sh:107` 用 `uv export --frozen`，要求 lock 与 pyproject 一致，改完必须重跑 `uv lock`。
4. **验证**：重打 zip，确认体积下降、素材库/核心后端功能不回归。
   - 仅 1+2 预计把 zip 从 ~246MB 降到 ~190MB。

### PR-0b：跨仓库（harness 侧，单独立项）
- `octop-harness` 提供 `[base]` extra（收窄 `google-api-python-client`/`boto3`），本仓库 pin 到该 extra 并升版本。
- `octop-gateway` 解掉对 `lark-oapi` 的硬依赖（若要裁它）。
- **这是减重天花板**，本仓库无法独立完成，不要在这里死磕。

### PR-1：分片制品（复用视频组件范式）

1. 新增 `desktop/portable/package-shards.sh`（或参考 `scripts/pack_video_components.py` 写 `pack_portable_runtime.py`），把 `package.sh:261-285` 的单 zip 改为多 part + manifest：
   - `runtime`（`runtime/`，required）
   - `app`（`packages/octop/`，required）
   - `deps-core`（`packages/`，required，其余）
   - 可选 part（tencent / google / boto / lark 等，`required:false`）
   - 各 part 用 `target` 指向同一 `packages/` 子路径 —— `desktop/portable/templates/launch.py:30-41` 用 `site.addsitedir(packages)`，只要最终落到 `packages/` 就能加载。
2. **必改一行 Go**：`desktop/src/download.go:259-271` 的 `bootstrap.Options` 加 `Merge: true`（对齐 `video_install.go:202`），并保证根 part 在 manifest 第一位（约束见 `bootstrap.go:182-195`）。
   - ⚠️ 这是当前运行时下载路径**唯一必须改的 Go 代码**。
   - 顺带：`download.go:262` 构造 manifest 时未传 `Platform`，运行时下载不做平台校验（视频组件在 `video_install.go:150-155` 做了），建议补上。
3. CI 新 job 产出分片（**先不发布、不引用**）。
4. 通过 `PORTABLE_RUNTIME_MANIFEST_URL` / `PORTABLE_RUNTIME_MANIFEST_SHA256` 注入（`Taskfile.yml:60-61` 已支持）。

### PR-3 / PR-5：进度面板 / 可选组件后台补齐
- `bootstrap.Run()` 当前对 `required:false` 的 part **直接跳过**（`bootstrap.go:159-162`），没有后台补装机制。
- 要实现真正"按需环境包"，需新增触发点（用户进入某功能时）复用 `bootstrap.Run()` 或 `runtime_packages.install_packages()`。
- 壳 UI 进度面板见 `docs/desktop-bootstrap-installer.md:418-457`、`:332-417`。

---

## 4. 不推荐 / 避坑

- ❌ **只拆 manifest 不瘦身**：总下载量不变，收益减半。设计文档 `:537-539` 明确。
- ❌ **只瘦身不拆 part**：能减体积，但拿不到断点续传 / 多镜像 / 校验 / 按功能补装的分层收益。
- ❌ **打包时残留 `desktop/src/bundled/portable.zip`**：会让 `go build` 走 full 内嵌路径（产出 259MB exe，而非 6MB slim）。打 slim 前必须删掉它（`package:slim` 任务结尾本会删，中途取消会残留）。
- ❌ **误以为 Gitee 100MB 限制约束运行时**：100MB 只约束 Gitee 附件（slim exe 6MB + 视频组件 74MB 都合规）；246MB 运行时 zip 放 GitHub Release，不受此限。
- ⚠️ **本机工具链**：`make` / `uv` 都可用；npm 用 `--registry=https://registry.npmmirror.com`；`makensis` PATH 里是 2.51（不认 `/INPUTCHARSET`），必须显式传 Tauri 3.11：`C:/Users/huawei/AppData/Local/tauri/NSIS/makensis.exe`。

---

## 5. 验收标准

- [ ] slim 首启下载体积显著下降（目标：246MB → ≤190MB，PR-0 后；进一步下降依赖 PR-0b）
- [ ] manifest 多 part 下载成功，断点续传 / SHA256 / 多镜像 fallback 均工作
- [ ] 可选 part（如 tencentcloud）在用户触发相关功能时才下载（PR-5）
- [ ] 素材库 / 浏览器 / 视频等核心功能无回归
- [ ] 真 Windows 上验证（CI 有 `windows-latest`，但 Windows 路径 / 长路径问题必须真机验，见设计文档 `:556`）

---

## 6. 关键代码位置速查

| 用途 | 路径 |
|---|---|
| 设计权威文档 | `docs/desktop-bootstrap-installer.md` |
| 依赖定义 | `pyproject.toml:13-57`（core）、`:59-89`（extras） |
| 运行时打包 | `desktop/portable/package.sh`、`_common.sh` |
| 锁文件 | `uv.lock` |
| slim 下载入口 | `desktop/src/download.go:251-311` |
| 下载器核心 | `desktop/src/bootstrap/bootstrap.go` |
| 分片范例（构建） | `scripts/pack_video_components.py` |
| 分片范例（发布） | `scripts/release-video-components.sh` |
| 分片范例（客户端） | `desktop/src/video_install.go:127-234` |
| NSIS 打包任务 | `desktop/src/build/windows/Taskfile.yml:48-78`（package:slim） |
| 落地模板 | `desktop/portable/templates/launch.py:30-41` |
