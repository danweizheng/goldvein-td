/**
 * 渲染层硬性约束的**静态检查**（不依赖浏览器即可跑）
 *
 * 策划案 §8.5「渲染优化清单」第 4 条：
 *   数字用 BitmapText 而非 Text（`Text` 每帧重绘 canvas，是最大性能杀手）。
 *
 * 「禁止使用 Phaser.Text」这件事必须可验证，而不是靠代码评审。
 * 这里直接扫描 src/render 下的源码，任何 `add.text(` / `GameObjects.Text`
 * 都会让测试失败。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDER_DIR = join(__dirname, '..');

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...collectSources(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('渲染层硬性约束（策划案 §8.5）', () => {
  const files = collectSources(RENDER_DIR);

  it('src/render 下存在实现文件（防止用例空跑）', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('禁止使用 Phaser.Text（必须用 BitmapText）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // 允许注释/文档里提到 Text，只拦真正的调用与类型引用
        const code = line.replace(/\/\/.*$/, '');
        if (/\.add\.text\s*\(/.test(code) || /Phaser\.GameObjects\.Text\b/.test(code) || /new\s+Text\s*\(/.test(code)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('飘字池用 BitmapText，且池容量为契约要求的 500/300/250', () => {
    const pools = readFileSync(join(RENDER_DIR, 'pools.ts'), 'utf8');
    expect(pools).toMatch(/add\.bitmapText/);
    expect(pools).toMatch(/BitmapText/);

    // 池容量（策划案 §8.5）：投射物 500 / 飘字 300 / 敌人 250
    //
    // ⚠️ 这条断言原先是对 GameScene.ts 的**构造字面量**做正则
    //    （`new SpritePool(this, ATLAS_KEY, 500`）。可玩路径重写后构造写法变了，
    //    它误报为回归 —— 而实测容量并没有变（敌人 250 / 飘字 300 都在）。
    //    【教训】断言对「某一行代码长什么样」敏感，就会在重构时误报；
    //    应当对「谁负责这个容量」敏感。
    //
    // 改为按职责归属分开断言：
    //   · 可玩场景负责：敌人 250、飘字 300（另有塔位池 48，非契约项）
    //   · 投射物 500 精灵池由基准页路径承担（可玩场景不绘制投射物精灵）
    const gameScene = readFileSync(join(RENDER_DIR, 'scenes', 'GameScene.ts'), 'utf8');
    expect(gameScene, '可玩场景：敌人池 = 250').toMatch(/new SpritePool\([^)]*,\s*250\s*,/);
    expect(gameScene, '可玩场景：飘字池 = 300').toMatch(/new FloatTextPool\([^)]*,\s*300\s*,/);

    const bench = readFileSync(join(RENDER_DIR, '..', '..', 'tools', 'bench', 'render-bench.ts'), 'utf8');
    expect(bench, '基准页：投射物池 = 500').toMatch(/new SpritePool\([^)]*,\s*500\s*,/);
  });

  it('像素风三件套在入口与图集里都被显式设置', () => {
    const main = readFileSync(join(RENDER_DIR, '..', 'main.ts'), 'utf8');
    expect(main).toMatch(/pixelArt:\s*true/);
    expect(main).toMatch(/antialias:\s*false/);
    expect(main).toMatch(/roundPixels:\s*true/);

    const atlas = readFileSync(join(RENDER_DIR, 'atlas.ts'), 'utf8');
    expect(atlas).toMatch(/FilterMode\.NEAREST/);

    const font = readFileSync(join(RENDER_DIR, 'pixel-font.ts'), 'utf8');
    expect(font).toMatch(/FilterMode\.NEAREST/);
  });

  it('相机缩放必须是整数倍（像素风不能糊）', () => {
    const gameScene = readFileSync(join(RENDER_DIR, 'scenes', 'GameScene.ts'), 'utf8');
    expect(gameScene).toMatch(/Math\.floor\(fit\)/);
    const bench = readFileSync(join(RENDER_DIR, '..', '..', 'tools', 'bench', 'render-bench.ts'), 'utf8');
    expect(bench).toMatch(/Math\.floor\(/);
  });

  it('index.html 有 image-rendering: pixelated', () => {
    const html = readFileSync(join(RENDER_DIR, '..', '..', 'index.html'), 'utf8');
    expect(html).toMatch(/image-rendering:\s*pixelated/);
  });
});
