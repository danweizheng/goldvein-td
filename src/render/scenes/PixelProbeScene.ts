/**
 * PixelProbeScene —— 「NEAREST 渲染无糊边」的**自动化证据**场景
 *
 * 做法（不靠肉眼看截图）：
 *   1. 在纯色背景上放两个**纯色方块**精灵（图集里的 `probe` 帧：
 *      内部纯 #FF0044 + 1px 亮绿描边，没有任何渐变/半透明）；
 *   2. 相机缩放取**整数倍**（默认 8x）、并把相机中心对到方块中心，渲染若干帧后用
 *      `renderer.snapshot()` 把画面读回来逐像素统计；
 *   3. 判定标准（整数缩放）：
 *        - 每个像素都必须**接近** {背景, #FF0044, #00FF00} 之一（容差 ±2/通道，
 *          用来吸收 WebGL 颜色空间往返的 1–2 级误差）；
 *        - "混色像素"数必须为 **0**；
 *        - 中间行上绿色描边的连续段长度必须**恰好等于**缩放倍数。
 *   4. **反向对照**：把缩放换成非整数（7.37x）再测一次，
 *      此时混色像素必然 > 0 —— 证明这个检查不是"永远通过"的空测试。
 *
 * 结果写到 `window.__PIXEL_PROBE__` 并 `console.log('PIXEL_PROBE_RESULT ' + json)`，
 * 供 tools/bench 的浏览器基准通过 CDP 抓取。
 *
 * 注意：本场景**刻意不放任何文字**（BitmapText 是白色字形，会污染
 * "只允许三种颜色"的判定）。BitmapText 通路由 GameScene / BenchScene 的 HUD
 * 覆盖，另有一条静态检查用例禁止使用 Phaser.Text（见
 * src/render/__tests__/no-phaser-text.spec.ts）。
 */
import Phaser from 'phaser';
import { ATLAS_KEY, FRAMES } from '../atlas';

export interface PixelProbeResult {
  label: string;
  renderer: 'WEBGL' | 'CANVAS';
  zoom: number;
  integerZoom: boolean;
  filter: 'NEAREST' | 'LINEAR';
  canvas: { w: number; h: number };
  allowedColors: string[];
  exactDistinctColors: string[];
  mixedPixels: number;
  totalPixels: number;
  spriteBBox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 精灵中间行上描边（绿）的连续段长度：整数缩放 + NEAREST 时必须恰好等于 zoom */
  edgeRunLengths: number[];
  /** 中间行上"主体色(红)"的连续段长度 */
  bodyRunLengths: number[];
  allRunsMatchZoom: boolean;
  verdict: 'crisp' | 'shimmer' | 'blurry';
}

interface ProbePass {
  label: string;
  zoom: number;
  /** 故意把纹理过滤切成 LINEAR，用来证明"混色检测"不是空测试 */
  linearControl?: boolean;
}

const BACKGROUND = '#101820';
const BODY = '#ff0044';
const EDGE = '#00ff00';
/** 每通道容差：吸收 WebGL 颜色往返的 1–2 级误差，不影响"检测混色"的能力。 */
const TOLERANCE = 2;

function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function parseHex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

const ALLOWED_RGB: [number, number, number][] = [BACKGROUND, BODY, EDGE].map(parseHex);

function nearAllowed(r: number, g: number, b: number): boolean {
  for (const [ar, ag, ab] of ALLOWED_RGB) {
    if (Math.abs(r - ar) <= TOLERANCE && Math.abs(g - ag) <= TOLERANCE && Math.abs(b - ab) <= TOLERANCE) {
      return true;
    }
  }
  return false;
}

function isEdgeLike(r: number, g: number, b: number): boolean {
  const [er, eg, eb] = ALLOWED_RGB[2] as [number, number, number];
  return Math.abs(r - er) <= TOLERANCE && Math.abs(g - eg) <= TOLERANCE && Math.abs(b - eb) <= TOLERANCE;
}

function isBackgroundLike(r: number, g: number, b: number): boolean {
  const [br, bg, bb] = ALLOWED_RGB[0] as [number, number, number];
  return Math.abs(r - br) <= TOLERANCE && Math.abs(g - bg) <= TOLERANCE && Math.abs(b - bb) <= TOLERANCE;
}

/** 从 ImageData 统计颜色、混色像素、描边/主体段长。纯函数，便于单测。 */
export function analyzePixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  label: string,
  zoom: number,
  renderer: 'WEBGL' | 'CANVAS',
  filter: 'NEAREST' | 'LINEAR' = 'NEAREST',
): PixelProbeResult {
  const exact = new Set<string>();
  let mixed = 0;

  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4] as number;
    const g = data[i * 4 + 1] as number;
    const b = data[i * 4 + 2] as number;
    exact.add(hex(r, g, b));
    if (!nearAllowed(r, g, b)) mixed++;
  }

  // 精灵包围盒（非背景像素）
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i] as number;
      const g = data[i + 1] as number;
      const b = data[i + 2] as number;
      if (!isBackgroundLike(r, g, b)) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }

  // 只在**一个精灵**的中间行上量段长（场景里只放一个精灵）
  const edgeRuns: number[] = [];
  const bodyRuns: number[] = [];
  if (x1 >= 0) {
    const midY = Math.floor((y0 + y1) / 2);
    let run = 0;
    let kind: 'edge' | 'body' | 'bg' = 'bg';
    for (let x = x0; x <= x1; x++) {
      const i = (midY * w + x) * 4;
      const r = data[i] as number;
      const g = data[i + 1] as number;
      const b = data[i + 2] as number;
      const isEdge = isEdgeLike(r, g, b);
      const isBody = !isEdge && !isBackgroundLike(r, g, b);
      const nextKind: 'edge' | 'body' | 'bg' = isEdge ? 'edge' : isBody ? 'body' : 'bg';
      if (nextKind === kind) {
        run++;
      } else {
        if (kind === 'edge' && run > 0) edgeRuns.push(run);
        if (kind === 'body' && run > 0) bodyRuns.push(run);
        kind = nextKind;
        run = 1;
      }
    }
    if (kind === 'edge' && run > 0) edgeRuns.push(run);
    if (kind === 'body' && run > 0) bodyRuns.push(run);
  }

  const integerZoom = Number.isInteger(zoom);
  // 整数缩放 + NEAREST：左右描边段长都必须恰好等于 zoom
  const allRunsMatchZoom = edgeRuns.length === 2 && edgeRuns.every((r) => r === Math.round(zoom));
  const verdict: PixelProbeResult['verdict'] =
    mixed > 0 ? 'blurry' : integerZoom && allRunsMatchZoom ? 'crisp' : 'shimmer';
  return {
    label,
    renderer,
    zoom,
    integerZoom,
    filter,
    canvas: { w, h },
    allowedColors: [BACKGROUND, BODY, EDGE],
    exactDistinctColors: [...exact].sort(),
    mixedPixels: mixed,
    totalPixels: w * h,
    spriteBBox: x1 >= 0 ? { x0, y0, x1, y1 } : null,
    edgeRunLengths: edgeRuns,
    bodyRunLengths: bodyRuns,
    allRunsMatchZoom,
    verdict,
  };
}

export class PixelProbeScene extends Phaser.Scene {
  private readonly passes: ProbePass[] = [
    // 出货配置：整数倍缩放 + NEAREST
    { label: 'integer-8x / NEAREST【出货配置】', zoom: 8 },
    // 非整数缩放 + NEAREST：不会混色，但像素大小会不均匀（shimmer）
    { label: 'fractional-7.37x / NEAREST', zoom: 7.37 },
    // 对照组：整数缩放但故意用 LINEAR —— 必须出现混色，证明检测有效
    { label: 'integer-8x / LINEAR【对照组】', zoom: 8, linearControl: true },
  ];
  private results: PixelProbeResult[] = [];
  private passIndex = 0;
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private framesToWait = 0;
  private readonly defaultFilter = Phaser.Textures.FilterMode.NEAREST;

  constructor() {
    super({ key: 'PixelProbe' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor(BACKGROUND);
    this.startPass();
  }

  private startPass(): void {
    const pass = this.passes[this.passIndex];
    if (!pass) {
      this.finish();
      return;
    }
    // 只在场景里放**一个** 16×16 方块：多放一个会让"中间行"穿到另一个方块的
    // 描边上，量出来的段长就没有意义了（这是第一版检查失效的原因）。
    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }

    const cam = this.cameras.main;
    cam.setZoom(pass.zoom);
    this.sprite = this.add.sprite(0, 0, ATLAS_KEY, FRAMES.probe).setOrigin(0, 0);

    // 纹理过滤：出货是 NEAREST；对照组故意切 LINEAR
    const tex = this.textures.get(ATLAS_KEY);
    tex.setFilter(pass.linearControl ? Phaser.Textures.FilterMode.LINEAR : this.defaultFilter);

    // ★ 关键：必须把相机中心对到方块上。Phaser 的 zoom 是绕相机中点缩放的，
    //   只 setZoom 不 centerOn 会把世界 (0,0) 推到屏幕外 —— 那样读回来的画面
    //   只有背景色，检查会"通过"但什么都没测到。
    cam.centerOn(8, 8);
    cam.setScroll(Math.round(cam.scrollX), Math.round(cam.scrollY));
    cam.roundPixels = true;

    this.framesToWait = 3;
  }

  override update(): void {
    if (this.framesToWait > 0) {
      this.framesToWait--;
      return;
    }
    if (this.results.length > this.passIndex) return;

    const pass = this.passes[this.passIndex] as ProbePass;
    const rendererType = this.game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS';
    this.game.renderer.snapshot((image) => {
      const img = image as HTMLImageElement;
      const w = img.width;
      const h = img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      // 关掉插值：读数过程本身不能引入混色
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      this.results.push(
        analyzePixels(
          data,
          w,
          h,
          pass.label,
          pass.zoom,
          rendererType,
          pass.linearControl ? 'LINEAR' : 'NEAREST',
        ),
      );
      this.passIndex++;
      if (this.passIndex < this.passes.length) this.startPass();
      else this.finish();
    });
  }

  private finish(): void {
    // 收尾：把过滤恢复成 NEAREST，避免影响后续页面（同一次会话里可能再进游戏）
    this.textures.get(ATLAS_KEY).setFilter(this.defaultFilter);
    const payload = {
      scene: 'PixelProbe',
      renderer: this.game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS',
      pixelArt: this.game.config.pixelArt === true,
      antialias: this.game.config.antialias === true,
      roundPixels: this.game.config.roundPixels === true,
      results: this.results,
    };
    (window as unknown as Record<string, unknown>).__PIXEL_PROBE__ = payload;
    console.log('PIXEL_PROBE_RESULT ' + JSON.stringify(payload));
  }
}
