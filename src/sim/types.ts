/**
 * 模拟层公开类型 —— 接口契约 §4（`types.ts`）+ §7（只读快照契约）
 *
 * `Vec2` / `RunConfig` 的字段与契约 §4 **逐字一致**，不得改名。
 * `WorldState` / `WorldSnapshot` 的具体形状由 engine-dev 设计（契约 §4 留白），
 * 但必须满足契约 §7 的「快照必须提供」清单（下方逐条对照）。
 */
import type { Fixed } from './fixed';
import type { Rng } from './rng';
import type {
  ArmorType,
  AttackType,
  AuraDef,
  EnemyDef,
  GridDef,
  PathDef,
  SimConstants,
  SimContent,
  UnitDef,
  WaveDef,
  WaveGroupDef,
} from './content';
import type { SimEvent, WaveStats } from './events';
import type { TechEffects, TechView } from './tech';

export interface Vec2 {
  x: Fixed;
  y: Fixed;
}

export interface RunConfig {
  seed: number; // 可播种 RNG 种子
  difficultyId: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  relics: Readonly<Record<string, number>>; // 圣物 id → 等级
  techArchive: Readonly<Record<string, number>>; // 科技 id → 存档等级
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部可变状态（仅 src/sim/** 内部可直接改字段 —— 铁律 7）
// ─────────────────────────────────────────────────────────────────────────────

/** 单元格坐标（格，普通整数）。 */
export interface Cell {
  x: number;
  y: number;
}

export interface TowerState {
  id: number;
  unitId: string;
  /** 等级 1..5（普通整数） */
  tier: number;
  cell: Cell;
  /** 格中心，定点 */
  pos: Vec2;
  def: UnitDef;
  /** 面板攻击（含光环乘区），定点 */
  attack: Fixed;
  /** 基础攻击（def/等级），定点 */
  baseAttack: Fixed;
  /** 射程（含光环加成），定点 */
  range: Fixed;
  baseRange: Fixed;
  /** 攻击间隔（秒，定点）—— 仅用于显示与快照 */
  attackInterval: Fixed;
  /** 攻击间隔换算成 tick（普通整数）—— 热路径用它，见 tick.ts 的说明 */
  intervalTicks: number;
  /** 未受光环影响的基础间隔 tick（普通整数） */
  baseIntervalTicks: number;
  /** 剩余冷却（tick，普通整数） */
  cooldownTicks: number;
  /** 攻速乘区（千分比，含光环） */
  intervalMul: Fixed;
  targetId: number; // -1 = 无
  totalStolen: Fixed;
  block: number; // 阻挡名额（普通整数）
  blockRange: Fixed;
  blockUsed: number; // 每 tick 重置
  slowWhileBlocked: Fixed;
  sellsFor: Fixed;
  /** 累计投入金币（用于出售返还） */
  spentGold: Fixed;
  multiShot: number;
  splash: Fixed;
  projectileSpeed: Fixed;
  isSteal: boolean;
  stealBonus: Fixed;
  /** 允许免费重新部署（策划案 §4.2.1 飞贼 T5「瞬移」） */
  canRelocate: boolean;
  /** 光环列表（契约 §14.10 数组化）；空数组 = 无光环 */
  auras: AuraDef[];
  /** 木材产出累计器（单位：定点/秒 的分数部分，保证不漂移） */
  woodAccum: number;
  /** 所在路径（用于 relocate 校验与光环报告） */
  pathIndex: number;
  /** 建成的 tick（撤销窗口用） */
  builtTick: number;
  /** 反向光环叠加后的最终值（供快照/UI 直接读） */
  auraReceived: { attack: Fixed; attackSpeed: Fixed; range: Fixed };
  /** 窃金效率光环乘区（千分比，1000 = 无加成；训导主任「周围神偷 +20%」） */
  stealAuraMul: Fixed;
}

export interface EnemyState {
  id: number;
  defId: string;
  def: EnemyDef;
  pathIndex: number;
  /** 当前所在线段下标（普通整数） */
  segIndex: number;
  pos: Vec2;
  /** 移动余数（单位：定点/60 的分数部分，保证不漂移） */
  moveRemainder: number;
  hp: Fixed;
  hpMax: Fixed;
  walletRemaining: Fixed;
  walletMax: Fixed;
  /** 基础移速，格/秒，定点 */
  speed: Fixed;
  /** 当前移速乘区（千分比）。软减速取最小值，列阵再取最小 */
  speedMul: Fixed;
  /** ★停顿点是否已触发 */
  haltDone: boolean;
  /** 剩余硬停顿 tick（荆棘丛林 / ★停顿点），普通整数 */
  haltTicksLeft: number;
  /** 软减速到期 tick */
  slowUntilTick: number;
  /** 命中时施加的软减速乘区（千分比）。仅当 slowUntilTick > tick 时生效 */
  slowMulFromHit: Fixed;
  /** 光环软减速乘区（千分比），每 tick 由光环系统重算 */
  slowAuraMul: Fixed;
  armorType: ArmorType;
  flying: boolean;
  stealResist: Fixed;
  dodge: Fixed;
  blockedBy: number | null;
  /** 被阻挡时由训导主任「罚站」带来的窃金抗性削减（千分比），每 tick 重算 */
  blockedResistReduce: Fixed;
  /** 光环带来的窃金抗性削减（千分比；`stealResistDebuff`），每 tick 重算 */
  auraResistReduce: Fixed;
  alive: boolean;
  /** 是否已经复活过（转生者） */
  revived: boolean;
  /**
   * 死亡时是否允许分裂（契约 §14.12）。
   * 原生敌人 = `def.splitOnDeath > 0`；**分裂出来的分身一律 false**（一代即止）。
   */
  canSplit: boolean;
  spawnedTick: number;
  /** 该敌人身上被窃取过的总额（用于报告） */
  stolenFrom: Fixed;
  /** 由于阻挡而产生的额外窃取（契约 §6.1） */
  blockExtra: Fixed;
}

export interface ProjectileState {
  slot: number;
  /** 递增序号，用于「池满时复用最旧」 */
  seq: number;
  active: boolean;
  ownerTowerId: number;
  targetEnemyId: number;
  pos: Vec2;
  speed: Fixed;
  damage: Fixed;
  attackType: AttackType;
  splash: Fixed;
  isSteal: boolean;
  /** 存活 tick 上限（防止目标丢失后永久占用槽位） */
  ttlTicks: number;
}

/** 一个待生成的敌人（波次展开后的扁平队列）。 */
export interface SpawnEntry {
  /** 相对本波开始的 tick 偏移（普通整数） */
  tickOffset: number;
  enemyId: string;
  pathIndex: number;
  groupIndex: number;
  indexInGroup: number;
}

export type WorldStatus = 'running' | 'won' | 'lost' | 'ascended';
export type WavePhase = 'prep' | 'combat' | 'done';

/** 本波统计累加器（契约 §6.1 的唯一数据源）。 */
export interface WaveStatsAccumulator {
  wave: number;
  goldEarned: Fixed;
  goldSpent: Fixed;
  stolenTotal: Fixed;
  walletTotal: Fixed;
  blockExtraSteal: Fixed;
  leaks: number;
}

export interface SkillState {
  salaryReadyTick: number;
  brambleReadyTick: number;
  midasReadyTick: number;
  brambleUntilTick: number;
}

export interface LastBuildRecord {
  towerId: number;
  tick: number;
  spentGold: Fixed;
  spentWood: Fixed;
  unitId: string;
}

/** 可变世界状态。仅在 src/sim/** 内部可直接改字段。 */
export interface WorldState {
  content: SimContent;
  cfg: RunConfig;
  grid: GridDef;
  paths: PathDef[];
  /** 单元格占用表：key = y * width + x → towerId（普通整数） */
  occupancy: Map<number, number>;
  /** 路径经过的单元格 key 集合（建图时算好，只读） */
  pathCells: Set<number>;
  /** 可建造单元格 key 集合（建图时算好，只读） */
  buildableCells: Set<number>;
  /**
   * 可直接建造的「根单位」id 集合（契约 §14.7）。
   * 判定：**没有任何单位的 `upgradeTo` 指向它**。非根单位只能由升级链到达。
   */
  buildableRoots: Set<string>;
  /** 上升级链查询：unitId → 它的父级（谁会升级成它），用于错误提示 */
  upgradeParentOf: Map<string, string>;

  // —— 科技（契约 §14.2）——
  /** 各科技线当前等级（普通整数） */
  techLevels: Record<string, number>;
  /** 存档等级（来自 RunConfig.techArchive，用于免费等级与造价折扣） */
  techArchiveLevels: Record<string, number>;
  /** 由 techLevels 算出的乘法/加法效果（研究后重算） */
  tech: TechEffects;
  /** 科技累计投入（定点，用于报告） */
  techSpentGold: Fixed;
  techSpentWood: Fixed;
  /** 本局研究次数（普通整数） */
  techResearched: number;

  /** 已前进的 tick 数（普通整数）。tick=0 表示尚未 step 过 */
  tick: number;
  rng: Rng;

  // —— 资源（契约 §7：金币/木材走定点，契约 §2）——
  gold: Fixed;
  wood: Fixed;
  lives: number;
  population: number;
  populationCap: number;

  // —— 波次 ——
  wave: number;
  waveTotal: number;
  phase: WavePhase;
  prepTicksLeft: number;
  spawnQueue: SpawnEntry[];
  spawnCursor: number;
  waveStartTick: number;

  // —— 累计 ——
  stolenTotal: Fixed;
  killGoldTotal: Fixed;
  spentTotal: Fixed;
  earnedTotal: Fixed;
  /** 小精灵采木累计（定点，用于报告） */
  woodMinedTotal: Fixed;
  killed: number;
  leaked: number;
  spawnedTotal: number;
  enemiesSpawnedThisWave: number;

  towers: TowerState[];
  enemies: EnemyState[];
  /** 塔 id → 状态（O(1) 查找；热路径用，避免线性扫描） */
  towerIndex: Map<number, TowerState>;
  /** 索敌用的可复用临时数组（避免每 tick 为每座塔分配数组） */
  targetScratch: EnemyState[];
  /** 固定容量投射物池（契约/策划案 §8.5：500） */
  projectiles: ProjectileState[];
  projectileFreeList: number[];
  projectileSeq: number;

  nextTowerId: number;
  nextEnemyId: number;
  /** 敌人 id → 状态（O(1) 投射物索敌；生成/移除时维护） */
  enemyIndex: Map<number, EnemyState>;

  /** 本 tick 产生的事件（drainEvents 取出后清空） */
  eventQueue: SimEvent[];
  waveAcc: WaveStatsAccumulator;
  lastBuild: LastBuildRecord | null;
  skills: SkillState;

  status: WorldStatus;
  speed: 1 | 2 | 4;
  paused: boolean;

  /** 峰值统计（基准报告用） */
  peakActiveProjectiles: number;
  peakAliveEnemies: number;

  /** 复用的快照对象（避免每帧分配 —— 铁律 7） */
  _snapshot: WorldSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 只读快照（契约 §7）
// ─────────────────────────────────────────────────────────────────────────────

/** 敌人视图：契约 §7「敌人钱包进度条」所需字段。 */
export interface EnemyView {
  id: number;
  defId: string;
  pos: Vec2;
  hp: Fixed;
  hpMax: Fixed;
  walletRemaining: Fixed;
  walletMax: Fixed;
  armorType: ArmorType;
  flying: boolean;
  blockedBy: number | null;
  speedMul: Fixed;
  pathIndex: number;
  segIndex: number;
  reachedVault: boolean;
}

/** 塔视图：契约 §7「单位详情」所需字段（含模拟层算好的 stealPerSecond）。 */
export interface TowerView {
  id: number;
  unitId: string;
  tier: number;
  cell: Cell;
  pos: Vec2;
  range: Fixed;
  attack: Fixed;
  attackInterval: Fixed;
  /** 由模拟层算好（契约 §7 明确要求，不要让 UI 自己推公式） */
  stealPerSecond: Fixed;
  totalStolen: Fixed;
  block: number;
  blockUsed: number;
  blockRange: Fixed;
  cooldownTicks: number;
  targetId: number;
}

/** 投射物视图（渲染层需要）。 */
export interface ProjectileView {
  id: number;
  pos: Vec2;
  targetId: number;
  ownerTowerId: number;
}

export interface SkillView {
  id: 'salary' | 'bramble' | 'midas';
  ready: boolean;
  cooldownLeft: Fixed;
  active: boolean;
}

export interface NextWaveGroupView {
  enemy: string;
  name: string;
  count: number;
  armorType: ArmorType;
  flying: boolean;
}

export interface NextWaveView {
  wave: number;
  groups: NextWaveGroupView[];
  hint: string;
}/**
 * 只读视图。render / ui / balance 只能通过它读状态。
 *
 * ⚠️ **对象与数组会被 `snapshot()` 复用**（铁律 7：250 敌人 × 60fps 下纯不可变
 * 会产生严重 GC 压力）。调用方**不得跨帧持有**。需要持久化请用
 * `deepCopySnapshot()`。
 */
export interface WorldSnapshot {
  readonly reused: true;
  tick: number;
  gold: Fixed;
  wood: Fixed;
  population: number;
  populationCap: number;
  lives: number;
  wave: number;
  waveTotal: number;
  phase: WavePhase;
  prepTicksLeft: number;
  status: WorldStatus;
  speed: 1 | 2 | 4;
  paused: boolean;
  stolenTotal: Fixed;
  killed: number;
  leaked: number;
  towers: TowerView[];
  enemies: EnemyView[];
  projectiles: ProjectileView[];
  nextWave: NextWaveView | null;
  skills: SkillView[];
  /** 科技视图（契约 §14.2：UI 要能显示等级/下一级造价/是否可研究） */
  techs: TechView[];
  /** 当前生效的科技乘区摘要（UI 详情面板用） */
  techEffects: {
    attackMul: Fixed;
    attackSpeedMul: Fixed;
    rangeMul: Fixed;
    stealMul: Fixed;
    woodMul: Fixed;
    critRateAdd: Fixed;
    critMulAdd: Fixed;
    populationAdd: number;
  };
  /** 引擎不认识的科技 id（效果未生效，UI 必须能提示"未实装"） */
  unimplementedTechIds: string[];
  /**
   * 靠**旧 id 表**（数据缺 `target`）解析出作用的科技 id —— 契约 §14.20 落地后应为空。
   * 非空即代表数据尚未迁移；暴露出来是为了**不静默**。
   */
  legacyTechTargetIds: string[];
  /** 上一 tick 结束时的本波统计（waveEnd 事件里也有同样一份） */
  currentWaveStats: WaveStats;
}

export type { ArmorType, AttackType, UnitDef, EnemyDef, SimContent, GridDef, PathDef, WaveDef, WaveGroupDef, SimConstants, WaveStats, SimEvent };
