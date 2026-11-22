# CNB 分支情况每日分析

> 状态：活文档 ｜ 最新核实日期：2026-11-20

本文说明 **cnb.cool（CNB 远端）分支情况的每日自动分析**机制：谁在跑、跑出什么、
结果在哪、怎么读、怎么复现。每日快照本身不在仓库里（机器生成、按日期滚动），
本文是唯一的权威说明。

---

## 1. 机制概览

```
                    每天 01:30（系统 crond）
                              │
                              ▼
        scripts/run_cnb_branch_analysis.sh   ← 包装：固定 PATH/HOME、收日志
                              │
                              ▼
         scripts/cnb_branch_analysis.py      ← 采集 + 并行模型分析 + 出报告
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    git 事实采集                    qiniu/conatus-free 并行判读
  （cnb.cool vs GitHub）            （逐分支 + 总览两级）
              └───────────────┬───────────────┘
                              ▼
              docs/cnb-branch-analysis/YYYY-MM-DD.md
```

| 项 | 值 |
|---|---|
| 触发 | 系统 crond，`30 1 * * *` |
| 入口 | `/opt/Octop/scripts/run_cnb_branch_analysis.sh` |
| 实现 | `/opt/Octop/scripts/cnb_branch_analysis.py`（仅标准库） |
| 模型 | `qiniu/conatus-free`——脚本内 `LLM_MODEL` 常量（默认；可用同名环境变量覆盖），**不读** settings.json 的 `ANTHROPIC_DEFAULT_SONNET_MODEL`。免费通道 |
| 网关与凭据 | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，读 `/root/.claude/settings.json` 的 `env` 段 |
| 报告 | `docs/cnb-branch-analysis/YYYY-MM-DD.md` + `latest.md` |
| 日志 | `scripts/logs/cnb-branch-analysis.log` |
| 保留期 | 90 天，超期自动删除 |
| 退出码 | `0` 报告已生成 ｜ `1` 采集失败 ｜ `2` 报告已生成但模型分析整体失败 |

**模型在哪个环节用**：`git` 采集的事实是确定性的；**判断**（这个分支该合还是该删、
落后主干有什么风险、建议做什么）由模型给出。两段并行——每个分支一个请求互不干扰，
全部完成后再汇总一次出总览。

---

## 2. 报告怎么读

报告分四块：

| 章节 | 内容 | 可信度 |
|---|---|---|
| 一、总览 | 模型对整体状况的概括 + 优先级清单 | 模型生成 |
| 二、分支事实表 | 每个分支的 SHA、最后提交、并入 CNB/GitHub 各自的基线状态、两组 ahead/behind、GitHub 是否有同名分支 | **git 实测，权威** |
| 三、逐分支判读 | 每分支的判断/依据/风险/建议动作 | 模型生成 |
| 四、采集异常 | 仅在采集出错时出现 | git 实测，权威 |

**事实表是权威的，判读是建议。** 二者冲突时以事实表为准——模型可能误读字段含义
（已在提示词里显式钉住口径，见 §4）。

### 字段口径

**两套基线必须分开看**——这是本报告最容易被误读的地方。

CNB 是开发侧，GitHub 是对外镜像，CNB 可以领先 GitHub 若干提交。所以每个分支
都会算**两组** ahead/behind：

| 字段 | 含义 |
|---|---|
| `on_origin: false` | 该分支**在 cnb.cool 远端存在，但 GitHub 上没有同名分支**。不是「本地分支」 |
| `merged_into_cnb` | 已并入 **CNB 自己的** `main`/`develop`；空表示在 CNB 上还没并 |
| `ahead_behind_cnb` | 相对 **CNB 的** `main`/`develop` 基线的领先/落后提交数 |
| `merged_into_github` | 已并入 **GitHub 上的** `main`/`develop`；空表示没回流 GitHub |
| `ahead_behind_github` | 相对 **GitHub 上的** `main`/`develop` 基线的领先/落后提交数 |
| `changed_files` | 相对 CNB main 改动的文件数 |
| `unmerged_commits` | 尚未进入 CNB main 的提交（最多取 8 条给模型）；为空表示内容已全部进 CNB main |

怎么读这两组数字：

- `ahead_behind_cnb.main` 很小（个位数）→ **在 CNB 上已经合得差不多了**。
- 这时 `ahead_behind_github.main` 数字大 → 只是**还没回流 GitHub**，
  是「同步欠账」，**不是**「分支没合并」。
- 判断分支是否已合并，**一律以 cnb 口径为准**。

> 历史教训：2026-11-21 之前脚本只算 GitHub 一套基线，把 `feat/unified-import-entry`
> 判成「12 个独有提交未合入主干」，实际它早已通过 MR #22 并入 CNB main，
> 只差 1 个提交——2026-11-21 起脚本改成双基线，提示词也同步钉住了口径。

**报告里的 git 命令一律用 `cnb/main` / `cnb/develop` / `origin/main` / `origin/develop`**
这四个远端引用，**不要用本地 `main` / `develop`**——本地分支可能已经陈旧
（实测本地 main 落后 origin/main 243 个提交），拿它做对比会得出错误结论。

---

## 3. 复现与补跑

```bash
# 立刻跑一次（完整，含模型分析）
/opt/Octop/scripts/run_cnb_branch_analysis.sh

# 只采集 git 事实，不调模型（快，几秒出结果）
/usr/bin/python3 -I /opt/Octop/scripts/cnb_branch_analysis.py --no-llm

# 补跑指定日期的报告（文件名用该日期，内容是补跑时的实际状态）
/usr/bin/python3 -I /opt/Octop/scripts/cnb_branch_analysis.py --date 2026-11-19
```

日志：

```bash
tail -50 /opt/Octop/scripts/logs/cnb-branch-analysis.log
```

---

## 4. 实现上踩过的坑（改脚本前先读）

### 4.1 `git ls-remote cnb` 会失败——凭据匹配口径

仓库 `.git/config` 里设了 `credential.usehttppath=true`，而 `~/.git-credentials` 中
cnb.cool 只有 **host 级**条目（没有 `mengxa.com/Octop.git` 这个 path 级条目）。
两者一撞，`git ls-remote --heads cnb` 直接报：

```
fatal: could not read Username for 'https://cnb.cool/mengxa.com/Octop.git'
```

解法：命令行 `-c credential.useHttpPath=false` 覆盖（命令行优先于文件配置），
命中 host 级凭据。

### 4.2 `git ls-remote` 会改写 `~/.git-credentials`

credential store 在认证成功后会把规范化 URL 写回去，**同 host 的另一条 path 级
条目会被折叠掉**（实测 6 条变 5 条，`cnb-api` 那条 `WeChatBridge` 条目可能消失）。

解法：脚本把凭据**复制一份到临时文件**，用 `GIT_CREDENTIAL_STORE` 指过去，
真实凭据文件全程只读。跑完删临时目录。

### 4.3 免费通道有两种限流

`qiniu/conatus-free` 有两套独立的 429：

- `Too many requests for this free model` —— 全局限流
- `Too many concurrent requests for this free model` —— 并发限流

单纯降并发数压不住，必须**错峰**。脚本用 `RateGate` 保证任意两次请求发起时刻
至少相隔 `LLM_MIN_INTERVAL`（默认 4 秒），并发降到 3，再叠加指数退避重试。

实测：并发 6 发 → **6 发全 429**；3 并发 + 4 秒错峰 + 退避重试 → 稳定拿到 200。

### 4.4 输出会被截断，且截断点很像正常结束

该通道底层是 oai_chat 语义，**reasoning tokens 计入 `completion_tokens`**，
`max_tokens` 给小了会在正文中途断掉——实测断在 `## 依据\n- ` 这种半截行，
看起来像「模型只写了一句」，其实是超预算。

两道防线：
1. `stop_reason == "max_tokens"` → 预算翻倍重试（上限 `MAX_TOKENS_CEILING`）；
2. `_looks_complete()` 兜底识别悬空列表符、标题下正文为空、表格列数少于表头。

**半截文本不许进报告**——宁可标记「模型分析不可用」重试，也不写半截内容。

### 4.5 并行失败要有串行兜底

并行阶段失败的分支，会**降到并发 1 再重试一轮**（网关侧并发为零时通过率最高）。
两阶段都失败才在报告里标「模型分析不可用」。

### 4.6 基线只能有一套——除非你显式拆成两套

**这是本脚本被改坏过一次的地方（2026-11-21）。**

原来 `collect()` 只拿 **GitHub 的 main/develop** 当基线算 ahead/behind 和
`merged_into`。但 CNB 是开发侧、GitHub 是镜像，CNB 领先 GitHub 12 个提交时，
同一个分支两套口径的数字会差出一大截：

- `feat/unified-import-entry` 实际早已通过 MR #22 并入 CNB main，只差 1 个提交；
- 用 GitHub 基线一算却变成「ahead 12 / 未并入任何基线」；
- 模型据此判成「12 个独有提交仍在活跃开发、未合入主干」，并给出「提 MR 合入 main」
  的建议——而那个 MR 早就合过了。

修法：**两套基线都算，并列给出**，再在提示词里钉死「判断合并状态以 cnb 口径为准，
github 口径只衡量回流欠账」。改完同一天的报告，`feat/unified-import-entry`
的判读就从「未合入」变成「相对 CNB main 只差 1 个提交、GitHub 侧陈旧待同步」。

同理，报告里的对比命令**必须用远端引用**（`cnb/main`、`origin/main`）。
本地 `main` 分支可能已经陈旧——实测本地 main 落后 `origin/main` 243 个提交，
`git log origin/main..main` 跑出来是空的，据此下结论必错。

---

## 5. 卸载

```bash
crontab -l | grep -v 'run_cnb_branch_analysis.sh' | crontab -
```

撤销备份：`/root/crontab.bak.20261120-165925`

脚本与报告可以一并删除：`scripts/cnb_branch_analysis.py`、
`scripts/run_cnb_branch_analysis.sh`、`docs/cnb-branch-analysis/`。

---

## 6. 相关文档

| 文档 | 关系 |
|---|---|
| [cnb-mirror.md](./cnb-mirror.md) | CNB 镜像链路（GitHub → CNB）——本分析关注的是**反向缺口**（CNB 有、GitHub 无） |
| [cnb-openapi.md](./cnb-openapi.md) | CNB Open API 调用方法与踩坑 |
