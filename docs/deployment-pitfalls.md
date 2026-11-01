# 部署踩坑清单

按「症状 → 原因 → 修法」组织，都是子路径部署（`/videogen`）+ 本机视频渲染这套
实际踩过的坑。**第 1 条是最高频的**：只改了后端 `base_path`、忘了用同样的前缀
构建前端，表现为「面板打开是白屏」。

---

## 1. 面板白屏：配了 `base_path`，前端却没用 `BASE_URL` 构建 ★

**症状**

- 打开 `https://host/videogen/` 整页空白，连登录框都不出来。
- 浏览器 DevTools → Network：`/assets/index.<hash>.js` **404**（而不是 `/videogen/assets/...`）。
- 后端日志没有报错，`GET /videogen/api/health` 正常返回 200。

**原因**

SPA 里的这些路径全部在**构建期**写死进 bundle：

| 位置 | 构建期决定的东西 |
|------|-----------------|
| `index.html` | 资源 URL（`/assets/...` vs `/videogen/assets/...`） |
| `api/config.ts` 的 `getApiUrl()` | API base |
| `App.tsx` 的 `BrowserRouter basename` | 路由前缀 |
| `sw-register.ts` | Service Worker 注册路径与 scope |
| `public/manifest.json` | PWA `start_url` / `scope` |

后端 `base_path` 只让**服务端**认得 `/videogen/...`，改不了已经打包好的前端。
两者必须一致。

**修法**

```bash
cd dashboard
BASE_URL=/videogen npm run build        # → src/octop/dashboard/
```

或从仓库根目录：

```bash
make build-frontend BASE_URL=/videogen
```

**验证**（部署后先跑这条，比开浏览器快）：

```bash
curl -s https://host/videogen/ | grep -o 'src="[^"]*"'
# 期望：src="/videogen/assets/index.<hash>.js"
# 若看到 src="/assets/..." → 前端没用 BASE_URL 构建，重建
```

**Windows / Git Bash 注意**：`BASE_URL=/videogen npm run build` 在 Git Bash 里
会被 MSYS 当成路径改写成 `C:/Program Files/Git/videogen`。用
`MSYS_NO_PATHCONV=1 BASE_URL=/videogen npm run build`（Makefile 里已带），或在
PowerShell 里 `$env:BASE_URL = "/videogen"; npm run build`。

**其它后果**（前缀不一致时）：API 请求打到 `/api/...`（漏前缀）→ 401；
React Router 不知道 basename → 路由 404，页面显示「页面不存在」；
Service Worker 注册在根 scope → 缓存了旧版本资源。

---

## 2. 反代带不带尾斜杠

**只有一种写法能用**：

```nginx
# B. 原样透传（proxy_pass 不带尾斜杠）—— 正确
location /videogen/ { proxy_pass http://127.0.0.1:8088; }
```

- B：后端收到 `/videogen/api/...`，由 `BasePathApp` 剥掉前缀再路由，同时把
  前缀重新挂回 `root_path`，生成的 URL（媒体链接、OAuth 回调）都带前缀。
- A（`proxy_pass http://127.0.0.1:8088/;` 带尾斜杠 = 剥前缀）：后端收到
  `/api/...`，**会被 404** —— 后端只认前缀内的路径，根路径一律拒绝。

不管哪种反代写法，前端都必须用 `BASE_URL=/videogen` 构建（见第 1 条），
且后端 `base_path` 与构建时 `BASE_URL` 必须一致。

---

## 3. 所有人共用一个 IP，5 次失败就被锁 15 分钟

**症状**：公网访问时，某个用户连输几次密码后，**所有用户**都登不进去，报
「登录尝试过多」。

**原因**：`api/common/client_ip.py` 只在**对端是 loopback** 时才采信
`X-Forwarded-For`（防伪造设计：头是调用方自己填的，不能信远端代理的）。
反代在另一台机器时，Octop 看到的 peer 是反代 IP，所有请求算同一个人，
触发 `login_max_attempts=5` / `login_lockout_seconds=900`。

**修法**：反代与 Octop **同机**部署（`127.0.0.1:8088`），这样 peer 是 loopback，
`X-Forwarded-For` 才被采信。

---

## 4. workspace 接口报 `AGENT_FAILED` / 404

**症状**：同步器拉不到任务，日志是
`[sync] queue not available yet: 500 AGENT_FAILED`，
或 `GET /api/agents/<id>/workspace/tree` 返回 404。

**原因**：workspace 的读写接口走 `require_running_workspace()`，要求**该 agent
处于运行中**。agent 启动失败（常见于没配模型）时接口一律拒绝。

**修法**：在 Dashboard 把目标 agent 启用；`/api/health` 的 `agents_running`
应当 ≥ 1。同步器会等下一轮轮询，agent 起来后自动继续。

---

## 5. 成片回传失败：任务不会失败，但视频也没在服务器上

**症状**：本机日志出现

```
[sync] job 20261021-1430-x: publish failed (403 Forbidden …) — kept locally → …inal.mp4
```

而服务器 workspace 里没有 `final.mp4`。

**原因**：同步器的默认模式是 `auto`——渲染完**自动尝试回传**，回传失败就保留在本机，
不抛错、不丢片。失败的常见原因：token 过期（401）、token 只有读权限（403）、agent
没在运行（`require_running_workspace`）、服务器磁盘满。

**修法**：看日志里的状态码。401 → 换 token；403 → 确认该 token 对目标 agent 有写
权限；其它 → 先看服务器侧 agent 状态和 `/api/health`。想让发布失败时把任务标成失败
（而不是降级留本机），用 `--deliver server`。

**为什么默认不直接失败**：回传只是「把成片放到聊天里」这个附加动作，不该因为它
失败就丢掉已经渲染好的片子——所以默认降级留本机。逐条任务的去向由服务器上的模型
在 `script.json` 里用 `"deliver": "server" | "local"` 决定。

## 6. 同步器「已处理」但任务没渲染

`remotion/work/state.json` 记录了已完成的 job。手工删掉某个条目即可重跑：

```bash
node -e "const f='remotion/work/state.json';const s=require('fs');s.writeFileSync(f,JSON.stringify({done:[]},null,2))"
```

---

## 7. 本机渲染卡在「downloading chromium」几小时

**症状**：`[render] ensuring chromium…` 之后几乎不动，下载进度个位数百分比
爬几小时。

**原因**：Remotion 自带的 headless shell 从 `storage.googleapis.com` 下载，
部分网络下只有 ~10 KB/s（150 MB 要几小时）。

**修法**：让渲染器用**本机已有的** Chrome/Chromium。`render.mjs` 会依次找：

1. 环境变量 `REMOTION_BROWSER_EXECUTABLE`；
2. `%LOCALAPPDATA%/ms-playwright/chromium-*/chrome-win64/chrome.exe`；
3. 系统 Chrome / Edge。

都没有才会触发下载。想彻底避免：

```bash
npx playwright install chromium
```

**同时注意**：`selectComposition` 和 `renderMedia` **两处**都要传
`browserExecutable`，只给后者的话前者仍会触发下载。

---

## 8. 改了 `base_path` 但 OAuth 回调 / SSO cookie 指向旧路径

`base_path` 已经同时作用于 `resolve_public_base()`（外部可见 origin）和
SSO 状态 cookie 的 path（`api/common/sso_cookie.py`），所以 OAuth 回调会带上
前缀。前提是反代透传了：

```
X-Forwarded-Proto: https
X-Forwarded-Host:  ocbot.aixifs.com
```

缺了 `X-Forwarded-Proto`，服务端会把回调算成 `http://`，浏览器会拒绝或跳回
错误地址。

---

## 9. 扫码登录「服务端说成功了，浏览器却 404」

**症状**

- 微信开放平台扫码：服务端日志出现 `SSO login succeeded`，浏览器却被重定向到
  `https://host/videogen/videogen/login/oidc/complete`（前缀出现两次）→ 404。
- 同一条链路上的错误重定向也一样：`/videogen/videogen/login?oidc_error=state`。

**原因**

子路径部署时前缀被拼了两次：

| 位置 | 行为 |
|------|------|
| `api/common/public_base.py` `resolve_public_base()` | 返回 `https://host/videogen`（已带 root_path） |
| `infra/auth/sso/service.py` `_frontend_base()` | 又拼了一次 `current_base_path()` |

两处都来自子路径部署那次改动（`53456ab8` / `7dd075f8`），OIDC 与 OAuth 共用
`_frontend_base()`，所以**通用 OIDC 登录在子路径下同样中招**。

**修法**

`_frontend_base()` 直接返回 `public_base.rstrip("/")`（前缀已在 `public_base` 里），
不再追加 `current_base_path()`。回归测试：
`tests/unit/auth/test_sso_service.py::test_callback_under_a_base_path_keeps_the_prefix_once`。

**排查手法**：SSO 链路的日志落在应用日志文件里（不是 journalctl）：

```bash
grep -E "SSO|WeChat" /opt/octop-data/logs/octop.log
```

起跳、回调、state 校验失败、微信 errcode、成功与失败分支都有日志，能直接看出
卡在哪一段（回调地址对不对、state cookie 有没有丢、微信返回什么错误码）。

---

## 10. 全站 502：后端根本没在跑（不是应用报错）

**症状**

- 浏览器全站 502，nginx 日志是
  `connect() failed (111: Connection refused) while connecting to upstream`，
  `upstream: "http://127.0.0.1:8088/..."`。
- `journalctl -u octop.service` 里最后一条是 `Stopping octop.service ...`，
  之后再没有 `Started`。
- 应用日志里没有任何异常栈——因为进程根本没在运行。

**502 = nginx 连不上后端**。先确认上游是否在监听：

```bash
systemctl is-active octop.service
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8088/videogen/api/health
```

**三个坑叠加**

| 坑 | 表现 | 修法 |
|----|------|------|
| 优雅停止退出码是 1 | `Main process exited, code=exited, status=1/FAILURE`，systemd 记成崩溃 | `launch.py` 捕获 `KeyboardInterrupt` → 退出码 0（`tests/unit/test_launch_signals.py`） |
| 测试集会停掉线上服务 | `tests/unit/infra/setup/test_service.py` 的 `stop_service` 用例在部署机上命中真实的 `/etc/systemd/system/octop.service` | 用例改为 stub `is_service_installed` + `_systemd_run`；模块加了 autouse 守卫，任何真实 `systemctl` 调用直接失败 |
| systemd 不会重启被显式 stop 的 unit | `Restart=always` 对 `systemctl stop` 不生效，进程停了就是停了 | `octop-watchdog.timer` 每 2 分钟探活，不通就拉起 |

**看门狗（`octop-watchdog.timer`）**

```bash
systemctl list-timers | grep octop-watchdog     # 下次触发时间
systemctl start octop-watchdog.service          # 手动跑一次
octop service watchdog                          # 手动探活 + 自愈
journalctl -u octop-watchdog.service -n 20      # 看它做了什么
```

- 探活地址会同时试 `<base_path>/api/health` 和 `/api/health`：
  子路径部署（`OCTOP_BASE_PATH=/videogen`）只有带前缀的那个会返回 200。
- 服务正常时输出 `healthy`；不通就 `systemctl restart` 再复检。
- **维护窗口**要停服时，先 `systemctl disable --now octop-watchdog.timer`，
  否则看门狗会在 2 分钟内把服务拉起来。
- 探活失败但 unit 是 `disabled` 状态时，看门狗不拉起——那是运维主动关的。

**`StartLimitBurst`**

`15-resource-limits.conf` 里的 `StartLimitBurst=10`（600 秒窗口）。
systemd 默认 5 次：连续重启几次就会彻底放弃启动，unit 卡在 failed，
后端就再也不会自己起来，直到有人手工 `systemctl reset-failed && start`。

---

## 11. Windows 上部署：PowerShell 脚本的坑单独成文

在 **Windows 开发机**跑部署会遇到一批只在 Windows 出现的坑（UTF-8 BOM、原生命令 stderr
被当异常、rsync 源路径冒号、rsync 必须配 MSYS ssh、MSYS ssh 的 HOME 退化、远端命令引号被吃），
外加两个运维型事故：

| 事故 | 一句话 |
|------|--------|
| `icacls /inheritance:r` 分步执行 | 第一步清空 DACL 后**第二步已无权写入** → 私钥变成谁都读不了，只能提权恢复 |
| `Exceeded MaxStartups` | 短时间多次 ssh 打满未认证连接数；**别写重试循环**，越试越糟 |

完整清单（含症状/原因/修法、事故复盘、脚本参数与执行流程）见
**[windows-deploy-script.md](windows-deploy-script.md)**。

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [configuration.md](configuration.md) | `config.json` 全量键说明、`OCTOP_BASE_PATH`、挂前缀的完整配置 |
| [remotion-video-pipeline.md](remotion-video-pipeline.md) | 视频生成流水线（服务器产出脚本 → 本机渲染 → 回传） |
| [agent-backend-file-io.md](agent-backend-file-io.md) | 工作区存储后端（含 COS/S3/OBS） |
| [windows-deploy-script.md](windows-deploy-script.md) | `deploy-dashboard.ps1` 用法 + Windows/PS 5.1 六个硬坑 + ACL 事故复盘 |
