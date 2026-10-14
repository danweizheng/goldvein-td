/**
 * 对象池 —— 策划案 §8.5
 *
 * | 对象 | 池大小 |
 * |---|---|
 * | 投射物 | 500（超出复用最旧的） |
 * | 伤害/金币飘字 | 300（BitmapText，**不要用 Text**） |
 * | 敌人精灵 | 250（按类型分帧，共用同一图集） |
 *
 * 池在场景创建时一次性 allocate 完，运行期只做 `visible` / `frame` /
 * `position` 改写，**不再 new 任何 GameObject**（避免 60fps 下的 GC 抖动）。
 */
import Phaser from 'phaser';
import { FONT_KEY } from './pixel-font';

/** 通用精灵池。 */
export class SpritePool {
  private readonly free: Phaser.GameObjects.Sprite[] = [];
  private readonly all: Phaser.GameObjects.Sprite[] = [];
  private inUseCount = 0;
  private peakCount = 0;
  private recycleCount = 0;

  constructor(
    scene: Phaser.Scene,
    private readonly textureKey: string,
    readonly capacity: number,
    depth: number,
  ) {
    for (let i = 0; i < capacity; i++) {
      const s = scene.add.sprite(0, 0, textureKey);
      s.setVisible(false);
      s.setActive(false);
      s.setDepth(depth);
      this.free.push(s);
      this.all.push(s);
    }
  }

  /** 取一个精灵。池满时**复用最旧的在用精灵**（策划案 §8.5）。 */
  acquire(frame: string): Phaser.GameObjects.Sprite {
    let s = this.free.pop();
    if (s === undefined) {
      // 池满：从"在用"里挑第一个（按创建顺序即最旧）回收
      for (const cand of this.all) {
        if (cand.active) {
          s = cand;
          this.recycleCount++;
          break;
        }
      }
      s ??= this.all[0] as Phaser.GameObjects.Sprite;
    } else {
      this.inUseCount++;
    }
    s.setActive(true);
    s.setVisible(true);
    if (frame !== '') s.setFrame(frame);
    if (this.inUseCount > this.peakCount) this.peakCount = this.inUseCount;
    return s;
  }

  release(s: Phaser.GameObjects.Sprite): void {
    if (!s.active) return;
    s.setActive(false);
    s.setVisible(false);
    this.free.push(s);
    this.inUseCount = Math.max(0, this.inUseCount - 1);
  }

  releaseAll(): void {
    for (const s of this.all) {
      if (s.active) this.release(s);
    }
  }

  get active(): number {
    return this.inUseCount;
  }
  get peak(): number {
    return this.peakCount;
  }
  get recycled(): number {
    return this.recycleCount;
  }
  get size(): number {
    return this.capacity;
  }
}

interface FloatItem {
  text: Phaser.GameObjects.BitmapText;
  life: number;
  maxLife: number;
}

/**
 * 飘字池。**必须用 BitmapText**（策划案 §8.5 第 4 条）：
 * `Phaser.Text` 每帧重绘 canvas，是最大性能杀手。
 */
export class FloatTextPool {
  private readonly free: Phaser.GameObjects.BitmapText[] = [];
  private readonly items: FloatItem[] = [];
  private readonly all: Phaser.GameObjects.BitmapText[] = [];
  private peakCount = 0;

  constructor(
    scene: Phaser.Scene,
    readonly capacity: number,
    depth: number,
    private readonly riseSpeed = 0.028,
    private readonly defaultLifeMs = 900,
  ) {
    for (let i = 0; i < capacity; i++) {
      const t = scene.add.bitmapText(0, 0, FONT_KEY, '', 8);
      t.setVisible(false);
      t.setActive(false);
      t.setDepth(depth);
      this.free.push(t);
      this.all.push(t);
    }
  }

  spawn(x: number, y: number, content: string, color: number, lifeMs = this.defaultLifeMs): void {
    let t = this.free.pop();
    if (t === undefined) {
      // 池满：复用最早创建的那条（寿命最可能已到）
      const oldest = this.items.shift();
      t = oldest ? oldest.text : (this.all[0] as Phaser.GameObjects.BitmapText);
    }
    t.setText(content.toUpperCase());
    t.setTint(color);
    t.setPosition(x, y);
    t.setAlpha(1);
    t.setActive(true);
    t.setVisible(true);
    this.items.push({ text: t, life: lifeMs, maxLife: lifeMs });
    if (this.items.length > this.peakCount) this.peakCount = this.items.length;
  }

  /** 每帧推进（手动，避免为每条飘字建 Tween 对象）。 */
  update(deltaMs: number): void {
    const rise = this.riseSpeed * deltaMs;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i] as FloatItem;
      it.life -= deltaMs;
      it.text.y -= rise;
      const k = it.life / it.maxLife;
      it.text.setAlpha(k < 0 ? 0 : k > 1 ? 1 : k);
      if (it.life <= 0) {
        it.text.setVisible(false);
        it.text.setActive(false);
        this.free.push(it.text);
        this.items.splice(i, 1);
      }
    }
  }

  get active(): number {
    return this.items.length;
  }
  get peak(): number {
    return this.peakCount;
  }
  get size(): number {
    return this.capacity;
  }
}
