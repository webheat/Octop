# PR-0 交付报告：桌面运行时依赖瘦身

> 分支：`feature/layered-download-pr0`（独立 worktree，未 push / 未打 tag / 未动 `/opt/Octop` 主工作区）
> 范围：仅 `docs/desktop-runtime-layered-download-task.md` §3 的 **PR-0**（依赖定义侧瘦身，不改 Go 代码）

## 0. 结论

| 项 | 结果 |
|---|---|
| `playwright`（约 36–47MB） | 已从 `[project] dependencies` 移入已有 `browser` extra；`src/octop` 内无模块级 `import playwright` |
| `tencentcloud-sdk-python`（约 17.7–18.8MB） | 模块级 import 已改为函数内惰性；已移入新 `tencentcloud` extra |
| `uv.lock` | 已重跑，diff 仅 9 增 5 删（未改写索引源）；`uv lock --check` 通过 |
| `uv export --frozen` | 可用；核心导出不含上述两个包，`--extra browser --extra tencentcloud` 时包含 |
| 静态检查 | `ruff check`、`ruff format --check`、`mypy --strict` 全绿 |
| 测试 | 受影响的 unit/integration 全绿；全量 `-m "not live"` 见 §2.4（含 2 个与本改动无关的既有失败） |
| 行为验证 | 用 import blocker 模拟「未安装 SDK / 未安装 playwright」，核心模块与路由仍可导入 |

---

## 1. 完成项与提交

| Commit | 内容 |
|---|---|
| `7239dd56` | `refactor(cloud): 腾讯云 SDK 改为函数内惰性导入` |
| `8cd12514` | `build(deps): playwright 与腾讯云 SDK 移出核心依赖` |

### 1.1 `playwright`

- `pyproject.toml`：从 `[project] dependencies` 删除 `playwright>=1.40`，保留在 `browser` extra（并更新注释：Chromium 仍由 `POST /api/browser/install` 按需下载）。
- 全仓库扫描：`src/octop` 中唯一 `import playwright` 是 `src/octop/api/routers/browser/env.py:81`，位于函数内 `try/except ImportError`，保持原样即可；`octop-browser` / `octop-harness` 都不依赖 playwright（见 `uv.lock`）。
- 模拟缺失验证：用 `sys.meta_path` 拦截 `playwright` 后，`octop.infra.server` / `octop.api.app` / `octop.cli.main` 均可导入，`_probe_env()["playwright"] is False`。
- 按需安装路径不受影响：`octop_browser.install.install_chromium_stream()` 在检测到
  playwright 不可用时会自行 `pip install playwright` 再下载 Chromium（外部包既有行为），
  因此 `POST /api/browser/install` 仍可用。

### 1.2 `tencentcloud-sdk-python`

- `src/octop/infra/cloud/tencent.py`：
  - 删除 8 行模块级 import。
  - 新增惰性访问器 `_cvm_client()` / `_cvm_models()` / `_monitor_client()` / `_monitor_models()` / `_sdk_exception()`。
  - `_profile()` / `_credential_of()` 内部按需 import；类型注解改到 `TYPE_CHECKING` 块（`Credential` / `ClientProfile`）。
  - `_ACTIONS` 改为保存类名字符串，`instance_action()` 内 `getattr(_cvm_models(), name)`，避免模块导入期触碰 SDK。
- `src/octop/api/routers/cloud.py`：**无需改动**。它只从 `octop.infra.cloud.tencent` import 符号（类/函数），不直接 import `tencentcloud.*`；惰性化后该模块在 SDK 缺失时仍可正常 import。
- 模拟缺失验证：拦截 `tencentcloud` 后，`octop.api.routers.cloud` 可导入（12 条路由注册成功），纯函数 `build_authorization()` 正常，5 个惰性访问器均在调用时才抛 `ImportError`。
- 测试适配：
  - `tests/unit/infra/cloud/test_tencent_catalog.py`：monkeypatch 目标从 `tencent.cvm_client` 改为惰性访问器 `tencent._cvm_client`。
  - `tests/unit/infra/cloud/test_tencent_trend.py`：同上，改用 `tencent._monitor_client`。

### 1.3 依赖定义

```toml
# 新增
tencentcloud = ["tencentcloud-sdk-python>=3.1.166"]

# 保留（playwright 现在的主入口）
browser = ["playwright>=1.40"]
```

`tencentcloud-sdk-python` 同时加入 `dev`（`[dependency-groups].dev` 与
`[project.optional-dependencies].dev`），原因：`tests/unit/infra/cloud/*` 直接
`import tencentcloud`，而 CI 的 `uv sync` 默认不装 extras。`uv export --no-dev`
不会把它带进便携运行时。

---

## 2. 验证命令与关键输出

### 2.1 锁文件与导出

```console
$ UV_INDEX_URL=http://192.168.20.173:4874/simple/ uv lock
Resolved 256 packages in 2.80s

$ UV_INDEX_URL=http://192.168.20.173:4874/simple/ uv lock --check
Resolved 256 packages in 1ms

$ uv export --project . --frozen --no-dev --no-emit-project --no-hashes -o /tmp/requirements-windows-amd64.txt
exit=0   # 767 行；playwright / tencentcloud 出现次数 = 0
```

> 注意：首次直接 `uv lock` 时本机默认索引是 PyPI，会把 `uv.lock` 里全部 256 个包的
> URL 从内部镜像改写成 pypi.org（约 6000 行噪声）。已回滚并用
> `UV_INDEX_URL=http://192.168.20.173:4874/simple/` 重跑，最终 lock diff 仅
> 9 行新增 / 5 行删除。

对照验证（`uv export --extra browser --extra tencentcloud`）：

```console
playwright==1.61.0
tencentcloud-sdk-python==3.1.201
```

### 2.2 静态检查

```console
$ uv run ruff check src tests
All checks passed!

$ uv run ruff format --check src tests
1343 files already formatted   # 1 个测试文件格式修正后

$ uv run mypy src/octop
Success: no issues found in 697 source files
```

### 2.3 惰性导入行为（新增的一次性验证脚本，未入库）

```console
$ uv run python -I /tmp/check_lazy_tencent.py
module import OK; routes: 12
pure helper OK: https://cloud.tencent.com/open/authorize
_cvm_client: lazy ImportError as expected
_cvm_models: lazy ImportError as expected
_monitor_client: lazy ImportError as expected
_monitor_models: lazy ImportError as expected
_sdk_exception: lazy ImportError as expected

$ uv run python -I /tmp/check_no_playwright.py
core imports OK; _probe_env playwright = False
```

### 2.4 测试

受影响的子集：

```console
$ uv run pytest tests/unit/infra/cloud -q
28 passed

$ uv run pytest tests/integration/test_cloud_api.py tests/integration/test_browser_api.py -q
14 passed
```

全量（`uv sync --frozen` 之后，venv 中已无 playwright，贴近 CI 环境）：

```console
$ uv run pytest -m "not live" -q
FULL_SUITE_RESULT_PLACEHOLDER
```

两个**与本改动无关**的既有失败（在当前分支 `HEAD` 上就存在，本次未触碰相关文件）：

| 失败测试 | 原因 | 证据 |
|---|---|---|
| `tests/unit/test_portable_prune.py`（3 例） | 测试加载 `desktop/portable/prune_packages.py`，该文件在本分支不存在 | `git cat-file -e HEAD:desktop/portable/prune_packages.py` → 不存在；`git log --all --` 无记录 |
| `tests/unit/test_fnos_docker_persist.py`（3 例） | 测试期望 compose 镜像 tag `0.0.0`，实际文件是 `1.5.0` | `git show HEAD:fnos/docker/app/docker/docker-compose.yaml` 已是 `1.5.0` |

未跑：`-m live`（需要真实 LLM/外部服务，按仓库约定跳过）；Windows CI 与真机打包。

---

## 3. 体积影响

任务书给出的 1.4.0 Windows zip 实测（246,105,871 字节）中：

| 依赖 | 任务书实测 zip 占用 | 本机实测（Linux 轮子，deflate） |
|---|---|---|
| `playwright` | 36MB | 原始 138.7MB → zip 47.4MB（含 `driver/` 131MB） |
| `tencentcloud-sdk-python` | 17.7MB | 原始 170.8MB → zip 18.8MB |
| 合计 | **53.7MB** | **66.2MB** |

按任务书数字估算：`246 − 53.7 ≈ 192.3MB`；按本机当前锁定版本
（playwright 1.61.0 / tencentcloud 3.1.201）压缩比估算：`246 − 66.2 ≈ 179.8MB`。
两者都说明「去掉两个包」后落在 **180–192MB** 区间；能否稳定 ≤190MB 必须在
Windows 上按真实轮子重打后确认（Windows 版 playwright driver 与 zip 压缩率不同）。

### Windows 真机验证步骤（本机无法完成）

```powershell
# 1. 取分支
git fetch && git switch feature/layered-download-pr0

# 2. 确认导出已剔除两个包（不依赖 extras）
uv export --frozen --no-dev --no-emit-project --no-hashes -o req.txt
Select-String -Path req.txt -Pattern 'playwright|tencentcloud'   # 应无输出

# 3. 重打便携运行时（需先准备便携 CPython）
bash desktop/portable/bootstrap-runtime.sh windows-amd64
bash desktop/portable/package.sh windows-amd64

# 4. 记录体积
Get-Item desktop/portable/release/Octop-portable-windows-amd64-*.zip |
  Select-Object Name, Length
# 验收：Length ≤ 190MB（199,229,440 字节左右）

# 5. 确认 zip 内不再包含两个包目录
tar -tf desktop/portable/release/Octop-portable-windows-amd64-*.zip |
  Select-String 'packages/(playwright|tencentcloud)/'   # 应无输出

# 6. 首启冒烟：解压 → start.bat → 打开 Dashboard，验证
#    素材库 / 浏览器环境页 / 视频环境诊断 / 聊天 正常
#    （云工作台在未安装 tencentcloud extra 时会不可用，属预期，见 §5）
```

---

## 4. 未完成项与已知风险

1. **未在 Windows 真机重打 zip**：本机是 Linux，无法生成 Windows 便携包；体积验收以 §3 步骤为准。
2. **Docker / fnos / 安装脚本的 extras 未跟进**（超出本次允许改动范围，见 §5）：
   - 这些部署方式之前靠「核心依赖」隐式获得 `tencentcloud-sdk-python`，改动后云工作台会因缺少 SDK 而不可用。
   - `fnos/docker/Dockerfile` 的 full 变体此前也靠核心依赖获得 playwright，改动后会缺失（`deploy/docker/Dockerfile` 的 full/lite 都显式带 `--extra browser`，不受影响）。
3. **未安装 SDK 时的用户提示**：当前调用云接口会抛 `ImportError`（路由返回 5xx）。按路线图这属于 PR-5（按需补装 + 进度/提示）的范围，本次未实现，以免超出 PR-0。
4. **未改 `scripts/install.sh` / `install-octop.sh` 的过时注释**（仍写着「playwright 是核心依赖」）。行为上安装脚本始终合并 `browser` extra，playwright 仍会安装；但 `tencentcloud` 不在默认合并列表里。

---

## 5. 本机无法处理、需汇总到 docs/

以下事项必须在 Windows 真机或其它仓库完成，建议整理进
`docs/desktop-runtime-layered-download-task.md` / `docs/desktop-bootstrap-installer.md`：

### 5.1 Windows 真机重打运行时 zip 并验收体积

- **原因**：便携 CPython / Windows 轮子 / zip 压缩率只能在 Windows 上真实测量。
- **步骤**：见 §3「Windows 真机验证步骤」。
- **验收标准**：`Octop-portable-windows-amd64-*.zip` ≤ 190MB；zip 内无
  `packages/playwright/` 与 `packages/tencentcloud/`；首启后素材库/浏览器/视频/聊天无回归。

### 5.2 部署侧补齐 `tencentcloud` extra（Docker / fnos / 安装脚本）

- **原因**：`tencentcloud-sdk-python` 已不再是核心依赖，而下列入口没有显式安装该 extra：
  - `deploy/docker/Dockerfile`：lite/full 均只有 `browser` 等 extras；
  - `fnos/docker/Dockerfile`：lite 为 `.[browser]`，full 为
    `.[desktop,local-embedding,knowledge-ocr]`（顺带：full 还缺 `browser`，此前靠核心依赖获得 playwright）；
  - `scripts/install.sh` / `scripts/install-octop.sh`：默认只合并 `browser`；
  - `bootstrap/bootstrap.sh`：安装裸 `octop`。
- **步骤**：在上述入口按需追加 `--extra tencentcloud` / `[tencentcloud]`；同步更新
  「playwright 是核心依赖」的过时注释。
- **验收标准**：对应镜像/安装产物中 `python -c "import tencentcloud"` 成功，云工作台可用；
  fnos full 镜像中 `python -c "import playwright"` 成功。

### 5.3 PR-0b（跨仓库，减重天花板）

- **原因**：`googleapiclient`（约 14.8MB）与 `boto3`/`botocore`（约 13MB）来自
  `octop-harness[all]`，本仓库改不掉。
- **步骤**：`octop-harness` 提供收窄的 `[base]` extra，本仓库把
  `octop-harness[all]` 改为 pin 该 extra 并升版本；`octop-gateway` 解掉 `lark-oapi`
  硬依赖（若要裁飞书）。
- **验收标准**：`uv export --no-dev` 不再出现 `google-api-python-client` / `boto3`，
  重打 zip 后体积继续下降且核心功能不回归。

### 5.4 PR-5 按需补装 + 缺失提示

- **原因**：现在 `bootstrap.Run()` 对 `required:false` 的 part 直接跳过，且未安装
  `tencentcloud` 时云接口只抛 `ImportError`。
- **步骤**：在用户进入云工作台等入口时触发 `runtime_packages.install_packages()` 或
  下载可选 part；接口层把 `ImportError` 映射为可读提示（如「请安装 octop[tencentcloud]」）。
- **验收标准**：slim 客户端未预装 SDK 时，进入云工作台能安装并按需生效，或至少得到
  明确可操作的提示。
