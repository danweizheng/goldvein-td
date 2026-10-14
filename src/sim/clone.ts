/**
 * `cloneWorld(w)` —— 契约 §14.9（`balance-eng` 的 M2 API 请求）
 *
 * ## 为什么需要它
 *
 * `balance-eng` 的 `heuristic` 策略之所以只能做贪心、做不了真搜索，就是因为
 * 无法克隆世界状态；在 balance 侧自己伪造状态树会**立刻与模拟层语义脱钩**
 * （漏掉一个新字段就静默给出错误估值）。把这个能力放在模拟层内部，克隆逻辑
 * 与 `WorldState` 定义永远同源。
 *
 * ## 实现方式
 *
 * **手写字段级深拷贝**，不用 `JSON.parse(JSON.stringify())`：
 *   - JSON 往返会把 `Map`/`Set` 变成 `{}`（占用表、索引会直接丢失）；
 *   - 会把 `undefined` 字段丢掉、把 `Infinity` 变 `null`；
 *   - 速度慢一个数量级（序列化 + 解析 + 重新解析字符串键）。
 * 手写拷贝还保证：**没有额外字段遗漏**——`tsc` 会因为 `WorldState` 新增必填字段
 * 而在这里报错（这正是我们要的"编译器帮我记住"）。
 *
 * ## 共享 vs 复制（重要）
 *
 * | 内容 | 处理 | 理由 |
 * |---|---|---|
 * | `content` / `cfg` / `grid` / `paths` / `def`（单位/敌人定义） | **共享引用** | 整局只读；复制等于浪费内存与时间 |
 * | `rng` | 复制（用 `state` 重建） | 克隆必须能从同一随机位置继续 |
 * | `towers` / `enemies` / `projectiles` / 各类索引 Map | **深拷贝** | 会被 step 改写 |
 * | `_snapshot` | 重建为空白 | 快照是派生数据，克隆后重新生成 |
 *
 * ## 代价（实测见 `src/sim/__tests__/clone.spec.ts`）
 *
 * 250 敌人 + 40 塔 + 500 投射物的一次克隆：见测试里的 `[clone-cost]` 行。
 * 典型值在 **1 ms 量级 / 数百 KB**（每个 `EnemyState` ~30 个数字字段）。
 */
import { createRng } from './rng';
import { PROJECTILE_POOL_SIZE } from './world';
import type { EnemyState, ProjectileState, TowerState, WorldState, WorldSnapshot, WorldStatus } from './types';

function cloneTower(t: TowerState): TowerState {
  return {
    id: t.id,
    unitId: t.unitId,
    tier: t.tier,
    cell: { x: t.cell.x, y: t.cell.y },
    pos: { x: t.pos.x, y: t.pos.y },
    def: t.def, // 共享（只读定义）
    attack: t.attack,
    baseAttack: t.baseAttack,
    range: t.range,
    baseRange: t.baseRange,
    attackInterval: t.attackInterval,
    intervalTicks: t.intervalTicks,
    baseIntervalTicks: t.baseIntervalTicks,
    cooldownTicks: t.cooldownTicks,
    intervalMul: t.intervalMul,
    targetId: t.targetId,
    totalStolen: t.totalStolen,
    block: t.block,
    blockRange: t.blockRange,
    blockUsed: t.blockUsed,
    slowWhileBlocked: t.slowWhileBlocked,
    sellsFor: t.sellsFor,
    spentGold: t.spentGold,
    multiShot: t.multiShot,
    splash: t.splash,
    projectileSpeed: t.projectileSpeed,
    isSteal: t.isSteal,
    stealBonus: t.stealBonus,
    canRelocate: t.canRelocate,
    auras: t.auras.map((a) => ({ ...a })),
    woodAccum: t.woodAccum,
    pathIndex: t.pathIndex,
    builtTick: t.builtTick,
    auraReceived: { ...t.auraReceived },
    stealAuraMul: t.stealAuraMul,
  };
}

function cloneEnemy(e: EnemyState): EnemyState {
  return {
    id: e.id,
    defId: e.defId,
    def: e.def, // 共享
    pathIndex: e.pathIndex,
    segIndex: e.segIndex,
    pos: { x: e.pos.x, y: e.pos.y },
    moveRemainder: e.moveRemainder,
    hp: e.hp,
    hpMax: e.hpMax,
    walletRemaining: e.walletRemaining,
    walletMax: e.walletMax,
    speed: e.speed,
    speedMul: e.speedMul,
    haltDone: e.haltDone,
    haltTicksLeft: e.haltTicksLeft,
    slowUntilTick: e.slowUntilTick,
    slowMulFromHit: e.slowMulFromHit,
    slowAuraMul: e.slowAuraMul,
    armorType: e.armorType,
    flying: e.flying,
    stealResist: e.stealResist,
    dodge: e.dodge,
    blockedBy: e.blockedBy,
    blockedResistReduce: e.blockedResistReduce,
    auraResistReduce: e.auraResistReduce,
    alive: e.alive,
    revived: e.revived,
    canSplit: e.canSplit,
    spawnedTick: e.spawnedTick,
    stolenFrom: e.stolenFrom,
    blockExtra: e.blockExtra,
  };
}

function cloneProjectile(p: ProjectileState): ProjectileState {
  return {
    slot: p.slot,
    seq: p.seq,
    active: p.active,
    ownerTowerId: p.ownerTowerId,
    targetEnemyId: p.targetEnemyId,
    pos: { x: p.pos.x, y: p.pos.y },
    speed: p.speed,
    damage: p.damage,
    attackType: p.attackType,
    splash: p.splash,
    isSteal: p.isSteal,
    ttlTicks: p.ttlTicks,
  };
}

function emptySnapshot(): WorldSnapshot {
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
 * 深拷贝世界状态。克隆体与源世界**完全独立**（step 互不影响），
 * 且 `hashWorld(clone) === hashWorld(original)`（这是正确性判据）。
 */
export function cloneWorld(w: WorldState): WorldState {
  const towers = w.towers.map(cloneTower);
  const enemies = w.enemies.map(cloneEnemy);
  const projectiles = w.projectiles.map(cloneProjectile);

  const towerIndex = new Map<number, TowerState>();
  for (const t of towers) towerIndex.set(t.id, t);
  const enemyIndex = new Map<number, EnemyState>();
  for (const e of enemies) enemyIndex.set(e.id, e);

  const rng = createRng(0);
  rng.setState(w.rng.state);

  const clone: WorldState = {
    // 共享只读内容
    content: w.content,
    cfg: w.cfg,
    grid: w.grid,
    paths: w.paths,
    // 复制可变集合
    occupancy: new Map(w.occupancy),
    pathCells: w.pathCells,
    buildableCells: w.buildableCells,
    buildableRoots: w.buildableRoots,
    upgradeParentOf: w.upgradeParentOf,
    techLevels: { ...w.techLevels },
    techArchiveLevels: { ...w.techArchiveLevels },
    tech: { ...w.tech, levels: { ...w.tech.levels }, unknownTechIds: [...w.tech.unknownTechIds] },
    techSpentGold: w.techSpentGold,
    techSpentWood: w.techSpentWood,
    techResearched: w.techResearched,

    tick: w.tick,
    rng,
    gold: w.gold,
    wood: w.wood,
    lives: w.lives,
    population: w.population,
    populationCap: w.populationCap,
    wave: w.wave,
    waveTotal: w.waveTotal,
    phase: w.phase,
    prepTicksLeft: w.prepTicksLeft,
    spawnQueue: w.spawnQueue.map((s) => ({ ...s })),
    spawnCursor: w.spawnCursor,
    waveStartTick: w.waveStartTick,
    stolenTotal: w.stolenTotal,
    killGoldTotal: w.killGoldTotal,
    spentTotal: w.spentTotal,
    earnedTotal: w.earnedTotal,
    woodMinedTotal: w.woodMinedTotal,
    killed: w.killed,
    leaked: w.leaked,
    spawnedTotal: w.spawnedTotal,
    enemiesSpawnedThisWave: w.enemiesSpawnedThisWave,
    towers,
    enemies,
    enemyIndex,
    towerIndex,
    targetScratch: [],
    projectiles,
    projectileFreeList: [...w.projectileFreeList],
    projectileSeq: w.projectileSeq,
    nextTowerId: w.nextTowerId,
    nextEnemyId: w.nextEnemyId,
    eventQueue: w.eventQueue.map((e) => ({ ...e })),
    waveAcc: { ...w.waveAcc },
    lastBuild: w.lastBuild ? { ...w.lastBuild } : null,
    skills: { ...w.skills },
    status: w.status as WorldStatus,
    speed: w.speed,
    paused: w.paused,
    peakActiveProjectiles: w.peakActiveProjectiles,
    peakAliveEnemies: w.peakAliveEnemies,
    _snapshot: emptySnapshot(),
  };

  // 防御性断言：投射物池容量必须一致（避免有人改了池大小而忘了这里）
  if (clone.projectiles.length !== PROJECTILE_POOL_SIZE) {
    throw new Error(
      `cloneWorld: 投射物池容量不一致（源 ${w.projectiles.length} / 期望 ${PROJECTILE_POOL_SIZE}）—— 请检查 PROJECTILE_POOL_SIZE`,
    );
  }
  return clone;
}
