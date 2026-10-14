# `src/data/schema` 约定说明（data-arch 所有）

> 本目录是 10 张配置表的 JSON Schema（draft-07）。`tools/validate-data.ts` 用 ajv 逐条校验，
> `tools/gen-types.ts` 把 10 份 Schema 合并后生成 `src/data/types.generated.ts`。
> 字段语义的**唯一真相**是 [`docs/窃金者TD-开发策划案-v0.2.md`](../../../docs/窃金者TD-开发策划案-v0.2.md) §14.1；
> 单位/取值的**唯一真相**是 [`docs/接口契约-v0.1.md`](../../../docs/接口契约-v0.1.md)
> §3.2 / §11.2（音频）/ §12–§14（v0.1.2–v0.1.4 修订）。
>
> **裁决改动记录**（见下文各节）：
> v0.1.2 — `aura`→`auras`、`bounty`→`bountyRatio`、`TowerLine` 加 worker/sprite/tech、units 23→29；
> §5.1 基线重设（`baseHp` 60 / `hpIndex` 1283 / `baseWallet` 32 / `walletIndex` 1200）、非 BOSS 波数量单调不减；
> **v0.1.4（契约 §13.5 / §14.2 / §14.5 / §14.11）** — 科技加 `effectMode` 并把 4 条线改乘法、
> BOSS 钱包系数 ×12/×12/×16/×20、`stealWoodRatio` 30→3、新增第 10 张表 `map.json`。

## 1. 根形状与条目数

每份 Schema 描述的是**单个条目**（不是整张表），条目数与根形状由契约 §3.1 钉死，实现在
`tools/validate-data.ts` 的 `TABLES`：

| 文件 | 根类型 | 条目数 | Schema |
|---|---|---|---|
| `units.json` | `UnitDef[]` | **29** | `units.schema.json`（23 战斗塔 §4.2 + 工人 §4.2.8 + 4 小精灵 §4.1.3 + 科技塔 §4.4.1） |
| `enemies.json` | `EnemyDef[]` | 11 | `enemies.schema.json` |
| `waves.json` | `WaveDef[]` | 30 | `waves.schema.json` |
| `tech.json` | `TechDef[]` | 8 | `tech.schema.json` |
| `relics.json` | `RelicDef[]` | 9 | `relics.schema.json` |
| `equipment.json` | `EquipmentDef[]` | 6 | `equipment.schema.json` |
| `difficulty.json` | `DifficultyDef[]` | 5 | `difficulty.schema.json` |
| `constants.json` | `BalanceConstants` | 单对象 | `constants.schema.json` |
| `audio.json` | `AudioDef[]` | 40 | `audio.schema.json`（契约 §11.2，v0.1.1 增补） |
| `map.json` | `MapDef` | 单对象 | `map.schema.json`（契约 §14.11，v0.1.4 增补） |

`units.json` 的 9 个 `line`：6 大战斗塔系（thief/archer/mage/drill/beauty/cannon，有升级树）+
3 个并列可建造的经济/功能系（`worker` / `sprite` / `tech`，**无 upgradesTo**）。`hero` 是
契约 §14.1 的冻结枚举成员，保留但本期不得出现在数据里（决策 D5）。

## 2. 定点数（铁律 3 / 契约 §2）

- 所有模拟层数值一律 **×1000 的整数**（含金币、木材）。`type: "integer"` 而不是 `number`，
  是为了让「不小心写了浮点」在 CI 就被拦住。
- 只有**纯计数**用普通整数：`tier` / `block` / `wave` / `count` / `maxLevel` / `openLanes` /
  `lives` / `crystalCostPerLevel[]`（结晶价格）/ audio 的 `fadeInMs` / `fadeOutMs`。
- ★ `attackInterval` 存的是**间隔秒**（定点），不是频率。策划案表格写「1.2/s」，
  JSON 里必须是 `833`（`round(1000 / 频率)`）。`tests/data/units.spec.ts` 会逐条核对这一点。

## 3. `abilities[].params` 键名约定（**重要**）

`params` 的类型是 `Record<string, number>`，TypeScript 无法表达每个键的单位，
因此用**键名后缀**承载单位语义。四处必须一致：

| 后缀 | 单位 | 例 |
|---|---|---|
| `…Pct` | 千分比（定点） | `stealPct: 250` = +25% |
| `…Sec` | 秒（定点，与 `cooldown` 同单位） | `burnSec: 5000` = 5s |
| `…Cells` | 格（定点） | `pullCells: 3000` = 3 格 |
| `…PerCycle` | 定点数量（每 `cooldown` 一次） | `woodPerCycle: 2000` = 每周期 2 木 |
| 无后缀 | 纯计数 | `targets: 4` / `bounces: 1` |

> **非攻击单位（worker / sprite / tech）** 的 `attack = 0`。此时 `range` 表示**能力作用半径**
> （工人 = 点金术半径），小精灵/科技塔为 `0`。周期性产能用 `cooldown` 表达周期、
> `params.<量>PerCycle` 表达每次产出。

### 技能 id 目录

`abilities[].id` 的取值是一个**枚举目录**（写在 `units.schema.json` 的
`definitions.AbilityId` 里）。这就是「abilities 引用完整性」的校验目标：写错 id 会被 ajv 拦下。
新增技能必须同时在此枚举登记，并在此处补一行说明。

| id | 归属 | 语义 |
|---|---|---|
| `stealth` | 神偷 T3+ | 窃金效率 +25%（常驻） |
| `midas_touch` | 神偷 T4 / **工人** | 秒杀低血敌人并全额夺取其剩余钱包（宗师：<15% / 20s；工人：<8% / 15s） |
| `relocate_free` | 神偷 T5 | 可免费重新部署 |
| `steal_ignore_counter` | 神偷 T5 | 窃金无视护甲克制 |
| `multishot` | 弓箭系 | 同时命中 N 个目标 |
| `bounce` | 弓箭 T4 | 弹射次数 |
| `archmage_range_aura` | 法师 T5 | 全图射程光环（射程部分单列，因为 `auras` 的 `allPct` 不覆盖射程） |
| `phalanx` | 军训系（3 个） | 列阵：被阻挡敌人 −40% 移速 |
| `chain_pull` | 铁闸守卫 | 每 15s 把最接近宝库的 1 个地面敌人拉回 3 格 |
| `detention` | 训导主任 | 被阻挡敌人窃金抗性 −25% |
| `detention_steal_aura` | 训导主任 | 周围 4 格内神偷系塔窃金效率 +20% |
| `frost_hit` | 冰封美女 | 命中减速 25%，持续 2s |
| `group_slow` | 美人鱼 | 群体减速 35% + 溅射 1.2 格 |
| `group_slow_freeze` | 美人鱼老妈 | 群体减速 50% + 范围冰冻 1.5s |
| `splash` | 炮塔 / 榴弹炮 | 溅射半径 |
| `splash_burn` | 地狱火 | 溅射半径 2.5 格 + 灼烧 5s |
| `wood_gather` | 4 小精灵 / 工人 | 周期产木：`cooldown` = 周期，`params.woodPerCycle` = 每次产木 |
| `build_boost` | 工人 | 建造加速（数值为推断） |
| `tech_unlock` | 科技塔 | 解锁局内科技研究面板 |

敌人侧的机制钩子 `EnemyDef.hooks` 同样是枚举目录：`split` / `revive` / `aura_speed` /
`boss_drop` / `steal_immune`。

## 4. 已知的**有意偏离**契约 §14.1 的字段（裁决后）

契约 §3.4 原本要求「生成类型必须是 14.1 的**超集**」。下面两处是主策划裁决**主动删改**的，
因此现在不再是严格超集——这是有意的，`tests/data/types.spec.ts` 里有一条用例专门断言它们已被移除，
避免将来被误当成「漏字段」补回来：

| 改动 | 原因 |
|---|---|
| ❌ 删除 `UnitDef.aura`（单对象），✅ 只保留 `UnitDef.auras: Aura[]` | 两者并存是 bug 温床：引擎读 `aura`、数据写 `auras` 会**静默失效且无报错**。多效果光环（法师爷爷 3 效果、训导主任 2 效果）一律写 `auras[]`。校验器额外禁止 `aura` 与 `auras` 并存。 |
| ❌ 删除 `EnemyDef.bounty`，✅ 换成 `EnemyDef.bountyRatio`（千分比） | 原字段名为 `gold` 却要求按钱包曲线缩放，是语义陷阱（engine-dev 极可能当绝对值实现 → 全局击杀奖励只剩钱包的 0.04%，违反 §4.1.1）。新字段名本身写明「这是比率」，Schema description 写明 `killGold = bountyRatio.gold × baseWallet × walletIndex^(wave-1) / 1000`。 |

**其余追加字段**（这些仍是纯追加，不影响 §14.1 原字段）：

| 字段 | 所属 | 为什么必须加 |
|---|---|---|
| `TechDef.effectUnit?: 'permille' \| 'count'` | tech | 14.1 规定 `effectPerLevel` 是千分比，但「人口上限 +2」是纯计数。加一个显式单位字段，避免消费者把 `+2` 当成 `+0.2%`。 |
| `RelicDef.effectUnit?: 'permille' \| 'fixed' \| 'count'` | relics | 同上：起始金币 +500（定点）、塔位 +1（计数）、窃金 +5%（千分比）三种单位混在一列。 |
| `EquipmentDef.equipSlot?` / `.availableFrom` | equipment | 契约 §3.1 列了 `equipment.json` 但 14.1 **没有给 EquipmentDef 类型**，本 Schema 为 data-arch 自拟（6 件装备的造价与效果取自策划案 §4.2.7）。 |

> `AudioDef`（契约 §11.2）**没有**任何追加字段：它的 9 个字段全部由契约直接给出。

## 5. `constants.json` 的 §5.1 成长曲线基线（v0.2 裁决后）

原基线表（`HP(n)=40×1.38^(n-1)`、`W(n)=10×1.29^(n-1)`）**漏乘了 §4.5.2 的单体钱包/血量系数**
（蝙蝠 ×1.1 / 装甲车 ×2.0 / 精英刺客 ×2.5 / 圣殿守卫 ×3.0），导致「累计总钱包 195 万」与
「实际 30 波组合」相差近一倍，且第 26–30 波独占 73–76% 的钱包——前 25 波几乎没钱铺塔。
主策划裁决重设四个起点值：

| 常量 | 原值 | **新值** | 设计意图 |
|---|---|---|---|
| `baseHp` | 40 | **60** | 基线抬到与「带系数的真实组合」同量级 |
| `hpIndex` | 1.38 | **1.283** | 见 ② |
| `baseWallet` | 10 | **32** | 见 ③（第二轮裁决：45 → 32，只为收口支出/收入比） |
| `walletIndex` | 1.29 | **1.20** | 见 ① |

**三条设计意图（缺一不可，改动这四个值前请重读）**

1. **压平后置度**：`1.20^29 = 198×`（原 `1.29^29 = 1606×`）。目的不是让曲线变平，而是把
   「前 25 波没钱铺塔」改成「前中期有真实经济」。实测第 26–30 波钱包占比由 **76.2% → 66.1%**
   （基准曲线）/ **70.9%**（实际波次组合）。仍过半，但这是**「指数曲线 vs 30 波」的模型层张力，
   不是取值错误**——主策划已按设计问题登记（备选模型：改为直接控形每波总收入
   `T(n) = T₁×g^(n-1)`，再按敌人数反推单体钱包），本轮不实现。
2. **保住净难度爬升**：比值 `1.283 / 1.20 = 1.069`，与原 `1.38 / 1.29 = 1.070` 基本一致，
   30 波累计相对难度仍 ≈4 倍。**比值是一阶参数（§5.3），比绝对值更重要**——校验器对它设了
   1.05–1.09 的硬门禁（`constants.指数关系`）。
3. **支出/收入比落进 80–90%**：`baseWallet = 32` 时累计理论钱包 ≈ **1,797,000** → 收入
   （窃金 70% + 击杀奖励 17% + 波次结算）≈ **1,583,000** → 对 §5.5 固定支出 1,293,200 =
   **≈81.7%**，落在验收带内。⚠️ 原 45 时为 **58.3%**（低于验收带，即 v0.1「钱花不完」的复发），
   所以第二轮只改这一个值。此时累计钱包**低于**首轮设的「2.1–2.2M」目标——两轮目标冲突时
   **以验收带（支出/收入比）为准**，因为它是防呆指标。该指标已被主策划**降级为 M3/M4 门禁**，不是 M0 结论。

> `enemyCountBase` / `enemyCountSlope`（§5.1 的 `Q(n) = 6 + floor(0.8n)`）已**降级为规划参考**，
> 不再是逐波硬要求；硬门禁换成「**非 BOSS 波敌人总数单调不减**」（见下节）。

### §13.5 BOSS 钱包系数（v0.1.4）

4 个 BOSS 的「钱包系数」原为「—」→ 取 1.0，后果是 `w27`（飞升者波）每波总钱包只有 **3,663**，
而 `w26 = 152,329`、`w28 = 334,085` —— **经济断崖**。终局 BOSS 波变成「打完没钱」。

裁决后的起点值：**荒兽 ×12 / 心魔 ×12 / 转生者 ×16 / 飞升者 ×20**（写入 `enemies.json.baseWallet`）。

硬门禁：**每个 BOSS 波的每波总钱包 ≥ 相邻非 BOSS 波的 60%**。参考基准取**较穷的一侧**
（`min(前一个非BOSS波, 后一个非BOSS波)`）——理由：BOSS 波 24–27 是一个连块，它们前面只有 `w23`(70,664)、
后面是 `w28`(334,085)；若按「对较富一侧也成立」的严格读法，荒兽/心魔/转生者/飞升者要分别抬到
**×30 / ×17 / ×17 / ×55**，远超裁决给出的起点值。校验器与测试**都会把严格读法的缺口打印出来**，
供主策划决定是否采用严格读法（见汇报「需要裁决」）。

### §14.2 科技树的 `effectMode`（v0.1.4）

`TechDef` 新增**必填**字段 `effectMode: 'add' | 'mul'`：

| 模式 | 语义 | 5 级总效果 |
|---|---|---|
| `add` | 千分比**增量**（线性） | `base + 5 × effectPerLevel/1000` |
| `mul` | 千分比**倍率**（指数） | `(effectPerLevel/1000)^5` |

| 科技线 | mode | effectPerLevel | 5 级总倍率 | 备注 |
|---|---|---|---|---|
| 攻击强化 | `mul` | 1500 | **7.59×** | 原 +10%/级（线性）→ 只有 1.5× |
| 攻速强化 | `mul` | 1400 | **5.38×** | 原 +8%/级 → 1.4× |
| 射程强化 | `mul` | 1100 | 1.61× | 工具性，不参与 DPS 乘积 |
| 窃金效率 | `mul` | 1120 | 1.76× | 效果量不变，只是明确为乘法 |
| 窃金暴击率 | `add` | 50（cap 300） | 5% → 30% | 有上限，保持加法 |
| 窃金暴击效率 | `add` | 250（cap 2750） | 150% → 275% | 有上限，保持加法 |
| 人口上限 | `add` | 2（count） | +10 人口 | §14.2 未列入，保持加法 |
| 基地等级 | `add` | 80 | +40% 木材产出 | 同上 |

**为什么必须这么做**：血量成长 `1.283^29 = 1373×`，而塔的 tier 强度只有 ~52×，
收入成长 `1.20^29 = 198×` 却**缺少指数级的金币→DPS 消耗口**（塔位有人口上限、tier 是一次性离散乘区）。
科技改乘法后 `52.5 × 7.59 × 5.38 = **2144×** > 1373×`（余量 1.56×）。
校验器与 `tests/data/progression.spec.ts` 都断言了这条验算，并保留了「旧线性方案只有 110×」的反例。

**`TechDef.target`（契约 §14.20 新增必填）**：`'attack' | 'speed' | 'range' | 'steal' | 'critRate' | 'critMul' | 'population' | 'baseLevel'`。
此前效果由 `id` 隐含，引擎只能硬编码一张 id→槽位映射表（**违反铁律 5**：加一条科技线就要改引擎代码）。
归属 data-arch，引擎应改为读该字段并删除映射表。

### 科技总额 ×2.16（契约 §15.2，v0.1.5）

`balance-eng` 实测 `balanced` N2 的科技支出占比只有 **94‰**，而 §14.12 的目标是 **350‰** —— 根因是
**科技总额 313,200 相对远期收入太小**，8 条线全点满也只占收入的 16.2%。

**新总额：576,000 金 / 49,000 木（×1.84）。口径见 §15.13：**

```
总收入     = 窃金 + 击杀奖励 + 波次结算 = 1,937,191
支出预算   = 总收入 × 85%（§5.4 的 80–90% 带取中）= 1,646,613
§14.12 四个占比 = 支出预算内的份额（塔 50 / 科技 35 / 精灵 8 / 杂项 7 = 1000‰）
⇒ 科技 = 350‰ × 1,646,613 = 576,314 ≈ 576,000      （换算成占收入 = 297.3‰）
```

> ⚠️ **两个口径必须分开写**：「占预算 350‰」≠「占收入 350‰」。曾按 `1,937,191 × 35% = 677,900`
> 算过一版 677,000，那是把「占预算的 35%」当成了「占收入的 35%」（§15.2 已更正，§15.13 定稿）。
> 测试里同时断言了两个口径与它们的换算关系（占收入 = 占预算 × 85%）。

| 科技线 | 金（逐级） | 小计 | 木（逐级） | 小计 |
|---|---|---|---|---|
| 窃金效率 | 2,200 / 4,600 / 9,600 / 20,200 / 41,400 | 78,000 | 220 / 460 / 960 / 2,020 / 4,140 | 7,800 |
| 攻击强化 | 1,900 / 4,000 / 8,300 / 17,400 / 35,900 | 67,500 | 190 / 400 / 830 / 1,740 / 3,540 | 6,700 |
| 攻速强化 | 同上 | 67,500 | 同上 | 6,700 |
| 射程强化 | 1,500 / 3,200 / 6,600 / 13,800 / 28,400 | 53,500 | 150 / 320 / 660 / 1,380 / 2,790 | 5,300 |
| 窃金暴击率 | 2,500 / 5,200 / 10,900 / 22,900 / 47,500 | 89,000 | 250 / 520 / 1,090 / 2,290 / 4,750 | 8,900 |
| 窃金暴击效率 | 同上 | 89,000 | 同上 | 8,900 |
| 人口上限 | 1,300 / 2,700 / 5,600 / 11,700 / 24,200 | 45,500 | 130 / 270 / 560 / 1,170 / 2,570 | 4,700 |
| 基地等级 | 2,400 / 5,000 / 10,500 / 22,100 / 46,000 | 86,000 | 0 | 0 |
| **合计** | | **576,000** | | **49,000** |

- 木材按**同比例** ×1.84：保持每条线的木/金比（0.1）不变，木材仍是真实的节流阀。
  需求 26,670 → **49,000**，覆盖它需要约 **13 只高阶小精灵**（缺口 42,513 木 ÷ (120 木/min × 28 min)）。
  按 §14.12 的精灵预算（80‰ × 1,646,613 = 131,729 金）可买约 **14 只** —— **余量很薄，需在模拟层验证木材闭环**（见「未验证」）。
- 逐级倍率落在 **2.05–2.13**（原设计注记「2.0–2.3 递增」，测试门禁 1.8–2.5）。
- 校验器断言 **8 条精确等于 576,000 / 49,000**，并有**三条负对照**（少 1 金 / 整体退回 313,200 / 抬到误算的 677,000 —— 双向都锚得住）。
- ⚠️ **`costPerLevel` 是花费口，同时科技又是强度来源** —— 涨价会拖慢 DPS 爬升。但 §15.13 已确认：
  `solvability` 门禁**成本无关**（上界公式里没有 `costPerLevel`），跑它对造价的改动不敏感，
  **不能**用它证明「科技变贵没破坏可通关性」。真正的验证只有「经济感知 + 会研究科技的 AI 跑批」（balance-eng）。

### §14.12 支出侧目标（**预算内份额**，口径见 §15.13）

| 用途 | key | 值（占**预算**） | 换算成占收入 |
|---|---|---|---|
| 塔建造与升级 | `economyTargets.spendRatios.tower` | **500**（原 550） | 425‰ |
| 科技研究 | `economyTargets.spendRatios.tech` | **350**（原 280） | **297.5‰** |
| 小精灵与产能 | `economyTargets.spendRatios.sprite` | **80**（原 100） | 68‰ |
| 装备与杂项 | `economyTargets.spendRatios.equipment` | 70 | 59.5‰ |

四项之和 = 1000‰（**预算**的 100% ⇒ 收入的 85%，剩下 15% 是波末余量，正好对上 §5.4 的 80–90% 带）。

### §15.4 替代「塔数目标」的两条判定 —— **两个上界，两个用途，不要混**

§5.4 的「第 10 波 6–9 座塔」**已删除**（塔数是弱代理指标：18 座 T1 与 6 座 T5 完全不同）。
替代它的是 `acceptanceTargets` 里新增的四条：

| key | 值 | 配的**哪个上界** | 含义 |
|---|---|---|---|
| `solvabilityMax` | 1000 | **最大军队上界**（50 座 T5 + 满级科技，与波次无关） | 硬界 `需求/上界 ≤ 1.0`，全部 30 波 × 5 难度 —— **存在性证明**，故意宽松（N2 0.17× 属正常） |
| `solvabilityComfortMin` / `Max` | 200 / 600 | **经济感知上界**（到该波时合理经济能支撑的阵容） | 舒适带 `[0.2, 0.6]`，衡量「正常玩家在该波是否吃力」 |
| `solvabilityComfortWaves` | `[10, 20]` | — | 舒适带适用波次（纯计数） |

- `towersAtWave10Min` / `towersAtWave10Max` **必须不存在**，否则校验器报错（反向门禁，防回滚）。
- 硬断言本轮在 `tests/sim/solvability.spec.ts`（balance-eng），M1 迁移进 `tools/validate-data.ts`（契约 §14.4）。
  **经济感知上界由 balance-eng 在 `ttk-analysis.ts` 实现**（§15.4 采纳「新增经济感知上界」方案，明确否决了「挪动舒适带上下限」的替代方案）。
- ⚠️ **不可混淆的原因**：用最大军队上界去算第 10 波会得到 **0.00×**（实测 w10 0.00×、w20 0.01–0.02×），
  离下限 0.2 差一个数量级 —— 那不是「太简单」，而是**拿了一把与波次无关的尺子去量逐波难度**，
  与「一个空的测量区域返回 0，而 0 看起来像决定性的否定结果」是同型错误（AGENTS.md 铁律 8 第 4 条）。

## 6. 校验器会做的检查（Schema 做不到的部分）

Schema 只能校验单条，下列检查在 `tools/validate-data.ts` 里实现（58 项结构化检查的一部分）：

- `waves.groups[].enemy` → `enemies.id`
- `units.upgradesTo[]` → `units.id`（且目标 `tier` 必须 = 本塔 `tier + 1`）
- `units.abilities[].id` → `AbilityId` 枚举目录；`enemies.hooks[]` → `Hook` 枚举目录
- `units.aura` 已被弃用 → 出现即报错；`auras[]` 由 Schema 保证非空
- `relics.unlocksUnit` → `units.id`
- `tech.requires[]` → `tech.id`
- `difficulty.crystalMul` ↔ `constants.difficultyCrystalMul`
- **`audio.id` ↔ 磁盘 `public/assets/audio/*.ogg` 完全一一对应（不多不少）**——
  这是唯一一条**跨文件系统**的校验：只查 JSON 内部一致性会漏掉「清单写了但文件不存在」与
  「文件存在但清单没写」两类错误。顺带还会拦下目录里的非 `.ogg` 文件。
- `audio.json`：`file` 必须等于 `assets/audio/<id>.ogg`；`bgm`→`bus:bgm`+`loop:true`；
  `sfx`→`bus:sfx`+`loop:false`；`ambience`→`bus:sfx`+`loop:true` **且 `fadeInMs`/`fadeOutMs` ≥ 100**
- **`waves`：非 BOSS 波的敌人总数必须单调不减**（含 BOSS 的波 = 24/25/26/27/30，不参与该序列）。
  BOSS 波的数量可以任意低（第 27 波只有 1 只），否则会误报。
- **`waves`：BOSS 波钱包 ≥ 相邻非 BOSS 波 60%（取较穷一侧）**（契约 §13.5）
- `waves` 的敌人首次出现波次 ≥ 策划案 §4.5.2 表的「出现波次」
- `waves` 的 `hint.recommendArmor` 必须出现在本波敌人的护甲集合里
- **`waves.path` 索引必须落在「最窄开放集」内** —— 否则 `tick.ts` 的 `% w.paths.length`
  会**静默回绕**到 0 号路（N1/N2 只有 2 路时的真实陷阱）
- `tech.costPerLevel` 长度 == `maxLevel`；**8 条总额精确 == 576,000 金 / 49,000 木**（§15.13，含 3 条负对照：少 1 金 / 退回 313,200 / 抬到 677,000）
- **`tech.target` == §14.20 的 8 个槽位**（含「改成别的槽位」「删掉字段」两条负对照）
- **`constants.economyTargets.spendRatios.tech` 必须 == 350**（§14.12）；四项之和 == 1000
- **`constants.acceptanceTargets`**：`solvabilityMax == 1000`、舒适带 `min < max ≤ solvabilityMax`、
  适用波次升序、**`towersAtWave10*` 必须不存在**（§15.4）——每条都有负对照
- **`tech`：`effectMode='mul'` 的线，5 级乘积必须等于契约 §14.2 的总倍率**；
  `add` 且有上限的线必须带 `effectCap` 且与 constants 的 cap 一致；
  总验算 `tier 52.5× × 攻击 × 攻速 ≥ 1373×`
- **`map`：几何 ↔ `constants.map`**（buildDepth / vault 尺寸 / haltPointsPerLane）、
  路径 `id` == 数组下标、waypoint 必须整格且轴对齐、末点必须在宝库内、停顿点不得在宝库内、
  `pathLengthCells` 必须能由 waypoints 复算（±1 格）、路径长度 30–50 格（§4.6 ≈40）、
  `openLanes` 必须等于 `[0..n-1]` 且长度等于 `difficulty.openLanes`、
  §4.6 通过时间（2.0 格/s → 15–25s、4.0 格/s → 7–13s）
- `relics.crystalCostPerLevel` 长度 == `maxLevel`
- `constants`：`levelMul` 恰好 5 个、`counterMatrixStandard` 5×5 且压缩后落在 [0.6, 1.5]、
  净难度爬升 1.05–1.09、`walletIndex ≤ 1.20`、经济占比合计 1000
- 数值叶子节点全部为整数（铁律 3）

## 7. 命令

```powershell
$node = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

& $node $pnpm validate-data   # ajv 校验 + 跨表/跨文件引用完整性（改动 JSON 后必跑）
& $node $pnpm gen-types       # 重新生成 src/data/types.generated.ts（改 Schema 后必跑）
& $node $pnpm exec vitest run tests/data   # 数据 vs 策划案逐条对照
```

`src/data/types.generated.ts` 是生成物，**任何人不得手改**；`tests/data/types.spec.ts`
会比对「文件内容 == 当前生成结果」，手改或忘记重生成都会红。

## 8. `map.json` 的坐标体系（契约 §14.11）

`map.json` 的字段与 `src/sim/content.ts` 的 `GridDef` / `PathDef` **逐字段同单位**，
没有任何换算层（这就是它存在的意义：让模拟层不再复用 `m0-fixture.ts` 的几何）：

| map.json | sim 类型 | 单位 |
|---|---|---|
| `grid.width` / `grid.height` | `GridDef.width/height` | **普通整数（格）** |
| `vault.{x,y,w,h}` | `GridDef.vault` | **普通整数（格）** |
| `buildDepth` | `SimConstants.buildDepth` | **普通整数（格）** |
| `paths[].waypoints[].{x,y}` | `PathDef.waypoints[].{x,y}` | **格 ×1000 定点**（`floor(x/1000)` = 所在格，与 `rasterizePathCells` 一致） |
| `paths[].haltIndex` | `PathDef.haltIndex` | 普通整数（下标） |
| `paths[].id` | `PathDef.id` | 普通整数，**必须 == 数组下标** |
| `openLanes.{N1..N5}` | `DifficultyRow.paths`（路数）+ 数组顺序 | 整数列表，**必须是 `[0..n-1]`** |

⚠️ **这是本项目第 4 类「同型不同单位」陷阱**（前三次：`attackInterval` 频率/间隔、`bounty` 绝对值/比率、
`aura` 增量/乘区）。所以 `map.json` 里**不许出现像素，也不许把格写成浮点**，校验器会拒绝非整格坐标。

**对齐是编译期强制的**：`tests/data/map.spec.ts` 用 `import type { GridDef, PathDef } from '../../src/sim/content'`
定义了 `asGridDef()` / `asPathDefs()` 两个**无断言、无转换**的装配函数 ——
一旦我这边改字段名或改单位，`pnpm typecheck` 就会失败，而不是等到运行时静默错位。

**起点几何取自 `m0-fixture.ts`**（48×33 / 宝库 `22,14 5×5` / 4 路 / 每路 1 个 ★停顿点 / 深度 2），
数组顺序为 **A(左上)、C(左下)、B(右上)、D(右下)**：这样 N1/N2 打开的前 2 条正好是
策划案 §4.6 写的「2 路（A、C）」，同时 §14.2 波次示例里的 `path: [0,1]` 在 2 路与 4 路难度下都合法。
实测折线长 **36/38/36/34** 格，与 §4.6「约 40 格」同量级（偏短 5%–15%）。
**这张表应在 M1 前定稿** —— M1 若调地图，所有路径相关结论（射程覆盖、卡位效果）都会变。
