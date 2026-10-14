/**
 * `heuristic` —— 「会用波次预告、会在漏怪时止损、每分钱花在边际收益最高处」的玩家
 *
 * ⚠️ **契约 §14.9：本策略原名 `optimal`，已更名 `heuristic`。**
 * 理由：它实现的**不是**策划案 §10.2 说的「贪心搜索最佳建造序列」，而是
 * 「价值/金币贪心 + 波次预告」——把一个弱于 `balanced` 的启发式叫 `optimal`，
 * 会诱导所有人把它的数字读成「高手上限」。门禁表里的 `heuristic N4/N5` 应读作**下界**。
 *
 * `src/sim/clone.ts` 已提供 `cloneWorld(w)`，但真前向搜索（每决策点 × 候选数 × 地平线）
 * 在 headless 跑批里成本仍过高，本轮未实现 —— 见汇报的「未验证」。
 *
 * 决策集与 `balanced` 的兜底**共用同一个 brain**（`actions.ts`），差别只在
 * ① `heuristic` 没有定序清单，②它开着「建造饱和因子」以体现边际覆盖递减。
 */
import type { Command } from '../../sim/commands';
import { createValueBrain } from './actions';
import { salaryCommand } from './common';
import type { Strategy, StrategyInput, StrategyOptions } from './types';

/** ⚠️ 必须每次新建：策略对象持有单局状态（权重 / 路数 / 起始生命）。 */
export function createHeuristic(opts: StrategyOptions = {}): Strategy {
  const brain = createValueBrain({ allowBlock: true, allowTech: true, buildSaturation: true, placement: opts.placement, allowedAttackTypes: opts.allowedAttackTypes });
  return {
    id: 'heuristic',
    label: '高手启发式（价值/金币贪心 + 波次预告）',
    description:
      '每一步都选边际价值最高的建造/升级/研究；上波漏怪或生命告急时把权重转向输出。不是真搜索（契约 §14.9）。',
    decide(input: StrategyInput): Command[] {
      const skills = salaryCommand(input.snap);
      for (const a of brain.candidates(input)) {
        const cmd = brain.commandFor(input, a);
        if (cmd) return [...skills, cmd];
      }
      return skills;
    },
  };
}
