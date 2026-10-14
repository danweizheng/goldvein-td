/**
 * 世界构造 / 只读快照 / 确定性哈希 —— 接口契约 §4、§7
 *
 * 契约冻结签名（不得改名/改参）：
 *   createWorld(cfg: RunConfig): WorldState
 *   snapshot(w: WorldState): WorldSnapshot
 *   hashWorld(w: WorldState): string
 *
 * `createWorld` 只接受冻结的 `RunConfig`。M0 的内容注入走**额外的**函数
 * `createWorldWithContent(cfg, content)` —— 它是对冻结签名的**扩展**而不是修改，
 * `createWorld` 自身保持契约形状（内部注入 M0 合成夹具）。M1 接真实数据时
 * 只改 `createWorld` 的注入源，不改签名。
 */
import { FIXED_SCALE, fmul, mulDiv, truncDiv, type Fixed } from './fixed';
import { createRng } from './rng';
import { M0_CONSTANTS, M0_GRID, M0_PATHS, M0_WAVES, createM0FallbackContent } from './m0-fixture';
import {
  computeTechEffects,
  freeLevelFromArchive,
  neutralTechEffects,
  researchCost,
  requiresSatisfied,
  techView,
  type TechEffects,
  type TechView,
} from './tech';
import {
  armorIndex,
  attackIndex,
  type ArmorType,
  type AttackType,
  type SimConstants,
  type SimContent,
  type UnitDef,
} from './content';
import type {
  Cell,
  EnemyState,
  EnemyView,
  ProjectileState,
  ProjectileView,
  RunConfig,
  SkillView,
  TowerState,
  TowerView,
  Vec2,
  WaveStatsAccumulator,
  WorldSnapshot,
  WorldState,
} from './types';
import type { WaveStats } from './events';

// ─────────────────────────────────────────────────────────────────────────────
// 几何工具（全整数，无浮点）
// ─────────────────────────────────────────────────────────────────────────────

/** 定点位置 → 单元格（格，普通整数）。 */
export function cellOf(pos: Vec2): Cell {
  return { x: Math.floor(pos.x / FIXED_SCALE), y: Math.floor(pos.y / FIXED_SCALE) };
}

/** 单元格 → 格中心（定点）。 */
export function cellCenter(cell: Cell): Vec2 {
  return { x: cell.x * FIXED_SCALE + 500, y: cell.y * FIXED_SCALE + 500 };
}

export function cellKey(width: number, x: number, y: number): number {
  return y * width + x;
}

/** 距离平方（单位：格² × 1e6）。比较距离时用它，**不开根**，保持整数。 */
export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 整数平方根（牛顿迭代，全整数）。用于投射物朝向归一化。 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  let y = truncDiv(x + 1, 2);
  while (y < x) {
    x = y;
    y = truncDiv(x + truncDiv(n, x), 2);
  }
  return x;
}

/** 格子是否落在宝库矩形内。 */
function inVault(content: SimContent, x: number, y: number): boolean {
  const v = content.grid.vault;
  return x >= v.x && x < v.x + v.w && y >= v.y && y < v.y + v.h;
}

/** 把路径折线栅格化成单元格集合（0.25 格步进）。 */
export function rasterizePathCells(content: SimContent): Set<number> {
  const cells = new Set<number>();
  const { width } = content.grid;
  const step = 250; // 0.25 格（定点）
  for (const path of content.paths) {
    for (let i = 0; i + 1 < path.waypoints.length; i++) {
      const a = path.waypoints[i] as Vec2;
      const b = path.waypoints[i + 1] as Vec2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = isqrt(dx * dx + dy * dy);
      const steps = Math.max(1, truncDiv(len * 4, 1000)); // 每 0.25 格一个采样
      for (let s = 0; s <= steps; s++) {
        const t = truncDiv(s * FIXED_SCALE, steps);
        const x = a.x + fmul(dx, t);
        const y = a.y + fmul(dy, t);
        cells.add(cellKey(width, Math.floor(x / FIXED_SCALE), Math.floor(y / FIXED_SCALE)));
      }
    }
  }
  return cells;
}

/** 可建造区：路径格 + 宝库之外的、且距路径 ≤ buildDepth 格的格子。 */
export function computeBuildableCells(content: SimContent, pathCells: Set<number>): Set<number> {
  const buildable = new Set<number>();
  const { width, height } = content.grid;
  const depth = content.constants.buildDepth;
  for (const key of pathCells) {
    const px = key % width;
    const py = truncDiv(key - px, width);
    for (let dy = -depth; dy <= depth; dy++) {
      for (let dx = -depth; dx <= depth; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (inVault(content, x, y)) continue;
        const k = cellKey(width, x, y);
        if (pathCells.has(k)) continue;
        buildable.add(k);
      }
    }
  }
  return buildable;
}

// ─────────────────────────────────────────────────────────────────────────────
// 世界构造
// ─────────────────────────────────────────────────────────────────────────────

/** 投射物池容量（策划案 §8.5：500）。 */
export const PROJECTILE_POOL_SIZE = 500;

function createProjectilePool(size: number): ProjectileState[] {
  const pool: ProjectileState[] = [];
  for (let i = 0; i < size; i++) {
    pool.push({
      slot: i,
      seq: -1,
      active: false,
      ownerTowerId: -1,
      targetEnemyId: -1,
      pos: { x: 0, y: 0 },
      speed: 0,
      damage: 0,
      attackType: 'normal',
      splash: 0,
      isSteal: false,
      ttlTicks: 0,
    });
  }
  return pool;
}

function createEmptySnapshot(): WorldSnapshot {
  return {
    reused: true,
    tick: 0,
    gold: 0,
    wood: 0,
    population: 0,
    populationCap: 0,
    lives: 0,
    wave: 0,
    waveTotal: 0,
    phase: 'prep',
    prepTicksLeft: 0,
    status: 'running',
    speed: 1,
    paused: false,
    stolenTotal: 0,
    killed: 0,
    leaked: 0,
    towers: [],
    enemies: [],
    projectiles: [],
    nextWave: null,
    skills: [],
    techs: [],
    techEffects: {
      attackMul: 1000,
      attackSpeedMul: 1000,
      rangeMul: 1000,
      stealMul: 1000,
      woodMul: 1000,
      critRateAdd: 0,
      critMulAdd: 0,
      populationAdd: 0,
    },
    unimplementedTechIds: [],
    legacyTechTargetIds: [],
    currentWaveStats: {
      wave: 0,
      goldEarned: 0,
      goldSpent: 0,
      stolenTotal: 0,
      walletTotal: 0,
      stealCoverage: 0,
      blockExtraSteal: 0,
      leaks: 0,
      towerCount: 0,
    },
  };
}

/**
 * 用指定内容创建世界（M1 真实数据入口；M0 由 tools/bench/fixture.ts 注入合成夹具）。
 */
export function createWorldWithContent(cfg: RunConfig, content: SimContent): WorldState {
  const diff = content.constants.difficulty[cfg.difficultyId];
  const pathCells = rasterizePathCells(content);
  const buildableCells = computeBuildableCells(content, pathCells);

  // —— 契约 §14.7：算出「根单位」集合（没有任何单位的 upgradeTo 指向它）——
  const upgradeParentOf = new Map<string, string>();
  for (const u of Object.values(content.units)) {
    if (u.upgradeTo !== null && content.units[u.upgradeTo] !== undefined) {
      if (!upgradeParentOf.has(u.upgradeTo)) upgradeParentOf.set(u.upgradeTo, u.id);
    }
  }
  const buildableRoots = new Set<string>();
  for (const id of Object.keys(content.units)) {
    if (!upgradeParentOf.has(id)) buildableRoots.add(id);
  }

  // —— 契约 §14.2 / §4.4.2：存档继承的免费等级 + 科技效果 ——
  const techArchiveLevels: Record<string, number> = {};
  const techLevels: Record<string, number> = {};
  if (content.tech) {
    const divisor = content.constants.techArchiveFreeLevelDivisor ?? 2;
    for (const [id, def] of Object.entries(content.tech)) {
      const archived = Math.max(0, cfg.techArchive[id] ?? 0);
      techArchiveLevels[id] = archived;
      techLevels[id] = def.archivable ? freeLevelFromArchive(archived, divisor, def.maxLevel) : 0;
    }
  }
  const tech: TechEffects = computeTechEffects(content.tech, techLevels);

  const waveAcc: WaveStatsAccumulator = {
    wave: content.constants.startWave,
    goldEarned: 0,
    goldSpent: 0,
    stolenTotal: 0,
    walletTotal: 0,
    blockExtraSteal: 0,
    leaks: 0,
  };

  const w: WorldState = {
    content,
    cfg,
    grid: content.grid,
    paths: content.paths,
    occupancy: new Map<number, number>(),
    pathCells,
    buildableCells,
    buildableRoots,
    upgradeParentOf,
    techLevels,
    techArchiveLevels,
    tech,
    techSpentGold: 0,
    techSpentWood: 0,
    techResearched: 0,
    tick: 0,
    rng: createRng(cfg.seed),
    gold: diff.startGold,
    wood: diff.startWood,
    lives: diff.lives,
    population: 0,
    // 科技「人口上限」加项（契约 §14.2 的 population 线）
    populationCap: content.constants.populationCap + tech.populationAdd,
    wave: content.constants.startWave,
    waveTotal: content.constants.totalWaves,
    phase: 'prep',
    prepTicksLeft: ticksFromSeconds(content.waves[0]?.prepTime ?? 15000, content.constants.tickRate),
    spawnQueue: [],
    spawnCursor: 0,
    waveStartTick: 0,
    stolenTotal: 0,
    killGoldTotal: 0,
    spentTotal: 0,
    earnedTotal: 0,
    woodMinedTotal: 0,
    killed: 0,
    leaked: 0,
    spawnedTotal: 0,
    enemiesSpawnedThisWave: 0,
    towers: [],
    enemies: [],
    enemyIndex: new Map<number, EnemyState>(),
    towerIndex: new Map<number, TowerState>(),
    targetScratch: [],
    projectiles: createProjectilePool(PROJECTILE_POOL_SIZE),
    projectileFreeList: [],
    projectileSeq: 0,
    nextTowerId: 1,
    nextEnemyId: 1,
    eventQueue: [],
    waveAcc,
    lastBuild: null,
    skills: { salaryReadyTick: 0, brambleReadyTick: 0, midasReadyTick: 0, brambleUntilTick: 0 },
    status: 'running',
    speed: 1,
    paused: false,
    peakActiveProjectiles: 0,
    peakAliveEnemies: 0,
    _snapshot: createEmptySnapshot(),
  };
  return w;
}

/**
 * 契约冻结签名。M0 内部注入 `src/sim/m0-fixture.ts` 的合成夹具
 * （**不是** `src/data/**` —— 契约 §4.2 禁止 M0 依赖它）。
 */
export function createWorld(cfg: RunConfig): WorldState {
  return createWorldWithContent(cfg, createM0FallbackContent());
}

/** 秒（定点）→ tick（普通整数）。契约 §4.1：固定 1/60 秒。 */
export function ticksFromSeconds(seconds: Fixed, tickRate: number): number {
  return truncDiv(seconds * tickRate, FIXED_SCALE);
}

/**
 * 暴击率（千分比）：**单位自身值优先**，缺省才用 `constants.critRateBase`。
 *
 * ⚠️ 契约 §3.3 同时给了 `critRateBase`(50 = 5%) 与单位表的 `critRate`，
 * 但没说两者如何合成。M0 采用「单位值覆盖全局默认」的读法；
 * 若主策划的本意是「全局基础 + 单位加成」，这里要改成相加。
 */
export function critRateOf(c: SimConstants, def: UnitDef, techAdd: Fixed = 0): Fixed {
  const base = def.critRate > 0 ? def.critRate : c.critRateBase;
  return Math.min(c.critRateCap, base + techAdd);
}

/**
 * 暴击倍率（千分比）：同样**单位自身值优先**，缺省用 `constants.critMulBase`。
 *
 * ⚠️ 策划案 §4.1.2 的 `CritMul = 1.5 + 0.25 × 暴击效率等级`：
 * **契约 §13.3 已裁决「暴击效率等级」= 窃金暴击效率科技线等级（0–5），不是塔的 tier。**
 * 所以这里只用单位基础值，科技加成由 `techAdd`（千分比加项，`critMulAdd`）传入。
 */
export function critMulOf(c: SimConstants, def: UnitDef, techAdd: Fixed = 0): Fixed {
  const base = def.critMul > 0 ? def.critMul : c.critMulBase;
  return Math.min(c.critMulCap, base + techAdd);
}

/**
 * 攻击/护甲克制倍率（千分比定点）。策划案 §4.3。
 *
 * N1/N2 走**压缩表**：`1 + (标准 − 1) × 0.5`，下限截断到 0.6；
 * N3+ 走标准表。英雄甲按 `armorAlias` 取列（契约 §3.3 只定义了 5 列）。
 */
export function counterMul(w: WorldState, atk: AttackType, armor: ArmorType): Fixed {
  const c = w.content.constants;
  const row = c.counterMatrixStandard[attackIndex(atk)];
  const col = armorIndex(armor, c.armorAlias);
  let mul = row?.[col] ?? FIXED_SCALE;
  const diff = c.difficulty[w.cfg.difficultyId];
  if (diff.compressed) {
    mul = FIXED_SCALE + fmul(mul - FIXED_SCALE, c.compressedFactor);
    if (mul < c.compressedFloor) mul = c.compressedFloor;
  }
  return mul;
}

/** 便捷：默认 M0 合成夹具的常量/路径/网格（仅供 tools 与测试使用）。 */
export const M0_SEEDS = { constants: M0_CONSTANTS, paths: M0_PATHS, grid: M0_GRID, waves: M0_WAVES };

// ─────────────────────────────────────────────────────────────────────────────
// 科技研究（契约 §14.2 + §4.4.2 存档继承）
// ─────────────────────────────────────────────────────────────────────────────

/** 研究结果：失败时给出可读原因（commandRejected 直接用）。 */
export interface ResearchResult {
  ok: boolean;
  reason?: string;
  goldSpent: Fixed;
  woodSpent: Fixed;
  level: number;
}

/**
 * 研究一级科技。**唯一的科技等级变更入口**（指令、AI、存档恢复都走它）。
 *
 * 造价含存档折扣：`base × (1 − 0.08 × 存档等级)`（§4.4.2）。
 */
export function researchTech(w: WorldState, techId: string): ResearchResult {
  const table = w.content.tech;
  const def = table?.[techId];
  if (!def) return { ok: false, reason: `未知科技 ${techId}`, goldSpent: 0, woodSpent: 0, level: 0 };

  const level = w.techLevels[techId] ?? 0;
  if (level >= def.maxLevel) {
    return { ok: false, reason: `${def.name} 已满级（${def.maxLevel}）`, goldSpent: 0, woodSpent: 0, level };
  }
  if (!requiresSatisfied(def, w.techLevels)) {
    const missing = (def.requires ?? []).filter((r) => (w.techLevels[r] ?? 0) < 1);
    return { ok: false, reason: `${def.name} 需要前置科技：${missing.join(', ')}`, goldSpent: 0, woodSpent: 0, level };
  }

  const cost = researchCost(
    def,
    level + 1,
    w.techArchiveLevels[techId] ?? 0,
    w.content.constants.techArchiveCostReductionPct ?? 80,
  );
  if (w.gold < cost.gold) {
    return { ok: false, reason: `金币不足（需 ${cost.gold}，有 ${w.gold}）`, goldSpent: 0, woodSpent: 0, level };
  }
  if (w.wood < cost.wood) {
    return { ok: false, reason: `木材不足（需 ${cost.wood}，有 ${w.wood}）`, goldSpent: 0, woodSpent: 0, level };
  }

  w.gold -= cost.gold;
  w.wood -= cost.wood;
  w.techLevels[techId] = level + 1;
  w.techSpentGold += cost.gold;
  w.techSpentWood += cost.wood;
  w.techResearched++;
  w.spentTotal += cost.gold;
  w.waveAcc.goldSpent += cost.gold; // 契约 §6：goldSpent 含科技（建造 + 升级 + 科技）
  w.earnedTotal -= 0; // 保持语义显式：科技是支出，不进收入

  // 重算效果（人口上限是即时生效的：加项直接加到 cap）
  const prevPopAdd = w.tech.populationAdd;
  w.tech = computeTechEffects(table, w.techLevels);
  w.populationCap += w.tech.populationAdd - prevPopAdd;

  return { ok: true, goldSpent: cost.gold, woodSpent: cost.wood, level: level + 1 };
}

/**
 * 击杀奖励（契约 §14.6）：**按波次缩放**，占该敌人当波钱包的比率。
 *
 * 优先用 `killGoldRatio`；为 0 时从常量反推比率
 * （`ratio = killGold × 1000 / baseWallet`，正好是适配层
 * `killGold = baseWallet × bountyRatio.gold / 1000` 的逆运算，
 * 所以不需要适配层先改就能修好这个 bug）。
 */
export function killRewardOf(w: WorldState, e: EnemyState): { gold: Fixed; wood: Fixed } {
  const def = e.def;
  const goldRatio =
    (def.killGoldRatio ?? 0) > 0
      ? (def.killGoldRatio as Fixed)
      : def.baseWallet > 0
        ? mulDiv(def.killGold, FIXED_SCALE, def.baseWallet)
        : 0;
  const woodRatio =
    (def.killWoodRatio ?? 0) > 0
      ? (def.killWoodRatio as Fixed)
      : def.baseWallet > 0
        ? mulDiv(def.killWood, FIXED_SCALE, def.baseWallet)
        : 0;
  void w;
  return {
    gold: mulDiv(e.walletMax, goldRatio, FIXED_SCALE),
    wood: mulDiv(e.walletMax, woodRatio, FIXED_SCALE),
  };
}

/** 当前科技视图（单条，供外部工具/测试用）。 */
export function techViewOf(w: WorldState, techId: string): TechView | null {
  const def = w.content.tech?.[techId];
  if (!def) return null;
  return techView(
    def,
    w.techLevels[techId] ?? 0,
    w.techArchiveLevels[techId] ?? 0,
    w.gold,
    w.wood,
    w.content.constants,
    w.techLevels,
  );
}

/** 中性科技效果（无 tech 表时用；导出给 clone/测试）。 */
export { neutralTechEffects };

// ─────────────────────────────────────────────────────────────────────────────
// 快照
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算「窃金/秒」（契约 §7：必须由模拟层算好再给 UI）。
 *
 * 含暴击期望：`E[CritMul] = 1 + p × (critMul − 1)`。
 * 不含「钱包剩余」截断（那是运行时状态，不是塔的产能）。
 */
export function expectedStealPerSecond(w: WorldState, t: TowerState): Fixed {
  if (!t.isSteal || t.def.stealBase <= 0) return 0;
  const c = w.content.constants;
  const perHit = stealAmountCore(w, t, 0, false);
  if (perHit <= 0) return 0;
  const critRate = critRateOf(c, t.def, w.tech.critRateAdd);
  const critMul = critMulOf(c, t.def, w.tech.critMulAdd);
  const expectedMul = FIXED_SCALE + truncDiv(critRate * (critMul - FIXED_SCALE), FIXED_SCALE);
  const expected = mulDiv(perHit, expectedMul, FIXED_SCALE);
  return truncDiv(expected * c.tickRate, t.intervalTicks);
}

/**
 * 单次窃取量的**核心项**（不含「钱包剩余」截断）。
 *
 * 对应策划案 §4.1.2 / 契约 §6 伪代码：
 *   StealBase × LevelMul × (1+0.02×攻击力) × (1+科技) × (1+装备) × CritMul × (1−抗性)
 *
 * 乘法**逐次 ÷1000 取整，顺序与伪代码一致** —— 这个顺序是规格的一部分，
 * 改成一次性乘完会得到不同结果，不得擅自「优化」。
 *
 * 科技（契约 §14.2）走 `w.tech.stealMul`（×1.12/级 的乘法），光环走 `t.stealAuraMul`。
 */
export function stealAmountCore(w: WorldState, t: TowerState, resistAfterReduce: Fixed, crit: boolean): Fixed {
  if (!t.isSteal || t.def.stealBase <= 0) return 0;
  if (resistAfterReduce >= FIXED_SCALE) return 0;

  const c = w.content.constants;
  const levelMul = c.levelMul[t.tier - 1] ?? FIXED_SCALE;
  const atkBonus = FIXED_SCALE + mulDiv(c.stealAtkCoef, t.attack, FIXED_SCALE);
  const techBonus = w.tech.stealMul;
  const equipBonus = FIXED_SCALE + relicStealPct(w);
  const passiveBonus = FIXED_SCALE + t.stealBonus;
  const critMul = crit ? critMulOf(c, t.def, w.tech.critMulAdd) : FIXED_SCALE;
  const resistMul = Math.max(0, FIXED_SCALE - resistAfterReduce);

  let amount = t.def.stealBase;
  amount = fmul(amount, levelMul);
  amount = fmul(amount, atkBonus);
  amount = fmul(amount, techBonus);
  amount = fmul(amount, equipBonus);
  amount = fmul(amount, passiveBonus);
  amount = fmul(amount, t.stealAuraMul);
  amount = fmul(amount, critMul);
  amount = fmul(amount, resistMul);
  return amount;
}

/** 单次窃取量（含钱包截断）。策划案 §4.1.2 的 `min(剩余钱包, 计算值)`。 */
export function stealPerHit(w: WorldState, t: TowerState, e: EnemyState, crit: boolean): Fixed {
  const resist = e.stealResist - e.blockedResistReduce - e.auraResistReduce;
  return Math.min(stealAmountCore(w, t, resist, crit), e.walletRemaining);
}

/** 圣物「贪婪之手」窃金加成（千分比，§4.7.2：每级 +5%，上限 10 级）。 */
function relicStealPct(w: WorldState): Fixed {
  const lv = Math.min(10, w.cfg.relics['greedy_hand'] ?? 0);
  return 50 * lv;
}

/**
 * 只读快照。**复用同一个对象与数组**（铁律 7：避免每帧 750 个对象分配）。
 * 调用方不得跨帧持有；需要持久化请用 `deepCopySnapshot()`。
 */
export function snapshot(w: WorldState): WorldSnapshot {
  const s = w._snapshot;
  s.tick = w.tick;
  s.gold = w.gold;
  s.wood = w.wood;
  s.population = w.population;
  s.populationCap = w.populationCap;
  s.lives = w.lives;
  s.wave = w.wave;
  s.waveTotal = w.waveTotal;
  s.phase = w.phase;
  s.prepTicksLeft = w.prepTicksLeft;
  s.status = w.status;
  s.speed = w.speed;
  s.paused = w.paused;
  s.stolenTotal = w.stolenTotal;
  s.killed = w.killed;
  s.leaked = w.leaked;

  // —— 科技：视图数组同样复用对象；等级/造价变了就原地更新 ——
  const techDefs = w.content.tech;
  const views = s.techs;
  if (!techDefs) {
    if (views.length > 0) views.length = 0;
  } else {
    const ids = Object.keys(techDefs).sort();
    if (views.length > ids.length) views.length = ids.length;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const def = techDefs[id];
      if (!def) continue;
      const level = w.techLevels[id] ?? 0;
      const view = techView(
        def,
        level,
        w.techArchiveLevels[id] ?? 0,
        w.gold,
        w.wood,
        w.content.constants,
        w.techLevels,
      );
      const existing = views[i];
      if (existing === undefined) {
        views[i] = view;
      } else {
        existing.id = view.id;
        existing.name = view.name;
        existing.level = view.level;
        existing.maxLevel = view.maxLevel;
        existing.nextGold = view.nextGold;
        existing.nextWood = view.nextWood;
        existing.affordable = view.affordable;
        existing.unimplemented = view.unimplemented;
        if (existing.requires.length !== view.requires.length) existing.requires = view.requires;
        else for (let k = 0; k < view.requires.length; k++) existing.requires[k] = view.requires[k] as string;
      }
    }
  }
  const te = s.techEffects;
  te.attackMul = w.tech.attackMul;
  te.attackSpeedMul = w.tech.attackSpeedMul;
  te.rangeMul = w.tech.rangeMul;
  te.stealMul = w.tech.stealMul;
  te.woodMul = w.tech.woodMul;
  te.critRateAdd = w.tech.critRateAdd;
  te.critMulAdd = w.tech.critMulAdd;
  te.populationAdd = w.tech.populationAdd;
  const unimpl = s.unimplementedTechIds;
  unimpl.length = 0;
  for (const id of w.tech.unknownTechIds) unimpl.push(id);
  const legacy = s.legacyTechTargetIds;
  legacy.length = 0;
  for (const id of w.tech.legacyTargetIds) legacy.push(id);

  // —— 塔：复用 view 对象（热路径零分配）——
  const towers = s.towers;
  if (towers.length > w.towers.length) towers.length = w.towers.length;
  for (let i = 0; i < w.towers.length; i++) {
    const t = w.towers[i] as TowerState;
    let v = towers[i];
    if (v === undefined) {
      v = {
        id: t.id,
        unitId: t.unitId,
        tier: t.tier,
        cell: { x: t.cell.x, y: t.cell.y },
        pos: { x: t.pos.x, y: t.pos.y },
        range: t.range,
        attack: t.attack,
        attackInterval: t.attackInterval,
        stealPerSecond: 0,
        totalStolen: t.totalStolen,
        block: t.block,
        blockUsed: t.blockUsed,
        blockRange: t.blockRange,
        cooldownTicks: t.cooldownTicks,
        targetId: t.targetId,
      };
      towers[i] = v;
    } else {
      v.id = t.id;
      v.unitId = t.unitId;
      v.tier = t.tier;
      v.cell.x = t.cell.x;
      v.cell.y = t.cell.y;
      v.pos.x = t.pos.x;
      v.pos.y = t.pos.y;
      v.range = t.range;
      v.attack = t.attack;
      v.attackInterval = t.attackInterval;
      v.totalStolen = t.totalStolen;
      v.block = t.block;
      v.blockUsed = t.blockUsed;
      v.blockRange = t.blockRange;
      v.cooldownTicks = t.cooldownTicks;
      v.targetId = t.targetId;
    }
    v.stealPerSecond = expectedStealPerSecond(w, t);
  }

  // —— 敌人 ——
  const enemies = s.enemies;
  if (enemies.length > w.enemies.length) enemies.length = w.enemies.length;
  for (let i = 0; i < w.enemies.length; i++) {
    const e = w.enemies[i] as EnemyState;
    let v = enemies[i];
    if (v === undefined) {
      v = {
        id: e.id,
        defId: e.defId,
        pos: { x: e.pos.x, y: e.pos.y },
        hp: e.hp,
        hpMax: e.hpMax,
        walletRemaining: e.walletRemaining,
        walletMax: e.walletMax,
        armorType: e.armorType,
        flying: e.flying,
        blockedBy: e.blockedBy,
        speedMul: e.speedMul,
        pathIndex: e.pathIndex,
        segIndex: e.segIndex,
        reachedVault: false,
      };
      enemies[i] = v;
    } else {
      v.id = e.id;
      v.defId = e.defId;
      v.pos.x = e.pos.x;
      v.pos.y = e.pos.y;
      v.hp = e.hp;
      v.hpMax = e.hpMax;
      v.walletRemaining = e.walletRemaining;
      v.walletMax = e.walletMax;
      v.armorType = e.armorType;
      v.flying = e.flying;
      v.blockedBy = e.blockedBy;
      v.speedMul = e.speedMul;
      v.pathIndex = e.pathIndex;
      v.segIndex = e.segIndex;
    }
  }

  // —— 投射物（只暴露活动中的）——
  const projectiles = s.projectiles;
  let pc = 0;
  for (const p of w.projectiles) {
    if (!p.active) continue;
    let v = projectiles[pc];
    if (v === undefined) {
      v = { id: p.seq, pos: { x: p.pos.x, y: p.pos.y }, targetId: p.targetEnemyId, ownerTowerId: p.ownerTowerId };
      projectiles[pc] = v;
    } else {
      v.id = p.seq;
      v.pos.x = p.pos.x;
      v.pos.y = p.pos.y;
      v.targetId = p.targetEnemyId;
      v.ownerTowerId = p.ownerTowerId;
    }
    pc++;
  }
  if (projectiles.length > pc) projectiles.length = pc;

  // —— 下一波预告（波次号不变时不重建 groups，避免每帧分配）——
  const previewNumber = w.phase === 'combat' ? w.wave + 1 : w.wave;
  const nextWaveDef = findWave(w, previewNumber);
  if (!nextWaveDef) {
    s.nextWave = null;
  } else if (s.nextWave !== null && s.nextWave.wave === nextWaveDef.wave) {
    s.nextWave.hint = nextWaveDef.hint;
  } else {
    const groups = nextWaveDef.groups.map((g) => {
      const def = w.content.enemies[g.enemy];
      return {
        enemy: g.enemy,
        name: def?.name ?? g.enemy,
        count: g.count,
        armorType: def?.armorType ?? ('light' as const),
        flying: def?.flying ?? false,
      };
    });
    s.nextWave = { wave: nextWaveDef.wave, groups, hint: nextWaveDef.hint };
  }

  // —— 技能 ——
  const skills = s.skills;
  fillSkill(skills, 0, w, 'salary', w.skills.salaryReadyTick, false);
  fillSkill(skills, 1, w, 'bramble', w.skills.brambleReadyTick, w.tick < w.skills.brambleUntilTick);
  fillSkill(skills, 2, w, 'midas', w.skills.midasReadyTick, false);

  // —— 本波统计（原地改写）——
  const a = w.waveAcc;
  const cs = s.currentWaveStats;
  cs.wave = a.wave;
  cs.goldEarned = a.goldEarned;
  cs.goldSpent = a.goldSpent;
  cs.stolenTotal = a.stolenTotal;
  cs.walletTotal = a.walletTotal;
  cs.stealCoverage = a.walletTotal > 0 ? truncDiv(a.stolenTotal * FIXED_SCALE, a.walletTotal) : 0;
  cs.blockExtraSteal = a.blockExtraSteal;
  cs.leaks = a.leaks;
  cs.towerCount = w.towers.length;

  return s;
}

/** 原地写入技能视图（热路径零分配）。 */
function fillSkill(
  list: SkillView[],
  index: number,
  w: WorldState,
  id: SkillView['id'],
  readyTick: number,
  active: boolean,
): void {
  const leftTicks = Math.max(0, readyTick - w.tick);
  let v = list[index];
  if (v === undefined) {
    v = { id, ready: false, cooldownLeft: 0, active: false };
    list[index] = v;
  }
  v.id = id;
  v.ready = leftTicks === 0;
  v.active = active;
  // 剩余冷却（秒，定点）——用整数 tick 换算，避免浮点
  v.cooldownLeft = mulDiv(leftTicks, FIXED_SCALE, w.content.constants.tickRate);
}

/** 找到波次号对应的 WaveDef。 */
export function findWave(w: WorldState, wave: number) {
  for (const def of w.content.waves) {
    if (def.wave === wave) return def;
  }
  return null;
}

/** 由累加器生成契约 §6 的 `WaveStats`。 */
export function waveStatsOf(w: WorldState): WaveStats {
  const a = w.waveAcc;
  return {
    wave: a.wave,
    goldEarned: a.goldEarned,
    goldSpent: a.goldSpent,
    stolenTotal: a.stolenTotal,
    walletTotal: a.walletTotal,
    stealCoverage: a.walletTotal > 0 ? truncDiv(a.stolenTotal * FIXED_SCALE, a.walletTotal) : 0,
    blockExtraSteal: a.blockExtraSteal,
    leaks: a.leaks,
    towerCount: w.towers.length,
  };
}

/** 深拷贝快照（跨帧持有 / 落盘 / 断言用；有分配，别放热路径）。 */
export function deepCopySnapshot(w: WorldState): WorldSnapshot {
  const s = snapshot(w);
  const copy: WorldSnapshot = {
    ...createEmptySnapshot(),
    ...s,
    towers: s.towers.map((t) => ({ ...t, cell: { ...t.cell }, pos: { ...t.pos } })),
    enemies: s.enemies.map((e) => ({ ...e, pos: { ...e.pos } })),
    projectiles: s.projectiles.map((p) => ({ ...p, pos: { ...p.pos } })),
    nextWave: s.nextWave ? { ...s.nextWave, groups: s.nextWave.groups.map((g) => ({ ...g })) } : null,
    skills: s.skills.map((k) => ({ ...k })),
    currentWaveStats: { ...s.currentWaveStats },
  };
  return copy;
}

// ─────────────────────────────────────────────────────────────────────────────
// 确定性哈希
// ─────────────────────────────────────────────────────────────────────────────

const FNV_PRIME = 0x01000193;
const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0x9e3779b9;

function mixU32(h: number, v: number): number {
  let x = h ^ (v | 0);
  x = Math.imul(x, FNV_PRIME);
  x ^= x >>> 13;
  x = Math.imul(x, FNV_PRIME);
  return x >>> 0;
}

/**
 * 混入任意安全整数（含 > 2^31 的定点金额）。
 * 拆成 16 位低位 + 高位，避免 `| 0` 把大数截断成不同值的同一结果。
 */
function mixInt(h: number, v: number): number {
  const lo = v % 65536;
  const hi = (v - lo) / 65536;
  return mixU32(mixU32(h, lo), hi);
}

function mixStr(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) {
    x = mixU32(x, s.charCodeAt(i));
  }
  return mixU32(x, s.length);
}

function mixBool(h: number, b: boolean): number {
  return mixU32(h, b ? 1 : 0);
}

/**
 * 确定性哈希：用于验证 1x/2x/4x 结果一致。纯函数、纯整数、无浮点。
 *
 * 覆盖范围：tick / RNG 状态 / 全部资源 / 波次状态机 / 每座塔 / 每个敌人 /
 * 投射物池（含空槽）/ 本波统计 / 撤销记录 / 技能冷却。
 * 只要任何一个字段漂移，哈希就不同 —— 这是「1x/2x/4x 一致」这条验收标准的
 * 唯一证据来源。
 */
export function hashWorld(w: WorldState): string {
  let a = FNV_OFFSET_A;
  let b = FNV_OFFSET_B;

  a = mixInt(a, w.tick);
  b = mixInt(b, w.tick ^ 0x5bf03635);

  // RNG 位置（不参与哈希就无法发现随机序列漂移）
  a = mixInt(a, w.rng.state);
  b = mixInt(b, w.rng.state ^ 0x27d4eb2f);

  // 资源与计数
  for (const v of [w.gold, w.wood, w.lives, w.population, w.populationCap, w.wave, w.waveTotal]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x165667b1);
  }
  a = mixStr(a, w.phase);
  b = mixStr(b, w.status);

  // 科技（等级 + 全部乘区 + 投入；等级漂移必须能被发现）
  const techIds = Object.keys(w.techLevels).sort();
  a = mixInt(a, techIds.length);
  b = mixInt(b, techIds.length);
  for (const id of techIds) {
    a = mixStr(a, id);
    a = mixInt(a, w.techLevels[id] ?? 0);
    b = mixInt(b, w.techArchiveLevels[id] ?? 0);
    b = mixInt(b, w.techLevels[id] ?? 0);
  }
  for (const v of [
    w.tech.attackMul,
    w.tech.attackSpeedMul,
    w.tech.rangeMul,
    w.tech.stealMul,
    w.tech.woodMul,
    w.tech.critRateAdd,
    w.tech.critMulAdd,
    w.tech.populationAdd,
    w.techSpentGold,
    w.techSpentWood,
    w.techResearched,
  ]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x2f4f6b1d);
  }
  for (const v of [w.prepTicksLeft, w.spawnCursor, w.waveStartTick, w.nextTowerId, w.nextEnemyId, w.projectileSeq]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x85ebca6b);
  }
  for (const v of [w.stolenTotal, w.killGoldTotal, w.spentTotal, w.earnedTotal]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0xc2b2ae35);
  }
  for (const v of [w.killed, w.leaked, w.spawnedTotal, w.enemiesSpawnedThisWave, w.spawnQueue.length]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x27d4eb2f);
  }

  // 本波统计
  const wa = w.waveAcc;
  for (const v of [wa.wave, wa.goldEarned, wa.goldSpent, wa.stolenTotal, wa.walletTotal, wa.blockExtraSteal, wa.leaks]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x9e3779b1);
  }

  // 技能与撤销
  const sk = w.skills;
  for (const v of [sk.salaryReadyTick, sk.brambleReadyTick, sk.midasReadyTick, sk.brambleUntilTick]) {
    a = mixInt(a, v);
    b = mixInt(b, v ^ 0x7feb352d);
  }
  a = mixBool(a, w.lastBuild !== null);
  b = mixBool(b, w.lastBuild !== null);
  if (w.lastBuild) {
    for (const v of [w.lastBuild.towerId, w.lastBuild.tick, w.lastBuild.spentGold, w.lastBuild.spentWood]) {
      a = mixInt(a, v);
      b = mixInt(b, v ^ 0x846ca68b);
    }
    a = mixStr(a, w.lastBuild.unitId);
    b = mixStr(b, w.lastBuild.unitId);
  }

  // 塔（保持数组顺序 = 建造顺序）
  a = mixInt(a, w.towers.length);
  b = mixInt(b, w.towers.length);
  for (const t of w.towers) {
    a = mixInt(a, t.id);
    b = mixStr(b, t.unitId);
    for (const v of [
      t.tier,
      t.cell.x,
      t.cell.y,
      t.pos.x,
      t.pos.y,
      t.attack,
      t.baseAttack,
      t.range,
      t.baseRange,
      t.intervalTicks,
      t.cooldownTicks,
      t.intervalMul,
      t.targetId,
      t.totalStolen,
      t.block,
      t.blockUsed,
      t.spentGold,
      t.multiShot,
      t.woodAccum,
      t.stealAuraMul,
      t.auras.length,
    ]) {
      a = mixInt(a, v);
      b = mixInt(b, v ^ 0x9e3779b9);
    }
  }

  // 敌人（保持数组顺序 = 生成顺序）
  a = mixInt(a, w.enemies.length);
  b = mixInt(b, w.enemies.length);
  for (const e of w.enemies) {
    a = mixInt(a, e.id);
    b = mixStr(b, e.defId);
    for (const v of [
      e.pathIndex,
      e.segIndex,
      e.pos.x,
      e.pos.y,
      e.moveRemainder,
      e.hp,
      e.hpMax,
      e.walletRemaining,
      e.walletMax,
      e.speed,
      e.speedMul,
      e.haltTicksLeft,
      e.slowUntilTick,
      e.stealResist,
      e.dodge,
      e.blockedBy === null ? -1 : e.blockedBy,
      e.blockedResistReduce,
      e.auraResistReduce,
      e.alive ? 1 : 0,
      e.revived ? 1 : 0,
      e.canSplit ? 1 : 0,
      e.spawnedTick,
      e.stolenFrom,
      e.blockExtra,
      e.haltDone ? 1 : 0,
    ]) {
      a = mixInt(a, v);
      b = mixInt(b, v ^ 0x85ebca6b);
    }
  }

  // 投射物池（含空槽：槽位分配顺序也必须确定）
  a = mixInt(a, w.projectileFreeList.length);
  b = mixInt(b, w.projectileFreeList.length);
  for (const p of w.projectiles) {
    for (const v of [
      p.slot,
      p.seq,
      p.active ? 1 : 0,
      p.ownerTowerId,
      p.targetEnemyId,
      p.pos.x,
      p.pos.y,
      p.speed,
      p.damage,
      p.splash,
      p.isSteal ? 1 : 0,
      p.ttlTicks,
    ]) {
      a = mixInt(a, v);
      b = mixInt(b, v ^ 0xc2b2ae35);
    }
  }
  for (const slot of w.projectileFreeList) {
    a = mixInt(a, slot);
    b = mixInt(b, slot ^ 0x165667b1);
  }

  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** 供测试/报告使用的「内容指纹」：确认两个世界用的是同一套夹具。 */
export function hashContent(content: SimContent): string {
  let h = FNV_OFFSET_A;
  h = mixStr(h, content.label);
  h = mixStr(h, content.synthetic ? 'synthetic' : 'real');
  h = mixInt(h, Object.keys(content.units).length);
  h = mixInt(h, Object.keys(content.enemies).length);
  h = mixInt(h, content.waves.length);
  h = mixInt(h, content.paths.length);
  for (const p of content.paths) {
    for (const wp of p.waypoints) {
      h = mixInt(h, wp.x);
      h = mixInt(h, wp.y);
    }
  }
  h = mixInt(h, attackIndex('chaos'));
  h = mixInt(h, armorIndex('divine', content.constants.armorAlias));
  return (h >>> 0).toString(16).padStart(8, '0');
}
