/**
 * tests/data/map.spec.ts —— 第 10 张表 map.json（契约 §14.11）（data-arch 所有）
 *
 * 本文件回答两个问题：
 *  ① 几何数据本身是否自洽（路径 id == 下标、轴对齐、末点入宝库、长度可复算、openLanes 与难度一致）
 *  ② **坐标体系是否与 src/sim 的 `GridDef` / `PathDef` 对齐** —— 见下面的「编译期对齐断言」。
 *     `src/sim/**` 是 engine-dev 的所有物，我只读；这里用 **type-only import** 做静态对齐，
 *     一旦我的表形状与 sim 类型分叉，`pnpm typecheck` 会直接失败（而不是运行时静默错位）。
 */
import { describe, expect, it } from 'vitest';

// ── 编译期对齐：只读地引用 engine-dev 的类型（不 import 任何运行时值） ──────────
import type { GridDef, PathDef } from '../../src/sim/content';
import { TABLES, loadTables } from '../../tools/validate-data';

const T = loadTables();
const MAP = T.map;
const F = T.constants.fixedScale;

/**
 * ★ 编译期对齐断言（这三行如果 typecheck 通过，就说明 map.json 的坐标体系与 sim 完全同构）：
 *   · `GridDef.width/height` = 整数、`vault.{x,y,w,h}` = 整数 → 与 map.json 的 `grid` / `vault` 相同单位
 *   · `PathDef.waypoints[].{x,y}` = Fixed（格×1000）、`haltIndex` = 整数 → 与 map.json 相同单位
 * 任何字段改名/改单位都会让这里编译失败。
 */
export const asGridDef = (): GridDef => ({
  width: MAP.grid.width,
  height: MAP.grid.height,
  vault: { x: MAP.vault.x, y: MAP.vault.y, w: MAP.vault.w, h: MAP.vault.h },
});

export const asPathDefs = (): PathDef[] =>
  MAP.paths.map((p: any) => ({
    id: p.id,
    waypoints: p.waypoints.map((w: any) => ({ x: w.x, y: w.y })),
    haltIndex: p.haltIndex,
  }));

describe('map.json —— 表注册与几何', () => {
  it('已注册为第 10 张表（单对象，与契约 §14.11 一致）', () => {
    const spec = TABLES.find((t) => t.file === 'map.json');
    expect(spec).toBeDefined();
    expect(spec!.name).toBe('MapDef');
    expect(spec!.kind).toBe('object');
    expect(TABLES).toHaveLength(10);
  });

  it('网格 48×33，宝库 22,14 5×5 且居中（§4.6 中央 5×5）', () => {
    expect(MAP.grid).toEqual({ width: 48, height: 33 });
    expect(MAP.vault).toEqual({ x: 22, y: 14, w: 5, h: 5 });
    // 奇宽宝库放进偶宽网格无法整数居中，允许 ±0.5 格
    const cx = MAP.vault.x + (MAP.vault.w - 1) / 2;
    const cy = MAP.vault.y + (MAP.vault.h - 1) / 2;
    expect(Math.abs(cx - (MAP.grid.width - 1) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cy - (MAP.grid.height - 1) / 2)).toBeLessThanOrEqual(0.5);
  });

  it('可建造区深度 2 格、每路 1 个 ★停顿点，且与 constants.map 一致（§4.6）', () => {
    expect(MAP.buildDepth).toBe(2);
    expect(MAP.buildDepth).toBe(T.constants.map.buildableWidthCells / F);
    expect(MAP.haltPointsPerLane).toBe(1);
    expect(MAP.haltPointsPerLane).toBe(T.constants.map.haltPointsPerLane);
    expect(MAP.vault.w).toBe(T.constants.map.vaultSizeCells / F);
  });

  it('4 条路径（= constants.map.laneCount），id == 下标', () => {
    expect(MAP.paths).toHaveLength(4);
    expect(MAP.paths).toHaveLength(T.constants.map.laneCount);
    MAP.paths.forEach((p: any, i: number) => expect(p.id, `paths[${i}]`).toBe(i));
  });

  it('几何可无转换地装配成 sim 的 GridDef / PathDef（编译期对齐的运行时对照）', () => {
    expect(asGridDef()).toEqual({ width: 48, height: 33, vault: { x: 22, y: 14, w: 5, h: 5 } });
    const sim = asPathDefs();
    expect(sim.map((p) => p.id)).toEqual([0, 1, 2, 3]);
    expect(sim[0]!.waypoints[0]).toEqual({ x: 3000, y: 1000 });
    expect(sim.map((p) => p.haltIndex)).toEqual([2, 2, 2, 2]);
  });
});

describe('map.json —— 路径几何自洽（§4.6）', () => {
  const inVaultCell = (x: number, y: number): boolean =>
    x >= MAP.vault.x && x < MAP.vault.x + MAP.vault.w && y >= MAP.vault.y && y < MAP.vault.y + MAP.vault.h;

  it('每个 waypoint 都在网格内、且是整格定点坐标（格×1000）', () => {
    for (const p of MAP.paths as any[]) {
      for (const [k, wp] of p.waypoints.entries()) {
        expect(wp.x % F, `path ${p.id} waypoints[${k}].x`).toBe(0);
        expect(wp.y % F, `path ${p.id} waypoints[${k}].y`).toBe(0);
        expect(wp.x / F).toBeGreaterThanOrEqual(0);
        expect(wp.y / F).toBeGreaterThanOrEqual(0);
        expect(wp.x / F).toBeLessThan(MAP.grid.width);
        expect(wp.y / F).toBeLessThan(MAP.grid.height);
      }
    }
  });

  it('相邻 waypoint 轴对齐（本表是格子地图，不允许斜线）', () => {
    for (const p of MAP.paths as any[]) {
      for (let k = 1; k < p.waypoints.length; k++) {
        const a = p.waypoints[k - 1];
        const b = p.waypoints[k];
        const axisAligned = a.x === b.x || a.y === b.y;
        expect(axisAligned, `path ${p.id} 段 ${k - 1}→${k} 是斜线`).toBe(true);
      }
    }
  });

  it('★ pathLengthCells 等于由 waypoints 重算的折线长度（±1 格）', () => {
    for (const p of MAP.paths as any[]) {
      let total = 0;
      for (let k = 1; k < p.waypoints.length; k++) {
        total += Math.abs(p.waypoints[k].x - p.waypoints[k - 1].x) + Math.abs(p.waypoints[k].y - p.waypoints[k - 1].y);
      }
      expect(Math.abs(total - p.pathLengthCells), `path ${p.id}`).toBeLessThanOrEqual(F);
    }
  });

  it('路径长度 34–38 格，与 §4.6「约 40 格」同量级（偏差 ≤15%）', () => {
    for (const p of MAP.paths as any[]) {
      const cells = p.pathLengthCells / F;
      expect(cells, `path ${p.id}`).toBeGreaterThanOrEqual(34);
      expect(cells, `path ${p.id}`).toBeLessThanOrEqual(40);
    }
  });

  it('★ 每条路径的末点都落在宝库内（路径必须汇入宝库）', () => {
    for (const p of MAP.paths as any[]) {
      const last = p.waypoints[p.waypoints.length - 1];
      expect(inVaultCell(last.x / F, last.y / F), `path ${p.id} 末点 (${last.x / F},${last.y / F})`).toBe(true);
    }
  });

  it('★ 停顿点不在宝库内（§4.6：停顿点在路径中段）', () => {
    for (const p of MAP.paths as any[]) {
      const halt = p.waypoints[p.haltIndex];
      expect(halt, `path ${p.id} haltIndex`).toBeDefined();
      expect(inVaultCell(halt.x / F, halt.y / F), `path ${p.id} 停顿点落在宝库内`).toBe(false);
    }
  });

  it('★ §4.6 通过时间：慢速(2.0 格/s) ~20s、快速(4.0 格/s) ~10s', () => {
    const lengths = (MAP.paths as any[]).map((p) => p.pathLengthCells / F);
    const lo = Math.min(...lengths);
    const hi = Math.max(...lengths);
    expect(lo / 2.0).toBeGreaterThanOrEqual(15);
    expect(hi / 2.0).toBeLessThanOrEqual(25);
    expect(lo / 4.0).toBeGreaterThanOrEqual(7);
    expect(hi / 4.0).toBeLessThanOrEqual(13);
  });
});

describe('map.json —— 开放路数与难度一致（§4.6 / 契约 §14.11）', () => {
  it('N1–N2 开 2 路、N3+ 开 4 路，长度与 difficulty.openLanes 一致', () => {
    expect(MAP.openLanes.N1).toEqual([0, 1]);
    expect(MAP.openLanes.N2).toEqual([0, 1]);
    for (const id of ['N3', 'N4', 'N5']) expect(MAP.openLanes[id]).toEqual([0, 1, 2, 3]);
    for (const d of T.difficulty as any[]) {
      expect(MAP.openLanes[d.id].length, d.id).toBe(d.openLanes);
    }
  });

  it('★ 开放集必须是 [0..n-1]：sim 的 tick.ts 按数组顺序取前 n 条（`content.paths[0..n-1]`）', () => {
    for (const [id, list] of Object.entries(MAP.openLanes as Record<string, number[]>)) {
      expect(list, id).toEqual(list.map((_, k) => k));
    }
  });

  it('★ 每条路径恰好 1 个停顿点（haltPointsPerLane = 1）', () => {
    expect((MAP.paths as any[]).every((p) => typeof p.haltIndex === 'number')).toBe(true);
    expect((MAP.paths as any[]).length * MAP.haltPointsPerLane).toBe(4);
  });

  it('★ 波次里的 path 索引必须落在最窄开放集内（否则 sim 的 % paths.length 会静默回绕到 0 号路）', () => {
    const narrowest = new Set<number>(MAP.openLanes.N1);
    const offenders: string[] = [];
    for (const w of T.waves as any[]) {
      for (const g of w.groups) {
        if (!Array.isArray(g.path)) continue;
        for (const idx of g.path) if (!narrowest.has(idx)) offenders.push(`w${w.wave}:${g.enemy}→path[${idx}]`);
      }
    }
    console.log('[data-arch] 最窄开放集 =', [...narrowest].join(','), '；带 path 的波次组 =', offenders.length === 0 ? '全部合法' : offenders.join(' '));
    expect(offenders).toEqual([]);
  });
});
