/**
 * 程序生成的占位像素图集（M0 无美术资源）
 *
 * 策划案 §8.5「渲染优化清单」第 1 条：所有精灵走**同一图集**（减少 draw call
 * 与 texture swap）。这里在运行时用 Canvas 2D 画出一张图集，再切成 frame
 * 注册到同一个 `CanvasTexture` 上 —— 因此所有精灵共享一张 GL 纹理。
 *
 * 所有绘制都是整数坐标的 `fillRect`，**没有任何抗锯齿/半透明边缘**，
 * 这是「NEAREST 无糊边」可验证的前提。
 */
import Phaser from 'phaser';

export const ATLAS_KEY = 'atlas';
export const TILE = 16;
const COLS = 8;
const ROWS = 8;

/** 图集里所有 frame 的名字。 */
export const FRAMES = {
  /** 像素校验专用：纯色 + 1px 描边，任何混色都能被检出 */
  probe: 'probe',
  path: 'path',
  buildable: 'buildable',
  halt: 'halt',
  vault: 'vault',
  projectile: 'projectile',
  projectileGold: 'projectile_gold',
  enemyPrefix: 'enemy_',
  unitPrefix: 'unit_',
} as const;

/** 6 大塔系 → 主色（策划案 §4.2）。 */
const FAMILY_COLORS: Record<string, string> = {
  thief: '#ffd24a', // 神偷系：金
  archer: '#7ad46b', // 弓箭系：绿
  mage: '#7fb2ff', // 法师系：蓝
  trainer: '#c8c8d0', // 军训系：灰
  beauty: '#ff8fd0', // 美女系：粉
  cannon: '#ff7043', // 炮塔系：橙
  wisp: '#9be8c0', // 小精灵：青
  worker: '#d8b070', // 工人：棕
};

/** 护甲类型 → 敌人主色（策划案 §4.3/§4.5.2）。 */
const ARMOR_COLORS: Record<string, string> = {
  light: '#e05c5c',
  medium: '#e0a05c',
  heavy: '#a05ce0',
  fortified: '#5c8fe0',
  hero: '#e0e05c',
  divine: '#f0f0f0',
};

export interface AtlasBuildResult {
  key: string;
  frames: string[];
}

/** 由单位 id 推断塔系（用于取色）。 */
export function familyOf(unitId: string): string {
  for (const key of Object.keys(FAMILY_COLORS)) {
    if (unitId.startsWith(key)) return key;
  }
  return 'worker';
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** 画一个 16×16 的塔：底座 + 主体 + 等级点。 */
function drawUnit(ctx: CanvasRenderingContext2D, ox: number, oy: number, unitId: string, tier: number): void {
  const main = FAMILY_COLORS[familyOf(unitId)] ?? '#cccccc';
  px(ctx, ox + 3, oy + 12, 10, 3, '#2b2b38'); // 底座
  px(ctx, ox + 4, oy + 4, 8, 8, main); // 主体
  px(ctx, ox + 4, oy + 4, 8, 1, '#ffffff'); // 高光
  px(ctx, ox + 4, oy + 11, 8, 1, '#1a1a22'); // 阴影
  px(ctx, ox + 6, oy + 6, 2, 2, '#1a1a22'); // 眼
  px(ctx, ox + 9, oy + 6, 2, 2, '#1a1a22');
  // 等级点：tier 个小点
  for (let i = 0; i < Math.min(5, Math.max(0, tier)); i++) {
    px(ctx, ox + 3 + i * 2, oy + 1, 1, 2, '#ffffff');
  }
}

/** 画一个 16×16 的敌人：身体 + 眼 + 护甲色，飞行单位加翅膀。 */
function drawEnemy(ctx: CanvasRenderingContext2D, ox: number, oy: number, armor: string, flying: boolean, boss: boolean): void {
  const main = ARMOR_COLORS[armor] ?? '#e05c5c';
  const size = boss ? 12 : 10;
  const off = boss ? 2 : 3;
  if (flying) {
    px(ctx, ox + 1, oy + 6, 3, 2, '#ffffff');
    px(ctx, ox + 12, oy + 6, 3, 2, '#ffffff');
  }
  px(ctx, ox + off, oy + off, size, size, main);
  px(ctx, ox + off, oy + off, size, 1, '#ffffff');
  px(ctx, ox + off, oy + off + size - 1, size, 1, '#1a1a22');
  px(ctx, ox + off + 2, oy + off + 3, 2, 2, '#1a1a22');
  px(ctx, ox + off + size - 4, oy + off + 3, 2, 2, '#1a1a22');
  if (boss) {
    px(ctx, ox + off + 2, oy + off - 2, 2, 2, '#ffe066');
    px(ctx, ox + off + size - 4, oy + off - 2, 2, 2, '#ffe066');
  }
}

/**
 * 生成图集（幂等）。返回注册了哪些 frame。
 *
 * `unitIds` / `enemyIds` 由调用方注入（M0 来自合成夹具，M1 来自 src/data），
 * 这样渲染层不需要硬编码任何一把单位 id —— 也不 import src/data。
 */
export function ensureAtlas(
  scene: Phaser.Scene,
  unitIds: readonly { id: string; tier: number }[],
  enemyIds: readonly { id: string; armorType: string; flying: boolean; boss: boolean }[],
): AtlasBuildResult {
  const plan = framePlan(unitIds, enemyIds);
  if (scene.textures.exists(ATLAS_KEY)) {
    return { key: ATLAS_KEY, frames: plan.map((p) => p.name) };
  }

  const canvasTex = scene.textures.createCanvas(ATLAS_KEY, COLS * TILE, ROWS * TILE);
  if (!canvasTex) throw new Error('无法创建图集纹理');

  const ctx = canvasTex.context;
  ctx.imageSmoothingEnabled = false;

  let index = 0;
  const next = (): { x: number; y: number } => {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    index++;
    if (index > COLS * ROWS) throw new Error('图集容量不足：帧数超过 ' + COLS * ROWS);
    return { x: col * TILE, y: row * TILE };
  };
  const addFrame = (pos: { x: number; y: number }, name: string): void => {
    canvasTex.add(name, 0, pos.x, pos.y, TILE, TILE);
  };

  // 1) 像素校验专用帧：整块纯色 + 1px 亮描边（无任何过渡色）
  {
    const p = next();
    px(ctx, p.x, p.y, TILE, TILE, '#ff0044');
    px(ctx, p.x, p.y, TILE, 1, '#00ff00');
    px(ctx, p.x, p.y + TILE - 1, TILE, 1, '#00ff00');
    px(ctx, p.x, p.y, 1, TILE, '#00ff00');
    px(ctx, p.x + TILE - 1, p.y, 1, TILE, '#00ff00');
    addFrame(p, FRAMES.probe);
  }
  // 2) 地面：路径 / 可建造 / 停顿点 / 宝库
  {
    const p = next();
    px(ctx, p.x, p.y, TILE, TILE, '#3a3f52');
    px(ctx, p.x + 4, p.y + 4, 2, 2, '#4b5270');
    px(ctx, p.x + 10, p.y + 10, 2, 2, '#4b5270');
    addFrame(p, FRAMES.path);
  }
  {
    const p = next();
    px(ctx, p.x, p.y, TILE, TILE, '#22262f');
    addFrame(p, FRAMES.buildable);
  }
  {
    const p = next();
    px(ctx, p.x, p.y, TILE, TILE, '#3a3f52');
    px(ctx, p.x + 2, p.y + 2, 12, 12, '#ffd24a');
    px(ctx, p.x + 4, p.y + 4, 8, 8, '#3a3f52');
    addFrame(p, FRAMES.halt);
  }
  {
    const p = next();
    px(ctx, p.x, p.y, TILE, TILE, '#4a3a12');
    px(ctx, p.x + 2, p.y + 5, 12, 9, '#d9a02b');
    px(ctx, p.x + 2, p.y + 5, 12, 2, '#ffe066');
    px(ctx, p.x + 7, p.y + 8, 2, 3, '#5a4008');
    addFrame(p, FRAMES.vault);
  }
  // 3) 投射物（4×4 小点，居中）
  {
    const p = next();
    px(ctx, p.x + 6, p.y + 6, 4, 4, '#ffffff');
    addFrame(p, FRAMES.projectile);
  }
  {
    const p = next();
    px(ctx, p.x + 6, p.y + 6, 4, 4, '#ffd24a');
    addFrame(p, FRAMES.projectileGold);
  }
  // 4) 单位与敌人
  for (const u of unitIds) {
    const p = next();
    drawUnit(ctx, p.x, p.y, u.id, u.tier);
    addFrame(p, FRAMES.unitPrefix + u.id);
  }
  for (const e of enemyIds) {
    const p = next();
    drawEnemy(ctx, p.x, p.y, e.armorType, e.flying, e.boss);
    addFrame(p, FRAMES.enemyPrefix + e.id);
  }

  canvasTex.refresh();
  // 像素风必须显式 NEAREST（策划案 §8.5 第 5 条）
  canvasTex.setFilter(Phaser.Textures.FilterMode.NEAREST);

  return { key: ATLAS_KEY, frames: plan.map((p) => p.name) };
}

/** frame 名单（不落盘即可断言，供测试与报告使用）。 */
export function framePlan(
  unitIds: readonly { id: string }[],
  enemyIds: readonly { id: string }[],
): { name: string }[] {
  const names: string[] = [
    FRAMES.probe,
    FRAMES.path,
    FRAMES.buildable,
    FRAMES.halt,
    FRAMES.vault,
    FRAMES.projectile,
    FRAMES.projectileGold,
  ];
  for (const u of unitIds) names.push(FRAMES.unitPrefix + u.id);
  for (const e of enemyIds) names.push(FRAMES.enemyPrefix + e.id);
  return names.map((name) => ({ name }));
}

export function unitFrame(unitId: string): string {
  return FRAMES.unitPrefix + unitId;
}

export function enemyFrame(enemyId: string): string {
  return FRAMES.enemyPrefix + enemyId;
}
