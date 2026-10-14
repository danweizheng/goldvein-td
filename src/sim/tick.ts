/**
 * 定步长主循环 —— 接口契约 §4 / §4.1
 *
 *   step(w, cmds)          前进恰好 1/60 秒
 *   tickMany(w, n, cmds)   前进 n 个 tick
 *   drainEvents(w)         取出并清空本 tick 产生的事件
 *
 * ## 倍速语义（契约 §4.1，硬性）
 *
 * 倍速**不得**通过改 dt 实现。`step` 永远走固定 1/60 秒，**不存在 dt 参数**。
 * 2x = 每渲染帧调 step 两次，4x = 四次。
 *
 * ## 两种「多 tick + 指令」语义（重要，已列为待裁决项）
 *
 * - `tickMany(w, n, cmds)`：**每个内层 tick 都应用 cmds**（字面照契约「前进 n 个 tick」）。
 *   于是 (a) 循环 N 次 `step(w,cmds)` 与 (b) 循环 N/2 次 `tickMany(w,2,cmds)`
 *   在**任意** cmds 下都完全等价 —— 两者共应用 N 次 cmds。
 * - `advanceFrame(w, speed, cmds)`：**渲染层推荐用法** —— 第一个 tick 应用 cmds，
 *   其余 tick 传空数组。这样一次「建造」点击在 4x 下也只建一座塔。
 *   1x/2x/4x 的状态哈希同样完全一致（见 determinism.spec.ts 用例 2）。
 *
 * ## 浮点禁令
 *
 * 本文件不出现浮点算术：除法只经 fixed.ts 的 `truncDiv`/`mulDiv`/`fmul`；
 * 计时一律用**整数 tick 计数**。
 * 理由：1/60 秒在 ×1000 定点里无法精确表示（1000/60 = 16.67），
 * 若用定点秒做冷却，攻击间隔会产生 ~4% 的系统性偏差。tick 计数属于契约 §2
 * 明确允许的「纯计数用普通整数」。
 *
 * ## 系统执行顺序（每 tick）
 *
 * 指令 → 生成 → 阻挡 → 光环 → 移动 → 战斗 → 投射物 → 清理 → 经济 → 波次
 *
 * 顺序本身是确定性的一部分：任何改动都会改变哈希，必须同步更新验收基线。
 */
import { FIXED_SCALE, fmul, fpow, mulDiv, truncDiv, type Fixed } from './fixed';
import { chance } from './rng';
import type { AttackType, EnemyDef, UnitDef, WaveGroupDef } from './content';
import type {
  Cell,
  EnemyState,
  ProjectileState,
  SpawnEntry,
  TowerState,
  Vec2,
  WorldState,
} from './types';
import type { Command } from './commands';
import type { SimEvent, WaveStats } from './events';
import {
  cellCenter,
  cellKey,
  counterMul,
  critRateOf,
  distSq,
  findWave,
  isqrt,
  killRewardOf,
  researchTech,
  stealPerHit,
  ticksFromSeconds,
  waveStatsOf,
} from './world';

/** 契约 §4.1：固定 60Hz。 */
export const TICKS_PER_SECOND = 60;

/** 撤销窗口：10 秒（策划案 §3.3 Ctrl+Z）。 */
const UNDO_WINDOW_TICKS = 10 * TICKS_PER_SECOND;

/** 投射物存活上限（tick）。目标消失后最多再飞 3 秒。 */
const PROJECTILE_TTL_TICKS = 3 * TICKS_PER_SECOND;

const EMPTY_COMMANDS: readonly Command[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 前进恰好 1/60 秒。`cmds` 为本 tick 要应用的指令。
 *
 * 世界已结束（won/lost/ascended）时是**纯 no-op**：不推进 tick、不消耗 RNG。
 * 这样结束之后 1x 与 4x 的行为也一致。
 */
export function step(w: WorldState, cmds: readonly Command[]): void {
  if (w.status !== 'running') return;

  w.tick++;

  applyCommands(w, cmds);
  spawnSystem(w);
  blockSystem(w);
  auraSystem(w);
  movementSystem(w);
  combatSystem(w);
  projectileSystem(w);
  cleanupSystem(w);
  economySystem(w);
  waveSystem(w);

  if (w.enemies.length > w.peakAliveEnemies) w.peakAliveEnemies = w.enemies.length;
  let active = 0;
  for (const p of w.projectiles) if (p.active) active++;
  if (active > w.peakActiveProjectiles) w.peakActiveProjectiles = active;
}

/**
 * 前进 n 个 tick。契约 §4.1 的倍速原语。
 * ⚠️ cmds 会在**每个**内层 tick 被应用（详见文件头说明）。
 */
export function tickMany(w: WorldState, n: number, cmds: readonly Command[]): void {
  for (let i = 0; i < n; i++) {
    step(w, cmds);
    if (w.status !== 'running') return;
  }
}

/**
 * 渲染层推荐用法（每帧调一次）：第一个 tick 应用本帧指令，其余 tick 空指令。
 *
 * `advanceFrame(w, 4, cmds)` 与 4 次 `advanceFrame(w, 1, cmds)` 状态哈希相同。
 */
export function advanceFrame(w: WorldState, speed: 1 | 2 | 4, cmds: readonly Command[]): void {
  step(w, cmds);
  for (let i = 1; i < speed; i++) {
    step(w, EMPTY_COMMANDS);
    if (w.status !== 'running') return;
  }
}

/** 取出并清空本 tick 产生的事件。 */
export function drainEvents(w: WorldState): SimEvent[] {
  const out = w.eventQueue;
  w.eventQueue = [];
  return out;
}

function emit(w: WorldState, ev: SimEvent): void {
  w.eventQueue.push(ev);
}

// ─────────────────────────────────────────────────────────────────────────────
// 指令处理（契约 §5）
// ─────────────────────────────────────────────────────────────────────────────

function reject(w: WorldState, command: Command, reason: string): void {
  emit(w, { type: 'commandRejected', command, reason });
}

function applyCommands(w: WorldState, cmds: readonly Command[]): void {
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'build':
        cmdBuild(w, cmd);
        break;
      case 'upgrade':
        cmdUpgrade(w, cmd);
        break;
      case 'sell':
        cmdSell(w, cmd);
        break;
      case 'undo':
        cmdUndo(w, cmd);
        break;
      case 'relocate':
        cmdRelocate(w, cmd);
        break;
      case 'activateSkill':
        cmdSkill(w, cmd);
        break;
      // 下面三条由外层循环消费（契约 §5）。这里只记录到状态里供 UI 读取，
      // **不参与**任何数值演化，因此不影响 1x/2x/4x 一致性。
      case 'setSpeed':
        w.speed = cmd.speed;
        break;
      case 'pause':
        w.paused = true;
        break;
      case 'resume':
        w.paused = false;
        break;
      case 'ascend':
        cmdAscend(w, cmd);
        break;
      case 'research':
        cmdResearch(w, cmd);
        break;
    }
  }
}

function findTower(w: WorldState, id: number): TowerState | null {
  return w.towerIndex.get(id) ?? null;
}

/** 建立塔状态（build 用；upgrade 就地改写）。 */
function makeTower(w: WorldState, id: number, def: UnitDef, cell: Cell, pathIndex: number): TowerState {
  const baseIntervalTicks = Math.max(1, ticksFromSeconds(def.attackInterval, w.content.constants.tickRate));
  return {
    id,
    unitId: def.id,
    tier: def.tier,
    cell: { x: cell.x, y: cell.y },
    pos: cellCenter(cell),
    def,
    attack: def.attack,
    baseAttack: def.attack,
    range: def.range,
    baseRange: def.range,
    attackInterval: def.attackInterval,
    intervalTicks: baseIntervalTicks,
    baseIntervalTicks,
    cooldownTicks: 0,
    intervalMul: FIXED_SCALE,
    targetId: -1,
    totalStolen: 0,
    block: def.block,
    blockRange: def.blockRange,
    blockUsed: 0,
    slowWhileBlocked: def.slowWhileBlocked,
    sellsFor: def.sellsFor,
    spentGold: 0,
    multiShot: def.multiShot,
    splash: def.splash,
    projectileSpeed: def.projectileSpeed,
    isSteal: def.isSteal,
    stealBonus: def.stealBonus,
    canRelocate: def.canRelocate,
    // 契约 §14.10：`auras[]` 数组化；兼容旧的单 `aura` 字段
    auras: def.auras && def.auras.length > 0 ? [...def.auras] : def.aura ? [def.aura] : [],
    woodAccum: 0,
    pathIndex,
    builtTick: w.tick,
    auraReceived: { attack: FIXED_SCALE, attackSpeed: FIXED_SCALE, range: FIXED_SCALE },
    stealAuraMul: FIXED_SCALE,
  };
}

function cmdBuild(w: WorldState, cmd: Extract<Command, { type: 'build' }>): void {
  const def = w.content.units[cmd.unitId];
  if (!def) {
    reject(w, cmd, `未知单位 ${cmd.unitId}`);
    return;
  }
  if (def.unlockWave > w.wave) {
    reject(w, cmd, `单位 ${cmd.unitId} 需第 ${def.unlockWave} 波解锁`);
    return;
  }
  // ★ 契约 §14.7：sim 必须拒绝建造非根单位。
  //   设计不变量：品阶阶梯的意义就是「必须逐级升上去」。
  //   直达建造会便宜 32%（goldfinger 25,000 vs 升级链累计 36,550）并绕过整条节奏。
  if (!w.buildableRoots.has(cmd.unitId)) {
    const parent = w.upgradeParentOf.get(cmd.unitId);
    reject(
      w,
      cmd,
      `单位 ${cmd.unitId} 不是根单位，只能由升级链到达（${parent ?? '?'} → ${cmd.unitId}）；请建造根单位后升级`,
    );
    return;
  }
  const key = cellKey(w.grid.width, cmd.cell.x, cmd.cell.y);
  if (!w.buildableCells.has(key)) {
    reject(w, cmd, `格子 (${cmd.cell.x},${cmd.cell.y}) 不可建造`);
    return;
  }
  if (w.occupancy.has(key)) {
    reject(w, cmd, `格子 (${cmd.cell.x},${cmd.cell.y}) 已被占用`);
    return;
  }
  if (w.population >= w.populationCap) {
    reject(w, cmd, '人口已达上限');
    return;
  }
  if (w.gold < def.costGold) {
    reject(w, cmd, `金币不足（需 ${def.costGold}，有 ${w.gold}）`);
    return;
  }
  if (w.wood < def.costWood) {
    reject(w, cmd, `木材不足（需 ${def.costWood}，有 ${w.wood}）`);
    return;
  }

  const id = w.nextTowerId++;
  const tower = makeTower(w, id, def, cmd.cell, nearestPathIndex(w, cmd.cell));
  tower.spentGold = def.costGold;
  w.towers.push(tower);
  w.towerIndex.set(id, tower);
  w.occupancy.set(key, id);
  w.population++;
  w.gold -= def.costGold;
  w.wood -= def.costWood;
  w.spentTotal += def.costGold;
  w.waveAcc.goldSpent += def.costGold;
  w.lastBuild = { towerId: id, tick: w.tick, spentGold: def.costGold, spentWood: def.costWood, unitId: def.id };
  emit(w, { type: 'build', towerId: id, unitId: def.id });
}

function cmdUpgrade(w: WorldState, cmd: Extract<Command, { type: 'upgrade' }>): void {
  const tower = findTower(w, cmd.towerId);
  if (!tower) {
    reject(w, cmd, `找不到塔 ${cmd.towerId}`);
    return;
  }
  const nextId = tower.def.upgradeTo;
  if (!nextId) {
    reject(w, cmd, `塔 ${cmd.towerId} 已是顶级`);
    return;
  }
  const nextDef = w.content.units[nextId];
  if (!nextDef) {
    reject(w, cmd, `升级目标 ${nextId} 不存在`);
    return;
  }
  if (w.gold < nextDef.costGold) {
    reject(w, cmd, `金币不足（升级需 ${nextDef.costGold}，有 ${w.gold}）`);
    return;
  }
  // 策划案 §5.5：T1→T5 累计造价 = 各级造价之和
  tower.unitId = nextDef.id;
  tower.def = nextDef;
  tower.tier = nextDef.tier;
  tower.baseAttack = nextDef.attack;
  tower.baseRange = nextDef.range;
  tower.attackInterval = nextDef.attackInterval;
  tower.baseIntervalTicks = Math.max(1, ticksFromSeconds(nextDef.attackInterval, w.content.constants.tickRate));
  tower.block = nextDef.block;
  tower.blockRange = nextDef.blockRange;
  tower.slowWhileBlocked = nextDef.slowWhileBlocked;
  tower.multiShot = nextDef.multiShot;
  tower.splash = nextDef.splash;
  tower.projectileSpeed = nextDef.projectileSpeed;
  tower.isSteal = nextDef.isSteal;
  tower.stealBonus = nextDef.stealBonus;
  tower.canRelocate = nextDef.canRelocate;
  tower.auras = nextDef.auras && nextDef.auras.length > 0 ? [...nextDef.auras] : nextDef.aura ? [nextDef.aura] : [];
  tower.sellsFor = nextDef.sellsFor;
  tower.spentGold += nextDef.costGold;

  w.gold -= nextDef.costGold;
  w.spentTotal += nextDef.costGold;
  w.waveAcc.goldSpent += nextDef.costGold;
  emit(w, { type: 'upgrade', towerId: tower.id, tier: tower.tier });
}

function removeTower(w: WorldState, tower: TowerState): void {
  const idx = w.towers.indexOf(tower);
  if (idx >= 0) w.towers.splice(idx, 1);
  w.towerIndex.delete(tower.id);
  w.occupancy.delete(cellKey(w.grid.width, tower.cell.x, tower.cell.y));
  w.population = Math.max(0, w.population - 1);
}

function cmdSell(w: WorldState, cmd: Extract<Command, { type: 'sell' }>): void {
  const tower = findTower(w, cmd.towerId);
  if (!tower) {
    reject(w, cmd, `找不到塔 ${cmd.towerId}`);
    return;
  }
  const refund = fmul(tower.spentGold, tower.sellsFor);
  removeTower(w, tower);
  w.gold += refund;
  emit(w, { type: 'sell', towerId: cmd.towerId, refund });
}

function cmdUndo(w: WorldState, cmd: Extract<Command, { type: 'undo' }>): void {
  const last = w.lastBuild;
  if (!last) {
    reject(w, cmd, '没有可撤销的建造');
    return;
  }
  if (w.tick - last.tick > UNDO_WINDOW_TICKS) {
    reject(w, cmd, '撤销窗口已过（10s）');
    return;
  }
  const tower = findTower(w, last.towerId);
  if (!tower) {
    reject(w, cmd, '上一次建造的塔已不存在');
    w.lastBuild = null;
    return;
  }
  removeTower(w, tower);
  w.gold += last.spentGold;
  w.wood += last.spentWood;
  w.spentTotal -= last.spentGold;
  w.waveAcc.goldSpent -= last.spentGold;
  w.lastBuild = null;
  // 契约 §13.1：undo 有了专属事件（不再复用 sell 造成语义混淆）
  emit(w, { type: 'undo', towerId: last.towerId, refund: last.spentGold });
}

function cmdRelocate(w: WorldState, cmd: Extract<Command, { type: 'relocate' }>): void {
  const tower = findTower(w, cmd.towerId);
  if (!tower) {
    reject(w, cmd, `找不到塔 ${cmd.towerId}`);
    return;
  }
  if (!tower.canRelocate) {
    reject(w, cmd, `塔 ${cmd.towerId}（${tower.unitId}）不支持重新部署`);
    return;
  }
  const key = cellKey(w.grid.width, cmd.cell.x, cmd.cell.y);
  if (!w.buildableCells.has(key) || w.occupancy.has(key)) {
    reject(w, cmd, `目标格 (${cmd.cell.x},${cmd.cell.y}) 不可用`);
    return;
  }
  w.occupancy.delete(cellKey(w.grid.width, tower.cell.x, tower.cell.y));
  tower.cell = { x: cmd.cell.x, y: cmd.cell.y };
  tower.pos = cellCenter(tower.cell);
  tower.pathIndex = nearestPathIndex(w, tower.cell);
  w.occupancy.set(key, tower.id);
}

function cmdSkill(w: WorldState, cmd: Extract<Command, { type: 'activateSkill' }>): void {
  const c = w.content.constants;
  switch (cmd.skillId) {
    case 'salary': {
      if (w.tick < w.skills.salaryReadyTick) {
        reject(w, cmd, '「领工资」冷却中');
        return;
      }
      // 策划案 §4.1.4：60 × 基地每秒产出
      const gain = mulDiv(c.salaryMultiplier, c.baseIncomePerSec, FIXED_SCALE);
      w.gold += gain;
      w.earnedTotal += gain;
      w.waveAcc.goldEarned += gain;
      w.skills.salaryReadyTick = w.tick + ticksFromSeconds(c.salaryCooldown, c.tickRate);
      // 契约 §13.1：技能生效要有事件，否则 UI 无从得知
      emit(w, { type: 'skillActivated', skillId: 'salary', amount: gain });
      return;
    }
    case 'bramble': {
      if (w.tick < w.skills.brambleReadyTick) {
        reject(w, cmd, '「荆棘丛林」冷却中');
        return;
      }
      const dur = Math.max(1, ticksFromSeconds(c.brambleDuration, c.tickRate));
      for (const e of w.enemies) {
        if (e.flying) continue; // 策划案 §4.1.4：对飞行无效
        if (e.haltTicksLeft < dur) e.haltTicksLeft = dur;
      }
      w.skills.brambleUntilTick = w.tick + dur;
      w.skills.brambleReadyTick = w.tick + ticksFromSeconds(c.brambleCooldown, c.tickRate);
      emit(w, { type: 'skillActivated', skillId: 'bramble' });
      return;
    }
    case 'midas': {
      if (w.tick < w.skills.midasReadyTick) {
        reject(w, cmd, '「点金术」冷却中');
        return;
      }
      w.skills.midasReadyTick = w.tick + ticksFromSeconds(c.midasCooldown, c.tickRate);
      // 策划案 §4.2.1 宗师：秒杀血量 <15% 的敌人并全额夺取其剩余钱包
      for (const e of w.enemies) {
        if (!e.alive) continue;
        if (e.hp * FIXED_SCALE >= e.hpMax * c.midasThreshold) continue;
        const greedy = e.walletRemaining;
        if (greedy > 0 && e.stealResist < FIXED_SCALE) {
          e.walletRemaining = 0;
          w.gold += greedy;
          w.stolenTotal += greedy;
          e.stolenFrom += greedy;
          w.waveAcc.stolenTotal += greedy;
          w.waveAcc.goldEarned += greedy;
          if (e.blockedBy !== null) {
            // 契约 §14.8：**增量**语义（见 applyHit 的注释）
            const blocker = findTower(w, e.blockedBy);
            const share = blocker ? blocker.slowWhileBlocked : 0;
            const inc = share > 0 ? fmul(greedy, share) : 0;
            if (inc > 0) {
              w.waveAcc.blockExtraSteal += inc;
              e.blockExtra += inc;
              emit(w, { type: 'blockExtraSteal', towerId: e.blockedBy, amount: inc });
            }
          }
          emit(w, { type: 'steal', towerId: -1, enemyId: e.id, amount: greedy, crit: false });
        }
        e.alive = false;
      }
      emit(w, { type: 'skillActivated', skillId: 'midas' });
      return;
    }
  }
}

/** 研究科技（契约 §14.2）。失败不抛异常，产出 commandRejected。 */
function cmdResearch(w: WorldState, cmd: Extract<Command, { type: 'research' }>): void {
  const result = researchTech(w, cmd.techId);
  if (!result.ok) {
    reject(w, cmd, result.reason ?? '研究失败');
    return;
  }
  // 科技本身不是「塔」，但 UI 需要知道等级变了 → 复用 upgrade 语义不合适，
  // 用 skillActivated 也不合适；契约 §13.1 未定义科技事件，故用 commandRejected 之外的
  // 最接近载体：这里**新增** techResearched 计数并靠快照 techs[] 让 UI 读取（已在汇报说明）。
}

function cmdAscend(w: WorldState, cmd: Extract<Command, { type: 'ascend' }>): void {
  if (w.wave < 20) {
    reject(w, cmd, '「蜕变」需第 20 波之后');
    return;
  }
  // 契约 §13.1：gameOver 扩为三态，'ascended' 是主动蜕变的第三种结局（不是「输」）
  w.status = 'ascended';
  emit(w, { type: 'gameOver', result: 'ascended', wave: w.wave });
}

/** 离最近路径的编号（用于光环/报告，不影响数值演化）。 */
function nearestPathIndex(w: WorldState, cell: Cell): number {
  const pos = cellCenter(cell);
  let best = 0;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < w.paths.length; i++) {
    const p = w.paths[i] as { waypoints: Vec2[] };
    let d = Number.MAX_SAFE_INTEGER;
    for (const wp of p.waypoints) {
      const dd = distSq(pos, wp);
      if (dd < d) d = dd;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// 波次生成
// ─────────────────────────────────────────────────────────────────────────────

/** 本难度开放的路数（策划案 §4.6：N1/N2 开 2 路，N3+ 开 4 路）。 */
function activePathCount(w: WorldState): number {
  const want = w.content.constants.difficulty[w.cfg.difficultyId].paths;
  return Math.max(1, Math.min(want, w.paths.length));
}

function spawnSystem(w: WorldState): void {
  if (w.phase === 'prep') {
    w.prepTicksLeft--;
    if (w.prepTicksLeft <= 0) startWave(w);
    return;
  }
  if (w.phase !== 'combat') return;

  const elapsed = w.tick - w.waveStartTick;
  while (w.spawnCursor < w.spawnQueue.length) {
    const entry = w.spawnQueue[w.spawnCursor] as SpawnEntry;
    if (entry.tickOffset > elapsed) break;
    spawnEnemy(w, entry.enemyId, entry.pathIndex);
    w.spawnCursor++;
  }
}

function startWave(w: WorldState): void {
  const def = findWave(w, w.wave);
  w.phase = 'combat';
  w.waveStartTick = w.tick;
  w.spawnQueue = buildSpawnQueue(w, def ? def.groups : []);
  w.spawnCursor = 0;
  w.enemiesSpawnedThisWave = 0;
  w.waveAcc.wave = w.wave;
  w.waveAcc.goldEarned = 0;
  w.waveAcc.goldSpent = 0;
  w.waveAcc.stolenTotal = 0;
  w.waveAcc.walletTotal = 0;
  w.waveAcc.blockExtraSteal = 0;
  w.waveAcc.leaks = 0;
  emit(w, { type: 'waveStart', wave: w.wave });
}

function buildSpawnQueue(w: WorldState, groups: readonly WaveGroupDef[]): SpawnEntry[] {
  const queue: SpawnEntry[] = [];
  const pathCount = activePathCount(w);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi] as WaveGroupDef;
    for (let i = 0; i < g.count; i++) {
      const offsetSeconds = g.delay + g.interval * i;
      const tickOffset = ticksFromSeconds(offsetSeconds, w.content.constants.tickRate);
      const pathIndex =
        g.path && g.path.length > 0
          ? (g.path[i % g.path.length] as number) % w.paths.length
          : (gi + i) % pathCount;
      queue.push({ tickOffset, enemyId: g.enemy, pathIndex, groupIndex: gi, indexInGroup: i });
    }
  }
  // 全序比较器（tickOffset/groupIndex/indexInGroup 组合唯一）→ 排序结果与引擎无关
  queue.sort(
    (a, b) => a.tickOffset - b.tickOffset || a.groupIndex - b.groupIndex || a.indexInGroup - b.indexInGroup,
  );
  return queue;
}

/** 构造敌人状态但**不注册**（分裂分身用）。 */
function makeEnemy(w: WorldState, enemyId: string, pathIndex: number, hpOverride: Fixed = 0): EnemyState | null {
  const def: EnemyDef | undefined = w.content.enemies[enemyId];
  if (!def) return null;
  const c = w.content.constants;
  const diff = c.difficulty[w.cfg.difficultyId];
  const waveExp = Math.max(0, w.wave - 1);

  // §5.1：HP(n) = base × hpIndex^(n−1)；钱包同理。两者再乘难度系数（§4.8）。
  const hp = hpOverride > 0 ? hpOverride : fmul(fmul(def.baseHp, fpow(c.hpIndex, waveExp)), diff.hpMul);
  const wallet = fmul(fmul(def.baseWallet, fpow(c.walletIndex, waveExp)), diff.walletMul);
  const path = w.paths[pathIndex] ?? w.paths[0];
  if (!path) return null;
  const start = path.waypoints[0] as Vec2;

  return {
    id: w.nextEnemyId++,
    defId: def.id,
    def,
    pathIndex,
    segIndex: 0,
    pos: { x: start.x, y: start.y },
    moveRemainder: 0,
    hp,
    hpMax: hp,
    walletRemaining: wallet,
    walletMax: wallet,
    speed: def.speed,
    speedMul: FIXED_SCALE,
    haltDone: false,
    haltTicksLeft: 0,
    slowUntilTick: 0,
    slowMulFromHit: FIXED_SCALE,
    slowAuraMul: FIXED_SCALE,
    armorType: def.armorType,
    flying: def.flying,
    stealResist: def.stealResist,
    dodge: def.dodge,
    blockedBy: null,
    blockedResistReduce: 0,
    auraResistReduce: 0,
    alive: true,
    revived: false,
    // 原生敌人可以分裂；由克隆产生时会被显式关掉（契约 §14.12）
    canSplit: def.splitOnDeath > 0,
    spawnedTick: w.tick,
    stolenFrom: 0,
    blockExtra: 0,
  };
}

/**
 * 「这只敌人死亡时是否应该分裂」——**单一真相**（契约 §14.12）。
 *
 * 独立的纯谓词是有意的：这样"分身不再分裂"这条规则可以被**真值表**直接测到
 * （`shouldSplit(分身) === false`），而不是只能靠端到端出怪数间接观察。
 * 谁把 `e.canSplit` 从条件里拿掉，真值表用例立刻报红。
 */
export function shouldSplit(e: EnemyState): boolean {
  return e.canSplit && e.def.splitOnDeath > 0;
}

function spawnEnemy(w: WorldState, enemyId: string, pathIndex: number, hpOverride: Fixed = 0): EnemyState | null {
  const e = makeEnemy(w, enemyId, pathIndex, hpOverride);
  if (!e) return null;
  w.enemies.push(e);
  w.enemyIndex.set(e.id, e);
  w.spawnedTotal++;
  w.enemiesSpawnedThisWave++;
  w.waveAcc.walletTotal += e.walletMax;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// 阻挡与卡位（策划案 §4.2.4）
//   ⚠️ blockUsed 必须每 tick 重置：阻挡是「占位」而非「锁定」
// ─────────────────────────────────────────────────────────────────────────────

function blockSystem(w: WorldState): void {
  for (const t of w.towers) t.blockUsed = 0;

  for (const e of w.enemies) {
    if (!e.alive || e.flying || isAtVault(w, e)) {
      e.blockedBy = null;
      e.blockedResistReduce = 0;
      continue;
    }
    let best: TowerState | null = null;
    let bestD = Number.MAX_SAFE_INTEGER;
    for (const t of w.towers) {
      if (t.block <= 0 || t.blockUsed >= t.block) continue;
      const d = distSq(t.pos, e.pos);
      if (d > t.blockRange * t.blockRange) continue;
      if (d < bestD || (d === bestD && best !== null && t.id < best.id)) {
        bestD = d;
        best = t;
      }
    }
    if (best) {
      best.blockUsed++;
      e.blockedBy = best.id;
      e.blockedResistReduce = best.def.resistReduce;
    } else {
      e.blockedBy = null;
      e.blockedResistReduce = 0;
    }
  }
}

/** 是否已走到路径终点（宝库）。 */
function isAtVault(w: WorldState, e: EnemyState): boolean {
  const path = w.paths[e.pathIndex];
  if (!path) return true;
  return e.segIndex >= path.waypoints.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 光环（策划案 §4.2.3：不可叠加，取最高；软减速取最低）
// ─────────────────────────────────────────────────────────────────────────────

function auraSystem(w: WorldState): void {
  for (const t of w.towers) {
    t.auraReceived.attack = FIXED_SCALE;
    t.auraReceived.attackSpeed = FIXED_SCALE;
    t.auraReceived.range = FIXED_SCALE;
    t.stealAuraMul = FIXED_SCALE;
  }
  for (const e of w.enemies) {
    e.slowAuraMul = FIXED_SCALE;
    e.auraResistReduce = 0;
  }

  for (const src of w.towers) {
    const auras = src.auras;
    if (auras.length === 0) continue;

    for (const aura of auras) {
      const radiusSq = aura.radius === 0 ? Number.MAX_SAFE_INTEGER : aura.radius * aura.radius;

      if (aura.kind === 'slow') {
        // 敌方光环：移速乘区，取最低
        for (const e of w.enemies) {
          if (!e.alive) continue;
          if (distSq(src.pos, e.pos) > radiusSq) continue;
          if (aura.value < e.slowAuraMul) e.slowAuraMul = aura.value;
        }
        continue;
      }

      if (aura.kind === 'stealResistDebuff') {
        // 敌方光环：窃金抗性削减量，取**最高**（削减越多越好）
        for (const e of w.enemies) {
          if (!e.alive) continue;
          if (distSq(src.pos, e.pos) > radiusSq) continue;
          if (aura.value > e.auraResistReduce) e.auraResistReduce = aura.value;
        }
        continue;
      }

      for (const dst of w.towers) {
        // 光环只作用于**其它**塔（辅助塔不给自己加成）—— 策划案未明确，已列为待裁决项。
        if (dst.id === src.id) continue;
        if (distSq(src.pos, dst.pos) > radiusSq) continue;
        if (aura.kind === 'attack' || aura.kind === 'all') {
          if (aura.value > dst.auraReceived.attack) dst.auraReceived.attack = aura.value;
        }
        if (aura.kind === 'attackSpeed' || aura.kind === 'all') {
          if (aura.value > dst.auraReceived.attackSpeed) dst.auraReceived.attackSpeed = aura.value;
        }
        if (aura.kind === 'range' || aura.kind === 'all') {
          if (aura.value > dst.auraReceived.range) dst.auraReceived.range = aura.value;
        }
        if (aura.kind === 'steal') {
          // 窃金效率光环（训导主任「周围 4 格内神偷系 +20%」），取最高
          if (aura.value > dst.stealAuraMul) dst.stealAuraMul = aura.value;
        }
      }
    }
  }

  // 应用：科技乘区（契约 §14.2）与光环乘区逐次 fmul，中间值始终保持定点量级
  const tech = w.tech;
  for (const t of w.towers) {
    t.attack = fmul(fmul(t.baseAttack, t.auraReceived.attack), tech.attackMul);
    t.range = fmul(fmul(t.baseRange, t.auraReceived.range), tech.rangeMul);
    // 攻速是**频率**乘区：intervalMul 越大越快，因此两个"越快"的乘区相乘后作除数
    const rate = tmul(t.auraReceived.attackSpeed, tech.attackSpeedMul);
    t.intervalMul = rate;
    t.intervalTicks = Math.max(1, mulDiv(t.baseIntervalTicks, FIXED_SCALE, rate));
  }
}

/** 两个乘区（千分比）相乘，结果仍是乘区。 */
function tmul(a: Fixed, b: Fixed): Fixed {
  return mulDiv(a, b, FIXED_SCALE);
}

// ─────────────────────────────────────────────────────────────────────────────
// 移动（沿 waypoint；★停顿点 0.6s；软/硬减速）
// ─────────────────────────────────────────────────────────────────────────────

function movementSystem(w: WorldState): void {
  const rate = w.content.constants.tickRate;
  const haltTicks = Math.max(1, ticksFromSeconds(w.content.constants.haltPointStopDuration, rate));

  for (const e of w.enemies) {
    if (!e.alive) continue;

    // 有效移速乘区：软减速（命中）→ 光环减速 → 列阵（被阻挡 −40%）
    let mul = FIXED_SCALE;
    if (e.slowUntilTick > w.tick && e.slowMulFromHit < mul) mul = e.slowMulFromHit;
    if (e.slowAuraMul < mul) mul = e.slowAuraMul;
    if (e.blockedBy !== null) {
      const blocker = findTower(w, e.blockedBy);
      if (blocker) {
        const after = FIXED_SCALE - blocker.slowWhileBlocked;
        if (after < mul) mul = after;
      }
    }
    e.speedMul = mul;

    // 硬停顿（★停顿点 / 荆棘丛林）：原地不动
    if (e.haltTicksLeft > 0) {
      e.haltTicksLeft--;
      continue;
    }
    if (isAtVault(w, e)) continue;

    // 用「速度 + 余数」累加，整数 tick 计数，不产生截断漂移
    const speed = fmul(e.speed, e.speedMul);
    const num = speed + e.moveRemainder;
    let remaining = truncDiv(num, rate);
    e.moveRemainder = num - remaining * rate;
    if (remaining <= 0) continue;

    const path = w.paths[e.pathIndex];
    if (!path) continue;
    const wps = path.waypoints;

    while (remaining > 0 && e.segIndex < wps.length - 1) {
      const target = wps[e.segIndex + 1] as Vec2;
      const dx = target.x - e.pos.x;
      const dy = target.y - e.pos.y;
      const dist = isqrt(dx * dx + dy * dy);
      if (dist === 0) {
        e.segIndex++;
        onWaypoint(e, path.haltIndex, haltTicks);
        continue;
      }
      if (remaining >= dist) {
        e.pos.x = target.x;
        e.pos.y = target.y;
        remaining -= dist;
        e.segIndex++;
        onWaypoint(e, path.haltIndex, haltTicks);
      } else {
        e.pos.x += truncDiv(dx * remaining, dist);
        e.pos.y += truncDiv(dy * remaining, dist);
        remaining = 0;
      }
    }
  }
}

/** 到达 waypoint：★停顿点只触发一次。 */
function onWaypoint(e: EnemyState, haltIndex: number, haltTicks: number): void {
  if (!e.haltDone && e.segIndex === haltIndex) {
    e.haltDone = true;
    e.haltTicksLeft = haltTicks;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 战斗（索敌 → 开火 → 投射物 → 命中结算）
// ─────────────────────────────────────────────────────────────────────────────

function combatSystem(w: WorldState): void {
  const vault = w.grid.vault;
  const vaultCenter: Vec2 = { x: (vault.x * 2 + vault.w) * 500, y: (vault.y * 2 + vault.h) * 500 };

  for (const t of w.towers) {
    if (t.cooldownTicks > 0) t.cooldownTicks--;
    if (t.attack <= 0 || t.range <= 0) continue;
    if (t.def.woodPerSecond > 0 && !t.isSteal) continue; // 纯产能单位不开火

    const k = Math.max(1, t.multiShot);
    const scratch = w.targetScratch;
    scratch.length = 0;
    const rangeSq = t.range * t.range;

    // 单次遍历取 top-K（K = multiShot ≤ 4），避免每塔每 tick 分配数组 + 全排序
    for (const e of w.enemies) {
      if (!e.alive) continue;
      if (distSq(t.pos, e.pos) > rangeSq) continue;
      insertNearestToVault(scratch, e, k, vaultCenter);
    }

    if (scratch.length === 0) {
      t.targetId = -1;
      continue;
    }
    const primary = scratch[0] as EnemyState;
    if (t.cooldownTicks > 0) {
      t.targetId = primary.id;
      continue;
    }
    for (const target of scratch) spawnProjectile(w, t, target);
    t.targetId = primary.id;
    t.cooldownTicks = t.intervalTicks;
  }
}

/** 按「离宝库更近优先，同距离 id 小优先」插入到长度 ≤ k 的有序小数组。 */
function insertNearestToVault(list: EnemyState[], e: EnemyState, k: number, vaultCenter: Vec2): void {
  const m = distSq(e.pos, vaultCenter);
  let i = list.length;
  while (i > 0) {
    const prev = list[i - 1] as EnemyState;
    const pm = distSq(prev.pos, vaultCenter);
    if (pm < m || (pm === m && prev.id < e.id)) break;
    i--;
  }
  if (i >= k) return;
  list.splice(i, 0, e);
  if (list.length > k) list.length = k;
}

function spawnProjectile(w: WorldState, t: TowerState, target: EnemyState): void {
  const pool = w.projectiles;
  let slot: number;
  if (w.projectileFreeList.length > 0) {
    slot = w.projectileFreeList.pop() as number;
  } else {
    // 池满：复用 seq 最小（最旧）的槽位（策划案 §8.5）
    let oldest = pool[0] as ProjectileState;
    for (const cand of pool) {
      if (!cand.active) {
        oldest = cand;
        break;
      }
      if (cand.seq < oldest.seq) oldest = cand;
    }
    slot = oldest.slot;
  }
  const p = pool[slot] as ProjectileState;

  p.active = true;
  p.seq = w.projectileSeq++;
  p.ownerTowerId = t.id;
  p.targetEnemyId = target.id;
  p.pos.x = t.pos.x;
  p.pos.y = t.pos.y;
  p.speed = t.projectileSpeed;
  // 存「面板攻击」而不是「已过克制矩阵的伤害」：溅射目标护甲可能不同，
  // 每次命中各自结算克制（策划案 §4.3）。
  p.damage = t.attack;
  p.attackType = t.def.attackType;
  p.splash = t.splash;
  p.isSteal = t.isSteal;
  p.ttlTicks = PROJECTILE_TTL_TICKS;
}

function deactivateProjectile(w: WorldState, p: ProjectileState): void {
  if (!p.active) return;
  p.active = false;
  p.targetEnemyId = -1;
  p.ownerTowerId = -1;
  p.ttlTicks = 0;
  w.projectileFreeList.push(p.slot);
}

function projectileSystem(w: WorldState): void {
  const rate = w.content.constants.tickRate;
  for (const p of w.projectiles) {
    if (!p.active) continue;
    const target = w.enemyIndex.get(p.targetEnemyId);
    if (!target || !target.alive) {
      deactivateProjectile(w, p);
      continue;
    }
    if (p.ttlTicks <= 0) {
      deactivateProjectile(w, p);
      continue;
    }
    p.ttlTicks--;

    const dx = target.pos.x - p.pos.x;
    const dy = target.pos.y - p.pos.y;
    const dsq = dx * dx + dy * dy;
    const step = Math.max(1, truncDiv(p.speed, rate));
    if (dsq <= step * step) {
      impact(w, p, target);
      deactivateProjectile(w, p);
      continue;
    }
    const len = isqrt(dsq);
    if (len === 0) {
      impact(w, p, target);
      deactivateProjectile(w, p);
      continue;
    }
    p.pos.x += truncDiv(dx * step, len);
    p.pos.y += truncDiv(dy * step, len);
  }
}

function impact(w: WorldState, p: ProjectileState, target: EnemyState): void {
  const owner = findTower(w, p.ownerTowerId);
  if (!owner) return;

  // 闪避（策划案 §4.5.2 精英刺客 15%）：闪避则既不掉血也不被窃。
  // 注意：这里的 RNG 消耗顺序（先闪避后暴击）是确定性契约的一部分。
  if (chance(w.rng, target.dodge)) return;

  applyHit(w, owner, target, p.damage, p.attackType, p.isSteal);

  if (p.splash > 0) {
    const radiusSq = p.splash * p.splash;
    for (const other of w.enemies) {
      if (other === target || !other.alive) continue;
      if (distSq(other.pos, target.pos) > radiusSq) continue;
      // 溅射不重复窃金（策划案未明确，M0 取"不重复"以避免一炮多次窃取）
      applyHit(w, owner, other, p.damage, p.attackType, false);
    }
  }
}

function applyHit(
  w: WorldState,
  owner: TowerState,
  victim: EnemyState,
  power: Fixed,
  attackType: AttackType,
  withSteal: boolean,
): void {
  if (!victim.alive) return;

  // 伤害过克制矩阵（§4.3；N1/N2 走压缩表）
  const dmg = fmul(power, counterMul(w, attackType, victim.armorType));

  // 减速（美女系软减速）
  if (owner.def.slowOnHit < FIXED_SCALE) {
    const dur = ticksFromSeconds(owner.def.slowDuration, w.content.constants.tickRate);
    if (dur > 0) {
      if (victim.slowUntilTick <= w.tick || owner.def.slowOnHit < victim.slowMulFromHit) {
        victim.slowMulFromHit = owner.def.slowOnHit;
      }
      if (victim.slowUntilTick < w.tick + dur) victim.slowUntilTick = w.tick + dur;
    }
  }

  victim.hp -= dmg;
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.alive = false;
  }

  if (!withSteal || !owner.isSteal) return;

  const c = w.content.constants;
  // 暴击率/暴击倍率统一走 world.ts 的 critRateOf / critMulOf（单一真相），
  // 科技加项（契约 §13.3：暴击效率等级 = 科技线等级）由 world.tech 提供。
  const critRate = critRateOf(c, owner.def, w.tech.critRateAdd);
  const crit = chance(w.rng, critRate);
  const amount = stealPerHit(w, owner, victim, crit);
  if (amount <= 0) return;

  victim.walletRemaining -= amount;
  owner.totalStolen += amount;
  w.gold += amount;
  w.stolenTotal += amount;
  w.waveAcc.goldEarned += amount;
  w.waveAcc.stolenTotal += amount;
  victim.stolenFrom += amount;
  emit(w, { type: 'steal', towerId: owner.id, enemyId: victim.id, amount, crit });

  // ── 契约 §14.8：blockExtraSteal 改为「**增量**」语义 ──
  //
  // 旧实现把「被阻挡敌人身上的全部窃取」计入，那是**占比**而不是增量 → 高估。
  // 增量取什么：「因阻挡多停留的时间」所对应的窃取份额。
  // 阻挡造成的唯一机制是『列阵』减速（slowWhileBlocked，如 400 = −40% 移速），
  // 它把敌人停留在射程内的时间拉长为 `1 / (1 − 40%) = 1.67 倍`，
  // 即多出的时间份额 = `slowWhileBlocked`（40%）。故
  //    增量 = 该笔窃取 × slowWhileBlocked / 1000
  // 这是**可实现且不依赖反事实模拟**的定义；真正的反事实只能靠跑两次世界。
  // 定义已写进汇报，请主策划确认口径。
  if (victim.blockedBy !== null) {
    const blocker = findTower(w, victim.blockedBy);
    const share = blocker ? blocker.slowWhileBlocked : 0;
    const increment = share > 0 ? fmul(amount, share) : 0;
    if (increment > 0) {
      w.waveAcc.blockExtraSteal += increment;
      victim.blockExtra += increment;
      emit(w, { type: 'blockExtraSteal', towerId: victim.blockedBy, amount: increment });
    }
  }

  // 窃金附带窃木（策划案 §4.1.1）
  const woodMul = owner.def.stealWoodRatio;
  if (woodMul > 0) {
    const wood = fmul(amount, woodMul);
    w.wood += wood;
    w.woodMinedTotal += wood;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 清理（死亡结算 / 漏怪 / 分裂 / 复活）
// ─────────────────────────────────────────────────────────────────────────────

function cleanupSystem(w: WorldState): void {
  const enemies = w.enemies;
  const newborns: EnemyState[] = [];
  let write = 0;

  for (let read = 0; read < enemies.length; read++) {
    const e = enemies[read] as EnemyState;
    const reachedVault = e.alive && isAtVault(w, e);

    if (e.alive && !reachedVault) {
      enemies[write++] = e;
      continue;
    }

    if (reachedVault) {
      // 漏怪：扣 1 生命并消失（策划案 §3.4）
      w.lives--;
      w.leaked++;
      w.waveAcc.leaks++;
      w.enemyIndex.delete(e.id);
      emit(w, { type: 'leak', enemyId: e.id, livesLeft: Math.max(0, w.lives) });
    } else if (e.def.reviveOnce && !e.revived) {
      // 转生者：复活一次（50% 血量）
      e.revived = true;
      e.alive = true;
      e.hp = truncDiv(e.hpMax, 2);
      enemies[write++] = e;
    } else {
      w.enemyIndex.delete(e.id);
      // 契约 §14.6：击杀奖励必须**按波次缩放**（占该敌人当波钱包的比率）。
      // 用 e.walletMax（生成时已乘过 walletIndex^(n-1) 与难度），与设计一致。
      const reward = killRewardOf(w, e);
      const gold = reward.gold;
      const wood = reward.wood;
      w.gold += gold;
      w.wood += wood;
      w.killGoldTotal += gold;
      w.earnedTotal += gold;
      w.waveAcc.goldEarned += gold;
      w.killed++;
      emit(w, { type: 'kill', enemyId: e.id, gold, wood });

      // 心魔：死亡分裂为 2 个**半血分身**（策划案 §4.5.2）。
      //
      // ⚠️ BUG 修复（契约 §14.12 / 主策划 2026-10-13 裁决）：
      //   旧实现让克隆继承同一个 `defId`，于是 `def.splitOnDeath` 仍是 2，
      //   分身死亡时**又裂出分身** → 每代 ×2 无界增长。
      //   实测后果：`waves.json` 全 30 波共 522 只敌人，含分裂时出怪 560（+38）。
      //   半血分裂本身**总血量守恒**（1 → 2×50%），所以它破坏的不是血量平衡，
      //   而是**生命经济** —— 分身数量指数增长 → 抵达宝库的身体数指数增长 →
      //   每个漏怪扣 1 命。
      //   ⇒ 修法必须是「**分身不再分裂**」（一代即止），而不是调低分身血量
      //   （后者会破坏总血量守恒，等于顺手改了数值）。
      if (shouldSplit(e)) {
        const splitCount = e.def.splitOnDeath;
        // ★ 钱包守恒（主策划 2026-10-13 裁决，与血量同构）：
        //   分身各得「本体**死亡时剩余钱包** ÷ N」，**总额不增不减**。
        //   为什么必须是"剩余"而不是"初始"：本体被偷过之后，剩下的那部分才该被继承，
        //   否则等于把已经被玩家偷走的钱又变出来。
        //   为什么必须守恒：各拿全额 = 凭空双倍收入；拿 0 = 玩家正在追的钱凭空消失。
        //   余数（`wallet % N`）逐个 +1 分给前面的分身 —— 用整除会让总额少几个定点单位，
        //   而"分身钱包之和 == 本体剩余钱包"是一条**精确**断言，不能有零头。
        //   击杀奖励按 `bountyRatio × walletMax` 走，所以这里同时把 `walletMax`
        //   设为同一值：分身后的击杀奖励自然减半，无需特殊处理。
        const remainingWallet = e.walletRemaining;
        const walletShare = truncDiv(remainingWallet, splitCount);
        const walletOdd = remainingWallet - walletShare * splitCount;

        for (let i = 0; i < splitCount; i++) {
          const clone = makeEnemy(w, e.defId, e.pathIndex, Math.max(1, truncDiv(e.hpMax, 2)));
          if (!clone) continue;
          clone.pos.x = e.pos.x;
          clone.pos.y = e.pos.y;
          clone.segIndex = e.segIndex;
          const wallet = walletShare + (i < walletOdd ? 1 : 0);
          clone.walletRemaining = wallet;
          clone.walletMax = wallet;
          // ★ 一代即止：分身自己不能再分裂
          clone.canSplit = false;
          newborns.push(clone);
        }
      }
    }
  }

  enemies.length = write;
  for (const n of newborns) {
    enemies.push(n);
    w.enemyIndex.set(n.id, n);
    w.spawnedTotal++;
    w.enemiesSpawnedThisWave++;
  }

  if (w.lives <= 0 && w.status === 'running') {
    w.lives = 0;
    w.status = 'lost';
    emit(w, { type: 'gameOver', result: 'lose', wave: w.wave });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 经济（小精灵采木；窃金/击杀收入在结算点直接入账）
// ─────────────────────────────────────────────────────────────────────────────

function economySystem(w: WorldState): void {
  const rate = w.content.constants.tickRate;
  for (const t of w.towers) {
    const perSec = fmul(t.def.woodPerSecond, w.tech.woodMul); // 科技「基地等级」木材乘区
    if (perSec <= 0) continue;
    // 「每秒量 + 余数」累加，避免每 tick 截断造成的系统性少产
    const num = perSec + t.woodAccum;
    const add = truncDiv(num, rate);
    t.woodAccum = num - add * rate;
    if (add > 0) {
      w.wood += add;
      w.woodMinedTotal += add;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 波次状态机（波结束 / 通关）
// ─────────────────────────────────────────────────────────────────────────────

function waveSystem(w: WorldState): void {
  if (w.phase !== 'combat') return;
  if (w.spawnCursor < w.spawnQueue.length) return;
  if (w.enemies.length > 0) return;

  const stats: WaveStats = waveStatsOf(w);
  emit(w, { type: 'waveEnd', wave: w.wave, stats });
  // 契约 §13.1 / §13.2：再发一条 `waveStats`，让 UI 不必从 waveEnd 里掏数据
  // （二者语义等价、payload 相同；保留两条是为了不破坏既有的 waveEnd 消费者）。
  emit(w, { type: 'waveStats', stats });

  const def = findWave(w, w.wave);
  if (def) {
    w.gold += def.rewardGold;
    w.wood += def.rewardWood;
    w.earnedTotal += def.rewardGold;
  }

  if (w.wave >= w.waveTotal) {
    w.phase = 'done';
    w.status = 'won';
    emit(w, { type: 'gameOver', result: 'win', wave: w.wave });
    return;
  }

  w.wave++;
  w.phase = 'prep';
  const next = findWave(w, w.wave);
  w.prepTicksLeft = Math.max(1, ticksFromSeconds(next ? next.prepTime : 15000, w.content.constants.tickRate));
}
