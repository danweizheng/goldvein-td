/**
 * 指令契约（UI → Sim）—— 接口契约 §5（冻结）+ §14.2 裁决新增 `research`
 *
 * 所有者：engine-dev ｜ 消费者：ui-dev
 *
 * 约定：
 * - UI **不直接改状态**，只发 `Command`。这让撤销与回放天然成立。
 * - 指令在下一个 `step()` 中被应用。`build` 失败（位置非法/钱不够）时不抛异常，
 *   改为产出 `commandRejected` 事件。
 * - `setSpeed` / `pause` / `resume` 由外层循环消费，不进入 `step` 的状态机。
 */

export type Command =
  | { type: 'build'; unitId: string; cell: { x: number; y: number } }
  | { type: 'upgrade'; towerId: number }
  | { type: 'sell'; towerId: number }
  | { type: 'undo' } // 10s 内撤销上一次建造
  | { type: 'relocate'; towerId: number; cell: { x: number; y: number } } // 飞贼瞬移
  | { type: 'activateSkill'; skillId: 'salary' | 'bramble' | 'midas' }
  | { type: 'setSpeed'; speed: 1 | 2 | 4 }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'ascend' } // 主动蜕变（第 20 波后可用）
  /**
   * ★ 契约 §14.2 裁决新增（主策划：以本条为准，将补进 v0.1.5）。
   * 研究**一级**科技。失败（钱/木不够、已满级、前置未满足）→ `commandRejected`，不抛异常。
   */
  | { type: 'research'; techId: string };

/** 由外层循环（render / main）消费、**不进入** `step` 状态机的指令类型。 */
export type OuterLoopCommand = Extract<Command, { type: 'setSpeed' | 'pause' | 'resume' }>;

export function isOuterLoopCommand(cmd: Command): cmd is OuterLoopCommand {
  return cmd.type === 'setSpeed' || cmd.type === 'pause' || cmd.type === 'resume';
}
