/**
 * ⚠️ 本文件由 `pnpm gen-types`（tools/gen-types.ts）自动生成，请勿手改。
 * 源：src/data/schema/*.schema.json
 *
 * 生成类型是策划案 14.1 手写类型的超集（接口契约 §3.4）：
 *  - 字段名与 14.1 完全一致，未删除任何字段
 *  - 追加的可选扩展字段（auras / effectUnit / equipSlot / availableFrom）已在各自 JSDoc 标注
 *
 * 定点约定（接口契约 §2）：除纯计数外，一切数值均为 ×1000 的整数。
 *  - `attackInterval` 是「间隔秒」，不是「次/秒」
 *  - `block` / `tier` / `wave` / `count` / `maxLevel` / `openLanes` / `lives` 等为纯计数
 *  - 数组长度约束（levelMul 恰好 5 个、counterMatrixStandard 5×5、costPerLevel 长度 == maxLevel）
 *    由 `pnpm validate-data` 的 ajv 门禁强制；类型层不展开为元组，以贴合契约 §3.3/§14.1 的 `T[]` 写法
 */

/** 定点数：始终是整数，真实值 = Fixed / 1000 */
export type Fixed = number;


export type ConfigTableEntry =
  | UnitDef
  | EnemyDef
  | WaveDef
  | TechDef
  | RelicDef
  | EquipmentDef
  | DifficultyDef
  | BalanceConstants
  | AudioDef
  | MapDef;
export type AttackType = 'normal' | 'pierce' | 'magic' | 'siege' | 'chaos';
export type AuraKind = 'attackPct' | 'speedPct' | 'rangePct' | 'slowPct' | 'allPct' | 'stealPct' | 'stealResistDebuff';
/**
 * 技能 id 目录。新增技能必须同时在此枚举登记 —— 这是引用完整性的校验目标。
 */
export type AbilityId =
  | 'stealth'
  | 'midas_touch'
  | 'relocate_free'
  | 'steal_ignore_counter'
  | 'multishot'
  | 'bounce'
  | 'archmage_range_aura'
  | 'phalanx'
  | 'chain_pull'
  | 'detention'
  | 'detention_steal_aura'
  | 'frost_hit'
  | 'group_slow'
  | 'group_slow_freeze'
  | 'splash'
  | 'splash_burn'
  | 'wood_gather'
  | 'build_boost'
  | 'tech_unlock';
export type ArmorType = 'light' | 'medium' | 'heavy' | 'fortified' | 'divine';
export type Hook = 'split' | 'revive' | 'aura_speed' | 'boss_drop' | 'steal_immune';
export type EffectKind = 'stealPct' | 'critRate' | 'speedPct' | 'bountyPct' | 'cooldownPct' | 'rangePct' | 'attackPct';
/**
 * @minItems 2
 * @maxItems 4
 */
export type LaneList = number[];

/**
 * 塔/单位定义（策划案 §4.2）。所有数值字段遵循接口契约 §2/§3.2 定点约定（×1000）；纯计数字段（tier / block）用普通整数。
 */
export interface UnitDef {
  /**
   * 唯一 id（snake_case）。被 waves/enemies/relics/equipment 引用。
   */
  id: string;
  name: string;
  /**
   * 单位系。本期可用 9 值：6 大战斗塔系（thief/archer/mage/drill/beauty/cannon）+ 3 个经济/功能系（worker 工人 / sprite 小精灵 / tech 科技塔）。hero 为 M6 保留成员（§14.1 冻结值），本期 units.json 不得出现。
   */
  line: 'thief' | 'archer' | 'mage' | 'drill' | 'beauty' | 'cannon' | 'worker' | 'sprite' | 'tech' | 'hero';
  /**
   * 等级。T2 分支（军训系）两条分支同为 2。
   */
  tier: 1 | 2 | 3 | 4 | 5;
  cost: Cost;
  /**
   * 定点。策划案 8 → 8000
   */
  attack: number;
  /**
   * ★ 间隔秒，定点。不是频率。策划案 1.0/s → 1000；1.2/s → 833；0.6/s → 1667（round(1000/频率)）
   */
  attackInterval: number;
  /**
   * 格，定点。2.0 格 → 2000
   */
  range: number;
  attackType: AttackType;
  /**
   * 窃金基础系数，定点。0 = 非经济塔
   */
  stealBase: number;
  /**
   * 窃金暴击率，千分比。50 = 5%
   */
  critRate: number;
  /**
   * 窃金暴击倍率，千分比。1500 = ×1.5
   */
  critMul: number;
  /**
   * 光环列表（同级不叠加，取最高）。★ 主策划裁决：契约 §14.1 的单对象 `aura` **已弃用并从此 Schema 删除**——两者并存会让「引擎读 aura、数据写 auras」变成静默失效且无报错。多效果单位（法师爷爷 +15%攻击/+15%攻速/+10%射程；训导主任 敌人−25%抗性 + 周围神偷系+20%窃金）一律写在 auras[] 里。
   *
   * @minItems 1
   * @maxItems 3
   */
  auras?: Aura[];
  /**
   * 特殊技能。params 的键名自带单位后缀（见 schema/README 约定）。
   *
   * @minItems 1
   * @maxItems 4
   */
  abilities?: Ability[];
  /**
   * 阻挡名额，纯计数
   */
  block: number;
  /**
   * 被本塔阻挡时敌人额外减速，千分比。400 = −40%（列阵）
   */
  slowWhileBlocked: number;
  /**
   * 可升级目标 unit id。长度 >1 = 分支。必须真实存在于 units.json。
   *
   * @minItems 1
   * @maxItems 2
   */
  upgradesTo?: string[];
  /**
   * 出售返还，千分比。700 = 70%
   */
  sellsFor: number;
  icon: string;
  sprite: string;
  description: string;
  /**
   * UI 定位标签（策划案 §6.1 ②）
   */
  roleTag?: 'transition' | 'core' | 'support' | 'blocker' | 'endgame';
}
export interface Cost {
  /**
   * 定点。250 金 → 250000
   */
  gold: number;
  /**
   * 定点。1500 木 → 1500000
   */
  wood: number;
}
/**
 * 光环。★ 主策划裁决：单对象 `aura` 已弃用，全部效果写在单位的 auras[] 列表里（避免引擎/数据字段不一致导致静默失效）。
 */
export interface Aura {
  kind: AuraKind;
  /**
   * 千分比
   */
  value: number;
  /**
   * 格，定点；0 = 全图
   */
  radius: number;
  affects: 'allyTower' | 'enemy';
}
export interface Ability {
  id: AbilityId;
  /**
   * 秒，定点。0 = 常驻被动
   */
  cooldown: number;
  /**
   * 参数表。键名后缀决定单位：…Pct=千分比；…Sec=秒(定点)；…Cells=格(定点)；无后缀=纯计数。
   */
  params: {
    [k: string]: number;
  };
}
/**
 * 敌人定义（策划案 §4.5.2）。baseHp / baseWallet 是「第 1 波的基准值 × 该敌人的系数」，波次成长由 constants.json 的 hpIndex / walletIndex 施加。
 */
export interface EnemyDef {
  /**
   * 唯一 id。被 waves.json 的 groups[].enemy 引用。
   */
  id: string;
  name: string;
  armorType: ArmorType;
  /**
   * 定点。基准 40 HP × 系数 → 40000
   */
  baseHp: number;
  /**
   * 定点。基准 10 金 × 系数 → 10000
   */
  baseWallet: number;
  /**
   * 格/秒，定点。2.0 格/秒 → 2000
   */
  speed: number;
  flying: boolean;
  /**
   * 窃金抗性，千分比。1000 = 完全免疫
   */
  stealResist: number;
  /**
   * 闪避率，千分比
   */
  dodge: number;
  bountyRatio: BountyRatio;
  isBoss: boolean;
  /**
   * 特殊机制钩子 id；必须来自固定目录（引用完整性校验目标）
   *
   * @minItems 1
   * @maxItems 4
   */
  hooks?: Hook[];
  sprite: string;
  description?: string;
}
export interface BountyRatio {
  /**
   * ★ 击杀奖励**比率**，千分比：占该敌人「当波钱包」的比例。170 = 17%。
   *
   * **必须乘以当波钱包才是实际金币**：`killGold = bountyRatio.gold × baseWallet × walletIndex^(wave-1) / 1000`。（契约 v0.1.2 修订：原 `bounty.gold` 名为 gold 却要求按曲线缩放，是陷阱——engine-dev 极可能当绝对值实现，结果全局击杀奖励只有钱包总量的 0.04%，违反 §4.1.1「击杀奖励占收入 15–20%」。）
   */
  gold: number;
  /**
   * 击杀奖励木材比率，千分比。§4.1.1 规定木材主要来自小精灵与窃金附带，故本表全为 0。
   */
  wood: number;
}
/**
 * 单波配置（策划案 §4.5.1 / §14.2）。hint 是 §6.1 ③ 波次预告面板的数据源，本表要求三字段齐备。
 */
export interface WaveDef {
  /**
   * 波次号，纯计数，1..30 且全局唯一
   */
  wave: number;
  /**
   * 备战时间，秒（定点）
   */
  prepTime: number;
  /**
   * @minItems 1
   * @maxItems 4
   */
  groups: WaveGroup[];
  reward: Bounty;
  hint: Hint;
}
export interface WaveGroup {
  /**
   * 敌人 id，必须存在于 enemies.json
   */
  enemy: string;
  /**
   * 数量，纯计数
   */
  count: number;
  /**
   * 生成间隔，秒（定点）。0.8s → 800
   */
  interval: number;
  /**
   * 本组延迟启动，秒（定点）
   */
  delay: number;
  /**
   * 路径索引；缺省 = 全部开放路径均分。N1/N2 只开放索引 0/1。
   *
   * @minItems 1
   * @maxItems 4
   */
  path?: number[];
}
export interface Bounty {
  /**
   * 本波结算奖励金币，定点
   */
  gold: number;
  /**
   * 本波结算奖励木材，定点
   */
  wood: number;
}
export interface Hint {
  recommendArmor: ArmorType;
  recommendAttack: AttackType;
  text: string;
}
/**
 * 局内科技线（策划案 §4.4.1，契约 §14.2 起改为「加法 / 乘法」双模式）。
 *
 * effectMode + effectUnit + effectPerLevel 三者共同决定效果：
 *   · effectMode='add'  → 第 n 级加成 = base + n × effectPerLevel/1000（千分比增量，线性）
 *   · effectMode='mul'  → 第 n 级乘区 = (effectPerLevel/1000)^n（千分比倍率，指数）
 *
 * ★ 契约 §14.2 为什么要有 effectMode：§4.4.1 原本全是线性（攻击 +10%/级，5 级只 +50%），
 * 而血量曲线是 1.283^29 = 1373×、塔的 tier 强度只有 ~52× —— 缺一条「金币 → DPS」的指数通道，
 * 数据在数学上不可通关（balance-eng 实证：无限金钱 + 40 座满级飞贼仍死于第 22 波）。
 * 攻击/攻速/射程/窃金效率四条改为乘法后，`52.5 × 7.59 × 5.38 = 2144×` 才能压住 1373×。
 */
export interface TechDef {
  id: string;
  name: string;
  maxLevel: number;
  /**
   * ★ 契约 §14.2 新增（必填）。add = 每级加法增量；mul = 每级乘法倍率。**引擎必须先读这个字段**，否则会把 ×1.50 当成 +150% 处理（这正是本项目第 5 类「同型不同单位」陷阱）。
   */
  effectMode: 'add' | 'mul';
  /**
   * ★ 契约 §14.20 新增（必填）：这条科技**作用于什么**。此前效果由 `id` 隐含，引擎只能硬编码一张 id→槽位映射表（违反 AGENTS.md 铁律 5「代码不得内联魔法数字」），后果是「加一条科技线就要改引擎代码」。引擎应改为读本字段。
   */
  target: 'attack' | 'speed' | 'range' | 'steal' | 'critRate' | 'critMul' | 'population' | 'baseLevel';
  /**
   * 每级效果。effectMode='add' 时是千分比增量（attack 原为 100 = +10%）；effectMode='mul' 时是千分比倍率（1500 = ×1.50/级，5 级 = 1.5^5 = 7.59×）。
   */
  effectPerLevel: number;
  /**
   * effectPerLevel 的量纲。permille = 千分比（add 增量 / mul 倍率皆为千分比）；count = 纯计数（如人口 +2）。
   */
  effectUnit: 'permille' | 'count';
  /**
   * 可选：叠加后的效果上限，千分比（仅 effectMode='add' 有意义）。窃金暴击率 300（=30%）、窃金暴击效率 2750（=275%）有上限，故这两条保持 add；校验器会断言该值等于 constants 里对应的 cap。
   */
  effectCap?: number;
  /**
   * 逐级造价，长度必须 == maxLevel。★ 契约 §15.13 口径：`支出预算 = 总收入 × 85%`（§5.4 的 80–90% 带取中）= 1,646,613；§14.12 的四个占比是**预算内的份额**，故科技总额 = 350‰ × 1,646,613 ≈ **576,000 金**（木材同比例 → 49,000）。校验器断言 8 条精确等于该总额。（上一版曾按「收入 × 35% = 677,900」算过一轮，那是把「占预算的 35%」误当成了「占收入的 35%」。）
   *
   * @minItems 1
   * @maxItems 10
   */
  costPerLevel: Cost[];
  /**
   * 是否写入存档等级（4.4.2）
   */
  archivable: boolean;
  /**
   * 前置科技 id；必须真实存在于 tech.json
   *
   * @minItems 1
   * @maxItems 3
   */
  requires?: string[];
  description: string;
}
/**
 * 圣物（策划案 §4.7.2）。crystalCostPerLevel 长度必须 == maxLevel。解锁类圣物用 unlocksUnit。
 */
export interface RelicDef {
  id: string;
  name: string;
  maxLevel: number;
  effectPerLevel: number;
  /**
   * ★ 对契约 14.1 的可选扩展（超集）：effectPerLevel 的单位。permille = 千分比；fixed = 定点数值（金币/木材/秒）；count = 纯计数。
   */
  effectUnit: 'permille' | 'fixed' | 'count';
  /**
   * 每级价格（暗金结晶，纯计数，非定点），长度必须 == maxLevel
   *
   * @minItems 1
   * @maxItems 10
   */
  crystalCostPerLevel: number[];
  /**
   * 解锁类圣物：解锁的 unit id，必须存在于 units.json
   */
  unlocksUnit?: string;
  description: string;
}
/**
 * 装备（策划案 §4.2.7，M6 上线）。⚠ 契约 14.1 未定义 EquipmentDef 手写类型，本 Schema 为 data-arch 自拟，需主策划确认。
 */
export interface EquipmentDef {
  id: string;
  name: string;
  cost: Cost;
  /**
   * @minItems 1
   * @maxItems 3
   */
  effects: Effect[];
  /**
   * 附加可选扩展：装备栏位标签（M6 英雄 6 格）
   */
  equipSlot?: 'weapon' | 'glove' | 'boots' | 'ring' | 'trinket' | 'tool';
  icon: string;
  sprite: string;
  description: string;
  /**
   * 上线里程碑。本期（M0）全部为 M6，仅建表不接入模拟层。
   */
  availableFrom: 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6';
}
export interface Effect {
  kind: EffectKind;
  /**
   * 千分比增量。stealPct +100% → 1000；cooldownPct −20% → -200；critRate +15% → 150
   */
  value: number;
  /**
   * 限定生效的塔系；缺省 = 全部
   */
  targetLine?: 'thief' | 'archer' | 'mage' | 'drill' | 'beauty' | 'cannon' | 'worker' | 'sprite' | 'tech' | 'hero';
}
/**
 * 难度分级（策划案 §4.8）。hpMul / walletMul / crystalMul 为千分比；startGold / startWood 为定点。
 */
export interface DifficultyDef {
  id: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  name: string;
  /**
   * 千分比。×0.60 → 600
   */
  hpMul: number;
  /**
   * 千分比。×1.40 → 1400
   */
  walletMul: number;
  counterMode: 'compressed' | 'standard';
  /**
   * N5 全程启用神圣甲（策划案 §4.8 注）
   */
  divineArmorAllWaves: boolean;
  /**
   * 定点。3000 金 → 3000000
   */
  startGold: number;
  /**
   * 定点。2000 木 → 2000000
   */
  startWood: number;
  /**
   * 宝库生命，纯计数
   */
  lives: number;
  /**
   * 开放路数，纯计数
   */
  openLanes: number;
  /**
   * 千分比。N1 = 0.6 → 600
   */
  crystalMul: number;
  description: string;
}
/**
 * 全局平衡常量（接口契约 §3.3）。必须覆盖策划案中所有出现在公式里、且不属于 units/tech/relics/difficulty 的数值常量。除 tickRate / fixedScale / waveTotal 等纯计数外，一律定点（×1000）。
 */
export interface BalanceConstants {
  /**
   * 逻辑定步长 60Hz。纯计数，非定点（铁律 2）
   */
  tickRate: 60;
  /**
   * 定点缩放因子。纯计数，非定点（铁律 3 / 契约 §2）
   */
  fixedScale: 1000;
  /**
   * 波次总量（策划案 D3 = 30）
   */
  waveTotal: number;
  /**
   * 默认备战时间，秒（定点）。策划案 §3.1 = 15s → 15000
   */
  wavePrepTimeDefault: number;
  /**
   * 结算阶段时长，秒（定点）。§3.1 = 3s → 3000
   */
  waveSettleTime: number;
  /**
   * 撤销窗口，秒（定点）。§3.3 = 10s → 10000
   */
  undoWindow: number;
  /**
   * 撤销返还比例，千分比。100% → 1000
   */
  undoRefundPct: number;
  /**
   * §5.1 HP(1)。★ 主策划裁决改基线：原 40 → 60。三条设计意图见 schema/README「§5.1 成长曲线基线（裁决后）」。起点值，待 headless 标定。
   */
  baseHp: number;
  /**
   * §5.1 血量指数。★ 裁决：原 1380 (1.38) → 1283 (1.283)。与 walletIndex 的比值 1.283/1.20 = 1.069 保住原设计的净难度爬升（一阶参数），同时把 30 波后置度从 1.38^29 压到 1.283^29。
   */
  hpIndex: number;
  /**
   * §5.1 W(1)。★ 两轮裁决：原 10 → 45（补上 §4.5.2 的单体钱包系数：蝙蝠 ×1.1 / 装甲车 ×2.0 / 精英刺客 ×2.5 / 圣殿守卫 ×3.0）→ **32**。第二轮只改这一个值来收口「支出/收入比」：32 时累计钱包 ≈1.797M → 收入 ≈1.583M → 对 §5.5 固定支出 1.293M = **81.7%**，落进 80–90% 验收带；净难度爬升 1.069 不受影响。起点值，待 headless 标定。
   */
  baseWallet: number;
  /**
   * §5.1 钱包指数。★ 裁决：原 1290 (1.29) → 1200 (1.20)。1.20^29 = 198×（原 1.29^29 = 1606×），压平「第 26–30 波独占 73–76% 钱包」的后置度，让前 25 波有真实经济铺塔。
   */
  walletIndex: number;
  /**
   * §5.1 Q(n) = 6 + floor(0.8n) → 6000。★ 裁决（A3/A4/A8）：Q(n) 降级为「规划参考」，**不是逐波硬要求**；硬门禁改为「非 BOSS 波敌人总数单调不减」（见 validate-data.ts）。
   */
  enemyCountBase: number;
  /**
   * §5.1 数量斜率 0.8 → 800（规划参考，见 enemyCountBase 说明）
   */
  enemyCountSlope: number;
  /**
   * §4.1.2 等级系数，恰好 5 个元素：[1000,1350,1850,2600,3800]
   *
   * @minItems 5
   * @maxItems 5
   */
  levelMul: number[];
  /**
   * §4.1.2 (1 + 0.02 × 攻击力) 的系数 20
   */
  stealAtkCoef: number;
  /**
   * §4.1.2 暴击率基础 5% → 50
   */
  critRateBase: number;
  /**
   * §4.4.1 暴击率上限 30% → 300
   */
  critRateCap: number;
  /**
   * §4.1.2 暴击倍率基础 150% → 1500
   */
  critMulBase: number;
  /**
   * §4.1.2 +25%/级 → 250
   */
  critMulPerLevel: number;
  /**
   * §4.4.1 暴击倍率上限 275% → 2750
   */
  critMulCap: number;
  /**
   * §4.1.2 缺省窃金抗性 0
   */
  stealResistDefault: number;
  /**
   * §8.5 抗性达到该值即窃金免疫 → 1000
   */
  stealImmunityThreshold: number;
  /**
   * §4.1.1 窃金附带窃木比例，千分比。★ 终值 **3**（= 3‰）。历史：data-arch 推定 10（1%）→ 首轮裁决 30 → [契约 §14.5](接口契约) 指出 30 读作 3%（差 10 倍），裁决回 3。按 ~1.8M 累计钱包、70% 覆盖率计 ≈ 3,774 木，缺口由小精灵产能承担。
   */
  stealWoodRatio: number;
  /**
   * §4.3 标准克制矩阵。行 = 攻击类型 [普通,穿刺,魔法,攻城,混乱]，列 = 护甲 [轻,中,重,城,神圣]。定点倍率。
   *
   * @minItems 5
   * @maxItems 5
   */
  counterMatrixStandard: number[][];
  /**
   * §4.3 压缩系数 0.5 → 500
   */
  compressedFactor: number;
  /**
   * §4.3 压缩下限 0.6 → 600
   */
  compressedFloor: number;
  /**
   * §4.2.4/§4.6 ★停顿点停留 0.6s → 600
   */
  haltPointStopDuration: number;
  /**
   * §4.7.1 结晶除数 1000
   */
  crystalDivisor: number;
  /**
   * §4.7.1 难度系数，千分比：600/1000/1600/2400/3600
   */
  difficultyCrystalMul: {
    N1: number;
    N2: number;
    N3: number;
    N4: number;
    N5: number;
  };
  /**
   * §4.7.1 可主动蜕变的最早波次 20
   */
  ascensionMinWave: number;
  /**
   * §4.7.3 成就系数，千分比。advanced_challenges 区间 ×1.2–2.0 取下限 1200
   */
  achievementMuls: {
    no_leak: number;
    no_ascension: number;
    speedrun: number;
    single_line: number;
    no_mage: number;
    big_spender: number;
    block_master: number;
    advanced_challenges: number;
  };
  /**
   * §6.3 第 7 步「首次结算翻倍」→ 2000
   */
  firstClearCrystalMul: number;
  /**
   * §4.1.4 领工资冷却 90s → 90000
   */
  salaryCooldown: number;
  /**
   * §4.1.4 60 × 基地每秒产出 → 60000
   */
  salaryMultiplier: number;
  /**
   * §4.1.4 荆棘丛林冷却 120s → 120000
   */
  brambleCooldown: number;
  /**
   * §4.1.4 荆棘丛林硬控 3s → 3000
   */
  brambleDuration: number;
  /**
   * §4.4.2 免费起始等级 = floor(存档等级 / 2) → 2
   */
  techArchiveFreeLevelDivisor: number;
  /**
   * §4.4.2 每级存档等级降低造价 8% → 80
   */
  techArchiveCostReductionPct: number;
  /**
   * §4.6 地图与路径常量
   */
  map: {
    /**
     * §4.6 总路径数 4，纯计数
     */
    laneCount: number;
    /**
     * §4.6 路径长度约 40 格 → 40000
     */
    pathLengthCells: number;
    /**
     * §4.6 路径两侧各 2 格 → 2000
     */
    buildableWidthCells: number;
    /**
     * §4.6 宝库 5×5 → 5000
     */
    vaultSizeCells: number;
    /**
     * §4.6 每路停顿点数 1，纯计数
     */
    haltPointsPerLane: number;
  };
  /**
   * §4.2.7 英雄系常量（M6 上线，本期数据仅登记）
   */
  hero: {
    /**
     * §4.2.7 最多 2 个，纯计数
     */
    maxCount: number;
    /**
     * §4.2.7 第 1 个 30000金/3000木，第 2 个 70000金/7000木（M6）
     *
     * @minItems 2
     * @maxItems 2
     */
    costs: Cost[];
    /**
     * §4.2.7 装备 6 格，纯计数
     */
    equipSlots: number;
    /**
     * §4.2.7 10/20/30 级变身
     *
     * @minItems 3
     * @maxItems 3
     */
    morphLevels: {
      /**
       * 纯计数
       */
      level: number;
      /**
       * 千分比。+50% → 500
       */
      attackPct: number;
    }[];
    /**
     * §4.2.7 窃金也涨经验（千分比权重）→ 1000
     */
    expFromSteal: number;
  };
  /**
   * §4.1.1 / §14.12 经济分配目标（验收目标值，非运行时公式常量）
   */
  economyTargets: {
    /**
     * §4.1.1 窃金占比下限 70% → 700
     */
    stealShareMin: number;
    /**
     * §4.1.1 窃金占比上限 80% → 800
     */
    stealShareMax: number;
    /**
     * §4.1.1 击杀奖励占比下限 15% → 150
     */
    killShareMin: number;
    /**
     * §4.1.1 击杀奖励占比上限 20% → 200
     */
    killShareMax: number;
    /**
     * §14.12 / §15.13 支出侧目标，千分比，合计 1000。★ 口径（§15.13）：这四个占比是**支出预算内的份额**，而 `支出预算 = 总收入 × 85%`（§5.4 的 80–90% 带取中）。故「占预算 35%」⇔「占收入 29.75%」—— 两个口径必须分开写，写混就会算出 677,900 这种错数。
     */
    spendRatios: {
      /**
       * §14.12 塔建造升级 50% → 500（原 55%）
       */
      tower: number;
      /**
       * §14.12 科技研究 35% → 350（原 28%；§14.2 把科技改成了主强度来源，投入必须匹配）
       */
      tech: number;
      /**
       * §14.12 小精灵与产能 8% → 80（原 10%）
       */
      sprite: number;
      /**
       * §14.12 装备与杂项 7% → 70（不变）
       */
      equipment: number;
    };
  };
  /**
   * §5.4 单局经济验收指标 + §10.2 Q1 门槛（CI 门禁目标值）。★ §15.4 删除了 towersAtWave10Min/Max（塔数是弱代理指标：18 座 T1 与 6 座 T5 完全不同），替代为 solvability 硬界 + 舒适带。
   */
  acceptanceTargets: {
    /**
     * §5.4 窃金覆盖率下限 650
     */
    stealCoverageMin: number;
    /**
     * §5.4 窃金覆盖率上限 800
     */
    stealCoverageMax: number;
    /**
     * §5.4 支出/收入比下限 800
     */
    spendRatioMin: number;
    /**
     * §5.4 支出/收入比上限 900
     */
    spendRatioMax: number;
    /**
     * §5.4 漏怪率上限 20（千分比 = 2%）
     */
    leakRateMax: number;
    /**
     * §5.4 波末金币余量下限 100
     */
    waveEndGoldMin: number;
    /**
     * §5.4 波末金币余量上限 400
     */
    waveEndGoldMax: number;
    /**
     * ★ 契约 §15.4 新增（替代被删除的塔数目标）：可通关性**硬界** —— 需求DPS/可达DPS上界 ≤ 1000（=1.0），全部 30 波 × 5 难度。
     *
     * 配的哪个上界：**最大军队上界**（50 座 T5 + 满级科技，**与波次无关**）。它证明「存在一套阵容能过」，是**存在性证明**，故意宽松 —— N2 只有 0.17× 属正常。⚠️ 它是**成本无关的**（公式里没有 `costPerLevel`），所以改科技造价不会让它变化。
     *
     * 实现位置：本轮 tests/sim/solvability.spec.ts（balance-eng），M1 迁移进 tools/validate-data.ts（契约 §14.4）。
     */
    solvabilityMax: number;
    /**
     * ★ 契约 §15.4 新增：舒适带下限 200（=0.2）——低于它说明该波对正常玩家太轻松。
     *
     * 配的哪个上界：**经济感知上界**（到该波时合理经济所能支撑的阵容），**不是** solvabilityMax 那个最大军队上界。后者与波次无关，拿它当逐波标尺只会得到恒 ~0 的无意义读数（实测 w10 0.00×、w20 0.01–0.02× —— 这正是「一个空的测量区域给出决定性否定结论」的同型陷阱）。经济感知上界由 balance-eng 在 ttk-analysis.ts 实现。
     */
    solvabilityComfortMin: number;
    /**
     * ★ 契约 §15.4 新增：舒适带上限 600（=0.6）——高于它说明该波对正常玩家太绝望。同样配**经济感知上界**（见 solvabilityComfortMin）。
     */
    solvabilityComfortMax: number;
    /**
     * ★ 舒适带适用的波次（§15.4：第 10 波与第 20 波），纯计数
     *
     * @minItems 1
     * @maxItems 4
     */
    solvabilityComfortWaves: number[];
    /**
     * §5.4 第 20 波科技等级下限 10，纯计数
     */
    techLevelsAtWave20Min: number;
    /**
     * §5.4 第 20 波科技等级上限 16，纯计数
     */
    techLevelsAtWave20Max: number;
    /**
     * §5.4/§10.2 军训系存在性下限 250（=25%，千分比）。⚠️ 契约 §14.15 已把 Q1 判据改为 balanced vs noblock 真反事实，本项降级为诊断指标。
     */
    blockExtraStealMin: number;
  };
}
/**
 * 音频清单（接口契约 §11.2，v0.1.1 增补）。id 必须与磁盘 public/assets/audio/<id>.ogg 一一对应（跨文件一致性由 tools/validate-data.ts 校验）。
 */
export interface AudioDef {
  /**
   * = 文件名（不含扩展名），如 'bgm_menu'。契约 §11.2 要求与 public/assets/audio/*.ogg 完全一一对应。
   */
  id: string;
  /**
   * 相对 public/ 的路径，§11.1 冻结为扁平结构 public/assets/audio/<id>.ogg
   */
  file: string;
  /**
   * bgm 4 条 / sfx 34 条 / ambience 2 条（合计 40，对照策划案 §7.3）
   */
  category: 'bgm' | 'sfx' | 'ambience';
  /**
   * 混音通道：只有 bgm 与 sfx 两条，没有 voice（契约 §11.3 裁决）
   */
  bus: 'bgm' | 'sfx';
  /**
   * 建议播放音量，千分比定点。1000 = 100%
   */
  gain: number;
  /**
   * bgm / ambience 为 true，sfx 为 false（契约 §11.2）
   */
  loop: boolean;
  /**
   * 淡入毫秒（纯计数，非定点）。★ ambience 必须 ≥100 且与 fadeOutMs 同时提供——两个 ambience 是 30s 截取片段，接缝未做 crossfade（§11.2 第 2 条）。此条件由校验器断言。
   */
  fadeInMs?: number;
  /**
   * 淡出毫秒（纯计数，非定点）
   */
  fadeOutMs?: number;
  description: string;
}
/**
 * 地图与路径（策划案 §4.6；契约 §14.11 新增的第 10 张表）。
 *
 * ★ 坐标体系与 `src/sim/content.ts` 的 `GridDef` / `PathDef` **逐字段同单位**（这就是本表存在的意义：让模拟层不再复用 m0-fixture 的几何）：
 *   · `grid.width/height`、`vault.{x,y,w,h}`、`buildDepth`、`haltIndex` = **普通整数（格）**
 *   · `paths[].waypoints[].{x,y}` = **格 ×1000 的定点**（`floor(x/1000)` 即所在格，与 `rasterizePathCells` 一致）
 *   · `pathLengthCells` = 格 ×1000 的定点（折线总长）
 *
 * ⚠️ 这是本项目第 4 类「同型不同单位」陷阱（前三次：attackInterval 频率/间隔、bounty 绝对值/比率、aura 增量/乘区）。
 * **不要把像素写进来，也不要把格写成浮点。**
 */
export interface MapDef {
  id: string;
  name: string;
  /**
   * 逻辑网格尺寸（格，普通整数）。对应 sim `GridDef.width/height`。
   */
  grid: {
    width: number;
    height: number;
  };
  /**
   * 宝库矩形（格，普通整数）。策划案 §4.6 = 中央 5×5。对应 sim `GridDef.vault`。
   */
  vault: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  /**
   * 可建造区深度：路径两侧各 N 格（策划案 §4.6 = 2）。对应 sim `SimConstants.buildDepth`；`computeBuildableCells` 用它从路径格向四周扩张。必须与 constants.map.buildableWidthCells/1000 一致。
   */
  buildDepth: number;
  /**
   * 每路 ★停顿点数量（策划案 §4.6 = 1）。实际位置由 `paths[].haltIndex` 指定（停顿时长在 constants.haltPointStopDuration）。必须与 constants.map.haltPointsPerLane 一致。
   */
  haltPointsPerLane: number;
  /**
   * 路径序列。★ **数组顺序即 sim 的开放路顺序**：`tick.ts` 用 `constants.difficulty[id].paths` 作为**路数**取 `content.paths[0..n-1]`，所以前 N 条必须是该难度真正要开的路。
   *
   * @minItems 2
   * @maxItems 4
   */
  paths: Path[];
  /**
   * 各难度开放的路径 id 列表（策划案 §4.6：N1–N2 开 2 路，N3+ 开 4 路）。必须与 difficulty.json 的 openLanes（路数）一致，且必须等于 `[0..n-1]`（sim 按数组顺序取前 n 条）。
   */
  openLanes: {
    N1: LaneList;
    N2: LaneList;
    N3: LaneList;
    N4: LaneList;
    N5: LaneList;
  };
  description: string;
}
export interface Path {
  /**
   * 路径 id。必须 == 它在 paths[] 中的下标（sim 用下标索引）。
   */
  id: number;
  /**
   * 策划案 §4.6 的入口代号（A 左上 / B 右上 / C 左下 / D 右下）
   */
  lane: 'A' | 'B' | 'C' | 'D';
  name: string;
  /**
   * 折线顶点（格，定点）。waypoints[0] = 入口，最后一个 = 宝库。相邻点必须轴对齐（本表为格子地图）。
   *
   * @minItems 2
   * @maxItems 12
   */
  waypoints: Point[];
  /**
   * ★停顿点所在 waypoint 下标；敌人到达 `waypoints[haltIndex]` 时停顿 constants.haltPointStopDuration。必须 < waypoints.length。
   */
  haltIndex: number;
  /**
   * 折线总长（格，定点）。策划案 §4.6 ≈ 40 格；校验器会从 waypoints 重算并断言误差 ≤1 格（防手抄错）。
   */
  pathLengthCells: number;
}
/**
 * 格坐标（定点 ×1000）。`floor(x/1000)` 即所在格。
 */
export interface Point {
  x: number;
  y: number;
}

/** 表级别名：整张 JSON 表的根类型 */
export type UnitTable = UnitDef[];
export type EnemyTable = EnemyDef[];
export type WaveTable = WaveDef[];
export type TechTable = TechDef[];
export type RelicTable = RelicDef[];
export type EquipmentTable = EquipmentDef[];
export type DifficultyTable = DifficultyDef[];
export type AudioTable = AudioDef[];

/** 8 张配置表在内存中的统一形状（data loader 消费） */
export interface ConfigTables {
  units: UnitTable;
  enemies: EnemyTable;
  waves: WaveTable;
  tech: TechTable;
  relics: RelicTable;
  equipment: EquipmentTable;
  difficulty: DifficultyTable;
  constants: BalanceConstants;
  audio: AudioTable;
  map: MapDef;
}

/** 配置表文件名 → 根类型名（供 loader 做运行期断言） */
export const TABLE_ROOT_TYPES = {
  'units.json': 'UnitDef',
  'enemies.json': 'EnemyDef',
  'waves.json': 'WaveDef',
  'tech.json': 'TechDef',
  'relics.json': 'RelicDef',
  'equipment.json': 'EquipmentDef',
  'difficulty.json': 'DifficultyDef',
  'constants.json': 'BalanceConstants',
  'audio.json': 'AudioDef',
  'map.json': 'MapDef',
} as const;

