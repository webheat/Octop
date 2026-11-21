# Gitee 发布通道

> Gitee 单个 Release 附件上限 **100 MB**。Octop 的完整客户端安装器是 **200–340 MB**，
> 直接传不上去。这条通道发的是 **slim 客户端**（~20 MB），运行时在首次启动时下载。

---

## 一、为什么需要 slim 客户端

实测体积（linux x86_64，`.venv` 与 `uv export --frozen --no-dev` 的生产依赖为准）：

| 组成 | 压缩后 | 口径 |
|---|---|---|
| 桌面壳（Go + Wails，`-w -s -trimpath`） | **12–18 MB** | `go build` 实测 |
| 便携 CPython（PBS 3.12.12） | 32 MB | `install_only_stripped` |
| 生产依赖 site-packages | 162 MB | 装完 674 MB |
| octop wheel（含 dashboard） | ~20 MB | |
| **完整 portable zip** | **~290 MB** | 本机实测 280 MB（linux-amd64） |

依赖里最大的几项（压缩后）：`playwright` 45 MB、`numpy` 15 MB、
`google-api-python-client` 14 MB、`botocore` 13 MB。这些都是
`octop-harness[all]` / `langchain-aws` / `openai` 拉进来的硬依赖，**砍依赖压不到
100 MB**（全砍光也还剩 ~125 MB，而且会废掉本地浏览器、S3 存储、embedding）。

所以路线是**换分发方式，不换内容**：安装器只带壳，运行时首启下载。

> 仓库里其实有两种"小客户端"，都 < 100 MB，语义不同：
>
> | 变体 | 产出方式 | 行为 |
> |---|---|---|
> | **远程版**（thin） | `wails3 task package`（默认，`DEFAULT_SERVER_URL` 有值） | 连接已部署的 Octop 服务，本地不装运行时 |
> | **本地版**（slim） | `wails3 task package PORTABLE_RUNTIME_URL=…` | 本地跑完整运行时，首次启动下载 |
>
> 两者都进 Gitee；**远程版不需要联网下载运行时**，本地版才需要。

```
┌─ 安装（~20 MB）────────────────────────────┐
│  Octop-desktop-slim-<plat>-<ver>.<ext>      │
│  NSIS stub + Octop.exe（不内嵌 portable）    │
│  运行时 URL 编译期写进二进制                  │
└────────────────────────────────────────────┘
                    │ 首次启动
                    ▼
┌─ 壳自举 ───────────────────────────────────┐
│  1. 从 GitHub Release 下载 portable zip      │
│     （~290 MB，运行时放不进 Gitee 附件）    │
│  2. 解包到 <portable>.new → 原子换名         │
│  3. 拉起 Octop 服务 → 健康检查 → 打开面板    │
└────────────────────────────────────────────┘
```

已落地范围见 [desktop-bootstrap-installer.md](desktop-bootstrap-installer.md#零已实现范围第一阶段)。
分片、断点续传、sha256 校验、可选组件后台补齐仍未做。

## 二、发布内容

Gitee Release 附件（都 < 100 MB）：

| 附件 | 体积 | 说明 |
|---|---|---|
| `Octop-desktop-<plat>-<ver>.<ext>` | ~6 MB | 远程版客户端，连接已部署的服务 |
| `Octop-video-components-<plat>-<ver>.<ext>` | ~71 MB | 视频制作组件，远程版客户端出片必装 |

**本轮只出 Windows 版**（amd64 / arm64）。macOS 与 Linux 的客户端本轮不构建、
不发布——构建说明见 [desktop-windows-build.md](desktop-windows-build.md)。

**不在 Gitee 分发**：

- `Octop-desktop-slim-...`（本地版客户端，首次启动要另外下载运行时）——
  Gitee 这边只服务"远程版读者"，下载页与 Release 说明都不提供它
- `octop-*.whl` / `octop-*.tar.gz`（Python 包）—— 走 PyPI
- 内嵌运行时的完整桌面安装器、portable 运行时、fnOS native 包（超限）——
  留在 GitHub Release，Release 说明里给外链

> 附件的取舍规则只有一处实现：`scripts/gitee/assets.py`。CI 与本地手工发布
> 都调同一套脚本（`scripts/gitee/publish_from_github.sh`），所以两边不会选出
> 不同的附件。改规则只改那一个文件。

## 三、前置条件

### 1. Gitee 仓库

> **最新口径（2026-11-21，以此为准）**：客户端构建产物**直接发布到本仓库**的
> Release 附件。渠道矩阵见 [RELEASE-MATRIX.md §3](./RELEASE-MATRIX.md#3-分发渠道)。
> 下文「从 GitHub Release 拉取附件」是既有的 CI 中转实现描述；渠道归属以本条为准。

发布目标：**`https://gitee.com/webheat/octop_client.git`**（`owner=webheat`，
`repo=octop_client`），公开仓库。

**公开分发要求仓库是公开的**：私有仓库的 Release 页面需要登录、附件需要带 token
才能下载，不构成公开分发。若想保留代码私有，可以另建一个公开仓库只放 Release 产物。

**本仓库是"下载页"仓库，不放源码**：

```
octop_client/                ← Gitee：只有 README.md / README.en.md（下载页）
  README.md                  ← 内容源在 scripts/gitee/REPO_README.md
  README.en.md               ← 内容源在 scripts/gitee/REPO_README.en.md
  (tag → 下载页所在的 commit)  ← Release 页挂在这里
```

源码继续只在 GitHub / CNB，不引入第三条镜像线（否则每次发版都要多推一次，
否则 Gitee 上的代码会落后）。下载页里的下载链接指向 Releases 页面，源码链接指向
GitHub / CNB。

下载页由 `scripts/gitee/push_readme.py` 通过 Gitee contents API 写入（CI 里不需要
SSH 密钥）。内容是**按本次发布渲染的模板**（见上面"分步执行"下面的说明），
**内容没变就不产生新 commit**；Release 的 tag 指向下载页所在的 commit，
所以 Release 页面看到的是一份可读的下载页，而不是一个无关的初始提交。

### 2. 仓库 Secrets

| Secret | 说明 |
|---|---|
| `GITEE_TOKEN` | Gitee Personal Access Token，需要 `projects` 权限，且能访问 `webheat/octop_client`（仓库公开时仍然需要 token 才能调 API 建 Release） |
| `GH_PAT` | 读取**别的** GitHub 仓库的 Release 资产时需要；资产来自本仓库时用自带的 `GITHUB_TOKEN` 即可 |

本机手工发版时，token 可以放在 `~/.gitee_token`（`chmod 600`），脚本的读取顺序是
`--token` → `$GITEE_TOKEN` → `~/.gitee_token`。

### 3. 运行时必须先发布到 GitHub Release

slim 安装器里的运行时 URL 指向 GitHub Release 上的
`Octop-portable-<plat>-<ver>.zip`。**先跑桌面发版把 portable zip 传上去，
再发 Gitee**，否则用户首次启动会 404（客户端会重试，但体验不好）。

> 为什么不放 Gitee：运行时 ~290 MB，超过 Gitee 单附件 100 MB 上限。
> 也不走 CDN/对象存储：多一条链路就多一份运维成本，先用 GitHub Release 单源跑通。

## 四、发版步骤

```bash
# 1. 先按 .cursor/skills/publish/SKILL.md 发桌面版
#    （产出 GitHub Release：portable zip + slim 安装器 + 完整安装器）

# 2. 发 Gitee：Actions → Gitee Release → Run workflow
#    tag          = v1.4.0
#    source_repo  = 留空（本仓库）或填 owner/repo
#    gitee_owner  = Gitee 用户名或组织
#    gitee_repo   = Gitee 仓库名
```

工作流做四件事：

1. 从 GitHub Release 拉取**体积小于 100 MB 且属于本轮平台**（默认 Windows）的附件；
2. 用 GitHub Release 的正文生成 Gitee Release 说明（`scripts/gitee/release_notes.py`），
   追加"Gitee 上的安装包"和"完整安装包（外链）"两节；
3. 把下载页推到 Gitee 仓库（`scripts/gitee/push_readme.py`），拿到它所在 commit；
4. 调 Gitee API 建 Release 并逐个上传附件
   （`scripts/gitee/publish_release.sh`，tag 指向第 3 步的 commit，
   超过 100 MB 的自动跳过并列出）。

### 手工执行

一键走完（拉资产 → 生成说明 → 同步下载页 → 建 Release 上传）：

```bash
export GITEE_TOKEN=...
bash scripts/gitee/publish_from_github.sh \
  --tag v1.4.0-gitee.1 \
  --source-repo zhuimeng2026-hub/Octop \
  --owner webheat --repo octop_client \
  --platform windows     # 默认就是 windows；--platform all 可发全平台
```

分步执行：

```bash
export GITEE_TOKEN=...

# 1. 同步下载页，拿到 commit
sha="$(python3 scripts/gitee/push_readme.py \
  --owner webheat --repo octop_client --tag v1.4.0-gitee.1 --token "$GITEE_TOKEN")"

# 2. 建 Release 并上传
scripts/gitee/publish_release.sh \
  --tag v1.4.0-gitee.1 --owner webheat --repo octop_client --token "$GITEE_TOKEN" \
  --assets-dir release-assets --body-file release-notes.md \
  --base-sha "$sha"
```

> **下载页是模板，必须传 `--tag`。** `REPO_README*.md` 里的下载链接写成
> `{{TAG}}` / `{{VERSION}}` / `{{OWNER}}` / `{{REPO}}` / `{{GITEE_WEB}}` 占位符，
> 由 `push_readme.py` 按本次发布渲染。渲染后如果页面里还出现**别的** tag 或版本号，
> 脚本直接中止并点名是哪一个 —— 否则新 Release 的页面会安静地指向旧安装器，
> 而因为内容与线上完全一致，连一次提交都不会产生，根本看不出来。

## 五、限制与注意事项

- **Gitee 附件 100 MB 是硬限制**，脚本按 `--max-size-mb`（默认 100）过滤，
  超限的只列出不传。
- **Gitee API 的三个怪癖**（实测，脚本已按此实现）：
  - 没有 `git/refs` 读端点（返回 404 HTML）；查分支用 `branches/{name}`，
    查标签用 `tags` 列表。
  - `GET /releases/tags/{tag}` 在**标签存在但还没有 Release** 时返回
    **200 + `null`**，不能只看状态码判断 Release 是否已存在。
  - 建 Release 时 Gitee **会连带把 tag 建出来**（`target_commitish` 指向已有
    commit 即可），不需要单独调建引用的接口。
- **fork 的 GitHub Actions 只有 `workflow_dispatch` 能触发**（push / schedule 不触发），
  所以桌面发版也得手动 dispatch。
- **slim 客户端首次启动必须联网**。离线场景请用完整 portable zip 或
  Docker 镜像。
- **运行时 URL 里的版本是编译期写死的**：装上 slim 客户端后升级到新版本，
  需要装新版 slim 客户端才会拉新的运行时；运行时本身也会按 URL 里的版本号
  判断是否需要刷新。

## 六、相关文件

| 主题 | 位置 |
|---|---|
| Gitee 发布工作流 | `.github/workflows/gitee-release.yml` |
| 一键发布（从 GitHub Release 到 Gitee） | `scripts/gitee/publish_from_github.sh` |
| 发布脚本 | `scripts/gitee/publish_release.sh` |
| Release 说明生成 | `scripts/gitee/release_notes.py` |
| 附件筛选规则（大小 + 平台） | `scripts/gitee/assets.py` |
| 附件清单 | `scripts/gitee/list_release_assets.py` |
| 下载页推送 | `scripts/gitee/push_readme.py` |
| 下载页内容源 | `scripts/gitee/REPO_README.md`、`scripts/gitee/REPO_README.en.md` |
| slim 客户端构建（本轮只 Windows） | `desktop/src/build/windows/Taskfile.yml` 的 `package:slim` |
| slim 产出的 CI 步骤 | `.github/workflows/octop-desktop.yml` |
| 运行时下载实现 | `desktop/src/bootstrap/`（续传、校验、manifest），入口 `desktop/src/download.go`（`bootstrapRuntime`） |
| 方案设计稿 | `docs/desktop-bootstrap-installer.md` |
