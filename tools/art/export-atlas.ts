/**
 * 图集落盘（方案 §3 的 `AtlasSpec` + 像素数据）。
 *
 * 产出（供 `src/render/**` 后续加载，替换成本 = 换一个 `SpriteSource` 实现）：
 * - `src/art/out/atlas.json` —— `AtlasSpec`（含每帧位置与锚点）
 * - `src/art/out/atlas.png`  —— 图集像素（RGBA，NEAREST 取整缩放即可用）
 *
 * 运行：`& $node $pnpm exec tsx tools/art/export-atlas.ts`
 *
 * ⚠️ 这两个文件是**生成物**，不要手改；改生成逻辑后重跑本脚本即可。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValidSource } from '../../src/art/source';
import { ProceduralSpriteSource, spriteSizeOf } from '../../src/art/procedural';
import { enemyRank } from '../../src/art/content';
import { loadContent, REPO_ROOT } from './load-content';
import { encodePng } from './png';

/** 落盘目录（`src/art/out/`）。 */
export const ATLAS_OUT_DIR = resolve(REPO_ROOT, 'src', 'art', 'out');

export interface AtlasExport {
  readonly jsonPath: string;
  readonly pngPath: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly frameCount: number;
  readonly jsonBytes: number;
  readonly pngBytes: number;
}

/** 生成图集并落盘（导出成函数，便于单测断言而不写文件时改用 `buildAtlasOnly`）。 */
export function exportAtlas(): AtlasExport {
  const content = loadContent();
  const source = new ProceduralSpriteSource(content);
  assertValidSource(source, 'ProceduralSpriteSource');

  const pixels = source.render();
  const png = encodePng(pixels, source.atlas.imageWidth, source.atlas.imageHeight);

  // frames 按 key 排序后再序列化：输出稳定，CI diff 才有意义。
  const sortedFrames: Record<string, (typeof source.atlas.frames)[string]> = {};
  for (const key of Object.keys(source.atlas.frames).sort()) {
    sortedFrames[key] = source.atlas.frames[key]!;
  }
  const spec = { ...source.atlas, frames: sortedFrames };
  const json = `${JSON.stringify(spec, null, 2)}\n`;

  mkdirSync(ATLAS_OUT_DIR, { recursive: true });
  const jsonPath = resolve(ATLAS_OUT_DIR, 'atlas.json');
  const pngPath = resolve(ATLAS_OUT_DIR, 'atlas.png');
  writeFileSync(jsonPath, json, 'utf8');
  writeFileSync(pngPath, png);

  return {
    jsonPath,
    pngPath,
    imageWidth: source.atlas.imageWidth,
    imageHeight: source.atlas.imageHeight,
    frameCount: Object.keys(spec.frames).length,
    jsonBytes: Buffer.byteLength(json, 'utf8'),
    pngBytes: png.length,
  };
}

function main(): void {
  const content = loadContent();
  const result = exportAtlas();
  console.log(`atlas: ${result.imageWidth}x${result.imageHeight}, ${result.frameCount} frames`);
  console.log(`  ${result.jsonPath}  ${result.jsonBytes} bytes`);
  console.log(`  ${result.pngPath}  ${result.pngBytes} bytes`);
  console.log('\nper-frame sizes (rank -> px):');
  const seen = new Map<number, string[]>();
  for (const e of content.enemies) {
    const size = spriteSizeOf(enemyRank(e));
    const list = seen.get(size) ?? [];
    list.push(e.id);
    seen.set(size, list);
  }
  for (const [size, ids] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size}x${size}: ${ids.length} enemies (${ids.join(', ')})`);
  }
  console.log(`  48x48: ${content.units.length} towers`);
  console.log(`\n(seed root: ${dirname(fileURLToPath(import.meta.url))})`);
}

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (entry !== undefined && resolve(entry).toLowerCase() === resolve(thisFile).toLowerCase()) {
  main();
}
