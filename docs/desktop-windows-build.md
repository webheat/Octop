# Windows 桌面客户端构建说明

> 面向在 Windows 机器上出包的机器。本文档覆盖三种变体、完整命令、验证清单和常见坑。
>
> 背景：Gitee 单个 Release 附件上限 **100 MB**，完整客户端安装器是 200–340 MB
> （内嵌 Python 运行时），直接传不上去。Windows 侧要出的是 **< 100 MB** 的变体。
>
> **本轮范围：只做 Windows**（amd64 / arm64）。macOS 与 Linux 客户端本轮不构建、
> 不发布。

---

## 一、三种变体，先选对

| 变体 | 命令里给什么 | 安装器体积 | 行为 | 适合 Gitee |
|---|---|---|---|---|
| **远程版**（thin） | 什么都不给（默认） | ~18 MB | 连已部署的 Octop 服务，本机不装运行时 | ✅ |
| **本地版**（slim） | `PORTABLE_RUNTIME_URL=<地址>` | ~20 MB | 本机跑完整运行时，**首启**下载 ~290 MB 运行时 | ✅ |
| 完整版（full） | `DEFAULT_SERVER_URL=`（置空） | ~300 MB | 本机跑完整运行时，离线包 | ❌ 超 100 MB |

> 默认是远程版：`desktop/src/Taskfile.yml` 里全局 `DEFAULT_SERVER_URL` 默认指向
> `https://ocbot.aixifs.com/videogen`。要出本地版就传 `PORTABLE_RUNTIME_URL`，
> 它会自动盖掉远程地址（否则壳会直接连远程服务，运行时永远不会被下载）。

**选哪个**：绝大多数用户装完即用、要能连你的服务 → **远程版**（最省事，18MB）。
要给"自己本地跑一套"的用户 → **本地版**（首启要联网）。

---

## 一之二、本轮要交付的产物

| # | 产物 | 大小 | 传到哪 |
|---|---|---|---|
| 1 | `Octop-portable-windows-amd64-1.4.0.zip` | ~290 MB | GitHub Release（运行时下载源） |
| 2 | `Octop-portable-windows-arm64-1.4.0.zip` | ~290 MB | GitHub Release |
| 3 | `Octop-desktop-slim-windows-amd64-1.4.0.exe` | ~20 MB | Gitee Release |
| 4 | `Octop-desktop-slim-windows-arm64-1.4.0.exe` | ~20 MB | Gitee Release |
| 5 | `Octop-desktop-windows-amd64-1.4.0.exe`（远程版，可选） | ~18 MB | Gitee Release |
| 6 | `octop-1.4.0-py3-none-any.whl` / `octop-1.4.0.tar.gz` | ~22 / ~21 MB | Gitee Release |

**顺序**：先把 1、2 传到 GitHub Release（运行时必须先在），再用它们的 URL 打 3、4。

---

## 二、机器准备

| 依赖 | 版本 | Windows 上的装法 |
|---|---|---|
| Git Bash | 任意近期版本 | 装 Git for Windows 时勾选（脚本是 bash 写的） |
| Go | **1.25+** | https://go.dev/dl/ |
| Wails v3 CLI | **v3.0.0-beta.13**（必须一致） | `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.13` |
| NSIS（makensis） | 3.x | `choco install nsis`，或 https://nsis.sourceforge.io/ |
| Node.js | 20 或 24 | https://nodejs.org/（脚本会自动尝试 `nvm use 24`） |
| uv | 任意 | https://docs.astral.sh/uv/ |

Windows 走 WebView2，**不需要** GTK / WebKit（那是 Linux/macOS 的事）。

自检：

```bash
go version
wails3 version          # 应为 v3.0.0-beta.13
makensis -VERSION       # 应有版本号
node -v
uv --version
```

---

## 三、构建

### 3.1 拉代码

```bash
git clone git@github.com:zhuimeng2026-hub/Octop.git
cd Octop
git checkout feat/desktop-slim-installer     # 或合并后的 develop / main
```

### 3.2 构建前端（必须，不能跳）

desktop 客户端的界面来自 dashboard，它被打进 octop wheel 里。**不构建前端就会得到一个
首屏白屏的客户端**。

```bash
make build-frontend
# 等价于：cd dashboard && npm ci && npm run build
# 产物落在 src/octop/dashboard/（该目录被 gitignore，是构建产物）
```

> 国内网络建议先设镜像：`npm config set registry https://registry.npmmirror.com`

### 3.3 构建 portable 运行时（只有本地版 slim 需要）

slim 客户端首启时要下载的就是这个 zip。**它必须在 Windows 上构建**——跨平台交叉组装
会失败（`aliyun-python-sdk-core` 只有源码包，没有 Windows wheel）：

```bash
bash desktop/portable/bootstrap-runtime.sh windows-amd64   # 下载便携 CPython
bash desktop/portable/package.sh windows-amd64              # 装依赖 + 打包
# 产物：desktop/portable/release/Octop-portable-windows-amd64-1.4.0.zip  (~290 MB)
```

ARM64 版同理，把平台换成 `windows-arm64`。

> 依赖源慢时可以走镜像：`PBS_BASE_URL=https://registry.npmmirror.com/-/binary/python-build-standalone/20251209`

### 3.4 打安装包

**远程版（thin，默认）：**

```bash
cd desktop/src
wails3 task package ARCH=amd64 VERSION=1.4.0
# 产物：desktop/src/bin/Octop-desktop-windows-amd64-1.4.0.exe   (~6 MB)
```

**本地版（slim）：**

```bash
cd desktop/src
wails3 task package \
  ARCH=amd64 \
  VERSION=1.4.0 \
  PORTABLE_RUNTIME_URL="https://github.com/zhuimeng2026-hub/Octop/releases/download/v1.4.0-gitee.1/Octop-portable-windows-amd64-1.4.0.zip"
# 产物：desktop/src/bin/Octop-desktop-slim-windows-amd64-1.4.0.exe   (~6 MB)
```

ARM64：`ARCH=arm64`，其余不变。**arm64 只能出远程版**——`psycopg-binary` 与
`cryptography` 官方都没有 `win_arm64` wheel，portable 的 `packages/` 装不出来。

### 3.5 打视频组件安装包（两种客户端都要）

客户端**不带**视频渲染环境。不装组件，登录、产品库、方案编辑都正常，只是不能在本机出片。
组件复用已有的 `desktop/src/video-runtime/`（含 node.exe、node_modules、worker）：

```bash
cd desktop/src
wails3 task windows:components:installer VERSION=1.4.0 \
  MAKENSIS="C:\Users\huawei\AppData\Local\tauri\NSIS\makensis.exe"
# 产物：desktop/src/bin/Octop-video-components-windows-x64-1.4.0.exe  (~72 MB)
```

需要从零重建 runtime 时才用 `windows:components:package`（它会跑
`remotion/build-desktop-runtime.mjs`，要联网拉 Node 与 headless shell，慢很多）。

打客户端时把组件 **manifest.json** 地址编译进去，界面才会出现「下载视频环境」按钮并执行安装：

```bash
wails3 task package ARCH=amd64 VERSION=1.4.0 \
  VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
```

> ⚠️ **2026-11-20 修正（曾导致「构建进去却报 NO_INSTALLER」）**：这里必须是
> `bootstrap.LoadManifest` 能解析的 **manifest.json URL**，不是 NSIS 安装包 `.exe` 链接。
> 旧文档里的 `Octop-video-components-*.exe` 直链是早期单文件安装器格式，代码已改为
> `manifest.json` + `parts[]` 分片下载（带断点续传与 SHA256），填 `.exe` 会解析失败。
> manifest URL **支持逗号分隔多节点**（主 + 镜像容灾），取不到时 `environment_install`
> 返回 `NO_INSTALLER`。线上可用地址见 `scripts/release-video-components.sh` 输出。

> ★ **2026-11-20 实测：manifest URL 必须烘焙多节点**。`dw.mengxa.com` 的 DNS 轮询到
> 四个 IP，各节点的 TLS/站点配置**并不一致**（实测复核结论）：
>
> | IP | HTTPS | HTTP | 说明 |
> |---|---|---|---|
> | `1.14.182.208` | ✅ 200（`CN=dw.mengxa.com`，Let's Encrypt YE1） | ✅ 206 | 正常节点，≈649 KB/s |
> | `175.178.33.107` | ✅ 200（同上，证书一致） | **301 → HTTPS** | HTTPS ≈287 KB/s；**HTTP 端口只做跳转，不直接供文件** |
> | `175.178.192.87` | ❌ SNI 不匹配（`tlsv1 unrecognized name`） | ✅ 206 | **只服务 HTTP**，nginx 没有 `dw.mengxa.com` 的 server 块，≈696 KB/s |
> | `8.134.147.195` | ❌ 证书为 `CN=ymxt.top` 且 2026-07-29 已过期 | 403 | **故意挂的故障节点**（验证容灾）：返回别的站点的过期证书 + 拦截页，客户端应探测并跳过 |
>
> ⚠️ **`175.178.33.107` 的 HTTP 端口只返回 301 跳转到 HTTPS**，不直接提供文件。
> 探测若跟随重定向就会把它误判为「HTTP 健康节点」—— 所以**探测不跟随重定向**，
> 3xx 直接算该节点在此 scheme 下不可用。
>
> ✅ **`8.134.147.195` 是故意挂进去的故障节点** —— 用来验证「某个节点失效时下载仍然有效」。
> 它返回 `ymxt.top` 的过期证书（HTTPS 握手失败）和 403 拦截页（HTTP），正是客户端
> 逐 IP 探测要排除的那种情况。**不要把它从 DNS 里摘掉**，摘了这套容灾验证就没了。
> 客户端的探测会识别并跳过它，下载照常走另外的节点。
>
> 同理，`http://dw.mengxa.com` 走默认 DNS 轮询有时会命中它、拿到 403 —— 这也是
> 预期行为：客户端的探测会逐 IP 找出真正供文件的节点，不依赖 DNS 碰运气。
>
> 客户端的 `componentsDownloadClient` 会逐 IP 探测并自动避开坏节点，所以只要 URL 列表里
> 含有可达节点即可。**推荐烘焙双 scheme（同域名）**：
> ```bash
> VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
> ```
>
> **探测按 (host, scheme) 分别进行**：只探 HTTPS 会把「只服务 HTTP」的好节点误判为死节点，
> 白丢一半带宽；客户端因此按 `host|scheme` 分组探测，并**按端口维护可用节点列表** ——
> HTTP-only 的节点不会被派给 :443 连接（它的 TLS 从未验证过）。
>
> **part 下载会并行开多个 Range 连接**（默认 4 路，见 `videoComponentConnections`），
> 连接轮询分配到不同的可达 IP，**各个分片轮流使用 part 的不同镜像**（两个镜像往往是两台不同的机器，
> 一台机器会把单连接限速在几百 KB/s）。实测总带宽从单连接的 ≈620 KB/s 提升到 ≈1.35 MB/s（**2.2 倍**）。
> manifest 里的 `connections` 字段可覆盖默认连接数（由 `pack_video_components.py --connections` 写入）。
>
> **两个容易踩的分配问题**（已修，勿回退）：
> - 节点轮询的计数器**必须按 host+port 隔离**。HTTPS 与 plain-HTTP 是两个连接池，
>   共用一个计数器会让两池互相抢槽位，最快的节点可能一次都没被选中。
> - **每个分片都要能回退到其它镜像**。镜像容灾不能只在单连接路径上生效 ——
>   一个节点挂掉不该拖垮整个 part。
>
> 实测（4 路并发拉 16MB）：全 HTTPS（2 台机器）≈1.10 MB/s；
> 2 路 HTTPS + 2 路 HTTP（3 台机器）≈1.66~1.96 MB/s；6 路反而更慢。
> **4 路是当前链路的上限**，且链路带宽本身在 0.5~2 MB/s 间波动。

### 3.5.1 已发布状态（2026-11-20 18:00）

| 项 | 值 |
|---|---|
| 组件目录 | `/opt/dw.mengxa.com/video-components/1.4.0/win-x64`（三台各自独立磁盘） |
| 节点 | `175.178.192.87` / `1.14.182.208` / `175.178.33.107` |
| core.zip | 104.7 MB，`sha256=0648c57866d4…`，`connections: 4` |
| browser.zip | 120.1 MB，`sha256=b75cdbf6ede0…`，`connections: 4` |
| manifest 镜像 | `https://dw.mengxa.com/…` + `http://dw.mengxa.com/…`（同域名双 scheme） |

发布命令（会逐台上传 + SSH 比对 sha256）：

```bash
bash scripts/release-video-components.sh \
  --base-url https://dw.mengxa.com/video-components/1.4.0/win-x64 \
  --mirror http://dw.mengxa.com/video-components/1.4.0/win-x64 \
  --connections 4 \
  --host 175.178.192.87 --host 1.14.182.208 --host 175.178.33.107 \
  --key "D:/.ssh/id_ed25519" --upload
```

> ⚠️ **重新发布前先确认 staged runtime 未变**。`desktop/src/video-runtime/` 里的
> `node_modules` 被 `npm ci` 重装过就会产出与线上不同的 `core.zip`，
> 而 manifest 的 sha256 必须与实际文件一致 —— 不一致时客户端会校验失败。
> 发布后务必核对三台 sha256 一致（脚本会自动做）。

### 3.6 打绿色版（默认交付物）
thin 壳编译完后，用仓库脚本组装成**免安装绿色包**（裸 exe + README，无 NSIS）：

```bash
# 1) 先编译 thin 壳，烘焙后端地址与多节点 manifest URL
cd desktop/src
wails3 task windows:generate:syso ARCH=amd64 VERSION=1.4.1
GOOS=windows CGO_ENABLED=0 GOARCH=amd64 go build -tags production,thin -trimpath -buildvcs=false \
  -ldflags="-w -s -H windowsgui \
    -X main.defaultServerURL=https://ocbot.aixifs.com/videogen \
    -X main.defaultVideoComponentsURL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json" \
  -o bin/Octop.exe .

# 2) 组装绿色包
cd ../..
python scripts/pack_green_client.py \
  --exe desktop/src/bin/Octop.exe --out-dir desktop/src/bin --version 1.4.1
# 产物：Octop-green-windows-amd64-1.4.1.zip (5.3 MB) 与 .7z (4.1 MB)
```

> **绿色包里没有 `video-runtime/` 骨架，这是有意的**：已发布的 `core.zip` 本身就带
> node.exe、worker 脚本与 Remotion 依赖树，`bootstrap.Run` 会把它解到 exe 同级的
> `video-runtime/`（目录不存在会自动创建）。再塞一份骨架等于让用户白下载一遍。
>
> 打包时注意 **7-Zip 不能把归档写进正在被归档的目录**（会把自己越写越大，实测膨胀到
> 968 MB）；仓库脚本用临时目录做暂存区绕开这个坑。

> 也可以用仓库自带的发布脚本（它会串起前端 → portable → 校验 → 打包）：
> `bash desktop/package-release.sh windows-amd64`。
> 但它走的是远程版/完整版，**slim 变体目前只能直接调 `wails3 task package`**。

---

## 四、运行时 URL 是关键

slim 客户端把运行时地址**编译期写死**进 exe。地址必须在用户首次启动前就公开可达，
否则首启会下载失败（客户端会重试，但用户看到的是报错）。

运行时本体 **~290 MB**，放不进 Gitee 附件（100 MB 上限），所以留在 GitHub Release：

```
PORTABLE_RUNTIME_URL=https://github.com/zhuimeng2026-hub/Octop/releases/download/v1.4.0-gitee.1/Octop-portable-windows-amd64-1.4.0.zip
```

**这个 zip 必须先上传到该 Release，客户端才能用**——URL 里的 tag 和文件名要跟实际
上传的对得上。先传 zip，再打客户端（打客户端不用等 zip，但发布顺序要对）。

> 客户端支持逗号分隔的多个地址、按顺序 fallback（`download.go` 的 `runtimeURLs`），
> 将来要加对象存储/CDN 镜像时再补第二个地址，不用改客户端。

> **如果只是想让国内用户用起来**：优先发**远程版**（thin）——它不下载运行时，
> 全部资源都在 Gitee 上，国内访问无障碍。slim 版首启要从 GitHub 拉 290 MB，
> 国内速度取决于 GitHub 的可达性。

下载会**断点续传**：中途断网或杀进程，下次启动从断点继续，不会从头再下。

**更稳的做法：给 manifest**

只给 zip 地址时客户端没有校验和，镜像给了坏包只能等下次重试。改用 manifest
（描述版本、分片、镜像、sha256）就能强校验：

```bash
cd desktop/src
wails3 task package \
  ARCH=amd64 \
  VERSION=1.4.0 \
  PORTABLE_RUNTIME_MANIFEST_URL="https://github.com/zhuimeng2026-hub/Octop/releases/download/v1.4.0-gitee.1/manifest.json"
```

manifest 长这样（`format` 是 `zip` 或 `tar.gz`，`urls` 是有序镜像列表）：

```json
{
  "version": "1.4.0",
  "parts": [
    {
      "id": "runtime",
      "urls": ["https://github.com/zhuimeng2026-hub/Octop/releases/download/v1.4.0-gitee.1/Octop-portable-windows-amd64-1.4.0.zip"],
      "size": 304087040,
      "sha256": "…",
      "format": "zip",
      "stripRoot": true,
      "required": true
    }
  ]
}
```

> manifest 和它描述的 zip 都得先传到 Release 上，客户端才能用；
> `PORTABLE_RUNTIME_MANIFEST_SHA256` 可以把 manifest 自身的校验和也写死进 exe。

详见 [desktop-bootstrap-installer.md §0.4](desktop-bootstrap-installer.md#04-怎么用)。

---

## 五、发布到 GitHub Release 与 Gitee

### 5.1 先把运行时 zip 传上 GitHub Release

运行时 zip 本身也是 Gitee 传不下的（290 MB > 100 MB），所以它留在 GitHub Release，
Gitee 页面给外链。

```bash
# 在有 GitHub token 的机器上（token 放 ~/.github_token 首行，或设 $GH_TOKEN）
bash scripts/gitee/upload_release_asset.sh <release-id> desktop/portable/release/Octop-portable-windows-amd64-1.4.0.zip
bash scripts/gitee/upload_release_asset.sh <release-id> desktop/src/bin/Octop-desktop-slim-windows-amd64-1.4.0.exe
```

### 5.2 再发 Gitee

```bash
export GITEE_TOKEN=<Gitee PAT，projects 权限>
bash scripts/gitee/publish_from_github.sh \
  --tag v1.4.0-gitee.1 \
  --source-repo zhuimeng2026-hub/Octop \
  --owner webheat --repo octop_client
```

它会：拉 GitHub Release 里 **< 100 MB 且属于 Windows** 的资产 → 生成 Release 说明 →
同步下载页 → 建 Gitee Release 并上传（超限的只列出并给外链）。

> 平台过滤是默认行为（`--platform windows`），跟"本轮只提供 Windows 版"一致；
> 要发全平台就传 `--platform all`。wheel / sdist / fnOS 包不带平台名，一直都发。

> 也可以在 GitHub Actions 里 dispatch `Gitee Release` 工作流（需要仓库 Secret
> `GITEE_TOKEN`），但那个工作流目前因 fork 的 Actions 被禁用而跑不起来。

---

## 六、验证清单

出包后逐项确认：

- [ ] `Octop-desktop-slim-windows-amd64-1.4.0.exe` 体积 **< 100 MB**（Gitee 硬限制）
- [ ] 在一台干净 Windows 上安装 → 启动 → 状态栏出现"正在下载运行环境… N%" → 完成后 dashboard 能打开
- [ ] **断网再启**：已下载的运行时不再下载，直接可用（离线可用）
- [ ] 下载中断（杀进程）后重启：从断点继续，不是从头再下
- [ ] `Octop-portable-windows-amd64-1.4.0.zip` 已上传到 GitHub Release，**且 URL 可公开下载**（拿无痕窗口试）
- [ ] 装完后运行时落在 `~/.octop/portable`（即 `OCTOP_HOME` 下，不是 Program Files）

---

## 七、常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `wails3: command not found` | 没装或不在 PATH | `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.13`，确认 `%GOPATH%\bin` 在 PATH |
| `makensis not found` | 没装 NSIS | `choco install nsis`，或设 `OCTOP_DESKTOP_MAKENSIS` 指向本地 makensis.exe |
| 安装后首屏白屏 | 没构建前端 | 补 `make build-frontend` 再重打 |
| `aliyun-python-sdk-core has no usable wheels` | 在 Linux/macOS 上交叉构建 Windows portable | portable 必须在 Windows 上构建 |
| 装完提示找不到 `pywintypes` | pywin32 的 DLL 没就位 | `package.sh` 会自动拷；确认走的是 `package.sh` 而不是手工拼 staging |
| arm64 包打出 amd64 的内容 | x64 Git Bash 上把 arm64 误判成 amd64 | 用 arm64 机器，或显式设 `GREEN_HOST_PLAT=windows-arm64` |
| slim 客户端首启 404 | 运行时 URL 指向的 zip 还没发布 | 先传 zip 再分发客户端；URL 是编译期写死的，改地址要重打 |
| slim 客户端连了远程服务、没下载运行时 | 构建时没清掉 `DEFAULT_SERVER_URL` | 传 `PORTABLE_RUNTIME_URL` 时打包任务会自动置空远程地址；确认用的是 `package:slim` |

---

## 八、参考：CI 里对应做什么

`.github/workflows/octop-desktop.yml` 的 `package` job 就是上面这套的自动化版本
（`bootstrap-runtime.sh` → `package.sh` → `wails3 task package` → 上传 artifact →
挂到 GitHub Release）。它的矩阵是 6 个平台，**本轮只取其中 windows-amd64 和
windows-arm64**。Windows 相关的两个额外动作：

1. 装 NSIS（choco 装不上时从 SourceForge 下 setup 静默安装）
2. 用 `windows-latest` / `windows-11-arm` 原生 runner（不能交叉）

> 该工作流目前在本 fork 跑不起来：fork 的 Actions 在 GitHub 侧被禁用
> （`actions/permissions` 显示 enabled，但 dispatch 一律返回
> `422 Actions has been disabled for this repository`），需要在网页上重新启用。

---

## 相关文件

| 主题 | 位置 |
|---|---|
| 打包任务（三种变体的选择逻辑） | `desktop/src/build/windows/Taskfile.yml` |
| portable 运行时构建 | `desktop/portable/package.sh`、`bootstrap-runtime.sh` |
| 一键发布脚本 | `desktop/package-release.sh` |
| 运行时下载实现（客户端侧） | `desktop/src/download.go` |
| Gitee 发布 | `docs/gitee-release.md`、`scripts/gitee/` |
| 瘦安装器方案与未实现项 | `docs/desktop-bootstrap-installer.md` |
