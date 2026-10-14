/**
 * BootScene —— 加载 art 语义化图集 + 音频，然后交给 GameScene。
 *
 * 加载顺序刻意如此：
 *   1. **art 图集优先**（`art-proxy` 的 `atlas.png` / `atlas.json`）—— 玩家要能看出护甲；
 *   2. 失败则兜底到 `src/render/atlas.ts` 的程序化图集，并把 `artOk=false` 传下去
 *      （HUD 会显示一行警告，**不静默降级**）；
 *   3. 音频：40 个文件里只加载本次用到的，首屏体积与加载时间都更可控。
 */
import Phaser from 'phaser';
import { ensureAtlas, FRAMES } from '../atlas';
import { ensurePixelFont, FONT_KEY } from '../pixel-font';
import { ART_TEXTURE_KEY, preloadArtAtlas, registerArtAtlas, type ArtAtlasStatus } from '../art-source';
import type { SimContent } from '../../sim/content';

/** 本次运行实际加载的音频（契约 §11.2 的 id 即文件名）。 */
export const AUDIO_KEYS = [
  'sfx_steal_normal',
  'sfx_steal_crit',
  'sfx_steal_midas',
  'sfx_ui_build',
  'sfx_ui_upgrade',
  'sfx_ui_sell',
  'sfx_ui_error',
  'sfx_ui_confirm',
  'sfx_combat_enemy_death',
  'sfx_wave_warning',
  'sfx_win',
  'sfx_lose',
  'bgm_wave',
] as const;

export interface BootSceneData {
  /** 真实数据内容（由 main.ts 的组合根注入） */
  content?: SimContent;
  difficultyId?: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  seed?: number;
  /** 进入哪个场景（默认 Game；`?scene=probe` 用于像素校验） */
  next?: string;
}

/** GameScene 需要的引导产物（图集选了哪条路、资源是否就绪）。 */
export interface GameBoot {
  content: SimContent;
  difficultyId: 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
  seed?: number;
  atlasKey: string;
  artOk: boolean;
  artReason: string;
}

export class BootScene extends Phaser.Scene {
  /** ⚠️ 字段不能叫 `data`：Phaser.Scene 自己有一个 `data` 插件属性，重名会覆盖它 */
  private bootInput!: BootSceneData;

  constructor() {
    super({ key: 'Boot' });
  }

  init(data: BootSceneData): void {
    // 两条路都通：显式 scene.start(key, data) 优先，否则读组合根写进 registry 的 bootData
    const fromRegistry = this.registry.get('bootData') as BootSceneData | undefined;
    this.bootInput = data?.content ? data : (fromRegistry ?? data);
  }

  preload(): void {
    preloadArtAtlas(this);
    for (const key of AUDIO_KEYS) {
      this.load.audio(key, `assets/audio/${key}.ogg`);
    }
    // 资源缺失（如音频未到齐）不应阻塞游戏
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, () => undefined);
  }

  create(): void {
    const content = this.bootInput.content;
    if (!content) {
      throw new Error('BootScene: 缺少 content（应由 main.ts 的组合根注入）');
    }

    // ① art 图集（默认路径）
    const artStatus: ArtAtlasStatus = registerArtAtlas(this);

    // ② 兜底：art 不可用时用程序化图集，保证"永远能开"
    let atlasKey = ART_TEXTURE_KEY;
    if (!artStatus.ok) {
      const units = Object.values(content.units).map((u) => ({ id: u.id, tier: u.tier }));
      const enemies = Object.values(content.enemies).map((e) => ({
        id: e.id,
        armorType: e.armorType as string,
        flying: e.flying,
        boss: e.boss,
      }));
      atlasKey = ensureAtlas(this, units, enemies).key;
    }

    ensurePixelFont(this);
    this.registry.set('atlasKey', atlasKey);
    this.registry.set('artOk', artStatus.ok);
    this.registry.set('artFrames', artStatus.frames);
    this.registry.set('fontKey', FONT_KEY);
    this.registry.set('fallbackProbeFrame', FRAMES.probe);

    const wanted = this.bootInput.next ?? new URLSearchParams(window.location.search).get('scene') ?? 'Game';
    const sceneKey = wanted === 'probe' ? 'PixelProbe' : wanted;
    const boot: GameBoot = {
      content,
      difficultyId: this.bootInput.difficultyId ?? 'N1',
      seed: this.bootInput.seed,
      atlasKey,
      artOk: artStatus.ok,
      artReason: artStatus.reason ?? '',
    };
    this.scene.start(sceneKey, boot);
  }
}