/**
 * `ProceduralSpriteSource` —— 从 `units.json` / `enemies.json` **确定性**生成全部精灵。
 *
 * ## 视觉编码（方案 §2 / §8，冻结）
 * ```
 * 塔  line → 轮廓形状（◆▲⬢■●⬣▣∴✚）    tier → 底部齿数（1–5 个小方块）
 *     tier ≥ 3 → 轮廓线宽 +1px
 * 敌  护甲 → 边框画法：light 虚线 2-2 ｜ medium 实线 1px ｜ heavy 实线 2px
 *                      ｜ fortified 双层实线 ｜ divine 实线 2px + 四角金刻痕
 *     flying  → 本体两侧加翼（并入本体掩码）+ 下方 2px 留白
 *     isBoss  → 外圈金色实环（2px）
 *     精英    → 右上角金色星点
 *     stealResist > 0    → 左下挂锁
 *     stealResist = 1000 → 挂锁 + 斜杠（把锁切成两半）
 * ```
 *
 * ## 硬约束
 * - **零 Phaser 依赖**：只产出 RGBA 缓冲 + 图集描述，可在 Node 里裸跑。
 * - **确定性**：不使用 `Math.random()`；同一 id 永远生成同一张图（id 哈希播种）。
 * - **数据驱动**：新增一行 `units.json` 不需要改任何代码。
 * - **像素正确**：全部整数坐标 + 整块覆盖，零抗锯齿；缩放只用整数倍最近邻。
 *
 * ## 尺寸（方案 §8）
 * 塔 48×48 ｜ 普通敌 32×32 ｜ 精英 48×48 ｜ BOSS 96×96。
 * 本体直径恒为**帧宽的 1/2**：于是 BOSS 本体 48 = 普通敌帧宽 32 的 ×1.5，
 * 与方案 §2.2 的「尺寸 ×1.5」吻合；96 的帧是留给外圈金环与留白的。
 */
import { drawBarStack, layoutBars } from './bars';
import {
  enemyRank,
  inferElite,
  kindOfRank,
  type ArtContentInput,
  type EnemyArtInput,
  type SpriteRank,
  type UnitArtInput,
} from './content';
import {
  ENEMY_BODY,
  ENEMY_BODY_HI,
  ENEMY_CORE_DARK,
  GOLD,
  HILIGHT,
  INK,
  PLINTH,
  PLINTH_EDGE,
  resolveArmor,
  resolveLine,
  shade,
} from './palette';
import {
  addWings,
  bossRingMask,
  eliteStarOrigin,
  flyingGapFor,
  planPadlock,
  starMask,
} from './marks';
import { rngForId, type ArtRng } from './rng';
import {
  ARMOR_RING_INNER,
  ARMOR_RING_OUTER,
  borderMask,
  chebyshevDistance,
  cornerTicksMask,
  distanceBand,
  Mask,
  PixelCanvas,
  radiusForLine,
  shapeForLine,
  shapeMask,
} from './shapes';
import {
  ATLAS_GENERATOR,
  ATLAS_VERSION,
  frameKey,
  SPRITE_SIZE,
  STATES_FOR,
  type AtlasSpec,
  type FrameRef,
  type SpriteSource,
  type SpriteState,
} from './source';
import type { Rect, Rgba } from './types';

// ---------------------------------------------------------------------------
// 尺寸与几何常量（方案 §8 冻结值 + 由它推导的排版）
// ---------------------------------------------------------------------------

/** 塔的帧尺寸。 */
export const TOWER_SIZE = SPRITE_SIZE.tower;
/**
 * 塔本体的中心与半径（48 帧内）。
 *
 * `TOWER_CY = 19` 而不是 21：本体半径 14 + 轮廓最宽 2px → 本体底缘最多到 y=35，
 * 齿（y=36–39）必须**完全不被轮廓压住** —— 否则"数齿数"这个非颜色通道会被破坏
 * （这是 ASCII 预览逐像素查出来的，不是推测）。
 */
export const TOWER_CX = TOWER_SIZE / 2; // 24
export const TOWER_CY = 19;
export const TOWER_RADIUS = 14;
/** 底座（含齿）的纵向排版。 */
export const TOWER_PLINTH_Y = 35;
export const TOWER_PLINTH_H = 8;
export const TOWER_TEETH_Y = 36;
/** 齿宽。4px（而不是 3px）是为了让相邻品阶的**图案差**更大、更好数。 */
export const TOWER_TEETH_W = 4;
export const TOWER_TEETH_H = 4;
/**
 * 齿间距（px）。
 *
 * 刻意从 1 加大到 2：齿距 1 时 T1（居中 3px）与 T2（两侧各 3px）**重叠 2px**，
 * 相邻品阶只差 3 个像素，去色后在 1× 下很难数清。齿距 2 + 齿宽 4 后，
 * 相邻品阶的可见差异升到 ≥ 9px（5 齿总宽 5×4+4×2 = 28px，仍放得进 32px 底座）。
 */
export const TOWER_TEETH_GAP = 2;
/** 着地点（锚点，帧内坐标）。 */
export const TOWER_ANCHOR_X = TOWER_SIZE / 2;
export const TOWER_ANCHOR_Y = 43;

/** 单个精灵的渲染结果。 */
export interface SpriteFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
  readonly anchorX: number;
  readonly anchorY: number;
}

/** 敌人在某个帧尺寸下的几何。 */
export interface EnemyGeometry {
  readonly size: number;
  /** 本体标称半径（不含 id 抖动）—— 锚点由它推导，保证同档位锚点稳定。 */
  readonly baseRadius: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

/** 敌人在某档位下的几何（锚点恒定，与 id / 抖动无关）。 */
export function enemyGeometry(size: number): EnemyGeometry {
  const baseRadius = Math.floor(size / 4);
  return {
    size,
    baseRadius,
    anchorX: Math.floor(size / 2),
    anchorY: Math.floor(size / 2) + baseRadius + 1,
  };
}

/** 档位 → 帧尺寸。 */
export function spriteSizeOf(rank: SpriteRank): number {
  return SPRITE_SIZE[rank];
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function toSpriteFrame(canvas: PixelCanvas, anchorX: number, anchorY: number): SpriteFrame {
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: canvas.data.slice(),
    anchorX,
    anchorY,
  };
}

/** 在掩码内画一个 `w×h` 方块（**要求整块都在掩码内**，避免蹭出轮廓）。 */
function fillBlockIfSolid(
  canvas: PixelCanvas,
  mask: Mask,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgba,
): boolean {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (!mask.get(px, py)) return false;
    }
  }
  canvas.fillRect(x, y, w, h, color);
  return true;
}

/** 给掩码内的像素加 1px 顶部亮边（上邻接不在掩码内 → 该像素是上边缘）。 */
function rimLight(canvas: PixelCanvas, mask: Mask, color: Rgba): void {
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.get(x, y)) continue;
      if (!mask.get(x, y - 1)) canvas.setPx(x, y, color);
    }
  }
}

// ---------------------------------------------------------------------------
// 塔（48×48）
// ---------------------------------------------------------------------------

/** 状态 → 塔的形变参数（方案 §2.3 的"程序化变形"）。 */
interface TowerVariant {
  readonly dx: number;
  readonly flash: boolean;
  readonly muzzle: boolean;
  readonly ring: Rgba | null;
}

function towerVariant(state: SpriteState): TowerVariant {
  switch (state) {
    case 'attack':
      // 沿朝向偏移 1px + 中心白闪 + 出膛口 2×2 亮点
      return { dx: 1, flash: true, muzzle: true, ring: null };
    case 'upgrade':
      // 外扩 1px 圆环（单帧即"3 帧内消失"的第一帧）
      return { dx: 0, flash: false, muzzle: false, ring: GOLD };
    default:
      // idle：基准姿态（呼吸浮动是渲染期的 ±1px 位移，不占帧）
      return { dx: 0, flash: false, muzzle: false, ring: null };
  }
}

/** 底座 + 齿（不随状态位移，锚点稳定）。 */
function drawTowerBase(canvas: PixelCanvas, tier: number): void {
  const width = 32;
  const pxLeft = Math.floor(TOWER_SIZE / 2) - width / 2; // 24-16 = 8
  canvas.fillRect(pxLeft, TOWER_PLINTH_Y, width, TOWER_PLINTH_H, PLINTH);
  // 底座上沿 1px 亮线：让底座在任何背景下都能被"看见"
  canvas.fillRect(pxLeft, TOWER_PLINTH_Y, width, 1, PLINTH_EDGE);

  const teeth = clampInt(tier, 1, 5);
  const totalW = teeth * TOWER_TEETH_W + (teeth - 1) * TOWER_TEETH_GAP;
  const startX = TOWER_CX - Math.floor(totalW / 2);
  for (let i = 0; i < teeth; i++) {
    canvas.fillRect(
      startX + i * (TOWER_TEETH_W + TOWER_TEETH_GAP),
      TOWER_TEETH_Y,
      TOWER_TEETH_W,
      TOWER_TEETH_H,
      HILIGHT,
    );
  }
}

/**
 * 渲染一个塔帧。
 *
 * 分层：**底座层**（固定，锚点稳定）+ **本体层**（随状态位移）。
 * 本体层上依次是：填充 → 顶部亮边 → 轮廓（系）→ 状态附加（环/闪）。
 */
export function renderTowerFrame(unit: UnitArtInput, state: SpriteState): SpriteFrame {
  const size = TOWER_SIZE;
  const canvas = new PixelCanvas(size, size);
  const line = resolveLine(unit.line);
  const shape = shapeForLine(unit.line);
  const tier = clampInt(unit.tier, 1, 5);
  const lineWidth = tier >= 3 ? 2 : 1;
  const variant = towerVariant(state);

  // 1) 底座 + 齿（方案 §2.1：齿数 = 品阶）
  drawTowerBase(canvas, tier);

  // 2) 本体层
  const radius = radiusForLine(unit.line, TOWER_RADIUS);
  const body = shapeMask(shape, size, size, TOWER_CX, TOWER_CY, radius);
  const layer = new PixelCanvas(size, size);
  layer.fillMask(body, line.color);
  rimLight(layer, body, shade(line.color, 320));
  layer.fillMask(distanceBand(body, 1, lineWidth), INK);

  // 2b) 单位指纹（id 哈希）
  // 方案要求"两个不同 id 不得产生完全相同的像素"。塔的编码通道只有
  // 「轮廓 = 系」与「齿数 = 品阶」，因此**同系同品阶的两座塔天然撞图**
  // （实际数据里 `iron_gate` 与 `discipline_dean` 都是 drill T2 —— 这是单测
  // 抓出来的真实缺陷）。这里在轮廓**内部**点几颗 1px 暗痕：
  //   - 不改变轮廓/齿数/边框，不占用任何语义通道；
  //   - 位置由 id 哈希决定 → 确定性；
  //   - 9×9 的位置空间 × 2–4 颗 → 同系同阶也不会撞图。
  const sigilRng = rngForId(unit.id, 'sigil');
  const sigils = 2 + sigilRng.nextInt(3);
  const sigilColor = shade(line.color, -420);
  for (let i = 0; i < sigils; i++) {
    const sx = TOWER_CX + sigilRng.nextInt(9) - 4;
    const sy = TOWER_CY + sigilRng.nextInt(9) - 4;
    if (body.get(sx, sy)) layer.setPx(sx, sy, sigilColor);
  }

  // 3) 状态附加
  if (variant.ring) {
    layer.fillMask(distanceBand(body, lineWidth + 2, lineWidth + 2), variant.ring);
  }
  if (variant.flash) {
    layer.fillRect(TOWER_CX - 1, TOWER_CY - 1, 2, 2, HILIGHT);
  }
  if (variant.muzzle) {
    layer.fillRect(TOWER_CX + TOWER_RADIUS + 1, TOWER_CY - 1, 2, 2, HILIGHT);
  }

  layer.drawOnto(canvas, variant.dx, 0);
  return toSpriteFrame(canvas, TOWER_ANCHOR_X, TOWER_ANCHOR_Y);
}

// ---------------------------------------------------------------------------
// 敌人（32 / 48 / 96）
// ---------------------------------------------------------------------------

/** 状态 → 敌人的形变（方案 §2.3：walk 左右交替 1px 位移，周期 20 tick）。 */
function enemyVariant(state: SpriteState): { dx: number } {
  return state === 'walk' ? { dx: -1 } : { dx: 0 };
}

/** 敌人本体的几何 + 剪影掩码（含飞行时的翼痕）。 */
export interface EnemyBodyPlan {
  readonly size: number;
  readonly geo: EnemyGeometry;
  /** 本体标称半径 + id 抖动后的实际半径。 */
  readonly radius: number;
  readonly cx: number;
  readonly cy: number;
  /** 本体剪影（飞行时已并入翼痕）。 */
  readonly body: Mask;
  /** 翼痕矩形（非飞行时为 null）。 */
  readonly wings: { left: Rect; right: Rect } | null;
  /** 「护甲边框可占据的环带」= 到本体的切比雪夫距离落在 [2, 5]。 */
  readonly ringBand: Mask;
  /** 已消耗掉"半径抖动"那一次的随机流（保证与首版实现逐位一致）。 */
  readonly rng: ArtRng;
}

/**
 * 计算敌人的本体几何（**渲染与审计共用同一份**，避免"测量用的几何"和"画图用的几何"漂移）。
 *
 * 环带 `[2, 5]` 的来历见 `shapes.borderMask`：
 * 边框从距离 2 起（距离 1 是 1px 空隙），最宽的 `double` 伸到距离 5。
 * 这个环带是**验证护甲通道的唯一正确区域** —— 拿整只精灵比像素差，
 * 会被本体形状的差异淹没（本体差异 200–400px，边框差异几十 px）。
 */
export function enemyBodyPlan(enemy: EnemyArtInput): EnemyBodyPlan {
  const rank = enemyRank(enemy);
  const size = spriteSizeOf(rank);
  const geo = enemyGeometry(size);
  const rng = rngForId(enemy.id, 'body');
  const radius = geo.baseRadius + rng.nextInt(2);
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2) - (enemy.flying ? flyingGapFor(size) : 0);
  const body = shapeMask('circle', size, size, cx, cy, radius);
  const wings = enemy.flying ? addWings(body, cx, cy, radius, size) : null;
  const ringBand = distanceBand(body, ARMOR_RING_INNER, ARMOR_RING_OUTER);
  return { size, geo, radius, cx, cy, body, wings, ringBand, rng };
}

/**
 * 渲染一个敌人帧。
 *
 * 分层：**本体层**（本体 + 眼 + 芯 + 腹纹 + 护甲边框 + BOSS 金环，随 walk 位移）
 * 与**固定标记层**（四角刻痕 / 精英星 / 挂锁，钉在帧角上）。
 */
export function renderEnemyFrame(enemy: EnemyArtInput, state: SpriteState): SpriteFrame {
  const plan = enemyBodyPlan(enemy);
  const { size, geo, radius, cx, cy, body, wings, rng } = plan;
  const armor = resolveArmor(enemy.armorType);
  const variant = enemyVariant(state);

  const canvas = new PixelCanvas(size, size);

  // ---- 本体层 ----
  const layer = new PixelCanvas(size, size);
  layer.fillMask(body, ENEMY_BODY);
  rimLight(layer, body, ENEMY_BODY_HI);
  if (wings) {
    // 翼痕用高光色：它是"飞行"这个非颜色通道的载体，不能比本体还暗。
    layer.fillRect(wings.left.x, wings.left.y, wings.left.w, wings.left.h, HILIGHT);
    layer.fillRect(wings.right.x, wings.right.y, wings.right.w, wings.right.h, HILIGHT);
  }

  // 眼睛（亮色，非颜色通道里最"像脸"的部分）
  const eyeSize = Math.max(2, Math.round(size / 16));
  const eyeOff = 3 + rng.nextInt(2) + Math.floor(size / 32);
  const eyeY = cy - eyeSize;
  fillBlockIfSolid(layer, body, cx - eyeOff - eyeSize, eyeY, eyeSize, eyeSize, HILIGHT);
  fillBlockIfSolid(layer, body, cx + eyeOff, eyeY, eyeSize, eyeSize, HILIGHT);

  // 钱包核心：护甲色的圆芯（把"护甲"这个语义在色相与边框两个通道上冗余一次）
  const coreR = Math.max(2, Math.floor(radius / 3));
  layer.fillMask(shapeMask('circle', size, size, cx, cy + Math.floor(radius / 3), coreR), armor.color);

  // 腹纹：由 id 哈希决定，保证"两个不同 id 不产生完全相同的像素"。
  // 落点必须在掩码内（否则会蹭出轮廓）；重试是确定性的（RNG 顺序固定）。
  // 刻意做得**很轻**（比本体只暗一档）：它的职责是"独一无二"，不是"好看"，
  // 不能抢走护甲边框/标记这些语义通道的注意力。
  const belly = 1 + rng.nextInt(3);
  for (let i = 0; i < belly; i++) {
    const dot = size >= 64 ? 2 : 1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const bx = cx + rng.nextInt(radius * 2 + 1) - radius;
      const by = cy + rng.nextInt(radius * 2 + 1) - radius;
      if (fillBlockIfSolid(layer, body, bx, by, dot, dot, ENEMY_CORE_DARK)) break;
    }
  }

  // 护甲边框（非颜色通道的首要载体）
  layer.fillMask(borderMask(body, armor.style), armor.color);

  // BOSS 金环：在护甲边框外侧（最宽边框 double 到 4px，环放 6–7）
  if (enemy.isBoss) {
    const dist = chebyshevDistance(body);
    layer.fillMask(bossRingMask(dist, size, size, 6, 7), GOLD);
  }

  layer.drawOnto(canvas, variant.dx, 0);

  // ---- 固定标记层 ----
  if (armor.style === 'divine') {
    // 方案 §2.2：神圣甲 = 实线 2px + 四角金色刻痕
    const len = Math.max(4, Math.round(size / 8));
    canvas.fillMask(cornerTicksMask(size, size, len, 2), GOLD);
  }

  if (inferElite(enemy)) {
    const star = starMask(size >= 64 ? 9 : 7);
    const origin = eliteStarOrigin(size, star.width);
    canvas.fillMask(star, GOLD, origin.x, origin.y);
  }

  if (enemy.stealResist > 0) {
    const immune = enemy.stealResist >= 1000;
    const plan = planPadlock(geo.anchorY, size, immune);
    // 顺序：描边 → 斜杠外缘(亮) → 锁身 → 斜杠(暗)。
    // 斜杠必须在最上面才能把锁"切开"；外缘先画才能在暗背景上显出刀口。
    canvas.fillMask(plan.outline, plan.outlineColor, plan.origin.x, plan.origin.y);
    if (immune) canvas.fillMask(plan.slashEdge, HILIGHT, plan.origin.x, plan.origin.y);
    canvas.fillMask(plan.lock, plan.lockColor, plan.origin.x, plan.origin.y);
    if (immune) canvas.fillMask(plan.slash, plan.slashColor, plan.origin.x, plan.origin.y);
  }

  return toSpriteFrame(canvas, geo.anchorX, geo.anchorY);
}

/**
 * 护甲边框掩码 —— 直接转发到 `shapes.borderMask`。
 * 收口成一个函数是为了让 `procedural.ts` 里只有一处"样式 → 掩码"的映射，
 * 将来加护甲只改 `palette.ARMOR_META` + `shapes.borderMask`。
 */
function borderMaskFor(body: Mask, style: string): Mask {
  return borderMask(body, style as Parameters<typeof borderMask>[1]);
}

// ---------------------------------------------------------------------------
// 图集打包
// ---------------------------------------------------------------------------

interface AtlasItem {
  readonly key: string;
  readonly frame: SpriteFrame;
}

export interface ProceduralOptions {
  /** 图集宽度（默认 1024，2 的幂）。 */
  readonly atlasWidth?: number;
  /** 帧间距（默认 1px，防止 NEAREST 采样串色）。 */
  readonly padding?: number;
  /** 是否把全部状态帧都放进图集（默认 true；接触表可关掉以加速）。 */
  readonly includeStates?: boolean;
}

function nextPowerOfTwo(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/** 货架式打包（按高度降序，确定性）。 */
export function packAtlas(items: readonly AtlasItem[], maxWidth: number, padding: number): AtlasSpec {
  const sorted = [...items].sort((a, b) => b.frame.height - a.frame.height || (a.key < b.key ? -1 : 1));
  const frames: Record<string, FrameRef> = {};
  let cursorX = padding;
  let cursorY = padding;
  let rowHeight = 0;
  const width = maxWidth;
  for (const item of sorted) {
    const w = item.frame.width;
    const h = item.frame.height;
    if (w + 2 * padding > width) throw new Error(`帧 ${item.key} 宽 ${w} 放不进图集宽 ${width}`);
    if (cursorX + w + padding > width) {
      cursorX = padding;
      cursorY += rowHeight + padding;
      rowHeight = 0;
    }
    frames[item.key] = {
      x: cursorX,
      y: cursorY,
      w,
      h,
      anchorX: item.frame.anchorX,
      anchorY: item.frame.anchorY,
    };
    cursorX += w + padding;
    rowHeight = Math.max(rowHeight, h);
  }
  const height = nextPowerOfTwo(cursorY + rowHeight + padding);
  return {
    imageWidth: width,
    imageHeight: height,
    frames,
    meta: { generator: ATLAS_GENERATOR, version: ATLAS_VERSION },
  };
}

function blitFrame(
  dst: Uint8ClampedArray,
  dstWidth: number,
  frame: SpriteFrame,
  x: number,
  y: number,
): void {
  for (let row = 0; row < frame.height; row++) {
    const srcStart = row * frame.width * 4;
    const dstStart = ((y + row) * dstWidth + x) * 4;
    dst.set(frame.pixels.subarray(srcStart, srcStart + frame.width * 4), dstStart);
  }
}

/**
 * ★ 程序化占位精灵源（当前实现）。
 *
 * 全部像素在构造时**一次性**生成并缓存；`render()` 只做一次图集拷贝，
 * 因此可以每帧调用而不产生额外 GC 压力。
 */
export class ProceduralSpriteSource implements SpriteSource {
  readonly atlas: AtlasSpec;
  private readonly items: readonly AtlasItem[];

  constructor(content: ArtContentInput, options: ProceduralOptions = {}) {
    const includeStates = options.includeStates ?? true;
    const items: AtlasItem[] = [];
    for (const unit of content.units) {
      const states = includeStates ? STATES_FOR.tower : (['idle'] as const);
      for (const state of states) {
        items.push({ key: frameKey(unit.id, state), frame: renderTowerFrame(unit, state) });
      }
    }
    for (const enemy of content.enemies) {
      const states = includeStates ? STATES_FOR.enemy : (['idle'] as const);
      for (const state of states) {
        items.push({ key: frameKey(enemy.id, state), frame: renderEnemyFrame(enemy, state) });
      }
    }
    this.items = items;
    this.atlas = packAtlas(items, options.atlasWidth ?? 1024, options.padding ?? 1);
  }

  render(): Uint8ClampedArray {
    const { imageWidth, imageHeight, frames } = this.atlas;
    const out = new Uint8ClampedArray(imageWidth * imageHeight * 4);
    for (const item of this.items) {
      const ref = frames[item.key];
      if (!ref) continue;
      blitFrame(out, imageWidth, item.frame, ref.x, ref.y);
    }
    return out;
  }

  /** 单个精灵的像素（不经过图集，测试与接触表用）。 */
  frameFrame(key: string): SpriteFrame | undefined {
    return this.items.find((i) => i.key === key)?.frame;
  }

  /** 全部 key（确定顺序）。 */
  keys(): string[] {
    return this.items.map((i) => i.key);
  }
}

// ---------------------------------------------------------------------------
// 便捷入口（接触表 / 测试）
// ---------------------------------------------------------------------------

/** 渲染"带血条 + 钱包条 + 阻挡点"的示意精灵（接触表 §4 第 4 条）。 */
export function renderBarsDemo(
  size: number,
  hpPermille: number,
  walletPermille: number,
  blocked: boolean,
): { width: number; height: number; pixels: Uint8ClampedArray; anchorX: number; anchorY: number } {
  const padTop = 10;
  const canvas = new PixelCanvas(size, size + padTop);
  const anchorX = Math.floor(size / 2);
  const anchorY = padTop + enemyGeometry(size).anchorY;
  const layout = layoutBars(size, anchorX, anchorY);
  drawBarStack(canvas, layout, hpPermille, walletPermille, blocked);
  // 用一块中性色块代替"精灵本体"，把注意力集中在条上
  canvas.fillRect(anchorX - Math.floor(size / 4), anchorY - Math.floor(size / 2), Math.floor(size / 2), Math.floor(size / 2), ENEMY_BODY);
  return { width: canvas.width, height: canvas.height, pixels: canvas.data.slice(), anchorX, anchorY };
}

export { kindOfRank };
