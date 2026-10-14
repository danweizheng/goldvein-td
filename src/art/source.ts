/**
 * ★ 可替换契约（方案 §3 冻结）—— `src/render/**` 只依赖本文件。
 *
 * 方案原文：
 * ```ts
 * export type SpriteState = 'idle' | 'attack' | 'upgrade' | 'walk';
 * export interface FrameRef { x, y, w, h, anchorX, anchorY }
 * export interface AtlasSpec { imageWidth, imageHeight, frames, meta }
 * export interface SpriteSource { readonly atlas: AtlasSpec; render(): Uint8ClampedArray }
 * ```
 *
 * 接真实美术时**只换实现类**（`ProceduralSpriteSource` → `AtlasSpriteSource`），
 * 调用方一行不改。
 *
 * ⚠️ 本文件零 Phaser 依赖：只描述"图集长什么样"，不碰任何渲染 API。
 */
import type { SpriteKind } from './types';

/** 精灵状态帧（方案 §2.3）。 */
export type SpriteState = 'idle' | 'attack' | 'upgrade' | 'walk';

/**
 * 一帧在纹理图集里的位置。
 *
 * `anchorX` / `anchorY` 是**帧内局部坐标**（相对帧左上角，单位像素），
 * 表示"脚的着地点"：部署时把该点对齐到格子的地面线，血条/钱包条即以它为基准。
 * （帧内局部坐标是与 Phaser atlas 惯例一致的选择：图集里每帧可取任意位置，
 * 锚点若用图集绝对坐标会在重排图集后失效。）
 */
export interface FrameRef {
  /** 帧左上角在图集中的 x。 */
  x: number;
  /** 帧左上角在图集中的 y。 */
  y: number;
  /** 帧宽（像素）。 */
  w: number;
  /** 帧高（像素）。 */
  h: number;
  /** 着地点相对帧左上角的 x。 */
  anchorX: number;
  /** 着地点相对帧左上角的 y。 */
  anchorY: number;
}

/** 图集描述（可 `JSON.stringify` 落盘，也可直接喂给 Phaser 的 atlas 加载器）。 */
export interface AtlasSpec {
  imageWidth: number;
  imageHeight: number;
  /** key = `${id}:${state}`。 */
  frames: Record<string, FrameRef>;
  meta: { generator: string; version: number };
}

/**
 * ★ 唯一替换点。
 *
 * `ProceduralSpriteSource` —— 程序化占位（当前）
 * `AtlasSpriteSource`      —— 接真实美术时
 */
export interface SpriteSource {
  readonly atlas: AtlasSpec;
  /** 生成像素数据（RGBA，行优先，宽×高×4）。 */
  render(): Uint8ClampedArray;
}

/** 写入 `AtlasSpec.meta.generator`。 */
export const ATLAS_GENERATOR = 'src/art/procedural.ts';
/** 写入 `AtlasSpec.meta.version`。**改变像素输出时必须 +1**（CI 视觉快照基准）。 */
export const ATLAS_VERSION = 1;

/**
 * 尺寸规格（方案 §8 冻结）：塔 48 ｜ 普通敌 32 ｜ 精英 48 ｜ BOSS 96 ｜ 板条 1px 高。
 *
 * BOSS 的 96 与方案 §2.2「尺寸 ×1.5」的关系：BOSS **本体**直径 = 48
 * = 普通敌精灵框 32 的 ×1.5，96 的帧是为了容纳外圈金环与余量。
 */
export const SPRITE_SIZE = {
  tower: 48,
  enemy: 32,
  elite: 48,
  boss: 96,
} as const;

/** 每类精灵有哪些状态帧。敌人不"攻击/升级"，塔不"行走"。 */
export const STATES_FOR: Readonly<Record<SpriteKind, readonly SpriteState[]>> = {
  tower: ['idle', 'attack', 'upgrade'],
  enemy: ['idle', 'walk'],
};

/** 拼装图集 frame key（方案 §3：`key = ${id}:${state}`）。 */
export function frameKey(id: string, state: SpriteState): string {
  return `${id}:${state}`;
}

/** 拆解图集 frame key。非本模块格式时返回 `null`（不抛异常）。 */
export function parseFrameKey(key: string): { id: string; state: SpriteState } | null {
  const idx = key.lastIndexOf(':');
  if (idx <= 0) return null;
  const state = key.slice(idx + 1);
  if (state !== 'idle' && state !== 'attack' && state !== 'upgrade' && state !== 'walk') return null;
  return { id: key.slice(0, idx), state };
}

/** 运行期校验：任何 `SpriteSource` 实现都必须满足的基本不变量。 */
export function assertValidSource(source: SpriteSource, label = 'SpriteSource'): void {
  const { atlas } = source;
  if (!Number.isInteger(atlas.imageWidth) || atlas.imageWidth <= 0) {
    throw new Error(`${label}: imageWidth 必须是正整数`);
  }
  if (!Number.isInteger(atlas.imageHeight) || atlas.imageHeight <= 0) {
    throw new Error(`${label}: imageHeight 必须是正整数`);
  }
  const keys = Object.keys(atlas.frames);
  if (keys.length === 0) throw new Error(`${label}: frames 为空`);
  for (const key of keys) {
    const f = atlas.frames[key];
    if (!f) throw new Error(`${label}: frame ${key} 缺失`);
    for (const v of [f.x, f.y, f.w, f.h, f.anchorX, f.anchorY]) {
      if (!Number.isInteger(v)) throw new Error(`${label}: frame ${key} 含非整数坐标 ${v}`);
    }
    if (f.x < 0 || f.y < 0 || f.w <= 0 || f.h <= 0) {
      throw new Error(`${label}: frame ${key} 越界或尺寸非法`);
    }
    if (f.x + f.w > atlas.imageWidth || f.y + f.h > atlas.imageHeight) {
      throw new Error(`${label}: frame ${key} 超出图集范围`);
    }
    if (f.anchorX < 0 || f.anchorX >= f.w || f.anchorY < 0 || f.anchorY >= f.h) {
      throw new Error(`${label}: frame ${key} 锚点必须在帧内`);
    }
  }
  const pixels = source.render();
  if (pixels.length !== atlas.imageWidth * atlas.imageHeight * 4) {
    throw new Error(`${label}: render() 返回 ${pixels.length} 字节，与图集尺寸不符`);
  }
}
