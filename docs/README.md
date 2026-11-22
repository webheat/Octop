# Octop 文档索引

> 本目录是 Octop 的**工程与产品文档中心**。本文是唯一入口，按主题分组列出全部文档并标注状态。
> 代码与配置的事实以源码为准；本索引只负责「去哪找」。
>
> 维护规范见文末 [§文档维护规范](#文档维护规范)。

---

## 快速入口（活文档）

这几篇是随代码持续更新的权威文档，多数问题从这里开始：

| 文档 | 回答什么 |
|---|---|
| [PRD.md](./PRD.md) | 产品是什么、为谁服务、要做什么、做到什么程度算完成 |
| [RELEASE-MATRIX.md](./RELEASE-MATRIX.md) | 客户端形态（full/slim/thin）、构建方式、分发渠道、版本口径 |
| [architecture.md](./architecture.md) | 技术分层、进程模型、存储、i18n |
| [api.md](./api.md) | HTTP/WebSocket 接口契约 |
| [configuration.md](./configuration.md) | 环境变量、`config.json`、SSO、存储配置 |
| [user-guide.md](./user-guide.md) | 终端用户操作指南（另有 [HTML 版](./user-guide.html)） |

---

## 1. 产品与需求

| 文档 | 说明 |
|---|---|
| [PRD.md](./PRD.md) | 产品需求文档（活文档，含桌面壳四条产品硬约束 §4.1） |
| [RELEASE-MATRIX.md](./RELEASE-MATRIX.md) | 交付形态与渠道矩阵（活文档） |
| [personas.md](./personas.md) | 用户画像与人格模板 |
| [expert-teams.md](./expert-teams.md) | 专家团队模式（AgentTeams）的设计与决策 |
| [projects.md](./projects.md) | 项目模式设计（设计态，尚未实现） |
| [desktop-direct-chat-panel.md](./desktop-direct-chat-panel.md) | 当前迭代需求：桌面端「直接对话框」R1–R5 |

## 2. 架构与决策记录（ADR）

| 文档 | 说明 |
|---|---|
| [architecture.md](./architecture.md) | 系统架构总览 |
| [adr/001-single-process-model.md](./adr/001-single-process-model.md) | ADR 001：单进程、无外部队列 |
| [adr/002-database-backends.md](./adr/002-database-backends.md) | ADR 002：SQLite / PostgreSQL 双后端 |
| [adr/003-skill-package-kb-pg-storage.md](./adr/003-skill-package-kb-pg-storage.md) | ADR 003：技能包与知识库的存储选型 |
| [agent-interop-mailbox.md](./agent-interop-mailbox.md) | Agent Teams 的 Inbox + Callback 底层架构 |
| [agent-call-agent.md](./agent-call-agent.md) | Agent 同步互调（`@` / `ask_agent sync`） |
| [agent-delegation.md](./agent-delegation.md) | Agent 后台异步协作 |
| [agent-backend-file-io.md](./agent-backend-file-io.md) | Agent 内容文件 Backend 严格化改造 |
| [bridge.md](./bridge.md) | Octop ↔ Octop 跨实例桥（实现中） |
| [browser-cdp-lan-reuse.md](./browser-cdp-lan-reuse.md) | 复用桌面 Chrome 登录态（CDP 局域网共享） |
| [octop-ui-payload-offload.md](./octop-ui-payload-offload.md) | 大 payload 旁路设计 |
| [acp.md](./acp.md) | ACP（Agent Client Protocol）双向能力 |

## 3. API、配置与认证

| 文档 | 说明 |
|---|---|
| [api.md](./api.md) | API 参考（活文档） |
| [cli.md](./cli.md) | CLI 参考 |
| [configuration.md](./configuration.md) | 配置参考（活文档） |
| [wechat-open-login.md](./wechat-open-login.md) | 微信开放平台扫码登录 |
| [ldap.md](./ldap.md) | LDAP 目录登录 |
| [magpie.md](./magpie.md) | Magpie（OpenAI 兼容 provider）接入 |

## 4. 连接器与通道

| 文档 | 说明 |
|---|---|
| [connectors.md](./connectors.md) | 内置连接器总览（元数据 source of truth 为 `catalog.json`） |
| [connectors-agently-mail.md](./connectors-agently-mail.md) | Agent Mail CLI 连接器 |
| [connectors-qcc.md](./connectors-qcc.md) | 企查查 MCP 连接器 |
| [connectors-ragflow.md](./connectors-ragflow.md) | RAGFlow 知识库连接器 |
| [discord-channel.md](./discord-channel.md) | Discord 通道配置与本地验收 |
| [telegram.md](./telegram.md) | Telegram 通道行为（draft，依赖 octop-gateway） |
| [plugin-channels.md](./plugin-channels.md) | 第三方通道插件 |

## 5. 市场与包格式

| 文档 | 说明 |
|---|---|
| [skill-market.md](./skill-market.md) | 自建 SkillHub 兼容技能市场 |
| [private-market.md](./private-market.md) | 内网自建插件/专家市场 |
| [expert-package.md](./expert-package.md) | 专家压缩包格式（`manifest.json`） |
| [plugin-package.md](./plugin-package.md) | 插件压缩包格式（`plugin.yaml`） |

## 6. 素材与视频

| 文档 | 说明 |
|---|---|
| [product-material-library.md](./product-material-library.md) | 产品素材库整体规划（活文档） |
| [product-library-import-architecture.md](./product-library-import-architecture.md) | 目录导入 AI 识别架构（**唯一权威结论**：服务端调远程模型，客户端不跑模型） |
| [product-image-batch-import.md](./product-image-batch-import.md) | 目录图片批量识别与归档（M1 已实现，M2/M3 规划） |
| [backend-ai-storyboard-mvp.md](./backend-ai-storyboard-mvp.md) | 服务端 LLM 分镜规划（当前实现） |
| [backend-mvp-v01-deployment.md](./backend-mvp-v01-deployment.md) | 后端 MVP v0.1 部署记录（历史实现记录，保留测试证据） |
| [remotion-video-pipeline.md](./remotion-video-pipeline.md) | 服务端产出脚本 → 本机 Remotion 渲染流水线 |
| [local-studio-package.md](./local-studio-package.md) | 本机 Remotion 制作包结构合同 |
| [design/product-video-wizard/README.md](./design/product-video-wizard/README.md) | 五步视频制作向导的界面与交互规范（含 [设计问答](./design/product-video-wizard/design-qa.md)） |
| [design/desktop-auto-video/README.md](./design/desktop-auto-video/README.md) | 桌面端自动视频设计入口，子文档：[验收标准](./design/desktop-auto-video/acceptance.md)、[桥接协议](./design/desktop-auto-video/contract.md)、[环境验收](./design/desktop-auto-video/environment-acceptance.md)、[环境合同](./design/desktop-auto-video/environment-contract.md)、[环境设计问答](./design/desktop-auto-video/environment-design-qa.md)、[手动安装组件](./design/desktop-auto-video/manual-components.md) |

## 7. 桌面客户端

| 文档 | 说明 |
|---|---|
| [desktop-windows-build.md](./desktop-windows-build.md) | Windows 构建流程与本机坑（活文档） |
| [desktop-bootstrap-installer.md](./desktop-bootstrap-installer.md) | Windows 瘦安装器与分层下载（**方案与路线图权威文档**） |
| [desktop-runtime-layered-download-task.md](./desktop-runtime-layered-download-task.md) | 分层下载任务书（PR-0/PR-1 已实施） |
| [desktop-runtime-layered-download-pr3-pr5.md](./desktop-runtime-layered-download-pr3-pr5.md) | PR-3/PR-5 下载进度面板与可选组件设计 |
| [desktop-runtime-layered-download-report-pr0.md](./desktop-runtime-layered-download-report-pr0.md) | PR-0 交付报告（依赖瘦身） |
| [desktop-runtime-layered-download-report-pr1.md](./desktop-runtime-layered-download-report-pr1.md) | PR-1 报告（源码层制品） |
| [desktop-runtime-layered-download-report-pr35.md](./desktop-runtime-layered-download-report-pr35.md) | PR-3/PR-5 设计与最小实现报告 |
| [desktop-single-instance.md](./desktop-single-instance.md) | 桌面端进程互斥（单实例）复核（权威） |

## 8. 部署与运维

| 文档 | 说明 |
|---|---|
| [deployment-pitfalls.md](./deployment-pitfalls.md) | 部署踩坑清单（路径前缀、代理、agent-running 等） |
| [base-path-deployment.md](./base-path-deployment.md) | 子路径部署（`base_path` / `base_url`） |
| [windows-deploy-script.md](./windows-deploy-script.md) | Windows 一键部署前端产物（PowerShell） |
| [cluster_CN.md](./cluster_CN.md) | 多副本 / Helm 部署（中文） |
| [cnb-mirror.md](./cnb-mirror.md) | CNB 镜像链路（GitHub → CNB） |
| [cnb-openapi.md](./cnb-openapi.md) | CNB Open API 调用方法与踩坑 |
| [cnb-branch-analysis.md](./cnb-branch-analysis.md) | CNB 分支情况每日分析机制（每日 01:30 自动出带日期的快照，活文档） |
| [gitee-release.md](./gitee-release.md) | Gitee 发布通道 |
| [memory-slim.md](./memory-slim.md) | 手动在线整理 `memory.sqlite` |
| [superagent-remote.md](./superagent-remote.md) | superagent（dsh-superagent）远程 systemd 部署 |
| [todo.md](./todo.md) | 需特定环境完成的人工待办清单 |

## 9. 历史归档

> 以下文档保留作背景参考，**结论以上文对应主题的活文档为准**，勿据此实现。

| 文档 | 说明 |
|---|---|
| [archive/product-library-mvp.md](./archive/product-library-mvp.md) | 素材库第一批 MVP 的历史设计与实施约定（已被 [导入架构](./product-library-import-architecture.md) 与 [批量导入](./product-image-batch-import.md) 取代） |

---

## 文档维护规范

1. **单一权威来源**：同一结论只在一篇文档中维护；其它文档用相对链接指向它，不复述、不另造判定逻辑。若发现两篇文档结论冲突，先确认哪篇随代码更新，再合并另一篇。
2. **活文档标注**：随代码演进的文档在页首声明「状态：活文档」与「最新核实日期」；被取代的文档移入 [archive/](./archive/) 并标注取代它的文档。
3. **状态诚实**：设计态、未实现、draft、历史记录必须在页首显式声明（参考 `projects.md`、`telegram.md`、`archive/product-library-mvp.md` 的写法），避免读者误当作现行能力。
4. **链接规范**：目录内一律使用相对 Markdown 链接（如 `./api.md`、`./adr/002-database-backends.md`），保证仓库可整体搬迁；新增/删除/移动文档后必须全局检查断链。
5. **命名规范**：小写 kebab-case；专题前缀按子系统统一（`desktop-*`、`product-*`、`connectors-*`、`design/*`）；ADR 按序号放 `adr/`。
6. **正文与索引同步**：新增文档必须在本索引登记（分组 + 一句话说明）；删除文档必须同步清理全部引用（含 README.md / AGENTS.md / 源码注释）。
