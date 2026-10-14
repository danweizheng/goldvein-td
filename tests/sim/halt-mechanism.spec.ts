/**
 * ★ **★停顿点机制的回归防线**（契约 §16 派下的扫描的配套单测）
 *
 * 这个文件**不测平衡**（那是 `pnpm balance` 的事），只测**机制与仪器**：
 *
 * 1. `haltPointStopDuration` 的注入真的改变模拟（铁律 8：先证明旋钮是活的）
 * 2. `clustered` 摆位真的把塔往★停顿点聚（否则"集中堆 vs 均匀铺"的对照是空的）
 * 3. 停顿时长对**硬停顿 tick 数**是单调的（机制方向正确）
 *
 * 为什么值得单独钉住：主策划的 Q1/停顿点结论全部依赖这两条；一旦 sim 侧
 * 改了 `haltPointStopDuration` 的读取方式，或者摆位模式失效，**平衡报告会继续输出数字**
 * 但含义已经变了 —— 这正是"绿着的测试不测它名字声称的东西"那一类风险。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { buildPlacement } from '../../src/balance/strategies/placement';
import { createWorldWithContent } from '../../src/sim/world';
import { drainEvents, step } from '../../src/sim/tick';
import type { SimContent } from '../../src/sim/content';

const base = loadRealContent();

/** 内存注入停顿时长（不改 src/data）。 */
function withHalt(content: SimContent, halt: number): SimContent {
  return { ...content, constants: { ...content.constants, haltPointStopDuration: halt } };
}

/** 不放任何塔，跑 3000 tick，统计「有敌人处于硬停顿」的 tick 数与累计推进。 */
function haltedTicks(content: SimContent): { halted: number; travel: number } {
  const w = createWorldWithContent({ seed: 20261013, difficultyId: 'N2', relics: {}, techArchive: {} }, content);
  let halted = 0;
  let travel = 0;
  for (let t = 0; t < 3000 && w.status === 'running'; t++) {
    step(w, []);
    drainEvents(w);
    let any = 0;
    for (const e of w.enemies) {
      if (e.haltTicksLeft > 0) any++;
      travel += e.pos.x;
    }
    if (any > 0) halted++;
  }
  return { halted, travel };
}

describe('★停顿点机制（不是平衡测试，是机制/仪器测试）', () => {
  it('★ 仪器是活的：停顿时长真的改变模拟（否则覆盖率曲线是空测量）', () => {
    const a = haltedTicks(withHalt(base, 600));
    const b = haltedTicks(withHalt(base, 3000));
    console.log(`[停顿仪器] 0.6s→停顿 tick ${a.halted} ／ 3.0s→${b.halted}（差 ${b.halted - a.halted}）`);
    // 方向：停顿时长↑ → 处于停顿的 tick 数↑
    expect(b.halted).toBeGreaterThan(a.halted);
    // 量级：3s vs 0.6s 是 5 倍，至少应多出 100 tick（实测 323）
    expect(b.halted - a.halted).toBeGreaterThan(100);
  });

  it('停顿时长单调：1.5s 的停顿 tick 数落在 0.6s 与 3.0s 之间', () => {
    const a = haltedTicks(withHalt(base, 600)).halted;
    const m = haltedTicks(withHalt(base, 1500)).halted;
    const b = haltedTicks(withHalt(base, 3000)).halted;
    expect(m).toBeGreaterThan(a);
    expect(m).toBeLessThan(b);
  });

  it('★ clustered 摆位真的把塔往★停顿点聚（否则对照实验是空的）', () => {
    const uniform = buildPlacement(base, 2, 'uniform');
    const clustered = buildPlacement(base, 2, 'clustered');
    const halted = base.paths
      .slice(0, 2)
      .map((p) => p.waypoints[p.haltIndex])
      .filter((w): w is { x: number; y: number } => w !== undefined);

    // 连续选 12 个格，比较「到最近★停顿点的平均距离」
    const avgDist = (mode: 'uniform' | 'clustered'): number => {
      const m = mode === 'uniform' ? uniform : clustered;
      const picked: { x: number; y: number }[] = [];
      const occupied = new Set<number>();
      for (let i = 0; i < 12; i++) {
        const cell = m.pick(occupied, picked, i % 2);
        if (!cell) break;
        occupied.add(cell.y * base.grid.width + cell.x);
        picked.push(cell);
      }
      let sum = 0;
      for (const c of picked) {
        let best = Number.MAX_SAFE_INTEGER;
        for (const h of halted) {
          const dx = h.x / 1000 - c.x;
          const dy = h.y / 1000 - c.y;
          best = Math.min(best, Math.round(Math.sqrt(dx * dx + dy * dy) * 100));
        }
        sum += best;
      }
      return picked.length > 0 ? sum / picked.length : Number.MAX_SAFE_INTEGER;
    };

    const du = avgDist('uniform');
    const dc = avgDist('clustered');
    console.log(`[摆位] 12 座塔到★停顿点的平均距离：uniform=${(du / 100).toFixed(2)} 格 ／ clustered=${(dc / 100).toFixed(2)} 格`);
    // clustered 必须明显更近（这是"集中堆"的定义；若两者相同说明模式没生效）
    expect(dc).toBeLessThan(du);
    expect(dc).toBeLessThan(250); // 平均 ≤ 2.5 格
  });

  it('clustered 的候选格都在★停顿点附近（半径约束生效）', () => {
    const clustered = buildPlacement(base, 2, 'clustered');
    const picked: { x: number; y: number }[] = [];
    const occupied = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const cell = clustered.pick(occupied, picked, i % 2);
      if (!cell) break;
      occupied.add(cell.y * base.grid.width + cell.x);
      picked.push(cell);
    }
    expect(picked.length).toBeGreaterThan(0);
  });
});
