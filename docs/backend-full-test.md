# 后端全量测试（定时）

> 每天凌晨定时对**当前后端**跑一次完整 pytest，再用**子代理模型**
> （默认 `qiniu/conatus-free`）分析测试结果，产出可读的失败归因报告。

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
   - 跑完了但有失败用例 → 这是**结论**，不重试，直接进分析；
   - 跑不起来（解释器缺失、依赖缺失、收集阶段崩溃、进程被杀）→ **不可跳过的异常**，
     重试，累计 3 次仍失败就终止。
3. **子代理分析** —— 一个 Octop 子代理（`task_type=agent`，模型
   `newapi/qiniu/conatus-free`）用 shell 读日志，产出 Markdown 分析报告：
   失败用例清单、按根因归类、真回归 vs 偶发、严重度排序与下一步建议。
   分析失败同样重试 3 次。
4. **出报告** —— 落到 `/opt/octop-data/test-reports/`：
   - `pytest-<时间戳>.log` —— 完整测试输出
   - `report-<时间戳>.json` / `report-<时间戳>.md` —— 测试结论 + 子代理分析

退出码：`0` = 全过；`1` = 有失败用例（报告里仍有分析）；`2` = 不可跳过的异常
（重试 3 次后终止）。

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
| `TEST_MODEL` | `qiniu/conatus-free` | 网关侧模型 id |
| `TEST_MODEL_REF` | `newapi/qiniu/conatus-free` | Octop 侧模型引用 |
| `TEST_MAX_ATTEMPTS` | `3` | 不可跳过异常时的最大尝试次数 |
| `TEST_TIMEOUT` | `5400` | 单次测试超时（秒） |
| `TEST_ANALYSIS_TIMEOUT` | `1800` | 子代理分析超时（秒） |
| `TEST_PYTEST_ARGS` | `-m "not live" -q` | pytest 参数 |
| `TEST_PYTHON` | `/opt/Octop/.venv/bin/python` | 解释器 |

## 注意事项

- **不要用 `uv run`** —— 它会联网同步依赖，内网 PyPI 源不可达（`pillow 13.0.0`
  拉不到）。脚本直接用 venv 里的解释器。
- **免费模型会限流** —— `qiniu/conatus-free` 有全局请求上限，429 时分析步骤会退避
  重试（60s / 120s），3 次仍失败才终止。
- **测试跑在生产机上**，与线上服务并行。pytest 是串行执行（没用 `-n auto`），
  内存压力可控；但会短时吃 CPU。
- **agent 产物在 `/opt/octop-data/agents/<agent_id>/`** —— 分析报告、pytest pid
  文件都在那里。
- cron job 只是子代理的**执行载体**（`enabled=false`），时间控制归 systemd 定时器，
  两边不会重复触发。
