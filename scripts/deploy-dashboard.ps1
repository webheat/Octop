<#
.SYNOPSIS
  一键把本机构建好的 Dashboard 产物同步到远端服务器（Windows PowerShell 版）。

.DESCRIPTION
  与 scripts/deploy-dashboard.sh 行为一致：默认 --delete 清理旧 hash 文件，
  保留 __init__.py / .gitkeep，同步前自动备份上一版（远端保留 5 份），
  同步后做入口 hash 比对 + 线上 health 探活。

  传输方式：优先本机 rsync 做真增量；没有 rsync 时退化为 scp 上传到远端临时目录，
  再由远端 rsync 做镜像，落地语义保持一致。

.PARAMETER Build
  先构建前端（BASE_URL=/videogen）再同步。

.PARAMETER DryRun
  只预览差异，不写远端。

.PARAMETER NoDelete
  保留远端旧 hash 文件（默认会清理）。

.PARAMETER NoBackup
  跳过远端备份。

.PARAMETER Restart
  同步后重启 octop 服务（通常不需要，前端是实时读盘）。

.PARAMETER NoVerify
  跳过线上探活。

.PARAMETER Help
  显示本帮助。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-dashboard.ps1 -DryRun

.EXAMPLE
  .\scripts\deploy-dashboard.ps1 -Build

.NOTES
  可用环境变量覆盖（与 sh 版一致）：
    OCTOP_DEPLOY_HOST / _PORT / _USER / _DST / _KEY / _VERIFY / _BASE_PATH
    OCTOP_DEPLOY_KEEP_BACKUPS / _BACKUP_ROOT / _SRC
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$DryRun,
  [switch]$NoDelete,
  [switch]$NoBackup,
  [switch]$Restart,
  [switch]$NoVerify,
  [string]$Server,
  [int]$Port,
  [string]$RemoteUser,
  [switch]$Help
)

# 注意：必须是 Continue。PowerShell 5.1 在 ErrorActionPreference=Stop 下，
# 原生命令（ssh/rsync/scp）的 stderr 经 2>&1 会被包装成 NativeCommandError 直接中断脚本，
# 而 ssh 的 host-key 提示、rsync 的 --info 统计都会走 stderr。所有外部命令统一用 $LASTEXITCODE 判定。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "    $m" }
function Warn([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ""; Write-Host "[ERROR] $m" -ForegroundColor Red; exit 1 }

# rsync 会把 "D:/..." 里的冒号误判成 host:path（报 "source and destination cannot both be remote"），
# 所以给 MSYS 工具用的本地路径要转成挂载风格 /d/Octop/...
function To-MsysPath([string]$path) {
  $full = (Resolve-Path -LiteralPath $path).Path
  if ($full -match '^([A-Za-z]):(.*)$') {
    return ('/' + $matches[1].ToLower() + ($matches[2] -replace '\\', '/'))
  }
  return ($full -replace '\\', '/')
}

if ($Help) {
  Get-Help $PSCommandPath -Detailed
  exit 0
}

# ---------- 配置（参数 > 环境变量 > 默认值） ----------
if (-not $Server) { $Server = if ($env:OCTOP_DEPLOY_HOST) { $env:OCTOP_DEPLOY_HOST } else { 'ocdev.aixifs.com' } }
if (-not $Port) { $Port = if ($env:OCTOP_DEPLOY_PORT) { [int]$env:OCTOP_DEPLOY_PORT } else { 13122 } }
if (-not $RemoteUser) { $RemoteUser = if ($env:OCTOP_DEPLOY_USER) { $env:OCTOP_DEPLOY_USER } else { 'root' } }

$Dst = if ($env:OCTOP_DEPLOY_DST) { $env:OCTOP_DEPLOY_DST } else { '/opt/Octop/src/octop/dashboard' }
$VerifyUrl = if ($env:OCTOP_DEPLOY_VERIFY) { $env:OCTOP_DEPLOY_VERIFY } else { 'https://ocbot.aixifs.com/videogen' }
$BasePath = if ($env:OCTOP_DEPLOY_BASE_PATH) { $env:OCTOP_DEPLOY_BASE_PATH } else { '/videogen' }
$KeepBackups = if ($env:OCTOP_DEPLOY_KEEP_BACKUPS) { [int]$env:OCTOP_DEPLOY_KEEP_BACKUPS } else { 5 }
$BackupRoot = if ($env:OCTOP_DEPLOY_BACKUP_ROOT) { $env:OCTOP_DEPLOY_BACKUP_ROOT } else { '/opt/octop-data/dashboard-backups' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Src = if ($env:OCTOP_DEPLOY_SRC) { $env:OCTOP_DEPLOY_SRC } else { Join-Path $RepoRoot 'src\octop\dashboard' }
$Target = "$RemoteUser@$Server"

# ---------- 0. 本地检查 ----------
Say '本地检查'

$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $sshCmd) { Fail '找不到 ssh，请先安装 OpenSSH 客户端' }
if (-not (Test-Path -LiteralPath $Src)) { Fail "产物目录不存在: $Src" }

# rsync 可能装在 C:\tools\rsync 但 PATH 未刷新
function Find-Rsync {
  $c = Get-Command rsync -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @('C:\tools\rsync\rsync.exe', "$env:ProgramFiles\cwRsync\bin\rsync.exe", "$env:ProgramFiles\Git\usr\bin\rsync.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}
$RsyncExe = Find-Rsync

# rsync 是 MSYS 程序，若 spawn 到 Windows 自带的 OpenSSH，stdin/stdout 文本模式会把
# rsync 协议流冲坏（典型报错：rsync: connection unexpectedly closed ... protocol data stream）。
# 有 rsync 时优先把 MSYS 版 ssh 放到 PATH 最前面。
$MsysSsh = $null
if ($RsyncExe) {
  $sshPat = @(
    "$env:ProgramFiles\Git\usr\bin\ssh.exe",
    "${env:ProgramFiles(x86)}\Git\usr\bin\ssh.exe",
    "$env:USERPROFILE\.workbuddy\binaries\PortableGit\versions\*\usr\bin\ssh.exe"
  )
  foreach ($pat in $sshPat) {
    $hit = Get-Item -Path $pat -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $MsysSsh = $hit.FullName; break }
  }
  if ($MsysSsh) {
    $env:PATH = (Split-Path -Parent $MsysSsh) + ';' + $env:PATH
    # MSYS 程序从 PowerShell 启动时 HOME 可能指向不存在的 /home/<user>，
    # 会让 ssh 找不到 ~/.ssh/known_hosts 甚至建目录失败。对齐成 Windows 用户目录。
    if (-not $env:HOME -or $env:HOME -notmatch '^[A-Za-z]:') { $env:HOME = $env:USERPROFILE }
  } else {
    Warn '没找到 MSYS 版 ssh，rsync 可能因协议流被打断而失败；将退化为 Windows ssh + scp 模式'
    $RsyncExe = $null
  }
}

if ($Build) {
  $dashDir = Join-Path $RepoRoot 'dashboard'
  if (-not (Test-Path -LiteralPath $dashDir)) { Fail "找不到前端目录: $dashDir" }

  # vite 的 emptyOutDir 会批量删除，容易被安全策略拦截，这里先手动清空
  if (Test-Path -LiteralPath $Src) {
    Get-ChildItem -LiteralPath $Src -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $Src)) { New-Item -ItemType Directory -Path $Src -Force | Out-Null }

  Info "构建前端（BASE_URL=$BasePath）…"
  $env:BASE_URL = $BasePath
  Push-Location $dashDir
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail '构建失败' }
  } finally {
    Pop-Location
    Remove-Item Env:BASE_URL -ErrorAction SilentlyContinue
  }
}

$indexPath = Join-Path $Src 'index.html'
if (-not (Test-Path -LiteralPath $indexPath)) { Fail "$Src 里没有 index.html，先加 -Build 或手动构建" }

$indexHtml = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
$m = [regex]::Match($indexHtml, 'assets/index\.[A-Za-z0-9_-]+\.js')
$LocalEntry = if ($m.Success) { $m.Value } else { '' }

$files = Get-ChildItem -LiteralPath $Src -Recurse -File
$LocalFiles = $files.Count
$LocalMb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)

Info "源目录   : $Src"
Info "文件数   : $LocalFiles（$LocalMb MB）"
Info "入口 hash: $(if ($LocalEntry) { $LocalEntry } else { '未识别' })"
Info "目标     : ${Target}:${Port} → ${Dst}"
Info "传输方式 : $(if ($RsyncExe) { "rsync 增量（$RsyncExe）" } else { 'scp + 远端镜像（本机无 rsync，全量上传）' })"

if (-not $LocalEntry) { Warn 'index.html 里没识别到入口 chunk，请确认是不是子路径构建产物' }

# ---------- 1. SSH 参数 ----------
$KeyFile = $env:OCTOP_DEPLOY_KEY
if (-not $KeyFile) {
  foreach ($cand in @('D:\.ssh\id_ed25519', (Join-Path $HOME '.ssh\id_ed25519'), (Join-Path $env:USERPROFILE '.ssh\id_ed25519'))) {
    if ($cand -and (Test-Path -LiteralPath $cand)) { $KeyFile = $cand; break }
  }
}

$sshArgs = @('-p', "$Port", '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4')
$scpArgs = @('-P', "$Port", '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
$sshForKey = "ssh -p $Port -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

# 显式指定 known_hosts：MSYS ssh 从 PowerShell 启动时可能找不到 ~/.ssh（HOME 解析成 /home/<user>）
$knownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'
if (Test-Path -LiteralPath $knownHosts) {
  $khSlash = $knownHosts -replace '\\', '/'
  $sshArgs += @('-o', "UserKnownHostsFile=$khSlash")
  $sshForKey += " -o UserKnownHostsFile=`"$khSlash`""
}

if ($KeyFile -and (Test-Path -LiteralPath $KeyFile)) {
  # scp 用 Windows OpenSSH（Windows 路径）；ssh 可能是 MSYS 版，用 D:/... 形式两种都认，
  # 但不能用 /d/... —— MSYS ssh 从 PowerShell 启动时挂载表未初始化，认不出 /d。
  $keyForScp = (Resolve-Path -LiteralPath $KeyFile).Path
  $keyForSsh = $keyForScp -replace '\\', '/'
  $sshArgs += @('-i', $keyForSsh, '-o', 'IdentitiesOnly=yes')
  $scpArgs += @('-i', $keyForScp, '-o', 'IdentitiesOnly=yes')
  $sshForKey += " -i `"$keyForSsh`" -o IdentitiesOnly=yes"
  Info "密钥     : $KeyFile"
} else {
  Warn '没找到私钥，会提示输入密码'
}

# Windows 把参数拼进子进程命令行时会吃掉引号，远端命令里的 awk '{print $1}' 这类引号容易损坏，
# 所以远端脚本一律 base64 传输后解码执行。
function Invoke-RemoteScript([string]$script) {
  # 载荷走 stdin，不走 argv：base64 里含 '/' '+' '=' 等字符，MSYS ssh / Windows 参数拼接
  # 会把这种长参数改写（实测远端收到的脚本被插入换行，test -d 判假、备份被跳过）。
  # 统一先把 CRLF 归一成 LF，避免 Linux bash 读到行尾 \r。
  $script = $script -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  $out = $b64 | & ssh @sshArgs $Target "tr -d '\r\n' | base64 -d | bash" 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{ Output = $out; Code = $code }
}

# ---------- 2. 连接探测 ----------
Say '连接探测'
$probe = & ssh @sshArgs -o BatchMode=yes $Target 'echo SSH_OK' 2>&1
$probeText = ($probe | Out-String)
if ($probeText -notmatch 'SSH_OK') {
  if ($probeText -match 'MaxStartups|Connection closed|Connection reset|kex_exchange') {
    Warn "服务器 SSH 暂时拒绝连接（常见原因：sshd 触发 MaxStartups 限流，或短时间内连接过多被临时封禁）"
    Warn '这不是密钥或网络问题，通常等 3~10 分钟自动恢复，然后重跑本脚本即可。'
    Fail "无法连接 ${Target}:${Port}"
  }
  Fail "无法连接 ${Target}:${Port}`n$($probeText.Trim())"
}
Info 'SSH 连接可用 ✅'

# ---------- 3. 远端现状 ----------
$infoTpl = @'
D="__DST__"
echo "dir=$(test -d "$D" && echo yes || echo no)"
echo "files=$(find "$D" -type f 2>/dev/null | wc -l)"
echo "entry=$(grep -oE 'assets/index\.[A-Za-z0-9_-]+\.js' "$D/index.html" 2>/dev/null | head -1)"
echo "svc=$(systemctl list-units --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -m1 '^octop' || true)"
'@
$infoCmd = $infoTpl.Replace('__DST__', $Dst)
$remoteInfo = Invoke-RemoteScript $infoCmd
$raw = $remoteInfo.Output
if ($remoteInfo.Code -ne 0) { Fail "无法读取远端状态`n$((($raw | Out-String).Trim()))" }

$remote = @{ dir = ''; files = ''; entry = ''; svc = '' }
foreach ($line in ($raw -split "`r?`n")) {
  if ($line -match '^(\w+)=(.*)$') { $remote[$matches[1]] = $matches[2].Trim() }
}

Say '远端现状'
Info "目录     : $Dst（存在=$(if ($remote.dir) { $remote.dir } else { 'no' })）"
Info "文件数   : $(if ($remote.files) { $remote.files } else { '0' })"
Info "入口 hash: $(if ($remote.entry) { $remote.entry } else { '无' })"
Info "服务单元 : $(if ($remote.svc) { $remote.svc } else { '未识别' })"
if ($remote.entry -eq $LocalEntry) {
  Info '状态     : 入口已一致（本次大概率无变化）'
} else {
  Info "状态     : 需要同步 $LocalEntry → $($remote.entry)"
}

$remoteDst = "${Target}:$Dst/"

if ($DryRun) {
  Say 'DRY-RUN（不写远端）'
  if ($RsyncExe) {
    $dryOpts = @('-rlzt', '--chmod=D755,F644', '--exclude=__init__.py', '--exclude=.gitkeep')
    Push-Location $Src
    try {
      & $RsyncExe @dryOpts -n --delete --itemize-changes -e $sshForKey './' $remoteDst
    } finally { Pop-Location }
  } else {
    Info "将上传 $LocalFiles 个文件（$LocalMb MB），远端现有 $(if ($remote.files) { $remote.files } else { '0' }) 个"
    if (-not $NoDelete) { Info '将删除远端多余文件（保留 __init__.py / .gitkeep）' }
    Info '不写入任何内容（dry-run）'
  }
  exit 0
}

# ---------- 4. 远端备份 ----------
if (-not $NoBackup -and $remote.dir -eq 'yes') {
  Say '远端备份上一版'
  $backupTpl = @'
set -e
D="__DST__"
R="__BROOT__"
if [ -f "$D/index.html" ]; then
  mkdir -p "$R"
  TS=$(date +%Y%m%d-%H%M%S)
  cp -a "$D" "$R/$TS"
  ls -1dt "$R"/* 2>/dev/null | tail -n +__KEEP__ | xargs -r rm -rf
  echo "backup=$R/$TS"
else
  echo "skip=empty"
fi
'@
  $backupCmd = $backupTpl.Replace('__DST__', $Dst).Replace('__BROOT__', $BackupRoot).Replace('__KEEP__', "$($KeepBackups + 1)")
  $bRes = Invoke-RemoteScript $backupCmd
  if ($bRes.Code -eq 0) {
    foreach ($l in ($bRes.Output -split "`r?`n")) {
      $t = "$l".Trim()
      if (-not $t) { continue }
      Info $t
      if ($t -match '^backup=(.+)$') { $script:BackupPath = $matches[1] }
    }
  } else {
    Warn '备份失败（不阻断部署）'
  }
}

# ---------- 5. 同步 ----------
Say '同步产物'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($RsyncExe) {
  $opts = @('-rlzt', '--chmod=D755,F644', '--exclude=__init__.py', '--exclude=.gitkeep')
  if (-not $NoDelete) { $opts += '--delete' }
  $opts += @('--info=stats1', '-e', $sshForKey)
  # 用相对路径 ./ 作为源：rsync 会把 D:/... 的冒号当成 host:path，
  # 而这个精简版 rsync 没有 /d 挂载点，/d/... 也认不出。
  Push-Location $Src
  try {
    & $RsyncExe @opts './' $remoteDst
    if ($LASTEXITCODE -ne 0) { Fail 'rsync 同步失败' }
  } finally { Pop-Location }
} else {
  $stage = '/tmp/octop-dash-deploy'
  Info "上传到远端临时目录 $stage …"
  $mk = Invoke-RemoteScript "rm -rf '$stage' && mkdir -p '$stage' && echo STAGE_OK"
  if ($mk.Code -ne 0) { Fail '无法创建远端临时目录' }

  $items = Get-ChildItem -LiteralPath $Src -Force | ForEach-Object { $_.FullName }
  & scp @scpArgs -r @items "${Target}:$stage"
  if ($LASTEXITCODE -ne 0) { Fail 'scp 上传失败' }

  $delFlag = if ($NoDelete) { '' } else { '--delete ' }
  $mirrorCmd = "mkdir -p '$Dst' && rsync -a $delFlag--exclude=__init__.py --exclude=.gitkeep '$stage/' '$Dst/' && echo ""runtime_files=`$(find '$Dst' -type f | wc -l)"" && rm -rf '$stage'"
  $mf = Invoke-RemoteScript $mirrorCmd
  $mf.Output | ForEach-Object { if ("$_".Trim()) { Info "$_".Trim() } }
  if ($mf.Code -ne 0) { Fail '远端镜像失败' }
}

$sw.Stop()
Info "方式: $(if ($RsyncExe) { 'rsync 增量' } else { 'scp → 远端 rsync 镜像' })，耗时 $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"

# ---------- 6. 远端落地校验 ----------
Say '远端校验'
$checkCmd = "grep -oE 'assets/index\.[A-Za-z0-9_-]+\.js' '$Dst/index.html' 2>/dev/null | head -1; echo ""files=`$(find '$Dst' -type f | wc -l)"""
$chkRes = Invoke-RemoteScript $checkCmd
$chkLines = @($chkRes.Output -split "`r?`n" | Where-Object { $_.Trim() })
$remoteEntry = if ($chkLines.Count -gt 0) { $chkLines[0].Trim() } else { '' }
foreach ($l in $chkLines) { Info $l.Trim() }
if ($remoteEntry -eq $LocalEntry) {
  Info '入口一致 ✅'
} else {
  Warn '入口不一致，检查是否同步到了正确的目录'
}

# ---------- 7. 重启服务（可选） ----------
if ($Restart) {
  if (-not $remote.svc) {
    Warn '没识别到 octop 服务单元，跳过重启'
  } else {
    Say "重启 $($remote.svc)"
    $r = Invoke-RemoteScript "systemctl restart '$($remote.svc)' && sleep 2 && systemctl is-active '$($remote.svc)'"
    $r.Output | ForEach-Object { if ("$_".Trim()) { Info "$_".Trim() } }
    if ($r.Code -ne 0) { Fail '重启失败' }
  }
}

# ---------- 8. 线上探活 ----------
if (-not $NoVerify) {
  Say "线上探活 $VerifyUrl"
  $oldProxy = [System.Net.WebRequest]::DefaultWebProxy
  [System.Net.WebRequest]::DefaultWebProxy = $null
  $liveEntry = ''
  $health = ''
  try {
    $resp = Invoke-WebRequest -Uri "$VerifyUrl/" -UseBasicParsing -TimeoutSec 20
    $mm = [regex]::Match($resp.Content, 'assets/index\.[A-Za-z0-9_-]+\.js')
    if ($mm.Success) { $liveEntry = $mm.Value }
    $hresp = Invoke-WebRequest -Uri "$VerifyUrl/api/health" -UseBasicParsing -TimeoutSec 20
    $health = $hresp.Content
  } catch {
    Warn "探活失败: $($_.Exception.Message)"
  } finally {
    [System.Net.WebRequest]::DefaultWebProxy = $oldProxy
  }
  Info "线上入口 : $(if ($liveEntry) { $liveEntry } else { '未取到' })"
  Info "健康检查 : $(if ($health) { $health } else { '失败' })"
  if ($liveEntry -and $liveEntry -eq $LocalEntry) {
    Info '线上已生效 ✅（浏览器按 Ctrl+Shift+R 硬刷新一次即可看到新界面）'
  } elseif ($liveEntry) {
    Warn '线上入口与本地不一致：可能域名指向另一台机器 / CDN 缓存 / service worker 尚未更新'
  }
}

Say '完成'
if ($script:BackupPath) {
  Info "回滚：ssh -p $Port $Target ``cp -a $($script:BackupPath)/. $Dst/``"
}
Info '提示：前端由后端实时读盘，无需重启 octop 服务。'
