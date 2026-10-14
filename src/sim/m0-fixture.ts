/**
 * ⚠️ **M0 合成夹具（synthetic fixture）—— 不是 `src/data/**`**
 *
 * 接口契约 §4.2：M0 阶段 `engine-dev` 不得 `import src/data/**`，用内联合成夹具。
 * 本文件就是那个夹具：数值取自策划案 §3.1 / §4.1.2 / §4.2 / §4.3 / §4.5.2 / §4.6 / §4.8 /
 * §5.1，**但它是 engine-dev 手抄的**，不是 `data-arch` 的 `src/data/*.json`。
 *
 * M1 集成时必须做的事（已在汇报里列为待办）：
 *   1. 删除/冻结本文件，改为从 `src/data/*.json` 经适配层构造 `SimContent`；
 *   2. 用 `pnpm validate-data` + `pnpm gen-types` 产出的类型替换 `content.ts` 里
 *      手写的 `UnitDef` / `EnemyDef` / `SimConstants`（字段名对齐，见 content.ts 注释）；
 *   3. 校对「攻速 → attackInterval 倒数换算」这一易错项（契约 §3.2）。
 */
import { FIXED_SCALE, fromInt, truncDiv, type Fixed } from './fixed';
import type {
  DifficultyRow,
  EnemyDef,
  GridDef,
  PathDef,
  SimConstants,
  SimContent,
  TechDef,
  TechTable,
  TechTarget,
  UnitDef,
  WaveDef,
} from './content';

/** 秒 → 定点。 */
const sec = (x: number): Fixed => Math.round(x * FIXED_SCALE);
/** 格 → 定点。 */
const cells = (x: number): Fixed => Math.round(x * FIXED_SCALE);
/** 千分比。 */
const pct = (x: number): Fixed => Math.round(x * FIXED_SCALE);

/** 把「策划案里的攻速（次/秒）」转成契约 §3.2 要求的「间隔秒（定点）」。 */
function intervalFromRate(perSecond: number): Fixed {
  return Math.round((1 / perSecond) * FIXED_SCALE);
}

type UnitSeed = Partial<UnitDef> & Pick<UnitDef, 'id' | 'name' | 'tier' | 'costGold' | 'attack' | 'range' | 'attackType'>;

function unit(seed: UnitSeed): UnitDef {
  return {
    costWood: 0,
    attackInterval: intervalFromRate(1),
    stealBase: 0,
    critRate: 0,
    critMul: 0,
    block: 0,
    blockRange: 0,
    sellsFor: pct(0.7),
    slowWhileBlocked: 0,
    projectileSpeed: cells(18),
    multiShot: 1,
    splash: 0,
    slowOnHit: FIXED_SCALE,
    slowDuration: 0,
    resistReduce: 0,
    stealWoodRatio: 0,
    woodPerSecond: 0,
    aura: null,
    upgradeTo: null,
    isSteal: false,
    canRelocate: false,
    unlockWave: 0,
    stealBonus: 0,
    ...seed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 单位（策划案 §4.2，攻速已按契约 §3.2 转成间隔秒）
// ─────────────────────────────────────────────────────────────────────────────

export const M0_UNITS: UnitDef[] = [
  // 神偷系（核心经济塔，§4.2.1）
  unit({ id: 'thief_t1', name: '小偷', tier: 1, costGold: fromInt(250), attack: fromInt(8), attackInterval: intervalFromRate(1.0), range: cells(2.0), attackType: 'normal', stealBase: fromInt(4), isSteal: true, critRate: pct(0.05), critMul: pct(1.5), upgradeTo: 'thief_t2', stealWoodRatio: pct(0.05) }),
  unit({ id: 'thief_t2', name: '扒手', tier: 2, costGold: fromInt(800), attack: fromInt(20), attackInterval: intervalFromRate(1.1), range: cells(2.0), attackType: 'normal', stealBase: fromInt(8), isSteal: true, critRate: pct(0.05), critMul: pct(1.5), upgradeTo: 'thief_t3', stealWoodRatio: pct(0.05) }),
  unit({ id: 'thief_t3', name: '神偷', tier: 3, costGold: fromInt(2500), attack: fromInt(45), attackInterval: intervalFromRate(1.2), range: cells(2.2), attackType: 'pierce', stealBase: fromInt(14), isSteal: true, critRate: pct(0.05), critMul: pct(1.5), upgradeTo: 'thief_t4', stealBonus: pct(0.25), stealWoodRatio: pct(0.05) }),
  unit({ id: 'thief_t4', name: '宗师', tier: 4, costGold: fromInt(8000), attack: fromInt(110), attackInterval: intervalFromRate(1.3), range: cells(2.4), attackType: 'pierce', stealBase: fromInt(26), isSteal: true, critRate: pct(0.05), critMul: pct(1.5), upgradeTo: 'thief_t5', stealWoodRatio: pct(0.05) }),
  unit({ id: 'thief_t5', name: '飞贼·金手指', tier: 5, costGold: fromInt(25000), attack: fromInt(280), attackInterval: intervalFromRate(1.5), range: cells(3.0), attackType: 'chaos', stealBase: fromInt(55), isSteal: true, critRate: pct(0.05), critMul: pct(1.5), stealWoodRatio: pct(0.05), canRelocate: true }),
  // 弓箭系（§4.2.2）
  unit({ id: 'archer_t1', name: '弓手', tier: 1, costGold: fromInt(200), attack: fromInt(14), attackInterval: intervalFromRate(0.9), range: cells(5.5), attackType: 'pierce', projectileSpeed: cells(22) }),
  unit({ id: 'archer_t2', name: '多重弓手', tier: 2, costGold: fromInt(600), attack: fromInt(26), attackInterval: intervalFromRate(1.0), range: cells(6.0), attackType: 'pierce', multiShot: 2, upgradeTo: 'archer_t3', projectileSpeed: cells(22) }),
  unit({ id: 'archer_t3', name: '弓手老妈', tier: 3, costGold: fromInt(1800), attack: fromInt(50), attackInterval: intervalFromRate(1.1), range: cells(6.5), attackType: 'pierce', multiShot: 3, upgradeTo: 'archer_t4', projectileSpeed: cells(22) }),
  unit({ id: 'archer_t4', name: '校长老妈', tier: 4, costGold: fromInt(5000), attack: fromInt(95), attackInterval: intervalFromRate(1.2), range: cells(7.0), attackType: 'pierce', multiShot: 4, projectileSpeed: cells(22) }),
  // 法师系（§4.2.3，光环不可叠加取最高）
  unit({ id: 'mage_t1', name: '法师', tier: 1, costGold: fromInt(300), attack: fromInt(12), attackInterval: intervalFromRate(0.8), range: cells(4.5), attackType: 'magic', upgradeTo: 'mage_t2' }),
  unit({ id: 'mage_t2', name: '萨满', tier: 2, costGold: fromInt(900), attack: fromInt(24), attackInterval: intervalFromRate(0.9), range: cells(5.0), attackType: 'magic', auras: [{ kind: 'attack', value: pct(1.25), radius: cells(4) }], upgradeTo: 'mage_t3' }),
  unit({ id: 'mage_t3', name: '守望者', tier: 3, costGold: fromInt(2200), attack: fromInt(40), attackInterval: intervalFromRate(1.0), range: cells(5.0), attackType: 'magic', auras: [{ kind: 'attackSpeed', value: pct(1.3), radius: cells(4) }], upgradeTo: 'mage_t4' }),
  unit({ id: 'mage_t4', name: '法师老爸', tier: 4, costGold: fromInt(5500), attack: fromInt(75), attackInterval: intervalFromRate(1.0), range: cells(5.5), attackType: 'magic', auras: [{ kind: 'slow', value: pct(0.6), radius: cells(5) }], upgradeTo: 'mage_t5' }),
  // 契约 §14.10：法师爷爷是「全图 +15% 攻击 / +15% 攻速 / +10% 射程」**三重光环** ——
  // 数组化之后终于可以如实表达（旧单 aura 字段只能保留一条）。
  unit({ id: 'mage_t5', name: '法师爷爷', tier: 5, costGold: fromInt(14000), attack: fromInt(140), attackInterval: intervalFromRate(1.1), range: cells(6.0), attackType: 'magic', auras: [{ kind: 'attack', value: pct(1.15), radius: 0 }, { kind: 'attackSpeed', value: pct(1.15), radius: 0 }, { kind: 'range', value: pct(1.1), radius: 0 }] }),
  // 军训系（§4.2.4，阻挡名额 + 列阵减速）
  unit({ id: 'trainer_t1', name: '军训教官', tier: 1, costGold: fromInt(350), attack: fromInt(26), attackInterval: intervalFromRate(1.0), range: cells(1.8), attackType: 'normal', block: 3, blockRange: cells(1.8), slowWhileBlocked: pct(0.4), upgradeTo: 'trainer_t2a' }),
  unit({ id: 'trainer_t2a', name: '铁闸守卫', tier: 2, costGold: fromInt(1500), attack: fromInt(55), attackInterval: intervalFromRate(1.1), range: cells(2.0), attackType: 'normal', block: 6, blockRange: cells(2.0), slowWhileBlocked: pct(0.4) }),
  // 训导主任：罚站（被阻挡敌人窃金抗性 −25%）+ 周围 4 格内神偷系窃金效率 +20%
  // （后者以前在模拟里**完全不存在**，契约 §14.10 补上）
  unit({ id: 'trainer_t2b', name: '训导主任', tier: 2, costGold: fromInt(1500), attack: fromInt(70), attackInterval: intervalFromRate(1.0), range: cells(2.0), attackType: 'magic', block: 2, blockRange: cells(2.0), slowWhileBlocked: pct(0.4), resistReduce: pct(0.25), auras: [{ kind: 'steal', value: pct(1.2), radius: cells(4) }] }),
  // 美女系（§4.2.5，软减速 + 溅射）
  unit({ id: 'beauty_t1', name: '冰封美女', tier: 1, costGold: fromInt(400), attack: fromInt(18), attackInterval: intervalFromRate(0.9), range: cells(4.0), attackType: 'magic', slowOnHit: pct(0.75), slowDuration: sec(2), upgradeTo: 'beauty_t2' }),
  unit({ id: 'beauty_t2', name: '美人鱼', tier: 2, costGold: fromInt(1600), attack: fromInt(60), attackInterval: intervalFromRate(1.0), range: cells(4.5), attackType: 'magic', slowOnHit: pct(0.65), slowDuration: sec(2), splash: cells(1.2), upgradeTo: 'beauty_t3' }),
  unit({ id: 'beauty_t3', name: '美人鱼老妈', tier: 3, costGold: fromInt(7000), attack: fromInt(130), attackInterval: intervalFromRate(1.1), range: cells(5.0), attackType: 'magic', slowOnHit: pct(0.5), slowDuration: sec(1.5) }),
  // 炮塔系（§4.2.6，攻城 + 溅射）
  unit({ id: 'cannon_t1', name: '炮塔', tier: 1, costGold: fromInt(450), attack: fromInt(55), attackInterval: intervalFromRate(0.6), range: cells(5.0), attackType: 'siege', splash: cells(1.2), projectileSpeed: cells(14), upgradeTo: 'cannon_t2' }),
  unit({ id: 'cannon_t2', name: '榴弹炮', tier: 2, costGold: fromInt(1800), attack: fromInt(130), attackInterval: intervalFromRate(0.7), range: cells(6.0), attackType: 'siege', splash: cells(1.8), projectileSpeed: cells(14), upgradeTo: 'cannon_t3' }),
  unit({ id: 'cannon_t3', name: '地狱火', tier: 3, costGold: fromInt(8000), attack: fromInt(300), attackInterval: intervalFromRate(0.8), range: cells(7.0), attackType: 'siege', splash: cells(2.5), projectileSpeed: cells(14) }),
  // 木材产能（§4.1.3）+ 工人（§4.2.8）
  unit({ id: 'wisp_slow', name: '笨拙的小精灵', tier: 1, costGold: fromInt(1200), attack: 0, range: 0, attackType: 'normal', woodPerSecond: fromInt(1) / 5 }),
  unit({ id: 'wisp_mid', name: '纵情的小精灵', tier: 2, costGold: fromInt(2200), attack: 0, range: 0, attackType: 'normal', woodPerSecond: fromInt(2) / 5 }),
  unit({ id: 'wisp_fast', name: '普通小精灵', tier: 3, costGold: fromInt(4800), attack: 0, range: 0, attackType: 'normal', woodPerSecond: fromInt(1) }),
  unit({ id: 'wisp_elite', name: '高阶小精灵', tier: 4, costGold: fromInt(9000), attack: 0, range: 0, attackType: 'normal', woodPerSecond: fromInt(2) }),
  unit({ id: 'worker', name: '工人', tier: 1, costGold: fromInt(150), attack: 0, range: 0, attackType: 'normal', woodPerSecond: fromInt(1) / 10 }),
];

// ─────────────────────────────────────────────────────────────────────────────
// 敌人（策划案 §4.5.2）
// baseHp / baseWallet 是**第 1 波基准值 × 类型系数**；波次指数由模拟层叠加（§5.1）
// ─────────────────────────────────────────────────────────────────────────────

function enemy(seed: Partial<EnemyDef> & Pick<EnemyDef, 'id' | 'name' | 'armorType' | 'speed' | 'baseHp' | 'baseWallet'>): EnemyDef {
  return {
    flying: false,
    stealResist: 0,
    dodge: 0,
    killGold: fromInt(2),
    killWood: 100,
    splitOnDeath: 0,
    reviveOnce: false,
    boss: false,
    ...seed,
  };
}

export const M0_ENEMIES: EnemyDef[] = [
  enemy({ id: 'thug', name: '街头混混', armorType: 'light', speed: cells(2.0), baseHp: fromInt(40), baseWallet: fromInt(10), killGold: fromInt(2) }),
  enemy({ id: 'bat', name: '蝙蝠', armorType: 'light', flying: true, speed: cells(4.0), baseHp: fromInt(30), baseWallet: fromInt(11), killGold: fromInt(2.2) }),
  enemy({ id: 'brute', name: '重装打手', armorType: 'heavy', speed: cells(1.5), baseHp: fromInt(100), baseWallet: fromInt(13), killGold: fromInt(2.6) }),
  enemy({ id: 'armored_car', name: '装甲车', armorType: 'fortified', speed: cells(1.0), baseHp: fromInt(240), baseWallet: fromInt(20), killGold: fromInt(4) }),
  enemy({ id: 'assassin', name: '精英刺客', armorType: 'medium', speed: cells(4.2), baseHp: fromInt(60), baseWallet: fromInt(25), dodge: pct(0.15), killGold: fromInt(5) }),
  enemy({ id: 'merchant', name: '铁钱袋商人', armorType: 'heavy', speed: cells(2.5), baseHp: fromInt(80), baseWallet: fromInt(20), stealResist: pct(0.7), killGold: fromInt(4) }),
  enemy({ id: 'temple_guard', name: '圣殿守卫', armorType: 'divine', speed: cells(2.5), baseHp: fromInt(320), baseWallet: fromInt(30), killGold: fromInt(6) }),
  enemy({ id: 'boss_beast', name: 'BOSS 荒兽', armorType: 'fortified', speed: cells(1.2), baseHp: fromInt(1600), baseWallet: fromInt(300), killGold: fromInt(50), boss: true }),
  enemy({ id: 'boss_demon', name: 'BOSS 心魔', armorType: 'hero', speed: cells(2.5), baseHp: fromInt(1200), baseWallet: fromInt(250), killGold: fromInt(50), splitOnDeath: 2, boss: true }),
  enemy({ id: 'boss_reborn', name: 'BOSS 转生者', armorType: 'divine', speed: cells(2.5), baseHp: fromInt(1400), baseWallet: fromInt(350), killGold: fromInt(50), reviveOnce: true, boss: true }),
  enemy({ id: 'boss_ascendant', name: 'BOSS 飞升者', armorType: 'divine', flying: true, speed: cells(4.0), baseHp: fromInt(1000), baseWallet: fromInt(200), stealResist: pct(1.0), killGold: fromInt(50), boss: true }),
];

// ─────────────────────────────────────────────────────────────────────────────
// 全局常量（契约 §3.3 + 策划案 §4.3 / §4.8 / §5.1）
// ─────────────────────────────────────────────────────────────────────────────

/** 策划案 §4.3 标准克制矩阵（行 = 攻击类型，列 = 轻/中/重/城/神圣）。 */
export const M0_COUNTER_MATRIX: Fixed[][] = [
  // normal
  [pct(1.0), pct(1.5), pct(1.0), pct(0.7), pct(0.3)],
  // pierce
  [pct(2.0), pct(0.75), pct(1.0), pct(0.35), pct(0.3)],
  // magic
  [pct(1.25), pct(0.75), pct(1.5), pct(0.35), pct(0.5)],
  // siege
  [pct(1.0), pct(0.5), pct(1.0), pct(2.0), pct(0.3)],
  // chaos
  [pct(1.25), pct(1.25), pct(1.25), pct(1.25), pct(1.0)],
];

/** 策划案 §4.8 难度分级。 */
export const M0_DIFFICULTY: Record<'N1' | 'N2' | 'N3' | 'N4' | 'N5', DifficultyRow> = {
  N1: { hpMul: pct(0.6), walletMul: pct(1.4), crystalMul: pct(0.6), startGold: fromInt(3000), startWood: fromInt(2000), lives: 50, paths: 2, compressed: true },
  N2: { hpMul: pct(1.0), walletMul: pct(1.0), crystalMul: pct(1.0), startGold: fromInt(2000), startWood: fromInt(1500), lives: 30, paths: 2, compressed: true },
  N3: { hpMul: pct(1.6), walletMul: pct(0.9), crystalMul: pct(1.6), startGold: fromInt(1500), startWood: fromInt(1000), lives: 20, paths: 4, compressed: false },
  N4: { hpMul: pct(2.4), walletMul: pct(0.8), crystalMul: pct(2.4), startGold: fromInt(1000), startWood: fromInt(800), lives: 10, paths: 4, compressed: false },
  N5: { hpMul: pct(3.6), walletMul: pct(0.7), crystalMul: pct(3.6), startGold: fromInt(800), startWood: fromInt(500), lives: 5, paths: 4, compressed: false },
};

export const M0_CONSTANTS: SimConstants = {
  tickRate: 60,
  baseHp: fromInt(40),
  hpIndex: pct(1.38),
  baseWallet: fromInt(10),
  walletIndex: pct(1.29),
  enemyCountBase: pct(6),
  enemyCountSlope: pct(0.8),
  levelMul: [pct(1.0), pct(1.35), pct(1.85), pct(2.6), pct(3.8)],
  stealAtkCoef: 20, // (1 + 0.02 × 攻击力) —— 20 千分比 = 0.02
  critRateBase: pct(0.05),
  critRateCap: pct(0.3),
  critMulBase: pct(1.5),
  critMulPerLevel: pct(0.25),
  critMulCap: pct(2.75),
  counterMatrixStandard: M0_COUNTER_MATRIX,
  compressedFactor: pct(0.5),
  compressedFloor: pct(0.6),
  // 契约 §3.3 只定义了 5 列矩阵，策划案 §4.5.2 的「英雄甲」没有对应列。
  // M0 的临时策略：英雄甲按神圣甲取列（已在汇报中请主策划裁决）。
  armorAlias: { hero: 'divine' },
  haltPointStopDuration: sec(0.6),
  salaryCooldown: sec(90),
  salaryMultiplier: pct(60),
  brambleCooldown: sec(120),
  brambleDuration: sec(3),
  midasCooldown: sec(20),
  midasThreshold: pct(0.15),
  baseIncomePerSec: fromInt(2),
  populationCap: 40,
  buildDepth: 2,
  startWave: 1,
  totalWaves: 30,
  killRewardWaveScale: pct(1.0),
  techArchiveFreeLevelDivisor: 2,
  techArchiveCostReductionPct: 80,
  difficulty: M0_DIFFICULTY,
};

// ─────────────────────────────────────────────────────────────────────────────
// 科技（M0 合成夹具：数值取自契约 §14.2 的**裁决值**，让引擎侧可测）
// ⚠️ 真实科技表是 `src/data/tech.json`（data-arch 所有）；这里只是给
//    `createWorld(cfg)`（冻结签名）一份能跑科技的默认内容。
// ─────────────────────────────────────────────────────────────────────────────

function tech(
  id: string,
  name: string,
  target: TechTarget,
  effectPerLevel: Fixed,
  effectMode: 'add' | 'mul',
  effectUnit: 'permille' | 'count',
  costs: Array<[number, number]>,
  archivable = true,
): TechDef {
  return {
    id,
    name,
    maxLevel: costs.length,
    effectPerLevel,
    effectUnit,
    effectMode,
    // 契约 §14.20：作用目标由**数据**给出（引擎不再靠 id 猜）
    target,
    costPerLevel: costs.map(([gold, wood]) => ({ gold: fromInt(gold), wood: fromInt(wood) })),
    archivable,
  };
}

/**
 * 8 条科技线。**乘法四条**（契约 §14.2 的结构性修复）：
 * 攻击 ×1.50/级、攻速 ×1.40/级、射程 ×1.10/级、窃金 ×1.12/级；
 * **加法两条**（保持加法且有上限）：暴击率 +5%/级、暴击效率 +25%/级。
 * 造价沿用策划案 §4.4.1 的逐级表（金 / 木）。
 */
export const M0_TECH: TechTable = {
  attack: tech('attack', '攻击强化', 'attack', 1500, 'mul', 'permille', [
    [1000, 100],
    [2200, 220],
    [4500, 450],
    [10000, 1000],
    [19000, 1900],
  ]),
  attack_speed: tech('attack_speed', '攻速强化', 'speed', 1400, 'mul', 'permille', [
    [1000, 100],
    [2200, 220],
    [4500, 450],
    [10000, 1000],
    [19000, 1900],
  ]),
  range: tech('range', '射程强化', 'range', 1100, 'mul', 'permille', [
    [800, 80],
    [1600, 160],
    [3600, 360],
    [8000, 800],
    [15000, 1500],
  ]),
  steal_efficiency: tech('steal_efficiency', '窃金效率', 'steal', 1120, 'mul', 'permille', [
    [1200, 120],
    [2800, 280],
    [5600, 560],
    [11000, 1100],
    [22000, 2200],
  ]),
  steal_crit_rate: tech('steal_crit_rate', '窃金暴击率', 'critRate', 50, 'add', 'permille', [
    [1400, 140],
    [3000, 300],
    [6100, 610],
    [13000, 1300],
    [25000, 2500],
  ]),
  steal_crit_mul: tech('steal_crit_mul', '窃金暴击效率', 'critMul', 250, 'add', 'permille', [
    [1400, 140],
    [3000, 300],
    [6100, 610],
    [13000, 1300],
    [25000, 2500],
  ]),
  population: tech('population', '人口上限', 'population', 2, 'add', 'count', [
    [700, 70],
    [1300, 130],
    [2900, 290],
    [7000, 700],
    [12800, 1280],
  ]),
  base_level: tech('base_level', '基地等级', 'baseLevel', 80, 'add', 'permille', [
    [1500, 0],
    [3000, 0],
    [6000, 0],
    [12000, 0],
    [24000, 0],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// 地图与路径（策划案 §4.6：4 路，约 40 格，每路中段 1 个 ★停顿点）
// ─────────────────────────────────────────────────────────────────────────────

export const M0_GRID: GridDef = { width: 48, height: 33, vault: { x: 22, y: 14, w: 5, h: 5 } };

/** 由扁平格坐标数组构造路径：`[x0,y0, x1,y1, ...]`。 */
function path(id: number, haltIndex: number, flat: number[]): PathDef {
  const waypoints: { x: Fixed; y: Fixed }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    waypoints.push({ x: cells(flat[i] as number), y: cells(flat[i + 1] as number) });
  }
  return { id, haltIndex, waypoints };
}

/**
 * 4 条路径（A/B/C/D），长度 33–39 格，与策划案 §4.6「约 40 格」同量级。
 * haltIndex = 2 → 中段那个拐点是 ★停顿点。
 * 入口分别为左上 / 右上 / 左下 / 右下，全部汇入中央宝库 (22,14)–(26,18)。
 */
export const M0_PATHS: PathDef[] = [
  path(0, 2, [3, 1, 3, 10, 18, 10, 18, 16, 24, 16]),
  path(1, 2, [45, 1, 45, 10, 30, 10, 30, 16, 24, 16]),
  path(2, 2, [3, 31, 3, 22, 18, 22, 18, 14, 24, 14]),
  path(3, 2, [45, 31, 45, 22, 30, 22, 30, 18, 24, 18]),
];

// ─────────────────────────────────────────────────────────────────────────────
// 波次（M0 教学 3 波；30 波真实数据是 data-arch 的 src/data/waves.json）
// ─────────────────────────────────────────────────────────────────────────────

export const M0_WAVES: WaveDef[] = [
  { wave: 1, prepTime: sec(15), groups: [{ enemy: 'thug', count: 6, interval: sec(0.8), delay: 0 }], rewardGold: fromInt(0), rewardWood: 0, hint: '认识窃金：把神偷放在 ★停顿点旁' },
  { wave: 2, prepTime: sec(15), groups: [{ enemy: 'thug', count: 8, interval: sec(0.8), delay: 0 }, { enemy: 'bat', count: 2, interval: sec(1.5), delay: sec(4) }], rewardGold: fromInt(0), rewardWood: 0, hint: '空中威胁：弓箭系可打飞行' },
  { wave: 3, prepTime: sec(15), groups: [{ enemy: 'thug', count: 10, interval: sec(0.7), delay: 0 }, { enemy: 'brute', count: 2, interval: sec(3), delay: sec(5) }], rewardGold: fromInt(0), rewardWood: 0, hint: '护甲分化：重甲用魔法/普通' },
];

/** M0 合成夹具完整内容（`createWorld(cfg)` 的默认注入源）。 */
export function createM0FallbackContent(): SimContent {
  const units: Record<string, UnitDef> = {};
  for (const u of M0_UNITS) units[u.id] = u;
  const enemies: Record<string, EnemyDef> = {};
  for (const e of M0_ENEMIES) enemies[e.id] = e;
  return {
    label: 'M0 synthetic fixture (engine-dev)',
    synthetic: true,
    units,
    enemies,
    waves: M0_WAVES,
    constants: M0_CONSTANTS,
    paths: M0_PATHS,
    grid: M0_GRID,
    tech: M0_TECH,
  };
}

/** tick ↔ 秒 的换算（普通整数 tick；契约 §4.1 固定 1/60 秒）。 */
export function secondsToTicks(s: Fixed, tickRate: number): number {
  // 与 tick.ts 的实现一致：truncDiv(s * tickRate, 1000)
  return truncDiv(s * tickRate, FIXED_SCALE);
}
