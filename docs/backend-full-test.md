# 后端全量测试（定时）

> 每天凌晨定时对**当前后端**跑一次完整 pytest，再用**子代理模型**
> （默认 `qiniu/conatus-free`，连续 429 会自动切到备用模型）分析测试结果，
> 产出可读的失败归因报告。

只做后端事务：不碰 `dashboard/`、不构建前端（边界见
[deployment-boundary.md](./deployment-boundary.md)）。

## 组成

| 部件 | 位置 | 作用 |
|---|---|---|
| 编排脚本 | `scripts/run_backend_full_test.py` | 跑测试 → 调子代理分析 → 出报告 |
| systemd 服务 | `/etc/systemd/system/octop-backend-full-test.service` | 一次性任务，输出追加到 `/opt/octop-data/logs/backend-full-test.log` |
| systemd 定时器 | `/etc/systemd/system/octop-backend-full-test.timer` | 决定什么时候拉起 |

## 运行流程

1. **预检** —— 服务可达、仓库与 venv 就位、pytest 可导入。
2. **跑测试（脚本自己跑，不经 LLM）** —— 在仓库根目录执行
   `python -m pytest -m "not live" -q`，后台运行 + 轮询，落完整日志与退出码。
   - **测试跑在独立的沙箱数据目录里**（`TEST_ISOLATED_HOME`，默认
     `/opt/octop-data-test-home`）—— 见下节「测试沙箱」，这是硬要求；
   - 跑完了但有失败用例 → 这是**结论**，不重试，直接进分析；
   - 跑不起来（解释器缺失、依赖缺失、收集阶段崩溃、进程被杀、**日志被删**）→
     **不可跳过的异常**，重试，累计 3 次仍失败就终止。
3. **子代理分析** —— 一个 Octop 子代理（`task_type=agent`，模型
   `newapi/qiniu/conatus-free`）用 shell 读日志，产出 Markdown 分析报告：
   失败用例清单、按根因归类、真回归 vs 偶发、严重度排序与下一步建议。
   分析失败按 3 次重试（退避 60s / 120s）。
4. **模型容灾（429）** —— 主模型连续 3 次仍撞 429 限流时，自动切到备用模型
   （默认 `newapi/MiniMax-M3.1-Flash-Preview`）重跑分析；见下节。
5. **出报告** —— 落到 `/opt/octop-data/test-reports/`：
   - `pytest-<时间戳>.log` —— 完整测试输出
   - `report-<时间戳>.json` / `report-<时间戳>.md` —— 测试结论 + 子代理分析 + 容灾记录

退出码：`0` = 全过；`1` = 有失败用例（报告里仍有分析）；`2` = 不可跳过的异常
（重试 3 次后终止）。

## 测试沙箱（硬要求）

全量测试**绝对不能**跑在生产 `OCTOP_HOME`（`/opt/octop-data`）上。

原因：测试里有 `octop clean --all`（`tests/unit/cli/test_clean_cmd.py`）和
`octop init --force` 这类**会删数据**的用例。`PathLayout.from_env()` 优先读环境变量
`OCTOP_HOME`，所以只要环境里带着生产的 `OCTOP_HOME`，这些用例就会把线上
DB、config、agent 工作区连同**正在写的 pytest 日志**一起删掉。

2026-11-22 凌晨 02:30 那次就是这么炸的：`test_clean_all_requires_confirmation`
在 03:17 把 `/opt/octop-data` 整个清空 → 线上 DB 只剩测试造的 `alice` 账号、
pytest 日志消失 → 脚本拿到「退出码 1、无汇总行」，子代理打开日志发现文件不存在，
交了一份「无法分析」的报告。结论和证据全是假的。

现在有四道防线：

| 防线 | 位置 | 作用 |
|---|---|---|
| 沙箱目录 | `scripts/run_backend_full_test.py`（`pytest_env()`） | pytest 子进程的 `OCTOP_HOME` / `HOME` 指向 `TEST_ISOLATED_HOME`，与生产目录无关 |
| 环境隔离 | `tests/conftest.py`（`_isolated_octop_home`） | 每个测试都把环境里的 `OCTOP_HOME` 清掉，根目录只能解析到隔离过的 `HOME`；手跑 pytest 也不会误伤线上 |
| 证据校验 | `scripts/run_backend_full_test.py`（`classify_run()` / `analysis_saw_no_log()`） | 日志消失或为空 → 判为**异常**重试；子代理说「日志不存在」→ 判为**分析无效**重试 |
| systemd 闸门 | `…/octop-backend-full-test.service.d/20-sandbox.conf` + `ExecStartPre=/usr/local/sbin/octop-full-test-sandbox-guard.sh` | 脚本里的沙箱化一旦被回退，直接拒绝启动（响亮失败），而不是让 `octop clean --all` 去删生产数据 |

> 沙箱目录默认放在生产目录**外面**（`/opt/octop-data-test-home`），避免清理测试
> 波及 `/opt/octop-data`。每次跑之前脚本会把这个沙箱清空重来。

### 父进程的 `OCTOP_HOME` 必须是生产目录

沙箱**只作用在 pytest 子进程**上。父进程的 `OCTOP_HOME` 必须是 `/opt/octop-data`
（生产），原因有二：

- `mint_admin_token()` 从 `OCTOP_HOME` 的库里读 `secrets.jwt` 与 `admin` 用户来签
  token，线上服务只认这个 secret；
- 分析阶段的 agent 工作区是 `Path(OCTOP_HOME)/"agents"/<agent_id>`，而线上服务
  写在 `/opt/octop-data/agents`。

把父进程也指到沙箱，脚本会死在第一步——「不可跳过的异常：本地 DB 里没有 jwt
secret，无法签发 token」——因为沙箱每次跑测试前都会被清空重建，永远不会有 secret。

## 模型容灾（429 切换）

分析步骤的模型链：**主模型 → 备用模型**。

| 情况 | 行为 |
|---|---|
| 主模型分析失败，但不是 429 | 重试 3 次（退避 60s / 120s），仍失败即终止，**不换模型**（换模型也救不了） |
| 主模型连续 3 次都是 429 | 切到备用模型，备用模型上再重试 3 次 |
| 备用模型也失败 | 终止，出 error 报告 |

切换的实现方式是改写分析 cron job 的 `model` 字段
（`PATCH /api/agents/{agent_id}/cron/{cron_id}`），跑完后再恢复成主模型，
避免污染下一次手动执行。

**429 判定**看错误文本里有没有 `RateLimitError` / `rate_limit` / `too many requests` /
`error code: 429` / `free_campaign_global_limit` 这些标记。

**"是哪个模型 429"** 有两处来源，都写进脚本日志与报告：

1. 脚本自己知道这一轮用的是哪个模型（主模型还是备用）；
2. 服务端日志（`TEST_SERVER_LOG`）里该模型最近的 429 证据行 —— 脚本只读本次
   尝试**之后**新增的日志（按字节偏移），不会把上次运行的旧 429 算进来。

日志里长这样：

```
[2026-11-22 02:41:03] 分析第 1/3 次失败（模型 newapi/qiniu/conatus-free）：子代理执行失败：... RateLimitError: Error code: 429 ...
[2026-11-22 02:41:03] 分析第 1/3 次失败（模型 newapi/qiniu/conatus-free）：... —— 命中 429 限流，证据：... chat model 'newapi/qiniu/conatus-free' failed ... Error code: 429
[2026-11-22 02:44:05] ⚠ 命中 429 的模型：newapi/qiniu/conatus-free（连续 3 次） → 切换到备用模型 newapi/MiniMax-M3.1-Flash-Preview
[2026-11-22 02:44:06] cron job 的分析模型已切换为 newapi/MiniMax-M3.1-Flash-Preview
```

报告（`report-<时间戳>.md`）里的「模型容灾」小节会列出每一次尝试的模型、结果、
是否 429，以及 429 证据行。

## 模型引用写法

Octop 的模型引用是 `<provider>/<model_id>`，按**第一个**斜杠切分。网关上的模型 id
本身带斜杠（`qiniu/conatus-free`），所以正确写法是：

```
newapi/qiniu/conatus-free      # provider=newapi, model_id=qiniu/conatus-free
```

写成 `qiniu/conatus-free` 会被解析成 provider `qiniu`，报
`Unknown provider 'qiniu' in model ref`。

模型还必须登记进该 provider 的 `models_json`（harness 只暴露登记过的模型），
脚本每次运行都会检查并自动补登记。

## 常用操作

```bash
# 立刻手动跑一次（默认全量）
scripts/run_backend_full_test.py

# 只做预检与准备（不跑测试）
scripts/run_backend_full_test.py --setup-only

# 用小子集试跑整条链路
TEST_PYTEST_ARGS='-q tests/unit/i18n' scripts/run_backend_full_test.py

# 改次数 / 超时
scripts/run_backend_full_test.py --attempts 5 --timeout 7200

# 定时器
systemctl list-timers octop-backend-full-test.timer
systemctl start octop-backend-full-test.service      # 立刻手动触发一次
journalctl -u octop-backend-full-test.service -n 100  # 或看日志文件
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCTOP_HOME` | `/opt/octop-data` | Octop 数据目录（DB、agent 工作区） |
| `OCTOP_BASE_URL` | `http://127.0.0.1:8088/videogen` | 后端 API 根 |
| `OCTOP_REPO` | `/opt/Octop` | 被测仓库 |
| `TEST_MODEL` | `qiniu/conatus-free` | 网关侧模型 id（主） |
| `TEST_MODEL_REF` | `newapi/qiniu/conatus-free` | Octop 侧模型引用（主） |
| `TEST_FALLBACK_MODEL` | `MiniMax-M3.1-Flash-Preview` | 备用模型 id；留空即关闭容灾 |
| `TEST_FALLBACK_MODEL_REF` | `newapi/MiniMax-M3.1-Flash-Preview` | 备用模型引用 |
| `TEST_SERVER_LOG` | `/opt/octop-data/logs/octop.log` | 服务端日志（找 429 证据行） |
| `TEST_ISOLATED_HOME` | `/opt/octop-data-test-home` | **测试沙箱数据目录**（pytest 的 `OCTOP_HOME` / `HOME`），必须与生产目录无关 |
| `TEST_MAX_ATTEMPTS` | `3` | 不可跳过异常时的最大尝试次数（也用于分析重试与每个模型的尝试次数） |
| `TEST_TIMEOUT` | `5400` | 单次测试超时（秒） |
| `TEST_ANALYSIS_TIMEOUT` | `1800` | 子代理分析超时（秒） |
| `TEST_TOKEN_TTL` | `86400` | 脚本自签的 admin token 有效期（秒）；要覆盖 pytest + 分析重试的总时长 |
| `TEST_PYTEST_ARGS` | `-m "not live" -q` | pytest 参数 |
| `TEST_PYTHON` | `/opt/Octop/.venv/bin/python` | 解释器 |

## 注意事项

- **脚本直接用 venv 解释器**（`/opt/Octop/.venv/bin/python`），不依赖运行时联网同步依赖。
  内网 PyPI 源 `192.168.20.173:4874` 已下线，包源已切到腾讯云公网镜像
  （`pyproject.toml` 的 `[tool.uv] index-url` + `uv.lock`），`uv run` 现在也能用，
  但定时任务不碰网络更稳。
- **免费模型会限流** —— `qiniu/conatus-free` 有全局请求上限，429 时分析步骤会退避
  重试（60s / 120s）；连续 3 次仍是 429 就切到备用模型
  （`MiniMax-M3.1-Flash-Preview`，与 `~/.claude/settings.json` 里 Claude Code 用的
  是同一个网关 `aikey4k.mengxa.com`，但这里走的是 Octop 的 provider 通道）。
  备用模型也必须登记进 provider 的 `models_json`，脚本每次运行都会自动补登记。
- **测试跑在生产机上**，与线上服务并行。pytest 是串行执行（没用 `-n auto`），
  内存压力可控；但会短时吃 CPU。**数据目录是隔离的**（`TEST_ISOLATED_HOME`），
  线上 `/opt/octop-data` 不受测试影响。
- **agent 产物在 `/opt/octop-data/agents/<agent_id>/`** —— 分析报告、pytest pid
  文件都在那里。
- cron job 只是子代理的**执行载体**（`enabled=false`），时间控制归 systemd 定时器，
  两边不会重复触发。
