/**
 * 浏览器端性能基准场景（渲染路径）
 *
 * 场景：**250 敌人 + 500 投射物 + 300 飘字**（策划案 §1.5 与 §8.5 的池容量）
 *
 * 测量方式：
 *   - 用 `performance.now()` 记录每一帧的真实间隔（不用 Phaser 平滑过的 delta）；
 *   - 分两个阶段：`sim+render`（模拟在跑）与 `render-only`（模拟暂停，
 *     精灵仍每帧同步/绘制）——把模拟 CPU 与渲染开销分开；
 *   - 输出 avg FPS / 最小 500ms 窗口 FPS / p95 p99 最大帧时长 / 掉帧率
 *     （帧时长 > 16.67ms 的占比）/ 模拟耗时；
 *   - 结果打到 console（`BENCH_RESULT {json}`）供 CDP 抓取。
 *
 * 浏览器带 `--disable-frame-rate-limit` 启动可让帧率不被 vsync 锁在 60，
 * 从而看出**还剩多少余量**（只到 60 就分不清"刚好够"和"绰绰有余"）。
 */
import Phaser from 'phaser';
import { ATLAS_KEY, TILE, ensureAtlas, enemyFrame, unitFrame } from '../../src/render/atlas';
import { ensurePixelFont, FONT_KEY } from '../../src/render/pixel-font';
import { FloatTextPool, SpritePool } from '../../src/render/pools';
import { SimDriver } from '../../src/render/SimDriver';
import { createStressContent, stressPlan } from './fixture';
import { toDisplayInt } from '../../src/sim/fixed';
import type { SimEvent } from '../../src/sim/events';
import type { WorldSnapshot } from '../../src/sim/types';
import type { Command } from '../../src/sim/commands';

interface PhaseResult {
  name: string;
  seconds: number;
  frames: number;
  avgFps: number;
  minWindowFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  jankRate: number;
  simAvgMs: number;
  simP95Ms: number;
  simMaxMs: number;
  peakEnemies: number;
  peakProjectiles: number;
  peakTexts: number;
  textsSpawned: number;
}

const WARMUP_MS = 12_000;
const PHASE_MS = 8000;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
}

export class BenchScene extends Phaser.Scene {
  private driver!: SimDriver;
  private enemyPool!: SpritePool;
  private towerPool!: SpritePool;
  private projectilePool!: SpritePool;
  private floatText!: FloatTextPool;
  private hud!: Phaser.GameObjects.BitmapText;
  private startedAt = 0;
  private phase: 'warmup' | 'sim+render' | 'render-only' | 'text-storm' | 'done' = 'warmup';
  private frameTimes: number[] = [];
  private simTimes: number[] = [];
  private lastFrameAt = 0;
  private phaseStart = 0;
  private results: PhaseResult[] = [];
  private peakEnemies = 0;
  private peakProjectiles = 0;
  private peakTexts = 0;
  private textsSpawned = 0;
  private logicalFrames = 0;
  private eventsSeen = 0;
  private stealsSeen = 0;
  private textStormSeq = 0;
  private orders: Command[] = [];

  constructor() {
    super({ key: 'Bench' });
  }

  create(): void {
    const content = createStressContent({
      enemyTarget: 250,
      towers: 35,
      attackIntervalTicks: 3,
      prepSeconds: 0.5,
    });
    ensureAtlas(
      this,
      Object.values(content.units).map((u) => ({ id: u.id, tier: u.tier })),
      Object.values(content.enemies).map((e) => ({
        id: e.id,
        armorType: e.armorType as string,
        flying: e.flying,
        boss: e.boss,
      })),
    );
    ensurePixelFont(this);

    this.enemyPool = new SpritePool(this, ATLAS_KEY, 250, 8);
    this.towerPool = new SpritePool(this, ATLAS_KEY, 40, 5);
    this.projectilePool = new SpritePool(this, ATLAS_KEY, 500, 12);
    this.floatText = new FloatTextPool(this, 300, 20);

    this.driver = new SimDriver({ seed: 20260214, difficultyId: 'N2', content, speed: 1 });
    this.orders = stressPlan(content, 35);

    const mapW = content.grid.width * TILE;
    const mapH = content.grid.height * TILE;
    const zoom = Math.max(
      1,
      Math.min(4, Math.floor(Math.min(this.scale.width / mapW, this.scale.height / mapH))),
    );
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(mapW / 2, mapH / 2);
    this.cameras.main.roundPixels = true;

    const g = this.add.graphics().setDepth(0);
    g.fillStyle(0x1b2130, 1);
    g.fillRect(0, 0, mapW, mapH);

    this.hud = this.add.bitmapText(8, 6, FONT_KEY, '', 8);
    this.hud.setScrollFactor(0).setDepth(30);

    this.startedAt = performance.now();
    this.phaseStart = this.startedAt;
    this.lastFrameAt = this.startedAt;
  }

  override update(): void {
    const now = performance.now();
    const frameMs = now - this.lastFrameAt;
    this.lastFrameAt = now;

    const simT0 = performance.now();
    if (this.phase !== 'render-only' && this.phase !== 'done') {
      const frames = this.driver.advance(frameMs);
      this.logicalFrames += frames;
      this.consumeEvents(this.driver.frameEvents);
    }
    const simMs = performance.now() - simT0;

    const snap = this.driver.snapshot;
    this.syncTowers(snap);
    this.syncEnemies(snap);
    this.syncProjectiles(snap);

    // text-storm 阶段：每帧强推 40 条飘字，把 300 容量的飘字池压到上限
    // （飘字寿命 2s × 40/帧 × 60fps = 4800 条在飞 → 池必然饱和并走"复用最旧"路径）
    if (this.phase === 'text-storm') {
      for (let i = 0; i < 40; i++) {
        this.floatText.spawn(
          ((i * 37 + this.textStormSeq * 11) % 1200) + 8,
          ((i * 53 + this.textStormSeq * 7) % 640) + 16,
          '+' + String(1 + (i % 99)),
          i % 7 === 0 ? 0xffe066 : 0xffd24a,
          2000,
        );
      }
      this.textStormSeq++;
    }

    this.floatText.update(frameMs);

    if (snap.enemies.length > this.peakEnemies) this.peakEnemies = snap.enemies.length;
    if (snap.projectiles.length > this.peakProjectiles) this.peakProjectiles = snap.projectiles.length;
    if (this.floatText.active > this.peakTexts) this.peakTexts = this.floatText.active;

    this.hud.setText(
      [
        `BENCH ${this.phase}`,
        `ENEMY ${snap.enemies.length} PROJ ${snap.projectiles.length} TEXT ${this.floatText.active}`,
        `FPS ${Math.round(this.game.loop.actualFps)}  TOWERS ${snap.towers.length}`,
      ].join('\n'),
    );

    if (this.phase === 'warmup') {
      if (now - this.startedAt > WARMUP_MS) {
        // 预热结束后一次性下发建造指令，避免把建塔开销算进测量窗口
        for (const c of this.orders) this.driver.push(c);
        this.phase = 'sim+render';
        this.phaseStart = now;
        this.frameTimes = [];
        this.simTimes = [];
      }
      return;
    }
    if (this.phase === 'done') return;

    this.frameTimes.push(frameMs);
    this.simTimes.push(simMs);
    if (now - this.phaseStart >= PHASE_MS) this.finishPhase(now);
  }

  private finishPhase(now: number): void {
    this.results.push(this.summarize(this.phase as string));
    const next: typeof this.phase | null =
      this.phase === 'sim+render' ? 'render-only' : this.phase === 'render-only' ? 'text-storm' : null;
    if (next === null) {
      this.phase = 'done';
      this.report();
      return;
    }
    this.phase = next;
    this.phaseStart = now;
    this.frameTimes = [];
    this.simTimes = [];
  }

  private summarize(name: string): PhaseResult {
    const frames = this.frameTimes;
    const sims = this.simTimes;
    const sorted = [...frames].sort((a, b) => a - b);
    const sortedSim = [...sims].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
    const totalMs = frames.reduce((a, b) => a + b, 0);

    // 最小 500ms 窗口 FPS（比"最小单帧"更接近玩家感受）
    let minWindowFps = Number.POSITIVE_INFINITY;
    let acc = 0;
    let winFrames = 0;
    for (const f of frames) {
      acc += f;
      winFrames++;
      if (acc >= 500) {
        minWindowFps = Math.min(minWindowFps, (winFrames * 1000) / acc);
        acc = 0;
        winFrames = 0;
      }
    }
    if (!Number.isFinite(minWindowFps)) {
      minWindowFps = acc > 0 ? (winFrames * 1000) / acc : 0;
    }

    return {
      name,
      seconds: totalMs / 1000,
      frames: frames.length,
      avgFps: mean > 0 ? 1000 / mean : 0,
      minWindowFps,
      p50FrameMs: percentile(sorted, 0.5),
      p95FrameMs: percentile(sorted, 0.95),
      p99FrameMs: percentile(sorted, 0.99),
      maxFrameMs: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : 0,
      jankRate: frames.length === 0 ? 0 : frames.filter((f) => f > 16.67).length / frames.length,
      simAvgMs: sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length),
      simP95Ms: percentile(sortedSim, 0.95),
      simMaxMs: sortedSim.length > 0 ? (sortedSim[sortedSim.length - 1] as number) : 0,
      peakEnemies: this.peakEnemies,
      peakProjectiles: this.peakProjectiles,
      peakTexts: this.peakTexts,
      textsSpawned: this.textsSpawned,
    };
  }

  private consumeEvents(events: readonly SimEvent[]): void {
    for (const ev of events) {
      this.eventsSeen++;
      if (ev.type !== 'steal') continue;
      this.stealsSeen++;
      const e = this.driver.world.enemyIndex.get(ev.enemyId);
      if (!e) continue;
      this.floatText.spawn(
        (e.pos.x / 1000) * TILE,
        (e.pos.y / 1000) * TILE - 8,
        '+' + String(toDisplayInt(ev.amount)),
        ev.crit ? 0xffe066 : 0xffd24a,
        // 基准里把飘字寿命拉长到 2s，才能把 300 容量的池压到接近上限
        // （出货配置是 900ms，见 FloatTextPool 默认值）
        2000,
      );
      this.textsSpawned++;
    }
  }

  private syncTowers(snap: WorldSnapshot): void {
    this.towerPool.releaseAll();
    for (const t of snap.towers) {
      const s = this.towerPool.acquire(unitFrame(t.unitId));
      s.setPosition((t.cell.x + 0.5) * TILE, (t.cell.y + 0.5) * TILE);
    }
  }

  private syncEnemies(snap: WorldSnapshot): void {
    this.enemyPool.releaseAll();
    for (const e of snap.enemies) {
      const p = this.driver.interpCell(e.id, e.pos.x / 1000, e.pos.y / 1000);
      const s = this.enemyPool.acquire(enemyFrame(e.defId));
      s.setPosition(p.x * TILE, p.y * TILE);
    }
  }

  private syncProjectiles(snap: WorldSnapshot): void {
    this.projectilePool.releaseAll();
    for (const p of snap.projectiles) {
      const s = this.projectilePool.acquire('projectile');
      s.setPosition((p.pos.x / 1000) * TILE, (p.pos.y / 1000) * TILE);
    }
  }

  private report(): void {
    const renderer = this.game.renderer as unknown as { gl?: WebGLRenderingContext };
    const gl = renderer.gl;
    const payload = {
      scene: 'Bench',
      renderer: this.game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS',
      pixelArt: this.game.config.pixelArt === true,
      antialias: this.game.config.antialias === true,
      roundPixels: this.game.config.roundPixels === true,
      viewport: { w: this.scale.width, h: this.scale.height },
      cameraZoom: this.cameras.main.zoom,
      glVendor: gl ? String(gl.getParameter(gl.VENDOR)) : null,
      glRenderer: gl ? String(gl.getParameter(gl.RENDERER)) : null,
      poolSizes: { enemy: 250, projectile: 500, text: 300 },
      poolPeak: {
        enemy: this.enemyPool.peak,
        projectile: this.projectilePool.peak,
        text: this.floatText.peak,
        projectileRecycled: this.projectilePool.recycled,
      },
      diagnostics: {
        logicalFrames: this.logicalFrames,
        eventsSeen: this.eventsSeen,
        stealsSeen: this.stealsSeen,
        textsSpawned: this.textsSpawned,
        textsAliveAtEnd: this.floatText.active,
      },
      phases: this.results,
    };
    console.log('BENCH_RESULT ' + JSON.stringify(payload));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自启动（该页面只用于基准，不需要菜单/存档）
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0a0d13',
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: '100%',
      height: '100%',
    },
    scene: [BenchScene],
  });
  (window as unknown as Record<string, unknown>).__BENCH_GAME__ = game;
}
