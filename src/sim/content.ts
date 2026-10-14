/**
 * 模拟层内容（配置）类型 —— **M0 合成夹具的形状定义**
 *
 * ⚠️ 接口契约 §4.2：M0 阶段 `src/sim/**` **不得 import `src/data/**`**。
 * 因此本文件只声明「模拟层需要什么形状的数据」，不声明任何具体数值。
 * 具体数值由调用方注入（`tools/bench/fixture.ts` 的合成夹具，或 M1 的
 * `src/data/*.json` 经适配层转换后的结果）。
 *
 * M1 集成时需要一个适配函数：`src/data/*.json` → `SimContent`。
 * 字段语义与接口契约 §3.2 的单位约定一一对应（见每个字段的注释）。
 */
import type { Fixed } from './fixed';

/** 护甲类型（策划案 §4.3 的 5 列 + §4.5.2 提到的「英雄甲」= 6 种）。 */
export type ArmorType = 'light' | 'medium' | 'heavy' | 'fortified' | 'hero' | 'divine';

/** 攻击类型（策划案 §4.3 的 5 行）。 */
export type AttackType = 'normal' | 'pierce' | 'magic' | 'siege' | 'chaos';

/** 矩阵下标顺序（契约 §3.3 `counterMatrixStandard` 的 5×5 行列顺序）。 */
export const ATTACK_TYPES: readonly AttackType[] = ['normal', 'pierce', 'magic', 'siege', 'chaos'];
export const ARMOR_TYPES: readonly ArmorType[] = ['light', 'medium', 'heavy', 'fortified', 'divine'];

/**
 * 光环效果（策划案 §4.2.3；契约 §12.2 / §14.10 —— **数组化**，一个单位可带多条）。
 *
 * `value` 的语义按 kind 区分（契约 §14.10 明确警告过"单位语义不一致但类型相同"这一坑）：
 * | kind | value 语义 |
 * |---|---|
 * | `attack` / `attackSpeed` / `range` / `all` / `steal` | **乘区**千分比（1250 = ×1.25） |
 * | `slow` | **目标移速乘区**千分比（600 = −40%） |
 * | `stealResistDebuff` | **目标窃金抗性削减量**千分比（250 = −25% 抗性） |
 */
export type AuraKind =
  | 'attack'
  | 'attackSpeed'
  | 'range'
  | 'slow'
  | 'steal'
  | 'stealResistDebuff'
  /** 同时作用于 attack + attackSpeed + range（法师爷爷「大法师光环」） */
  | 'all';

export interface AuraDef {
  kind: AuraKind;
  value: Fixed;
  /** 格，定点；0 = 全图 */
  radius: Fixed;
}

/**
 * 单位（塔）定义 —— 策划案 §4.2。
 * 与 units.json 的字段一一对应；`attackInterval` 是**间隔秒**（契约 §3.2 的易错项）。
 */
export interface UnitDef {
  id: string;
  name: string;
  /** 等级 1..5（普通整数） */
  tier: number;
  costGold: Fixed;
  costWood: Fixed;
  attack: Fixed;
  /** 秒，定点。注意不是「次/秒」 */
  attackInterval: Fixed;
  /** 格，定点 */
  range: Fixed;
  attackType: AttackType;
  /** 定点。0 = 不参与窃金（纯输出塔） */
  stealBase: Fixed;
  /** 千分比：50 = 5% */
  critRate: Fixed;
  /** 千分比：1500 = ×1.5 */
  critMul: Fixed;
  /** 阻挡名额（普通整数） */
  block: number;
  /** 格，定点 */
  blockRange: Fixed;
  /** 千分比：700 = 返还 70% */
  sellsFor: Fixed;
  /** 千分比：400 = 被阻挡时 −40% 移速 */
  slowWhileBlocked: Fixed;
  /** 格/秒，定点 */
  projectileSpeed: Fixed;
  /** 多重箭目标数（普通整数，>=1） */
  multiShot: number;
  /** 溅射半径，格，定点；0 = 无溅射 */
  splash: Fixed;
  /** 命中减速：目标移速乘区下限（千分比，750 = −25%）；1000 = 不减速 */
  slowOnHit: Fixed;
  /** 减速持续（秒，定点） */
  slowDuration: Fixed;
  /** 被本塔阻挡的敌人窃金抗性削减（千分比，250 = −25%；训导主任「罚站」） */
  resistReduce: Fixed;
  /** 窃金附带窃木比例（千分比，50 = 窃金额的 5% 转为木材） */
  stealWoodRatio: Fixed;
  /** 木材产出，定点/秒。小精灵系 > 0 */
  woodPerSecond: Fixed;
  /**
   * 光环列表（契约 §12.2 / §14.10）。不可叠加，**同类取最高**。
   * 缺省/空数组 = 无光环。
   */
  auras?: AuraDef[];
  /**
   * @deprecated 单光环旧字段（契约 §12.2 已弃用）。sim 仍然认它：
   * 当 `auras` 为空而 `aura` 有值时按单条处理，避免适配层一次性迁移时炸掉。
   */
  aura?: AuraDef | null;
  /** 升级目标单位 id；null = 顶级 */
  upgradeTo: string | null;
  /** 窃金科技/装备/罚站加成接口（M0 由 SimConstants 提供，M1 接科技系统） */
  isSteal: boolean;
  /** 允许免费重新部署（策划案 §4.2.1 飞贼 T5「瞬移」） */
  canRelocate: boolean;
  /** 解锁波次（普通整数）。0 = 开局可用 */
  unlockWave: number;
  /** 潜行类被动：窃金效率附加千分比（250 = +25%） */
  stealBonus: Fixed;
}

/** 敌人定义 —— 策划案 §4.5.2。 */
export interface EnemyDef {
  id: string;
  name: string;
  armorType: ArmorType;
  flying: boolean;
  /** 格/秒，定点。这是**基础移速**，实际血量/钱包按波次指数放大 */
  speed: Fixed;
  baseHp: Fixed;
  baseWallet: Fixed;
  /** 千分比：700 = 70% 窃金抗性 */
  stealResist: Fixed;
  /** 千分比：150 = 15% 闪避（普通整数不适用，这里是定点） */
  dodge: Fixed;
  /**
   * 击杀奖励（定点，**第 1 波基准常量**）。
   * ⚠️ 契约 §14.6：这个字段**必须按波次缩放**，否则第 30 波只有设计的 1.4%。
   * 优先用 `killGoldRatio`；为 0 时由 sim 从 `killGold / baseWallet` 反推比率。
   */
  killGold: Fixed;
  killWood: Fixed;
  /**
   * 击杀奖励比率（千分比，占**该敌人当波钱包**的比例）—— 契约 §14.6，镜像 `bountyRatio`。
   * > 0 时优先于 `killGold` 常量使用：`killGold(wave) = 当波钱包 × ratio / 1000`。
   */
  killGoldRatio?: Fixed;
  /** 击杀掉木比率（千分比，占当波钱包）—— 与 `killGoldRatio` 同源同坑（契约 §14.6） */
  killWoodRatio?: Fixed;
  /** 心魔：死亡时分裂出的半血分身数量（普通整数） */
  splitOnDeath: number;
  /** 转生者：复活一次（50% 血量） */
  reviveOnce: boolean;
  /** 是否 BOSS（用于报告，不影响模拟） */
  boss: boolean;
}

/** 波次组 —— 策划案 §4.5.3。 */
export interface WaveGroupDef {
  enemy: string;
  /** 普通整数 */
  count: number;
  /** 秒，定点 */
  interval: Fixed;
  /** 秒，定点，相对于本波开始 */
  delay: Fixed;
  /** 该组使用的路径下标；缺省 = 全部路径轮转 */
  path?: number[];
}

export interface WaveDef {
  /** 普通整数，从 1 开始 */
  wave: number;
  /** 秒，定点 */
  prepTime: Fixed;
  groups: WaveGroupDef[];
  rewardGold: Fixed;
  rewardWood: Fixed;
  hint: string;
}

/** 路径定义（策划案 §4.6）。waypoint 坐标为**格**，定点。 */
export interface PathDef {
  /** 普通整数 */
  id: number;
  waypoints: { x: Fixed; y: Fixed }[];
  /** 停顿点：敌人到达 `waypoints[haltIndex]` 时停顿 `haltPointStopDuration` */
  haltIndex: number;
}

/** 地图网格（格，普通整数）。 */
export interface GridDef {
  width: number;
  height: number;
  /** 宝库 5×5（策划案 §4.6） */
  vault: { x: number; y: number; w: number; h: number };
}

/**
 * 全局平衡常量 —— 契约 §3.3 `constants.json` 里**模拟层真正用到**的子集。
 * 所有键名与契约 §3.3 一致，便于 M1 直接映射。
 */
export interface SimConstants {
  tickRate: number; // 60（普通整数）
  // 成长曲线（§5.1）
  baseHp: Fixed;
  hpIndex: Fixed; // 1380 → 1.380
  baseWallet: Fixed;
  walletIndex: Fixed; // 1290 → 1.290
  enemyCountBase: Fixed; // 6
  enemyCountSlope: Fixed; // 800 → 0.8
  // 窃金（§4.1.2）
  levelMul: Fixed[]; // [1000,1350,1850,2600,3800]
  stealAtkCoef: Fixed; // 20 → (1 + 0.02 × 攻击力)
  critRateBase: Fixed; // 50 → 5%
  critRateCap: Fixed; // 300 → 30%
  critMulBase: Fixed; // 1500
  critMulPerLevel: Fixed; // 250
  critMulCap: Fixed; // 2750
  // 克制矩阵（§4.3）
  counterMatrixStandard: Fixed[][]; // 5×5，行=攻击类型 列=护甲类型
  compressedFactor: Fixed; // 500 → ×0.5
  compressedFloor: Fixed; // 600 → 下限 0.6
  /** 英雄甲在 5×5 矩阵中的取列映射（契约 §3.3 只定义了 5 列） */
  armorAlias: Partial<Record<ArmorType, ArmorType>>;
  // 阻挡与卡位（§4.2.4）
  haltPointStopDuration: Fixed; // 600 → 0.6s
  // 建筑师技能（§4.1.4）
  salaryCooldown: Fixed; // 90000 → 90s
  salaryMultiplier: Fixed; // 60000 → 60 × 基地每秒产出
  brambleCooldown: Fixed; // 120000 → 120s
  brambleDuration: Fixed; // 3000 → 3s
  midasCooldown: Fixed;
  midasThreshold: Fixed; // 150 → 血量 <15%
  // 局内起始与上限（策划案 §4.8 难度表；注意 §3.4 与 §4.8 的生命数值互相矛盾，见汇报）
  baseIncomePerSec: Fixed; // 「领工资」的基数（基地每秒产出）
  populationCap: number;
  /** 可建造区深度：路径两侧各 N 格（§4.6） */
  buildDepth: number;
  startWave: number;
  totalWaves: number;
  /** 击杀奖励是否按波次缩放（M0 恒为 1000 = 不缩放） */
  killRewardWaveScale: Fixed;
  /**
   * 存档继承：每 N 级存档等级换 1 级免费起始等级（§4.4.2）。
   * 对应 `constants.techArchiveFreeLevelDivisor = 2`；**可选**是为了不破坏
   * 尚未补该字段的适配层（缺省按 2 处理，与 constants.json 同值）。
   */
  techArchiveFreeLevelDivisor?: number;
  /**
   * 存档继承：每级存档等级给造价打的折扣（千分比/级，§4.4.2）。
   * 对应 `constants.techArchiveCostReductionPct = 80`；缺省按 80 处理。
   */
  techArchiveCostReductionPct?: Fixed;
  /** N1–N5 难度行（策划案 §4.8） */
  difficulty: Record<DifficultyId, DifficultyRow>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 科技（策划案 §4.4；契约 §14.2 裁决：线性 → 乘法）
// ─────────────────────────────────────────────────────────────────────────────

/** `effectPerLevel` 的单位。 */
export type TechEffectUnit = 'permille' | 'count';

/**
 * 效果模式（契约 §14.2 新增，`data-arch` 正在加到 `TechDef`）。
 * - `mul`：每级**乘** `effectPerLevel`（1500 = ×1.50/级）→ 指数通道
 * - `add`：每级**加** `effectPerLevel`（50 = +5%/级，有上限）
 *
 * 缺省按 `add` 处理（兼容 `effectMode` 尚未落盘的旧 `tech.json`）。
 */
export type TechEffectMode = 'add' | 'mul';

export interface TechCost {
  gold: Fixed;
  wood: Fixed;
}

/**
 * 科技**作用目标**（契约 §14.20 新增必填字段，`data-arch` 所有）。
 *
 * 为什么必须有：没有它，效果只能由 `id` 隐含 → 引擎必须内联一张 id→槽位映射表
 * → **违反铁律 5**（加一条科技线就要改引擎代码）。§14.20 裁决：
 * `TechDef.target` 用这 8 值枚举，引擎读它、**删掉硬编码映射**。
 */
export type TechTarget =
  | 'attack'
  | 'speed'
  | 'range'
  | 'steal'
  | 'critRate'
  | 'critMul'
  | 'population'
  | 'baseLevel';

/** 契约 §14.20 的 8 值枚举（顺序即文档顺序）。 */
export const TECH_TARGETS: readonly TechTarget[] = [
  'attack',
  'speed',
  'range',
  'steal',
  'critRate',
  'critMul',
  'population',
  'baseLevel',
];

/** 科技线定义（对应 `src/data/tech.json` 的一条）。 */
export interface TechDef {
  id: string;
  name: string;
  /** 普通整数 */
  maxLevel: number;
  effectPerLevel: Fixed;
  effectUnit: TechEffectUnit;
  effectMode: TechEffectMode;
  /**
   * 作用于哪条乘区/加项（契约 §14.20）。**引擎据此决定效果，不再看 `id`**。
   * 可选仅用于兼容尚未补该字段的数据；那种情况会记入 `legacyTargetIds` 并暴露出来。
   */
  target?: TechTarget;
  /** 逐级造价，下标 = 目标等级 − 1 */
  costPerLevel: TechCost[];
  archivable: boolean;
  /** 前置科技：需要这些科技至少 1 级 */
  requires?: string[];
}

export type TechTable = Record<string, TechDef>;

/** 存档继承的两个常量的**兼容默认值**（适配层尚未补字段时用；与 constants.json 同值）。 */
export const TECH_ARCHIVE_FREE_LEVEL_DIVISOR_DEFAULT = 2;
export const TECH_ARCHIVE_COST_REDUCTION_PCT_DEFAULT = 80;

export type DifficultyId = 'N1' | 'N2' | 'N3' | 'N4' | 'N5';

/** 策划案 §4.8 难度分级的一行。 */
export interface DifficultyRow {
  hpMul: Fixed; // 敌人血量（千分比）
  walletMul: Fixed; // 敌人钱包（千分比）
  crystalMul: Fixed; // 暗金结晶系数（千分比，§4.7.1）
  startGold: Fixed;
  startWood: Fixed;
  lives: number; // 普通整数
  paths: number; // 开放路数（普通整数）
  /** true = 启用压缩克制倍率（N1/N2），false = 标准（N3+） */
  compressed: boolean;
}

/** 模拟层内容的完整输入。`createWorld` 只依赖这个形状。 */
export interface SimContent {
  label: string;
  /** true = M0 合成夹具（不是策划案真实数值） */
  synthetic: boolean;
  units: Record<string, UnitDef>;
  enemies: Record<string, EnemyDef>;
  waves: WaveDef[];
  constants: SimConstants;
  paths: PathDef[];
  grid: GridDef;
  /**
   * 科技表（`src/data/tech.json` 的映射）。缺省 = 本局没有可研究科技。
   *
   * 契约 §14.2：攻击/攻速/射程/窃金效率是**乘法**（指数通道），
   * 暴击率/暴击效率是**加法且有上限**。`effectMode` 决定，缺省 `add`。
   */
  tech?: TechTable;
}

/** 攻击类型 → 矩阵行下标。 */
export function attackIndex(t: AttackType): number {
  const i = ATTACK_TYPES.indexOf(t);
  return i < 0 ? 0 : i;
}

/** 护甲类型 → 矩阵列下标（含英雄甲别名解析）。 */
export function armorIndex(t: ArmorType, alias: SimConstants['armorAlias']): number {
  const resolved = alias[t] ?? t;
  const i = ARMOR_TYPES.indexOf(resolved);
  return i < 0 ? 0 : i;
}
