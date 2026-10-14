/**
 * M0 合成夹具（synthetic fixture）—— 接口契约 §4.2
 *
 * ⚠️ 这里**不是** `src/data/**`。M0 阶段 `engine-dev` 不得 import 真实数据表，
 * 因此本文件在 `src/sim/m0-fixture.ts` 的基础上拼出两类场景：
 *
 *   createDesignContent()  —— **忠于策划案数值**的 30 波场景（逻辑基准 + 确定性用例）
 *   createStressContent()  —— **合成压力场景**：250 敌人 + 500 投射物（性能基准）
 *
 * 压力场景里被"调大"的参数（攻速、血量、生命数）都显式标注了 `stress`，
 * 报告里会如实说明哪些数字不是策划案数值。
 */
import { FIXED_SCALE, fromInt, truncDiv, type Fixed } from '../../src/sim/fixed';
import {
  M0_CONSTANTS,
  M0_ENEMIES,
  M0_GRID,
  M0_PATHS,
  M0_UNITS,
} from '../../src/sim/m0-fixture';
import type {
  DifficultyRow,
  EnemyDef,
  SimConstants,
  SimContent,
  UnitDef,
  WaveDef,
  WaveGroupDef,
} from '../../src/sim/content';
import type { Command } from '../../src/sim/commands';
import { M0_SEEDS, computeBuildableCells, rasterizePathCells } from '../../src/sim/world';

const sec = (x: number): Fixed => Math.round(x * FIXED_SCALE);
const cells = (x: number): Fixed => Math.round(x * FIXED_SCALE);
const pct = (x: number): Fixed => Math.round(x * FIXED_SCALE);

function indexUnits(extra: UnitDef[] = []): Record<string, UnitDef> {
  const map: Record<string, UnitDef> = {};
  for (const u of M0_UNITS) map[u.id] = u;
  for (const u of extra) map[u.id] = u;
  return map;
}

function indexEnemies(extra: EnemyDef[] = []): Record<string, EnemyDef> {
  const map: Record<string, EnemyDef> = {};
  for (const e of M0_ENEMIES) map[e.id] = e;
  for (const e of extra) map[e.id] = e;
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 塔位规划（确定性：按「离★停顿点距离 → 路径编号 → y → x」全序排序）
// ─────────────────────────────────────────────────────────────────────────────

export interface TowerSlot {
  cell: { x: number; y: number };
  pathIndex: number;
  distToHalt: number;
}

/**
 * 取 `count` 个合法塔位：围绕 4 条路径的 ★停顿点，由近到远。
 * 排序键是全序，因此与引擎的 sort 稳定性无关。
 */
export function towerSlots(content: SimContent, count: number): TowerSlot[] {
  const pathCells = rasterizePathCells(content);
  const buildable = computeBuildableCells(content, pathCells);
  const width = content.grid.width;
  const slots: TowerSlot[] = [];

  for (let pi = 0; pi < content.paths.length; pi++) {
    const p = content.paths[pi];
    const wp = p?.waypoints[p.haltIndex];
    if (!p || !wp) continue;
    const hx = Math.floor(wp.x / FIXED_SCALE);
    const hy = Math.floor(wp.y / FIXED_SCALE);
    for (const key of buildable) {
      const x = key % width;
      const y = truncDiv(key - x, width);
      const d = Math.abs(x - hx) + Math.abs(y - hy);
      if (d <= 3) slots.push({ cell: { x, y }, pathIndex: pi, distToHalt: d });
    }
  }
  slots.sort(
    (a, b) =>
      a.distToHalt - b.distToHalt ||
      a.pathIndex - b.pathIndex ||
      a.cell.y - b.cell.y ||
      a.cell.x - b.cell.x,
  );
  return slots.slice(0, count);
}

/**
 * 升级链：`unitId` → 从根单位到它的完整品阶链。
 *
 * ⚠️ 契约 §14.7 之后这**不再是可选项**：`build` 会拒绝非根单位，所以基准/测试
 * 想摆一座 T3 神偷，必须显式发「建 T1 + 升 T2 + 升 T3」三步。
 */
export function upgradeChainTo(content: SimContent, unitId: string): string[] {
  const parentOf = new Map<string, string>();
  for (const u of Object.values(content.units)) {
    if (u.upgradeTo !== null && content.units[u.upgradeTo] !== undefined && !parentOf.has(u.upgradeTo)) {
      parentOf.set(u.upgradeTo, u.id);
    }
  }
  const chain: string[] = [unitId];
  let cur = unitId;
  for (let guard = 0; guard < 16; guard++) {
    const parent = parentOf.get(cur);
    if (parent === undefined) break;
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/** 根单位 id（链首）。 */
export function rootUnitId(content: SimContent, unitId: string): string {
  return upgradeChainTo(content, unitId)[0] as string;
}

/**
 * 生成一整套建塔指令（**含升级链**）。
 *
 * 塔 id 由 `nextTowerId++` 顺序分配、从 1 开始且不回退，所以只要有 K 次成功建造，
 * id 就是 1..K —— 因此可以先把全部建造指令排在前面，再用 `upgrade` 引用 1..K。
 * 任何一次建造失败都会让 id 错位并产生 `commandRejected`（响亮失败，
 * 而不是静默少一座塔）。
 */
export function towerPlan(
  content: SimContent,
  count: number,
  unitIds: string[] = ['thief_t1', 'archer_t1', 'mage_t1', 'trainer_t1', 'cannon_t1'],
): Command[] {
  const slots = towerSlots(content, count);
  const builds: Command[] = [];
  const upgrades: Command[] = [];
  for (let i = 0; i < slots.length; i++) {
    const target = unitIds[i % unitIds.length] as string;
    const chain = upgradeChainTo(content, target);
    const s = slots[i] as TowerSlot;
    builds.push({ type: 'build', unitId: chain[0] as string, cell: s.cell });
    const towerId = i + 1; // nextTowerId 从 1 开始顺序分配
    for (let k = 1; k < chain.length; k++) {
      upgrades.push({ type: 'upgrade', towerId });
    }
  }
  return [...builds, ...upgrades];
}

// ─────────────────────────────────────────────────────────────────────────────
// 忠于策划案的 30 波场景
// ─────────────────────────────────────────────────────────────────────────────

/** 按策划案 §4.5.1 的波段分配敌人类型。 */
function enemyMixForWave(wave: number): { main: string; extra?: string } {
  if (wave <= 4) return { main: 'thug' };
  if (wave <= 7) return { main: 'thug', extra: 'bat' };
  if (wave <= 8) return { main: 'bat', extra: 'thug' };
  if (wave <= 10) return { main: 'brute', extra: 'thug' };
  if (wave <= 12) return { main: 'brute', extra: 'armored_car' };
  if (wave <= 16) return { main: 'assassin', extra: 'brute' };
  if (wave <= 20) return { main: 'merchant', extra: 'armored_car' };
  if (wave <= 23) return { main: 'assassin', extra: 'merchant' };
  if (wave === 24) return { main: 'boss_beast' };
  if (wave === 25) return { main: 'boss_demon' };
  if (wave === 26) return { main: 'boss_reborn' };
  if (wave === 27) return { main: 'boss_ascendant' };
  return { main: 'temple_guard', extra: 'merchant' };
}

/** 生成 30 波（数量按 §5.1 的 Q(n) = 6 + floor(0.8n)）。 */
export function designWaves(opts: { prepSeconds?: number; maxWaves?: number } = {}): WaveDef[] {
  const prep = sec(opts.prepSeconds ?? 15);
  const total = opts.maxWaves ?? 30;
  const out: WaveDef[] = [];
  for (let wave = 1; wave <= total; wave++) {
    const count = 6 + Math.floor(0.8 * wave);
    const mix = enemyMixForWave(wave);
    const isBoss = mix.main.startsWith('boss');
    const groups: WaveGroupDef[] = isBoss
      ? [{ enemy: mix.main, count: 1, interval: sec(1), delay: 0 }]
      : [
          { enemy: mix.main, count, interval: sec(0.8), delay: 0 },
          ...(mix.extra
            ? [{ enemy: mix.extra, count: Math.max(1, Math.floor(count / 3)), interval: sec(1.6), delay: sec(2) }]
            : []),
        ];
    out.push({
      wave,
      prepTime: prep,
      groups,
      rewardGold: 0,
      rewardWood: 0,
      hint: `wave ${wave}`,
    });
  }
  return out;
}

/**
 * 忠于策划案数值的 30 波内容（逻辑基准与确定性用例用）。
 *
 * `startGold` 是**基准专用旋钮**（默认 `undefined` = 用策划案 §4.8 的 N2 起始金 2000）。
 * 性能/确定性场景需要"中后期满配局面"（策划案 §5.5：约 35 座塔、累计投入 ~67 万），
 * 因此基准里把它调高到能一次摆满 35 座塔。**不是平衡数值**。
 */
export function createDesignContent(
  opts: { prepSeconds?: number; maxWaves?: number; lives?: number; startGold?: Fixed } = {},
): SimContent {
  const difficulty: Record<string, DifficultyRow> = {};
  for (const [k, v] of Object.entries(M0_CONSTANTS.difficulty)) {
    difficulty[k] = {
      ...v,
      ...(opts.lives === undefined ? {} : { lives: opts.lives }),
      ...(opts.startGold === undefined ? {} : { startGold: opts.startGold }),
    };
  }
  const constants: SimConstants = {
    ...M0_CONSTANTS,
    difficulty: difficulty as SimConstants['difficulty'],
  };
  return {
    label: 'bench:design-30waves',
    synthetic: true,
    units: indexUnits(),
    enemies: indexEnemies(),
    waves: designWaves(opts),
    constants,
    paths: M0_SEEDS.paths,
    grid: M0_SEEDS.grid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 压力场景：250 敌人 + 500 投射物
// ─────────────────────────────────────────────────────────────────────────────

export interface StressOptions {
  /** 目标同屏敌人数（策划案 §1.5 指标：250） */
  enemyTarget?: number;
  /** 塔数量（策划案 §5.5 的满配约 35 座） */
  towers?: number;
  /** stress：塔的攻击间隔（tick）。3 tick = 20 次/秒，**远超策划案的 1.5/s** */
  attackIntervalTicks?: number;
  /** stress：投射物速度（格/秒）。越小 → 在空时间越长 → 并发数越高 */
  projectileSpeed?: Fixed;
  /** stress：敌人速度（格/秒）。要慢到 60s 内不抵达宝库 */
  enemySpeed?: Fixed;
  /** stress：准备时间（秒） */
  prepSeconds?: number;
}

/** 压力场景的敌人血包：血量与钱包都极大，保证测量窗口内不死亡、不偷空。 */
const STRESS_DUMMY: EnemyDef = {
  id: 'stress_dummy',
  name: '压力靶',
  armorType: 'light',
  flying: false,
  speed: cells(2),
  baseHp: fromInt(1_000_000),
  baseWallet: fromInt(1_000_000),
  stealResist: 0,
  dodge: 0,
  killGold: 0,
  killWood: 0,
  splitOnDeath: 0,
  reviveOnce: false,
  boss: false,
};

/**
 * tick 数 → 定点秒（**必须向上取整**）。
 *
 * ⚠️ 这里踩过坑：用 `Math.round` 时 2 tick = 33.33ms 会被存成 33，
 * 再换算回 tick 就变成 truncDiv(33×60, 1000) = **1**，攻速凭空翻倍。
 * 向上取整则 2 tick → 34 → truncDiv(2040,1000) = 2 ✓。
 * 数据侧（units.json）同理：attackInterval 换算成 tick 时是向下取整，
 * 所以写值时宁可略微保守（间隔略大）也不要写小。
 */
function ticksToFixedSeconds(ticks: number): Fixed {
  return Math.ceil((ticks * FIXED_SCALE) / 60);
}

/**
 * 压力塔：**不是策划案数值**。
 * 攻速被刻意调到 20 次/秒（策划案神偷 T5 是 1.5/s），
 * 目的是让同屏投射物达到契约要求的 500 —— 这个数字属于渲染压力指标，
 * 不是平衡数值。报告里会显式列出该偏差。
 *
 * `isSteal: true` + 极小 `stealBase`：让每次命中都产出 `steal` 事件，
 * 从而把「飘字池 300」也压满（否则飘字池在基准里根本不会被用到）。
 */
function stressTower(attackIntervalTicks: number, projectileSpeed: Fixed): UnitDef {
  return {
    id: 'stress_tower',
    name: '压力塔(合成)',
    tier: 3,
    costGold: 0,
    costWood: 0,
    attack: fromInt(20),
    attackInterval: ticksToFixedSeconds(attackIntervalTicks),
    range: cells(6),
    attackType: 'pierce',
    stealBase: fromInt(1),
    critRate: pct(0.05),
    critMul: pct(1.5),
    block: 0,
    blockRange: 0,
    sellsFor: pct(0.7),
    slowWhileBlocked: 0,
    projectileSpeed,
    multiShot: 1,
    splash: 0,
    slowOnHit: FIXED_SCALE,
    slowDuration: 0,
    resistReduce: 0,
    stealWoodRatio: 0,
    woodPerSecond: 0,
    aura: null,
    upgradeTo: null,
    isSteal: true,
    canRelocate: false,
    unlockWave: 0,
    stealBonus: 0,
  };
}

/**
 * 构造压力内容：**连续人流**，让同屏稳定在 250 敌人。
 *
 * 为什么不是"一波 250 个一起生成"：
 *   - 那样敌人在路径上挤成一团（渲染上等于一个精灵），且一波走完会出现空场，
 *     后续 tick 变成 no-op，把平均 tick 耗时稀释成假的好看数字；
 *   - 改成"按人流量持续生成"后：
 *       同屏人数 = 移速 × 路径长度⁻¹ × 生成率
 *       路径 36 格 / 4.5 格每秒 = 8s 通过时间；生成间隔 0.128s
 *       → 每条路 62.5 个在途，4 条路 = **250 个同屏**（正好是策划案的指标）
 *   - 敌人在 8s 内铺满整条路径（渲染压力真实），并且持续有目标进入塔的射程。
 */
export function createStressContent(opts: StressOptions = {}): SimContent {
  const enemyTarget = opts.enemyTarget ?? 250;
  const towers = opts.towers ?? 35;
  const intervalTicks = opts.attackIntervalTicks ?? 3;
  const projectileSpeed = opts.projectileSpeed ?? cells(8);
  const enemySpeed = opts.enemySpeed ?? cells(4.5);
  const prep = sec(opts.prepSeconds ?? 0.5);

  const dummy: EnemyDef = { ...STRESS_DUMMY, speed: enemySpeed };
  const tower = stressTower(intervalTicks, projectileSpeed);

  // 通过时间 = 路径长度 / 移速；生成间隔由"目标同屏数 / 4 条路 / 通过时间"反推
  const traversalSeconds = 8; // 36 格 / 4.5 格每秒
  const perPathAlive = enemyTarget / 4;
  const spawnInterval = traversalSeconds / perPathAlive; // ≈ 0.128s
  const perGroupCount = 4000; // 足够多，保证整场基准都在同一波内（不会出现空场）

  const groups: WaveGroupDef[] = [];
  for (let p = 0; p < 4; p++) {
    groups.push({
      enemy: dummy.id,
      count: perGroupCount,
      interval: sec(spawnInterval),
      delay: 0,
      path: [p],
    });
  }

  const difficulty: Record<string, DifficultyRow> = {};
  for (const [k, v] of Object.entries(M0_CONSTANTS.difficulty)) {
    // stress：生命调到极大，避免长期跑批时因漏怪结束（不是策划数值）
    difficulty[k] = { ...v, lives: 999_999 };
  }

  const constants: SimConstants = {
    ...M0_CONSTANTS,
    difficulty: difficulty as SimConstants['difficulty'],
  };

  const waves: WaveDef[] = [];
  for (let wave = 1; wave <= 4; wave++) {
    waves.push({
      wave,
      prepTime: prep,
      groups: groups.map((g) => ({ ...g })),
      rewardGold: 0,
      rewardWood: 0,
      hint: 'stress',
    });
  }

  return {
    label: 'bench:stress-250x500',
    synthetic: true,
    units: indexUnits([tower]),
    enemies: indexEnemies([dummy]),
    waves,
    constants,
    paths: M0_SEEDS.paths,
    grid: M0_SEEDS.grid,
  };
}

/** 压力场景的建塔指令：全部用 `stress_tower`（它是根单位，无需升级）。 */
export function stressPlan(content: SimContent, towers: number): Command[] {
  const slots = towerSlots(content, towers);
  return slots.map((s) => ({ type: 'build' as const, unitId: 'stress_tower', cell: s.cell }));
}

export { M0_GRID, M0_PATHS };
