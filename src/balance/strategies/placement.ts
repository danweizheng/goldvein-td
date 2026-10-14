/**
 * 选点模型（策略 AI 的「眼睛」）
 *
 * 策略 AI 只能通过 `WorldSnapshot` 读状态（契约 §4/§7），而**可建造格集合**不在快照里。
 * 因此本模块在开局时用 `src/sim/world.ts` 导出的 `computeBuildableCells` /
 * `rasterizePathCells`（只读复用，保证与模拟层判定完全一致）算一次候选格，
 * 再按「路径覆盖度 + ★停顿点距离」排序。
 *
 * 全程整数运算（定点 ×1000），不使用浮点。
 */
import { FIXED_SCALE, fmul, truncDiv, type Fixed } from '../../sim/fixed';
import { computeBuildableCells, isqrt, rasterizePathCells } from '../../sim/world';
import type { PathDef, SimContent } from '../../sim/content';
import type { Cell } from '../../sim/types';

/** 一个候选建造格。 */
export interface RankedCell {
  key: number;
  x: number;
  y: number;
  /** 半径 2 格内的路径采样点数（≈ 神偷 T5 射程 3 格的量级） */
  covNear: number;
  /** 半径 6 格内的路径采样点数（≈ 弓箭/炮塔射程） */
  covFar: number;
  /** 每条路的覆盖采样点数（下标 = 路径下标） */
  laneCov: number[];
  /** 到最近 ★停顿点的距离（格，定点） */
  haltDist: Fixed;
  score: number;
}

export interface PlacementModel {
  readonly laneCount: number;
  readonly paths: readonly PathDef[];
  readonly ranked: readonly RankedCell[];
  /** 塔所在格 → 该格覆盖最好的路径下标（-1 = 不覆盖任何路）。 */
  laneOf(cell: Cell): number;
  /**
   * 挑一个空格。
   * @param occupied 已占用格 key 集合
   * @param towers   已有塔的格子（用于「别扎堆」惩罚）
   * @param lane     目标路（-1 = 不限）；若该路没有可用格会自动放宽
   */
  pick(occupied: ReadonlySet<number>, towers: readonly Cell[], lane: number): Cell | null;
}

interface Sample {
  x: Fixed;
  y: Fixed;
  lane: number;
}

/** 0.5 格步长采样路径折线。 */
function samplePath(path: PathDef, lane: number, out: Sample[]): void {
  for (let i = 0; i + 1 < path.waypoints.length; i++) {
    const a = path.waypoints[i];
    const b = path.waypoints[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = isqrt(dx * dx + dy * dy);
    const steps = Math.max(1, truncDiv(len * 2, FIXED_SCALE));
    for (let s = 0; s <= steps; s++) {
      const t = truncDiv(s * FIXED_SCALE, steps);
      out.push({ x: a.x + fmul(dx, t), y: a.y + fmul(dy, t), lane });
    }
  }
}

/**
 * 摆位风格。
 *
 * - `uniform`（此前唯一实现）：沿路径摊开，靠覆盖采样数排序，并**惩罚扎堆**。
 * - `clustered`（新增，用于 ★停顿点 扫描）：向★停顿点**聚集**，扎堆改为**加分**。
 *
 * 为什么要这一维：策划案 §4.6 把★停顿点写成「**本项目对原作最重要的致敬**」——
 * 原作高手攻略的原话是「怪来的时候会在一个地方稍微有一下停顿，而这个位置恰好可以打到那里」，
 * 也就是**把窃金塔集中堆在停顿点上**，而不是均匀铺满路径。两种摆位在同一个停顿时长下
 * 的表现差异，就是"这个机制有没有被激活"的判据。
 */
export type PlacementMode = 'uniform' | 'clustered';

/** `clustered` 模式只考虑距★停顿点 ≤ 该半径的格（格，定点）。 */
const CLUSTER_RADIUS: Fixed = 3500;

export function buildPlacement(content: SimContent, laneCount: number, mode: PlacementMode = 'uniform'): PlacementModel {
  const width = content.grid.width;
  const samples: Sample[] = [];
  for (let i = 0; i < Math.min(laneCount, content.paths.length); i++) {
    const p = content.paths[i];
    if (p) samplePath(p, i, samples);
  }

  // ★停顿点（每路中段 1 处）
  const halts: Sample[] = content.paths.map((p, i) => {
    const wp = p.waypoints[p.haltIndex];
    return { x: wp ? wp.x : 0, y: wp ? wp.y : 0, lane: i };
  });

  const pathCells = rasterizePathCells(content);
  const buildable = computeBuildableCells(content, pathCells);

  const nearSq = 2000 * 2000;
  const farSq = 6000 * 6000;
  const ranked: RankedCell[] = [];

  for (const key of buildable) {
    const x = key % width;
    const y = truncDiv(key - x, width);
    const cx = x * FIXED_SCALE + 500;
    const cy = y * FIXED_SCALE + 500;

    let covNear = 0;
    let covFar = 0;
    const laneCov: number[] = new Array<number>(content.paths.length).fill(0);
    for (const s of samples) {
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= nearSq) {
        covNear++;
        laneCov[s.lane] = (laneCov[s.lane] as number) + 1;
      }
      if (d2 <= farSq) covFar++;
    }
    if (covNear === 0 && covFar === 0) continue;

    let haltDist = Number.MAX_SAFE_INTEGER;
    for (const h of halts) {
      const dx = h.x - cx;
      const dy = h.y - cy;
      const d = isqrt(dx * dx + dy * dy);
      if (d < haltDist) haltDist = d;
    }

    // 覆盖度为主，★停顿点距离为辅。
    // `clustered` 模式下把停顿点权重放大 10 倍 —— 这正是"把塔堆在停顿点"这个玩家行为。
    const haltBonusRaw = Math.max(0, 5000 - haltDist) / 5;
    const haltBonus = mode === 'clustered' ? haltBonusRaw * 10 : haltBonusRaw;
    const score = covNear * 1000 + Math.min(covFar, 200) * 5 + haltBonus;
    ranked.push({ key, x, y, covNear, covFar, laneCov, haltDist, score });
  }

  ranked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  const byKey = new Map<number, RankedCell>();
  for (const c of ranked) byKey.set(c.key, c);

  const pickCell = (occupied: ReadonlySet<number>, towers: readonly Cell[], lane: number): Cell | null => {
    for (const c of ranked) {
      if (c.covNear < 2) continue;
      if (occupied.has(c.key)) continue;
      // clustered 只考虑★停顿点附近的格；uniform 不限
      if (mode === 'clustered' && c.haltDist > CLUSTER_RADIUS) continue;
      if (lane >= 0 && (c.laneCov[lane] as number) === 0) continue;
      // uniform：扎堆**惩罚**（避免 40 座塔全挤在一处）
      // clustered：扎堆**加分**（这正是"把塔堆在停顿点"的行为）
      let s = c.score;
      for (const t of towers) {
        if (Math.max(Math.abs(t.x - c.x), Math.abs(t.y - c.y)) <= 2) s += mode === 'clustered' ? 2500 : -2500;
      }
      if (s <= 0) continue;
      return { x: c.x, y: c.y };
    }
    // 放宽路的约束再试一次
    if (lane >= 0) return pickCell(occupied, towers, -1);
    return null;
  };

  return {
    laneCount,
    paths: content.paths,
    ranked,
    laneOf(cell: Cell): number {
      const c = byKey.get(cell.y * width + cell.x);
      if (!c) return -1;
      let best = -1;
      let bestV = 0;
      for (let i = 0; i < c.laneCov.length; i++) {
        const v = c.laneCov[i] as number;
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      return best;
    },
    pick: pickCell,
  };
}

/** 从快照的塔列表算出已占用格 key 集合。 */
export function occupiedKeys(towers: readonly { cell: Cell }[], width: number): Set<number> {
  const out = new Set<number>();
  for (const t of towers) out.add(t.cell.y * width + t.cell.x);
  return out;
}
