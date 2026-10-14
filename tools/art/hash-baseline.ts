/**
 * 回归基线：打印全部精灵帧的哈希（改代码前后对照，确保"只改了想改的"）。
 * `& $node $pnpm exec tsx tools/art/hash-baseline.ts`
 */
import { normalizeContent } from '../../src/art/content';
import { ProceduralSpriteSource } from '../../src/art/procedural';
import { loadContent } from './load-content';

function hash(pixels: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i]! & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const content = normalizeContent(loadContent());
const source = new ProceduralSpriteSource(content);
for (const key of source.keys()) {
  const frame = source.frameFrame(key)!;
  console.log(`${key.padEnd(28)} ${hash(frame.pixels)} ${frame.width}x${frame.height}`);
}
console.log('TOTAL', source.keys().length);
