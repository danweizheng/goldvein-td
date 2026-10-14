/**
 * 应用入口 = **组合根**（composition root）
 *
 * ## 唯一的适配层引用点（架构约束，别扩散）
 *
 * `src/balance/data-adapter.ts` 把 `src/data/*.json` 转成 `SimContent`；
 * 它最终要迁到 `src/data/adapter.ts`（那笔债已登记）。
 * **所以本文件是全项目唯一 import 它的地方** —— 迁移时只改这一行，
 * 而 `src/render/**` 只接收 `SimContent` 参数，一行都不用动。
 *
 * ## 像素风硬性配置（策划案 §7.1 / §8.5 第 5 条）
 *
 *   pixelArt: true   → antialias: false + roundPixels: true
 *   antialias: false → 纹理过滤走 NEAREST
 *   roundPixels: true→ 精灵位置取整，避免半像素采样
 *
 * ## URL 参数
 *
 *   ?difficulty=N1..N5   默认 **N1**（试玩门禁用的就是 N1）
 *   ?seed=12345          默认固定值，便于复现
 *   ?scene=probe         像素无糊边校验场景
 */
import Phaser from 'phaser';
import { BootScene, type BootSceneData } from './render/scenes/BootScene';
import { GameScene } from './render/scenes/GameScene';
import { PixelProbeScene } from './render/scenes/PixelProbeScene';

// TODO(M1)：适配层迁往 src/data/adapter.ts，届时仅此一行需要改
import { loadRealContent } from './balance/data-adapter';

const DIFFICULTIES = ['N1', 'N2', 'N3', 'N4', 'N5'] as const;
type DifficultyId = (typeof DIFFICULTIES)[number];

const params = new URLSearchParams(window.location.search);

function readDifficulty(): DifficultyId {
  const raw = (params.get('difficulty') ?? 'N1').toUpperCase();
  return (DIFFICULTIES as readonly string[]).includes(raw) ? (raw as DifficultyId) : 'N1';
}

const seedRaw = params.get('seed');
const bootData: BootSceneData = {
  content: loadRealContent(),
  difficultyId: readDifficulty(),
  seed: seedRaw !== null && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : 20260214,
};

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#101219',
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: '100%',
    height: '100%',
  },
  scene: [BootScene, GameScene, PixelProbeScene],
};

const game = new Phaser.Game(config);
// 第一个场景（Boot）在第 1 帧才 create，所以此刻写入 registry 一定早于它读取；
// 同时 BootScene 也支持 scene.start(key, data) 的显式传参（两条路都通）。
game.registry.set('bootData', bootData);
// 供自动化冒烟（tools/bench/playable-smoke.ts）读取页面客观事实
(window as unknown as Record<string, unknown>).__DSH_GAME__ = game;

export default game;