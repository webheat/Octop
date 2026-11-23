# Octop 视频生产工作台升级 PRD / Implementation Handoff

- 日期：2026-11-23
- 状态：已完成产品/交互设计规格；**未实现代码或验证真实渲染**
- 目标分支：`feat/video-production-workbench`（从 main 创建）
- 设计依据：`docs/design/product-video-wizard/README.md`、`docs/product-material-library.md`、`docs/backend-ai-storyboard-mvp.md`、`docs/remotion-video-pipeline.md`
- 现有落点：`dashboard/src/pages/ProductVideoWizard/index.tsx`、`brief.ts`，后端 product-library storyboard API、Remotion 本地渲染器
- 设计角色：高层产品/交互设计；实施建议分配给低成本编码模型，但不得把设计稿或任务清单视作已实现

## 1. 决策与非目标

**产品定义**：把「五步视频向导」升级成「轻量视频生产工作台」。保持普通用户无需懂剪辑仍能一步步出片的默认体验；同时提供可编辑分镜和多平台批量输出。不是 Premiere 式多轨 NLE，不重做授权/产品库/Remotion，也不引入在线高成本视频渲染服务。

**双层操作模型**：默认「引导模式」一步一主按钮；高级「工作台模式」仅在用户主动点击「精细调整」后展开。同一项目、同一草稿数据、同一状态机，切换模式不得复制项目或丢失编辑。

**不退化红线**：继承 `docs/PRD.md` S1–S6：桌面登录页/对话框立即出现、微信 SSO、无启动前置向导、视频运行时登录后按需主动检测和安装、绿色版免安装、重依赖不随壳打包。产品视频内部四个业务步骤不属于应用首启 onboarding。

## 2. 用户旅程及页面布局

入口：产品库「制作视频」或已有项目「继续制作」 -> `/product-library/video-wizard?project=...`。

顶部：项目名/保存状态/当前阶段/引导模式-精细调整切换；退出时提示未保存。

四个业务阶段（复用旧五步数据/路由，不做破坏性升级）：
1. **产品与素材**：选择已有产品/上传图片；对素材按用途分组（产品正面、细节、场景、品牌、参考），明确哪些只能理解、哪些可出镜；用可见标签呈现已确认卖点。
2. **营销方案**：选择用途、目标受众、风格、时长、语言、**目标平台多选**；自动推荐画幅/镜头数/开头 Hook；显示「下一步：生成分镜」，可以跳过高级字段。
3. **分镜生产**：先显示 AI 拟定的镜头顺序与时长、静态素材、文案；默认可以一键「确认并继续」；点击「精细调整」展开左侧素材抽屉、中央顺序镜头卡片/预览、右侧选中镜头属性。允许在合法范围内调整镜头顺序、选择项目快照内素材、字幕文本和时长、镜头技术（静态程序化运镜/已有视频/后续 AI 图生视频），逐镜头重新生成必须有显式成本提示与确认。保存草稿和最终确认必须区分；失败不丢草稿。
4. **输出交付**：根据平台选择显示待输出版本，批量渲染任务进度、失败重试与 ZIP/MP4 交付；网页环境无可用本机渲染时明确给出 Remotion Studio ZIP，绝不假称 MP4 已生成。

在引导模式，仅展开当前步骤一个大操作（「下一步」或「生成并继续」），上一步可退回，所有高级编辑放到可选入口。未确认草稿不能下载生产包；编辑已确认稿后清除确认状态。

## 3. 分镜工作台信息结构

三栏布局（桌面宽度足够时）：
- 左侧：项目素材、筛选、搜索、可用性/来源/授权用途、将素材应用至所选镜头。
- 中间：顶部当前视频预览（可为静态分镜示意，必须明确标记，不得伪装成真实视频）、下方横向镜头列表；顺序、封面、时长、状态标签；选中/添加/删除/复制/上下移动。
- 右侧：镜头属性（素材、文案、字幕、时长、画面比例安全区、运动方式、生成来源），操作「保存当前镜头」「重生成镜头」。
- 底部固定：草稿状态、预计时长、上一步 / 下一步、保存、确认。

窄屏：三栏变为「镜头/素材/属性」标签切换，保持底部主操作可见；支持键盘，焦点样式、错误提示和撤销关键操作。重生成不得覆盖用户手改内容，必须提供新版本预览及采纳/放弃。

素材以 **原始产品/分镜静帧/分镜动态片段/最终成片** 四级资源分类；采用源 ID + 衍生关系（parent_asset_id / scene_id），避免重复上传及引用失效。项目仍只访问所属用户资产；旧项目 snapshot 不应被静默更新，新素材增补需要明确的项目授权/快照版本设计。

## 4. 多平台输出恢复（核心要求）

当前前端 `ProductVideoWizard/index.tsx` 已出现 `PLATFORM_KEYS`（douyin、xiaohongshu、channels、kuaishou、bilibili、tiktok、instagram、youtube）及 `PLATFORM_FORMATS`。**这些主要是选择与画幅提示，不足以证明已有逐平台独立渲染**。必须将其变成真正的输出目标列表。

定义输出目标：
```ts
type OutputTarget = {
  id: string;
  platform: 'douyin'|'xiaohongshu'|'channels'|'kuaishou'|'bilibili'|'tiktok'|'instagram'|'youtube'|'custom';
  profile: 'short_vertical'|'landscape'|'square'|'custom';
  width: number;
  height: number;
  fps: number;
  language: string;
  filename: string;
  status: 'queued'|'preparing'|'rendering'|'completed'|'failed';
  error?: string;
}
```

**默认建议**而非固定平台强制标准：短视频 1080x1920 / 30fps；横屏 1920x1080 / 30fps；方形 1080x1080 / 30fps。所有具体平台规则是可版本化 preset，用户可覆盖；不要把 YouTube/B站一概等同仅横屏（Shorts 也可竖屏），Instagram 同理可选 Reels。多平台通常可以合并相同 render profile 避免重复生成；差异化字幕安全区、片尾 CTA 和平台文案时则各自生成变体。

一个源故事板对应多个 **OutputVariant**，包括 crop/contain/blur padding、safe areas、caption layout、localization、BGM 权益约束。每个平台输出独立文件及 manifest.json，UI 必须呈现「预计产物」与真实完成情况。

保持 `script.json` 向后兼容：旧 schema 不支持的字段放在版本化 `output-manifest.json` 或新增可选字段，由渲染入口消费；老式单平台 ZIP 仍应可渲染。不使用「只改文件名」伪造多比例输出；每个变体真实创建对应尺寸的 Remotion Composition/render input。

多平台输出与「直接发布到平台」区分：本期是**多平台规格文件导出**，不做平台 API 自动上传。

## 5. 状态/API/持久化

保留已有 storyboard / projects / auth API（`docs/backend-ai-storyboard-mvp.md`）。低风险迭代优先客户端 composition + 可选后端扩展：
- `GET/PUT /projects/{id}/storyboard`：读写故事板。服务端校验镜头类型、时长、授权素材。
- 建议新增 `GET/PUT /projects/{id}/output-targets`：用户所属项目、profile preset 校验及版本号。
- 建议新增 `POST /projects/{id}/render-batch`、`GET /projects/{id}/render-batches/{batch_id}`：可选；如果复用桌面桥接，则 UI 控制多目标序列任务，服务端只保存 manifest。**不能宣称已有这些接口。**
- `GET /projects/{id}/storyboard-package` 兼容旧客户端；增加可选多目标导出时仍保持原行为。
- 幂等 job/target 键；部分失败不得覆盖其它成品；断线恢复和按目标重试；取消只影响尚未完成任务。
- 用户隔离所有新增资源和路径，防止通过 asset ID 或 job ID 越权访问。
- 保存时明确 draft version / dirty / confirmed / render snapshot；修改后失效旧版本确认但不删除旧成片。

## 6. 对低成本编码模型的开发切片（必须逐切片提交和基础测试）

### P0A — 保留原功能并重构容器
- 将单一较大 `ProductVideoWizard/index.tsx` 拆为流程壳、产品选择、方案、镜头板、输出页；原有主逻辑复用；引导模式保持默认且可下一步。
- 对原素材库/旧项目恢复/配音配乐/导出链路添加回归测试。
- 不迁移数据库、不中断微信登录与桌面壳。

### P0B — 精细分镜工作台
- 实现三栏布局与窄屏降级、镜头顺序和属性编辑（先接已有服务端允许字段）、明确保存/确认语义。
- 标记图像为「分镜示意」，尚无引擎时不得显示可用播放按钮。
- 新增镜头级 AI 生成能力时必须通过后端限额/鉴权/费用提示；如接口尚无，先仅提供受支持的手动编辑，禁用占位按钮。

### P0C — 多平台批量交付
- 输出页展示八个平台及 custom，按真实渲染 profile 编组；允许同平台不同版式；增加各变体的尺寸/语言/字幕安全区与批量选择。
- Remotion 本地渲染以 profile 参数真实出不同像素尺寸，准确反馈每一项成功/失败；产物 manifest 与 zip；无本地运行时 fallback 保持 ZIP 导出。
- 多语言 TTS / 配乐授权是依赖项；本期未支持的组合应清晰提示，不能默默使用错误语言/曲目。

### P1 — 成本优化与易用性增强（后续）
- 单镜头重生成与版本对比、模板库、智能素材推荐、批量产品出片、多个分镜方案 A/B 对比。

## 7. 测试与验收

基础验证：前端类型检查、相关 RTL/Vitest、生产构建；后端新增路由的鉴权/Schema/隔离测试；Remotion 用最小 mock 素材输出 9:16 / 16:9 / 1:1 并用 ffprobe 实际确认像素尺寸、帧率与时长。GitHub Actions 逐次检查失败日志，避免只凭绿色提交判断产品效果。

必须覆盖：
1. 新用户一键下一步，未使用高级功能也能生成已确认的制作包；
2. 旧项目、旧版 ZIP、旧 storyboard 可继续使用；
3. 精细编辑并保存，刷新恢复正确，重新确认后可导出；
4. 同时选择 TikTok 9:16、YouTube 横屏 16:9（可另选 Shorts）、Instagram Reels，得到多个不同分辨率文件且字幕不出安全区；
5. 单目标失败不取消其他目标，可单独重试，不谎报成功；
6. 切换账户看不到他人素材、计划、成片；API 不接收越权资产；
7. 未登录不安装重依赖；已登录用户仅主动在视频功能中触发环境检查/安装；桌面壳启动行为不变；
8. 低成本模型/本地渲染不可用时向用户解释可重试/下载 Studio ZIP，不生成假结果。

**验收完成定义**：产品 UI、服务端契约、本地渲染入口均接通且 CI 基础检查通过；真正多平台至少验证两个不同画幅的输出；本期不保证真实平台上传。
