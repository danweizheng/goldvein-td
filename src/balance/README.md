# `src/balance/**` 存档说明（AI 平衡线的冻结快照）

> **写这份文档的原因**：`balance-eng` 的「AI 当替代玩家」这条线已被主策划**冻结**
> （可玩版本已在人手上，人 15 分钟就能答"能不能赢"，还能答 AI 永远答不了的"好不好玩"）。
>
> **目的**：**如果这条线半年后重启，接手的人不用重跑 12 轮才知道下面这些。**
>
> 冻结日期：见仓库最近一次与本文档同批的提交。维护者：`balance-eng`（批次 2）。
> 路径所有权：`src/balance/**`、`tests/sim/**`、`tools/balance-report.ts`。
>
> ⚠️ **本文档只记录结论与证据，不记录"我试过什么"的过程** —— 过程在 Git 历史与各脚本的头部注释里。

---

## 0. 先读这一节：这条线**现在**在做什么

| 线 | 状态 | 说明 |
|---|---|---|
| **「AI 当替代玩家」**（策略变强、找双达标点） | **❄️ 冻结** | 不要再扫权重、不要升级控制器、不要改默认值 |
| **「AI 当门禁」**（守住数据与映射的正确性） | ✅ **活着，要维护** | 见第 4 节的门禁清单，**必须保持绿色** |

冻结不等于废弃：**门禁是真在干活的** —— 它们抓过适配层四次事故（漏整张 `tech` 表 / 漏 `target` /
`map.json` 未迁 / 按下标取难度），也守住过"数据在数学上不可通关"这类结论。

---

## 1. ★★ 双稳态闩锁（bistable latch）—— 为什么调参找不到解

### 结论

**大脑（价值函数）在"建经济"与"建输出"之间做的是一个近乎平手的比较，而它一旦倒向某一侧，
就被一条"钉死不释放"的规则锁住。所以任何大脑侧权重的扫描都只会产生 2–3 种结果，而不是一条可调的曲线。**

### 机制（两段叠加）

```
① 近乎平手的密度比较（T1 单位、默认参数）
   小偷：stealPerSec 7 金/秒 × STEAL_WEIGHT(1)          = 7      ÷ 造价 250 = 0.028
   弓箭手：14 dps × DPS_GOLD_EQ(0.4)                     = 5.6    ÷ 造价 200 = 0.028
   ⇒ 几乎相等 ⇒「建哪个」实际由 rootSet 的【遍历顺序】决定（脆弱的平手）

② 钉死不释放的规则（闩锁本体）
   weightsFor 在 mix.output < 路数 × 2 时把 dpsW 钉到 SAFETY_WEIGHT(6)
   该条件在前期长期成立 ⇒ 输出被永久放大 6 倍
   ⇒ ①平手一旦倒向输出，就再也不会回头（双稳态 + 迟滞）
```

### 据点证据 A：`DPS_GOLD_EQ` 扫描（`src/balance/dps-eq-scan.ts`，N2，每值 3 局）

| `DPS_GOLD_EQ` | 窃金覆盖 | 均到波 | 窃金塔数 | 平均等级 | 弓箭手数 |
|---|---|---|---|---|---|
| 50 | 46.1% | 11 | 11.3 | T1.32 | 24.0 |
| 100 | 46.1% | 11 | 11.3 | T1.32 | 24.0 |
| 200 | 30.2% | 11 | 9.7 | T1.21 | 22.3 |
| **400（默认）** | **30.2%** | **11** | **9.7** | **T1.21** | **22.3** |
| 800 | 30.2% | 11 | 9.7 | T1.21 | 22.3 |
| 1600 | 28.2% | 12 | 8.0 | T1.25 | 24.0 |
| 3200 | 28.2% | 12 | 8.0 | T1.25 | 24.0 |

**64 倍变化只产生 3 种结果。**

### 据点证据 B：`SAFETY_WEIGHT` 扫描（`src/balance/safety-scan.ts`，N2，每值 3 局）

| `SAFETY_WEIGHT` | 窃金覆盖 | 均到波 | 窃金塔数 | 平均等级 | 弓箭手数 |
|---|---|---|---|---|---|
| **1（拆掉闩锁）** | **42.9%** | **11** | 9.7 | T1.35 | 25.7 |
| 2 | 42.9% | 11 | 9.7 | T1.35 | 25.7 |
| 3 | 30.2% | 11 | 9.7 | T1.21 | 22.3 |
| **6（默认）** | **30.2%** | **11** | 9.7 | T1.21 | 22.3 |
| 10 | 30.2% | 11 | 9.7 | T1.21 | 22.3 |

⇒ **拆掉闩锁（`SW=1`）净得 +12.7pt 覆盖率（30.2% → 42.9%），存活不变（11 波）。**
⇒ **杠杆是 ②（那条钉死规则），不是 `DPS_GOLD_EQ`。**

> ⚠️ **`SAFETY_WEIGHT` 默认值仍是 6 —— 主策划裁决不改。**
> 理由：它只在 N2、每值 3 局上测过，而生产默认值的改动是全局行为；更权威的仪器（人试玩）即将产出读数。
> **若 AI 线将来解冻，`SW = 1` 是第一件该改的事。**

---

## 2. ★★ 更硬的结构结论：**分配比例不由大脑决定**

### 结论

**对 `gap` 策略，经济与输出的"分配比例"由 `aging` 硬分支决定；大脑只决定"买哪一种输出"。**
⇒ **任何大脑侧权重都无法移动分配比例** ⇒ **"扫大脑权重找双达标点"在结构上就是死的**（不是还没找到那个值）。

### 证据

两张扫描表里 **`窃金塔数` 在所有取值下都是 9.7 座**（阈值跨越时也几乎不动），
而 **`弓箭手数` 在动**（22.3 ↔ 24.0 ↔ 25.7）。

原因：`gap` 的窃金塔来自它的**显式经济分支**（`economyAction`，由 aging 规则触发），**不经过大脑的价值排序**。

### 这条结论的关系图

```
覆盖率 / 存活 这两个指标
   ↑
   ├── 由【aging 硬分支】决定"经济 vs 输出"的比例 ── 大脑插不上手
   └── 由【大脑】决定"买哪一种输出" ────────────── 只影响输出构成，不影响比例
```

⇒ 想真正控制比例，必须**把分配从 "binary 硬分支" 改成 "数据目标驱动的控制器"**
（覆盖率 + 存活两个实测信号共同决定比例）。**这是解冻后该做的第一件结构性改动**（未被批准过）。

---

## 3. 启发式常量清单（**没有被文档来源的数值**）

**这一节的存在理由**：这些数是"自由参数"，而项目已经三次栽在"便宜的、看起来有用的、回不了本的东西"上。
清单化是为了让接手的人知道**哪些数可以怀疑**。

| 常量 | 位置 | 默认 | **角色** | 来源 |
|---|---|---|---|---|
| `DPS_GOLD_EQ` | [`strategies/value.ts`](strategies/value.ts) | `400` | 「1 点 DPS 值多少金币」—— 决定买输出还是买经济 | ❌ 无文档来源（策划案没给"伤害→价值"换算） |
| `SAFETY_WEIGHT` | [`strategies/value.ts`](strategies/value.ts) | `6` | 漏怪/生命告急/输出不足时**放大 DPS 价值**（**闩锁本体**） | ❌ 无文档来源 |
| `STEAL_WEIGHT` | [`strategies/value.ts`](strategies/value.ts) | `1` | 窃金价值的基准权重 | ❌ 无文档来源 |
| `BELOW_TARGET_STEAL_WEIGHT` | [`strategies/value.ts`](strategies/value.ts) | `3` | **覆盖率低于数据目标时的窃金权重**（按需打破那个平手） | ❌ 无文档来源，但**角色已降级**：从"设定分配比例"变为"在近乎平手的比较里按需推一把"（由实测覆盖率驱动，不是自由的） |
| `SAVE_REACH_MULT` / `SAVE_REACH_FLOOR` / `SAVE_PATIENCE_TICKS` | [`strategies/plan.ts`](strategies/plan.ts) | `3000` / `500_000` / `25*60` | 清单驱动的"攒钱纪律"及其耐心上限 | ❌ 无文档来源 |
| `SAVE_MULT` / `SAVE_PATIENCE_TICKS` | [`strategies/gap.ts`](strategies/gap.ts) | `4000` / `25*60` | aging 策略的攒钱容忍与耐心 | ❌ 无文档来源 |
| `DEFAULT_AGING_MAX` | [`strategies/gap.ts`](strategies/gap.ts) | `1` | 漏怪持续时经济最多被连续饿死几波 | ⚠️ **由扫描确定**（`aging-scan.ts`，扫 `{1..5}`），不是猜的 |
| `DPS_GOLD_EQ` 等两个实验参数 | [`strategies/value.ts`](strategies/value.ts) | — | `setDpsGoldEqForExperiment` / `setSafetyWeightForExperiment` | ⚠️ **实验后门**，见第 4 节的门禁 |

### ★ 由**数据**决定（**不是**启发式，改这些要动 `src/data`）

这些阈值**唯一来源**是 `constants.json` 的 `acceptanceTargets`，由 [`acceptance.ts`](acceptance.ts) 统一读出。
**任何消费方都不许再写字面量**（曾经有 5 份私有副本，被键登记门禁抓到）：

| 导出 | 数据键 |
|---|---|
| `SOLVABILITY_MAX_PERMILLE` | `acceptanceTargets.solvabilityMax` |
| `COMFORT_BAND` | `solvabilityComfortMin` / `Max` / `Waves` |
| `STEAL_COVERAGE_RANGE` | `stealCoverageMin` / `Max` |
| `COVERAGE_TARGET_PERMILLE` | 由上面两项推**中值** |

---

## 4. 门禁清单（**哪些权威、哪些只是诊断**）

### ✅ 权威门禁（**必须保持绿色**，报红即为真问题）

| 门禁 | 位置 | 守住什么 |
|---|---|---|
| **可通关性** | [`tests/sim/solvability.spec.ts`](../../tests/sim/solvability.spec.ts) | 契约 §14.4：`需求DPS/可达上界 ≤ 1.0`（阈值来自数据）；**含两条负对照**（拿掉科技表 → 精确复现 9.01×；hpIndex 调陡 → 报红） |
| **覆盖率定义性断言** | [`tests/sim/coverage-bound.spec.ts`](../../tests/sim/coverage-bound.spec.ts) | `窃金 ≤ 钱包`（覆盖率 ≤ 1000‰）。**含负对照**（已知越界的假结果必须报红） |
| **变异覆盖** | [`tests/sim/mapping-coverage.spec.ts`](../../tests/sim/mapping-coverage.spec.ts) | 适配层每张表每个字段被消费（249 条）；**含负对照**（变异 `description`/`sprite`/`icon` 必须**不变**）；**含完整性断言**（每条变异至少在一个夹具上被生成） |
| **`constants.json` 键登记** | [`tests/sim/constants-registry.spec.ts`](../../tests/sim/constants-registry.spec.ts) + [`constants-registry.ts`](constants-registry.ts) | **新增键未登记即报红**；登记表不许陈旧；25 项消费探针；**含负对照** |
| **实验后门** | [`tests/sim/experiment-backdoor.spec.ts`](../../tests/sim/experiment-backdoor.spec.ts) | 生产路径结果 == 从未调用过实验 setter（逐位相同）；**含 2 条负对照**（设成非默认值**必须不同**） |
| **采样约定唯一性** | [`tests/sim/sampling-convention.spec.ts`](../../tests/sim/sampling-convention.spec.ts) | 唯一具名读数 `dpsAtWaveEnd` 两条路径逐位相等；**含负对照**（换时刻读必须不同） |
| **策略语义** | [`tests/sim/strategies.spec.ts`](../../tests/sim/strategies.spec.ts) | 6 种策略的语义；`allowedAttackTypes` 空数组 == 不限（**反直觉语义被钉住**） |
| **适配层字段对照** | [`tests/sim/data-adapter.spec.ts`](../../tests/sim/data-adapter.spec.ts) | 不硬编码上游数值；`TechDef.target` 逐条映射 |
| **真实数据冒烟** | [`tests/sim/smoke-real-data.spec.ts`](../../tests/sim/smoke-real-data.spec.ts) | 端到端可复现；逐波统计自洽 |
| **门禁阈值自检** | [`tests/sim/gating.spec.ts`](../../tests/sim/gating.spec.ts) | 门禁判定逻辑本身可分（用假 RunResult） |

> 另有 `engine-dev` 路径下的门禁（`src/sim/__tests__/**`：出怪守恒、心魔分裂、确定性、科技乘法、克制矩阵…）
> —— **不是我的路径，但它们同样是权威门禁**，改动 `src/sim` 时会联动。

### 📋 记录器 / 诊断（**明确不承担判定职责**）

| 项目 | 位置 | 为什么不设门禁 |
|---|---|---|
| **生存缺口的 DPS 比** | [`tests/sim/survival-threshold.spec.ts`](../../tests/sim/survival-threshold.spec.ts) + [`survival-threshold.ts`](survival-threshold.ts) | 4 条策略的极差 **106.4pt**；且同一策略在两条采样路径下从 **151.8% 跳到 222.6%** ⇒ **被测量本身对采样约定不稳定**，写成断言等于把"我恰好这么采样"固化成门禁 |
| **舒适带** | [`metrics.ts`](metrics.ts) 的 `evaluateComfortBand` + [`solvability.spec.ts`](../../tests/sim/solvability.spec.ts) | 两把尺子必须分开用（契约 §16.3）：最大军队上界仅诊断（10/10 too-easy 是**正常的**）；经济感知上界（[`economy-bound.ts`](economy-bound.ts)）才是舒适带的正确尺子 |
| **资源上界实验** | [`tests/sim/upper-bound.spec.ts`](../../tests/sim/upper-bound.spec.ts) | **它是"资源上界 + 启发式摆位"，不是行为上界**。可以用来证明"资源不再是瓶颈"，**不能**用来调 N5 的数值（解析上界说 0.60× 宽裕，而实验漏 5 —— 落差是摆位质量） |
| **★停顿点机制** | [`tests/sim/halt-mechanism.spec.ts`](../../tests/sim/halt-mechanism.spec.ts) | 机制/仪器测试（不是平衡测试）：证明停顿时长旋钮是活的、`clustered` 摆位真的更近 |
| **孤岛脚本** | `halt-scan.ts` / `coverage-scan.ts` / `aging-scan.ts` / `armor-hypothesis.ts` / `dps-eq-scan.ts` / `safety-scan.ts` / `gap-report.ts` / `halt-instrument-check.ts` | 一次性扫描器，**结论已固化到本文档**；它们的价值是"结论可复现"，不是"每次都跑" |

---

## 5. 已知**无效读数**（不要当数据用）

| 读数 | 状态 | 原因 |
|---|---|---|
| **`heuristic` 的窃金覆盖率** | ❌ **无效**（0.0% → 修后 1.4%） | `heuristic` 是**纯大脑**策略（无经济分支），它**几乎不建窃金塔**（1 座）⇒ **不是"偷得少"，是"没有偷的塔"**。根因是结构（同第 1 节的闩锁），**不是参数**。**建议继续标注为无效，直到它的塔数 > 0 且稳定。** |
| `noop` 的覆盖率（74.1% @ N2） | ⚠️ **窗口仅 6 波** | 它不杀怪、第 6 波漏光 ⇒ 与 full-run 不可直接比 |
| `balanced` @ N4/N5 的覆盖率（60.6% / 67.8%） | ⚠️ **假象** | AI 在第 1–2 波就死，钱多怪弱 → 把两只怪偷干净 |
| 任何"单波时长"作为停顿代价 | ❌ 不敏感 | 资源上界阵容在停顿期间就把敌人打死了 ⇒ 换停顿时长后末 8 波 **7 波逐位相同** |

---

## 6. 12 轮里**已经被证否**的死胡同（**不要再走**）

| 假设 | 证否它的数据 |
|---|---|
| 「数据在数学上不可通关」 | 解析上界 9.0× + 上界实验；根因是**没有 金币→DPS 的指数通道**（契约 §14.2 已修） |
| 「加停顿时长能提覆盖率」 | 0.6s→3.0s（5×）只 **+5.1pt**（弱杠杆）；机制：收益 ∝ **射程内塔数**，而射程只有 2.0 格 |
| 「射程 2.0→2.5 是主杠杆」 | 只 **+0.5pt**（uniform）/ +4.4pt（clustered），与停顿时长同量级 |
| 「摆位是主杠杆」 | `clustered` 每个时长上 +8~14pt（**有效但不足以补 16%→65%**） |
| 「人口利用率是瓶颈」 | 限制输出后窃金塔能建到 **21.7–24.7 座**（塔位够用）⇒ 瓶颈在选择逻辑，不在容量 |
| 「护甲克制失败是第 12 波墙」 | ①首次漏怪在**第 1–9 波、全轻甲、城甲 0%**；②只攻城**更差**（12→9 波）；③只穿刺**逐位相同**（AI 本来就只建穿刺） |
| 「`DPS_GOLD_EQ` 是主自由参数」 | 64× 变化只有 3 种结果（见第 1 节） |
| 「降低钱包曲线（第 3 级）」 | **暂停**，重入条件：**一次完整 30 波（分配健康）的覆盖率读数 < 65%**。目前**没有任何 full-run 可比读数** |

---

## 7. 复现命令

```powershell
$node = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

# 门禁（权威）
& $node $pnpm run typecheck ; & $node $pnpm run lint ; & $node $pnpm run test

# 平衡跑批 + 报告（两步，**都必须跑**：只跑前者会读到旧 report.csv）
& $node $pnpm balance --difficulty all --strategy all --runs 3 --out src/balance/out/balance.csv --json src/balance/out/balance.json
& $node $pnpm exec tsx tools/balance-report.ts --in src/balance/out/balance.json --csv src/balance/out/report.csv

# 复现本文档的据点证据
& $node $pnpm exec tsx src/balance/dps-eq-scan.ts --difficulty N2 --runs 3   # 证据 A
& $node $pnpm exec tsx src/balance/safety-scan.ts --difficulty N2 --runs 3   # 证据 B
& $node $pnpm exec tsx src/balance/aging-scan.ts  --difficulty N2 --runs 3   # aging 取值来源
```

---

## 8. 维护者须知（踩过的坑，省得再踩）

1. **`balance` 与 `balance-report` 是两步**：只重跑前者会读到**旧的** `report.csv`
   （我踩过一次，把修 bug **之前**的数字当成修后的报了出去）。
2. **并行编辑共享模块时，测试结论必须附被依赖文件的 mtime** —— 已发生过一次读到
   `engine-dev` 改 `src/sim/tech.ts` 的中间态（28 文件里 9 个加载失败）。
3. **Windows 控制台用 GBK 读 UTF-8 会显示乱码**（`渚挎嵎`），**那只是控制台编码问题**，
   文件本身是好的 —— 要看内容用 read 工具，不要用 `Get-Content` 看中文。
   另：PowerShell 里带中文引号的字符串替换会**解析失败**，改中文注释请用编辑工具。
4. **一条绿着的测试，如果不测它名字声称的东西，比没有测试更危险** ——
   本项目已四次栽在"空测量"上（lint 对 `.ts` 空操作 / 没人查通关 / 心魔无界分裂 /
   环带区域是空的）。**每个门禁都要能回答："如果我的断言是空的，它会报红吗？"**
5. **不要为了过闸调参**，也不要改验收区间去迎合结果 —— 达不到就报实际值 + 根因。