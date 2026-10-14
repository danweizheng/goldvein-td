/**
 * 图集产物门禁（`src/art/out/atlas.json` + `atlas.png`）。
 *
 * 这两份文件是**交给 `src/render/**` 的实际输入**。它们一旦与生成器不同步，
 * 游戏里就会出现"代码是对的、图是旧的"这种最难查的问题。所以这里断言：
 * 1. 图集里每一帧的像素 == 单独渲染该帧的像素（blit 没写错位置）；
 * 2. 落盘的 PNG / JSON == 现在重新生成的结果（**产物没有过期**）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeContent } from '../../src/art/content';
import { ProceduralSpriteSource } from '../../src/art/procedural';
import { decodePng } from '../../tools/art/png';
import { loadContent, REPO_ROOT } from '../../tools/art/load-content';
import { ATLAS_OUT_DIR } from '../../tools/art/export-atlas';
import { assertValidSource } from '../../src/art/source';

const content = normalizeContent(loadContent());
const source = new ProceduralSpriteSource(content);

describe('图集内部一致性', () => {
  it('每一帧在图集里的像素都与单独渲染一致', () => {
    const atlas = source.render();
    const { imageWidth, frames } = source.atlas;
    let checked = 0;
    for (const [key, ref] of Object.entries(frames)) {
      const frame = source.frameFrame(key);
      expect(frame, `缺少 ${key} 的独立渲染`).toBeDefined();
      for (let row = 0; row < ref.h; row++) {
        for (let col = 0; col < ref.w; col++) {
          const dst = ((ref.y + row) * imageWidth + (ref.x + col)) * 4;
          const src = (row * frame!.width + col) * 4;
          if (
            atlas[dst] !== frame!.pixels[src] ||
            atlas[dst + 1] !== frame!.pixels[src + 1] ||
            atlas[dst + 2] !== frame!.pixels[src + 2] ||
            atlas[dst + 3] !== frame!.pixels[src + 3]
          ) {
            throw new Error(`${key} 在 (${col},${row}) 处与独立渲染不一致`);
          }
        }
      }
      checked++;
    }
    console.log('[atlas] 逐像素核对帧数 =', checked);
    expect(checked).toBe(source.keys().length);
  });

  it('帧之间至少留 1px 间隔（NEAREST 采样不串色）', () => {
    const entries = Object.entries(source.atlas.frames);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]![1];
        const b = entries[j]![1];
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        // 同行相邻只需 x 方向有间隔，异行只需 y 方向有间隔
        expect(Math.max(gapX, gapY), `${entries[i]![0]} 与 ${entries[j]![0]} 挨得太近`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('落盘产物没有过期（render/ 会直接加载它）', () => {
  const jsonPath = resolve(ATLAS_OUT_DIR, 'atlas.json');
  const pngPath = resolve(ATLAS_OUT_DIR, 'atlas.png');

  it('atlas.json 与当前生成器一致', () => {
    const onDisk = JSON.parse(readFileSync(jsonPath, 'utf8')) as typeof source.atlas;
    expect(onDisk.imageWidth).toBe(source.atlas.imageWidth);
    expect(onDisk.imageHeight).toBe(source.atlas.imageHeight);
    expect(onDisk.meta).toEqual(source.atlas.meta);
    expect(Object.keys(onDisk.frames).sort()).toEqual(Object.keys(source.atlas.frames).sort());
    for (const [key, ref] of Object.entries(source.atlas.frames)) {
      expect(onDisk.frames[key], `${key} 位置不一致`).toEqual(ref);
    }
  });

  it('atlas.png 解出来与 render() 逐字节一致', () => {
    const decoded = decodePng(new Uint8Array(readFileSync(pngPath)));
    const rendered = source.render();
    expect(decoded.width).toBe(source.atlas.imageWidth);
    expect(decoded.height).toBe(source.atlas.imageHeight);
    for (let i = 0; i < rendered.length; i++) {
      if (decoded.rgba[i] !== rendered[i]) {
        throw new Error(`atlas.png 第 ${i} 字节与生成器不一致（产物过期？跑 tools/art/export-atlas.ts）`);
      }
    }
  });

  it('atlas.json 满足契约（正整数尺寸 / 锚点在帧内 / 帧不越界）', () => {
    const onDisk = JSON.parse(readFileSync(jsonPath, 'utf8')) as typeof source.atlas;
    expect(() =>
      assertValidSource({ atlas: onDisk, render: () => source.render() }, 'atlas.json'),
    ).not.toThrow();
  });

  it('产物路径在 art-proxy 的独占目录内', () => {
    expect(jsonPath.startsWith(resolve(REPO_ROOT, 'src', 'art', 'out'))).toBe(true);
    expect(pngPath.startsWith(resolve(REPO_ROOT, 'src', 'art', 'out'))).toBe(true);
  });
});
