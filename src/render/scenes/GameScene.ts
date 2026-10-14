/**
 * GameScene —— 可玩路径的主场景（本次任务的核心）
 *
 * ## 分层（严格）
 *   - 模拟层：`SimDriver`（固定步长 + 倍速 + 插值），只从**快照**读状态；
 *   - 输入：一律走 `Command`，**绝不直接改状态**；
 *   - 美术：只认 `src/art/**` 的图集 frame key（`${id}:${state}`）；条的几何/颜色
 *     取自 `src/art/bars.ts` 的冻结规格，`src/render/**` **不内联形状逻辑**（方案 §3）。
 *
 * ## 本次重点是「窃金反馈」（策划案 §6.2 标注：**核心爽点，必须做足**）
 *
 *   攻击命中 → 金色 "＋N" 飘字（上浮 + 淡出 0.6s）
 *            → 金币计数器滚动
 *            → 敌人头顶【钱包条】减少      ← 招牌机制的可视化
 *            → 暴击：飘字加大 + 屏幕轻微震动 + 专用音效
 *
 * **钱包条宁可砍血条也不能砍**（方案 §2.4）：它是唯一能让人一眼看到"我在偷钱"的东西。
 *
 * ## 一处刻意的取舍
 * 投射物**不走精灵池**，而是用同一个 Graphics 批量画 3×3 方块 —— 因为 art 图集里
 * **没有投射物帧**（109 帧 = 29 塔×3 状态 + 11 敌×2 状态，正好用尽）。
 * 500 并发投射物的精灵池路径仍由 `tools/bench/render-bench.ts` 覆盖（它有自己的图集）。
 */
import Phaser from 'phaser';
import { BAR_SPECS, hpColor, layoutBars, walletFillWidth } from '../../art/bars';
import { inferElite } from '../../art/content';
import { GOLD, INK, WALLET_RING, WALLET_SLOT, type Rgba } from '../../art/palette';
import { artFrame, enemySpriteSize } from '../art-source';
import { FONT_KEY } from '../pixel-font';
import { FloatTextPool, SpritePool } from '../pools';
import { SimDriver, type SimDriverOptions } from '../SimDriver';
import { computeBuildableCells, rasterizePathCells } from '../../sim/world';
import type { SimContent } from '../../sim/content';
import type { SimEvent } from '../../sim/events';
import type { Cell, WorldSnapshot } from '../../sim/types';
import { toDisplayInt, truncDiv } from '../../sim/fixed';
import type { GameBoot } from './BootScene';

const TILE = 16;
const DEPTH = { ground: 0, range: 2, tower: 5, enemy: 8, bars: 10, text: 20, hud: 30 };

interface PanelEntry {
  line: string;
  label: string;
  rootUnitId: string;
  hotkey: string;
}

const r255 = (c: Rgba): number => (c[0] << 16) | (c[1] << 8) | c[2];
const WALLET_IS_SIGNATURE = BAR_SPECS.find((s) => s.id === 'wallet')?.priority === 2;

/** 卡位反馈用色：亮黄 = 钱包条"正被加速窃取"；红 = 阻挡/被阻挡刻度。 */
const BLOCK_HILIGHT: Rgba = [255, 240, 160, 255];
const BLOCK_RED: Rgba = [224, 68, 56, 255];

/**
 * 脚下的小挂锁（3×4 像素）—— 被阻挡敌人的"锁住它了"标记。
 * 纯整数 fillRect（无圆角），与像素风一致；画在着地点下方 3px。
 */
function drawPadlock(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
  // 锁梁
  g.fillStyle(r255(BLOCK_RED), 1);
  g.fillRect(x - 1, y, 2, 1);
  g.fillRect(x - 2, y + 1, 1, 1);
  g.fillRect(x + 1, y + 1, 1, 1);
  // 锁体
  g.fillStyle(r255(BLOCK_HILIGHT), 1);
  g.fillRect(x - 2, y + 2, 5, 3);
  g.fillStyle(r255(INK), 1);
  g.fillRect(x, y + 3, 1, 1);
}

/** 整数倍相机缩放（像素风硬性要求）。 */
export function computeIntegerZoom(viewW: number, viewH: number, mapW: number, mapH: number): number {
  const fit = Math.min(viewW / mapW, viewH / mapH);
  return Math.max(1, Math.min(4, Math.floor(fit)));
}

export class GameScene extends Phaser.Scene {
  private driver!: SimDriver;
  private content!: SimContent;
  private difficultyId!: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  private atlasKey = 'atlas';
  private artOk = false;
  private artReason = '';

  private enemyPool!: SpritePool;
  private towerPool!: SpritePool;
  private floatText!: FloatTextPool;
  private overlays!: Phaser.GameObjects.Graphics;
  private rangeGfx!: Phaser.GameObjects.Graphics;

  private hud!: Phaser.GameObjects.BitmapText;
  private preview!: Phaser.GameObjects.BitmapText;
  private panel!: Phaser.GameObjects.BitmapText;
  private detail!: Phaser.GameObjects.BitmapText;
  private hint!: Phaser.GameObjects.BitmapText;

  private panelEntries: PanelEntry[] = [];
  private selectedUnitId = '';
  private selectedTowerId = -1;
  private hoverCell: Cell | null = null;
  private speed: 1 | 2 | 4 = 1;
  private cameraZoom = 2;

  /** 金币滚动显示值（视觉，非模拟值） */
  private goldShown = 0;
  private lastGold = 0;
  private lastSfxAt = 0;
  private stealEvents = 0;
  private critEvents = 0;

  constructor() {
    super({ key: 'Game' });
  }

  create(boot: GameBoot): void {
    const data = boot?.content ? boot : (this.registry.get('bootData') as GameBoot);
    this.content = data.content;
    this.difficultyId = data.difficultyId ?? 'N1';
    this.atlasKey = data.atlasKey ?? 'atlas';
    this.artOk = data.artOk ?? false;
    this.artReason = data.artReason ?? '';

    const opts: SimDriverOptions = {
      seed: data.seed ?? 20260214,
      difficultyId: this.difficultyId,
      content: this.content,
    };
    this.driver = new SimDriver(opts);
    this.goldShown = this.driver.world.gold;
    this.lastGold = this.goldShown;

    // —— 对象池（策划案 §8.5：敌人 250 / 飘字 300）——
    this.enemyPool = new SpritePool(this, this.atlasKey, 250, DEPTH.enemy);
    this.towerPool = new SpritePool(this, this.atlasKey, 48, DEPTH.tower);
    this.floatText = new FloatTextPool(this, 300, DEPTH.text);

    this.overlays = this.add.graphics().setDepth(DEPTH.bars);
    this.rangeGfx = this.add.graphics().setDepth(DEPTH.range);

    this.drawGround();
    this.buildPanelEntries();
    this.createHud();
    this.setupCamera();
    this.setupInput();
    this.startMusic();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.enemyPool.releaseAll();
      this.towerPool.releaseAll();
      try {
        this.sound.stopAll();
      } catch {
        /* ignore */
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // 静态地面
  // ───────────────────────────────────────────────────────────────────────

  private drawGround(): void {
    const g = this.add.graphics().setDepth(DEPTH.ground);
    const { width, height, vault } = this.content.grid;
    g.fillStyle(0x101219, 1);
    g.fillRect(0, 0, width * TILE, height * TILE);

    const pathCells = rasterizePathCells(this.content);
    const buildable = computeBuildableCells(this.content, pathCells);

    g.fillStyle(0x1a1f2c, 1);
    for (const key of buildable) {
      const x = key % width;
      g.fillRect(x * TILE, truncDiv(key - x, width) * TILE, TILE, TILE);
    }
    g.fillStyle(0x2c3346, 1);
    for (const key of pathCells) {
      const x = key % width;
      g.fillRect(x * TILE, truncDiv(key - x, width) * TILE, TILE, TILE);
    }
    // ★停顿点（把隐性技巧显性化）
    for (const p of this.content.paths) {
      const wp = p.waypoints[p.haltIndex];
      if (!wp) continue;
      const cx = truncDiv(wp.x, 1000);
      const cy = truncDiv(wp.y, 1000);
      g.fillStyle(0xffc832, 1);
      g.fillRect(cx * TILE + 3, cy * TILE + 3, TILE - 6, TILE - 6);
      g.fillStyle(0x2c3346, 1);
      g.fillRect(cx * TILE + 6, cy * TILE + 6, TILE - 12, TILE - 12);
    }
    g.fillStyle(0x4a3b2a, 1);
    g.fillRect(vault.x * TILE, vault.y * TILE, vault.w * TILE, vault.h * TILE);
    g.fillStyle(0xd9a02b, 1);
    g.fillRect(vault.x * TILE + 6, vault.y * TILE + 6, vault.w * TILE - 12, vault.h * TILE - 12);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 建造面板（每系取根单位 —— 契约 §14.7：只能建根单位）
  // ───────────────────────────────────────────────────────────────────────

  /**
 * 建造面板 = **6 个最便宜的可攻击根单位**（数据驱动，不解析 id）。
 *
 * ⚠️ 这里踩过一个坑：第一版用正则从 id 里推"塔系名"（`x_t1` → `x`），
 * 而真实数据里 T1 的 id 是 `pickpocket` / `archer` / `mage`（**没有 `_t1` 后缀**），
 * 于是 6 个面板位里**神偷系直接消失**，试玩者点第一个键建出来的是弓手 ——
 * 一个纯 UI 缺陷，却让"偷钱爽不爽"这个核心问题**根本没法被试玩**。
 * 交互冒烟（真的点鼠标）把它抓出来了。
 *
 * 现在的规则只依赖数据字段：根单位 + `attack > 0` + 按造价升序取前 6。
 * 设计上的 6 大系 T1 造价正好是最低的 6 个，所以结果与"六大系"一致。
 */
  private buildPanelEntries(): void {
    const roots = this.driver.world.buildableRoots;
    const combatRoots = Object.values(this.content.units)
      .filter((u) => roots.has(u.id) && u.attack > 0)
      // 窃金塔排最前（本作核心是偷钱），其余按造价升序
      .sort(
        (a, b) =>
          Number(b.isSteal) - Number(a.isSteal) ||
          a.costGold - b.costGold ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 6);
    this.panelEntries = combatRoots.map((u, i) => ({
      line: u.id,
      label: u.name,
      rootUnitId: u.id,
      hotkey: String(i + 1),
    }));
    // 默认选中第一座（最便宜的根单位）
    this.selectedUnitId = this.panelEntries[0]?.rootUnitId ?? (Object.keys(this.content.units)[0] as string);
  }

  // ───────────────────────────────────────────────────────────────────────
  // HUD
  // ───────────────────────────────────────────────────────────────────────

  private createHud(): void {
    this.hud = this.add.bitmapText(6, 4, FONT_KEY, '', 8).setScrollFactor(0).setDepth(DEPTH.hud);
    this.preview = this.add.bitmapText(6, 46, FONT_KEY, '', 8).setScrollFactor(0).setDepth(DEPTH.hud);
    this.panel = this.add.bitmapText(6, 0, FONT_KEY, '', 8).setScrollFactor(0).setDepth(DEPTH.hud);
    this.detail = this.add.bitmapText(0, 60, FONT_KEY, '', 8).setScrollFactor(0).setDepth(DEPTH.hud);
    this.hint = this.add.bitmapText(6, 62, FONT_KEY, '', 8).setScrollFactor(0).setDepth(DEPTH.hud);
    this.layoutHud();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.layoutHud());
  }

  private layoutHud(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    this.panel.setPosition(6, h - 50);
    this.detail.setPosition(w - 200, 60);
    this.hint.setPosition(6, h - 14);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 相机 / 输入
  // ───────────────────────────────────────────────────────────────────────

  private setupCamera(): void {
    const cam = this.cameras.main;
    const mapW = this.content.grid.width * TILE;
    const mapH = this.content.grid.height * TILE;
    this.cameraZoom = computeIntegerZoom(this.scale.width, this.scale.height, mapW, mapH);
    cam.setZoom(this.cameraZoom);
    cam.centerOn(mapW / 2, mapH / 2);
    cam.setScroll(Math.round(cam.scrollX), Math.round(cam.scrollY));
    cam.roundPixels = true;
  }

  private setupInput(): void {
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.hoverCell = this.cellAt(pointer);
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const cell = this.cellAt(pointer);
      const snap = this.driver.snapshot;
      const hit = snap.towers.find((t) => t.cell.x === cell.x && t.cell.y === cell.y);
      if (hit) {
        this.selectedTowerId = hit.id;
        return;
      }
      this.driver.push({ type: 'build', unitId: this.selectedUnitId, cell });
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (dy === 0) return;
      const cam = this.cameras.main;
      const zoom = Math.max(1, Math.min(6, cam.zoom + (dy > 0 ? -1 : 1)));
      cam.setZoom(zoom);
      cam.setScroll(Math.round(cam.scrollX), Math.round(cam.scrollY));
      this.cameraZoom = zoom;
    });

    const kb = this.input.keyboard;
    if (!kb) return;
    const numberKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX'];
    for (const e of this.panelEntries) {
      const key = numberKeys[Number(e.hotkey) - 1];
      if (key) kb.on('keydown-' + key, () => {
        this.selectedUnitId = e.rootUnitId;
      });
    }
    kb.on('keydown-SPACE', () => {
      if (this.driver.paused) this.driver.push({ type: 'resume' });
      else this.driver.push({ type: 'pause' });
    });
    kb.on('keydown-F', () => {
      const next: 1 | 2 | 4 = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      this.speed = next;
      this.driver.push({ type: 'setSpeed', speed: next });
    });
    kb.on('keydown-U', () => {
      if (this.selectedTowerId >= 0) this.driver.push({ type: 'upgrade', towerId: this.selectedTowerId });
    });
    kb.on('keydown-S', () => {
      if (this.selectedTowerId >= 0) this.driver.push({ type: 'sell', towerId: this.selectedTowerId });
    });
    kb.on('keydown-Z', (ev: KeyboardEvent) => {
      if (ev.ctrlKey) this.driver.push({ type: 'undo' });
    });
    kb.on('keydown-R', () => this.driver.push({ type: 'activateSkill', skillId: 'salary' }));
    kb.on('keydown-T', () => this.driver.push({ type: 'activateSkill', skillId: 'bramble' }));
    kb.on('keydown-G', () => this.driver.push({ type: 'activateSkill', skillId: 'midas' }));
    const techIds = Object.keys(this.content.tech ?? {}).sort();
    ['Q', 'W', 'E'].forEach((k, i) => {
      const id = techIds[i];
      if (id) kb.on('keydown-' + k, () => this.driver.push({ type: 'research', techId: id }));
    });
  }

  private cellAt(pointer: Phaser.Input.Pointer): Cell {
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return { x: Math.floor(wp.x / TILE), y: Math.floor(wp.y / TILE) };
  }

  private startMusic(): void {
    try {
      if (this.cache.audio.exists('bgm_wave')) {
        const bgm = this.sound.add('bgm_wave', { loop: true, volume: 0.3 });
        bgm.play();
      }
    } catch {
      /* 自动播放策略/文件缺失都不该阻塞游戏 */
    }
  }

  private play(key: string, volume = 0.5): void {
    try {
      if (this.cache.audio.exists(key)) this.sound.play(key, { volume });
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 每帧
  // ───────────────────────────────────────────────────────────────────────

  override update(_time: number, delta: number): void {
    this.driver.advance(delta);
    const snap = this.driver.snapshot;
    this.lastGold = snap.gold;

    this.syncTowers(snap);
    this.syncEnemies(snap);
    this.drawOverlays(snap);
    this.consumeEvents(this.driver.frameEvents);
    this.floatText.update(delta);
    this.rollGold(snap, delta);
    this.updateHud(snap);
    this.drawRangePreview(snap);
  }

  private syncTowers(snap: WorldSnapshot): void {
    this.towerPool.releaseAll();
    for (const t of snap.towers) {
      const s = this.towerPool.acquire(artFrame(t.unitId, 'idle'));
      s.setOrigin(0.5, 1);
      s.setPosition(t.cell.x * TILE + TILE / 2, t.cell.y * TILE + TILE);
      s.setTint(t.id === this.selectedTowerId ? 0xffffff : 0xdfe4ee);
    }
  }

  private syncEnemies(snap: WorldSnapshot): void {
    this.enemyPool.releaseAll();
    for (const e of snap.enemies) {
      const p = this.driver.interpCell(e.id, e.pos.x / 1000, e.pos.y / 1000);
      const s = this.enemyPool.acquire(artFrame(e.defId, 'walk'));
      s.setOrigin(0.5, 1);
      s.setPosition(p.x * TILE, p.y * TILE);
      // 钱包被偷光 → 褪色（"我把它榨干了"的即时反馈）
      s.setTint(e.walletRemaining <= 0 ? 0x808080 : 0xffffff);
    }
  }

  /**
   * 血条 + **钱包条** + 投射物 + 阻挡标记（一个 Graphics 批量画完）。
   *
   * 几何与颜色全部来自 `src/art/bars.ts` 的冻结规格 + `src/art/palette.ts` 的调色板，
   * 渲染层不自己发明形状（方案 §3 的接线约定）。
   */
  private drawOverlays(snap: WorldSnapshot): void {
    const g = this.overlays;
    g.clear();

    // ① 阻挡范围（红色虚线）——军训系价值的可视化（策划案 §6.2）
    if (this.showBlockRanges(snap)) {
      for (const t of snap.towers) {
        if (t.block <= 0) continue;
        this.strokeDashedCircle(g, (t.cell.x + 0.5) * TILE, (t.cell.y + 0.5) * TILE, (t.blockRange / 1000) * TILE);
      }
      const placing = this.content.units[this.selectedUnitId];
      const cell = this.hoverCell;
      if (placing && placing.block > 0 && cell) {
        this.strokeDashedCircle(g, cell.x * TILE + TILE / 2, cell.y * TILE + TILE / 2, (placing.blockRange / 1000) * TILE);
      }
    }

    for (const e of snap.enemies) {
      const p = this.driver.interpCell(e.id, e.pos.x / 1000, e.pos.y / 1000);
      const def = this.content.enemies[e.defId];
      const elite = def ? inferElite({ id: def.id, armorType: def.armorType, flying: def.flying, isBoss: def.boss, stealResist: def.stealResist, dodge: def.dodge }) : false;
      const size = enemySpriteSize(def?.boss ?? false, elite);
      const anchorX = Math.round(p.x * TILE);
      const anchorY = Math.round(p.y * TILE);
      const L = layoutBars(size, anchorX, anchorY);

      const hpPermille = e.hpMax > 0 ? Math.round((e.hp / e.hpMax) * 1000) : 0;
      g.fillStyle(r255(INK), 1);
      g.fillRect(L.hp.x, L.hp.y, L.hp.w, L.hp.h);
      const hpFill = Math.round((L.hp.w * Math.max(0, Math.min(1000, hpPermille))) / 1000);
      if (hpFill > 0) {
        g.fillStyle(r255(hpColor(hpPermille)), 1);
        g.fillRect(L.hp.x, L.hp.y, hpFill, L.hp.h);
      }

      // ★ 钱包条：暗外圈 → 底槽 → 金填充（"被偷掉多少" = 暗槽长度）
      const walletPermille = e.walletMax > 0 ? Math.round((e.walletRemaining / e.walletMax) * 1000) : 0;
      if (WALLET_IS_SIGNATURE) {
        g.fillStyle(r255(WALLET_RING), 1);
        g.fillRect(L.walletRing.x, L.walletRing.y, L.walletRing.w, L.walletRing.h);
        g.fillStyle(r255(WALLET_SLOT), 1);
        g.fillRect(L.walletSlot.x, L.walletSlot.y, L.walletSlot.w, L.walletSlot.h);
        const wFill = walletFillWidth(L.walletFillArea.w, walletPermille);
        if (wFill > 0) {
          // 被阻挡时钱包条加亮：把"它正在被加速窃取"顶到眼前
          g.fillStyle(e.blockedBy !== null ? r255(BLOCK_HILIGHT) : r255(GOLD), 1);
          g.fillRect(L.walletFillArea.x, L.walletFillArea.y, wFill, L.walletFillArea.h);
        }
      }

      // ② 被阻挡：脚下刻度变红（"移速被压住"）+ **锁图标**
      if (e.blockedBy !== null) {
        g.fillStyle(r255(BLOCK_HILIGHT), 1);
        g.fillRect(L.block.x - 1, L.block.y, 3, 1);
        g.fillStyle(r255(BLOCK_RED), 1);
        g.fillRect(L.block.x - 1, L.block.y + 1, 3, 1);
        drawPadlock(g, anchorX, anchorY + 3);
      }
    }

    // 投射物（3×3 方块；art 图集无投射物帧，见文件头说明）
    g.fillStyle(0xf2f4f8, 1);
    for (const pr of snap.projectiles) {
      g.fillRect(Math.round((pr.pos.x / 1000) * TILE) - 1, Math.round((pr.pos.y / 1000) * TILE) - 1, 3, 3);
    }
  }

  /**
   * 是否显示阻挡范围虚线：选中的塔有阻挡，或正准备建一个有阻挡的单位。
   * 这条虚线就是**军训系价值的可视化**（策划案 §6.2「放置军训教官 → 显示阻挡范围」）。
   */
  private showBlockRanges(snap: WorldSnapshot): boolean {
    const placing = this.content.units[this.selectedUnitId];
    if (placing && placing.block > 0) return true;
    const sel = snap.towers.find((t) => t.id === this.selectedTowerId);
    return (sel?.block ?? 0) > 0;
  }

  /** 红色虚线圆：Graphics 没有 dash，用固定份数的短划逼近（全整数坐标）。 */
  private strokeDashedCircle(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
    const segments = 28;
    const color = r255(BLOCK_RED);
    for (let i = 0; i < segments; i++) {
      if (i % 2 === 1) continue; // 隔一段画一段 = 虚线
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const steps = 3;
      for (let s = 0; s <= steps; s++) {
        const a = a0 + ((a1 - a0) * s) / steps;
        g.fillStyle(color, 1);
        g.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
      }
    }
  }

  private drawRangePreview(snap: WorldSnapshot): void {
    const g = this.rangeGfx;
    g.clear();
    const cell = this.hoverCell;
    if (!cell) return;
    const def = this.content.units[this.selectedUnitId];
    if (!def) return;
    const cx = cell.x * TILE + TILE / 2;
    const cy = cell.y * TILE + TILE / 2;
    const r = (def.range / 1000) * TILE;
    const affordable = snap.gold >= def.costGold;
    g.lineStyle(1, affordable ? 0x7ad46b : 0xe04438, 0.9);
    g.strokeCircle(cx, cy, r);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 反馈（本次核心）
  // ───────────────────────────────────────────────────────────────────────

  private consumeEvents(events: readonly SimEvent[]): void {
    const cam = this.cameras.main;
    for (const ev of events) {
      switch (ev.type) {
        case 'steal': {
          this.stealEvents++;
          const e = this.driver.world.enemyIndex.get(ev.enemyId);
          if (!e) break;
          const x = (e.pos.x / 1000) * TILE;
          const y = (e.pos.y / 1000) * TILE - 20;
          const amount = toDisplayInt(ev.amount);
          this.floatText.spawn(x, y, '+' + String(amount), ev.crit ? 0xffe066 : 0xffc832, ev.crit ? 900 : 600);
          if (ev.crit) {
            this.critEvents++;
            this.floatText.spawn(x + 6, y - 9, 'CRIT', 0xfff2a8, 900);
            cam.shake(90, 0.0035);
            this.play('sfx_steal_crit', 0.6);
          } else {
            // 每次都响会糊成一片 → 按时间节流 70ms（事件计数不受影响）
            const now = this.time.now;
            if (now - this.lastSfxAt >= 70) {
              this.lastSfxAt = now;
              this.play('sfx_steal_normal', 0.3);
            }
          }
          break;
        }
        case 'kill':
          this.play('sfx_combat_enemy_death', 0.3);
          break;
        case 'leak':
          this.play('sfx_ui_error', 0.5);
          cam.shake(200, 0.006);
          this.floatText.spawn(cam.midPoint.x, cam.midPoint.y, 'LEAK', 0xff4040, 1200);
          break;
        case 'build':
          this.play('sfx_ui_build', 0.5);
          break;
        case 'upgrade':
          this.play('sfx_ui_upgrade', 0.5);
          break;
        case 'sell':
        case 'undo':
          this.play('sfx_ui_sell', 0.45);
          break;
        case 'commandRejected':
          this.play('sfx_ui_error', 0.3);
          this.floatText.spawn(cam.midPoint.x, cam.midPoint.y, ev.reason.slice(0, 18), 0xffa040, 900);
          break;
        case 'waveStart':
          this.play('sfx_wave_warning', 0.45);
          this.floatText.spawn(cam.midPoint.x, cam.midPoint.y - 40, 'WAVE ' + String(ev.wave), 0x9be8c0, 1400);
          break;
        case 'skillActivated':
          this.play(ev.skillId === 'midas' ? 'sfx_steal_midas' : 'sfx_ui_confirm', 0.5);
          break;
        case 'gameOver': {
          this.play(ev.result === 'win' ? 'sfx_win' : 'sfx_lose', 0.7);
          const label = ev.result === 'win' ? 'VICTORY' : ev.result === 'ascended' ? 'ASCENDED' : 'DEFEAT';
          this.floatText.spawn(cam.midPoint.x, cam.midPoint.y, label, 0xffffff, 4000);
          break;
        }
        default:
          break;
      }
    }
  }

  /** 金币计数器滚动（策划案 §6.1 ①） */
  private rollGold(snap: WorldSnapshot, delta: number): void {
    const target = snap.gold;
    if (this.goldShown === target) return;
    const diff = target - this.goldShown;
    const step = Math.max(1, Math.abs(diff) * Math.min(1, delta / 120));
    this.goldShown = diff > 0 ? Math.min(target, this.goldShown + step) : Math.max(target, this.goldShown - step);
  }

  // ───────────────────────────────────────────────────────────────────────
  // HUD 文本
  // ───────────────────────────────────────────────────────────────────────

  private updateHud(snap: WorldSnapshot): void {
    const stats = snap.currentWaveStats;
    const coverage = stats.walletTotal > 0 ? (stats.stealCoverage / 10).toFixed(1) : '—';
    const fps = Math.round(this.game.loop.actualFps);
    const techLines = Object.values(this.content.tech ?? {}).length;

    this.hud.setText(
      [
        `GOLD ${toDisplayInt(this.goldShown)}  WOOD ${toDisplayInt(snap.wood)}  POP ${snap.population}/${snap.populationCap}  WAVE ${snap.wave}/${snap.waveTotal}  LIVES ${snap.lives}`,
        `本波窃金覆盖率 ${coverage}%   本波窃取 ${toDisplayInt(stats.stolenTotal)}金   击杀奖励 ${toDisplayInt(stats.goldEarned - stats.stolenTotal)}金   漏怪 ${stats.leaks}   卡位额外 +${toDisplayInt(stats.blockExtraSteal)}`,
        `${this.difficultyId}  ${this.speed}x  ${this.driver.paused ? 'PAUSED' : 'RUNNING'}  ZOOM ${this.cameraZoom}x  FPS ${fps}  ART ${this.artOk ? 'ok' : 'FALLBACK'}  科技线 ${techLines}`,
      ].join('\n'),
    );

    // ③ 波次预告（策划案：本作最重要的 UX 改良）
    if (snap.nextWave) {
      const groups = snap.nextWave.groups
        .map((gr) => `${gr.count}x ${gr.name}(${armorLabel(gr.armorType)}${gr.flying ? '·飞行' : ''})`)
        .join(' · ');
      this.preview.setText(
        `下一波 ${snap.nextWave.wave}：${groups}\n推荐攻击：${recommendAttack(snap.nextWave.groups.map((gr) => gr.armorType))}   ${snap.nextWave.hint}`,
      );
    } else {
      this.preview.setText('最后一波');
    }

    // ② 建造面板（造价 + 买不起灰显 + 定位）
    const rows: string[] = [];
    for (let i = 0; i < this.panelEntries.length; i++) {
      const e = this.panelEntries[i] as PanelEntry;
      const def = this.content.units[e.rootUnitId];
      if (!def) continue;
      const afford = snap.gold >= def.costGold;
      const mark = e.rootUnitId === this.selectedUnitId ? '>' : ' ';
      const tag = def.isSteal ? '核心·偷钱' : def.block > 0 ? '卡位' : '输出';
      rows.push(`${mark}[${i + 1}] ${e.label} ${toDisplayInt(def.costGold)}金 ${tag}${afford ? '' : ' [买不起]'}`);
    }
    this.panel.setText(rows.join('\n'));

    // ④ 单位详情（窃金/秒 = 关键指标）
    const sel = snap.towers.find((t) => t.id === this.selectedTowerId);
    if (sel) {
      const def = this.content.units[sel.unitId];
      const next = def?.upgradeTo ? this.content.units[def.upgradeTo] : undefined;
      this.detail.setText(
        [
          `${def?.name ?? sel.unitId}  T${sel.tier}`,
          `攻击 ${toDisplayInt(sel.attack)}   射程 ${(sel.range / 1000).toFixed(1)} 格`,
          `窃金/秒 +${toDisplayInt(sel.stealPerSecond)}`,
          `已窃取 ${toDisplayInt(sel.totalStolen)} 金`,
          `攻速 ${(1000 / Math.max(1, sel.attackInterval)).toFixed(2)} /s`,
          next ? `[U] 升级→${next.name} ${toDisplayInt(next.costGold)}金` : '已满级',
          '[S] 出售（返还 70%）',
        ].join('\n'),
      );
    } else {
      this.detail.setText('点击一座塔查看详情\n（窃金/秒 是判断"值不值"的关键指标）');
    }

    const warn = this.artOk ? '' : `   ⚠ ART 降级：${this.artReason.slice(0, 36)}`;
    this.hint.setText(
      `点击建塔/选塔  [U]升级 [S]出售 [Ctrl+Z]撤销 [空格]暂停 [F]倍速 [R]领工资 [T]荆棘 [G]点金 [Q/W/E]研究${warn}`,
    );
  }

  /** 供自动化/QA 读取的调试状态（只读） */
  get debugState(): {
    artOk: boolean;
    wave: number;
    gold: number;
    stealEvents: number;
    critEvents: number;
    selectedUnitId: string;
    blockRangesShown: boolean;
  } {
    const sel = this.driver.snapshot.towers.find((t) => t.id === this.selectedTowerId);
    const placing = this.content.units[this.selectedUnitId];
    return {
      artOk: this.artOk,
      wave: this.driver.world.wave,
      gold: this.driver.world.gold,
      stealEvents: this.stealEvents,
      critEvents: this.critEvents,
      selectedUnitId: this.selectedUnitId,
      blockRangesShown: (placing?.block ?? 0) > 0 || (sel?.block ?? 0) > 0,
    };
  }
}

const ARMOR_LABEL: Record<string, string> = {
  light: '轻甲',
  medium: '中甲',
  heavy: '重甲',
  fortified: '城甲',
  divine: '神圣甲',
  hero: '英雄甲',
};

function armorLabel(a: string): string {
  return ARMOR_LABEL[a] ?? a;
}

/** 由下一波护甲构成推荐攻击类型（策划案 §4.3 的克制方向）。 */
function recommendAttack(armors: readonly string[]): string {
  const has = (t: string): boolean => armors.includes(t);
  const parts: string[] = [];
  if (has('light')) parts.push('穿刺');
  if (has('medium')) parts.push('魔法/混乱');
  if (has('heavy')) parts.push('魔法');
  if (has('fortified')) parts.push('攻城');
  if (has('divine')) parts.push('混乱(唯一)');
  return parts.length > 0 ? parts.join(' / ') : '任意';
}