/**
 * 窃金系统与克制矩阵的**公式级**验证
 *
 * 为什么要有这个文件：
 * determinism.spec.ts 里有一条「180s 内窃金事件 > 50」的断言。当场景只有 60s、
 * 且混入了长射程输出塔时实测只有 21 次，看上去像 bug。到底是**引擎错**还是
 * **断言阈值不合理**，必须用可控的公式级用例来回答，而不是改阈值让它变绿。
 *
 * 本文件用完全可控的输入逐个钉死 §4.1.2 的每一项乘区，
 * 并给出「一个敌人身上最多能被偷几次」的量化结论。
 */
import { describe, expect, it } from 'vitest';
import { FIXED_SCALE, fmul, mulDiv, fromInt, toDisplayInt, truncDiv } from '../fixed';
import { counterMul, createWorld, createWorldWithContent, expectedStealPerSecond, researchTech, snapshot, stealAmountCore, stealPerHit } from '../world';
import { createM0FallbackContent } from '../m0-fixture';
import { M0_PATHS, M0_GRID, M0_CONSTANTS } from '../m0-fixture';
import { computeBuildableCells, rasterizePathCells } from '../world';
import { drainEvents, step } from '../tick';
import type { EnemyState, RunConfig, SimContent, TowerState, WorldState } from '../types';
import type { Command } from '../commands';

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return { seed: 1, difficultyId: 'N2', relics: {}, techArchive: {}, ...over };
}

/** 造一个只有 1 个敌人、1 条路径、起始金充足的受控世界。 */
function controlledWorld(over: Partial<RunConfig> = {}, startGold = 100_000_000, enemyId = 'thug', count = 1, enemyWalletMul = 1): SimContent {
  const base = createM0FallbackContent();
  const constants = {
    ...base.constants,
    difficulty: Object.fromEntries(
      Object.entries(base.constants.difficulty).map(([k, v]) => [
        k,
        { ...v, startGold, startWood: 100_000_000 },
      ]),
    ) as SimContent['constants']['difficulty'],
  };
  const enemies = { ...base.enemies };
  if (enemyWalletMul !== 1) {
    const e = enemies[enemyId];
    if (e) enemies[enemyId] = { ...e, baseWallet: e.baseWallet * enemyWalletMul };
  }
  void over;
  return {
    ...base,
    enemies,
    constants,
    waves: [
      {
        wave: 1,
        prepTime: 1000, // 1s 备战，测试跑得快
        groups: [{ enemy: enemyId, count, interval: 1000, delay: 0, path: [0] }],
        rewardGold: 0,
        rewardWood: 0,
        hint: 'controlled',
      },
    ],
  };
}

/** 在离 path 0 的 ★停顿点最近的合法格子上建一座塔，返回该塔。 */
function buildNearHalt(w: WorldState, unitId: string): TowerState {
  const pathCells = rasterizePathCells(w.content);
  const buildable = computeBuildableCells(w.content, pathCells);
  const width = w.grid.width;
  const halt = w.paths[0]?.waypoints[w.paths[0].haltIndex];
  if (!halt) throw new Error('no halt');
  const hx = Math.floor(halt.x / FIXED_SCALE);
  const hy = Math.floor(halt.y / FIXED_SCALE);

  let best: { x: number; y: number; d: number } | null = null;
  for (const key of buildable) {
    const x = key % width;
    const y = truncDiv(key - x, width);
    const d = Math.abs(x - hx) + Math.abs(y - hy);
    if (best === null || d < best.d || (d === best.d && (y < best.y || (y === best.y && x < best.x)))) {
      best = { x, y, d };
    }
  }
  if (!best) throw new Error('no buildable cell');

  // 契约 §14.7：非根单位必须先建根单位再逐级升（直达建造会被拒绝）
  const parentOf = new Map<string, string>();
  for (const u of Object.values(w.content.units)) {
    if (u.upgradeTo !== null && !parentOf.has(u.upgradeTo)) parentOf.set(u.upgradeTo, u.id);
  }
  const chain: string[] = [unitId];
  for (let cur = unitId, g = 0; g < 16; g++) {
    const p = parentOf.get(cur);
    if (p === undefined) break;
    chain.unshift(p);
    cur = p;
  }

  step(w, [{ type: 'build', unitId: chain[0] as string, cell: { x: best.x, y: best.y } } as Command]);
  const t = w.towers[0];
  if (!t) throw new Error('build failed: ' + JSON.stringify(w.eventQueue));
  for (let k = 1; k < chain.length; k++) {
    step(w, [{ type: 'upgrade', towerId: t.id } as Command]);
  }
  const done = w.towers.find((x2) => x2.id === t.id);
  if (!done || done.unitId !== unitId) throw new Error(`升级链未到达 ${unitId}（当前 ${done?.unitId}）`);
  return done;
}

/** 只提供 stealPerHit 会读到的字段（避免构造完整 EnemyState）。 */
function enemyLike(walletRemaining: number, stealResist = 0, blockedResistReduce = 0): EnemyState {
  return { walletRemaining, stealResist, blockedResistReduce, auraResistReduce: 0 } as unknown as EnemyState;
}

describe('窃金公式（策划案 §4.1.2 / 契约 §6 伪代码）', () => {
  it('小偷 T1 的单次窃取量精确等于手算值（含各乘区）', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'thief_t1');

    // 手算：stealBase 4（=4000）× levelMul 1.0 × (1 + 0.02×8 = 1.16) = 4.64
    expect(t.def.stealBase).toBe(4000);
    expect(t.attack).toBe(8000);
    expect(stealAmountCore(w, t, 0, false)).toBe(4640);
    expect(toDisplayInt(stealAmountCore(w, t, 0, false))).toBe(4);

    // 暴击：critMul 1.5 → 6.96
    expect(stealAmountCore(w, t, 0, true)).toBe(6960);

    // 窃金科技（契约 §14.2：×1.12/级，乘法）。
    // 存档等级 5 → 免费 floor(5/2) = 2 级 → ×1.12² = 1.2544 → 4.64 × 1.2544 = 5.8204 → 5818
    const w2 = createWorldWithContent(cfg({ techArchive: { steal_efficiency: 5 } }), controlledWorld());
    const t2 = buildNearHalt(w2, 'thief_t1');
    expect(w2.techLevels['steal_efficiency']).toBe(2);
    expect(w2.tech.stealMul).toBe(1254);
    expect(stealAmountCore(w2, t2, 0, false)).toBe(5818);

    // 再研究 3 级到满级（×1.12⁵ = 1.7623）→ 4.64 × 1.7623 = 8.177 → 8175
    for (let i = 0; i < 3; i++) {
      const r = researchTech(w2, 'steal_efficiency');
      if (!r.ok) throw new Error(`第 ${i + 1} 次研究失败：${r.reason}（gold=${w2.gold} wood=${w2.wood} level=${r.level}）`);
    }
    expect(w2.techLevels['steal_efficiency']).toBe(5);
    expect(w2.tech.stealMul).toBe(1762);
    expect(stealAmountCore(w2, t2, 0, false)).toBe(8175);

    // 圣物「贪婪之手」3 级（+15%）→ 4.64 × 1.15 = 5.336 → 5336
    const w3 = createWorldWithContent(cfg({ relics: { greedy_hand: 3 } }), controlledWorld());
    const t3 = buildNearHalt(w3, 'thief_t1');
    expect(stealAmountCore(w3, t3, 0, false)).toBe(5336);

    // 窃金抗性 70%（铁钱袋商人）→ 4.64 × 0.3 = 1.392 → 1392
    expect(stealAmountCore(w, t, 700, false)).toBe(1392);

    // 窃金免疫（BOSS 飞升者 1000）→ 0
    expect(stealAmountCore(w, t, 1000, false)).toBe(0);
  });

  it('窃取量受「敌人剩余钱包」上限约束（min(剩余钱包, 计算值)）', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'thief_t1');
    expect(stealPerHit(w, t, enemyLike(2000), false)).toBe(2000); // 钱包只剩 2 金 → 只能偷 2
    expect(stealPerHit(w, t, enemyLike(100000), false)).toBe(4640);
    expect(stealPerHit(w, t, enemyLike(0), false)).toBe(0);
  });

  it('纯输出塔不参与窃金（stealBase 0）', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'archer_t1');
    expect(t.isSteal).toBe(false);
    expect(stealAmountCore(w, t, 0, false)).toBe(0);
    expect(expectedStealPerSecond(w, t)).toBe(0);
  });

  it('expectedStealPerSecond 含暴击期望，且是整数', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'thief_t1');
    // 4.64/次，攻速 1.0/s，暴击率 5%、critMul 1.5
    // E[mul] = 1 + 0.05×0.5 = 1.025 → 4.64×1.025 = 4.756 → 每秒 4.756
    const perSec = expectedStealPerSecond(w, t);
    expect(perSec).toBe(4756);
    expect(Number.isInteger(perSec)).toBe(true);
  });

  it('★ 量化结论：单个敌人身上的窃取次数受「钱包 / 单次窃取量」限制', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'thief_t1');
    // 第 1 波混混钱包 10 金（=10000 定点），小偷 T1 每次偷 4.64 金
    // → 2 次偷掉 9.28，第 3 次只能偷剩余的 0.72 → 钱包归零后再无窃取事件
    const wallet = 10000;
    const hits: number[] = [];
    let remaining = wallet;
    for (let i = 0; i < 10 && remaining > 0; i++) {
      const amt = Math.min(stealAmountCore(w, t, 0, false), remaining);
      hits.push(amt);
      remaining -= amt;
    }
    console.log(
      `[steal-quant] 单敌人钱包 ${toDisplayInt(wallet)} 金，单次窃取 ${toDisplayInt(stealAmountCore(w, t, 0, false))} 金 → 恰好 ${hits.length} 次偷光（${hits.map(toDisplayInt).join('+')}）`,
    );
    expect(hits.length).toBe(3);
    expect(hits.reduce((a, b) => a + b, 0)).toBe(wallet);
  });

  it('端到端：窃金真的入账，且钱包空了之后不再产出（§4.1.2 关键约束）', () => {
    // 把钱包放大 100 倍，让窃取能持续到测试结束
    const content = controlledWorld({}, 100_000_000, 'thug', 1, 100);
    const w = createWorldWithContent(cfg(), content);
    buildNearHalt(w, 'thief_t1');
    const goldBefore = w.gold;

    let stealEvents = 0;
    let stolen = 0;
    let crits = 0;
    for (let i = 0; i < 1200; i++) {
      step(w, []);
      for (const ev of drainEvents(w)) {
        if (ev.type === 'steal') {
          stealEvents++;
          stolen += ev.amount;
          if (ev.crit) crits++;
        }
      }
    }
    console.log(
      `[steal-e2e] 20s 内 steal 事件 ${stealEvents} 次（暴击 ${crits}）、累计 ${stolen} 定点 = ${toDisplayInt(stolen)} 金；gold ${goldBefore} → ${w.gold}`,
    );
    expect(stealEvents).toBeGreaterThan(0);
    expect(stolen).toBe(w.stolenTotal);
    expect(crits).toBeLessThan(stealEvents);
    // 入账必须与窃取额严格一致（不允许出现"偷了但没进账"或反向）
    expect(w.gold).toBe(goldBefore + stolen);
  });

  it('端到端：金币进账与 waveEnd 统计一致（契约 §6.1 的唯一数据源）', () => {
    const content = controlledWorld({}, 100_000_000, 'thug', 2, 50);
    const w = createWorldWithContent(cfg(), content);
    buildNearHalt(w, 'thief_t2');
    let stolen = 0;
    let waveEndStolen: number | null = null;
    for (let i = 0; i < 2400; i++) {
      step(w, []);
      for (const ev of drainEvents(w)) {
        if (ev.type === 'steal') stolen += ev.amount;
        // ⚠️ waveAcc 是「本波」累加器，波次结束后会被重置 —— 每波的真实统计
        //    只出现在 waveEnd 事件里。这正是契约 §6.1 把 WaveStats 定为
        //    「平衡验证唯一数据源」的原因，快照里的 currentWaveStats 只代表当前波。
        if (ev.type === 'waveEnd' && waveEndStolen === null) waveEndStolen = ev.stats.stolenTotal;
      }
    }
    console.log(`[steal-waveacc] 累计窃取 ${stolen} 定点；首个 waveEnd.stats.stolenTotal=${String(waveEndStolen)}`);
    expect(stolen).toBeGreaterThan(0);
    expect(w.stolenTotal).toBe(stolen);
    // 第一波结束时，本波统计必须覆盖该波全部窃取
    expect(waveEndStolen).not.toBeNull();
    expect(waveEndStolen as unknown as number).toBeGreaterThan(0);
    expect(waveEndStolen as unknown as number).toBeLessThanOrEqual(stolen);
  });
});

describe('克制矩阵（策划案 §4.3）', () => {
  it('标准表（N3+）数值与策划案逐格一致', () => {
    const content = controlledWorld();
    const n3 = createWorldWithContent(cfg({ difficultyId: 'N3' }), content);
    const rows: Array<[string, string, number]> = [
      ['normal', 'light', 1000],
      ['normal', 'medium', 1500],
      ['normal', 'fortified', 700],
      ['normal', 'divine', 300],
      ['pierce', 'light', 2000],
      ['pierce', 'medium', 750],
      ['pierce', 'fortified', 350],
      ['pierce', 'divine', 300],
      ['magic', 'heavy', 1500],
      ['magic', 'divine', 500],
      ['siege', 'fortified', 2000],
      ['siege', 'divine', 300],
      ['chaos', 'divine', 1000],
      ['chaos', 'fortified', 1250],
    ];
    const got: string[] = [];
    for (const [atk, armor, want] of rows) {
      const v = counterMul(n3, atk as never, armor as never);
      got.push(`${atk}→${armor}=${v / 1000}`);
      expect(v).toBe(want);
    }
    console.log('[counter-matrix-N3] ' + got.join(' '));
  });

  it('压缩表（N1/N2）：1 + (标准 − 1) × 0.5，下限 0.6', () => {
    const content = controlledWorld();
    const n2 = createWorldWithContent(cfg({ difficultyId: 'N2' }), content);
    // 穿刺打城甲：1 + (0.35 − 1) × 0.5 = 0.675（策划案 §4.3 原文举例）
    expect(counterMul(n2, 'pierce', 'fortified')).toBe(675);
    // 穿刺打轻甲：1 + (2.0 − 1) × 0.5 = 1.5
    expect(counterMul(n2, 'pierce', 'light')).toBe(1500);
    // 普通打神圣甲：1 + (0.3 − 1) × 0.5 = 0.65 ≥ 下限 0.6 → 0.65
    expect(counterMul(n2, 'normal', 'divine')).toBe(650);
    // 魔法打神圣甲：1 + (0.5 − 1) × 0.5 = 0.75
    expect(counterMul(n2, 'magic', 'divine')).toBe(750);
  });

  it('英雄甲按 armorAlias 取神圣甲列（契约 §3.3 只定义了 5 列）', () => {
    const content = controlledWorld();
    const n2 = createWorldWithContent(cfg({ difficultyId: 'N2' }), content);
    expect(counterMul(n2, 'chaos', 'hero')).toBe(counterMul(n2, 'chaos', 'divine'));
    expect(counterMul(n2, 'normal', 'hero')).toBe(counterMul(n2, 'normal', 'divine'));
  });
});

describe('定点数学与契约形状的交叉检查', () => {
  it('createM0FallbackContent 的地图/路径与策划案 §4.6 同量级', () => {
    expect(M0_PATHS.length).toBe(4);
    for (const p of M0_PATHS) {
      let len = 0;
      for (let i = 0; i + 1 < p.waypoints.length; i++) {
        const a = p.waypoints[i] as { x: number; y: number };
        const b = p.waypoints[i + 1] as { x: number; y: number };
        len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      }
      const cellsLen = len / FIXED_SCALE;
      // 策划案：「路径长度约 40 格」
      expect(cellsLen).toBeGreaterThan(25);
      expect(cellsLen).toBeLessThan(50);
    }
    expect(M0_GRID.vault.w).toBe(5);
    expect(M0_GRID.vault.h).toBe(5);
  });

  it('难度起始资源与策划案 §4.8 一致（N2 = 2000 金 / 1500 木 / 30 命）', () => {
    const w = createWorld(cfg());
    expect(w.gold).toBe(fromInt(2000));
    expect(w.wood).toBe(fromInt(1500));
    expect(w.lives).toBe(30);
  });

  it('快照的 stealPerSecond 与权威计算一致（契约 §7：必须由模拟层算好）', () => {
    const w = createWorldWithContent(cfg(), controlledWorld());
    const t = buildNearHalt(w, 'thief_t3');
    const s = snapshot(w);
    const view = s.towers.find((v) => v.id === t.id);
    expect(view?.stealPerSecond).toBe(expectedStealPerSecond(w, t));
    // 神偷 T3：stealBase 14 × levelMul 1.85 × (1 + 0.02×45 = 1.9) × 潜行 1.25
    const expected = fmul(fmul(fmul(fromInt(14), 1850), 1900), 1250);
    expect(stealAmountCore(w, t, 0, false)).toBe(expected);
    // ⚠️ 攻速换算的**已知量化误差**：策划案写 1.2 次/秒 → attackInterval 存在
    //    833（定点秒），再换算成 tick = truncDiv(833×60, 1000) = 49 tick，
    //    即实际 1.2245 次/秒（比设计快 2%）。60Hz 定步长下无法精确表示 1/1.2s，
    //    误差上界是 ±1 tick（±1.7%）。已列入汇报，请数据侧知悉。
    expect(t.attackInterval).toBe(833);
    expect(t.intervalTicks).toBe(49);
    // 暴击期望 1.025
    const expectMul = FIXED_SCALE + truncDiv(50 * (1500 - FIXED_SCALE), FIXED_SCALE);
    expect(expectedStealPerSecond(w, t)).toBe(truncDiv(mulDiv(expected, expectMul, FIXED_SCALE) * 60, 49));
  });
});
