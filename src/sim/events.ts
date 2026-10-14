/**
 * 事件契约（Sim → UI / Render / Balance）
 * 接口契约 §6（冻结）+ §13.1（v0.1.3 增补 3 项与 gameOver 三态）
 *
 * 所有者：engine-dev ｜ 消费者：ui-dev / balance-eng
 */
import type { Fixed } from './fixed';
import type { Command } from './commands';

export type SimEvent =
  | { type: 'steal'; towerId: number; enemyId: number; amount: Fixed; crit: boolean }
  | { type: 'kill'; enemyId: number; gold: Fixed; wood: Fixed }
  | { type: 'leak'; enemyId: number; livesLeft: number }
  | { type: 'waveStart'; wave: number }
  | { type: 'waveEnd'; wave: number; stats: WaveStats }
  | { type: 'build'; towerId: number; unitId: string }
  | { type: 'upgrade'; towerId: number; tier: number }
  | { type: 'sell'; towerId: number; refund: Fixed }
  /** ★ 军训系价值量化。契约 §14.8：**增量**语义（不是"被阻挡敌人身上的窃取占比"） */
  | { type: 'blockExtraSteal'; towerId: number; amount: Fixed }
  | { type: 'commandRejected'; command: Command; reason: string }
  // ── 契约 §13.1 增补 ──
  | { type: 'undo'; towerId: number; refund: Fixed }
  | { type: 'skillActivated'; skillId: 'salary' | 'bramble' | 'midas'; amount?: Fixed }
  | { type: 'waveStats'; stats: WaveStats }
  | { type: 'gameOver'; result: 'win' | 'lose' | 'ascended'; wave: number };

export interface WaveStats {
  wave: number;
  goldEarned: Fixed; // 本波收入（窃金 + 击杀奖励）
  goldSpent: Fixed; // 本波支出（建造 + 升级 + 科技）
  stolenTotal: Fixed; // 本波实际窃取总额
  walletTotal: Fixed; // 本波敌人钱包总量（理论上限）
  stealCoverage: Fixed; // 千分比 = stolenTotal / walletTotal
  blockExtraSteal: Fixed; // 其中因阻挡/卡位额外获得的部分
  leaks: number; // 本波漏怪数（普通整数）
  towerCount: number; // 本波结束时塔数量（普通整数）
}
