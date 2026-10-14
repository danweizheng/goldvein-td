/**
 * 通道审计：把"某个编码通道到底贡献了多少像素"变成**可复算的数字**。
 *
 * ## 为什么需要这个模块（一次真实的失败）
 * 第一版验收测试断言「不同护甲可区分」时，算的是**整只精灵**的像素差。
 * 那个数字很好看（219–375px），但它**全部来自本体形状**（id 哈希抖动、眼、
 * 腹纹），护甲边框的真实贡献被淹没了 —— 测试全绿，却什么都没证明。
 * （AGENTS.md 铁律 8：门禁必须能证明它**没测到**什么。）
 *
 * ## 正确做法
 * 把被测通道**隔离**出来测：
 * 1. 护甲边框住在「到本体掩码的切比雪夫距离 ∈ [2, 5]」的环带里
 *    （`shapes.ARMOR_RING_INNER/OUTER`）→ 只在这个环带里数差异；
 * 2. 同一本体（同一 id / 同一 flags）下比不同护甲，排除本体差异；
 * 3. 配一条**负对照**：构造一对"边框相同、本体不同"的精灵，
 *    断言环带差异 == 0（证明检测器没在测本体），
 *    再配一条**正对照**：同一本体换护甲 → 环带差异 > 0。
 *
 * ⚠️ 零 Phaser 依赖，Node 可裸跑。
 */
import { resolveArmor, toCvd, toGrayscale, type ArmorType, type Rgba } from './palette';
import { enemyBodyPlan, renderEnemyFrame, type SpriteFrame } from './procedural';
import { ARMOR_RING_INNER, ARMOR_RING_OUTER, chebyshevDistance, Mask, shapeMask } from './shapes';
import { FLYING_GAP, flyingGapFor } from './marks';
import type { EnemyArtInput } from './content';

/** 可见差异阈值（0–255）：16 ≈ 6% 动态范围。 */
export const VISIBLE = 16;

/** 通道比较模式。 */
export type CompareMode = 'rgba' | 'gray' | 'cvd' | 'alpha';

function transform(pixels: Uint8ClampedArray, mode: CompareMode): Uint8ClampedArray {
  switch (mode) {
    case 'gray':
      return toGrayscale(pixels);
    case 'cvd':
      return toGrayscale(toCvd(pixels, 'deuteranopia'));
    default:
      return pixels;
  }
}

/**
 * 在**给定区域**内比较两帧，返回"可见不同的像素数"。
 *
 * - `alpha` 模式：只看"不透明/透明"是否不同（纯剪影，与颜色无关）
 * - `gray` / `cvd` 模式：先做去色 / 色盲变换，再看亮度差是否 > 阈值
 * - `rgba` 模式：看任一通道差是否 > 阈值
 */
export function diffInRegion(
  a: SpriteFrame,
  b: SpriteFrame,
  region: Mask,
  mode: CompareMode = 'gray',
  threshold = VISIBLE,
): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`diffInRegion 需要同尺寸两帧（${a.width} vs ${b.width}）`);
  }
  if (region.width !== a.width || region.height !== a.height) {
    throw new Error('diffInRegion 的区域尺寸必须与帧一致');
  }
  const pa = mode === 'alpha' ? a.pixels : transform(a.pixels, mode);
  const pb = mode === 'alpha' ? b.pixels : transform(b.pixels, mode);
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!region.get(x, y)) continue;
      const i = (y * a.width + x) * 4;
      const oa = a.pixels[i + 3]! > 0;
      const ob = b.pixels[i + 3]! > 0;
      if (mode === 'alpha') {
        if (oa !== ob) n++;
        continue;
      }
      if (oa !== ob) {
        n++;
        continue;
      }
      if (!oa) continue;
      let maxDelta = 0;
      const channels = mode === 'rgba' ? 3 : 1;
      for (let c = 0; c < channels; c++) maxDelta = Math.max(maxDelta, Math.abs(pa[i + c]! - pb[i + c]!));
      if (maxDelta > threshold) n++;
    }
  }
  return n;
}

/** 整帧差异（**只用于对照**：这个数字会被本体形状主导，不能用来证明通道有效）。 */
export function diffWholeFrame(a: SpriteFrame, b: SpriteFrame, mode: CompareMode = 'gray'): number {
  const region = new Mask(a.width, a.height);
  for (let i = 0; i < region.bits.length; i++) region.bits[i] = 1;
  return diffInRegion(a, b, region, mode);
}

/** 取两帧环带的并集（不同 id 的本体不同 → 环带位置也不同，必须取并集才公平）。 */
export function unionRing(a: EnemyArtInput, b: EnemyArtInput): Mask {
  const ra = armorRegion(a);
  const rb = armorRegion(b);
  const out = new Mask(ra.width, ra.height);
  for (let i = 0; i < out.bits.length; i++) out.bits[i] = ra.bits[i] || rb.bits[i] ? 1 : 0;
  return out;
}

/** 四角刻痕区（神圣甲的金色刻痕落在帧角上，**不在环带里**）。 */
export function cornerZone(size: number, box = 8): Mask {
  const m = new Mask(size, size);
  m.setRect(0, 0, box, box);
  m.setRect(size - box, 0, box, box);
  m.setRect(0, size - box, box, box);
  m.setRect(size - box, size - box, box, box);
  return m;
}

/**
 * ★ 护甲通道的**完整**采样区域 = 环带 `[2, 5]` ∪ 四角刻痕区。
 *
 * 只取环带会漏掉神圣甲的四角金刻痕（它们钉在帧角上，距离本体 9px 以上）——
 * 那样 `heavy vs divine` 会被量成"剪影完全相同"（实测 ringAlpha = 0），
 * 掩盖掉 divine 真正多出来的那个通道。这是审计自身的覆盖漏洞，必须并进来。
 */
export function armorRegion(enemy: EnemyArtInput): Mask {
  const plan = enemyBodyPlan(enemy);
  const corners = cornerZone(plan.size);
  const out = new Mask(plan.size, plan.size);
  for (let i = 0; i < out.bits.length; i++) {
    out.bits[i] = plan.ringBand.bits[i] || corners.bits[i] ? 1 : 0;
  }
  return out;
}

/** 单只精灵的护甲环带区域（不含四角，用于厚度剖面）。 */
export function ringOf(enemy: EnemyArtInput): Mask {
  return enemyBodyPlan(enemy).ringBand;
}

/** 环带上"被边框占据"的像素数（护甲画法的厚度指纹）。 */
export function ringInkCount(enemy: EnemyArtInput): number {
  const plan = enemyBodyPlan(enemy);
  const frame = renderEnemyFrame(enemy, 'idle');
  let n = 0;
  for (let y = 0; y < plan.size; y++) {
    for (let x = 0; x < plan.size; x++) {
      if (!plan.ringBand.get(x, y)) continue;
      if (frame.pixels[(y * plan.size + x) * 4 + 3]! > 0) {
        // 本体层的"护甲色"像素才算边框（排掉固定的四角刻痕等）
        const i = (y * plan.size + x) * 4;
        const color: Rgba = [frame.pixels[i]!, frame.pixels[i + 1]!, frame.pixels[i + 2]!, frame.pixels[i + 3]!];
        if (colorDistance(color, resolveArmor(enemy.armorType).color) < 60) n++;
      }
    }
  }
  return n;
}

/**
 * 护甲画法的**结构指纹** = 径向剖面 + 四角刻痕区的实体像素数。
 *
 * 必须把四角并进来：`divine` 的环带剖面与 `heavy` **逐位相同**
 * （都是 2px 实线环），它多出来的只有四角金刻痕。只用环带剖面会得出
 * "heavy 与 divine 结构相同"的错误结论 —— 这是审计自身的覆盖漏洞。
 */
export function armorFingerprint(enemy: EnemyArtInput): string {
  const profile = radialProfile(enemy);
  const corners = cornerZone(enemyBodyPlan(enemy).size);
  const frame = renderEnemyFrame(enemy, 'idle');
  const cornerInk = inkIn(frame, corners);
  const parts = Object.keys(profile)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => `${d}:${profile[d]}`);
  return `ring{${parts.join(',')}} corners:${cornerInk}`;
}

/**
 * 环带的**径向剖面**：对每个到本体的距离 d，数出该距离上有多少像素被填。
 *
 * 这是护甲画法的"指纹"：
 * `light` → {2: 若干（约一半，因为虚线）}
 * `medium` → {2: 全部}
 * `heavy` → {2: 全部, 3: 全部}
 * `fortified` → {2, 3, 5}
 * `divine` → {2, 3}
 */
export function radialProfile(enemy: EnemyArtInput): Record<number, number> {
  const plan = enemyBodyPlan(enemy);
  const frame = renderEnemyFrame(enemy, 'idle');
  const dist = chebyshevDistance(plan.body);
  const armorColor = resolveArmor(enemy.armorType).color;
  const profile: Record<number, number> = {};
  const totals: Record<number, number> = {};
  for (let i = 0; i < dist.length; i++) {
    const d = dist[i]!;
    if (d < ARMOR_RING_INNER || d > ARMOR_RING_OUTER + 2) continue;
    totals[d] = (totals[d] ?? 0) + 1;
    const i4 = i * 4;
    if (frame.pixels[i4 + 3]! === 0) continue;
    const color: Rgba = [frame.pixels[i4]!, frame.pixels[i4 + 1]!, frame.pixels[i4 + 2]!, frame.pixels[i4 + 3]!];
    if (colorDistance(color, armorColor) < 60) profile[d] = (profile[d] ?? 0) + 1;
  }
  // 只有"该距离上存在环带像素"的 d 才进入结果
  const out: Record<number, number> = {};
  for (const key of Object.keys(totals)) {
    const d = Number(key);
    if ((totals[d] ?? 0) === 0) continue;
    out[d] = profile[d] ?? 0;
  }
  return out;
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** 一对护甲在同一本体下的隔离测量结果。 */
export interface ArmorPairResult {
  readonly a: ArmorType;
  readonly b: ArmorType;
  /** 环带内灰度可见差异（**这是唯一有意义的护甲断言**）。 */
  readonly ringGray: number;
  /** 环带内色盲可见差异。 */
  readonly ringCvd: number;
  /** 环带内剪影差异（虚线/双层是形状差异，实线 1px vs 2px 则不是）。 */
  readonly ringAlpha: number;
  /** 整帧灰度差异（对照用；会被本体主导，**不能**用作护甲断言）。 */
  readonly wholeGray: number;
}

/**
 * 5 种护甲在同一本体上的**逐对隔离矩阵**。
 *
 * `probeId` 固定 → 5 个样本的本体完全相同 → 环带同一位置、同一形状，
 * 因此环带内的一切差异**只可能来自护甲画法**。
 */
export function armorMatrix(probeId = 'armor_probe', armorOrder: readonly ArmorType[]): ArmorPairResult[] {
  const frames = new Map<ArmorType, SpriteFrame>();
  const enemies = new Map<ArmorType, EnemyArtInput>();
  for (const armor of armorOrder) {
    const enemy: EnemyArtInput = { id: probeId, armorType: armor, flying: false, isBoss: false, stealResist: 0 };
    enemies.set(armor, enemy);
    frames.set(armor, renderEnemyFrame(enemy, 'idle'));
  }
  const band = armorRegion(enemies.get(armorOrder[0]!)!);
  const out: ArmorPairResult[] = [];
  for (let i = 0; i < armorOrder.length; i++) {
    for (let j = i + 1; j < armorOrder.length; j++) {
      const a = armorOrder[i]!;
      const b = armorOrder[j]!;
      out.push({
        a,
        b,
        ringGray: diffInRegion(frames.get(a)!, frames.get(b)!, band, 'gray'),
        ringCvd: diffInRegion(frames.get(a)!, frames.get(b)!, band, 'cvd'),
        ringAlpha: diffInRegion(frames.get(a)!, frames.get(b)!, band, 'alpha'),
        wholeGray: diffWholeFrame(frames.get(a)!, frames.get(b)!, 'gray'),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 飞行通道：底部区域 + 翼痕区域（同样必须**分区域**测）
// ---------------------------------------------------------------------------

/** 飞行通道的分区域测量结果。 */
export interface FlyingResult {
  readonly size: number;
  /** 地面态机身下缘 y。 */
  readonly groundBodyBottom: number;
  /** 飞行态机身下缘 y（= 地面态 − FLYING_GAP）。 */
  readonly airBodyBottom: number;
  /** 「阴影留白」带 = 飞行态机身下方那 2 行。 */
  readonly gapRowGroundInk: number;
  readonly gapRowAirInk: number;
  readonly gapRowDiff: number;
  /** 翼痕所在行（= 飞行态机身中线）。 */
  readonly wingRow: number;
  /** 该行左右两端的实体像素跨度（px）—— 翼痕把剪影顶宽的直接证据。 */
  readonly wingRowSpanGround: number;
  readonly wingRowSpanAir: number;
  /** 「翼痕带」= 地面态本体水平包围盒之外、机身中线 ±2 行。 */
  readonly wingZoneGroundInk: number;
  readonly wingZoneAirInk: number;
  readonly wingZoneDiff: number;
  /** 整帧剪影差异（对照用）。 */
  readonly wholeDiff: number;
  /** 质心抬高（px）。 */
  readonly centroidLift: number;
}

/** 飞行通道的两个采样区（导出给真实数据用：探针之外也要能测）。 */
export interface FlyingZones {
  readonly ground: EnemyArtInput;
  readonly air: EnemyArtInput;
  /** 飞行态机身下方那 2 行（阴影留白）。 */
  readonly gap: Mask;
  /**
   * 翼痕带 = 地面态本体水平包围盒之外、机身中线 ±2 行。
   *
   * ⚠️ 别用"整帧左右跨度"来测 96 帧的 BOSS：神圣甲的四角金刻痕已经把跨度
   * 顶满到整帧宽，翼痕再宽也量不出来（实测 ascendant 地面/飞行都是 96px）。
   */
  readonly wing: Mask;
  readonly wingRow: number;
}

/** 构造飞行通道的采样区（探针与真实敌人都用它，保证口径一致）。 */
export function flyingZones(enemy: EnemyArtInput): FlyingZones {
  const ground: EnemyArtInput = { ...enemy, flying: false };
  const air: EnemyArtInput = { ...enemy, flying: true };
  const pg = enemyBodyPlan(ground);
  const pa = enemyBodyPlan(air);
  const size = pg.size;

  const airBottom = pa.cy + pa.radius;
  const gap = new Mask(size, size);
  for (let y = airBottom + 1; y <= airBottom + flyingGapFor(size); y++) gap.setRect(0, y, size, 1);

  let minX = size;
  let maxX = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pg.body.get(x, y)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
  }

  const wingRow = pa.cy;
  const wing = new Mask(size, size);
  for (let y = wingRow - 2; y <= wingRow + 2; y++) {
    if (y < 0 || y >= size) continue;
    wing.setRect(0, y, Math.max(0, minX), 1);
    wing.setRect(maxX + 1, y, Math.max(0, size - maxX - 1), 1);
  }
  return { ground, air, gap, wing, wingRow };
}

/** 在给定区域里数实体像素。 */
export function inkIn(frame: SpriteFrame, region: Mask): number {
  let n = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (region.get(x, y) && frame.pixels[(y * frame.width + x) * 4 + 3]! > 0) n++;
    }
  }
  return n;
}

/** 在给定行上，实体像素的水平跨度（px）。 */
export function rowSpan(frame: SpriteFrame, y: number): number {
  let lo = frame.width;
  let hi = -1;
  for (let x = 0; x < frame.width; x++) {
    if (frame.pixels[(y * frame.width + x) * 4 + 3]! > 0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return hi < 0 ? 0 : hi - lo + 1;
}

/** 帧的实体像素质心 y。 */
export function centroidY(frame: SpriteFrame): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (frame.pixels[(y * frame.width + x) * 4 + 3]! > 0) {
        sum += y;
        n++;
      }
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * 测量飞行标记（**分区域**，因为"整体差异"什么都证明不了）。
 *
 * 三个区域刻意这样选：
 * 1. **阴影留白带** = 飞行态机身下方那 2 行。地面态在那里有机身像素、飞行态必须是空的
 *    —— 这就是方案 §2.2 的「下方 2px 阴影留白」。
 * 2. **翼痕带** = 地面态本体水平包围盒之外、机身中线 ±2 行。
 *    翼痕把护甲环向外顶出去了 3px/侧，所以这里飞行态会多出实体像素。
 * 3. **翼痕行的跨度** = 同一行上两种状态的实体像素总宽度，直接看出"飞行的更宽"。
 *
 * ⚠️ 两个**实测踩过的坑**（都是"区域选错"，不是通道失效）：
 * - 「帧最低 6 行」：两种状态的机身都不在那里（实测只差 5px）。
 * - 「到本体距离 > 5 的环外区」：由于**对角线方向**的切比雪夫距离更短，
 *   翼痕外缘恰好落在距离 5（实测 (3,14) 到本体距离 = 5，(3,14)→(8,16) 走对角），
 *   于是该区也量到 0。区域必须按**翼痕实际所在的列/行**定义，不能按"离本体多远"。
 */
export function flyingReport(probeId = 'flying_probe'): FlyingResult {
  const zones = flyingZones({
    id: probeId,
    armorType: 'medium',
    flying: true,
    isBoss: false,
    stealResist: 0,
  });
  const fg = renderEnemyFrame(zones.ground, 'idle');
  const fa = renderEnemyFrame(zones.air, 'idle');
  const pg = enemyBodyPlan(zones.ground);
  const pa = enemyBodyPlan(zones.air);

  return {
    size: pg.size,
    groundBodyBottom: pg.cy + pg.radius,
    airBodyBottom: pa.cy + pa.radius,
    gapRowGroundInk: inkIn(fg, zones.gap),
    gapRowAirInk: inkIn(fa, zones.gap),
    gapRowDiff: diffInRegion(fg, fa, zones.gap, 'alpha'),
    wingRow: zones.wingRow,
    wingRowSpanGround: rowSpan(fg, zones.wingRow),
    wingRowSpanAir: rowSpan(fa, zones.wingRow),
    wingZoneGroundInk: inkIn(fg, zones.wing),
    wingZoneAirInk: inkIn(fa, zones.wing),
    wingZoneDiff: diffInRegion(fg, fa, zones.wing, 'alpha'),
    wholeDiff: diffWholeFrame(fg, fa, 'alpha'),
    centroidLift: centroidY(fg) - centroidY(fa),
  };
}

/**
 * 负对照：找一对 **本体轮廓完全相同、只有内部装饰不同** 的精灵。
 *
 * 用**灰度签名**（而不是 alpha 签名）来判定"内部不同"：
 * 眼与腹纹画在已经不透明的本体内部，**不会改变 alpha**，
 * 所以用 alpha 找差异会一个都找不到 —— 这正是第一次跑出来的结果
 * （审计工具自身的 bug，已修）。
 */
export function findSameSilhouettePair(armor: ArmorType, maxProbe = 64): { a: string; b: string } | null {
  const seen = new Map<string, { id: string; gray: string }>();
  for (let i = 0; i < maxProbe; i++) {
    const id = `ctrl_${i}`;
    const enemy: EnemyArtInput = { id, armorType: armor, flying: false, isBoss: false, stealResist: 0 };
    const plan = enemyBodyPlan(enemy);
    const frame = renderEnemyFrame(enemy, 'idle');
    const gray = toGrayscale(frame.pixels);
    let signature = '';
    for (let k = 0; k < gray.length; k += 4) signature += gray[k]!.toString(16).padStart(2, '0');
    const key = Array.from(plan.body.bits).join('');
    const prev = seen.get(key);
    if (prev && prev.gray !== signature) return { a: prev.id, b: id };
    seen.set(key, { id, gray: signature });
  }
  return null;
}

/** 仅用于自检：把掩码渲染成 ASCII（诊断用）。 */
export function maskToAscii(mask: Mask, frame?: SpriteFrame): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let line = '';
    for (let x = 0; x < mask.width; x++) {
      if (!mask.get(x, y)) {
        line += ' ';
        continue;
      }
      if (!frame) {
        line += '#';
        continue;
      }
      const i = (y * mask.width + x) * 4;
      line += frame.pixels[i + 3]! > 0 ? '#' : '.';
    }
    rows.push(line);
  }
  return rows;
}

/** 便于测试构造：一个固定半径的本体（与 id 抖动无关）。 */
export function fixedBody(size: number, radius: number, flying = false, cx = size / 2, cy = size / 2): Mask {
  return shapeMask('circle', size, size, cx, flying ? cy - 2 : cy, radius);
}
