# 产品素材库：目录图片批量识别与归档

> 状态：**M1 已实现**（Web 目录导入 + 视觉分类 + 人工确认归档）
> 目标读者：后端 / 前端 / 测试
> 关联功能：产品素材库 `/product-library`（见 [product-material-library.md](product-material-library.md)）
>
> M1 落地清单（与下文设计对应）：
> - `src/octop/infra/product_library/vision.py` — `CATEGORISE_PROMPT` / `categorise_image()` / `parse_categorisation_payload()`
> - `src/octop/infra/product_library/batch_import.py` — `analyse_upload()` / `commit_import()`（预去重、分组、归档、owner 隔离、job manifest）
> - `src/octop/api/routers/product_library.py` — `POST /product-library/imports/analyze` 与 `/imports/commit`
> - `dashboard/src/pages/ProductLibrary/index.tsx` — 产品列表「目录导入」按钮 + 三步向导 Modal
> - `dashboard/src/api/modules/productLibrary.ts` — `analyzeImport` / `commitImport`
> - `tests/unit/product_library/test_batch_import.py` — 9 个用例（分类校验、分组、去重、权限、失败隔离、router 接线）
>
> M2（任务持久化/进度）与 M3（桌面端目录对话框）尚未实现。

## 1. 背景与问题

当前素材库的新增图片全部来自人工操作：用户在产品详情页点击「上传」，逐个或批量选择文件，再手动设置用途（scene / reference / style）。图片内容的语义只能靠已有的「AI 识别内容 / 批量识别图片」按钮补一段 `description` + `tags`，用于检索和视频分镜参考。

实际业务里，用户往往已经有一个**按文件夹整理好的素材目录**（例如 `登山包/` 下放着 `front.jpg`、`side.jpg`、`detail.jpg`，以及其它产品的照片）。他们希望：

1. 把整个目录的图片一次性导入；
2. 用 LLM 的图片理解能力识别每张图「是什么产品 / 属于哪个品类」；
3. 按识别结果**自动归档**到对应的产品条目下，而不是自己一张张判断和拖拽。

本文档定义这一「目录导入 → 视觉识别 → 自动归档」功能的需求、边界与实现方案。

## 2. 现状盘点（实现前必须知道的事实）

以下均为当前仓库中**已经存在**的能力，新功能应尽量复用而不是重造：

| 能力 | 位置 | 说明 |
|---|---|---|
| 图片内容描述（LLM 视觉） | `src/octop/infra/product_library/vision.py` | `describe_image()` 把图片 base64 发给已配置的多模态模型，返回 `{description, tags}`；`describe_asset()` / `describe_missing_assets()` 是单张/批量入口 |
| 描述持久化 | 迁移 `028_product_library_asset_descriptions` | 表 `product_library_asset_descriptions`，字段 `description` / `tags` / `status` / `error` / `model` / `content_hash`；按 `asset_id` 唯一，带 owner + hash + status 索引 |
| 资产入库 | `ProductLibraryService.store_asset()` | 写入字节到 `product_library_dir/<user>/<product>/`，并登记元数据；`content_hash` 为 SHA-256 |
| 重复识别跳过 | `find_ready_description_by_hash()` | 相同 `content_hash` 的已识别结果直接复用，不重复花模型调用 |
| 上传接口 | `POST /product-library/products/{product_id}/assets` | multipart，字段 `files` + `usage`，受 `max_upload_bytes` 限制 |
| 识别接口 | `POST .../assets/{id}/describe`、`POST .../products/{id}/describe-missing` | 对应前端「AI 识别内容」「批量识别图片」按钮 |
| 前端上传控件 | `dashboard/src/pages/ProductLibrary/index.tsx:907` | antd `<Upload multiple accept=...>`，无目录选择能力 |
| 产品/资产所有权限定 | 全链路 `owner_id = user.id` | 所有读写按登录用户硬隔离 |

**关键约束**：现有视觉识别的 prompt 是「只描述可见内容、禁止臆造品牌/规格」，输出只有 `description` + `tags`，**并不做产品归类**。因此「按识别结果归档到产品」需要新增一个结构化的分类输出，见 §4.2。

## 3. 需求

### 3.1 功能需求

- **FR-1 目录导入**：用户能选择一个包含图片的目录（含子目录），系统遍历其中受支持的图片文件（`png/jpg/jpeg/webp/gif/bmp/avif`），忽略其它文件。
- **FR-2 逐张识别**：对每张图片调用 LLM，输出结构化的视觉分析：建议产品名、品类、可见特征描述、检索标签、置信度。
- **FR-3 自动归档**：按识别出的「产品」把图片分组，在素材库里落库：同组图片归入同一个产品条目，图片作为该产品的资产保存（默认 `usage=scene`）。
- **FR-4 拍照分组证据**：识别结果要能解释「为什么归到这个产品」，至少保留描述与标签供用户复核。
- **FR-5 人工确认**：自动归档是**建议**而非不可逆操作。用户能在提交前查看分组、修改产品名/品类、把图片在组间移动或排除；确认后才真正写入。
- **FR-6 幂等与去重**：相同字节（同 `content_hash`）的图片在同一用户下不重复入库、不重复调用模型；重复导入同一目录不产生副本。
- **FR-7 失败可控**：单张识别失败不影响整批；失败的图保留在本地待重试项并给出原因，不阻塞其它图归档。
- **FR-8 权限隔离**：所有目录、识别任务、归档结果严格按 `user.id` 隔离，用户 A 无法读取或操作用户 B 的导入任务。

### 3.2 非功能需求

- **NFR-1 体积上限**：沿用 `max_upload_bytes` 单文件上限；视觉调用沿用 `vision.py` 的 8 MB 图片上限，超限图片跳过识别但仍可导入。
- **NFR-2 并发受控**：LLM 调用并发数可配置（默认 2–4），避免打爆 provider 配额；单任务超时与整批超时均需设置。
- **NFR-3 成本透明**：识别会消耗模型额度。界面需提示「将识别 N 张图片」，并复用已识别 hash 以避免重复消费。
- **NFR-4 隐私**：图片字节与识别请求仅在处理期间存在；描述/标签按现有表落库，不额外外发第三方。

## 4. 关键设计决策

### 4.1 「目录」从哪里来 —— 浏览器与桌面端的根本差异

这是本功能最大的现实约束，必须先定清楚，否则方案无法落地：

| 运行环境 | 能否读取本地任意目录 | 可行入口 |
|---|---|---|
| 浏览器访问 Dashboard（Web） | **不能**。浏览器沙箱禁止读取本地磁盘目录；`<input webkitdirectory>` 只能拿到用户**手动选中**的这一次目录内容，无法记住路径、无法服务端遍历 | 用户在前端用目录选择器选中目录 → 浏览器 FileList → 逐文件上传给后端；后端从「上传上来的文件集合」做识别归档，而非自己遍历磁盘 |
| 桌面客户端（Wails） | 可以（走 Go 侧文件对话框），但涉及桌面与后端的文件通道，属独立改造 | 后续阶段，见 §7 |

**决策**：MVP 只做 **Web 侧「目录选择器 + 批量上传」** 方案。所谓「遍历目录」实际由**浏览器的目录选择控件**完成（`webkitdirectory` 的 `<input type=file>`），后端拿到的是一组已上传的临时文件，再在其上做识别与归档。后端**不提供**「传一个服务器本地路径让我扫描」的接口——那会让 Web 用户读到服务端文件系统，是安全问题。

> 若将来确实需要「服务端读取一个共享目录」（例如 NAS 上的素材盘），应作为独立的管理员功能，加上路径白名单与鉴权，不并入本 MVP。

### 4.2 识别输出：从「描述」升级为「可归档的结构化结果」

复用 `vision.py` 的模型解析与 base64 通道，但为归档新增一个**专门的结构化 prompt**（不要改现有的 `_PROMPT`，避免影响「批量识别图片」的既有行为）。新增函数建议：

```python
# infra/product_library/vision.py（新增，不改动现有 describe_*）
CATEGORISE_PROMPT = (
    "You are cataloguing product photos. Return ONLY one JSON object with keys: "
    '"group" (short product name inferred from visible subject; empty if unclear), '
    '"category" (one concise category word), '
    '"description" (2-4 sentences of only what is visible), '
    '"tags" (3-8 short keywords), '
    '"confidence" (0..1 float). '
    "Never invent brands, prices or specifications. "
    "Use Chinese unless visible text is in another language."
)

def categorise_image(data: bytes, media_type: str, model: Any) -> dict[str, Any]:
    """One bounded vision call returning a validated categorisation payload."""
    # 与 describe_image 相同的 base64/HumanMessage 通道
    # 复用 parse_* 校验：group/category/description 非空字符串、tags 列表、confidence 限幅
```

校验函数需严格拒绝：非 JSON、缺字段、类型错误、`confidence` 越界、`group`/`tags` 超长（沿用 `MAX_TAGS` / `MAX_DESCRIPTION_CHARS`）。**模型输出永远不能直接写库**，必须先过校验。

### 4.3 分组与归档算法

针对一批识别结果 `{group, category, ...}`：

1. **归一化分组键**：去首尾空格、统一大小写与全半角、`category` + `group` 组合成键。可选：用标签 Jaccard 相似度做近似合并（MVP 可先只做精确匹配，避免过度合并）。
2. **匹配已有产品**：对每组，先在当前用户已有产品里按 `name`（归一化后）查找；命中则复用该产品 id，避免重复建品。
3. **未命中则新建产品**：用 `group` 作为产品 `name`、`category` 作为品类，其余字段留空（符合现有 `create_product` 契约）。
4. **落库图片**：每张图 `store_asset(owner_id, product_id, filename, media_type, data, usage="scene")`。
5. **写入识别结果**：复用 `save_description()` 把 `description`/`tags`/`status=ready`/`model` 写入 `product_library_asset_descriptions`，让这批图和手动识别的图在检索上完全一致。
6. **去重**：入库前按 `content_hash` 查 `find_ready_description_by_hash()`；同用户已存在同 hash 则跳过模型调用与入库。

### 4.4 事务与失败边界

- 归档以**单个产品组**为提交单元：一组内的产品创建 + 资产写入尽量原子；失败的图单独记录，不回滚整批。
- 单张失败（超限、格式不支持、模型报错）写一条 `{filename, reason}`，通过任务结果返回，前端高亮提示。
- 不引入新的后台任务队列（仓库无队列，见 `AGENTS.md`）。任务状态用内存 + 前端轮询即可；若需跨请求持久化，放 `product-library/<uid>/imports/<job_id>.json`（纳入备份范围），不进数据库。

## 5. 接口设计

新增路由均在 `src/octop/api/routers/product_library.py`，全部 `Depends(current_user)` 并按 `user.id` 隔离。

### 5.1 分析（dry-run，不写库）

```
POST /api/product-library/imports/analyze
Content-Type: multipart/form-data
Body:   files: File[...]              # 浏览器目录选择器给出的图片集合
Return: {
  "job_id": "...",
  "groups": [
    {
      "key": "登山包",
      "suggested_name": "轻量防撕裂登山双肩包",
      "category": "登山包",
      "items": [
        {"index": 0, "filename": "front.jpg", "confidence": 0.86,
         "description": "...", "tags": ["岩灰", "双肩"], "duplicate": false}
      ]
    }
  ],
  "skipped": [{"filename": "notes.txt", "reason": "unsupported type"}],
  "failed":  [{"filename": "huge.png", "reason": "exceeds 8 MB"}]
}
```

只识别、只返回结果，**不创建产品、不写资产**。用户据此在前端复核和编辑分组。

### 5.2 确认归档

```
POST /api/product-library/imports/commit
Content-Type: application/json
Body: {
  "job_id": "...",
  "groups": [
    {
      "product_id": null,             # null=新建；填已有 id=归入该产品
      "name": "轻量防撕裂登山双肩包",
      "category": "登山包",
      "item_indices": [0, 1, 2]       # 引用 analyze 返回的 items.index
    }
  ],
  "exclude_indices": [7]
}
Return: {
  "created_products": 1,
  "imported_assets": 3,
  "reused_products": 0,
  "skipped_duplicates": 0
}
```

`analyze` 与 `commit` 之间用 `job_id` 关联：`analyze` 把上传的文件临时落到 `product-library/<uid>/imports/<job_id>/`，并记录每个 index 对应的文件路径与 hash；`commit` 按 `item_indices` 取回文件入库并清理临时目录（或失败时保留供重试）。`job_id` 必须绑定 owner，越权返回 404。

### 5.3 复用现有接口

识别结果写入的 `description/tags` 通过既有 `GET .../assets` 列表返回（字段 `ai_description` / `ai_tags`，见 `productLibrary.ts`），前端素材卡片也能显示——无需新增读取接口。

## 6. 前端方案

### 6.1 界面入口

在 `ProductLibrary` 页顶部（产品列表工具条）新增一个按钮 **「目录导入」**，与「添加产品」并列。这是与「上传」（针对单个已选产品）不同的入口：目录导入面向**跨产品批量建库**。

```
产品素材库
┌──────────────────────────────────────────────┐
│ [+ 添加产品] [目录导入]        （产品列表工具条）│
├──────────────┬───────────────────────────────┤
│ 产品列表      │ 素材区                          │
│  登山包        │  [批量识别图片]                  │
│  旅行袋        │  ...                            │
└──────────────┴───────────────────────────────┘
```

### 6.2 交互流程（三步向导 Modal）

1. **选择目录**：`<input type="file" webkitdirectory directory multiple>`，选择后展示「已选择 N 张图片，将识别 M 张」与成本提示；点「开始识别」调 `analyze`。
2. **复核分组**：按 `groups` 展示卡片，每组可编辑产品名/品类、组内图片可勾选排除或移动到其它组；展示 `confidence` 与 `description` 作为归档依据；`failed`/`skipped` 单独列出。
3. **确认归档**：点「确认导入」调 `commit`，展示结果汇总（新建产品数 / 导入图片数 / 复用 / 跳过重复），关闭后刷新产品与素材列表。

`webkitdirectory` 在 Chrome/Edge 受支持；Firefox 支持有限，需在 UI 提示「建议使用 Chrome / Edge」，并提供退化为普通多选文件的兜底。

### 6.3 前端 API（新增到 `productLibrary.ts`）

```ts
analyzeImport: (files: File[]) => Promise<ImportAnalysis>   // FormData 走 requestUpload
commitImport: (body: ImportCommit) => Promise<ImportResult>
```

沿用现有 `requestUpload`（带鉴权 token），不新增请求基建。

### 6.4 文案（追加到 zh.json / en.json 的 `productLibrary` 命名空间）

`importDirectory`、`importSelectHint`、`importAnalyzing`、`importReviewGroups`、`importConfirm`、`importCostHint`、`importFailed`、`importSkipped`、`importResult` 等。

## 7. 分阶段实施

| 阶段 | 范围 | 可交付 |
|---|---|---|
| **M1（本提案 MVP）** | Web 目录选择器 + 批量上传 + 结构化识别 + 分组预览 + 人工确认归档 + 去重 + 失败提示 | 后端 `vision.categorise_image` + `imports/analyze` / `commit` 两接口 + 前端三步向导；无需新迁移（复用 v28 描述表），无需队列 |
| **M2** | 近似分组合并、任务持久化与断点续传、进度条、取消 | `imports/<job_id>.json` 状态文件 + 轮询接口 |
| **M3（桌面端）** | Wails Go 侧目录对话框，直接把目录内文件流送给后端识别，免去浏览器上传体积限制 | 桌面专用入口，需评估桌面↔后端文件通道 |

## 8. 测试计划

遵循仓库铁律：本地只跑相关单测，全量交 CNB 门禁。

- **后端单测**（新增 `tests/unit/product_library/test_batch_import.py`）：
  - `categorise_image` 的 JSON 解析/校验（正常、markdown 包裹、缺字段、类型错、confidence 越界、超长截断）；
  - 分组归一化与匹配已有产品（命中复用 / 未命中新建）；
  - 去重：相同 hash 不重复调用模型、不重复入库；
  - 权限隔离：用 user A 的 `job_id` 调 commit 被拒（404）；
  - 单张失败不阻塞整批，`failed` 正确返回。
- **前端**：`analyzeImport` / `commitImport` 的 API 契约测试；向导 Modal 的分组编辑交互测试（可参考现有 ProductLibrary 相关测试的 mock 约定，注意补齐 `bgmOptions` 等既有 mock 字段，避免基线那 13 个失败）。
- **集成**：本地起服务，用 curl 打 `analyze` → `commit` 两个接口，确认产品与资产落库、描述表写入、重复导入无副本。
- **验证命令**：`uv run pytest -q tests/unit/product_library/test_batch_import.py`。

## 9. 风险与开放问题

1. **成本**：批量识别可能一次消耗大量模型额度。缓解：分析前显示张数与成本提示、hash 去重、并发限流。需在上线前确认 provider 配额策略。
2. **分类质量**：LLM 可能把同一产品的不同角度识别成不同 `group`，或把不同产品合并。MVP 用精确匹配 + 人工复核兜底；近似合并放 M2。
3. **上传体积**：Web 目录导入受浏览器与 `max_upload_bytes` 双重限制，大批量可能很慢。M1 需给出清晰的进度与失败提示，M3 桌面端根治。
4. **浏览器兼容**：`webkitdirectory` 非全平台一致，需退化方案与提示。
5. **待确认**：是否允许「分析后不确认、保留临时文件」？临时目录的保留时长与清理策略需产品拍板。
6. **待确认**：`group` 为空（识别不出产品）的图片如何处理——归入「未分类」产品，还是跳过？建议默认归入「未分类」并在 UI 提示用户手动归类。

## 10. 与其他文档的关系

- 现有素材库能力见 [product-material-library.md](product-material-library.md)。
- 视频分镜/制作包链路见 [backend-ai-storyboard-mvp.md](backend-ai-storyboard-mvp.md)、[local-studio-package.md](local-studio-package.md)。
- 本功能是**新增**能力，不改变现有「手动上传 + 单张/批量识别 + 视频向导」流程；两者并列，用户按需选用。
