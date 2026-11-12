# Windows 一键部署前端产物（PowerShell 版）

`scripts/deploy-dashboard.ps1` 是 `scripts/deploy-dashboard.sh` 的 Windows 等价实现，
用于在开发机（Windows）上把 `src/octop/dashboard/` 的构建产物增量同步到线上服务器。
核心语义一致：**rsync 增量 + 远端备份（留 5 份）+ 入口 hash 校验 + 线上探活**；
本机没装 rsync 时退化为 `scp` 上传 + 远端镜像。

两版并非逐行等价，差异见 [第 8 节](#8-与-sh-版的差异)：sh 版有 SSH 连接复用与密码回退，
ps1 版走 `scp` 上传（sh 版走 tar 流）。**远端镜像那一步，两版都要求服务器上装了 rsync。**

> 本文按「用法 → 执行流程 → 环境准备 → 踩坑（症状/原因/修法）→ 事故复盘」组织。
> 只看坑，直接跳 [第 4 节](#4-windows--ps-51-的六个硬坑)。

---

## 1. 用法

```powershell
cd D:\Octop

# 先看差异，不写远端
powershell -ExecutionPolicy Bypass -File scripts\deploy-dashboard.ps1 -DryRun

# 正式同步
powershell -ExecutionPolicy Bypass -File scripts\deploy-dashboard.ps1

# 先构建再同步（内部走 BASE_URL=/videogen npm run build）
powershell -ExecutionPolicy Bypass -File scripts\deploy-dashboard.ps1 -Build
```

cmd 里同样可用（`powershell -ExecutionPolicy Bypass -File ...`）。
Git Bash 里优先用 `.sh` 版，不要混着用。

### 参数

| 参数 | 作用 |
|------|------|
| `-Build` | 同步前先构建（`MSYS_NO_PATHCONV=1 BASE_URL=/videogen npm run build`） |
| `-DryRun` | 只算差异、不写远端 |
| `-NoDelete` | 不删远端多余文件（默认 `--delete`，会清旧 hash 产物） |
| `-NoBackup` | 跳过同步前备份 |
| `-Restart` | 同步后 `systemctl restart` 远端服务 |
| `-NoVerify` | 跳过线上探活（远端落地校验与入口 hash 比对始终执行） |
| `-Server` / `-Port` / `-RemoteUser` | 覆盖默认目标（默认 `ocdev.aixifs.com` / `13122` / `root`） |
| `-Help` | 打印帮助 |

**不要写 `-Host`**：它和 PowerShell 的自动变量 `$Host` 冲突，脚本里刻意改名成 `-Server`。

### 环境变量覆盖（与 sh 版一致）

不想改脚本、也不想每次带参数时，用环境变量；**参数优先级高于环境变量**。

| 变量 | 默认值 |
|------|--------|
| `OCTOP_DEPLOY_HOST` | `ocdev.aixifs.com` |
| `OCTOP_DEPLOY_PORT` | `13122` |
| `OCTOP_DEPLOY_USER` | `root` |
| `OCTOP_DEPLOY_KEY` | 自动探测 `D:/.ssh/id_ed25519` 等 |
| `OCTOP_DEPLOY_SRC` | `<repo>/src/octop/dashboard` |
| `OCTOP_DEPLOY_DST` | `/opt/Octop/src/octop/dashboard` |
| `OCTOP_DEPLOY_VERIFY` | `https://ocbot.aixifs.com/videogen` |
| `OCTOP_DEPLOY_BASE_PATH` | `/videogen` |
| `OCTOP_DEPLOY_BACKUP_ROOT` | `/opt/octop-data/dashboard-backups` |
| `OCTOP_DEPLOY_KEEP_BACKUPS` | `5` |
| `OCTOP_DEPLOY_ALLOW_STALE` | 不设 = 产物过期时中止同步；设 `1` = 放行 |

### 一次成功运行的实际输出（参考基线）

```
传输方式 : rsync 增量，1.2s 传 1.9MB（26MB 中只传变化的）
远端备份 : /opt/octop-data/dashboard-backups/20261027-121047
入口 hash: index.BGex2Wjm.js → index.BTI42U5S.js
线上探活 : {"ok":true,"db":true,"users_loaded":4}
```

---

## 2. 执行流程

```
参数解析 → 找 rsync / 找 MSYS ssh
   ↓
产物闸门：入口 chunk 必须存在；产物比 dashboard/src 旧则中止（防回滚线上）
   ↓
远端探测（文件数、入口 hash、octop.service 是否存在）
   ↓
[DryRun] rsync -n --itemize-changes → 打印差异 → 退出
   ↓
远端备份 → cp -a 到 /opt/octop-data/dashboard-backups/<ts>（保留 5 份，可回滚）
   ↓
rsync 增量同步（--delete，保留 __init__.py / .gitkeep）
   ↓
校验：远端 index.html 的入口 hash + https://<host>/videogen/api/health
   ↓
[可选] systemctl restart
```

**不需要重启后端**：`api/app.py` 的 `_dashboard_response()` 用 `FileResponse` 每次实时读盘，
静态产物换了即刻生效。但 `index.html` / `sw.js` / `manifest.json` 是 `no-cache`、
`assets/*` 是 `immutable`，**客户端必须 Ctrl+Shift+R 硬刷新**才能换掉 Service Worker 缓存的语言包 chunk。

---

## 3. 环境准备（一次性）

### 3.1 rsync（可选，但强烈建议）

没有 rsync 也能跑（退化为 scp + 远端镜像，26MB 全量上传），但增量同步是几秒 vs 几十秒的差别。

本机的装法是**从 repo.msys2.org 取独立二进制**，winget / mirror.msys2.org 都没有现成包：

```bash
# 1) 下 rsync 的 .pkg.tar.zst
#    Windows 自带 tar 3.5.2 不支持 zstd，先 pip install zstandard 再用 python tarfile 解
# 2) objdump -p 递归找出依赖的 12 个 msys-*.dll，一并放到同一目录
# 3) 目录加进 PATH
C:\tools\rsync\rsync.exe + msys-*.dll
```

脚本会自动在 `PATH`、`C:\tools\rsync`、Git 自带目录里找 `rsync.exe`，找不到就走 scp 分支。

### 3.2 SSH 免密（Windows OpenSSH 会查私钥 ACL）

Linux 那边 `~/.ssh/id_ed25519` 直接能用，**Windows 版 OpenSSH 8.1 会校验私钥文件权限**，
过宽就拒绝加载：

```
Permissions for 'D:/.ssh/id_ed25519' are too open.
This private key will be ignored.
```

Git Bash 的 ssh **不做**这个检查，所以「Git Bash 能连、PowerShell 连不上」是正常现象，
不是密钥坏了。修法是**一条命令**把 ACL 收紧到仅当前用户：

```powershell
icacls "D:\.ssh\id_ed25519" /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(F)"
```

⚠️ **必须一条命令写完**，拆成两步会出事故，见 [第 5 节](#5-事故复盘icacls-inheritancer-会先把-dacl-清空)。

---

## 4. Windows / PS 5.1 的六个硬坑

这六条都是**实测撞过**的，脚本里已经内建规避。要改脚本时务必保留对应处理。

| # | 坑 | 症状（很容易误判） |
|---|----|-------------------|
| 1 | 脚本无 UTF-8 BOM | 报一堆「意外的标记 }」，看着像语法错 |
| 2 | `$ErrorActionPreference='Stop'` | ssh 的 host key 警告直接中断整个脚本 |
| 3 | rsync 源路径写了 `D:/...` | `source and destination cannot both be remote` |
| 4 | rsync 配了 Windows OpenSSH | `protocol data stream` / `connection unexpectedly closed` |
| 5 | MSYS ssh 的 HOME 变了 | `Host key verification failed` / 找不到 key |
| 6 | 远端命令内联引号 | 远端 `awk` 拿不到内容，服务名识别成空 |

### 坑 1：文件必须存成 UTF-8 with BOM

**症状**：`[System.Management.Automation.Language.Parser]` 报几十条「意外的标记 '}'」、
「字符串缺少终止符」，位置全对不上。

**原因**：**PowerShell 5.1 读无 BOM 的 UTF-8 文件时按系统 ANSI（GBK）解码**。
中文注释被解成乱码后，多字节序列里恰好含 `"` 或 `{}` 的字节，导致**引号配对错乱**，
后面整体错位。看起来是语法问题，实际是编码问题。

**修法**：文件开头写 BOM（`EF BB BF`）。改动后用这条确认 BOM 还在：

```bash
python3 -c "d=open('scripts/deploy-dashboard.ps1','rb').read(); print('BOM:', d[:3]==b'\xef\xbb\xbf')"
```

> 用 `Edit` 工具改文件通常能保住 BOM，但每次改完复查一次成本极低。

### 坑 2：`$ErrorActionPreference = 'Stop'` 会把 ssh 的 stderr 当异常

**症状**：ssh 明明成功了（或只是打了个 host key 警告），脚本却在第一次调用时就退出：

```
ssh : Warning: Permanently added 'ocdev.aixifs.com' to the list of known hosts.
    + CategoryInfo          : NotSpecified: (...) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

**原因**：PowerShell 5.1 对**原生命令**（ssh / rsync / scp）的 stderr 处理很粗暴——
只要有输出到 stderr，配合 `2>&1` 就会被包装成 `NativeCommandError`。
这些工具往 stderr 打进度和警告是常态（ssh 的 banner、rsync 的统计），不是错误。

**修法**：`$ErrorActionPreference = 'Continue'`，改用 `$LASTEXITCODE` 判断成败：

```powershell
$out = & ssh @sshArgs $Target 'echo SSH_OK' 2>&1
if ($LASTEXITCODE -ne 0) { Fail "..." }
```

> 副作用：真正的 PS cmdlet 异常不再自动抛出，所以脚本里每个外部调用都要显式查 `$LASTEXITCODE`。

### 坑 3：rsync 的源路径不能用 `D:/...`，也不能用 `/d/...`

**症状**

```
rsync: source and destination cannot both be remote
```

或（另一种写法时）：

```
rsync: change_dir "/d/Octop/src/octop/dashboard" failed: No such file or directory
```

**原因**：两个不同的问题叠在一起

- `D:/Octop/...` 里的**冒号**被 rsync 解析成 `host:path`，于是「源」被判成远程主机，
  和目标 `root@host:/path` 一起 → 两头都是远程，直接拒绝。
- 改成 MSYS 风格 `/d/Octop/...` 也不行：`C:\tools\rsync` 是**精简 MSYS 构建**，
  没有 `/d` 挂载点（那是 Git for Windows 的 mount table 才有的）。

**修法**：`Push-Location` 到产物目录，用相对路径 `./` 当源：

```powershell
Push-Location $Src
& $RsyncExe @opts './' $remoteDst
Pop-Location
```

同理，`-i` 传私钥路径用 `D:/...` 正斜杠形式（MSYS ssh 认，Windows OpenSSH 也认），
**不要用 `/d/...`**。

### 坑 4：rsync 必须配 MSYS 版的 ssh，不能配 Windows OpenSSH

**症状**：rsync 刚开始就断，输出像

```
Connection to ocdev.aixifs.com closed by remote host.
rsync: connection unexpectedly closed (0 bytes received so far) [sender]
rsync error: unexplained error (code 255) at io.c(...) [sender=3.5.1]
```

**原因**：rsync 通过 `-e ssh` 走的是**二进制协议流**，Windows OpenSSH 在某些组合下会做
文本模式转换 / 缓冲处理，把协议数据冲坏。这不是「连不上」——ssh 单独跑是好的，
只有 rsync 走它才炸。

**修法**：调用 rsync 前把 **MSYS 的 ssh** 前置到 `PATH`：

```powershell
# C:\Program Files\Git\usr\bin\ssh.exe
$env:PATH = (Split-Path -Parent $MsysSsh) + ';' + $env:PATH
```

脚本会自动探测 Git 自带 `usr\bin\ssh.exe` 等候选路径，找到就用。
单独连服务器做探测时仍可用 Windows OpenSSH（无 rsync 协议流）。

### 坑 5：MSYS ssh 从 PowerShell 启动时 HOME 变了

**症状**

```
Failed to add the host to the list of known hosts (/home/huawei/.ssh/known_hosts).
Host key verification failed.
```

或提示找不到私钥。

**原因**：MSYS ssh 在纯 PowerShell 环境里启动时，**MSYS 运行时没被初始化**，
`HOME` 退化成 `/home/<user>`（Windows 上并不存在这个目录）。
于是 known_hosts 写不进去、`~/.ssh/` 下的 key 也找不到。
在 Git Bash 里跑没这问题，因为那里的 HOME 已被设成 `C:\Users\<user>`。

**修法**：显式指定 known_hosts，并且用 `D:/...` 形式的密钥路径：

```powershell
$sshArgs += @('-o', "UserKnownHostsFile=$env:USERPROFILE\.ssh\known_hosts".Replace('\','/'))
```

### 坑 6：Windows 拼子进程命令行会吃掉引号

**症状**：远端命令里带引号的部分失效。最典型的是识别服务名时拿到空字符串，或者
`awk '{print $1}'` 什么都不输出——**但脚本不报错**，只是后面用了空值。

**原因**：PowerShell 把参数数组拼成命令行字符串再交给 Windows `CreateProcess`，
中间的转义层次（PS → cmd → sh）会把 `'...'` 或 `"..."` 剥掉一层。
远端 `sh` 收到的是没有引号的裸参数，被 shell 重新分词。

**修法**：远端脚本**先 base64 编码传过去，再在远端解码执行**，彻底绕开引号：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
& ssh @sshArgs $Target "echo $b64 | base64 -d | bash"
```

脚本里所有多行/带引号的远端操作（备份、校验、重启）都走这条路。
**改脚本时别图省事改回内联字符串。**

---

## 5. 事故复盘：`icacls /inheritance:r` 会先把 DACL 清空

**这是本文最重要的一条——差点让唯一的部署私钥变成谁都读不了。**

**经过**

1. Windows OpenSSH 报 `permissions are too open`，拒绝加载 `D:\.ssh\id_ed25519`。
2. 为了收紧权限，**分两步**执行：

   ```powershell
   icacls $key /inheritance:r          # ← 第一步：移除所有继承 ACE
   icacls $key /grant:r "USER:(R)"     # ← 第二步：想加回来，但已经无权写入
   ```

3. 第一步执行完，文件的 DACL 变成**空**。空 DACL = **拒绝所有人**，
   连 owner 的隐含 `WRITE_DAC` 也不放行。
4. 第二步直接失败 → 文件当场变成**谁都读不了，包括 Git Bash 的 ssh**。
5. 非提权会话无法恢复：`Set-Acl` / `[IO.File]::SetAccessControl()` 都报
   「尝试执行未经授权的操作」——写 DACL 本身就需要权限。

**恢复**：必须提权。用 `Start-Process -Verb RunAs` 弹一次 UAC 跑 `icacls`，
再验证密钥字节数（419 字节，ed25519 正常）：

```powershell
Start-Process icacls.exe -ArgumentList @($key,'/inheritance:r','/grant:r',"$me:(F)") -Verb RunAs -Wait
[IO.File]::ReadAllBytes($key).Length
```

**正确写法（一条命令，原子完成）**

```powershell
icacls "D:\.ssh\id_ed25519" /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(F)"
```

**教训**

- 改 ACL 前先想清楚**会不会把唯一的访问路径也切掉**。收紧权限和恢复权限是两回事，
  中间态一旦不可访问就再也改不回来（除非提权）。
- 不可再生资产（私钥、证书）的权限变更必须**一条命令完成**，不能分步试错。
- 动手前先备份一份密钥到安全位置，成本几乎为零。

---

## 6. SSH 触发 `Exceeded MaxStartups`

**症状**

```
kex_exchange_identification: banner line 0: Exceeded MaxStartups
Connection closed by 1.14.182.208 port 13122
```

同时 TCP 端口探测**仍然「可连」**。

**原因**：服务端 sshd 的**未认证连接数**打满（`MaxStartups`），常见诱因是短时间多次
ssh——部署脚本探测 + 手动重试 + 轮询重连叠加。**不是网络不通，也不是密钥问题**，
更不是封 IP（TCP 层能握手）。通常几分钟到十几分钟自愈（实测一次 20s 恢复、另一次 3 分钟仍失败）。

**修法**

- **别写重试循环**。每次重试都是一次新的未认证连接，越试越糟。
- **sh 版已改为始终启用连接复用**，整轮部署只握一次手：

  ```bash
  -o ControlMaster=auto -o ControlPath=<mktemp dir>/octop-deploy-%r@%h:%p -o ControlPersist=180
  ```

  > 历史 bug：原来只在**密码模式**才启用复用，且 `ControlPath` 引用了未定义的 `$TMPDIR`
  > （本机没这个变量，路径退化成 `/octop-deploy-...`）。两处都已修。
- **ps1 版没有连接复用**：Windows 自带的 OpenSSH 不支持 `ControlMaster`，一轮部署会开
  4~6 条独立 SSH 连接，更容易撞上限流。已经撞上了就**改用 sh 版**（Git Bash 里跑
  `bash scripts/deploy-dashboard.sh`），或者把部署拆成「先同步、后单独验证」两步。
- 已经撞上了就**等 3~10 分钟再跑一次**，不要循环。

---

## 7. 与其它部署路径的关系

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| `scripts/deploy-dashboard.ps1` | **Windows 开发机（推荐）** | rsync 增量 + 备份 + 校验，一条命令 |
| `scripts/deploy-dashboard.sh` | Git Bash / Linux / macOS | 行为一致，参数名带 `--` |
| zip 上传解压覆盖 | SSH 完全不可用的兜底 | 产物打 zip，解压到 `/opt/Octop/src/octop/dashboard/` 覆盖 |
| 服务器本地 `make build-frontend` | **不要用** | 生产机 2 核 3G 跑 vite 会 OOM；`.githooks/local.env` 已设 `SKIP_FRONTEND=1` |

产物落在 `src/octop/dashboard/`（`vite.config.ts` 的 `outDir` 写死），
且 **`.gitignore` 排除了该目录**——产物不入 git，走「构建 → 同步」而不是「提交产物」。

---

## 8. 与 sh 版的差异

| | ps1（Windows） | sh（Git Bash / Linux） |
|---|---|---|
| 本机 rsync 有 | `rsync` 直连增量 | `rsync` 直连增量 |
| 本机 rsync 无 | `scp` 上传到远端临时目录 → 远端 `rsync -a` 镜像 | `tar` 流上传 → 远端 `rsync -a` 镜像 |
| 远端要求 | **服务器必须装了 rsync**（镜像那一步靠它） | 同左 |
| SSH 连接复用 | 无（Windows OpenSSH 不支持 `ControlMaster`） | 有（`ControlMaster=auto`） |
| 密码登录回退 | 无（探测走 `BatchMode=yes`，只能用密钥） | 有 |

两版共同的硬要求：**上传内容必须先在远端临时目录校验通过**（`index.html` 存在）才做镜像，
否则 `rsync --delete` 会拿空目录把线上前端清掉。

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [deployment-pitfalls.md](deployment-pitfalls.md) | 子路径部署 / 反代 / 502 / 渲染下载慢等通用踩坑 |
| [configuration.md](configuration.md) | `config.json`、`OCTOP_BASE_PATH`、前缀配置 |
| [backend-mvp-v01-deployment.md](backend-mvp-v01-deployment.md) | 服务器侧部署与已知限制 |
| [base-path-deployment.md](base-path-deployment.md) | 子路径部署的完整做法 |
