/**
 * 「建造计划」引擎 —— `balanced` / `noblock` / `noop` 都用它
 *
 * 一个**普通玩家**的模型：手里有一张按优先级排好的清单（建造 / 升级 / **研究科技**），
 * 每个决策点从上往下找**第一个买得起**的条目执行；买不起就攒钱，不会跳过昂贵的关键条目。
 *
 * 为什么不做「比例分配」的连续优化：策划案 §10.2 说 `balanced` 是「按固定比例分配
 * （经济 40% / 辅助 20% / 输出 40%）」。实现上如果每个决策点都按累计占比选类别，
 * 会在第 1 波就把 20% 的预算砸在军训系上（350 金的教官 > 开局能承担的量），
 * 得到的不是「普通玩家」而是「按比例乱花的玩家」。因此把它实现成**满足占比的清单**，
 * 占比由 `report.ts` 实测并核对。
 *
 * 契约 §14.2 之后，清单多了一类条目：**科技**（`research` 指令）。
 * 没有它，AI 永远不会升科技 → 满科技配置根本不会发生 → 跑批测的仍是「无科技」的世界。
 *
 * 全部整数运算；决策只读 `WorldSnapshot`；产出 `Command`。
 */
import type { Command } from '../../sim/commands';
import type { SimContent } from '../../sim/content';
import { FIXED_SCALE, type Fixed } from '../../sim/fixed';
import type { Cell, TowerView, WorldSnapshot } from '../../sim/types';
import { buildPlacement, occupiedKeys, type PlacementMode, type PlacementModel } from './placement';
import { argMin, findTower, laneCountOf, sameCell, salaryCommand, unitOf } from './common';
import type { Strategy, StrategyId, StrategyInput } from './types';

/** 清单分类（用于核对 §14.12 的支出占比目标）。 */
export type PlanTag = 'economy' | 'output' | 'support' | 'tech' | 'wood';

export interface PlanStep {
  key: string;
  kind: 'build' | 'upgrade' | 'research';
  /** build = 要造的单位；upgrade = 升级后的目标单位；research = 目标科技线 id */
  unitId: string;
  /** 目标路（0-based；-1 = 不限；research 恒为 -1） */
  lane: number;
  /** upgrade 用：要升级的那座塔的 step key */
  afterKey?: string;
  minWave?: number;
  tag: PlanTag;
}

export interface PlanStrategyOptions {
  id: StrategyId;
  label: string;
  description: string;
  /** 生成清单（只知道路数与内容，不读世界状态） */
  plan(ctx: { lanes: number; content: SimContent }): PlanStep[];
  /** 摆位风格（契约 §16 扫描用） */
  placement?: PlacementMode;
}

interface Inflight {
  step: PlanStep;
  tick: number;
  kind: 'build' | 'upgrade' | 'research';
  towerId: number;
  cell: Cell | null;
  /** research 用：发指令时的等级，用于验证「升了一级」 */
  levelAtIssue: number;
}

/** 给上层（balanced 的兜底逻辑 / 报告）看的清单状态。 */
export interface PlanScan {
  /** 清单里存在「其它条件都满足、只差钱/木」的条目 → 上层应该攒钱而不是另花钱。 */
  savingForStep: boolean;
  doneCount: number;
  totalCount: number;
}

const RETRY_TICKS = 3;

/**
 * 「攒钱」的容忍倍数（千分比定点）：当清单里**优先级最高**的未完成条目买不起、
 * 但造价不超过 `当前金币 × 3 + 500 金` 时，**停下来攒钱**而不是跳过去买更便宜的条目。
 *
 * 没有这条约束会出现一个反直觉的退化：清单末尾那些便宜的条目（250 金的扩建）会
 * 在每一 tick 都被买走，于是 AI 永远攒不到 800 金去升级、也永远到不了第 7 行的科技研究
 * —— 表现为「造了一屏 T1 小偷，科技 0 级」。这不是玩家行为，是实现缺陷。
 *
 * 超过容忍倍数（例如清单里的 25,000 金 T5）才允许跳过，避免早期被远期条目锁死。
 */
const SAVE_REACH_MULT = 3000;
const SAVE_REACH_FLOOR = 500_000;

/**
 * ★ **攒钱的耐心上限（tick）**：同一条目连续卡住超过这个时长，就不再为它憋着。
 *
 * 为什么必须有：N1 实测出现过「全程 23 座塔 / 9 次升级 / 科技 0 级 / 结束时手上 1,103 金
 * （定点 1,103,143）」—— 它的金币**长期低于清单里下一条的造价**（800 金的升级），
 * 于是每一 tick 都在"攒钱"，而 `savingForStep` 又把价值兜底关掉了
 * → AI 事实上停止花钱，一直到输。一个真实玩家不会为一件买不起的东西攒 30 秒还不动手；
 * 这条上限就是把那个行为写进来。
 */
const SAVE_PATIENCE_TICKS = 30 * 60;

/** 现在买不起的这一条，值不值得为它攒钱？（只有**备战期**才攒钱，战斗中不憋着） */
function canReach(phase: string, gold: Fixed, cost: Fixed): boolean {
  if (phase !== 'prep') return false;
  return cost <= (gold * SAVE_REACH_MULT) / FIXED_SCALE + SAVE_REACH_FLOOR;
}

export function createPlanStrategy(opts: PlanStrategyOptions): Strategy & { scan: PlanScan } {
  let model: PlacementModel | null = null;
  let steps: PlanStep[] = [];
  const done = new Set<string>();
  /** step.key → 建成的塔 id */
  const slots = new Map<string, number>();
  let inflight: Inflight | null = null;
  const scan: PlanScan = { savingForStep: false, doneCount: 0, totalCount: 0 };

  function ensureInit(input: StrategyInput): void {
    if (model) return;
    const lanes = laneCountOf(input.content, input.difficultyId);
    model = buildPlacement(input.content, lanes, opts.placement ?? 'uniform');
    steps = opts.plan({ lanes, content: input.content });
    scan.totalCount = steps.length;
  }

  function verify(input: StrategyInput): boolean {
    if (!inflight) return true;
    const fl = inflight;
    if (fl.kind === 'build') {
      const cell = fl.cell as Cell;
      for (const t of input.snap.towers) {
        if (t.unitId === fl.step.unitId && sameCell(t.cell, cell)) {
          slots.set(fl.step.key, t.id);
          done.add(fl.step.key);
          inflight = null;
          return true;
        }
      }
    } else if (fl.kind === 'upgrade') {
      const t = findTower(input.snap, fl.towerId);
      if (t && t.unitId === fl.step.unitId) {
        done.add(fl.step.key);
        slots.set(fl.step.key, fl.towerId); // 让「升级链」的下一步能接着引用
        inflight = null;
        return true;
      }
      // 目标已经是顶级 / 已被升过 → 这一步永久完成，避免死循环
      if (t) {
        const cur = unitOf(input.content, t.unitId);
        if (!cur || cur.upgradeTo === null) {
          done.add(fl.step.key);
          inflight = null;
          return true;
        }
      }
    } else {
      const tv = input.snap.techs.find((x) => x.id === fl.step.unitId);
      if (tv && tv.level > fl.levelAtIssue) {
        done.add(fl.step.key);
        inflight = null;
        return true;
      }
      if (tv && tv.level >= tv.maxLevel) {
        done.add(fl.step.key);
        inflight = null;
        return true;
      }
    }
    if (input.snap.tick - fl.tick >= RETRY_TICKS) {
      inflight = null; // 被拒绝（格子被占 / 人口满 / 钱木不足）→ 重试
      return true;
    }
    return false;
  }

  function pickCell(input: StrategyInput, lane: number): Cell | null {
    const m = model as PlacementModel;
    const snap = input.snap;
    const occupied = occupiedKeys(snap.towers, input.content.grid.width);
    const cells: Cell[] = snap.towers.map((t) => t.cell);
    // 分路均衡：目标路塔数最多时改成塔最少的那条路（4 路难度下很重要）
    const lanes = m.laneCount;
    if (lanes > 1) {
      const counts = new Array<number>(lanes).fill(0);
      for (const c of cells) {
        const l = m.laneOf(c);
        if (l >= 0 && l < lanes) counts[l] = (counts[l] as number) + 1;
      }
      if (lane >= 0 && lane < lanes && (counts[lane] as number) > (counts[argMin(counts)] as number)) {
        lane = argMin(counts);
      }
    }
    return m.pick(occupied, cells, lane);
  }

  /** 正在为哪一条攒钱、从什么时候开始（耐心上限用） */
  let blockKey: string | null = null;
  let blockSince = 0;

  return {
    id: opts.id,
    label: opts.label,
    description: opts.description,
    decide(input: StrategyInput): Command[] {
      ensureInit(input);
      const snap = input.snap;
      if (snap.status !== 'running') return [];

      const skills = salaryCommand(snap);

      if (inflight && !verify(input)) return skills;

      /**
       * 该不该为这一条继续憋着？
       * ① 只有备战期才攒钱（战斗中手上有钱就补最需要的）
       * ② 造价要在"够得着"的范围内
       * ③ **同一件东西不能卡超过 30 秒** —— 超过就放弃攒钱，继续往下扫（让更便宜的条目/兜底动手）
       */
      const keepSavingFor = (key: string, cost: Fixed, wood: Fixed, haveWood: Fixed): boolean => {
        if (!canReach(snap.phase, snap.gold, cost)) return false;
        if (wood > haveWood) return false; // 木材缺口是**结构性**的（没有产木单位），憋着也等不到 → 交给兜底
        if (blockKey !== key) {
          blockKey = key;
          blockSince = snap.tick;
          return true;
        }
        return snap.tick - blockSince < SAVE_PATIENCE_TICKS;
      };

      let saving = false;
      for (const st of steps) {
        if (done.has(st.key)) continue;
        if (snap.wave < (st.minWave ?? 0)) continue;

        if (st.kind === 'research') {
          const tv = snap.techs.find((x) => x.id === st.unitId);
          if (!tv) continue; // 该科技线不存在（数据侧删了）
          if (tv.level >= tv.maxLevel) {
            done.add(st.key);
            continue;
          }
          if (tv.unimplemented) {
            done.add(st.key); // 引擎不认识的线：跳过并记完成，避免每 tick 空扫
            continue;
          }
          if (!tv.affordable) {
            saving = true;
            if (keepSavingFor(st.key, tv.nextGold, tv.nextWood, snap.wood)) break;
            continue;
          }
          blockKey = null;
          inflight = { step: st, tick: snap.tick, kind: 'research', towerId: -1, cell: null, levelAtIssue: tv.level };
          scan.savingForStep = false;
          scan.doneCount = done.size;
          return [...skills, { type: 'research', techId: tv.id }];
        }

        if (st.kind === 'upgrade') {
          const afterKey = st.afterKey as string;
          const tid = slots.get(afterKey);
          if (tid === undefined) continue;
          const tv = findTower(snap, tid);
          if (!tv) continue;
          const cur = unitOf(input.content, tv.unitId);
          if (!cur) continue;
          if (cur.id === st.unitId || cur.upgradeTo === null) {
            done.add(st.key);
            continue;
          }
          if (cur.upgradeTo !== st.unitId) continue; // 等级不对（清单写错），跳过
          const def = unitOf(input.content, st.unitId);
          if (!def) continue;
          if (snap.gold < def.costGold || snap.wood < def.costWood) {
            saving = true;
            if (keepSavingFor(st.key, def.costGold, def.costWood, snap.wood)) break;
            continue;
          }
          blockKey = null;
          inflight = { step: st, tick: snap.tick, kind: 'upgrade', towerId: tid, cell: null, levelAtIssue: 0 };
          scan.savingForStep = false;
          scan.doneCount = done.size;
          return [...skills, { type: 'upgrade', towerId: tid }];
        }

        if (snap.population >= snap.populationCap) continue;
        const def = unitOf(input.content, st.unitId);
        if (!def) continue;
        if (snap.gold < def.costGold || snap.wood < def.costWood) {
          saving = true;
          if (keepSavingFor(st.key, def.costGold, def.costWood, snap.wood)) break;
          continue;
        }
        const cell = pickCell(input, st.lane);
        if (!cell) continue;
        blockKey = null;
        inflight = { step: st, tick: snap.tick, kind: 'build', towerId: -1, cell, levelAtIssue: 0 };
        scan.savingForStep = false;
        scan.doneCount = done.size;
        return [...skills, { type: 'build', unitId: st.unitId, cell }];
      }
      scan.savingForStep = saving;
      scan.doneCount = done.size;
      return skills;
    },
    scan,
  };
}

/** 供测试使用的清单自检：key 唯一、upgrade 的 afterKey 存在、research 的 id 存在。 */
export function validatePlan(steps: readonly PlanStep[], content?: SimContent): string[] {
  const errs: string[] = [];
  const keys = new Set<string>();
  for (const s of steps) {
    if (keys.has(s.key)) errs.push(`重复 key: ${s.key}`);
    keys.add(s.key);
  }
  for (const s of steps) {
    if (s.kind === 'upgrade' && (!s.afterKey || !keys.has(s.afterKey))) {
      errs.push(`${s.key}: upgrade 的前置 ${s.afterKey ?? '(缺)'} 不存在`);
    }
    if (s.kind === 'research' && content && !content.tech?.[s.unitId]) {
      errs.push(`${s.key}: research 的科技线 ${s.unitId} 不在 content.tech 里`);
    }
    if (s.kind === 'build' && content && !content.units[s.unitId]) {
      errs.push(`${s.key}: build 的单位 ${s.unitId} 不在 content.units 里`);
    }
  }
  return errs;
}

/** 清单里每个 tag 的**计划**金币占用（用于核对占比目标，不含升级的累计成本）。 */
export function planCostByTag(content: SimContent, steps: readonly PlanStep[]): Record<PlanTag, number> {
  const out: Record<PlanTag, number> = { economy: 0, output: 0, support: 0, tech: 0, wood: 0 };
  for (const s of steps) {
    if (s.kind === 'research') {
      const def = content.tech?.[s.unitId];
      if (!def) continue;
      // 该线上「第 n 次出现」对应第 n 级 —— 用出现次数累计
      const nth = steps.filter((x) => x.kind === 'research' && x.unitId === s.unitId && x.key <= s.key).length;
      out.tech += def.costPerLevel[nth - 1]?.gold ?? 0;
      continue;
    }
    out[s.tag] += unitOf(content, s.unitId)?.costGold ?? 0;
  }
  return out;
}

export type { TowerView, WorldSnapshot };
