/**
 * 一次性基准：接触表生成与 deflate 等级（**不是交付物，是调参工具**）。
 * 运行：`& $node $pnpm exec tsx tools/art/bench-encode.ts`
 */
import { deflateSync } from 'node:zlib';

import { buildContactSheet } from './contact-sheet';
import { loadContent } from './load-content';

const content = loadContent();
const t0 = Date.now();
const sheet = buildContactSheet(content);
console.log('build 4x sheet:', Date.now() - t0, 'ms', `${sheet.width}x${sheet.height}`);

const stride = sheet.width * 4;
const raw = Buffer.allocUnsafe((stride + 1) * sheet.height);
const src = Buffer.from(sheet.color.buffer, sheet.color.byteOffset, sheet.color.length);
for (let y = 0; y < sheet.height; y++) {
  raw[y * (stride + 1)] = 0;
  src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
}

for (const level of [1, 6, 9] as const) {
  const t = Date.now();
  const out = deflateSync(raw, { level });
  console.log(`deflate level ${level}: ${Date.now() - t} ms, ${out.length} bytes`);
}

const tc = Date.now();
const gray = new Uint8ClampedArray(sheet.color.length);
console.log('(sanity) alloc+copy ms', Date.now() - tc, gray.length === sheet.color.length);
