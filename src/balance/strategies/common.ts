/**
 * 策略 AI 共用工具（全部整数运算）
 */
import type { Command } from '../../sim/commands';
import type { DifficultyId, SimContent, UnitDef } from '../../sim/content';
import type { Cell, TowerView, WorldSnapshot } from '../../sim/types';

/** 本难度开放的路数（策划案 §4.6：N1/N2 开 2 路，N3+ 开 4 路）。 */
export function laneCountOf(content: SimContent, diff: DifficultyId): number {
  const row = content.constants.difficulty[diff];
  return Math.max(1, Math.min(row ? row.paths : 1, content.paths.length));
}

/**
 * 根单位（= 可以直接 `build` 的建筑）。
 *
 * ★ 设计意图：只有升级树的叶子入口能直接建造，其它等级必须逐级 `upgrade`。
 *   sim 的 `cmdBuild` **不校验这一点** —— 任何 unitId 只要钱够、格子合法就能建。
 *   由于 T3+ 的单体造价 < 逐级累加造价（神偷 T5：25,000 vs 25,000+8,000+2,500+800+250 = 36,550），
 *   这形成一个「直达建造比升级更便宜」的经济漏洞。所有策略都**遵守设计意图**（只建根单位），
 *   该漏洞写进汇报，由主策划裁决 sim 是否要补门禁。
 */
export function rootUnitIds(content: SimContent): Set<string> {
  const targets = new Set<string>();
  for (const u of Object.values(content.units)) {
    if (u.upgradeTo) targets.add(u.upgradeTo);
  }
  const roots = new Set<string>();
  for (const u of Object.values(content.units)) {
    if (!targets.has(u.id)) roots.add(u.id);
  }
  return roots;
}

export function unitOf(content: SimContent, id: string): UnitDef | null {
  return content.units[id] ?? null;
}

export function costOf(content: SimContent, id: string): number {
  const u = content.units[id];
  return u ? u.costGold : Number.MAX_SAFE_INTEGER;
}

export function findTower(snap: WorldSnapshot, id: number): TowerView | null {
  for (const t of snap.towers) if (t.id === id) return t;
  return null;
}

/** 「领工资」：冷却好了就按（所有策略都按，属于玩家基本操作）。 */
export function salaryCommand(snap: WorldSnapshot): Command[] {
  for (const s of snap.skills) {
    if (s.id === 'salary' && s.ready) return [{ type: 'activateSkill', skillId: 'salary' }];
  }
  return [];
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 每条路的塔数（用于分路均衡）。 */
export function laneCounts(model: { laneOf(c: Cell): number }, towers: readonly TowerView[], lanes: number): number[] {
  const out = new Array<number>(lanes).fill(0);
  for (const t of towers) {
    const l = model.laneOf(t.cell);
    if (l >= 0 && l < lanes) out[l] = (out[l] as number) + 1;
  }
  return out;
}

export function argMin(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) < (values[best] as number)) best = i;
  }
  return best;
}

/** 展示用：定点 → 一位小数的百分比文本（只在报告层用，不参与模拟）。 */
export function pct1(pct: number): string {
  const whole = Math.trunc(pct / 10);
  const frac = Math.abs(pct - whole * 10);
  return `${whole}.${frac}%`;
}
