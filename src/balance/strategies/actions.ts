/**
 * 「价值动作」采集器 —— `heuristic` 的全部决策，也是 `balanced` 清单饱和后的兜底
 *
 * 把四类可选动作统一成一个候选集，按**价值密度**（价值 / 金币）降序排：
 *
 * | 动作 | 指令 | 价值来源 |
 * |---|---|---|
 * | 建造根单位 | `build` | 窃金/秒 + 折算后的 DPS + 木材价值 |
 * | 升级已有塔 | `upgrade` | 新单位价值 − 当前单位价值 |
 * | **研究科技** | `research` | 契约 §14.2：`×1.50/级` 的指数通道，按军队总价值的比例增益算 |
 * | 产木单位（小精灵） | `build` | 木价值（科技树全解锁需 26,670 木，是硬约束） |
 *
 * 只读 `WorldSnapshot`；产出契约 §5 的 `Command`；全整数。
 */
import type { Command } from '../../sim/commands';
import { FIXED_SCALE, truncDiv } from '../../sim/fixed';
import type { AttackType, SimContent, UnitDef } from '../../sim/content';
import type { Cell } from '../../sim/types';
import { buildPlacement, occupiedKeys, type PlacementMode, type PlacementModel } from './placement';
import { laneCountOf, rootUnitIds, salaryCommand } from './common';
import {
  armyValueOf,
  density,
  techOptions,
  towerMix,
  valueOf,
  weightsFor,
  type ValueWeights,
} from './value';
import type { StrategyInput } from './types';

export type ActionKind = 'build' | 'upgrade' | 'research';

export interface Action {
  kind: ActionKind;
  /** build/upgrade = 目标单位 id；research = 科技线 id */
  unitId: string;
  towerId: number;
  density: number;
}

export interface ValueBrain {
  /** 本 tick 的候选动作（已按价值密度降序；同分按 unitId 字典序，保证确定性）。 */
  candidates(input: StrategyInput): Action[];
  /** 把动作翻译成指令（build 会在这里选格子；选不到返回 null）。 */
  commandFor(input: StrategyInput, action: Action): Command | null;
  /** 当前权重（诊断/报告用）。 */
  currentWeights(): ValueWeights;
  /** 诊断：最近一次决策的候选数与原因 */
  stats(): { candidates: number; towers: number; lanes: number; weights: ValueWeights };
}

export interface BrainOptions {
  /** 是否允许建造军训系塔 */
  allowBlock: boolean;
  /**
   * ★ **只允许这些塔系**（`UnitDef.line`）—— 用于「护甲克制假设」的对照实验。
   * 空/未设 = 不限。
   *
   * 关键设计：**窃金塔（经济）不受此限制**。实验要隔离的是「输出类型选错」，
   * 不是「没有经济」—— 若把经济也一起禁掉，实验就变成了"没钱会怎样"，那是另一回事。
   */
  allowedAttackTypes?: readonly AttackType[];
  /** 是否研究科技（`noop` 关掉） */
  allowTech: boolean;
  /** 只允许这些 tag 的单位（缺省不限）——见 `sprite` 与 `noop` 的用法 */
  allowUnit?: (u: UnitDef) => boolean;
  /** 只允许这些科技线 */
  allowTechId?: (id: string) => boolean;
  /**
   * 建造饱和因子：塔数越多，再铺一座新塔的**实际**边际收益越低（射程重叠、
   * 路径被重复覆盖）。不建模会让 AI 无限铺最便宜的塔而永不升级。
   */
  buildSaturation?: boolean;
  /** 摆位风格（契约 §16 扫描用） */
  placement?: PlacementMode;
}

const EMPTY_WEIGHTS: ValueWeights = { stealW: 1, dpsW: 1, reason: '初始化' };

export function createValueBrain(opts: BrainOptions): ValueBrain {
  let model: PlacementModel | null = null;
  let roots: Set<string> | null = null;
  let startLives = 0;
  let lastWave = -1;
  let weights: ValueWeights = EMPTY_WEIGHTS;
  let lastCandidates = 0;

  function ensure(input: StrategyInput): void {
    if (model) return;
    const lanes = laneCountOf(input.content, input.difficultyId);
    model = buildPlacement(input.content, lanes, opts.placement ?? 'uniform');
    roots = rootUnitIds(input.content);
    const row = input.content.constants.difficulty[input.difficultyId];
    startLives = row ? row.lives : Math.max(1, input.snap.lives);
  }

  function commandFor(input: StrategyInput, action: Action): Command | null {
    if (action.kind === 'research') return { type: 'research', techId: action.unitId };
    if (action.kind === 'upgrade') return { type: 'upgrade', towerId: action.towerId };
    const m = model as PlacementModel;
    const snap = input.snap;
    const cells: Cell[] = snap.towers.map((t) => t.cell);
    const occupied = occupiedKeys(snap.towers, input.content.grid.width);
    const counts = new Array<number>(m.laneCount).fill(0);
    for (const c of cells) {
      const l = m.laneOf(c);
      if (l >= 0 && l < m.laneCount) counts[l] = (counts[l] as number) + 1;
    }
    let lane = 0;
    for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[lane] as number)) lane = i;
    const cell = m.pick(occupied, cells, lane);
    if (!cell) return null;
    return { type: 'build', unitId: action.unitId, cell };
  }

  return {
    candidates(input: StrategyInput): Action[] {
      ensure(input);
      const snap = input.snap;
      const m = model as PlacementModel;
      const rootSet = roots as Set<string>;

      if (snap.wave !== lastWave) {
        lastWave = snap.wave;
        weights = weightsFor(snap, snap.currentWaveStats.leaks, startLives, towerMix(input.content, snap), m.laneCount * 2, snap.currentWaveStats.stealCoverage);
      }

      const allowedAtk = opts.allowedAttackTypes;
  // 输出攻击类型白名单（克制矩阵就是按 attackType 索引的）：窃金塔（经济）永远放行
  const lineOk = (def: UnitDef): boolean => {
    if (!allowedAtk || allowedAtk.length === 0) return true;
    if (def.isSteal) return true;
    return allowedAtk.includes(def.attackType);
  };

  const actions: Action[] = [];

      // ── 建造（只建根单位：设计不变量 + 契约 §14.7 已由 sim 强制）──
      const buildFactor = opts.buildSaturation
        ? Math.max(600, FIXED_SCALE - truncDiv(snap.towers.length * FIXED_SCALE, m.laneCount * 8))
        : FIXED_SCALE;
      if (snap.population < snap.populationCap) {
        for (const uid of rootSet) {
          const def: UnitDef | undefined = input.content.units[uid];
          if (!def) continue;
          if (def.block > 0 && !opts.allowBlock) continue;
          if (opts.allowUnit && !opts.allowUnit(def)) continue;
          if (!lineOk(def)) continue; // ★ 输出系别白名单（窃金塔放行）
          if (def.costGold > snap.gold || def.costWood > snap.wood) continue;
          const v = valueOf(input.content, input.difficultyId, def, def.attack, snap, weights);
          if (v <= 0) continue;
          actions.push({
            kind: 'build',
            unitId: uid,
            towerId: -1,
            density: density(truncDiv(v * buildFactor, FIXED_SCALE), Math.max(1, def.costGold)),
          });
        }
      }

      // ── 升级 ──
      for (const t of snap.towers) {
        const cur: UnitDef | undefined = input.content.units[t.unitId];
        if (!cur || !cur.upgradeTo) continue;
        const next: UnitDef | undefined = input.content.units[cur.upgradeTo];
        if (!next) continue;
        if (next.block > 0 && !opts.allowBlock) continue;
        if (opts.allowUnit && !opts.allowUnit(next)) continue;
        if (!lineOk(next)) continue; // ★ 输出系别白名单（窃金塔放行）
        if (next.costGold > snap.gold || next.costWood > snap.wood) continue;
        const vNow = valueOf(input.content, input.difficultyId, cur, t.attack, snap, weights);
        const vNext = valueOf(input.content, input.difficultyId, next, next.attack, snap, weights);
        const gain = vNext - vNow;
        if (gain <= 0) continue;
        actions.push({ kind: 'upgrade', unitId: next.id, towerId: t.id, density: density(gain, Math.max(1, next.costGold)) });
      }

      // ── 研究科技（契约 §14.2：唯一的指数通道）──
      if (opts.allowTech) {
        const army = armyValueOf(input.content, input.difficultyId, snap, weights);
        for (const t of techOptions(input.content, snap, army)) {
          if (opts.allowTechId && !opts.allowTechId(t.techId)) continue;
          actions.push({ kind: 'research', unitId: t.techId, towerId: -1, density: t.density });
        }
      }

      actions.sort((a, b) => b.density - a.density || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
      lastCandidates = actions.length;
      return actions;
    },
    commandFor,
    currentWeights(): ValueWeights {
      return weights;
    },
    stats() {
      return { candidates: lastCandidates, towers: 0, lanes: model ? model.laneCount : 0, weights };
    },
  };
}

/** 「领工资」——所有策略都按（玩家基本操作）。 */
export { salaryCommand };
export type { SimContent };
