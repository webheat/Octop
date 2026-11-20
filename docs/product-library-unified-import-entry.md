# 素材库统一导入入口（图片 + 文件夹混选）设计与实现

- 状态：**设计已确认，代码待实现**（路线 B：合并入口 + 保留目录结构）
- 影响模块：`dashboard/src/pages/ProductLibrary`、`octop/api/routers/product_library.py`、`octop/infra/product_library/batch_import.py`、`octop/infra/product_library/vision.py`
- 数据库迁移：**无**（导入任务的中间状态存在 `manifest.json`，不落表）

---

## 1. 背景：现状复核结论

素材库当前有**两个割裂的导入入口**，且语义不同：

| 入口 | 位置 | 实际行为 | 接口 |
|---|---|---|---|
| 「选择文件」 | `dashboard/src/pages/ProductLibrary/index.tsx:1014-1040`（antd `Upload multiple`） | 只能选**文件**，上传到当前选中产品的 assets | `POST /product-library/products/{id}/assets` |
| 「目录导入」 | `index.tsx:869` 按钮 → Modal `index.tsx:1727-1736` | `<input type="file" webkitdirectory directory multiple>`，只能选**文件夹**，进 AI 分组向导 | `POST /product-library/imports/analyze` |

### 1.1 为什么"一个对话框里同时选图片和文件夹"做不到

1. `webkitdirectory` 是**排他属性**：一旦存在，原生文件对话框只允许选目录，文件项变灰不可选。这是规范定义的行为，不是实现缺陷。
2. 反过来，不带 `webkitdirectory` 的 `<input type="file">` 只能选文件。
3. **操作系统层面同样不支持**单个对话框同时选中文件和文件夹（Windows 资源管理器、macOS Finder 一致）。桌面壳是 webview（`desktop/` 为 Wails 壳，M3 原生目录对话框尚未实现），复用同一套 input，限制相同。

结论：**"一个按钮点开、同时勾选"在 Web 与桌面壳均不可行**。能真正实现"文件夹 + 图片混合"的只有**拖拽**——`DataTransfer.items` 里文件与目录可以混排，`DataTransferItem.webkitGetAsEntry()` 可拿到 `FileSystemDirectoryEntry` 递归展开。

### 1.2 更严重的隐性缺陷：后端把目录层级抹掉了

| 位置 | 代码 | 后果 |
|---|---|---|
| `api/routers/product_library.py:461` | `Path(file.filename or "upload.bin").name` | 子目录被丢弃 |
| `api/routers/product_library.py:423` | 同上（`upload_assets`） | 同上 |
| `infra/product_library/batch_import.py:108` | `Path(filename.replace("\\", "/")).name` | 同上 |
| `dashboard/src/api/modules/productLibrary.ts:204-211` | `body.append("files", file)` | **`webkitRelativePath` 从未发送**，浏览器默认只用 `file.name` |

后果：`产品A/正面.jpg` 与 `产品B/正面.jpg` 上传后完全同名，分组只能 100% 依赖视觉模型猜测。用户手工整理好的目录结构——**最可靠且零成本的标注信号**——被整体丢弃，与"形成高质量基础图库"的目标直接冲突。

### 1.3 可复用的既有能力

`dashboard/src/pages/Chat/utils/droppedFiles.ts` 已实现混拖 + 目录递归（`snapshotDroppedEntries` / `filesFromSnapshot` / `collectEntryFiles`，上限 500）。但它只返回 `File[]`，**不保留相对路径**，且已被 Chat 依赖，直接改动有回归风险。

---

## 2. 需求

### 2.1 目标

1. **一个导入入口**：素材库只保留一个「导入素材」按钮，弹出同一个 Modal。
2. **三种选择方式并存**：Modal 内同时提供「选择图片」「选择文件夹」两个按钮和一块**拖拽区**，三者写入**同一个待导入队列**，共用一个「开始分析」动作。
3. **拖拽支持混合**：一次拖入可以同时包含若干图片和若干文件夹，递归展开，去重后入队。
4. **保留目录结构**：文件在队列中携带相对路径（如 `登山包A/正面/01.jpg`），随上传一同提交到后端。
5. **目录名作为分组先验**：顶层子目录名作为分组提示传给视觉模型；当模型分组为空或置信度不足时，回退使用目录名。

### 2.2 非目标

- 不改变「上传到已有产品 assets」这条链路的语义（`upload_assets` 保持现状，仅统一 filename 清洗函数）。
- 不做 `showDirectoryPicker`（File System Access API）适配——它与 `webkitdirectory` 能力重叠，且 Firefox 不支持，收益为零。
- 不做桌面原生混合选择对话框（OS 不支持混合选择，见 1.1）。
- 不引入队列/任务表：仍沿用 `product-library/<uid>/imports/<job_id>/manifest.json`。

### 2.3 验收标准

| # | 场景 | 期望 |
|---|---|---|
| A1 | 只选若干图片 | 行为与现状一致，全部进队列 |
| A2 | 只选一个文件夹 | 递归展开，行为与现状一致 |
| A3 | 拖入图片 + 文件夹混合 | 全部入队，文件夹按层级展开 |
| A4 | 选完图片再选文件夹 | 两批**追加**合并，不互相覆盖 |
| A5 | 队列展示 | 显示总数 + 可见的相对路径前缀（用于确认结构未丢） |
| A6 | 提交后 manifest | 每条记录含 `relative_path` 与 `folder` |
| A7 | 目录名与图片一致时 | 分组优先采用目录名（不额外消耗模型调用） |
| A8 | 老客户端（不发 `paths`） | 行为与当前完全一致，无回归 |
| A9 | 恶意路径 `../../etc/passwd` | 被清洗为 `etc/passwd` 或被丢弃，不写出用户目录 |

---

## 3. 方案总览

```
                     ┌──────────────── Modal（唯一入口）────────────────┐
  选择图片 ──┐        │  [选择图片]  [选择文件夹]                        │
  选择文件夹 ┼──────► │  ┌─────────── 拖拽区（文件+文件夹混拖）────────┐ │
  拖拽混选 ──┘        │  └────────────────────────────────────────────┘ │
                     │  队列：12 个文件 · 登山包A/正面/01.jpg  …       │
                     │  [开始分析]                                      │
                     └────────────────────────┬───────────────────────┘
                                              │ FormData: files[] + paths[]（同序）
                                              ▼
                       POST /product-library/imports/analyze
                                              │
                       sanitize_relative_path()  ← 防穿越 / 归一
                                              ▼
                       analyse_upload(files=[(relpath, mime, bytes)])
                         ├─ 存盘：{index}-{basename}
                         ├─ manifest 记录 relative_path / folder
                         └─ categorise_image(..., folder_hint=folder)
                                              ▼
                                   groups（目录先验优先）
```

---

## 4. 前端实现

### 4.1 新增 `dashboard/src/pages/ProductLibrary/importFiles.ts`

只服务于导入向导弹窗，不改动 Chat 的 `droppedFiles.ts`。

```ts
/** 队列条目：File + 浏览器/拖拽给的相对路径（已归一为 / 分隔）。 */
export interface ImportEntry {
  file: File;
  /** 例如 "登山包A/正面/01.jpg"；纯文件选择时等于 file.name。 */
  path: string;
  /** 稳定去重键，避免同一文件被拖两次。 */
  key: string;
}

export const MAX_IMPORT_FILES = 500;

/** 归一：反斜杠转 /、去掉开头的 / 和 ./、折叠重复分隔符。 */
export function normaliseRelativePath(raw: string): string;

/** 从 <input type="file"> 的 FileList 生成条目（用 webkitRelativePath）。 */
export function entriesFromFileList(files: FileList | File[]): ImportEntry[];

/** 从拖拽 DataTransfer 递归收集文件与目录，保留层级路径。 */
export async function entriesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): Promise<{ entries: ImportEntry[]; truncated: boolean }>;

/** 两个队列按 key 合并去重，保留先入者顺序。 */
export function mergeEntries(current: ImportEntry[], incoming: ImportEntry[]): ImportEntry[];
```

实现要点：

- `File.webkitRelativePath` 在 `webkitdirectory` 选择时由浏览器填入（形如 `登山包A/正面/01.jpg`）；普通文件选择为空 → 回退 `file.name`。
- 拖拽路径来自 `FileSystemEntry.fullPath`（形如 `/登山包A/正面/01.jpg`），去掉前导 `/` 即得相对路径；`FileSystemFileEntry.file()` 返回的 `File` **不带** `webkitRelativePath`，所以必须在递归时显式传递。
- 递归实现沿用 `readAllDirectoryEntries`（`readEntries` 需循环读到空批次，否则目录超过 100 项会截断）。
- 类型：`FileSystemEntry` / `FileSystemDirectoryReader` 在 `lib.dom.d.ts` 已有定义；若 TS 报错，用局部 `interface` 收敛，**不加 `any`**。
- 上限 `MAX_IMPORT_FILES = 500`，超出置 `truncated=true` 并在 UI 提示。

### 4.2 改造导入 Modal（`index.tsx`）

现状：`importStep === 0` 分支只有一个 `webkitdirectory` input（`index.tsx:1722-1748`）。

改为三个入口 + 队列摘要：

```tsx
// 1) 选择图片：不带 webkitdirectory
<input ref={imageInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden
       onChange={(e) => appendFiles(e.target.files)} />
<Button icon={<ImagePlus />} onClick={() => imageInputRef.current?.click()}>
  {t("productLibrary.importPickImages")}
</Button>

// 2) 选择文件夹：保留 webkitdirectory
<input ref={folderInputRef} type="file" multiple hidden
       // @ts-expect-error webkitdirectory is a valid browser attribute
       webkitdirectory="" directory=""
       onChange={(e) => appendFiles(e.target.files)} />
<Button icon={<FolderOpen />} onClick={() => folderInputRef.current?.click()}>
  {t("productLibrary.importPickFolder")}
</Button>

// 3) 拖拽区：文件 + 文件夹混拖
<div onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
     onDragLeave={() => setDragActive(false)}
     onDrop={handleDrop}>
  {t("productLibrary.importDropHint")}
</div>
```

状态变更：

| 旧 | 新 |
|---|---|
| `importFiles: File[]` | `importEntries: ImportEntry[]` |
| `setImportFiles(Array.from(e.target.files ?? []))` | `appendFiles()` → `mergeEntries(...)` **追加**，不再覆盖 |
| 分析按钮 `disabled={!importFiles.length}` | `disabled={!importEntries.length}` |
| 计数文案 `importSelected` | 增加路径前缀预览（最多 5 条，超出折叠） |

`handleDrop` 固定流程（`snapshot` 必须同步完成，否则事件结束后 `DataTransferItem` 失效）：

```ts
const handleDrop = async (event: React.DragEvent) => {
  event.preventDefault();
  setDragActive(false);
  const dt = event.dataTransfer;              // 先取，事件对象会被回收
  const { entries, truncated } = await entriesFromDataTransfer(dt);
  setImportEntries((all) => mergeEntries(all, entries));
  if (truncated) message.warning(t("productLibrary.importTruncated", { max: MAX_IMPORT_FILES }));
};
```

### 4.3 API 客户端（`dashboard/src/api/modules/productLibrary.ts`）

`analyzeImport` 签名从 `File[]` 改为 `ImportEntry[]`，用**两个并行字段**保持顺序对齐：

```ts
analyzeImport: (entries: ImportEntry[]) => {
  const body = new FormData();
  entries.forEach((entry) => {
    body.append("files", entry.file);   // 保持原字段名，老后端也能收
    body.append("paths", entry.path);   // 与 files 同序
  });
  return requestUpload<ImportAnalysis>("/product-library/imports/analyze", body);
},
```

> 为什么不把路径塞进 `body.append("files", file, path)` 的第三参数？
> 因为 `Content-Disposition` 的 `filename` 在不同 multipart 实现中会被 `basename` 化（历史上有多次安全修复），服务端拿到的是被截断的名字。**并行字段更可靠**，且不依赖解析器行为。

### 4.4 国际化

`dashboard/src/locales/zh.json` / `en.json` 新增（`productLibrary` 命名空间）：

| key | zh | en |
|---|---|---|
| `importPickImages` | 选择图片 | Choose images |
| `importPickFolder` | 选择文件夹 | Choose folder |
| `importDropHint` | 把图片或文件夹拖到这里（可混选） | Drag images or folders here (mix allowed) |
| `importQueueSummary` | 已选 {{count}} 个文件 | {{count}} files selected |
| `importQueuePaths` | 包含目录：{{paths}} | Folders: {{paths}} |
| `importTruncated` | 超出 {{max}} 个文件上限，已截断 | Truncated at {{max}} files |
| `importSelectHint` | （改文案）可选择图片、选择文件夹或直接拖入；系统会逐张识别并按产品自动分组 | （同步改） |

### 4.5 前端测试（`index.test.tsx`）

现有测试对 `Upload` 做了 mock（`index.test.tsx:50-60`），改造后需补充：

- 点击「选择图片」→ `analyzeImport` 收到的 `path` 等于 `file.name`。
- 用 `userEvent.upload` 给 `webkitdirectory` input 塞带 `webkitRelativePath` 的 `File` → `path` 保留前缀。
- 连续两次选择 → 队列为**追加**结果（验证 A4）。
- 拖拽：构造 `DataTransfer` mock（`items[].webkitGetAsEntry` 返回伪 `FileSystemEntry` 树）→ 递归展开正确（A3）。

---

## 5. 后端实现

### 5.1 路径清洗 `sanitize_relative_path()`

新增于 `infra/product_library/batch_import.py`（供 `analyse_import` 与 `upload_assets` 共用）：

```python
MAX_PATH_PARTS = 8
MAX_PATH_CHARS = 400

def sanitize_relative_path(raw: str, fallback: str = "upload.bin") -> str:
    """Turn a client-supplied path into a safe, display-only relative path.

    Never used to build a filesystem path directly: callers keep using the
    index-prefixed flat storage name. This value is metadata for grouping.
    """
    text = (raw or "").replace("\\", "/").strip()
    # Drop Windows drive letters and any leading slashes.
    text = re.sub(r"^[A-Za-z]:", "", text).lstrip("/")
    parts = [p for p in text.split("/") if p not in ("", ".", "..")]
    parts = [p.strip() for p in parts if p.strip()]
    if not parts:
        return fallback
    parts = parts[-MAX_PATH_PARTS:]          # keep the most specific tail
    rel = "/".join(parts)
    return rel[:MAX_PATH_CHARS] or fallback
```

规则说明：

| 威胁/异常 | 处理 |
|---|---|
| `../../etc/passwd` | `..` 组件直接丢弃 → `etc/passwd`，且**从不**用于拼磁盘路径 |
| `C:\imgs\a.jpg` | 去盘符 + 反斜杠归一 → `imgs/a.jpg` |
| 超长路径 / 超深目录 | 截断尾部 `MAX_PATH_PARTS` / `MAX_PATH_CHARS` |
| 空串、全分隔符 | 回退 `fallback`（通常为原 `filename` 的 basename） |
| Unicode 变体（NFD/NFC 混用） | 保持原样展示；仅在**分组 key** 侧沿用既有 `_norm()`（NFKC + lower + 去空白） |

`folder_of(rel_path) -> str`：取第一个路径组件（顶层目录名）作为先验；单层文件返回 `""`。

### 5.2 路由 `analyse_import`

```python
async def analyse_import(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(default=[]),      # 与 files 同序，可缺省
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    ...
    payload: list[tuple[str, str, bytes]] = []
    for index, file in enumerate(files):
        basename = Path(file.filename or "upload.bin").name
        raw_path = paths[index] if index < len(paths) else basename
        rel_path = sanitize_relative_path(raw_path, fallback=basename)
        data = await read_upload_capped(file, max_bytes=max_bytes)
        payload.append((rel_path, file.content_type or "", data))
    ...
```

兼容性：`paths` 缺省为空列表时逐条回退 `basename`，与当前行为**逐字节一致**。

### 5.3 `analyse_upload` 变更

第一个元组元素语义从「文件名」升为「相对路径」：

| 位置 | 现状 | 改为 |
|---|---|---|
| `batch_import.py:108` | `safe_name = Path(...).name` | `rel_path = sanitize_relative_path(filename)`；`safe_name = Path(rel_path).name`（基名仍单独保留） |
| `batch_import.py:114` | `storage_name = f"{len(items)}-{safe_name}"` | **不变**（index 前缀天然避免同名冲突，磁盘仍扁平） |
| 行字段 | `filename` | 追加 `relative_path`、`folder` |
| 返回 `items`/`failed`/`groups[].items` | 仅 `filename` | 追加 `relative_path`、`folder` |

`commit_import` **无需改动**：它按 `index` 取 manifest 行，`storage_name` 未变；`validate_asset(row["filename"], ...)` 仍收到基名，扩展名白名单逻辑不变。

### 5.4 目录名作为分组先验

`vision.categorise_image` 增加可选参数，默认 `""` → 提示词不变（既有调用零影响）：

```python
def categorise_image(
    data: bytes, media_type: str, model: Any, folder_hint: str = ""
) -> dict[str, Any]:
```

提示词增补（仅当 `folder_hint` 非空时追加，避免污染普通调用）：

```python
hint = (
    f'\nThe image comes from a folder named "{folder_hint}". '
    "If that name plausibly matches the visible subject, use it as \"group\"; "
    "ignore it when it contradicts what you actually see."
)
```

分组决策（`analyse_upload` 内，AI 结果归来后）：

```
优先序：
1. folder_hint 非空 且 (group 为空 或 confidence < FOLDER_PRIOR_MIN_CONFIDENCE)
   → group = folder_hint，confidence = max(confidence, 0.6)，标记 group_source="folder"
2. 否则用模型 group，group_source="vision"
```

`FOLDER_PRIOR_MIN_CONFIDENCE = 0.5`（常量，便于回归时单点调整）。

为什么是"先验"而非"强制"：目录命名可能混乱（`新建文件夹/`、`1/`、`IMG_0002/`），强制会把垃圾目录名变产品名；但目录名与图片冲突时仍应信图。因此仅在模型不自信时兜底。

### 5.5 后端测试清单（`tests/unit/product_library/`）

| 文件 | 用例 |
|---|---|
| `test_batch_import.py`（追加） | `sanitize_relative_path`：`../` 穿越、盘符、超深、空值、Unicode；`folder_of` 单层/多层 |
| 同上 | `analyse_upload` 收到 `paths` 后 manifest 含 `relative_path`/`folder` |
| 同上 | 不发 `paths` 时字段回退为 basename（A8 回归） |
| 同上 | `folder_hint` 覆盖空 group（A7）；高置信模型结果不被目录名覆盖 |
| `test_vision.py`（追加） | `folder_hint=""` 时提示词与现状逐字一致（防回归） |
| `tests/unit/api/test_product_library.py`（追加） | `paths` 数量多于/少于 `files` 时不报错 |

前端：见 4.5。

---

## 6. 数据、兼容与安全

| 项 | 结论 |
|---|---|
| SQLite 迁移 | **不需要**。`relative_path`/`folder` 只存在导入任务的 `manifest.json`，commit 后不落库；图库侧已有 `029_product_library_base_images` 覆盖质量字段 |
| 旧 manifest | 无 `relative_path` 时读取方回退 `filename`，历史未 commit 的任务可继续提交 |
| 旧客户端 | 不发 `paths` → 行为不变（A8） |
| 磁盘布局 | 不变（`<job_dir>/{index}-{basename}`），不因相对路径产生子目录 |
| 路径穿越 | `..` 丢弃 + 该值**从不**参与磁盘拼接；写出前仍用 `re.fullmatch(r"[A-Za-z0-9_-]{1,64}")` 校验 `job_id` |
| 隐私 | 相对路径可能含用户名/项目名，仅存本地 manifest，不上报、不进日志正文 |

---

## 7. 实施顺序与风险

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 | `sanitize_relative_path` + `folder_of` + 单测 | 低，纯函数 |
| P2 | 路由 `paths` 字段 + `analyse_upload` 元组语义升级 | 中：元组第一元素语义变了，需全量搜调用点（仅 `analyse_import` 一处） |
| P3 | `folder_hint` 提示词 + 分组回退 | 中：会改变既有导入的分组结果，需用固定图片回归 |
| P4 | 前端 `importFiles.ts` + Modal 三入口 | 中：拖拽递归的浏览器差异（Chrome/Edge OK，Safari 不支持 `webkitGetAsEntry` 目录） |
| P5 | i18n + 前端测试 | 低 |

**已知取舍**：Safari 下拖拽文件夹拿不到目录句柄，退化为只能拖文件；此时仍可用「选择文件夹」按钮（Safari 对 `webkitdirectory` 支持自 11.1 起）。UI 不额外提示，避免噪音。

---

## 8. 关联文档

- [素材库导入架构](./product-library-import-architecture.md) —— AI 识别职责边界（服务端调远程多模态模型，客户端不跑模型）
- [PRD §3.6](./PRD.md) —— 本地质检基础图库、隔离区与批量出片入口
