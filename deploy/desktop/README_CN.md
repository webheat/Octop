# 桌面客户端「未配置组件下载地址」排查与预防

> 记录一次真实踩坑：客户端编译成功、能连上远端服务端，但点「一键安装制作组件」报
> **"当前客户端未配置组件下载地址"**。根因不在检测模块，而在**编译期少注入一个 ldflag**。
>
> **这不只是本地手敲 `go build` 的问题——CI 的打包路径同样不带这个地址。**
> 线上已发布的绿色版是好的（手工注入过），但下一次让 CI 自动发版就会翻车。
>
> 适用版本：`v1.4.0` / `desktop-v1.4.1`（本文基于 `develop` @ `cacbe146`）。

---

## 1. 现象

客户端启动正常，日志里能看到远端服务端在响应：

```
[fetch] url=https://ocbot.aixifs.com/videogen/api/setup/status status=200
```

打开「视频环境」页，点「一键安装制作组件」，界面提示**组件下载地址没配置**。

`desktop/src/bin/desktop-nav.log`（或 `<octop home>/logs/`）里是决定性的一行：

```
video env: check found no runtime directory (RUNTIME_MISSING); the components must be installed
video environment state=needs_setup stage=none code=RUNTIME_MISSING requiresInstall=true
video install: no components manifest URL is configured (build-time default is empty)
```

注意最后那句括号：**`build-time default is empty`** —— 是编译期默认值是空，不是网络不通、
不是 token 失效、不是 DNS 解析问题。

对应的用户可见文案在 `dashboard/src/locales/zh.json:766`：

```json
"NO_INSTALLER": "当前客户端未配置组件下载地址，请在桌面客户端打开本页或联系管理员。"
```

---

## 2. 根因

组件下载地址是**编译期常量**，靠 `-ldflags -X` 注入：

`desktop/src/main.go:36`

```go
// defaultVideoComponentsURL is the URL of the video components manifest,
// baked in via -ldflags "-X main.defaultVideoComponentsURL=https://.../manifest.json".
// Empty means the UI falls back to the "contact administrator" guidance.
var defaultVideoComponentsURL string
```

读取它的入口：`desktop/src/video_install.go:111`

```go
urls := manifestURLs(firstNonEmpty(os.Getenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL"), defaultVideoComponentsURL))
if len(urls) == 0 {
    m.mu.Unlock()
    navLogf("video install: no components manifest URL is configured (build-time default is empty)")
    return VideoEnvironmentStatus{}, videoErr("NO_INSTALLER")
}
```

`defaultVideoComponentsURL` 为空 → `NO_INSTALLER` → 前端
`dashboard/src/pages/VideoEnvironment/index.tsx:179` 渲染
`videoEnvironment.installerUnavailable`（zh.json:389「请在桌面客户端打开本页以安装组件，或联系管理员。」）。

### 为什么会漏：三处都断

下载地址**从来没有被当成一个构建输入**管理，它只活在文档和运维脚本的 stdout 里。

> ⚠️ **先澄清一个常见误解**：**线上发布的绿色版客户端是正常的**——它的二进制里
> **确实烘焙了组件地址**，点「一键安装」可用（实测见 §2.1）。
> 缺地址的是**绕开 Taskfile 手敲 `go build`** 的编译，以及 **CI 的打包路径**。
> 详见 §2.1 的对照表。

**① Taskfile 全局默认是空串** — `desktop/src/Taskfile.yml:21`

```yaml
  # Optional HTTPS URL for the separately built video component installer.
  # Leave empty until an official release asset is available.
  VIDEO_COMPONENTS_URL: ""
```

注释说"等官方资源发布前先留空"——但资源**早已发布**（1.4.0，2026-11-20）。
对比同文件 `:18` 的 `DEFAULT_SERVER_URL: "https://ocbot.aixifs.com/videogen"`：
服务端地址有默认值，组件地址没有。

**② ldflags 模板是条件注入** — `desktop/src/build/windows/Taskfile.yml:24`

```
{{if .VIDEO_COMPONENTS_URL}} -X main.defaultVideoComponentsURL={{.VIDEO_COMPONENTS_URL}}{{end}}
```

空 → 整段不生成 → `main.go:36` 的变量保持空 → `video_install.go:111` 返回 `NO_INSTALLER`。
**编译照样成功，没有任何 warning。**

**③ CI 打包路径根本不传这个变量** — `.github/workflows/octop-desktop.yml:340, 352, 364, 372`

四处 `wails3 task package` / `package:green` / `package:green:slim` 全都没带
`VIDEO_COMPONENTS_URL`，全靠那个空全局。**CI 产出的绿色版客户端会缺这个地址。**

**④ `package-release.sh` 会把全局默认清空** — `desktop/package-release.sh:118`

```bash
wails3 task package ... "VIDEO_COMPONENTS_URL=${video_components_url}"
```

`video_components_url` 取自 `:72` 的 `${OCTOP_DESKTOP_VIDEO_COMPONENTS_URL-}`，未设即空串。
go-task 的语义（已实测）：**显式传空值会覆盖全局默认**，不传才继承。

```
$ wails3 task show              → FOO=[global-default]   # 不传：继承全局
$ wails3 task show FOO=         → FOO=[]                 # 传空：覆盖成空
$ wails3 task show FOO=xyz      → FOO=[xyz]
```

所以即使把 `Taskfile.yml:21` 的全局填上，这一行也会把它抹掉。**两处必须一起改。**

### 2.1 线上发布的客户端是正常的（重要澄清）

网上有人会看到「线上发的客户端也缺地址」的说法——**那是错的**，因为被检查的
`C:\Octop_v0\desktop\src\bin\Octop.exe` 是 **`.gitignore` 忽略的本地构建产物**
（`desktop/src/.gitignore:1` 就是 `bin/`），不是发布物。

实测三份二进制（`grep -a -o -E 'https?://[a-z0-9.-]*mengxa\.com[^"[:space:]]*'`）：

| 二进制 | 来源 | `mengxa` | 烘焙的组件 URL |
|---|---|---|---|
| `C:\Octop_v0\desktop\src\bin\Octop.exe`<br>（2026-11-19，13.6 MB） | **本地**构建产物，`.gitignore` 忽略 | **0** | **无** |
| `Downloads\Octop.exe`（2026-11-22 07:08） | **线上发布物**，sha256 `26cc6788…` | 1 | https + http + IP 三档 |
| Gitee `v1.4.1-gitee.8` 的 `Octop.exe`<br>（2026-11-22 发布） | **线上发布物**，sha256 `26cc6788…` | 1 | 同上 |

后两份 sha256 完全相同，且与 Gitee Release 说明里公布的
`26cc678858f632bfd22e8d29e8072ae92dfa573a6b51156bbeb25b9de4db0d94` 一致 ——
**就是线上在发的那个文件**。

它烘焙的值是：

```
https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,
http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,
http://175.178.192.87/video-components/1.4.0/win-x64/manifest.json
```

（三档，含 IP 直连——对应 `docs/PRD.md:269` 那版配方；`docs/RELEASE-MATRIX.md:90`
之后改为只留域名两档，见 §4。）

**佐证：线上版的「一键安装」确实跑通过。** `~/.octop/logs/desktop-nav.log`
（旧版日志落盘位置）2026-11-22 07:11 的记录：

```
video install: started, manifest urls=[https://dw.mengxa.com/... http://dw.mengxa.com/... http://175.178.192.87/...]
video install: manifest loaded version=1.4.0-win-x64-node24.14.0 platform=win-x64 parts=2
video install: target dir=C:\Users\Admin\Downloads\video-runtime cache=C:\Users\Admin\.octop\desktop-video-environment\install
video install: progress part=core received=1103746/109800203 total=0.5%
```

`target dir` 指向 `Downloads\video-runtime`，即**exe 同级目录**——
说明跑的就是 `Downloads\Octop.exe`（那个已发布、已带地址的文件）。
下载确实完成了：`~/.octop/desktop-video-environment/install/parts/` 下躺着
`core.zip`（109,800,203 B）与 `browser.zip`（125,919,250 B），
sha256 与 manifest 一致。

**结论**：线上发布物是**手工构建**并注入 URL 的，走的是
`OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` 环境变量（`desktop/package-release.sh:72`）
或直接手敲 ldflags。**CI 路径没走这条**——所以风险在于：
**下次谁让 CI 自动发一版，就会发出一版装不了组件的客户端，而且没有任何报错。**

### 顺带一个直接诱因：本机 `wails3 task` 全线不可用

`desktop/src/build/windows/Taskfile.yml:192` 和 `:214` 用了 `sh:` 作为 cmds 键：

```yaml
- sh: 'mkdir -p "{{.ROOT_DIR}}/bin/green-webview2" && wails3 generate webview2bootstrapper ...'
- sh: '"{{.MAKENSIS}}" -VERSION'
```

本机 wails3 v3.0.0-beta.13 不认这个键，报：

```
ERROR  err:  invalid keys in command
  file: desktop/src/build/windows/Taskfile.yml:192:9
```

**注意：go-task 是解析整个 Taskfile 再挑任务执行的，所以 `desktop/src` 下**任何**
`wails3 task` 都跑不起来**——`wails3 task build:frontend` 同样报这个错，
不是只有 `create:green:zip` 那条链会踩。

该语法由提交 `180dd6a9`（"feat(desktop): Windows 免安装 zip（green）打包"）引入，
只在 `fork/develop` 上、**不在 `origin/develop`**，所以上游 CI 没暴露。

这直接把人推向手敲 `go build`——而手写 ldflags 正是最容易漏 `-X` 的地方。

---

## 3. 正确的编译方式

### 3.0 本次是怎么修好的

现象：客户端连得上远端、能登录、能进「视频环境」页，但点「一键安装」报
"当前客户端未配置组件下载地址"。

诊断：`bin/desktop-nav.log` 里那行
`video install: no components manifest URL is configured (build-time default is empty)`
直接指出是编译期变量为空，不是网络/权限问题。

修复：**重编一次，把 `defaultVideoComponentsURL` 这个 ldflag 补上**——就是在原来的
命令后面多一段 `-X main.defaultVideoComponentsURL=<双 scheme URL>`：

```bash
cd desktop/src
go build -buildvcs=false -tags "production,thin" \
  -ldflags="-X main.defaultServerURL=https://ocbot.aixifs.com/videogen \
            -X main.defaultVideoComponentsURL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json" \
  -o bin/Octop.exe .
```

验证（二进制里应能 grep 到两条 URL）：

```bash
grep -a -o -E 'https?://[A-Za-z0-9._/-]*mengxa\.com[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
# https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
```

重启客户端后 navlog 里 `no components manifest URL` 的计数归零，
「一键安装」即可正常下载组件。

> 本次**没有改动任何生产代码**——缺的只是一个编译参数，不是代码 bug。
> 下面三种编译方式都能避免再次踩坑。

### 方式 A：走 Taskfile（推荐）

```bash
cd desktop/src
wails3 task build PRODUCTION=true \
  DEFAULT_SERVER_URL=https://ocbot.aixifs.com/videogen \
  VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
```

### 方式 B：走 package-release.sh（发布用）

```bash
export OCTOP_DESKTOP_VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
./desktop/package-release.sh --platform windows-x64
```

脚本会把它转成 `VIDEO_COMPONENTS_URL` 传给 `wails3 task package`
（`desktop/package-release.sh:118`）。

### 方式 C：手敲 go build（临时调试）

**两个 ldflag 必须成对出现**：

```bash
cd desktop/src
go build -buildvcs=false -tags "production,thin" -ldflags="-X main.defaultServerURL=https://ocbot.aixifs.com/videogen -X main.defaultVideoComponentsURL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json" -o bin/Octop.exe .
```

---

## 4. 组件地址从哪来

| 项 | 值 |
|---|---|
| 主 URL | `https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json` |
| 镜像 URL | `http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json` |
| 线上可用版本 | `1.4.0`（`1.4.1` / `1.5.0` 路径均 404） |
| 版本号来源 | `pyproject.toml:7` 的 `version = "1.4.0"`，与 `scripts/release-video-components.sh:172` 的读取行为一致 |
| manifest 内容 | `schema: octop-desktop-video-components/1`，`version: 1.4.0-win-x64-node24.14.0`，`platform: win-x64` |
| parts | `core.zip`（109.8 MB）、`browser.zip`（125.9 MB），各带 `connections: 4` |

发布脚本 `scripts/release-video-components.sh` 会在发布成功后打印要注入的 URL
（`scripts/release-video-components.sh:387`），照抄即可。

### 为什么必须烘焙**双 scheme**（多节点）

`dw.mengxa.com` 的 DNS 轮询到 4 个 IP，各节点 TLS/站点配置**不一致**：

| IP | HTTPS | HTTP | 说明 |
|---|---|---|---|
| `1.14.182.208` | ✅ 200 | ✅ 206 | 正常节点 |
| `175.178.33.107` | ✅ 200 | 301→HTTPS | HTTPS 正常；**HTTP 端口只跳转不供文件** |
| `175.178.192.87` | ❌ SNI 不匹配 | ✅ 206 | **只服务 HTTP** |
| `8.134.147.195` | ❌ 证书 `CN=ymxt.top` 已过期 | 403 | **故意挂的故障节点**，用于验证容灾 |

- 只探 HTTPS 会把「只服务 HTTP」的好节点误判为死节点，白丢一半带宽 → 客户端按
  `host|scheme` 分组探测、按端口维护可用节点列表。
- `8.134.147.195` **不要从 DNS 摘掉**，摘了这套容灾验证就没了；客户端的
  `componentsDownloadClient` 会逐 IP 探测并自动跳过它。
- 探测**不跟随重定向**，3xx 直接算该 scheme 下不可用（否则 `175.178.33.107` 的
  HTTP 301 会被误判为健康）。

详见 `docs/desktop-windows-build.md` §3.5 与 `docs/PRD.md`。

---

## 5. 验证清单（编译后必做）

```bash
# 1) 二进制里两个 URL 都在
grep -a -o -E 'https?://[A-Za-z0-9._/-]*mengxa\.com[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# 期望：
#   http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
#   https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json

grep -a -o -E 'https?://ocbot[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# 期望：https://ocbot.aixifs.com/videogen

# 2) manifest 实际可达（两个 scheme 都要 200）
curl -sS -o /dev/null -w '%{http_code}\n' https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
curl -sS -o /dev/null -w '%{http_code}\n' http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json

# 3) 启动后 navlog 里不能再出现这句
grep -c "no components manifest URL" bin/desktop-nav.log
# 期望：0
```

---

## 6. 排查决策树

```
客户端报「未配置组件下载地址」
│
├─ navlog 有 "no components manifest URL is configured (build-time default is empty)"
│   → 编译期漏注入。查上面的验证清单第 1 步。补 ldflag 重编。
│
├─ navlog 无此句，但前端仍显示不可用
│   → 前端拿的是 window.octopDesktopVideo.environmentInstallerURL，
│     它来自 video_bridge.go:95 注入的 JS。确认 webview 加载的是
│     /videogen 前缀下的页面，且 bridge 注入成功（navlog 有 "injecting probe"）。
│
├─ 报的是 NO_INSTALLER / DOWNLOAD_FAILED，且 navlog 显示 "manifest could not be loaded"
│   → URL 有了但取不到。跑第 5 步第 2 条确认 200；再确认版本号（当前只有 1.4.0）。
│
└─ 报 RUNTIME_MISSING / BROWSER_MISSING
    → 组件没装成功。装成功后再 verify。
```

---

## 7. 代码位置速查

| 文件:行 | 作用 |
|---|---|
| `desktop/src/main.go:36` | `defaultVideoComponentsURL` 变量声明（ldflags 注入点） |
| `desktop/src/main.go:63` | `resolveRemoteDashboardURL()` —— 服务端地址，env 优先 |
| `desktop/src/video_install.go:111` | 读 URL；为空则返回 `NO_INSTALLER` |
| `desktop/src/video_install.go:75` | `manifestURLs()` —— 逗号分隔多 URL 解析 + 校验 |
| `desktop/src/video_environment.go:52` | `sanitizeEnvironmentInstallerURL()` |
| `desktop/src/video_bridge.go:95` | 把主镜像 URL 注入前端 `window.octopDesktopVideo.environmentInstallerURL` |
| `desktop/src/Taskfile.yml:21` | `VIDEO_COMPONENTS_URL` 全局 var（默认空 ← 陷阱之一） |
| `desktop/src/build/windows/Taskfile.yml:24` | BUILD_FLAGS 拼装 ldflags（条件注入） |
| `desktop/src/build/windows/Taskfile.yml:192, 214` | `sh:` 键 —— wails3 v3.0.0-beta.13 不认，整个 Taskfile 不可用 |
| `desktop/package-release.sh:72` | 从 `OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` 取值（默认空） |
| `desktop/package-release.sh:118` | 转成 `VIDEO_COMPONENTS_URL` 传给 `wails3 task package`（**显式空值会覆盖全局**） |
| `scripts/release-video-components.sh:172` | 从 `pyproject.toml` 读版本号 |
| `scripts/release-video-components.sh:387` | 发布后打印应注入的 URL |
| `.github/workflows/octop-desktop.yml:340,352,364,372` | CI 的四处打包调用，**均未传 `VIDEO_COMPONENTS_URL`** |
| `dashboard/src/locales/zh.json:766` | `NO_INSTALLER` 用户文案 |
| `dashboard/src/pages/VideoEnvironment/index.tsx:179` | 前端提示 `installerUnavailable` |
| `docs/desktop-windows-build.md` §3.5 | 组件打包与烘焙的完整说明 |

---

## 8. 建议的修复（尚未实施）

### (a) 单一真源：新增 `desktop/video-components.env`

提交进仓库，取代散落在 `docs/desktop-windows-build.md:151,186,244` 的重复字面量：

```
OCTOP_VIDEO_COMPONENTS_URL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
```

版本号与 `pyproject.toml:7` 的 `1.4.0` 一致，也与发布脚本从 pyproject 取版本的行为一致。

### (b) `desktop/src/Taskfile.yml:21` 改为读该文件

go-task 的 `vars` 支持 `sh:`，且根 Taskfile 的全局可被 `includes` 的子 Taskfile 读到：

```yaml
  VIDEO_COMPONENTS_URL:
    sh: 'cat "{{.ROOT_DIR}}/../../video-components.env" 2>/dev/null | sed -nE "s/^OCTOP_VIDEO_COMPONENTS_URL=(.*)$/\1/p"'
```

CI 不传该变量 → 走全局 → 四处 `wails3 task package` 自动带上。

### (c) `desktop/package-release.sh:118` 改成不传空值

仅在 env 非空时才追加 `VIDEO_COMPONENTS_URL=...`，否则交给 Taskfile 全局。
**否则 (b) 会被这行覆盖掉**（go-task 显式空值覆盖全局，已实测）。

### (d) `scripts/release-video-components.sh` 发布成功后回写该 env 文件

它已经知道 `ALL_URLS`（`:386`），回写即可；`docs/desktop-windows-build.md` 里
手抄 URL 的步骤同步改成"读文件"。

### (e) 加构建期断言 —— 这是"确保下次不漏"的关键

CI 打包后加一步：

```bash
strings bin/Octop.exe | grep -q 'dw.mengxa.com' || { echo "::error::defaultVideoComponentsURL 未注入"; exit 1; }
```

断言放在 **CI** 比放在 Taskfile 好 —— Taskfile 路径当前就是坏的（见 (f)）。

### (f) 先修 `build/windows/Taskfile.yml:192,214` 的 `sh:`

改成 `cmd: sh -c '...'`（`preconditions` 里的 `sh:` 是否被该 fork 支持尚未验证）。
**不修这条，Taskfile 里的任何修复都无法验证**，只会继续逼人手敲 `go build`。

### (g) 前端提示语区分

`installerUnavailable` 目前只有一句「请在桌面客户端打开本页」，区分不了
「不在桌面客户端」和「在桌面客户端但没编译下载地址」两种情况，容易误导排查方向。
`NO_INSTALLER` 的文案（zh.json:766）相对准确，但两处应统一。

---

## 9. 附带发现：两处取值口径不一致

`video_bridge.go:95` 只用烘焙值 `defaultVideoComponentsURL` 算前端桥的
`environmentInstallerURL`，而 `video_install.go:111` 是 env 优先：

```
video_install.go:111  firstNonEmpty(os.Getenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL"), defaultVideoComponentsURL)
video_bridge.go:95    manifestURLs(defaultVideoComponentsURL)
```

后果：**运行时设 `OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` 能装上组件，
但前端拿到的 installer URL 是空。** 目前 `dashboard/src` 里没有任何页面真正消费
`environmentInstallerURL`（只有 `DesktopVideoJobsContext.tsx:442` 透传），
所以暂无可见影响——但一旦前端开始用它判断"能不能装"，这个不一致就会变成 bug。
