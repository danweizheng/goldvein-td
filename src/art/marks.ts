/**
 * 属性标记（方案 §2.2 / §2.5 的"附加标记"）。
 *
 * | 属性 | 标记 | 为什么是非颜色通道 |
 * |---|---|---|
 * | `flying` | 本体轮廓加翼 + 下方 2px 留白 | 剪影变化 + 垂直位移 |
 * | `isBoss` | 外圈金色实环 | 附加环形结构 |
 * | 精英 | 右上角金色星点 | 附加字形 |
 * | `stealResist > 0` | 左下挂锁字形 | 附加字形 |
 * | `stealResist = 1000` | 挂锁 + 斜杠（把锁切成两半） | 剪影被切断 |
 *
 * 关键设计：**挂锁与星点都是"字形"**，不是"颜色点"。去色后
 * 它们仍是可数的实体形状，因此灰度/色盲版本不会丢失信息。
 *
 * ⚠️ 零 Phaser 依赖。
 */
import { HILIGHT, INK, type Rgba } from './palette';
import { edgeOf, Mask, outlineMask } from './shapes';
import type { Rect } from './types';

/**
 * 翼痕长度（px，**32px 基准**）。方案 §2.2 写「两侧各 1px 翼痕」—— 指线宽 1px。
 *
 * ★ 实际长度必须按帧尺寸放大（`markScaleFor`）：48 帧 → 6px，96 帧 → 9px。
 * 原实现把它写成固定 3px，于是 96 帧 BOSS 的翼痕在比例上只有普通怪的 1/3 ——
 * 实测 ascendant 的翼痕带只比地面态多 9px（放大后大幅提升）。挂锁与星点
 * 本来就按 `markScaleFor` 缩放，翼痕漏了，这是实现不一致。
 */
export const WING_LENGTH = 3;
/**
 * 飞行留白高度（px，**32px 基准**）。方案 §2.2：下方 2px 阴影留白。
 *
 * ★ 实际高度按帧尺寸等比放大（`flyingGapFor`）：32→2px、48→4px、96→6px。
 * 理由与翼痕/挂锁/星点完全一致 —— 标记几何必须随精灵尺寸缩放，
 * 否则 96 帧 BOSS 的"2px 留白"在比例上只有普通怪的 1/3，而且会被它自己的
 * 金环占满（实测：飞行态留白带 65px > 地面态 56px，"留白"根本不空白）。
 */
export const FLYING_GAP = 2;

/** 按帧尺寸推导飞行留白高度（32→2、48→4、96→6）。 */
export function flyingGapFor(frameSize: number): number {
  return FLYING_GAP * markScaleFor(frameSize);
}
/** 挂锁字形的原始尺寸（5×8 锁身 + 1px 斜杠余量）。 */
export const PADLOCK_W = 7;
export const PADLOCK_H = 10;

// ---------------------------------------------------------------------------
// 掩码缩放（把 32px 基准的标记放大到 48 / 96 的帧上）
// ---------------------------------------------------------------------------

/** 整数倍最近邻放大（零插值，像素不糊）。 */
export function scaleMask(mask: Mask, factor: number): Mask {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return mask.clone();
  const out = new Mask(mask.width * f, mask.height * f);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.get(x, y)) continue;
      out.setRect(x * f, y * f, f, f);
    }
  }
  return out;
}

/** 按帧尺寸推导标记放大倍率：32 → 1，48 → 2，96 → 3。 */
export function markScaleFor(frameSize: number): number {
  return Math.max(1, Math.round(frameSize / 32));
}

// ---------------------------------------------------------------------------
// 飞行：翼痕并入本体掩码
// ---------------------------------------------------------------------------

/**
 * 在**本体掩码**两侧加翼痕，并返回两段翼痕的矩形（供调用方上亮色）。
 *
 * 刻意并入本体（而不是事后画两根线）的理由：护甲边框由本体距离场导出，
 * 因此边框会自动把翅膀一起包进去 —— 翼痕不会被边框盖住，
 * 也不会把"虚线 / 实线 / 双层"的边框节奏打断（那是护甲的首要通道）。
 *
 * `frameSize` 用于按帧尺寸放大翼痕长度（32→3px、48→6px、96→9px）。
 */
export function addWings(
  body: Mask,
  cx: number,
  cy: number,
  radius: number,
  frameSize = 32,
): { left: Rect; right: Rect } {
  const len = WING_LENGTH * markScaleFor(frameSize);
  const left: Rect = { x: cx - radius - len, y: cy, w: len, h: 1 };
  const right: Rect = { x: cx + radius + 1, y: cy, w: len, h: 1 };
  body.setRect(left.x, left.y, left.w, left.h);
  body.setRect(right.x, right.y, right.w, right.h);
  return { left, right };
}

// ---------------------------------------------------------------------------
// BOSS：外圈金色实环
// ---------------------------------------------------------------------------

/**
 * BOSS 金环：紧贴护甲边框**外侧**的 2px 实环。
 *
 * `inner = 7` 保证它与最宽的护甲边框（`double`，最大外扩 5px，见
 * `shapes.BORDER_REACH`）之间留 1px 空隙，因此"城甲 + BOSS"
 * （`boss_behemoth`：`fortified` + `isBoss`）两个通道不会糊在一起。
 */
export function bossRingMask(bodyDistance: Int32Array, width: number, height: number, inner = 7, outer = 8): Mask {
  const out = new Mask(width, height);
  for (let i = 0; i < bodyDistance.length; i++) {
    const v = bodyDistance[i]!;
    if (v >= inner && v <= outer) out.bits[i] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 精英：右上角金色星点
// ---------------------------------------------------------------------------

/**
 * 星点字形（✦ 形，`size` 为奇数）。7×7 时是 25 个实心像素，
 * 在任何底色上都是"可数的字形"，不依赖色相。
 */
export function starMask(size = 7): Mask {
  const s = size % 2 === 1 ? size : size + 1;
  const c = (s - 1) / 2;
  const m = new Mask(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.abs(x - c) + Math.abs(y - c);
      if (d <= c) m.set(x, y);
    }
  }
  return m;
}

/** 精英星点应落的位置（帧右上角，内缩 1px）。 */
export function eliteStarOrigin(frameW: number, starSize = 7): { x: number; y: number } {
  return { x: frameW - starSize - 1, y: 1 };
}

// ---------------------------------------------------------------------------
// 窃金抗性：挂锁（+ 斜杠）
// ---------------------------------------------------------------------------

/**
 * 挂锁字形的位图（5 宽 × 8 高，`1` = 实心）。
 *
 * 尺寸刻意压到 5px 宽：32×32 的帧里，本体（直径 16）加护甲边框（最多外扩 5px）
 * 已经吃掉了大半宽度，锁身再宽就会压住本体轮廓或边框左半圈。
 * 5×8 的锁放在左下角时与本体**完全不重叠**，只会在双层甲的场合擦到最内一圈。
 */
const PADLOCK_ROWS: readonly string[] = [
  '.111.',
  '.1.1.',
  '.1.1.',
  '11111',
  '11111',
  '11011',
  '11111',
  '11111',
];

/**
 * 挂锁字形（含 1px 斜杠余量，返回 7×10 的掩码）。
 *
 * `slashed = true` 时**多返回**一条覆盖挂锁的反斜杠带（把锁切成两半），
 * 用于表达 `stealResist = 1000`（窃金免疫）。
 * 斜杠带与锁是分开返回的，调用方可以分别上色（锁亮、斜杠暗）。
 */
export function padlockMask(slashed: boolean): { lock: Mask; slash: Mask } {
  const lock = new Mask(PADLOCK_W, PADLOCK_H);
  for (let r = 0; r < PADLOCK_ROWS.length; r++) {
    const row = PADLOCK_ROWS[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '1') lock.set(c + 1, r + 1);
    }
  }
  const slash = new Mask(PADLOCK_W, PADLOCK_H);
  if (slashed) {
    // 2px 宽的反斜杠：x + y - (PADLOCK_W - 1) ∈ {-1, 0}
    for (let y = 0; y < PADLOCK_H; y++) {
      for (let x = 0; x < PADLOCK_W; x++) {
        const k = x + y - (PADLOCK_W - 1);
        if (k === -1 || k === 0) slash.set(x, y);
      }
    }
  }
  return { lock, slash };
}

/** 挂锁落点（帧左下角，底边对齐地面线）。 */
export function padlockOrigin(anchorY: number, scale: number): { x: number; y: number } {
  return { x: 1, y: anchorY - PADLOCK_H * scale };
}
export interface PadlockDrawPlan {
  readonly origin: { x: number; y: number };
  readonly lock: Mask;
  readonly outline: Mask;
  /** 斜杠带（切成两半的"刀口"，暗色）。 */
  readonly slash: Mask;
  /** 斜杠带的 1px 外缘（亮色）—— 让刀口在暗背景上也能被看见。 */
  readonly slashEdge: Mask;
  readonly lockColor: Rgba;
  readonly outlineColor: Rgba;
  readonly slashColor: Rgba;
}

/**
 * 组装挂锁的绘制计划（**纯函数**，便于单测直接断言字形）。
 * 描边保证挂锁在任何本体色上都能被看见（浅色本体 + 亮锁会糊在一起）。
 *
 * 免疫（`slashed`）时的绘制顺序刻意是
 * `描边 → 斜杠外缘(亮) → 锁身(亮) → 斜杠(暗)`：
 * 刀口在锁身上表现为**被切掉的一条暗带**，在锁外表现为两条亮边 ——
 * 于是"挂锁 + 斜杠"在灰度/色盲版里同样是一个**形状**差异，而不是颜色差异。
 */
export function planPadlock(anchorY: number, frameSize: number, slashed: boolean): PadlockDrawPlan {
  const scale = Math.min(3, markScaleFor(frameSize));
  const { lock, slash } = padlockMask(slashed);
  const lockS = scaleMask(lock, scale);
  const slashS = scaleMask(slash, scale);
  return {
    origin: padlockOrigin(anchorY, scale),
    lock: lockS,
    outline: outlineMask(lockS, 1),
    slash: slashS,
    slashEdge: slashed ? edgeOf(slashS) : new Mask(1, 1),
    lockColor: HILIGHT,
    outlineColor: INK,
    slashColor: INK,
  };
}
