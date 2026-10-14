/**
 * 零依赖 PNG 编解码器（`node:zlib` + 手写 CRC32）。
 *
 * 为什么手写：`package.json` 已冻结，不能加 `pngjs` / `sharp`。
 * 而方案 §4 要求接触表必须落盘成 PNG（**这是主策划目视验收的唯一依据**），
 * 所以这个编码器是硬需求，不是"顺手实现"。
 *
 * - 编码：8 位 RGBA（color type 6），逐行 filter=0（None，整块覆盖、无抗锯齿，
 *   不做 Sub/Up 之类的行内预测，保证输出与输入**逐字节一致**）。
 * - 解码：**完整实现** 5 种 filter（0–4），用于测试回环与 CRC 自检。
 *
 * ⚠️ 仅 Node 侧工具使用（`tools/art/**`）。
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32（PNG 多项式 0xEDB88320），返回无符号 32 位。 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC（CRC 覆盖"类型 + 数据"）。 */
export function chunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error(`PNG chunk 类型必须是 4 字节：${type}`);
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeUint32BE(out, 8 + data.length, crc32(crcInput));
  return out;
}

/**
 * 把 8 位 RGBA 像素编码成 PNG。
 *
 * @param pixels 行优先 RGBA，长度必须等于 `width * height * 4`
 * @param width  宽（正整数）
 * @param height 高（正整数）
 */
export function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG 尺寸必须是正整数，收到 ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`PNG 像素缓冲长度不符：期望 ${expected}，收到 ${pixels.length}`);
  }

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter = None
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const chunks = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 解码结果。 */
export interface DecodedPng {
  width: number;
  height: number;
  /** 行优先 RGBA。 */
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG（8 位；color type 6 RGBA / 2 RGB；逐 chunk 校验 CRC；支持 filter 0–4）。
 * 任何结构问题都抛 `Error`（测试用它做负向断言）。
 */
export function decodePng(png: Uint8Array): DecodedPng {
  if (png.length < 8) throw new Error('PNG 太短');
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIGNATURE[i]) throw new Error('PNG 签名不匹配');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idatParts: Uint8Array[] = [];

  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = readUint32BE(png, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error('PNG chunk 越界');
    const type =
      String.fromCharCode(png[typeStart]!, png[typeStart + 1]!, png[typeStart + 2]!, png[typeStart + 3]!);
    const crcExpected = readUint32BE(png, dataEnd);
    const crcActual = crc32(png.subarray(typeStart, dataEnd));
    if (crcExpected !== crcActual) {
      throw new Error(`PNG chunk ${type} CRC 校验失败：期望 ${crcExpected}，实得 ${crcActual}`);
    }
    const data = png.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (length !== 13) throw new Error('IHDR 长度必须是 13');
      width = readUint32BE(data, 0);
      height = readUint32BE(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
    }
    offset = dataEnd + 4;
  }

  if (!sawIhdr) throw new Error('PNG 缺少 IHDR');
  if (!sawIend) throw new Error('PNG 缺少 IEND');
  if (bitDepth !== 8) throw new Error(`仅支持 8 位色深，收到 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  if (colorType !== 6 && colorType !== 2) throw new Error(`仅支持 color type 6/2，收到 ${colorType}`);
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸非法');

  let total = 0;
  for (const part of idatParts) total += part.length;
  const compressed = new Uint8Array(total);
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 解压后数据不足');

  const unfiltered = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x]!;
      const a = x >= channels ? unfiltered[dst + x - channels]! : 0;
      const b = y > 0 ? unfiltered[prev + x]! : 0;
      const c = y > 0 && x >= channels ? unfiltered[prev + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`未知 PNG filter 类型 ${filter}`);
      }
      unfiltered[dst + x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < unfiltered.length; i += channels, j += 4) {
    rgba[j] = unfiltered[i]!;
    rgba[j + 1] = unfiltered[i + 1]!;
    rgba[j + 2] = unfiltered[i + 2]!;
    rgba[j + 3] = channels === 4 ? unfiltered[i + 3]! : 255;
  }
  return { width, height, rgba };
}
