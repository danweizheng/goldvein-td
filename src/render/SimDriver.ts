/**
 * 渲染层的模拟驱动器 —— 定步长 + 倍速 + 渲染插值
 *
 * 关键约束（策划案 §8.3 / 契约 §4.1）：
 * - 逻辑永远 1/60 秒一步；倍速靠**多跑几步**，绝不改 dt；
 * - 渲染只读 `snapshot()`；UI 只发 `Command`；
 * - `setSpeed` / `pause` / `resume` 由本驱动器（外层循环）消费（契约 §5）。
 *
 * 本文件**不 import Phaser**（便于在 Node 里单测驱动器本身）。
 */
import { advanceFrame, drainEvents } from '../sim/tick';
import { createWorld, createWorldWithContent, snapshot } from '../sim/world';
import { createM0FallbackContent } from '../sim/m0-fixture';
import type { SimContent } from '../sim/content';
import type { Command } from '../sim/commands';
import type { SimEvent } from '../sim/events';
import type { RunConfig, WorldSnapshot, WorldState } from '../sim/types';

export const STEP_MS = 1000 / 60;

/** 单帧最多补跑的逻辑帧数（防止切标签页回来后的"死亡螺旋"）。 */
const MAX_CATCHUP_FRAMES = 8;

interface InterpRecord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lastSeen: number;
}

export interface SimDriverOptions {
  seed: number;
  difficultyId: RunConfig['difficultyId'];
  relics?: Record<string, number>;
  techArchive?: Record<string, number>;
  content?: SimContent;
  speed?: 1 | 2 | 4;
}

export class SimDriver {
  readonly world: WorldState;
  speed: 1 | 2 | 4;
  paused = false;

  /** 本渲染帧内产生的事件（已 drain） */
  frameEvents: SimEvent[] = [];
  /** 本渲染帧内跑过的逻辑帧数 */
  framesLastAdvance = 0;
  /** 插值 alpha ∈ [0,1) */
  alpha = 0;
  /** 累计逻辑 tick（用于报告） */
  totalTicks = 0;

  private accumulatorMs = 0;
  private pending: Command[] = [];
  private readonly interp = new Map<number, InterpRecord>();
  private frameCounter = 0;

  constructor(opts: SimDriverOptions) {
    const cfg: RunConfig = {
      seed: opts.seed,
      difficultyId: opts.difficultyId,
      relics: opts.relics ?? {},
      techArchive: opts.techArchive ?? {},
    };
    this.world = opts.content ? createWorldWithContent(cfg, opts.content) : createWorld(cfg);
    this.speed = opts.speed ?? 1;
    void createM0FallbackContent;
  }

  /** 下发一条指令（下一个逻辑帧生效）。 */
  push(cmd: Command): void {
    if (cmd.type === 'setSpeed') this.speed = cmd.speed;
    else if (cmd.type === 'pause') this.paused = true;
    else if (cmd.type === 'resume') this.paused = false;
    this.pending.push(cmd);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * 推进。
   * @param deltaMs 真实经过的毫秒数（来自 Phaser 的 delta）
   * @returns 本帧跑过的逻辑帧数
   */
  advance(deltaMs: number): number {
    this.frameEvents.length = 0;
    this.framesLastAdvance = 0;
    if (this.paused || this.world.status !== 'running') {
      this.alpha = 0;
      // 暂停时仍然让指令留在队列里（恢复后立刻生效），但不推进世界
      this.pending.length = 0;
      return 0;
    }

    // 单帧上限：最多补 8 个逻辑帧
    this.accumulatorMs = Math.min(this.accumulatorMs + Math.max(0, deltaMs), STEP_MS * MAX_CATCHUP_FRAMES);

    let frames = 0;
    while (this.accumulatorMs >= STEP_MS && frames < MAX_CATCHUP_FRAMES) {
      this.accumulatorMs -= STEP_MS;
      const cmds = this.pending;
      this.pending = [];
      this.beginLogicalFrame();
      advanceFrame(this.world, this.speed, cmds);
      this.endLogicalFrame();
      frames++;
      const evs = drainEvents(this.world);
      if (evs.length > 0) this.frameEvents.push(...evs);
      if (this.world.status !== 'running') break;
    }
    this.framesLastAdvance = frames;
    this.totalTicks = this.world.tick;
    this.alpha = this.accumulatorMs / STEP_MS;
    return frames;
  }

  private beginLogicalFrame(): void {
    for (const r of this.interp.values()) {
      r.x0 = r.x1;
      r.y0 = r.y1;
    }
  }

  private endLogicalFrame(): void {
    this.frameCounter++;
    for (const e of this.world.enemies) {
      let r = this.interp.get(e.id);
      if (r === undefined) {
        r = { x0: e.pos.x, y0: e.pos.y, x1: e.pos.x, y1: e.pos.y, lastSeen: this.frameCounter };
        this.interp.set(e.id, r);
      }
      r.x1 = e.pos.x;
      r.y1 = e.pos.y;
      r.lastSeen = this.frameCounter;
    }
    // 每 240 逻辑帧清理一次已消失的敌人记录
    if (this.frameCounter % 240 === 0) {
      for (const [id, r] of this.interp) {
        if (this.frameCounter - r.lastSeen > 240) this.interp.delete(id);
      }
    }
  }

  /** 只读快照（会被复用，不得跨帧持有）。 */
  get snapshot(): WorldSnapshot {
    return snapshot(this.world);
  }

  /**
   * 渲染插值位置（**格**，浮点 —— 只在渲染层使用）。
   * 新生成的敌人没有历史位置时直接返回当前位置。
   */
  interpCell(id: number, cx: number, cy: number): { x: number; y: number } {
    const r = this.interp.get(id);
    if (r === undefined) return { x: cx, y: cy };
    const a = r.x1 === r.x0 && r.y1 === r.y0 ? 1 : this.alpha;
    return {
      x: (r.x0 + (r.x1 - r.x0) * a) / 1000,
      y: (r.y0 + (r.y1 - r.y0) * a) / 1000,
    };
  }

  /** 调试用：插值表大小（内存占用观察）。 */
  get interpSize(): number {
    return this.interp.size;
  }
}
