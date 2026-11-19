# 桌面端「直接对话框」改造（需求说明）

> 状态：**需求已确认，代码未完成**。最后核实 2026-11-19。
> 适用范围：`desktop/` 桌面客户端（thin 远程壳）。**浏览器端行为一律不变。**
>
> 本文只描述需求与现状事实，不含实现代码。相关既有文档：
> [产品素材库导入架构](./product-library-import-architecture.md)、
> [微信开放平台登录](./wechat-open-login.md)、
> [桌面端 Windows 构建](./desktop-windows-build.md)。

---

## 一、需求来源

用户对桌面端聊天页提出的界面诉求：**把「专家 / 团队 / 云端 + 创建专家」这套控制台界面，简化为一个直接的对话框。**

产品定位（已确认）：桌面端是**面向素材管理与视频生成的专用应用**，不是一个通用 Agent 控制台。

---

## 二、为什么这是必要的

现状链路有三个独立的断点，缺一不可地让「桌面端直接聊天」不成立：

| # | 断点 | 现象 | 根因位置 |
|---|---|---|---|
| 1 | **界面层级过重** | 聊天页左栏出现「专家 / 团队 / 云端」三个 Tab、「创建专家」按钮、空态「还没有专家 / 去创建专家」 | `dashboard/src/pages/Chat/components/SessionList.tsx:891-901`、`ChatNavScopeTabs.tsx` |
| 2 | **输入被硬拦** | 即使只有一个助手，主区域仍渲染 `AgentNotReadyScreen`，输入框 `disabled` | `dashboard/src/pages/Chat/index.tsx:242`（`noAgents`）、`:1617-1623`、`:1958-1963` |
| 3 | **账号没有助手** | 微信 SSO 登录建出的账号**一个专家都没有**，聊天接口要求 `agent_id`，无助手即无法发消息 | `src/octop/api/routers/auth_oidc.py` 的 `exchange_login_code_response()` |

第 3 点是**真正的卡点**：只隐藏 UI 不解决它。聊天接口必须带 `agent_id`，
所以桌面端用户登录后必须**自动拥有**一个可用助手。

---

## 三、现状事实（已核实）

### 3.1 微信 SSO 账号确实没有默认助手

- 默认专家引导 `try_bootstrap_default_agent()` 目前**只在 3 处被调用**：
  `api/routers/setup.py:230`（初始化向导）、`api/routers/invites.py:169`（邀请兑换）、
  `api/routers/users.py:418`（带 `template_id` 建号）。
- **`exchange_login_code_response()`（SSO 换码登录）不在其中** → 微信扫码登录的账号没有助手。
- `resolve_or_create_sso_user()`（`infra/users/manager.py:257`）只 seed 素材库示例数据，不碰专家。

### 3.2 默认助手是「可创建」的，且模板可从市场拉取

- `DEFAULT_EXPERT_ID = "general-assistant"`（`infra/agents/experts/default_agent.py:26`）。
- `bootstrap_first_expert()` 会先 `materialize_market_expert()` 从远程市场拉模板；
  市场 `https://octop.cloud/api/market/experts` 已确认包含 `general-assistant` 这个 slug。
- 该函数**幂等**：`bootstrap_default_agent()` 开头 `if registry.list_agents(user_id): return None`，
  已有助手则跳过 → 可以安全地在每次登录时调用。
- `try_bootstrap_default_agent()` 自身 try/except 吞异常并记 warning → **不会阻断登录**。

### 3.3 新建助手的初始状态不是 `running`

- `bootstrap_default_agent()` 调 `registry.create(spec, defer_bootstrap=True)`
  （`default_agent.py:89`），`defer_bootstrap=True` 会把状态置为 `starting` 并
  `asyncio.create_task(self._complete_create_bootstrap(row))` 异步补完启动
  （`infra/agents/manager.py:1019-1026`）。
- 前端 `isAgentChatReady()` 要求 `state === "running"`（`dashboard/src/utils/agentError.ts:91-97`），
  `selectEnabledExperts()` 同样只保留 `running` 或 `bridge_disconnected`
  （`dashboard/src/context/AgentContext.tsx:145-147`）。
- **含义**：刚登录的瞬间助手处于 `starting`，此时仍会命中第 2 点的拦截屏。
  → 需要「等待启动完成」的处理，否则用户看到的是一闪而过的「专家未运行」。

### 3.4 桌面端身份判定已有成熟机制，不要另造轮子

`dashboard/src/desktopShellDetection.ts` 组合三个信号：

| 信号 | 时机 | 说明 |
|---|---|---|
| `?desktop=1` | 首屏第一个脚本执行前 | 壳在首个导航 URL 上追加，**唯一能拦住 Service Worker 注册的信号** |
| localStorage `octop.desktopShell` | 之后所有导航 | 壳写入的 profile 标记，导航丢 query 也认得 |
| `window.octopDesktop` / `octopDesktopShell` / `octopDesktopVideo` | 页面加载后 250ms×10s 注入 | 壳主动亮明身份 |

> **坑（已踩过）**：nginx 会剥掉 `?desktop=1`，**不能只依赖 URL**；
> 而桥接是**延迟注入**的，首次渲染时可能还没有 → 判定必须**异步等待**，
> 否则桌面端会被误判成浏览器。
> `resolveDesktopShellContext()` 已封装这套逻辑（Promise，12s 超时后 resolve `false`）。

另有现成的 `useDesktopMinimalMode()`（`dashboard/src/hooks/useDesktopMinimalMode.ts`），
桌面端**已经**用它隐藏导航栏并把落地页导向 `/product-library`。
本次改造应**沿用同一套判定**，不要引入第二套。

---

## 四、需求条目（逐条可验收）

### R1 · 后端：SSO 登录时自动创建默认助手

**要求**：微信开放平台扫码登录成功后，该账号必须**自动拥有**一个 `general-assistant` 助手。

- 落点：`exchange_login_code_response()` 内，`exchange_login_code(code)` 成功之后、签发 JWT 之前。
- 复用现成的 `try_bootstrap_default_agent()`（含幂等 + 吞异常语义），**不要新写一套**。
- 失败**不得**影响登录：拿不到助手也要照常签发 JWT，让用户进得去。
- 覆盖所有 SSO 通道（微信开放平台是其中之一），而非只针对微信做特判。

**验收**：新账号扫码登录 → `GET /api/agents` 返回至少一个 `general-assistant`。

### R2 · 后端：已存在的账号要能自愈

**要求**：R1 只覆盖**今后**的登录。已经登录过、但一个助手都没有的老账号，
不能要求用户「重新注册」或「手动去创建」。

- 幂等调用 `try_bootstrap_default_agent()` 天然覆盖此场景：老账号下次登录时
  `list_agents(user_id)` 为空 → 照样创建。
- **需要确认登录态续期路径**：桌面端长期持有 JWT，若长期不重新扫码，是否存在
  「token 有效但没走过 `exchange_login_code_response()`」的窗口？
  → **待确认**（见 §六 Q1），必要时在会话恢复路径补一次同等的引导。

### R3 · 前端：桌面端隐藏「专家 / 团队 / 云端」与「创建专家」

**要求**：桌面端聊天页左栏不出现：
- 「专家 / 团队 / 云端」三个 Tab（`ChatNavScopeTabs`）
- 「创建专家 / 创建团队 / 添加云端」按钮（`ChatNavCreateButton`）
- 空态里的「还没有专家 → 去创建专家」引导（`ChatNavScopeEmpty`）

- 判定用 `useIsDesktopShell()`（基于 `resolveDesktopShellContext()` 的 React hook），
  **浏览器端完全不受影响**（永远拿到完整控制台）。
- 「专家/团队/云端」是**列表分组维度**，不是聊天能力。隐藏后列表只展示本账号的助手。
  → 顺带确认 `matchesChatNavScope()` 的过滤在单一分组下仍能正确列出助手。

### R4 · 前端：桌面端不因「没有专家」拦截输入

**要求**：桌面端不渲染 `AgentNotReadyScreen` 的「还没有专家」墙，输入框不禁用。

- 落点：`Chat/index.tsx` 的 `noAgents = !agentsLoading && agents.length === 0`（`:242`），
  它同时控制三处：主区域渲染（`:1617`）、输入框 `disabled`（`:1958-1963`）、
  `useMemoryMaintenance` / `useHistoryMigration` 的启用条件（`:269`、`:274`）。
- **注意**：这是「双刃」开关。直接置 `false` 会让**真·没有助手**的桌面用户
  进入一个没有 `agent_id` 的聊天页，接口会报错。
  → 正确做法是区分两种状态：
  - 「助手正在创建/启动中」→ 显示加载态，**不**当没有助手处理；
  - 「确实一个都没有且引导也失败」→ 给出可操作的错误提示，**不是**「去创建专家」。
- §3.3 已说明新建助手初始是 `starting`，需要等它变 `running`。

### R5 · 前端：桌面端落地页

**要求**：桌面端进聊天时**不要**被「专家 / 团队 / 云端」等控制台入口干扰，
首屏应直接是**可直接输入的对话框**。

- 现状：`useDesktopMinimalLanding()` 已把桌面端落地页导向 `/product-library`
  （`hooks/useDesktopMinimalMode.ts:4`、`:88-104`），登录后会重定向到 `/chat`
  → 这段注释里已提到「post-login redirect to /chat」的坑。
- 需确认：登录后跳 `/chat` 的行为在桌面端是否仍要保留（用户是从素材页主动进对话的）。

---

## 五、明确不做的事（避免范围蔓延）

| 不做 | 原因 |
|---|---|
| 改浏览器端的聊天界面 | 需求明确只针对桌面端；浏览器端保持完整控制台 |
| 删掉「创建专家」功能本身 | 只是**桌面端隐藏入口**；浏览器端、专家市场仍要用 |
| 新建一套桌面端身份判定 | 已有 `desktopShellDetection.ts` + `useDesktopMinimalMode()`，复用即可 |
| 改 `noAgents` 的语义而不加区分 | 会把「真的没助手」和「助手还在启动」混为一谈（见 R4） |
| 在桌面端本地跑模型 / 本地 runtime | 与产品定位冲突：素材与视频走云端，按需下载 video-components |

---

## 六、待确认问题

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 桌面端长期持有 JWT、不重新扫码时，老账号的自愈路径是什么？ | 决定 R2 是否需要在会话恢复路径补引导 |
| Q2 | 助手从 `starting` 到 `running` 通常要多久？失败率如何？ | 决定 R4 里加载态要给多久、失败怎么提示 |
| Q3 | `general-assistant` 从远程市场拉取依赖外网；市场不可达时账号还有助手吗？ | 决定「助手获取失败」的用户可见文案 |
| Q4 | 桌面端是否也需要在「专家市场」里直接装 `general-assistant`？ | 属于替代方案，与 R1 二选一或并存 |

---

## 七、验收清单

- [ ] 新账号微信扫码登录 → 聊天页**直接可输入**，无「专家/团队/云端」Tab、无「创建专家」按钮
- [ ] 左栏只列出本账号的助手；列表分组维度隐藏后过滤逻辑正确
- [ ] 登录后不出现「专家未运行 / 还没有专家」的墙（助手在 `starting` 的短暂瞬间除外）
- [ ] 助手创建失败时给出**可操作**的错误提示（不是「去创建专家」）
- [ ] **浏览器端**聊天页与改造前完全一致（三 Tab、「创建专家」按钮、空态引导都在）
- [ ] 已有但无助手的老账号，下次登录后自动获得助手
- [ ] 登录流程不被助手创建失败阻断（失败仍能拿到 JWT 并进入应用）

---

## 八、修改文件清单（实现时对照）

| 文件 | 涉及需求 | 说明 |
|---|---|---|
| `src/octop/api/routers/auth_oidc.py` | R1、R2 | `exchange_login_code_response()` 中加默认助手引导 |
| `dashboard/src/hooks/useIsDesktopShell.ts` | R3、R4 | 新增：桌面端身份 hook（基于 `resolveDesktopShellContext()`） |
| `dashboard/src/pages/Chat/components/SessionList.tsx` | R3 | 隐藏 scope Tab、创建按钮、空态创建引导 |
| `dashboard/src/pages/Chat/index.tsx` | R4 | 区分「无助手」与「助手未就绪」，桌面端不放行到无 `agent_id` 的聊天 |

---

## 九、参考

- 产品定位：见 [产品素材库导入架构](./product-library-import-architecture.md)（素材走云端、客户端不跑模型）
- 登录链路：见 [微信开放平台登录](./wechat-open-login.md)
- 桌面壳构建：见 [桌面端 Windows 构建](./desktop-windows-build.md)
- 桌面身份判定实现：`dashboard/src/desktopShellDetection.ts`
- 桌面精简模式先例：`dashboard/src/hooks/useDesktopMinimalMode.ts`
- 默认助手引导实现：`src/octop/infra/agents/experts/default_agent.py`
