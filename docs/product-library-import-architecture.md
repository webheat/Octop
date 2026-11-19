# 产品素材库「目录导入」AI 识别架构（结论固化）

> 状态：**已固化**，最后核实 2026-11-19。
> 背景：此架构被反复问及、反复澄清过多次。本文是**唯一权威结论**，后续直接引用本文，不再重复口头解释。

---

## 1. 一句话结论

**目录导入的图片 AI 识别，由「服务端」执行、调用「远程多模态模型」完成并回传识别数据；客户端（桌面壳/浏览器）只负责上传图片和接收分组结果，本机/客户端不运行任何模型。**

- 这里的「服务端」= Octop 后端进程（`octop run` 起的 FastAPI 服务）。桌面端连的是**远程自建 Octop 后端**（`ocdev.aixifs.com:13122`），不是用户本机。
- 「远程多模态模型」= 服务端 provider 配置里 `base_url` 指向的云端 LLM（如 `newapi` → `https://aikey4k.mengxa.com:8443/v1`）。

---

## 2. 职责边界（谁做什么）

| 环节 | 执行位置 | 说明 |
|---|---|---|
| 选择目录、上传图片 | 客户端（桌面壳 / 浏览器） | 只上传文件字节，不做识别 |
| 接收上传、落临时 job 目录 | 服务端（Octop 后端） | `~/.octop/product-library/<uid>/imports/<job_id>/` |
| 读取模型配置 | 服务端 provider_repo | `base_url` + `api_key` + `model_id`，**只是连接配置，不是模型本身** |
| 构造模型客户端 | 服务端进程 | `build_probe_chat_model()` 构造一个指向远程端点的 HTTP 客户端 |
| **图片识别计算** | **远程多模态 LLM** | `categorise_image()` 把图片 base64 POST 到 `base_url`，远程识别后回传 text |
| 解析回传、分组、入库 | 服务端 | `parse_categorisation_payload()` 解析 group/category/description/tags |

**关键澄清**：本机 providers 表即使为空也不代表"功能坏了"——客户端连的是远程后端，远程后端配了 provider 即可。本机为空只是"拿本机充当服务端"时的配置未就绪状态。

---

## 3. 代码调用链（代码级）

```
客户端上传图片
  → POST /api/product-library/imports/analyze      (服务端 API)
  → batch_import.analyse_upload()                   (服务端)
  → resolve_vision_model(provider_repo)             (服务端；vision.py:64)
       └─ provider_repo.resolve_multimodal_model_ref()
          按 models_json 中 "input":["text","image"] 选出 vision 模型
  → build_probe_chat_model(row, base_url=...)       (服务端；probe.py:43)
      构造指向远程端点的 chat model 客户端
  → categorise_image(data, media_type, model)       (服务端；vision.py:146)
      把图片 base64 POST 到 base_url → 远程 LLM 识别 → 回传 text
  → parse_categorisation_payload()                  (服务端)
      解析 JSON → dry-run 分组计划（不入库）
  → 用户复核 → POST /imports/commit                 (服务端)
  → 创建产品 + 素材入库 + 文件落盘
```

相关代码位置：

| 文件 | 关键函数 / 行 |
|---|---|
| `src/octop/api/routers/product_library.py` | `/imports/analyze`(395) `/imports/commit`(428) |
| `src/octop/infra/product_library/batch_import.py` | `analyse_upload` / `commit_import`，`resolve_vision_model` 调用在 135 行 |
| `src/octop/infra/product_library/vision.py` | `resolve_vision_model`(64) `categorise_image`(146) `parse_categorisation_payload` |
| `src/octop/infra/agents/providers/probe.py` | `build_probe_chat_model`(43) |
| `src/octop/infra/agents/providers/store.py` | `resolve_multimodal_model_ref`（按 `input` 含 `image` 判定 vision） |

---

## 4. 实测证据

### 4.1 本机（localhost）实测 —— 2026-11-19

起本地服务 `python -m octop run --host 127.0.0.1 --port 8088`，打真实接口：

| 验证项 | 结果 |
|---|---|
| `/imports/analyze`、`/imports/commit` 路由注册 | ✅ 401（非 404） |
| analyze（3 PNG + 1 txt） | ✅ HTTP 200；txt → skipped(unsupported) |
| 无多模态模型时的行为 | ✅ 3 图 → failed("no enabled vision model")，**per-image 失败，不整体 500** |
| dry-run 不入库 | ✅ 产品/素材数不变，job 临时目录落盘 |
| commit（手动分组） | ✅ 创建 1 产品 + 导入 3 素材，文件落盘 |
| 越权隔离 | ✅ 另一用户 commit 同一 job → 404 |
| 数据清理 | ✅ DB 恢复、测试文件清理 |

本机降级原因：本机 providers 表为空 → 本机充当服务端时无法解析 vision 模型。这是**配置未就绪**，非设计缺陷。

### 4.2 远程后端实测 —— 2026-11-19（只读）

`ocdev.aixifs.com:13122`，web/DB 在 `/opt/Octop`、`/opt/octop-data/octop.db`：

| 验证项 | 结果 |
|---|---|
| 服务状态 | ✅ `octop.service` active；`/videogen/api/health` → 200 |
| 代码版本 | `ea0c24c5 wip: 备份线上工作树在途改动`（与本地 develop `6205ce99` 不同，为线上在途备份） |
| `batch_import.py` | ✅ 存在（13974 B，Nov 18 20:55） |
| `/imports/analyze` 路由 | ✅ 401（非 404），已注册 |
| `/imports/commit` 路由 | ✅ 401（非 404），已注册 |
| vision 调用链 | ✅ `resolve_vision_model` / `categorise_image` / `build_probe_chat_model` 均在 |
| provider 配置 | ✅ 1 条 `newapi`（kind=openai，`https://aikey4k.mengxa.com:8443/v1`，enabled） |
| vision 能力 | ✅ models_json 中 MiniMax-M3/M2.7/M2.5 标 `"input":["text","image"]`，会被判定为 vision 模型 |

**结论：远程后端已完整部署识别链路并配好带图像输入的模型，"服务端处理、回传识别数据"在真实部署上成立。桌面端连它即可拿到 AI 分组结果。**

> 注意：本次为只读核实，未在远程实际执行 analyze（会写入远程用户数据）。如需端到端验证真实 AI 分组，需由远程管理员在其上跑一次 analyze，或用专用测试账号。

---

## 5. 常见误解澄清（Q&A，直接引用）

**Q1：是不是要在"本机"配一个 vision provider 才能跑识别？**
A：不是。识别由**服务端**执行，桌面客户端连的是**远程 Octop 后端**，那里已配好 provider。本机 providers 表为空不影响真实桌面端使用。

**Q2：本机 providers 表只是什么？**
A：只是"服务端连哪个远程端点 + 用什么 key + 用哪个 model_id"的**连接配置**。模型计算全在 `base_url` 指向的远程端，本机不加载模型、不跑推理。

**Q3："远程服务端"指云端 LLM 还是自建 Octop 后端？**
A：两者是**串联**的两层，不冲突：
- 第一层「服务端」= 自建 Octop 后端，负责编排（接收图片、解析回传、入库）；
- 第二层「远程多模态模型」= Octop 后端通过 provider 配置的 `base_url` 调用的云端 LLM（MiniMax 网关等），负责真正的图像识别计算。

**Q4：本机实测时图片进了 failed，是不是功能坏了？**
A：不是。本机恰好被当成服务端，而本机 providers 表为空，才走 per-image 降级。真实桌面端连远程后端（已配 vision 模型）不会这样。

**Q5：当前版本的目录导入做到什么程度？**
A：M1（Web 选目录 → 识别分组 → 复核 → 入库）已实现并可用。M2（任务持久化/进度/断点续传）、M3（桌面端原生目录对话框）按 `docs/product-image-batch-import.md` 标注**尚未实现**。

---

## 6. 相关文档

- `docs/product-image-batch-import.md` —— 目录导入功能规划（M1/M2/M3）
- `docs/product-material-library.md` —— 产品素材库整体规划
- `docs/design/product-library-mvp.md` —— 素材库 MVP 设计
