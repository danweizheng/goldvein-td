/**
 * `src/art/**` 的共享基础类型。
 *
 * 这里只放"连颜色模块都要用"的最小集合，避免 palette / shapes / marks
 * 之间出现循环 import。方案 §3 的对外契约（`FrameRef` / `AtlasSpec` /
 * `SpriteSource`）定义在 `source.ts`。
 */

/** 8 位 RGBA 颜色（四个分量均为 0–255 整数）。 */
export type Rgba = readonly [number, number, number, number];

/** 整数矩形（像素）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 精灵分类（塔 / 敌人）。 */
export type SpriteKind = 'tower' | 'enemy';
