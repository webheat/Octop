# 与上游同步（TencentCloud/Octop）

本 fork 的上游是 `https://github.com/TencentCloud/Octop.git`（remote 名 `upstream`）。
本文记录同步基线、冲突面盘点、以及每次同步要走的固定流程。

## 1. 为什么需要这份文档

fork 与上游已经**双向大幅偏离**：

| | 上游自基线起 | fork 自基线起 |
|---|---|---|
| 提交数 | 113 | 182 |
| 改动文件 | 2010 | 380 |
| 代码行 | +108,842 / −159,077 | +37,863 / −1,065 |
| 双方都改过的文件 | — | **108** |

deviation 已经到"每次同步都要人工判断"的程度，靠记忆不可持续。这份文档把
「哪些是必须守住的、哪些可以让给上游、每次怎么走流程」固定下来。

## 2. 当前基线（2026-11-15 实测）

- 共同祖先（merge-base）：`88aee30e`（上游 develop 的 2026-10-25 快照）
- 上游目标：`upstream/develop` = `2104b681`（比 `upstream/main`/`v1.0.3b5` 再多 22 个提交）
- fork 目标：`origin/develop`
- **三方合并实测冲突：67 个文件 / 94 个冲突块**（`git merge-tree --write-tree origin/develop upstream/develop`）
  - 52 个内容冲突（双方都改同一处）
  - 15 个 modify/delete（上游删了、我们改过）
  - 0 个 add/add

### 冲突面分布

| 区域 | 冲突文件数 | 说明 |
|---|---|---|
| `desktop/**` | 16 | 上游把桌面端从 **Go 重写成 Electron**，删掉了全部 `.go`；我们 fork 基于 Go 深度二开 |
| `dashboard/src/**` | 15 | 前端路由/布局/登录页，双方都在改 |
| `src/octop/api/**` | 4 | `auth.py` / `users.py` / `settings.py` / `public_base.py` |
| `src/octop/infra/**` | 3 | `db/migrate.py`、`db/services.py`、`agents/plugins/manager.py` |
| `tests/**` | 9 | 多数是 schema 版本断言 |
| 其他（文档/脚本/打包） | 20 | 低风险 |

### 上游这一轮做了什么（架构级）

1. **桌面端换语言**：Go → Electron/TypeScript（`desktop/src/{main,renderer,preload,shared}`）。
2. **infra 目录再收敛**：`infra/desktop/`、`infra/mobile/`、`infra/browser/` → `infra/control/{desktop,mobile,browser}/`；
   新增 `infra/auth/`（MFA/TOTP/WebAuthn/LDAP）、`infra/migration/`（hermes/openclaw 迁移器）、
   `infra/crypto/`、`infra/market/`、`infra/backup/`。
3. **专家库瘦身**：`infra/agents/experts/library/` 从 ~20 个专家砍到 3 个（`default` / `ops-engineer` / `tencent-cvm-ops`）。
4. **前端新增**：Service Worker（`dashboard/src/sw-register.ts`）、`dashboard/vite/monaco.ts`、`dashboard/src/plugins/`。
5. **新 DB 迁移**：`025_user_mfa`（SQLite + PG 成对）。

### 必须单独决策的点

1. **迁移编号撞车（两侧都已发布，最需要小心的一条）**：

   | 编号 | fork 侧 | 上游侧 |
   |---|---|---|
   | 023 | `023_user_groups`（同源） | `023_user_groups`（同源） |
   | 024 | `024_user_group_profile`（同源） | `024_user_group_profile`（同源） |
   | **025** | `025_skill_package_shared`（已随 v1.2.0 发布） | `025_user_mfa`（已随 v1.0.3b5 发布） |
   | 026 | `026_product_library_reconcile`（已随 v1.2.0 发布） | — |

   两边都把 **025** 用掉了，而且**都已经发布**，所以不能简单地"把 fork 的往后挪"——
   fork 线上库的 `_schema_version` 已经写到 26，上游库写到 25，直接改文件名会让
   老库跳过新迁移（fork 库跳过 `025_user_mfa`，上游库跳过 fork 的 skill/product 迁移）。
   正确做法：
   - 合并后的迁移文件集定为 `023, 024, 025_user_mfa, 026_skill_package_shared, 027_product_library_reconcile`
     （上游的 025 已发布，编号冻结；fork 的两个顺延）；
   - `infra/db/migrate.py` 里补**幂等修复路径**：对 `_schema_version` 已越过某个文件编号的库，
     仍要把该文件的内容补上（AGENTS.md §"Database" 已明确要求 migrate.py 保持幂等且能处理跳号库）；
   - `tests/unit/db/test_db_pool.py` 的版本断言随之更新（fork 现为 `v == 26`，上游为 `v == 25`，
     合并后应为 `v == 27`）。
   - 改完必须**双向实测**：拿一个 fork 老库（v26）和一个上游老库（v25）各升一次，确认都能到 v27 且表齐全。
2. **Go 桌面端去留**：上游已整体转向 Electron，fork 的 Go 客户端（`desktop/src/*.go`）在上游没有对应物。
   15 个 modify/delete 冲突全部来自这里 → 决策只有两个：**保留 Go 客户端**（fork 继续发 `desktop-v1.4.0` 产物）
   或**整体迁移到 Electron**。这是产品决策，不是技术冲突，建议单独开一轮评估，不要混在同步里。

## 3. 每次同步的固定流程

```bash
# 0. 前置：upstream remote 用 SSH（本机 https://github.com:443 拉大包会失败）
git remote set-url upstream git@github.com:TencentCloud/Octop.git

# 1. 取上游
git fetch upstream --prune --no-tags

# 2. 先干跑，看冲突规模（不产生任何提交）
git merge-tree --write-tree --name-only origin/develop upstream/develop | head -200

# 3. 起同步分支（从上游起，merge 回我们；不要在 develop/main 上直接干）
git checkout -b sync/upstream-<上游tag或日期> upstream/develop
git merge origin/develop
#   → 逐个解冲突；rerere 已开，同类冲突第二次会自动复用上次解法

# 4. 验证
uv run pytest -m "not live"          # 后端
cd dashboard && npx tsc -b           # 前端类型检查（本机不做前端构建）
uv run ruff check src tests && uv run mypy src/octop

# 5. PR 回 develop（走 AGENTS.md §10 的 release 分支流程）
```

### 分批原则

- 上游自己就是分批发的（`v1.0.3b1` → `b5`），**以上游 release 为单位分批同步**，不要攒。
- 每批一条独立 `sync/upstream-*` 分支，单独 PR、独立回滚。
- **架构改动批次放最后**：前面几批先把纯功能的改动吃进来，等真正要动 `infra/` 结构时，前面批次已经把调用点都理顺了。

## 4. 长期降冲突（每轮同步顺手做）

- **冲突热点判定**：文件同时出现在「fork 改动集」和「上游改动集」里 → 热点。上游在
  `src/octop/api/app.py`、`infra/agents/manager.py`、`dashboard/src/pages/Chat/**`、
  `dashboard/src/locales/*.json`、`pyproject.toml` 上改得最勤，这些目录要格外小心。
- **能不碰上游文件就不碰**：仓库已有现成的扩展机制——`plugins/`、`infra/skills/`、
  `infra/agents/experts/`、slash handler 注册、`api/routers/` 注册。
  新功能优先走这些口子，别去改上游核心文件。
- **双方各自实现了同一功能**（例如头像选择器、用户组 API 模块）→ 收敛到一处，
  否则每次同步都要人工二次决策。
- **能提回上游的就提回上游**：平台通用的修复（Windows 兼容、CI、文档）往
  `TencentCloud/Octop` 提 PR，能显著减少未来的合并面。已有的通用性改动不要留在 fork 里。
- **版本号解耦**：fork 用 `v1.1.0`~`v1.4.0`，上游用 `v0.9.x`~`v1.0.3b5`。
  两套版本线并存容易让人误读（fork 的 v1.4.0 实际基线是上游 1.0.2）。
  建议 fork 侧版本加前缀（如 `v1.4.0-fork.1`），或在本文件里写明基线对应关系。

## 5. 本机环境的坑（同步时必看）

| 坑 | 表现 | 绕法 |
|---|---|---|
| GitHub HTTPS 拉不动 | `Failed to connect to github.com port 443 after 133509 ms` | upstream remote 走 SSH（`git@github.com:`） |
| GitHub HTTPS 大包慢 | 24MB tarball 耗时 4.5 分钟 | 只在确实需要时拉；`api.github.com` 与 `codeload.github.com` 可用 |
| origin 有两个 pushurl | `git push` 一次同时推 GitHub 和 CNB | 同步分支先确认推送目标，别默认推 `main`/`develop` |
| 共享分支会被强推 | 另一台机器 force push `fix/backend-mvp-v01-integration` | 同步一律用独立分支名 + PR，不在共享分支上直接工作 |
| fork 的 Actions 受限 | push/schedule 不触发，只有 `workflow_dispatch` 有效；工作流须在 `main` 上才注册 | 同步分支的 CI 要手动 dispatch，或本地跑 pytest |
| 本机不做前端构建 | `npm run build` 会 OOM | 前端只做 `npx tsc -b` |
