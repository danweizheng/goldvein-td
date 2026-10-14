/**
 * PNG 编解码器自检（`tools/art/png.ts`）。
 *
 * 为什么值得单测：接触表 PNG 是**主策划目视验收的唯一依据**，
 * 而 PNG 编码器是手写的（`package.json` 冻结，不能上 pngjs）。
 * 编码器一旦写错，验收物就是一张打不开的图 —— 这条通路必须有门禁。
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { chunk, crc32, decodePng, encodePng } from '../../tools/art/png';

function makePattern(width: number, height: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      px[i] = (x * 17 + y * 3) % 256;
      px[i + 1] = (x * 5 + y * 29) % 256;
      px[i + 2] = x === 0 && y === 0 ? 0 : 255;
      px[i + 3] = (x + y) % 7 === 0 ? 0 : 255;
    }
  }
  return px;
}

describe('crc32', () => {
  it('已知向量：IEND 与 123456789', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('空输入为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodePng / decodePng', () => {
  it('17x13 图案可无损回环', () => {
    const px = makePattern(17, 13);
    const png = encodePng(px, 17, 13);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(17);
    expect(decoded.height).toBe(13);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(px));
  });

  it('1x1 也可回环', () => {
    const px = new Uint8ClampedArray([1, 2, 3, 4]);
    const decoded = decodePng(encodePng(px, 1, 1));
    expect(Array.from(decoded.rgba)).toEqual([1, 2, 3, 4]);
  });

  it('PNG 结构：签名 / IHDR / IEND 位置正确', () => {
    const png = encodePng(makePattern(4, 4), 4, 4);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR 长度 = 13
    expect([png[8], png[9], png[10], png[11]]).toEqual([0, 0, 0, 13]);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    // IEND + 其 CRC 收尾
    const tail = png.subarray(png.length - 12);
    expect(String.fromCharCode(...tail.subarray(4, 8))).toBe('IEND');
    expect(tail.length).toBe(12);
    // 编码器输出必须是"压缩过"的：整块纯色图应该远小于原始体积
    const flat = new Uint8ClampedArray(64 * 64 * 4).fill(200);
    expect(encodePng(flat, 64, 64).length).toBeLessThan(flat.length);
  });

  it('CRC 被篡改时必须报错（而不是静默给出坏图）', () => {
    const png = encodePng(makePattern(8, 8), 8, 8);
    const broken = png.slice();
    // 找到 IDAT 数据区并翻一个字节
    const idatIndex = broken.findIndex(
      (_, i) =>
        i + 4 < broken.length &&
        String.fromCharCode(broken[i]!, broken[i + 1]!, broken[i + 2]!, broken[i + 3]!) === 'IDAT',
    );
    expect(idatIndex).toBeGreaterThan(0);
    broken[idatIndex + 8] = broken[idatIndex + 8]! ^ 0xff;
    expect(() => decodePng(broken)).toThrow(/CRC/);
  });

  it('非法输入必须抛错', () => {
    expect(() => encodePng(new Uint8ClampedArray(12), 2, 2)).toThrow(/长度/);
    expect(() => encodePng(new Uint8ClampedArray(4), 0, 4)).toThrow(/正整数/);
    expect(() => decodePng(new Uint8Array(3))).toThrow();
    expect(() => decodePng(new Uint8Array(32))).toThrow(/签名/);
  });

  it('filter 0–4 都能被正确还原', () => {
    // 手工构造 3x2 的 RGBA 图，逐行用不同 filter 编码
    const width = 3;
    const height = 5;
    const src = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 200, // row0
      11, 21, 31, 255, 41, 51, 61, 255, 71, 81, 91, 200, // row1
      12, 22, 32, 255, 42, 52, 62, 255, 72, 82, 92, 200, // row2
      13, 23, 33, 255, 43, 53, 63, 255, 73, 83, 93, 200, // row3
      14, 24, 34, 255, 44, 54, 64, 255, 74, 84, 94, 200, // row4
    ]);
    const bpp = 4;
    const stride = width * bpp;
    const raw = new Uint8Array((stride + 1) * height);
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    for (let y = 0; y < height; y++) {
      const filter = y; // 行 0..4 分别用 filter None/Sub/Up/Average/Paeth
      raw[y * (stride + 1)] = filter;
      for (let x = 0; x < stride; x++) {
        const cur = src[y * stride + x]!;
        const a = x >= bpp ? src[y * stride + x - bpp]! : 0;
        const b = y > 0 ? src[(y - 1) * stride + x]! : 0;
        const c = y > 0 && x >= bpp ? src[(y - 1) * stride + x - bpp]! : 0;
        let encoded: number;
        switch (filter) {
          case 0:
            encoded = cur;
            break;
          case 1:
            encoded = cur - a;
            break;
          case 2:
            encoded = cur - b;
            break;
          case 3:
            encoded = cur - ((a + b) >> 1);
            break;
          default:
            encoded = cur - paeth(a, b, c);
            break;
        }
        raw[y * (stride + 1) + 1 + x] = encoded & 0xff;
      }
    }
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xff;
    ihdr[1] = (width >>> 16) & 0xff;
    ihdr[2] = (width >>> 8) & 0xff;
    ihdr[3] = width & 0xff;
    ihdr[4] = (height >>> 24) & 0xff;
    ihdr[5] = (height >>> 16) & 0xff;
    ihdr[6] = (height >>> 8) & 0xff;
    ihdr[7] = height & 0xff;
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(chunk('IHDR', ihdr)),
      Buffer.from(chunk('IDAT', new Uint8Array(deflateSync(raw)))),
      Buffer.from(chunk('IEND', new Uint8Array(0))),
    ]);
    const decoded = decodePng(new Uint8Array(png));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(src));
  });
});
