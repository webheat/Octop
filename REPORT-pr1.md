# PR-1 报告：桌面运行时分层下载（源码层制品）

> 分支：`feature/layered-download-pr1`　执行环境：Linux（无 Windows 真机）
> 完成时间：2026-11-19
> 任务书：`docs/desktop-runtime-layered-download-task.md` §3 PR-1

## 一、完成项与 commit

| # | 内容 | commit |
|---|---|---|
| 1 | 分片打包：`desktop/portable/pack_portable_shards.py` + 薄壳 `package-shards.sh` | `8d3935b8` |
| 2 | 下载器：`bootstrap.Part.Append`、`download.go` 的 `Merge: true` / `Platform` / 平台校验 | `a2858acd` |
| 3 | CI：新增 `shards` job（仅产出 artifact，不发布、不被引用） | `27d92dbd` |
| 4 | 本报告 | 见本 commit |

`desktop/portable/package.sh` **未改动**：按设计文档 §7.1 两条线并存，整包 zip 继续作为
现有发版路径；分片是新增旁路。

## 二、分片设计

### 2.1 part 清单

| part id | 内容 | target | append | required |
|---|---|---|---|---|
| `runtime` | `runtime/` + `launch.py` / `start.sh` / `start.bat` / `README.txt` / `VERSION.txt` | `""`（根） | false | true |
| `deps-core` | `packages/` 下除 app / 可选组之外的全部文件 | `packages` | false | true |
| `app` | `packages/octop/` + `packages/octop-*.dist-info/` | `packages` | true | true |
| `deps-tencent` | tencentcloud-sdk-python | `packages` | true | false |
| `deps-google` | google-api-python-client 及其专有依赖 | `packages` | true | false |
| `deps-boto` | boto3 / botocore / s3transfer / jmespath / aioboto3 / aiobotocore | `packages` | true | false |
| `deps-lark` | lark-oapi | `packages` | true | false |

- 格式统一 `tar.gz`（设计文档 §4.1：Windows 无 symlink 权限、Go stdlib 可直接流式解压）。
  归档内路径**相对各自 target**，因此 `stripRoot: false`。
- 可选组为空时不产出空分片，直接从 manifest 省略。
- `--zip` 模式解包时会还原 zip 里的 Unix mode 与符号链接（`zipfile.extractall` 会丢
  mode，导致 runtime 的 python 不可执行），保证从 CI 的 portable zip 直接分片也正确。

### 2.2 为什么必须调整 `target` 与新增 `Append`

任务书原文建议 `app` 用 `target: packages/octop`、其余分片 `target: packages`。实现时
核对 `desktop/src/bootstrap/unpack.go:22-28` 发现问题：`Extract` 对 target 目录**无条件
`os.RemoveAll`**（契约是"目录归归档所有"）。因此：

- 多个分片共用 `packages` 会互相清空，`deps-core` 会把 `app` 删掉；
- `app` 若只解到 `packages/octop`，`octop-*.dist-info` 无法落在 `packages/` 根，
  而 `download.go:128-145` 的版本识别和 `importlib.metadata.version("octop")` 依赖它。

因此新增了一个**加法式**的分片字段，不改动既有语义：

- `bootstrap.Part.Append`（JSON `append`，默认 false）：同名 target 的**第一个**分片照旧
  清空目录，后续分片改为 `ExtractOver`（只写入、不删除）。`ExtractOver` 由 `Extract`
  拆出的 `extractInto` 复用，video components 的 `core + browser` 行为完全不变。
- 仍是"只允许一个根 part"：`runtime` 的 `target` 为空且排在第一位，`download.go` 打开
  `Merge: true` 后符合 `validateParts`（`bootstrap.go:171-197`）的约束。
- `app` 改为 `target: packages` + `append: true`，`octop` 与 dist-info 一起落在
  `packages/` 根；`deps-core` 排在 `app` 之前，先清空再叠加。

这是本次唯一超出"只改一行 Go"的改动，原因如上；未改变任何既有 manifest 的行为
（无 `append` 字段的 manifest 与旧客户端语义一致）。

### 2.3 可选组的划分依据

`google/`、`protobuf` 这类顶层目录是多个发行版共享的命名空间，按目录名切会切错。
脚本改为读每个 `*.dist-info/RECORD`，建立"文件 → 发行版"映射，再按**发行版名**
归组（`scripts/pack_video_components.py` 没有这个问题，因为它是手工分树）。

当前组成员是**临时**的：设计文档 §4.2 的精确切分依赖 PR-0 的 extras 化；PR-0 落地后
只需改脚本顶部的 `OPTIONAL_GROUPS` 常量即可，无需改 Go 或 CI。

### 2.4 兼容性

- **旧路径不变**：无 manifest / 单 zip URL 仍走 `runtimeParts()` 的单 part 分支；
  有 manifest 但没有 `append` 字段的旧 manifest 行为不变。
- **新增平台校验**只针对 `manifest.Platform != ""` 且与 `greenPlat()` 不一致的情况；
  现有不带 `platform` 的测试 manifest 不受影响。
- **版本/目录**：分片整体解压到 `portableDir()`；`VERSION.txt` 在根分片，
  `packages/octop-*.dist-info` 在 app 分片，`portableVersion()` 两条来源都保留。
- `launch.py` 的 `site.addsitedir(packages)` 无需改动：所有包分片最终都落在 `packages/`
  根，保持扁平布局。

## 三、验证命令与结果

### 3.1 Go

```bash
cd desktop/src
go test ./bootstrap/...                       # ok  octop.desktop/bootstrap
gofmt -l bootstrap download.go portable_download_test.go   # 无输出
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./...     # 通过
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./...       # 通过
```

本机 Linux 原生 `go build ./...` 失败于 Wails 依赖的 GTK：本机 Ubuntu 22.04 只有
GTK 4.6，Wails v3 beta.13 需要 `GtkFileDialog`（GTK ≥ 4.10）。这是**环境**问题，
与本次改动无关；因此改用 Windows 目标交叉编译 + vet 覆盖主包，`bootstrap` 包单测在本机实跑。

新增单测：

- `TestRunMergeAppendsToSharedTarget`：根分片 + 清空型 `deps-core` + append 型 `app`，
  断言三个分片的文件同时存在（证明 append 不会清掉前序分片）。
- `TestBootstrapRuntimeRejectsAManifestForAnotherPlatform`：`platform=plan9-z80` 的
  manifest 被拒绝，错误含 `platform mismatch`。

> 说明：`desktop/src` 主包的单测（含新增的平台用例）在本机**无法执行**——编译主包即
> 需要 GTK 4.10+。交叉编译与 `go vet` 已确认其可编译；执行留给 Windows/CI。

### 3.2 Python / Shell / YAML

```bash
python3 -m py_compile desktop/portable/pack_portable_shards.py   # 通过
bash -n desktop/portable/package-shards.sh                        # 通过
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/octop-desktop.yml'))"  # YAML_OK
```

分片脚本干跑（合成树，非真实运行时）：

```
$ python3 desktop/portable/pack_portable_shards.py \
    --staging /tmp/shards-dryrun/Octop-testplat --plat testplat --version 1.4.0 \
    --out-dir /tmp/shards-dryrun/out
[runtime-shards] manifest: /tmp/shards-dryrun/out/testplat/manifest.json
  - runtime           0.0 MB  required=True append=False target=<root>
  - deps-core         0.0 MB  required=True append=False target=packages
  - app               0.0 MB  required=True append=True target=packages
  - deps-tencent      0.0 MB  required=False append=True target=packages
  - deps-google       0.0 MB  required=False append=True target=packages
  - deps-boto         0.0 MB  required=False append=True target=packages
  - deps-lark         0.0 MB  required=False append=True target=packages
```

tar 内容抽样：`runtime.tar.gz` 含 `runtime/bin/python3` + 启动器；`deps-core.tar.gz`
含 `requests/` 与未归属文件；`app.tar.gz` 含 `octop/` 与 `octop-1.4.0.dist-info/`；
`deps-tencent` / `deps-google` / `deps-boto` / `deps-lark` 各自只含对应发行版。

### 3.3 pre-commit

三次 commit 均走完整 hook（`make format` / `lint` / `typecheck` / `test-smoke`）：

```
[lint] Ruff check... All checks passed!
[typecheck] mypy... Success: no issues found in 697 source files
[test-smoke] 82 passed
[pre-commit] all checks passed
```

未使用 `--no-verify` / `SKIP_PRECOMMIT`。

## 四、未完成 / 需 Windows 真机验证

1. **真实 Windows 运行时 zip 的分片未在本机生成**：本机无法运行 `bootstrap-runtime.sh
   windows-*` 与 `package.sh windows-*`（需要 Windows runner 或 Docker 交叉环境）。
   CI 的 `shards` job 会在真实 Windows zip 上执行，但本机只做了合成树干跑。
2. **分片安装的端到端验证**：`runtime → deps-core → app` 三个 tar 解压后能否直接
   `start.bat` 启动、`import octop` 成功，未在真机跑。Go 单测覆盖了 append 语义，
   未覆盖真实 250MB 运行时。
3. **主包单测未执行**（GTK 版本限制，见 §3.1）。
4. **可选分组成员**是临时切分，PR-0 extras 化之前不保证依赖闭包完整；且 PR-5 的
   后台补装尚未实现，`required:false` 分片当前会被 `bootstrap.Run` 直接跳过
   （`bootstrap.go:159-162`），这符合本 PR 的范围。
5. **CI `shards` job 未实际触发**：只做了 YAML 解析校验，未 push（任务约束禁止 push）。
6. **manifest URL 为占位符**：未发布场景下使用 `https://downloads.example.invalid/...`；
   真正发布时需要 `--base-url` 传入 Release/COS 地址。

## 五、本机无法处理、需汇总到 docs/

以下条目建议在 `docs/desktop-bootstrap-installer.md`（或新增 `docs/desktop-runtime-shards.md`）
补齐，因为都需要 Windows 真机结果才能定稿：

### 1. 真实运行时体积与分片收益

- **原因**：本机无法构建 windows-amd64/arm64 运行时 zip（`bootstrap-runtime.sh` 需在
  目标平台或 CI 上执行，产物约 250MB）。
- **Windows 真机操作**：
  1. 运行 `bash desktop/portable/bootstrap-runtime.sh windows-amd64`；
  2. 运行 `bash desktop/portable/package.sh windows-amd64`；
  3. 运行 `python desktop/portable/pack_portable_shards.py --zip desktop/portable/release/Octop-portable-windows-amd64-<ver>.zip --out-dir dist/shards`；
  4. 记录各 part 的 `size`（manifest 内）。
- **验收标准**：`runtime + deps-core + app` 三片之和与整包差距在压缩率预期内
  （分片不重复压缩、总字节 ≈ 整包 ±5%）；可选片体积与任务书 §1 的估算一致
  （tencent ≈17.7MB、google ≈14.8MB、boto ≈13MB、lark ≈5MB，压缩前）。

### 2. 分片安装后的首启

- **原因**：本机不能运行 Windows GUI 壳，也无法验证 `start.bat` / 长路径 / 杀软扫描。
- **Windows 真机操作**：
  1. 把 `dist/shards/<plat>/` 下的分片放到本地 HTTP 服务；
  2. 生成带 `PORTABLE_RUNTIME_MANIFEST_URL` 的 slim 安装包
     （`wails3 task package ARCH=amd64 VERSION=<ver> PORTABLE_RUNTIME_MANIFEST_URL=...`）；
  3. 安装并首启，观察 `%LOCALAPPDATA%`（或 `~/.octop/portable`）下是否出现
     `runtime/`、`packages/octop/`、`packages/octop-*.dist-info/`；
  4. 断网/杀进程后重启，确认断点续传与 `state.json` 生效。
- **验收标准**：首启成功进入主界面；`packages/` 下同时存在 deps-core 与 app 的文件
  （证明 append 生效）；关掉可选分片下载时应用仍能启动（当前必装片之外不依赖可选片）。

### 3. Windows 长路径与 tar 解压

- **原因**：设计文档 §5.3 明确 MAX_PATH 260 与 Defender 扫描需要真机验证；本机无法
  复现。
- **Windows 真机操作**：在默认 `%LOCALAPPDATA%\Octop\...` 路径下完成 §2 的安装，
  再在较深的用户目录（如 `C:\Users\<长用户名>\AppData\Local\...`）重复一次。
- **验收标准**：解压无 `path too long` 报错；`packages/` 内最长的 `.dist-info` 路径
  可正常创建。

### 4. 平台校验与镜像 fallback

- **原因**：需要真实 manifest 与多镜像环境。
- **Windows 真机操作**：manifest 写 `platform: windows-arm64` 后在 amd64 机器上启动，
  应报"平台不匹配"；再把首个镜像指向 404，确认自动切到第二个镜像。
- **验收标准**：平台不符时**不落盘**且给出可读错误；镜像 1 失败后镜像 2 完成下载，
  最终 sha256 校验通过。

### 5. 可选分组的最终定义

- **原因**：依赖闭包需要 PR-0（extras 化）+ harness 发版后才能确定；本机无法判断
  `google/`、`protobuf` 等共享命名空间的最终归属。
- **操作**：PR-0 落地后，对照 `pyproject.toml` 的 extras 重新填
  `pack_portable_shards.py` 的 `OPTIONAL_GROUPS`，并在 docs 固化"组 ↔ 发行版"表。
- **验收标准**：每个可选组装完可独立 `import` 其主包（`tencentcloud` / `googleapiclient`
  / `boto3` / `lark_oapi`）；不装可选组时核心启动无 ImportError。

### 6. CI 分片 job 的首次真实运行

- **原因**：任务约束禁止 push，本机无法触发 GitHub Actions。
- **操作**：推送分支/开 PR 后查看 `Octop Desktop Package` 的
  `Runtime shards (artifact only, not published)` job，下载 `octop-runtime-shards-pr1`
  artifact。
- **验收标准**：job 绿；artifact 内含 `<plat>/manifest.json` 与各 `*.tar.gz`；
  `release` / `upload-cos` 未因该 job 改变行为（仍只挂整包 zip 与安装器）。
