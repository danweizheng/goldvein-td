/**
 * 形状语法与边框画法（方案 §2.1 / §2.2 / §2.5）。
 *
 * ## 为什么自定义而不是用 Canvas 2D
 * 方案要求**像素正确**：全部整数坐标、零抗锯齿。`CanvasRenderingContext2D`
 * 的 `arc`/`lineTo` 会产生小数覆盖与混色边缘（即使 `imageSmoothingEnabled=false`，
 * 路径填充本身仍是解析式抗锯齿）。所以这里直接操作 RGBA 缓冲，
 * 形状用**整数判据**（棋盘/切比雪夫/内积）逐像素判定，边框由**切比雪夫距离变换**导出。
 *
 * ## 非颜色通道
 * - 塔系 → 轮廓形状（`shapeMask`）
 * - 品阶 → 底部齿数（在 `procedural.ts` 里画）
 * - 护甲 → 边框画法（`borderMask`：虚线 / 实线 / 双线 / 双层 / 四角刻痕）
 * - 飞行 → 本体轮廓加翼 + 下方 2px 留白
 * - 窃金抗性 → 挂锁字形（`marks.ts`）
 *
 * 上面每一项都是**形状/纹理**通道，去色后依然成立（方案 §2.5 硬要求）。
 *
 * ⚠️ 零 Phaser 依赖，Node 里可裸跑。
 */
import { over } from './palette';
import type { Rgba } from './types';

// ---------------------------------------------------------------------------
// 像素画布
// ---------------------------------------------------------------------------

/**
 * 纯缓冲的像素画布。所有写入都是**整数坐标 + 整块覆盖**，不存在
 * 半透明边缘（除非显式使用 `blendPx`）。
 */
export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  /** RGBA，行优先，长度 = width × height × 4。 */
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`PixelCanvas 尺寸必须是正整数，收到 ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  /** 该坐标是否在画布内。 */
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** 直接覆盖写入（不做混合）。越界静默丢弃 —— 允许"画出去"，便于复用形状。 */
  setPx(x: number, y: number, c: Rgba): void {
    if (!this.inside(x, y)) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = c[3];
  }

  /** 源覆盖混合写入（仅阴影/柔光用，边缘仍是硬边）。 */
  blendPx(x: number, y: number, c: Rgba): void {
    if (!this.inside(x, y)) return;
    if (c[3] >= 255) {
      this.setPx(x, y, c);
      return;
    }
    const i = (y * this.width + x) * 4;
    const dst: Rgba = [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
    const out = over(c, dst);
    this.data[i] = out[0];
    this.data[i + 1] = out[1];
    this.data[i + 2] = out[2];
    this.data[i + 3] = out[3];
  }

  /** 读回像素（越界返回全透明）。 */
  getPx(x: number, y: number): Rgba {
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /** 实心矩形（整数坐标）。 */
  fillRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.setPx(px, py, c);
    }
  }

  /** 空心矩形边框，线宽 `thickness` px，**向内**绘制。 */
  strokeRect(x: number, y: number, w: number, h: number, c: Rgba, thickness = 1): void {
    for (let t = 0; t < thickness; t++) {
      this.fillRect(x + t, y + t, w - 2 * t, 1, c);
      this.fillRect(x + t, y + h - 1 - t, w - 2 * t, 1, c);
      this.fillRect(x + t, y + t, 1, h - 2 * t, c);
      this.fillRect(x + w - 1 - t, y + t, 1, h - 2 * t, c);
    }
  }

  /** 按掩码填色（掩码与画布同尺寸或更小；`ox`/`oy` 为落点偏移）。 */
  fillMask(mask: Mask, c: Rgba, ox = 0, oy = 0): void {
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (mask.get(x, y)) this.setPx(x + ox, y + oy, c);
      }
    }
  }

  /** 深拷贝（用于在基准帧上叠加状态变形）。 */
  clone(): PixelCanvas {
    const copy = new PixelCanvas(this.width, this.height);
    copy.data.set(this.data);
    return copy;
  }

  /** 把自身整帧拷贝到 `dst` 的 (dx, dy)（只拷贝非透明像素）。 */
  drawOnto(dst: PixelCanvas, dx: number, dy: number): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.getPx(x, y);
        if (c[3] === 0) continue;
        dst.setPx(x + dx, y + dy, c);
      }
    }
  }

  /** 统计非透明像素数（测试用）。 */
  opaqueCount(): number {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] > 0) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// 掩码
// ---------------------------------------------------------------------------

/** 单通道位掩码（1 = 实心）。 */
export class Mask {
  readonly width: number;
  readonly height: number;
  readonly bits: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`Mask 尺寸必须是正整数，收到 ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.bits = new Uint8Array(width * height);
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.bits[y * this.width + x] === 1;
  }

  set(x: number, y: number, value = true): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.bits[y * this.width + x] = value ? 1 : 0;
  }

  setRect(x: number, y: number, w: number, h: number): void {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) this.set(px, py);
  }

  /** 实心像素计数。 */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.bits.length; i++) n += this.bits[i];
    return n;
  }

  hasAny(): boolean {
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) return true;
    return false;
  }

  clone(): Mask {
    const m = new Mask(this.width, this.height);
    m.bits.set(this.bits);
    return m;
  }
}

/** 由判定函数构造掩码。 */
export function maskFrom(w: number, h: number, pred: (x: number, y: number) => boolean): Mask {
  const m = new Mask(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pred(x, y)) m.set(x, y);
  return m;
}

/** 并集。 */
export function unionMask(...masks: readonly Mask[]): Mask {
  if (masks.length === 0) throw new Error('unionMask 需要至少一个掩码');
  const out = masks[0]!.clone();
  for (let i = 1; i < masks.length; i++) {
    const m = masks[i]!;
    for (let j = 0; j < out.bits.length; j++) if (m.bits[j]) out.bits[j] = 1;
  }
  return out;
}

/** 交集。 */
export function intersectMask(a: Mask, b: Mask): Mask {
  const out = new Mask(a.width, a.height);
  for (let j = 0; j < out.bits.length; j++) out.bits[j] = a.bits[j] && b.bits[j] ? 1 : 0;
  return out;
}

/** 差集 `a - b`。 */
export function subtractMask(a: Mask, b: Mask): Mask {
  const out = a.clone();
  for (let j = 0; j < out.bits.length; j++) if (b.bits[j]) out.bits[j] = 0;
  return out;
}

/** 掩码像素列表（确定顺序：行优先）。 */
export function maskPixels(m: Mask): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) if (m.get(x, y)) out.push({ x, y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 形状语法（塔系 → 轮廓，方案 §2.1）
// ---------------------------------------------------------------------------

/** 方案 §2.1 的 9 种轮廓。 */
export type ShapeId =
  | 'diamond' // ◆ thief
  | 'triangle' // ▲ archer
  | 'hexagon' // ⬢ mage
  | 'square' // ■ drill
  | 'circle' // ● beauty
  | 'octagon' // ⬣ cannon
  | 'notchedSquare' // ▣ worker
  | 'dotCluster' // ∴ sprite
  | 'cross'; // ✚ tech

/** 形状 → 方案里的 Unicode 记号（接触表图例直接用它作标签）。 */
export const SHAPE_GLYPH: Readonly<Record<ShapeId, string>> = {
  diamond: '◆',
  triangle: '▲',
  hexagon: '⬢',
  square: '■',
  circle: '●',
  octagon: '⬣',
  notchedSquare: '▣',
  dotCluster: '∴',
  cross: '✚',
};

/**
 * 塔系 → 轮廓形状（方案 §2.1 / §8 第一行，逐字对应）。
 * 放在 `shapes.ts` 而不是 `palette.ts`：色板不知道形状，
 * 而形状模块已经依赖色板 —— 反过来会造成循环 import。
 */
export const LINE_SHAPE: Readonly<Record<string, ShapeId>> = {
  thief: 'diamond',
  archer: 'triangle',
  mage: 'hexagon',
  drill: 'square',
  beauty: 'circle',
  cannon: 'octagon',
  worker: 'notchedSquare',
  sprite: 'dotCluster',
  tech: 'cross',
};

/** 未知塔系的兜底轮廓（六边形，最容易看出"这是个未被编码的新系"）。 */
export const FALLBACK_SHAPE: ShapeId = 'hexagon';

/**
 * 各轮廓的半径系数（千分比，基准半径 × 系数）。
 *
 * 方案只规定了"形状 = 系"，没有规定各形状一样大。这里刻意让
 * `worker`（▣ 小方块）与 `drill`（■ 方形）在**尺寸**上也分开：
 * worker 是"小方块 + 缺口"，drill 是占满的方块 —— 两者同时用形状与体量区分，
 * 去色后更容易分辨。其余形状保持同一体量，避免"大小"变成第二个品阶通道。
 */
export const SHAPE_RADIUS_SCALE: Readonly<Record<ShapeId, number>> = {
  diamond: 1000,
  triangle: 1000,
  hexagon: 1000,
  square: 930,
  circle: 1000,
  octagon: 1000,
  notchedSquare: 720,
  dotCluster: 1000,
  cross: 1000,
};

/** 某塔系轮廓的半径（基准 14px）。 */
export function radiusForLine(line: string, baseRadius = 14): number {
  const shape = shapeForLine(line);
  return Math.max(4, Math.round((baseRadius * SHAPE_RADIUS_SCALE[shape]) / 1000));
}

/** 取塔系轮廓（未知塔系不抛异常，返回兜底形状）。 */
export function shapeForLine(line: string): ShapeId {
  return LINE_SHAPE[line] ?? FALLBACK_SHAPE;
}

/**
 * 生成形状掩码（**已在帧坐标系里**，中心 `(cx, cy)`，半尺寸 `radius`）。
 *
 * 所有判据都在"双倍坐标"下做整数比较，因此：
 * - 完全对称（左右/上下），不会出现半像素偏差；
 * - 不依赖任何浮点三角函数。
 */
export function shapeMask(
  shape: ShapeId,
  frameW: number,
  frameH: number,
  cx: number,
  cy: number,
  radius: number,
): Mask {
  // 三角形的收窄是线性的，单独实现（整数不等式，无除法）。
  if (shape === 'triangle') return triangleMask(frameW, frameH, cx, cy, radius);
  const R2 = 2 * radius;
  return maskFrom(frameW, frameH, (x, y) => {
    const dx2 = 2 * (x - cx);
    const dy2 = 2 * (y - cy);
    const ax = Math.abs(dx2);
    const ay = Math.abs(dy2);
    switch (shape) {
      case 'square':
        return Math.max(ax, ay) <= R2;
      case 'diamond':
        return ax + ay <= R2;
      case 'circle':
        return dx2 * dx2 + dy2 * dy2 <= R2 * R2;
      case 'hexagon': {
        // 尖顶六边形（⬢）：中段满宽，上下两端线性收窄。
        const w2 = Math.round((R2 * 866) / 1000); // √3/2
        if (ay <= radius) return ax <= w2;
        if (ay >= R2) return false;
        return ax * radius <= w2 * (R2 - ay);
      }
      case 'octagon':
        // 正方形切四角（⬣）：对角约束 |dx|+|dy| ≤ 1.414R。
        return Math.max(ax, ay) <= R2 && ax + ay <= Math.round((R2 * 1414) / 1000);
      case 'notchedSquare': {
        if (Math.max(ax, ay) > R2) return false;
        // 缺口：从顶边向中心切一条竖槽（▣ 的"缺口"）。
        const slotW = Math.max(2, Math.round(radius / 2)) * 2;
        const slotDepth = radius;
        return !(ax < slotW && dy2 < -radius + slotDepth);
      }
      case 'cross': {
        // 十字（✚ tech）：横竖两条臂都要在半径内收口，
        // 否则 `ax <= bar` 这一条会把竖臂"画穿"整个帧（ASCII 预览抓到的 bug）。
        const bar = Math.max(2, Math.round((R2 * 5) / 12));
        return (ax <= bar && ay <= R2) || (ay <= bar && ax <= R2);
      }
      case 'dotCluster': {
        // 3×3 点簇（∴）：9 个方块，块间留空。
        const gap = Math.max(1, Math.round(radius / 3));
        const dot = Math.max(2, Math.floor((2 * radius + 1 - 2 * gap) / 3));
        const step = dot + gap;
        const total = 3 * dot + 2 * gap;
        const base = -Math.floor(total / 2);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const x0 = base + j * step;
            const y0 = base + i * step;
            if (dx2 >= 2 * x0 && dx2 < 2 * (x0 + dot) && dy2 >= 2 * y0 && dy2 < 2 * (y0 + dot)) {
              return true;
            }
          }
        }
        return false;
      }
      default:
        return false;
    }
  });
}

/**
 * 三角形（▲ archer）。单独实现：半宽随高度**线性**收窄，
 * 用一条整数不等式 `2·ax ≤ dy2 + R2` 表达，无需除法与三角函数。
 */
export function triangleMask(
  frameW: number,
  frameH: number,
  cx: number,
  cy: number,
  radius: number,
): Mask {
  const R2 = 2 * radius;
  return maskFrom(frameW, frameH, (x, y) => {
    const dx2 = 2 * (x - cx);
    const dy2 = 2 * (y - cy);
    const ax = Math.abs(dx2);
    if (dy2 > R2) return false;
    // 半宽在 |dy| = radius（底边）处取满 radius，在顶点处收为 0：
    //   |dx| = radius · (dy + radius) / (2·radius)  ⟺  2·ax ≤ dy2 + R2
    return ax * 2 <= dy2 + R2;
  });
}

// ---------------------------------------------------------------------------
// 距离场：边框画法的公共底座
// ---------------------------------------------------------------------------

/**
 * 掩码的**切比雪夫距离场**（两遍 chamfer，O(w·h)）。
 * `d[i] = 0` 表示该点在掩码内；否则为到掩码的切比雪夫距离。
 *
 * 这是"边框画法"的基础：护甲的虚线/实线/双层/刻痕全部由距离带导出，
 * 因此边框永远贴着本体轮廓，且**与颜色无关**。
 */
export function chebyshevDistance(mask: Mask): Int32Array {
  const { width: w, height: h, bits } = mask;
  const INF = 1 << 20;
  const d = new Int32Array(w * h);
  for (let i = 0; i < bits.length; i++) d[i] = bits[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 1);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1);
      }
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 1);
      }
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      d[i] = v;
    }
  }
  return d;
}

/**
 * 距离带：取"到 `mask` 的切比雪夫距离落在 `[lo, hi]`"的像素。
 * `lo = 1` 表示紧贴本体外的一圈。
 */
export function distanceBand(mask: Mask, lo: number, hi: number): Mask {
  const d = chebyshevDistance(mask);
  const out = new Mask(mask.width, mask.height);
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (v >= lo && v <= hi) out.bits[i] = 1;
  }
  return out;
}

/** 本体外 `thickness` px 的一圈（实心）。 */
export function outlineMask(mask: Mask, thickness: number): Mask {
  return distanceBand(mask, 1, thickness);
}

/** 膨胀：掩码自身 + 其外 `radius` px。 */
export function dilateMask(mask: Mask, radius: number): Mask {
  return distanceBand(mask, 0, radius);
}

/** 掩码的 1px 外边界（膨胀一圈减去自身），常用来描边/加亮边。 */
export function edgeOf(mask: Mask): Mask {
  const grown = dilateMask(mask, 1);
  return subtractMask(grown, mask);
}

/** 沿 `(x + y)` 做 2-2 交替的虚线段（`on`/`off` 可调）。 */
export function dashMask(mask: Mask, on = 2, off = 2): Mask {
  const period = on + off;
  const out = new Mask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.get(x, y)) continue;
      if ((x + y) % period < on) out.set(x, y);
    }
  }
  return out;
}

/** 四角刻痕（神圣甲的金色记号）。 */
export function cornerTicksMask(w: number, h: number, len: number, thickness: number): Mask {
  const m = new Mask(w, h);
  for (let t = 0; t < thickness; t++) {
    // 左上
    m.setRect(0, t, len, 1);
    m.setRect(t, 0, 1, len);
    // 右上
    m.setRect(w - len, t, len, 1);
    m.setRect(w - 1 - t, 0, 1, len);
    // 左下
    m.setRect(0, h - 1 - t, len, 1);
    m.setRect(t, h - len, 1, len);
    // 右下
    m.setRect(w - len, h - 1 - t, len, 1);
    m.setRect(w - 1 - t, h - len, 1, len);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 护甲边框（方案 §2.2：边框画法 = 护甲）
// ---------------------------------------------------------------------------

/**
 * 由本体掩码导出护甲边框掩码。
 *
 * | 护甲 | 画法 | 占用距离带 |
 * |---|---|---|
 * | light | 细虚线（1px，2-2 交替） | 2 |
 * | medium | 实线 1px | 2 |
 * | heavy | 实线 2px | 2–3 |
 * | fortified | 双层实线（2px 内圈 + 1px 间隔 + 1px 外圈） | 2–3, 5 |
 * | divine | 实线 2px（四角金刻痕由调用方另加金色） | 2–3 |
 *
 * ⚠️ 所有边框都从**距离 2** 起（而不是 1）：距离 1 留作 **1px 空隙（moat）**。
 * 这一像素的空隙很关键 ——
 * 1. 本体剪影（塔系/敌体）与"护甲边框"两个通道在视觉上分离，不会糊成一块；
 * 2. 虚线的 2-2 节奏不会被本体边缘的像素吃掉；
 * 3. 去色后，"有没有一圈独立的边框"仍然一眼可判。
 *
 * 边框**始终在体外侧**，不会盖住本体。
 */
/**
 * 护甲边框的**环带范围**（到本体掩码的切比雪夫距离）。
 *
 * `INNER = 2`：距离 1 留作 1px 空隙（moat，见 `borderMask`）。
 * `OUTER = 5`：最宽的 `double` 外圈落在距离 5。
 *
 * ★ 这两个常量是**验证护甲通道的唯一正确采样区域**。
 * 断言必须只作用在「距离 ∈ [2, 5] 的环带」上：拿整只精灵比像素差，
 * 会被本体形状差异（200–400px）淹没边框差异（几十 px）——
 * 那正是"绿着的测试却没测到护甲"的成因（见 `src/art/audit.ts` 与
 * `tests/art/channels.spec.ts` 的负对照）。
 */
export const ARMOR_RING_INNER = 2;
export const ARMOR_RING_OUTER = 5;

export function borderMask(body: Mask, style: BorderStyleLike): Mask {
  const inner = ARMOR_RING_INNER;
  const thick = inner + 1;
  switch (style) {
    case 'dashed':
      return dashMask(distanceBand(body, inner, inner), 2, 2);
    case 'solid1':
      return distanceBand(body, inner, inner);
    case 'solid2':
      return distanceBand(body, inner, thick);
    case 'double':
      return unionMask(distanceBand(body, inner, thick), distanceBand(body, ARMOR_RING_OUTER, ARMOR_RING_OUTER));
    case 'divine':
      return distanceBand(body, inner, thick);
    default:
      return distanceBand(body, inner, inner);
  }
}

/** 与 `palette.BorderStyle` 同构（此处避免反向依赖，仅作结构约束）。 */
export type BorderStyleLike = 'dashed' | 'solid1' | 'solid2' | 'double' | 'divine';

/** 某一护甲样式的最大外扩距离（用于排版预算与断言）。 */
export const BORDER_REACH: Readonly<Record<BorderStyleLike, number>> = {
  dashed: 2,
  solid1: 2,
  solid2: 3,
  double: 5,
  divine: 3,
};
