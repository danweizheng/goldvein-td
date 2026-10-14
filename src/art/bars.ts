/**
 * 血条 / **钱包条** / 阻挡条的规格与画法（方案 §2.4）。
 *
 * 方案原文：**「条状 UI 应由渲染层绘制，不是精灵。美术模块只输出规格」**。
 * 所以本文件分两层：
 * 1. `BAR_SPECS` —— 交给 `src/render/**` 的**规格表**（位置/颜色/尺寸/重要度）；
 * 2. `layoutBars` / `drawBarStack` —— 规格的可执行版本（供接触表示意与单测断言）。
 *
 * ★ 钱包条是本作**招牌机制**的可视化：「宁可砍血条也不能砍钱包条」。
 *   因此它的规格里额外带 `ringPx: 1`（暗色外圈）+ `slot`（底槽），
 *   保证 1px 金条在杂乱战场背景上依然"最醒目"。
 *
 * ⚠️ 零 Phaser 依赖。坐标全为整数。
 */
import { GOLD, HP_HIGH, HP_LOW, HP_MID, HILIGHT, INK, mix, WALLET_RING, WALLET_SLOT, type Rgba } from './palette';
import type { PixelCanvas } from './shapes';
import type { Rect } from './types';

/** 条的 id（与快照字段对应）。 */
export type BarId = 'hp' | 'wallet' | 'block';

/** 条的规格（**这是给渲染层的契约**，不含任何绘制代码）。 */
export interface BarSpec {
  readonly id: BarId;
  /**
   * 摆放规则（符号化，避免把某一尺寸的数字写死 —— 32/48/96 三种帧都要成立）：
   * - `aboveSprite2px`：精灵可视顶边上 2px（血条）
   * - `belowHp1px`：血条下方 1px，外圈占掉那 1px（钱包条）
   * - `feetBelow1px`：着地点下方 1px（阻挡点）
   */
  readonly place: 'aboveSprite2px' | 'belowHp1px' | 'feetBelow1px';
  /** 宽度表达式：`body` = 本体可视宽度（帧宽 / 2），`fixed1` = 1px。 */
  readonly widthFrom: 'body' | 'fixed1';
  /** 高度（方案 §2.4 冻结：一律 1px）。 */
  readonly height: 1;
  /** 填充色规则。 */
  readonly fill: 'hpGradient' | 'gold' | 'white';
  /** 底槽色（无底槽时为 null）。 */
  readonly slot: Rgba | null;
  /** 外圈暗色宽度（px）。钱包条专用 —— 让 1px 金条能被"定位"。 */
  readonly ringPx: number;
  /** 重要度：2 = 招牌机制（不可砍），1 = 常规。 */
  readonly priority: 1 | 2;
  /** 一句话说明（会出现在接触表上，也是给渲染层的注记）。 */
  readonly note: string;
}

/**
 * 冻结规格表（方案 §2.4）。
 *
 * 垂直堆叠顺序（自上而下）：**血条 → 钱包条 → 精灵本体 → 阻挡点**。
 * 具体像素由 `layoutBars(spriteSize, anchorX, anchorY)` 算出。
 */
export const BAR_SPECS: readonly BarSpec[] = [
  {
    id: 'hp',
    place: 'aboveSprite2px',
    widthFrom: 'body',
    height: 1,
    fill: 'hpGradient',
    slot: INK,
    ringPx: 0,
    priority: 1,
    note: 'HP：精灵上方 2px，宽=本体宽，高 1px，红→绿渐变（按比例取色）',
  },
  {
    id: 'wallet',
    place: 'belowHp1px',
    widthFrom: 'body',
    height: 1,
    fill: 'gold',
    slot: WALLET_SLOT,
    ringPx: 1,
    priority: 2,
    note: '★钱包：HP 条下方 1px，金 #ffc832，有底槽 + 1px 暗外圈（招牌机制，不可砍）',
  },
  {
    id: 'block',
    place: 'feetBelow1px',
    widthFrom: 'fixed1',
    height: 1,
    fill: 'white',
    slot: null,
    ringPx: 0,
    priority: 1,
    note: '阻挡：精灵脚下 1px 白点（1×1）。只能表达"有/无被阻挡"，无法表达名额数',
  },
] as const;

/** 条堆叠的整体高度（含外圈），供排版预算使用。 */
export const BAR_STACK_HEIGHT = 6;

// ---------------------------------------------------------------------------
// 颜色规则
// ---------------------------------------------------------------------------

/**
 * HP 条颜色：按血量比例在 红 → 黄 → 绿 之间取色（千分比，整数路径）。
 * 方案 §2.4 的「红→绿渐变」指的是**随比例变色**（1px 高不可能做条内渐变）。
 */
export function hpColor(ratioPermille: number): Rgba {
  const r = Math.max(0, Math.min(1000, Math.round(ratioPermille)));
  return r < 500 ? mix(HP_LOW, HP_MID, (r * 1000) / 500) : mix(HP_MID, HP_HIGH, ((r - 500) * 1000) / 500);
}

/**
 * 钱包条填充宽度（千分比 → 像素，向下取整但**不吞掉最后 1px**：
 * 只要还剩任意正数钱包就至少画 1px —— 否则玩家会误以为"已经偷空"）。
 */
export function walletFillWidth(width: number, ratioPermille: number): number {
  const r = Math.max(0, Math.min(1000, Math.round(ratioPermille)));
  if (r === 0) return 0;
  return Math.max(1, Math.round((width * r) / 1000));
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

/** 一个精灵的条布局（世界/屏幕坐标，整数）。 */
export interface BarLayout {
  readonly hp: Rect;
  readonly walletSlot: Rect;
  readonly walletFillArea: Rect;
  readonly walletRing: Rect;
  readonly block: Rect;
}

/** 本体可视宽度 = 帧宽 / 2（见 `procedural.ts` 的尺寸表）。 */
export function bodyWidthOf(spriteSize: number): number {
  return Math.floor(spriteSize / 2);
}

/**
 * 计算一个精灵的条布局。
 *
 * `spriteSize` 取 `SPRITE_SIZE` 之一（32 / 48 / 96），`anchor` 是精灵的着地点。
 * 垂直偏移按**本体可视区**推导，而不是按帧高 —— 否则 96 帧的 BOSS
 * 会把血条顶到离本体 24px 之外。
 */
export function layoutBars(spriteSize: number, anchorX: number, anchorY: number): BarLayout {
  const bodyW = bodyWidthOf(spriteSize);
  const x = anchorX - Math.floor(bodyW / 2);
  // 本体顶边：帧内 size/4；护甲边框最多外扩 4px；再留 2px 间隙。
  const bodyTopFromAnchor = -(Math.floor(spriteSize / 2) + 1);
  const spriteTopFromAnchor = bodyTopFromAnchor - 4;
  const hpY = anchorY + spriteTopFromAnchor - 3;
  const walletY = hpY + 2;
  return {
    hp: { x, y: hpY, w: bodyW, h: 1 },
    walletSlot: { x, y: walletY, w: bodyW, h: 1 },
    walletFillArea: { x, y: walletY, w: bodyW, h: 1 },
    walletRing: { x: x - 1, y: walletY - 1, w: bodyW + 2, h: 3 },
    block: { x: anchorX - 1, y: anchorY + 1, w: 1, h: 1 },
  };
}

// ---------------------------------------------------------------------------
// 画法（接触表 + 背景/地板复用；渲染层可以照抄，也可以只读规格表）
// ---------------------------------------------------------------------------

/** 画 HP 条（含底槽）。`ratioPermille` 为 0–1000。 */
export function drawHpBar(canvas: PixelCanvas, rect: Rect, ratioPermille: number): void {
  canvas.fillRect(rect.x, rect.y, rect.w, rect.h, INK);
  const fill = Math.round((rect.w * Math.max(0, Math.min(1000, ratioPermille))) / 1000);
  if (fill > 0) canvas.fillRect(rect.x, rect.y, fill, rect.h, hpColor(ratioPermille));
}

/**
 * 画钱包条：暗外圈 → 底槽 → 金填充。
 *
 * 顺序刻意如此：外圈先铺满整条（含左右各 1px），底槽覆盖中间，
 * 金条最后压在底槽上 —— 于是"被偷掉多少"永远显示为**暗槽长度**，
 * 与血条（空槽也是暗色）的读法一致。
 */
export function drawWalletBar(canvas: PixelCanvas, layout: BarLayout, ratioPermille: number): void {
  const { walletSlot, walletRing } = layout;
  if (walletRing.w > 0) canvas.fillRect(walletRing.x, walletRing.y, walletRing.w, walletRing.h, WALLET_RING);
  canvas.fillRect(walletSlot.x, walletSlot.y, walletSlot.w, walletSlot.h, WALLET_SLOT);
  const fill = walletFillWidth(walletSlot.w, ratioPermille);
  if (fill > 0) canvas.fillRect(walletSlot.x, walletSlot.y, fill, walletSlot.h, GOLD);
}

/** 画阻挡点（1×1 白点）。 */
export function drawBlockTick(canvas: PixelCanvas, rect: Rect, color: Rgba = HILIGHT): void {
  canvas.fillRect(rect.x, rect.y, rect.w, rect.h, color);
}

/** 一次性画完整个条堆叠（接触表示意用）。 */
export function drawBarStack(
  canvas: PixelCanvas,
  layout: BarLayout,
  hpPermille: number,
  walletPermille: number,
  blocked: boolean,
): void {
  drawHpBar(canvas, layout.hp, hpPermille);
  drawWalletBar(canvas, layout, walletPermille);
  if (blocked) drawBlockTick(canvas, layout.block);
}
