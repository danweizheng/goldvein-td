/**
 * `balanced` / `noblock` —— 「普通玩家」：定序清单 + 清单饱和后的价值兜底
 *
 * 清单的 tag 目标占比对齐 **契约 §14.12** 的支出侧目标（塔 50% / 科技 35% / 精灵 8% / 杂项 7%），
 * 由 `report.ts` 实测核对（清单按**优先级**排，实际占比取决于钱木够不够）。
 *
 * 契约 §14.2 之后清单多了一类条目：**科技**（`research` 指令）。
 * 没有它，AI 永远不会升科技 → 满科技配置根本不会发生 → 跑批测的仍是「无科技」的世界。
 *
 * `noblock` = 同一张清单删掉军训系行（`needsBlock`），且价值兜底同样禁用军训系。
 * **两组共用同一条代码路径** —— 否则 Q1 的对照实验会被策略差异污染。
 */
import type { Command } from '../../sim/commands';
import type { SimContent } from '../../sim/content';
import { createValueBrain } from './actions';
import { createPlanStrategy, type PlanStep, type PlanTag } from './plan';
import type { Strategy, StrategyInput, StrategyOptions } from './types';

interface Row {
  key: string;
  kind: 'build' | 'upgrade' | 'research';
  /** build/upgrade = 单位 id；research = 科技线 id */
  unitId: string;
  tag: PlanTag;
  minWave?: number;
  /** upgrade：同路的哪个 step key 提供塔 */
  after?: string;
  /** 只在这些路建（缺省 = 全部路） */
  only?: number[];
  /** 军训系（`noblock` 会整行删掉） */
  needsBlock?: boolean;
}

/**
 * 主清单（**按优先级从上到下**）。
 *
 * 顺序的设计意图：
 * 1. 先让每条路有窃金塔 + 输出塔（前 6 行），否则第 1 波就漏；
 * 2. 再补**科技**（契约 §14.2 是唯一的指数通道，越早开始复利越大）；
 * 3. 中段补城甲答案（炮塔）与减速（美女），并按波次把科技推到 L3；
 * 4. 后段把人口/攻速/攻击推到满级，同时把神偷系升到 T5。
 */
export const MAIN_ROWS: readonly Row[] = [
  { key: 'pp', kind: 'build', unitId: 'pickpocket', tag: 'economy' },
  { key: 'ar', kind: 'build', unitId: 'archer', tag: 'output' },
  { key: 'mg', kind: 'build', unitId: 'mage', tag: 'support', only: [0] },
  { key: 'pp2', kind: 'build', unitId: 'pickpocket', tag: 'economy' },
  // 早期铺开：每路第三座窃金塔（250 金，覆盖度比升级更值钱 —— 每个敌人要多经过几座塔）
  { key: 'ppc', kind: 'build', unitId: 'pickpocket', tag: 'economy', minWave: 2 },
  { key: 'arc2', kind: 'build', unitId: 'archer', tag: 'output', minWave: 4 },
  // ── 科技（契约 §14.2 是主强度来源，§14.12 给 35% 预算）──
  // ★ 放在 800 金的升级**之前**：科技是**复利**，越早开始越好；800 金的升级是线性的。
  //   实测教训：把科技排在 cut/cut2 之后时，AI 的可用金币长期低于 800 → 永远到不了研究行
  //   （N1 全程 0 级科技、手上 1,103 金）。这里先买**最便宜**的三条（人口 1300 / 射程 1500 / 攻击 1900）。
  { key: 'pop1', kind: 'research', unitId: 'population', tag: 'tech', minWave: 3 },
  { key: 'rng1', kind: 'research', unitId: 'range', tag: 'tech', minWave: 3 },
  { key: 'spr1', kind: 'build', unitId: 'sprite_clumsy', tag: 'wood', minWave: 4 },
  { key: 'atk1', kind: 'research', unitId: 'attack', tag: 'tech', minWave: 5 },
  { key: 'cut', kind: 'upgrade', unitId: 'cutpurse', tag: 'economy', after: 'pp' },
  { key: 'cut2', kind: 'upgrade', unitId: 'cutpurse', tag: 'economy', after: 'pp2' },
  { key: 'can', kind: 'build', unitId: 'cannon_tower', tag: 'output', minWave: 6 },
  { key: 'as1', kind: 'research', unitId: 'attack_speed', tag: 'tech', minWave: 6 },
  { key: 'stl1', kind: 'research', unitId: 'steal_efficiency', tag: 'tech', minWave: 6 },
  { key: 'shm', kind: 'upgrade', unitId: 'shaman', tag: 'support', after: 'mg', only: [0], minWave: 5 },
  { key: 'drl', kind: 'build', unitId: 'drill_instructor', tag: 'support', minWave: 7, needsBlock: true },
  { key: 'bea', kind: 'build', unitId: 'ice_beauty', tag: 'support', minWave: 9 },
  { key: 'ma2', kind: 'upgrade', unitId: 'multi_archer', tag: 'output', after: 'ar' },
  { key: 'atk2', kind: 'research', unitId: 'attack', tag: 'tech', minWave: 9 },
  { key: 'spr2', kind: 'build', unitId: 'sprite_indulgent', tag: 'wood', minWave: 8 },
  { key: 'pp3', kind: 'build', unitId: 'pickpocket', tag: 'economy', minWave: 10 },
  { key: 'mt', kind: 'upgrade', unitId: 'master_thief', tag: 'economy', after: 'pp', minWave: 11 },
  { key: 'as2', kind: 'research', unitId: 'attack_speed', tag: 'tech', minWave: 11 },
  { key: 'how', kind: 'upgrade', unitId: 'howitzer', tag: 'output', after: 'can', minWave: 12 },
  { key: 'wtc', kind: 'upgrade', unitId: 'watcher', tag: 'support', after: 'shm', only: [0], minWave: 12 },
  { key: 'atk3', kind: 'research', unitId: 'attack', tag: 'tech', minWave: 13 },
  { key: 'mer', kind: 'build', unitId: 'mermaid', tag: 'support', minWave: 13 },
  { key: 'cut3', kind: 'upgrade', unitId: 'cutpurse', tag: 'economy', after: 'pp3', minWave: 13 },
  { key: 'stl2', kind: 'research', unitId: 'steal_efficiency', tag: 'tech', minWave: 13 },
  { key: 'spr3', kind: 'build', unitId: 'sprite_common', tag: 'wood', minWave: 12 },
  { key: 'ar3', kind: 'upgrade', unitId: 'archer_mom', tag: 'output', after: 'ar', minWave: 14 },
  { key: 'crit1', kind: 'research', unitId: 'steal_crit_rate', tag: 'tech', minWave: 14 },
  { key: 'mt2', kind: 'upgrade', unitId: 'master_thief', tag: 'economy', after: 'pp2', minWave: 15 },
  { key: 'as3', kind: 'research', unitId: 'attack_speed', tag: 'tech', minWave: 15 },
  { key: 'ded', kind: 'upgrade', unitId: 'discipline_dean', tag: 'support', after: 'drl', minWave: 16, needsBlock: true },
  { key: 'gm', kind: 'upgrade', unitId: 'grandmaster', tag: 'economy', after: 'pp', minWave: 17 },
  { key: 'mdd', kind: 'upgrade', unitId: 'mage_dad', tag: 'support', after: 'wtc', only: [0], minWave: 18 },
  { key: 'atk4', kind: 'research', unitId: 'attack', tag: 'tech', minWave: 18 },
  { key: 'spr4', kind: 'build', unitId: 'sprite_advanced', tag: 'wood', minWave: 16 },
  { key: 'mt3', kind: 'upgrade', unitId: 'master_thief', tag: 'economy', after: 'pp3', minWave: 19 },
  { key: 'rng2', kind: 'research', unitId: 'range', tag: 'tech', minWave: 19 },
  { key: 'critm1', kind: 'research', unitId: 'steal_crit_mul', tag: 'tech', minWave: 18 },
  { key: 'hel', kind: 'upgrade', unitId: 'hellfire', tag: 'output', after: 'how', minWave: 20 },
  { key: 'pop2', kind: 'research', unitId: 'population', tag: 'tech', minWave: 20 },
  { key: 'as4', kind: 'research', unitId: 'attack_speed', tag: 'tech', minWave: 20 },
  { key: 'am', kind: 'upgrade', unitId: 'principal_mom', tag: 'output', after: 'ar', minWave: 21 },
  { key: 'gm2', kind: 'upgrade', unitId: 'grandmaster', tag: 'economy', after: 'pp2', minWave: 22 },
  { key: 'atk5', kind: 'research', unitId: 'attack', tag: 'tech', minWave: 22 },
  { key: 'stl3', kind: 'research', unitId: 'steal_efficiency', tag: 'tech', minWave: 22 },
  { key: 'spr5', kind: 'build', unitId: 'sprite_advanced', tag: 'wood', minWave: 20 },
  { key: 'agp', kind: 'upgrade', unitId: 'archmage_grandpa', tag: 'support', after: 'mdd', only: [0], minWave: 23 },
  { key: 'gm3', kind: 'upgrade', unitId: 'grandmaster', tag: 'economy', after: 'pp3', minWave: 24 },
  { key: 'as5', kind: 'research', unitId: 'attack_speed', tag: 'tech', minWave: 24 },
  { key: 'crit2', kind: 'research', unitId: 'steal_crit_rate', tag: 'tech', minWave: 24 },
  { key: 'spr6', kind: 'build', unitId: 'sprite_advanced', tag: 'wood', minWave: 24 },
  { key: 'gf', kind: 'upgrade', unitId: 'goldfinger', tag: 'economy', after: 'gm', only: [0], minWave: 25 },
  { key: 'critm2', kind: 'research', unitId: 'steal_crit_mul', tag: 'tech', minWave: 25 },
  { key: 'rng3', kind: 'research', unitId: 'range', tag: 'tech', minWave: 26 },
  { key: 'stl4', kind: 'research', unitId: 'steal_efficiency', tag: 'tech', minWave: 27 },
];

/**
 * 扩建轮（把人口上限铺满）—— **必须有 minWave 门槛**。
 *
 * 否则这些 250 金的便宜条目会在第 1 波就被「买得起就买」的扫描规则吃掉，
 * 导致 AI 造一屏 T1 小偷、永远升不起级、也到不了清单前面的科技研究行。
 * 这与「普通玩家」的行为不符：扩建是**后期**才做的事。
 */
export const EXTRA_ROWS: readonly Row[] = [
  { key: 'pp4', kind: 'build', unitId: 'pickpocket', tag: 'economy', minWave: 16 },
  { key: 'cut4', kind: 'upgrade', unitId: 'cutpurse', tag: 'economy', after: 'pp4' },
  { key: 'mt4', kind: 'upgrade', unitId: 'master_thief', tag: 'economy', after: 'pp4' },
  { key: 'gm4', kind: 'upgrade', unitId: 'grandmaster', tag: 'economy', after: 'pp4' },
  { key: 'can4', kind: 'build', unitId: 'cannon_tower', tag: 'output', minWave: 17 },
  { key: 'how4', kind: 'upgrade', unitId: 'howitzer', tag: 'output', after: 'can4' },
  { key: 'hel4', kind: 'upgrade', unitId: 'hellfire', tag: 'output', after: 'how4' },
  { key: 'ar4', kind: 'build', unitId: 'archer', tag: 'output', minWave: 18 },
  { key: 'ma24', kind: 'upgrade', unitId: 'multi_archer', tag: 'output', after: 'ar4' },
  { key: 'bea4', kind: 'build', unitId: 'ice_beauty', tag: 'support', minWave: 19 },
  { key: 'mer4', kind: 'upgrade', unitId: 'mermaid', tag: 'support', after: 'bea4' },
  { key: 'drl4', kind: 'build', unitId: 'drill_instructor', tag: 'support', minWave: 15, needsBlock: true },
  { key: 'ded4', kind: 'upgrade', unitId: 'discipline_dean', tag: 'support', after: 'drl4', needsBlock: true },
];

/**
 * ★ **经济倾向（主策划裁决 2 的 A 维度）**
 *
 * | 取值 | 含义 | 实现 |
 * |---|---|---|
 * | `build-first` | 建造优先（现状）：有钱就铺新的窃金塔 | 清单用 `MAIN_ROWS` 的原始顺序 |
 * | `upgrade-first` | **升级优先**：先把手上的窃金塔升到 T3+，再铺新的 | 把「首座小偷的升级链」提前到「第二座小偷」之前 |
 *
 * 为什么这一维优先于射程/停顿：`stealAmountCore = StealBase × LevelMul × (1+0.02×attack)`
 * 在 T1→T3 之间就有 **10.6 倍**差距（4.64 → 49.0 金/次），远大于摆位的 +8~14pt 与停顿的 +5pt。
 * 而之前三轮的 AI 采样显示它**长期只有 3 座窃金塔、看不出升级** —— 若这一维是主导，
 * 那就**不需要动任何数据**。
 */
export type EconomyPolicy = 'build-first' | 'upgrade-first';

/** `upgrade-first` 用的清单：把首座小偷的 cut→mt 升级插到第二座小偷之前。 */
export const UPGRADE_FIRST_ROWS: readonly Row[] = (() => {
  const byKey = new Map(MAIN_ROWS.map((r) => [r.key, r]));
  const taken = new Set<string>();
  const out: Row[] = [];
  const take = (key: string): void => {
    const r = byKey.get(key);
    if (r && !taken.has(key)) {
      taken.add(key);
      out.push(r);
    }
  };
  // 前 4 行：每路 1 座小偷 + 1 座弓手（覆盖与伤害各一）——顺序不变
  take('pp');
  take('ar');
  take('mg');
  // ★ 先把第一座小偷推到 T3（cut → mt），再做别的
  take('cut');
  take('mt');
  // 然后才是第二座小偷与它的升级
  take('pp2');
  take('cut2');
  // 其余按原顺序（把已取的跳过）
  take('ppc');
  take('arc2');
  take('pop1');
  take('rng1');
  take('spr1');
  take('atk1');
  take('can');
  for (const r of MAIN_ROWS) if (!taken.has(r.key)) out.push(r);
  return out;
})();

export function buildBalancedPlan(opts: {
  lanes: number;
  allowBlock: boolean;
  rows?: readonly Row[];
  economyPolicy?: EconomyPolicy;
}): PlanStep[] {
  const { lanes, allowBlock } = opts;
  const rows =
    opts.rows ?? (opts.economyPolicy === 'upgrade-first' ? [...UPGRADE_FIRST_ROWS, ...EXTRA_ROWS] : [...MAIN_ROWS, ...EXTRA_ROWS]);
  const out: PlanStep[] = [];
  for (const row of rows) {
    if (row.needsBlock && !allowBlock) continue;
    // research 是全局的（不分路）：只生成一条
    if (row.kind === 'research') {
      const step: PlanStep = { key: row.key, kind: 'research', unitId: row.unitId, lane: -1, tag: row.tag };
      if (row.minWave !== undefined) step.minWave = row.minWave;
      out.push(step);
      continue;
    }
    const targets = row.only ?? Array.from({ length: lanes }, (_, i) => i);
    for (const lane of targets) {
      if (lane >= lanes) continue;
      const step: PlanStep = {
        key: `${row.key}#${lane}`,
        kind: row.kind,
        unitId: row.unitId,
        lane,
        tag: row.tag,
      };
      if (row.minWave !== undefined) step.minWave = row.minWave;
      if (row.after !== undefined) step.afterKey = `${row.after}#${lane}`;
      out.push(step);
    }
  }
  return out;
}

/** ⚠️ 必须每次新建：策略对象持有单局状态（清单进度 / 已建塔槽位 / 权重）。 */
export function createBalancedLike(id: 'balanced' | 'noblock', description: string, opts: StrategyOptions = {}): Strategy {
  const allowBlock = id === 'balanced';
  const inner = createPlanStrategy({
    id,
    label: id === 'balanced' ? '普通玩家（塔/科技/精灵 定序清单）' : '普通玩家·禁军训系（Q1 对照组）',
    description,
    plan: ({ lanes }) => buildBalancedPlan({ lanes, allowBlock, economyPolicy: opts.economyPolicy }),
    placement: opts.placement,
  });
  const brain = createValueBrain({ allowBlock, allowTech: true, placement: opts.placement });

  return {
    id: inner.id,
    label: inner.label,
    description: inner.description,
    decide(input: StrategyInput): Command[] {
      const cmds = inner.decide(input);
      const planBusy = cmds.some((c) => c.type === 'build' || c.type === 'upgrade' || c.type === 'research');
      if (planBusy) return cmds;
      // 清单里还有「够条件但暂时买不起」的条目 → 攒钱，不要被兜底带偏优先级
      if (inner.scan.savingForStep) return cmds;
      const actions = brain.candidates(input);
      for (const a of actions) {
        const cmd = brain.commandFor(input, a);
        if (cmd) return [...cmds, cmd];
      }
      return cmds;
    },
  };
}

export function createBalanced(opts: StrategyOptions = {}): Strategy {
  return createBalancedLike(
    'balanced',
    '塔 50% / 科技 35% / 精灵 8% 的定序清单（契约 §14.12 目标）；清单饱和后按价值/金币继续投资。',
    opts,
  );
}

export function createNoblock(opts: StrategyOptions = {}): Strategy {
  return createBalancedLike(
    'noblock',
    '与 balanced 完全相同，但清单与价值兜底都禁止军训系 —— Q1「军训系是否存在价值」的真反事实对照组。',
    opts,
  );
}

export type { SimContent };
