# CNB 镜像链路（GitHub → CNB）

> 本文档记录 Octop 仓库的 GitHub → CNB 单向镜像链路：仓库地址形态、凭据存放位置、
> 三条触发链、本机与生产机的 git 远程配置，以及 2026-11-01 在开发机上的验证结论。
>
> 相关文件：`.cnb.yml`（CNB 流水线）、`.github/workflows/mirror-to-cnb.yml`（镜像工作流）、
> `scripts/sync_github_to_cnb.sh`（同步脚本）。

## 1. 链路总览

```
        push                                  push (CI)
   ┌──────────┐                          ┌───────────────┐
   │  GitHub  │ ───────────────────────► │     CNB       │
   │  origin  │  mirror-to-cnb.yml       │ mengxa.com/   │
   │  zhuimeng2026-hub/Octop             │    Octop      │
   └──────────┘                          └───────────────┘
        ▲                                       ▲
        │ 01:15 cron                            │ 01:40 cron (3 repos)
        │ 01:40 cron (3 repos)                  │ 02:30 workflow fallback
        └──── ocdev:/opt/Octop ──────────────────┘
```

方向是**单向**的：GitHub → CNB。CNB 上若被直接改动（比如 CNB 的 NPC 自动提 PR），
不会自动回灌 GitHub；反向体检由服务器上的 `cnb-check` cron 负责（只读、只报告）。

## 2. 仓库地址形态

CNB 仓库 slug 是 `mengxa.com/Octop` —— **namespace 本身带斜杠**，
所以 "host/path" 二段式的直觉在这里不成立：

| 用途 | 地址 |
|---|---|
| 网页 | `https://cnb.cool/mengxa.com/Octop` |
| git clone / remote | `https://cnb.cool/mengxa.com/Octop.git` |
| SSH | `git@cnb.cool:mengxa.com/Octop.git`（**本机不通**，见 §6） |

CNB 端同时提供 PR（`refs/pull/<n>/head`）与 notes（`refs/notes/npc-push`）引用，
`git ls-remote` 会一并列出——镜像脚本只处理 `refs/heads/*` 和 `refs/tags/*`。

## 3. 凭据

CNB 的 Personal Access Token（git 相关 scope）：

| 位置 | 内容 |
|---|---|
| 生产机 `ocdev.aixifs.com` | `/root/.git-credentials`，`credential.helper = store`，**用户名固定 `cnb`** |
| 同机条目 | 按仓库路径分四条：`Octop` / `weixin-ClawBot-API` / `obsidian-xiaolvshu` / `WeChatBridge` |
| GitHub Actions | 仓库 Secrets `CNB_TOKEN`（必填）、`CNB_USERNAME`（选填，默认 `cnb`）、`CNB_REPO`（选填，默认 `mengxa.com/Octop`） |
| 开发机（Windows） | `C:\Users\huawei\.git-credentials`，2026-11-01 从生产机同步 `Octop` 那一条 |

凭据文件形如：

```
https://cnb:<TOKEN>@cnb.cool/mengxa.com/Octop.git
```

生产机上的 `cnb` remote 与本机一致，因此同一份凭据在两边通用。

## 4. 触发链

| 触发者 | 位置 | 作用 |
|---|---|---|
| GitHub Actions | `.github/workflows/mirror-to-cnb.yml` | 推 GitHub 后即时同步（秒级）；全分支 + 全标签；只快进不带 force |
| 生产机 cron | `/etc/cron.d/octop-git-sync` → `/opt/Octop/scripts/sync_github_to_cnb.sh` | 每天 01:15 兜底同步 Octop |
| 生产机 cron | `/etc/cron.d/cnb-git-sync-all` → `/usr/local/bin/cnb-git-sync-all` | 每天 01:40 同步三个仓库 |
| GitHub Actions | 同上工作流的 `schedule`（30 18 * * *，UTC+8 02:30） | 兜底；fork 下 schedule 通常不触发 |
| 生产机 cron | `/etc/cron.d/cnb-check` | 每 4 小时 CNB → GitHub 只读体检，只报告不 merge |

## 5. 远程配置（生产机与开发机现已对齐）

```
remote.origin.url      git@github.com:zhuimeng2026-hub/Octop.git
remote.origin.fetch    +refs/heads/*:refs/remotes/origin/*
remote.origin.pushurl  git@github.com:zhuimeng2026-hub/Octop.git
remote.origin.pushurl  https://cnb.cool/mengxa.com/Octop.git      ← 双写
remote.cnb.url         https://cnb.cool/mengxa.com/Octop.git
remote.cnb.fetch       +refs/heads/*:refs/remotes/cnb/*
```

`origin` 挂两个 pushurl，所以 `git push origin` 会**同时**写 GitHub 和 CNB。

> **坑：多 pushurl 会污染远程追踪引用。**
> `git push` 成功后会更新 `refs/remotes/origin/*`；即使只有其中一个 pushurl 真正写成功，
> 追踪引用也可能指向"只存在于另一端"的提交。这就是 `scripts/sync_github_to_cnb.sh`
> 坚持用 `git ls-remote` 取权威 SHA、显式 `git push cnb "$sha:refs/heads/$branch"`、
> 绕开 `git push origin` 的原因（见脚本第 68-70 行注释）。
>
> **结论：日常同步用 `git push cnb`，不要用 `git push origin`。**

## 6. 本机（Windows / Git Bash）跑同步脚本

脚本 `scripts/sync_github_to_cnb.sh` 默认面向 Linux 生产机，本机要处理两处：

| 坑 | 现象 | 处理 |
|---|---|---|
| Git Bash 没有 `flock`（util-linux 才有） | 脚本第 37-41 行的锁会失败 → 打印"已有同步任务在运行，本次跳过"后 `exit 0`，**静默什么都不做** | 在 PATH 上放一个返回 0 的最小 `flock` shim |
| `REPO_DIR` 默认 `/opt/Octop` | 找不到仓库直接退出 | 显式传 `REPO_DIR=D:/Octop` |

```bash
mkdir -p /tmp/octop-shim && printf '#!/bin/sh\nexit 0\n' > /tmp/octop-shim/flock && chmod +x /tmp/octop-shim/flock
REPO_DIR='D:/Octop' GIT_TERMINAL_PROMPT=0 PATH="/tmp/octop-shim:$PATH" bash scripts/sync_github_to_cnb.sh
```

`GIT_TERMINAL_PROMPT=0` 是保险：凭据缺失时直接失败，而不是卡住等输入。

脚本产物落在 `$REPO_DIR/.git-sync/`（`latest-report.md` + `anomalies/<ts>.md`），
该目录已在 `.gitignore` 里，不会脏工作区。

### 脚本行为要点

- **只快进，不 force**：CNB 端被直接改动导致分叉时推送被拒 → 记为异常 → 交人工判断。
- **陈旧分支清理**（第 160-211 行）：CNB 独有且内容已并入 `main`/`develop` 的分支会被删除；
  内容独有的保留并记录。判定用 `merge-base --is-ancestor` + `git cherry`（patch-id）双保险，
  避免 cherry-pick / rebase 过的分支被误判为"未合并"。
- **CNB 独有的 `ci/reports` 会被保留** —— 它是 CI 的 pytest 失败清单分支，内容不在主线。

## 7. 验证结论（2026-11-01，开发机）

| 检查 | 命令 | 结果 |
|---|---|---|
| 匿名读 | `git ls-remote https://cnb.cool/mengxa.com/Octop.git` | ✅ 公开可读 |
| SSH 通道 | `git ls-remote git@cnb.cool:mengxa.com/Octop.git` | ❌ `Network is unreachable`（到 22 端口不通） |
| 凭据解析 | `git credential fill` (host=cnb.cool) | ✅ `username=cnb` + token 长度 27 |
| 推送通道认证 | `git push --dry-run cnb main` | ✅ `Everything up-to-date` |
| 双通道认证 | `git push --dry-run origin main` | ✅ 两行 `Everything up-to-date`（GitHub SSH + CNB HTTPS 各一） |
| 引用一致性 | `git ls-remote --heads --tags origin` vs `cnb` | ✅ 逐条一致，唯一差异是 CNB 独有的 `ci/reports` |
| 脚本实跑 | `scripts/sync_github_to_cnb.sh`（REPO_DIR=D:/Octop） | ✅ 9 分支 + 4 组标签全部 ✓，报告"已对齐"，退出码 0 |

### 已知缺口

**per-ref 写权限未被实证。** 上述推送全是 no-op——两端 SHA 本就一致，git 在**本地**就判定
`Everything up-to-date`，push 命令根本没有发到服务端，服务端的写权限检查一次都没执行过。

严格结论是：**token 有效、读权限确认、写权限缺一次真实落盘的证据**。
CNB 按仓库授权，认证能过说明该 token 覆盖 `mengxa.com/Octop`；另外生产机上
**同一份凭据每天 01:15/01:40 在成功推送**，这本身就是写权限的持续证明。

要补实证，两条命令任选（都不会污染主线）：

```bash
# A. 真写一次再删
git push cnb HEAD:refs/heads/tmp/cred-check && git push cnb --delete tmp/cred-check

# B. 非快进探测（不产生任何改动）：用一个不在 main 历史里的提交推 main，
#    服务端必然拒绝，但拒绝原因能反证写权限——non-fast-forward = 权限通过，
#    not allowed to push = 权限真有问题
git push cnb 606362301c06c735fb48fca687d4a33c88a124b7:refs/heads/main
```

## 8. 排障速查

```bash
# 两端引用差异
git ls-remote --heads --tags origin | sort > /tmp/o.txt
git ls-remote --heads --tags cnb    | sort > /tmp/c.txt
diff -u /tmp/o.txt /tmp/c.txt

# CNB 端多出来的提交
git log --oneline origin/main..cnb/main

# 生产机同步报告
ssh ocdev.aixifs.com cat /opt/Octop/.git-sync/latest-report.md
ssh ocdev.aixifs.com cat /var/log/cnb-check.log | tail -50
```

## 9. 另一个本地陷阱：`uv.lock` 被私有源污染

在局域网私有源（如 `http://192.168.20.173:4874/simple/`）上跑过 `uv sync` 之后，
`uv.lock` 里所有 `source = { registry = ... }` 会被改写成私有源地址（248 处），
**直接提交会导致 CI 在公网拉不到包**。恢复：

```bash
git restore uv.lock
```

提交前用 `git diff --stat uv.lock` 检查是否出现大量 `source` 行变更。
