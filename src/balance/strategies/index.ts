/**
 * 策略注册表（策划案 §10.2 的 5 种内置 AI）
 *
 * ⚠️ 契约 §14.9：`optimal` → **`heuristic`**（它弱于 `balanced`，不该被读成「高手上限」）。
 */
import type { Strategy, StrategyId, StrategyOptions } from './types';
import { createBalanced, createNoblock } from './balanced';
import { createHeuristic } from './heuristic';
import { createGreedy } from './greedy';
import { createNoop } from './noop';
import { createGapDriven } from './gap';

export type { Strategy, StrategyId, StrategyInput, StrategyOptions } from './types';

export const STRATEGY_IDS: readonly StrategyId[] = ['greedy', 'balanced', 'heuristic', 'noop', 'noblock', 'gap'];

/** 每次都返回**新建**的策略实例（策略持有单局状态，不能跨局复用）。 */
export function createStrategy(id: StrategyId, opts: StrategyOptions = {}): Strategy {
  switch (id) {
    case 'greedy':
      return createGreedy(opts);
    case 'balanced':
      return createBalanced(opts);
    case 'heuristic':
      return createHeuristic(opts);
    case 'noop':
      return createNoop(opts);
    case 'noblock':
      return createNoblock(opts);
    case 'gap':
      return createGapDriven({ placement: opts.placement, agingMax: opts.agingMax, allowedAttackTypes: opts.allowedAttackTypes });
    default:
      throw new Error(`未知策略 '${id as string}'（可用：${STRATEGY_IDS.join(' / ')}）`);
  }
}

export function isStrategyId(v: string): v is StrategyId {
  return (STRATEGY_IDS as readonly string[]).includes(v);
}
