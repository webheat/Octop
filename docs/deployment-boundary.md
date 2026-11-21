# 前后端部署边界契约

> **一句话契约（MUST）**：产物是前端与后端之间**唯一**的交接物。
> **后端环境 NEVER 构建前端。** 看到 `dashboard/` 源码变化不是构建理由。

本文是"谁在哪编译、产物怎么交接"的**唯一权威说明**。前端与后端的 LLM 都必须先读 §0，
再跳到自己那一节。其它文档（`windows-deploy-script.md`、`deployment-pitfalls.md`、
`base-path-deployment.md`）只补充**具体操作细节**，不重新定义边界。

---

## 0. 先判断你在哪个环境（MUST）

在做任何构建/部署动作之前，先回答：**我现在是前端环境还是后端环境？**

| 判据 | 前端环境 | 后端环境 |
|------|---------|---------|
| 典型载体 | 本地开发机 / 前端 CI job | 生产服务器 `ocdev.aixifs.com` / 后端 CI job |
| 有 Node/npm | 有（`dashboard/node_modules` 可 `npm ci`） | **默认 PATH 里无**（本机 nvm 目录下装了，但**不得使用**，见下） |
| 可写源码 | `dashboard/` 可写 | 只读 / 根本没有 `dashboard/` 源码 |
| 你的交付物 | `src/octop/dashboard/` 里的静态文件 | 运行中的 `octop.service` |

**关键事实**：`src/octop/dashboard/**` 在 `.gitignore:83` 中被排除，产物**不入版本库**。
后端环境通过 `git pull` 拿到的永远是后端源码，不是前端源码。因此"后端环境发现前端代码
变化"在正常情况下**不可能发生**——如果你在后端环境看到了 `dashboard/` 的变化，说明你
处在共享工作区里，此时你的身份是后端，**正确动作依然是 NO-OP**（见 §2）。

**本机（`/opt/Octop`，后端环境）的具体形态**：`dashboard/` 源码与 `src/octop/dashboard/`
产物同处一棵树（共享工作区）；Node 装在 `/root/.nvm/` 下但**不在默认 PATH**。这些都
不改变判定——身份是后端，动作是 NO-OP。真正兜底的是 §4 的内存约束，不是"没有 Node"。

---

## 1. 职责边界

### 前端环境（拥有 `dashboard/`）

| | |
|---|---|
| **拥有** | `dashboard/` 全部源码（`src/`、`index.html`、`vite.config.ts`、`package.json`） |
| **产出** | `src/octop/dashboard/` 静态产物（`index.html` + `assets/index.<hash>.js`） |
| **构建命令** | `cd dashboard && BASE_URL=/videogen npm run build`，或 `make build-frontend BASE_URL=/videogen` |
| **交接** | 构建后用 `bash scripts/deploy-dashboard.sh` 同步产物到后端环境 |
| **NEVER** | 手改 `src/octop/dashboard/`（它是产物，会被下次构建覆盖）；把 `BASE_URL` 配成与后端 `base_path` 不同的值 |

### 后端环境（拥有 `src/octop/` 与服务）

| | |
|---|---|
| **拥有** | `src/octop/` 后端源码、`config.json`、`octop.service`、产物目录的**运行副本** |
| **产出** | 运行中的服务（只读托管 `src/octop/dashboard/`） |
| **合法动作** | `git pull` 后 `systemctl restart octop.service`（editable 安装无需重装）；必要时重同步产物 |
| **NEVER** | 运行 `npm` / `npx` / `vite` / `npm run build` / `make build-frontend`；install Node；手改产物目录 |

---

## 2. 触发式决策表（核心，LLM 请逐条匹配）

匹配规则：从上往下找第一条符合的行，只执行该行的动作，不要自由发挥。

| # | IF 你观察到 | AND 你在 | THEN 动作 | NEVER |
|---|------------|---------|----------|-------|
| 1 | `dashboard/` 下有源码变化 | **后端环境** | **NO-OP**：不改任何文件、不构建。仅在回复中说明"前端源码变更应由前端环境构建后同步" | `npm run build` / `make build-frontend` / `cd dashboard && …` |
| 2 | `dashboard/` 下有源码变化 | **前端环境** | `BASE_URL=<后端 base_path> npm run build` → `bash scripts/deploy-dashboard.sh` | 跳过 `--build` 后的产物新鲜度检查（`OCTOP_DEPLOY_ALLOW_STALE=1` 仅在明确知晓时） |
| 3 | 线上面板白屏、`/assets/index.<hash>.js` 404 | 任意 | 检查 `index.html` 里的资源路径是否带 `base_path` 前缀；不带 = 前端没用 `BASE_URL` 构建 → 回前端环境重建（见 `deployment-pitfalls.md` §1） | 改后端 `base_path` 去迁就前端产物 |
| 4 | 产物目录为空 / 缺 `index.html` | 后端环境 | 从上一个备份恢复，或通知前端环境重同步 | `npm ci` / `npm run build` / 在服务器上生成产物 |
| 5 | 需要更新线上前端 | 后端环境 | 只做"同步来源"确认：产物来自前端环境且 hash 匹配；不匹配则退回前端环境 | 任何形式的本地编译 |
| 6 | `git pull` 后前端产物没变 | 后端环境 | 正常：产物本就不在 git 里。`systemctl restart octop.service`（如需） | 认为"构建没跑"而补跑 build |

**给 LLM 的判定口诀**：*后端环境遇到前端变化 → 动作是"报告 + 停手"，不是"修复 + 构建"。*
LLM 面对变化必须产生一个动作；如果你不选择 NO-OP，就会默认选择一个错误动作。

---

## 3. 交接协议（产物怎么算有效）

一个可部署的前端产物必须同时满足：

1. `src/octop/dashboard/index.html` 存在，且入口是 `assets/index.<hash>.js`（`grep -oE 'assets/index\.[A-Za-z0-9_-]+\.js'` 能取到）；
2. **构建期 `BASE_URL` == 后端运行期 `base_path`**（`config.json` 的 `base_path` / env `OCTOP_BASE_PATH`）。前缀不一致 → 白屏、API 401、路由 404（`deployment-pitfalls.md` §1–2）；
3. 产物比 `dashboard/src` 新——`deploy-dashboard.sh:111-124` 有新鲜度闸门，过期会中止同步；
4. 通过 `bash scripts/deploy-dashboard.sh --dry-run` 预览后，再执行同步（脚本自动备份、`--delete` 清旧 hash、校验入口 hash、线上探活）。

产物落点：`/opt/Octop/src/octop/dashboard`（服务端由 `src/octop/api/app.py` 挂载为静态目录）。
前端由后端**实时读盘**托管，通常**不需要重启服务**；只有后端代码变化才 `systemctl restart octop.service`。

---

## 4. 为什么这样设计（rationale，规则冲突时用它推理）

| 事实 | 后果 |
|------|------|
| 生产机 2 核 3G / 2.6G 内存 | 跑 vite 会 **OOM**；`make build-frontend` 明确"不要用" |
| 产物 `gitignored` | 前端源码变化**不会**通过 git 到达后端环境；边界是物理成立的 |
| 同仓不同部署单元 | "一个 Python wheel" 是交付形态，**不意味着**部署时前后端同机同构建 |
| 构建期写死路径 | `BASE_URL` / `basename` / SW scope 都编进 bundle，后端 `base_path` 改不了已构建产物 |

结论：**构建是前端环境的职责，后端环境只消费产物。** 这不是流程建议，是环境能力决定的硬约束。

---

## 5. 门禁清单（不依赖"理解"，靠机制兜底）

- [x] 生产机默认 PATH 不含 Node/npm（nvm 里即使装了也不使用；最强的物理约束其实是内存，见 §4）
- [x] `.gitignore:83` 排除产物目录，前后端源码/产物不混入版本库
- [x] `deploy-dashboard.sh` 产物新鲜度闸门 + 入口 hash 校验 + 自动备份
- [ ] CI 拆成 frontend build job（产出 artifact）与 backend deploy job（只下载，无 npm）
- [ ] 产物目录对后端部署账号设为只读

前 3 项是当前已有事实；后 2 项是后续工程化建议（不在本次文档+指令改动范围内）。

---

## 相关文档

| 文档 | 内容 |
|------|------|
| `docs/deployment-pitfalls.md` | 子路径部署、反代、OOM 等踩坑（症状→原因→修法） |
| `docs/windows-deploy-script.md` | `deploy-dashboard.ps1` 用法与 Windows/PS 5.1 硬坑 |
| `docs/base-path-deployment.md` | `base_path` 完整配置 |
| `AGENTS.md` §8 / `CLAUDE.md` | LLM 入口指令（本文规则已同步到此，两处冲突时以本文为准） |
