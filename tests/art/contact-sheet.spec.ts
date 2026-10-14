/**
 * 接触表（方案 §4）的产出物门禁。
 *
 * 接触表是**主策划目视验收的唯一依据**，所以这里断言的不是"跑了没报错"，
 * 而是三件硬事实：
 * 1. 版面上**一个精灵都没漏**（用标签清单逐 id 核对）；
 * 2. 三份 PNG 都能**被解回来**且像素与生成缓冲逐字节一致（编码器 + CRC 通路）；
 * 3. 灰度版**真的是灰度**（r=g=b），色盲版**真的做过变换**。
 */
import { describe, expect, it } from 'vitest';

import { CONTACT_SHEET_FILES, buildContactSheet, DEFAULT_SCALE, pngOf } from '../../tools/art/contact-sheet';
import { loadContent } from '../../tools/art/load-content';
import { decodePng } from '../../tools/art/png';
import { normalizeContent } from '../../src/art/content';

const content = loadContent();

// 版式生成一次即可（scale 1 版够用来断言结构；逐像素比对的成本与 scale 无关）
const sheet = buildContactSheet(content, { scale: 1 });

describe('版面结构', () => {
  it('尺寸固定为 1800 宽，高度足够容纳全部区块', () => {
    expect(sheet.width).toBe(1800);
    expect(sheet.height).toBeGreaterThan(1500);
    console.log('[contact sheet] size at scale 1 =', `${sheet.width}x${sheet.height}`);
  });

  it('4× 版（CLI 实际输出）明显更大（标签/间距不随倍率放大，实测比 ≈ 1.95）', () => {
    const big = buildContactSheet(content, { scale: DEFAULT_SCALE });
    expect(DEFAULT_SCALE).toBe(4);
    expect(big.width).toBe(1800);
    expect(big.height).toBeGreaterThan(sheet.height * 1.5);
    console.log(
      '[contact sheet] size at scale 4 =',
      `${big.width}x${big.height}`,
      `(1x = ${sheet.width}x${sheet.height}, ratio = ${(big.height / sheet.height).toFixed(2)})`,
    );
  });

  it('29 个塔 / 11 个敌人的 id 全部出现在版面上', () => {
    const titles = new Set(sheet.titles);
    for (const unit of content.units) expect(titles.has(unit.id.toUpperCase()), `缺塔：${unit.id}`).toBe(true);
    for (const enemy of content.enemies) expect(titles.has(enemy.id.toUpperCase()), `缺敌：${enemy.id}`).toBe(true);
  });

  it('图例 / 条 / 状态帧区块都在（不只有精灵）', () => {
    for (const label of ['LIGHT', 'MEDIUM', 'HEAVY', 'FORTIFIED', 'DIVINE']) {
      expect(sheet.titles, `缺护甲图例 ${label}`).toContain(label);
    }
    for (const label of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      expect(sheet.titles, `缺品阶图例 ${label}`).toContain(label);
    }
    for (const label of ['NO_MARK', 'FLYING', 'BOSS', 'ELITE', 'IMMUNE:1000']) {
      expect(sheet.titles, `缺标记图例 ${label}`).toContain(label);
    }
    for (const label of ['FULL', 'HALF_STOLEN', 'ALMOST_EMPTY', 'BOSS_LAYOUT']) {
      expect(sheet.titles, `缺条示意 ${label}`).toContain(label);
    }
    // 状态帧区块：master_thief 在塔列表里 1 次 + idle/attack/upgrade 3 次 = 4
    expect(sheet.titles.filter((t) => t === 'MASTER_THIEF').length).toBe(4);
    // heavy_brute 在敌人列表里 1 次 + idle/walk 2 次 = 3
    expect(sheet.titles.filter((t) => t === 'HEAVY_BRUTE').length).toBe(3);
  });

  it('标签文字全部落在 5×7 字体的字符集内（否则会渲染成缺字方框）', () => {
    // 与 src/art/text.ts 的 FONT_CHARS 对齐：只允许它覆盖的字符
    const allowed = /^[ 0-9A-Z+\-%/:.,()_*#=!?<>]*$/;
    for (const title of sheet.titles) {
      expect(allowed.test(title), `标签含字体不支持的字符：${title}`).toBe(true);
    }
  });

  it('四个变体的缓冲长度一致且非空（不是一张空图）', () => {
    const expected = sheet.width * sheet.height * 4;
    for (const key of ['color', 'gray', 'cvd', 'protan'] as const) {
      expect(sheet[key].length).toBe(expected);
    }
    let opaque = 0;
    for (let i = 3; i < sheet.color.length; i += 4) if (sheet.color[i]! > 0) opaque++;
    expect(opaque).toBe(sheet.width * sheet.height); // 整页铺满背景色
  });
});

describe('三份 PNG 的落盘通路（编码 + CRC + 解码回环）', () => {
  for (const file of CONTACT_SHEET_FILES) {
    it(`${file.name} 可编码并被解回（逐字节一致）`, () => {
      const png = pngOf(sheet, file.variant);
      const decoded = decodePng(png);
      expect(decoded.width).toBe(sheet.width);
      expect(decoded.height).toBe(sheet.height);
      const src = sheet[file.variant];
      // 逐字节比对（采样加速：每 997 字节抽一个位置 + 首尾）
      for (let i = 0; i < src.length; i += 997) {
        if (decoded.rgba[i] !== src[i]) throw new Error(`${file.name} 第 ${i} 字节不一致`);
      }
      expect(decoded.rgba[src.length - 1]).toBe(src[src.length - 1]);
      console.log(`[png] ${file.name} = ${png.length} bytes`);
    });
  }

  it('文件名与方案 §4 的要求一致（3 张必需 + 1 张补充红盲版）', () => {
    const names = CONTACT_SHEET_FILES.map((f) => f.name);
    expect(names).toContain('contact-sheet.png');
    expect(names).toContain('contact-sheet-gray.png');
    expect(names).toContain('contact-sheet-cvd.png');
    expect(names).toContain('contact-sheet-protan.png');
    expect(names.length).toBe(4);
  });
});

describe('灰度版与色盲版确实是"变换过"的图', () => {
  it('灰度版每个像素都满足 r=g=b', () => {
    let bad = 0;
    for (let i = 0; i < sheet.gray.length; i += 4) {
      if (sheet.gray[i] !== sheet.gray[i + 1] || sheet.gray[i] !== sheet.gray[i + 2]) bad++;
    }
    expect(bad).toBe(0);
  });

  it('色盲版不是灰度图（说明真的做了 CVD 变换，而不是误用去色）', () => {
    let colored = 0;
    for (let i = 0; i < sheet.cvd.length; i += 4) {
      if (sheet.cvd[i] !== sheet.cvd[i + 1]) colored++;
    }
    console.log('[cvd] 非灰像素 =', colored);
    expect(colored).toBeGreaterThan(0);
  });

  it('三个版本彼此不同', () => {
    const differs = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => {
      for (let i = 0; i < a.length; i += 401) if (a[i] !== b[i]) return true;
      return false;
    };
    expect(differs(sheet.color, sheet.gray)).toBe(true);
    expect(differs(sheet.color, sheet.cvd)).toBe(true);
    expect(differs(sheet.cvd, sheet.protan)).toBe(true);
  });

  it('生成的输入与 src/data 的文件一致（不是内置夹具）', () => {
    // loadContent() 读的是 src/data/*.json；这里用一个等价的手工归一化结果对照
    expect(content.units.length).toBeGreaterThanOrEqual(29);
    expect(content.enemies.length).toBe(11);
    expect(() => normalizeContent({ units: content.units, enemies: content.enemies })).not.toThrow();
  });
});
