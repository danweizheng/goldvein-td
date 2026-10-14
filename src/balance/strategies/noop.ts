/**
 * `noop` —— 「纯偷流」：只造小偷，不造任何输出塔。
 *
 * 策划案 §10.2：应当 0% 通关（否则说明纯偷流破坏设计）。
 *
 * 本实现允许**神偷系内部的升级**（小偷 → 扒手 → 神偷 → 宗师 → 飞贼），
 * 因为那仍然是「只造小偷」；禁止的是弓箭/法师/军训/美女/炮塔这些其它塔系。
 * **只研究窃金相关科技**（窃金效率 / 暴击率 / 暴击效率 / 人口），不研究攻击与攻速
 * —— 攻击强化同时是窃金乘区（`stealAtkCoef`），把它算进「纯偷流」会让这条对照
 * 变得不纯。这是对「纯偷流」最宽的解释：如果连它都失败，更弱的版本一定也失败。
 */
import { createPlanStrategy, type PlanStep } from './plan';
import type { SimContent, UnitDef } from '../../sim/content';
import type { Strategy, StrategyOptions } from './types';

/** 神偷系升级链（units.json 的 upgradesTo 链）。 */
const THIEF_CHAIN = ['pickpocket', 'cutpurse', 'master_thief', 'grandmaster', 'goldfinger'] as const;

/** 纯偷流允许研究的科技线（只碰窃金侧）。 */
const ECONOMY_TECH: readonly { id: string; minWave: number }[] = [
  { id: 'steal_efficiency', minWave: 5 },
  { id: 'population', minWave: 8 },
  { id: 'steal_efficiency', minWave: 10 },
  { id: 'steal_crit_rate', minWave: 12 },
  { id: 'steal_efficiency', minWave: 15 },
  { id: 'steal_crit_mul', minWave: 17 },
  { id: 'population', minWave: 19 },
  { id: 'steal_crit_rate', minWave: 21 },
  { id: 'steal_efficiency', minWave: 23 },
  { id: 'steal_crit_mul', minWave: 25 },
];

export function buildNoopPlan(lanes: number): PlanStep[] {
  const out: PlanStep[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    for (let copy = 0; copy < 3; copy++) {
      const headKey = `noop_pp${copy}#${lane}`;
      out.push({ key: headKey, kind: 'build', unitId: THIEF_CHAIN[0], lane, tag: 'economy' });
      let prev = headKey;
      for (let i = 1; i < THIEF_CHAIN.length; i++) {
        const key = `noop_${i}_${copy}#${lane}`;
        out.push({
          key,
          kind: 'upgrade',
          unitId: THIEF_CHAIN[i] as string,
          lane,
          tag: 'economy',
          afterKey: prev,
          minWave: i * 4,
        });
        prev = key;
      }
    }
  }
  for (let i = 0; i < ECONOMY_TECH.length; i++) {
    const t = ECONOMY_TECH[i] as { id: string; minWave: number };
    out.push({ key: `noop_tech${i}`, kind: 'research', unitId: t.id, lane: -1, tag: 'tech', minWave: t.minWave });
  }
  return out;
}

export function createNoop(opts: StrategyOptions = {}): Strategy {
  const inner = createPlanStrategy({
    id: 'noop',
    label: '纯偷流（只造小偷 + 只研究窃金科技）',
    description: '只建造并升级神偷系、只研究窃金侧科技，不造任何输出/辅助塔。用于验证「纯偷流不可行」。',
    plan: ({ lanes }) => buildNoopPlan(lanes),
    placement: opts.placement,
  });
  return { id: inner.id, label: inner.label, description: inner.description, decide: (i) => inner.decide(i) };
}

/** 供测试与报告使用。 */
export function noopChain(content: SimContent): string[] {
  const out: string[] = [];
  let cur: string | undefined = THIEF_CHAIN[0];
  while (cur) {
    out.push(cur);
    const def: UnitDef | undefined = content.units[cur];
    cur = def && def.upgradeTo ? def.upgradeTo : undefined;
  }
  return out;
}

export { ECONOMY_TECH };
