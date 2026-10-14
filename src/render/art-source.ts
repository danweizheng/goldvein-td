/**
 * 消费 `src/art/**` 的语义化图集（方案 §3 的 `SpriteSource` 契约）
 *
 * ## 为什么要有这个文件
 *
 * M0 的 `src/render/atlas.ts` 自己按索引循环填色 —— 那只能让"有个方块在动"，
 * 玩家**看不出护甲**，而护甲是"造穿刺还是造攻城"的唯一依据。
 * `art-proxy` 的图集把语义编码了进去：塔系→轮廓、品阶→齿数、
 * 护甲→边框色、飞行/BOSS/精英/窃金抗性→标记。
 *
 * ## 两条加载路径（默认 art，失败兜底）
 *
 * 1. **默认**：加载 `src/art/out/atlas.png` + `atlas.json`（`atlas-proxy` 的产物，
 *    1024×512 / 109 帧 / key = `${unitId}:${state}`）。**id 与
 *    `src/data/units.json`、`enemies.json` 完全一致**（我核对过：29 + 11 = 40 个 id，
 *    无缺无多），所以 `unitId` → frame key 是**恒等映射**，不需要任何翻译表。
 * 2. **兜底**：art 资源缺失/加载失败时，用 `src/render/atlas.ts` 的程序化图集，
 *    保证游戏**永远能开**。这条路径会在 HUD 上明确提示（不静默降级）。
 *
 * ⚠️ 本文件只读 `SpriteSource` / `AtlasSpec` / 图集 PNG，**不内联任何形状或颜色逻辑**
 *    （方案 §3 的接线约定）。渲染层不认识"齿数""边框"这些概念，只认 frame key。
 */
import Phaser from 'phaser';
import atlasSpecJson from '../art/out/atlas.json';
import atlasPngUrl from '../art/out/atlas.png';
import { frameKey, SPRITE_SIZE, type AtlasSpec, type SpriteSource, type SpriteState } from '../art/source';

/** art 图集的 Phaser 纹理 key。 */
export const ART_TEXTURE_KEY = 'art-atlas';

/** 预加载 art 资源时使用的 loader key。 */
export const ART_LOAD_KEY = 'art-atlas-image';

/** 把 `atlas.json` 当 `AtlasSpec` 用（它就是这个形状，`meta` 已带 generator/version）。 */
export const ART_ATLAS: AtlasSpec = atlasSpecJson as unknown as AtlasSpec;

/** art 图集是否可用（加载失败时由 BootScene 置 false）。 */
export interface ArtAtlasStatus {
  ok: boolean;
  reason?: string;
  frames: number;
  image: string;
  generator: string;
  version: number;
}

/** 把 PNG 挂到 Phaser 的加载队列（BootScene.preload 里调）。 */
export function preloadArtAtlas(scene: Phaser.Scene): void {
  scene.load.image(ART_LOAD_KEY, atlasPngUrl);
}

/**
 * 把已加载的 art 图集注册成 Phaser 纹理 + frames（BootScene.create 里调）。
 *
 * Phaser 的 `load.atlas` 要求的是它的 XML/JSON 格式，而我们的 `AtlasSpec` 是自定义
 * 形状 —— 所以这里**手工注册 frames**（`texture.add(key, sourceIndex, x, y, w, h)`），
 * 这也正是"图集描述可序列化、由渲染层自行注册"的用法。
 */
export function registerArtAtlas(scene: Phaser.Scene): ArtAtlasStatus {
  if (scene.textures.exists(ART_TEXTURE_KEY)) {
    return {
      ok: true,
      frames: Object.keys(ART_ATLAS.frames).length,
      image: atlasPngUrl,
      generator: ART_ATLAS.meta.generator,
      version: ART_ATLAS.meta.version,
    };
  }
  if (!scene.textures.exists(ART_LOAD_KEY)) {
    return {
      ok: false,
      reason: `art 图集 PNG 未加载（${atlasPngUrl}）`,
      frames: 0,
      image: atlasPngUrl,
      generator: ART_ATLAS.meta.generator,
      version: ART_ATLAS.meta.version,
    };
  }

  const src = scene.textures.get(ART_LOAD_KEY);
  const srcImage = src.getSourceImage() as { width: number; height: number };
  if (srcImage.width !== ART_ATLAS.imageWidth || srcImage.height !== ART_ATLAS.imageHeight) {
    return {
      ok: false,
      reason: `atlas.json 与 PNG 尺寸不符：json ${ART_ATLAS.imageWidth}×${ART_ATLAS.imageHeight} vs png ${srcImage.width}×${srcImage.height}`,
      frames: 0,
      image: atlasPngUrl,
      generator: ART_ATLAS.meta.generator,
      version: ART_ATLAS.meta.version,
    };
  }

  // 用 canvas 纹理把 PNG 拷进来，再逐帧注册（这样所有帧共享一张纹理 → 单 draw call）
  const canvasTex = scene.textures.createCanvas(ART_TEXTURE_KEY, ART_ATLAS.imageWidth, ART_ATLAS.imageHeight);
  if (!canvasTex) {
    return { ok: false, reason: '无法创建 art canvas 纹理', frames: 0, image: atlasPngUrl, generator: ART_ATLAS.meta.generator, version: ART_ATLAS.meta.version };
  }
  const ctx = canvasTex.context;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(srcImage as CanvasImageSource, 0, 0);

  let registered = 0;
  for (const [key, f] of Object.entries(ART_ATLAS.frames)) {
    // 帧名直接用 art 的 `${id}:${state}`，渲染层不再需要任何 id 翻译
    canvasTex.add(key, 0, f.x, f.y, f.w, f.h);
    registered++;
  }
  canvasTex.refresh();
  // 像素风硬性要求：NEAREST，否则边缘会糊（M0 已用逐像素验证过）
  canvasTex.setFilter(Phaser.Textures.FilterMode.NEAREST);

  return {
    ok: true,
    frames: registered,
    image: atlasPngUrl,
    generator: ART_ATLAS.meta.generator,
    version: ART_ATLAS.meta.version,
  };
}

/**
 * 任意 `SpriteSource` → Phaser canvas 纹理（供程序化实现与接真实美术时复用）。
 *
 * 这条路走 `SpriteSource.render()` 的 RGBA 原始像素，不依赖任何 PNG 文件 ——
 * 所以它在 Node/无网络环境下也能工作（用于测试与兜底）。
 */
export function registerSourceTexture(
  scene: Phaser.Scene,
  source: SpriteSource,
  key: string,
): { ok: boolean; reason?: string; frames: number } {
  if (scene.textures.exists(key)) {
    return { ok: true, frames: Object.keys(source.atlas.frames).length };
  }
  const { atlas } = source;
  const canvasTex = scene.textures.createCanvas(key, atlas.imageWidth, atlas.imageHeight);
  if (!canvasTex) return { ok: false, reason: '无法创建 canvas 纹理', frames: 0 };
  const ctx = canvasTex.context;
  const pixels = source.render();
  if (pixels.length !== atlas.imageWidth * atlas.imageHeight * 4) {
    return {
      ok: false,
      reason: `render() 返回 ${pixels.length} 字节，期望 ${atlas.imageWidth * atlas.imageHeight * 4}`,
      frames: 0,
    };
  }
  // 用 putImageData 直接铺原始 RGBA（DataView 形状与 ImageData 一致；
  // TS 的 lib 对 `Uint8ClampedArray<ArrayBuffer>` 有更严的泛型，这里显式构造）
  ctx.putImageData(
    { data: pixels, width: atlas.imageWidth, height: atlas.imageHeight, colorSpace: 'srgb' } as unknown as ImageData,
    0,
    0,
  );
  let frames = 0;
  for (const [frameName, f] of Object.entries(atlas.frames)) {
    canvasTex.add(frameName, 0, f.x, f.y, f.w, f.h);
    frames++;
  }
  canvasTex.refresh();
  canvasTex.setFilter(Phaser.Textures.FilterMode.NEAREST);
  return { ok: true, frames };
}

/** 精灵帧名：`${id}:${state}`（方案 §3 冻结）。 */
export function artFrame(id: string, state: SpriteState = 'idle'): string {
  return frameKey(id, state);
}

/**
 * 敌人该用哪一档尺寸（方案 §8 冻结表：32 / 精英 48 / BOSS 96）。
 *
 * 尺寸只用于**条布局**与站位，不影响帧本身 —— 帧尺寸由图集决定。
 */
export function enemySpriteSize(isBoss: boolean, isElite: boolean): number {
  if (isBoss) return SPRITE_SIZE.boss;
  if (isElite) return SPRITE_SIZE.elite;
  return SPRITE_SIZE.enemy;
}

/** 塔的尺寸（方案 §8：一律 48）。 */
export function towerSpriteSize(): number {
  return SPRITE_SIZE.tower;
}