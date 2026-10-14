/**
 * 策略 AI 的公共接口（策划案 §10.2「内置 AI 策略」）
 *
 * ## 硬约束
 *
 * - AI **只能通过 `WorldSnapshot` 读状态**（契约 §4/§7：render / ui / balance 只能读只读视图），
 *   只能通过 `Command` 改状态（契约 §5）。不直接改 `WorldState` 任何一个字段。
 * - 全程整数运算，不使用 `Math.random()`（策略是纯函数式的，唯一随机源是模拟层的可播种 RNG）。
 *
 * ## 为什么把 AI 写成「发指令」而不是「改状态」
 *
 * 这顺带验证了 UI → Sim 的指令通路：任何策略（包括最优解）都必须经过
 * `build` / `upgrade` / `sell` / `activateSkill` 这些真实指令，指令被拒绝时会产出
 * `commandRejected` 事件 —— 跑批报告里的 `rejections` 就是这条通路的健康度指标。
 */
import type { Command } from '../../sim/commands';
import type { DifficultyId, SimContent } from '../../sim/content';
import type { WorldSnapshot } from '../../sim/types';

/**
 * 五种内置策略的 id。
 *
 * ⚠️ 契约 §14.9：原 `optimal` **已更名 `heuristic`** —— 它是「价值/金币贪心 + 波次预告」，
 * 不是「贪心搜索最佳建造序列」。门禁表里的 `heuristic` 数字应读作**下界**。
 */
export type StrategyId = 'greedy' | 'balanced' | 'heuristic' | 'noop' | 'noblock' | 'gap';


import type { AttackType } from '../../sim/content';
import type { PlacementMode } from './placement';

/** 策略构造选项（摆位风格等）—— 由 createStrategy(id, opts) 传入。 */
export interface StrategyOptions {
  /** 摆位风格：uniform 沿路径摊开 / clustered 向★停顿点聚集 */
  placement?: PlacementMode;
  /** 经济倾向：uild-first 铺新塔 / upgrade-first 先升级手上的窃金塔（主策划裁决 2 的 A 维度） */
  economyPolicy?: 'build-first' | 'upgrade-first';
  /** gap 策略的 aging 上限（漏怪持续时经济最多被饿死几波） */
  agingMax?: number;
  /**
   * 只允许这些**攻击类型**（`AttackType`）—— 护甲克制对照实验用。
   *
   * 为什么用 `attackType` 而不是 `line`：**克制矩阵就是按 `attackType` 索引的**
   * （`src/sim/content.ts` 的 `counterMatrixStandard`），而 sim 侧的 `UnitDef`
   * 根本没有 `line` 字段（`line` 是 `src/data` 的概念，适配层把它消化成了其他字段）。
   *
   * 空/未设 = 不限；**窃金塔（经济）不受此限制** —— 实验要隔离的是「输出类型选错」，
   * 不是「没有经济」。
   */
  allowedAttackTypes?: readonly AttackType[];
}

export interface StrategyInput {
  /** ⚠️ 快照对象被模拟层复用，**只能在本 tick 内读**，不得跨帧持有。 */
  readonly snap: WorldSnapshot;
  readonly content: SimContent;
  readonly difficultyId: DifficultyId;
}

export interface Strategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly description: string;
  /** 返回本 tick 要应用的指令（空数组 = 什么都不做）。 */
  decide(input: StrategyInput): Command[];
}
