/**
 * **通道隔离测试**（AGENTS.md 铁律 8：门禁必须能证明它没测到什么）。
 *
 * ## 为什么单独有这个文件
 * 第一版验收里有一条断言「不同护甲可区分」，算的是**整只精灵**的像素差
 * （219–375px），全绿 —— 但那些差异**全部来自本体形状**，护甲通道是否有效
 * 根本没被验证。主策划逐像素复核时用错了采样区（帧外圈 2px 矩形框，
 * 而精灵本体在帧中央，该框内 0 个实体像素），量出"护甲贡献 0"。
 * 两边都错在同一个地方：**采样区不是通道真正所在的区域**。
 *
 * 这个文件把每个通道的采样区**显式定义**出来，并配三条对照：
 *
 * | 对照 | 构造 | 必须 |
 * |---|---|---|
 * | 负对照 | 边框相同、本体内部不同（同剪影的两个 id） | 环带差异 **== 0** |
 * | 正对照 | 同一本体、只换护甲 | 环带差异 **> 0** |
 * | 区域敏感对照 | 故意用错的区域（帧最低 6 行 / 帧外圈框） | 差异 **≈ 0**（证明"区域选错会量到 0"，而不是通道不存在） |
 *
 * > 没有对照的断言，无法区分"通过"与"没测到"。
 */
import { describe, expect, it } from 'vitest';

import enemiesJson from '../../src/data/enemies.json';
import unitsJson from '../../src/data/units.json';
import {
  armorFingerprint,
  armorMatrix,
  armorRegion,
  cornerZone,
  diffInRegion,
  diffWholeFrame,
  findSameSilhouettePair,
  flyingReport,
  flyingZones,
  inkIn,
  radialProfile,
  ringOf,
  unionRing,
} from '../../src/art/audit';
import { normalizeContent, type ArtContentInput, type EnemyArtInput, type UnitArtInput } from '../../src/art/content';
import { ARMOR_ORDER, luma, resolveArmor } from '../../src/art/palette';
import { enemyBodyPlan, renderEnemyFrame } from '../../src/art/procedural';
import { ARMOR_RING_INNER, ARMOR_RING_OUTER, distanceBand, Mask } from '../../src/art/shapes';

const content: ArtContentInput = normalizeContent({
  units: unitsJson as unknown as UnitArtInput[],
  enemies: enemiesJson as unknown as EnemyArtInput[],
});

const probe = (patch: Partial<EnemyArtInput>): EnemyArtInput => ({
  id: 'armor_probe',
  armorType: 'medium',
  flying: false,
  isBoss: false,
  stealResist: 0,
  ...patch,
});

// ---------------------------------------------------------------------------
// 1) 护甲通道：只在外圈环带里测
// ---------------------------------------------------------------------------

describe('护甲通道隔离（采样区 = 距离本体 [2,5] 的环带 ∪ 四角刻痕区）', () => {
  it('环带确实存在（不是空区域）—— 否则下面所有断言都是空断言', () => {
    const band = ringOf(probe({}));
    const total = band.count();
    console.log('[armor] 环带像素总数 =', total, `（距离 ${ARMOR_RING_INNER}..${ARMOR_RING_OUTER}）`);
    // 若环带为空，下面的 diff 会恒为 0 —— 这条断言就是"门禁本身有效"的证明
    expect(total).toBeGreaterThan(200);
  });

  it('5 种护甲的结构指纹（径向剖面 + 四角刻痕）两两不同 —— 纯结构证据，与颜色无关', () => {
    const fingerprints = new Map<string, string>();
    for (const armor of ARMOR_ORDER) {
      const fp = armorFingerprint(probe({ armorType: armor }));
      console.log(`[armor] ${armor.padEnd(10)} 结构指纹 = ${fp}`);
      fingerprints.set(armor, fp);
    }
    // ⚠️ 必须并上四角刻痕：divine 的**环带剖面与 heavy 逐位相同**（都是 2px 实线环），
    //    只用剖面会得 4 种指纹、掩盖掉 divine 真正多出来的通道。
    expect(new Set([...fingerprints.values()]).size).toBe(ARMOR_ORDER.length);
    // 单独把这条事实钉住，防止将来有人"简化"掉四角
    expect(radialProfile(probe({ armorType: 'divine' }))).toEqual(radialProfile(probe({ armorType: 'heavy' })));
  });

  it('light 是虚线（有断口）、medium 是实线 —— 用"最内圈的断续率"证明，不靠感觉', () => {
    // 只看**距离恰好为 2** 的那一圈（5 种护甲都有这一圈，共 88 px）
    const innerRingRatio = (armor: string): number => {
      const enemy = probe({ armorType: armor });
      const plan = enemyBodyPlan(enemy);
      const frame = renderEnemyFrame(enemy, 'idle');
      const inner = distanceBand(plan.body, ARMOR_RING_INNER, ARMOR_RING_INNER);
      let ink = 0;
      let total = 0;
      for (let y = 0; y < inner.height; y++) {
        for (let x = 0; x < inner.width; x++) {
          if (!inner.get(x, y)) continue;
          total++;
          if (frame.pixels[(y * inner.width + x) * 4 + 3]! > 0) ink++;
        }
      }
      expect(total, '距离 2 的那一圈不能为空，否则本断言是空的').toBeGreaterThan(60);
      return ink / total;
    };
    const light = innerRingRatio('light');
    const medium = innerRingRatio('medium');
    const heavy = innerRingRatio('heavy');
    console.log(`[armor] 最内圈上色率 light=${light.toFixed(2)} medium=${medium.toFixed(2)} heavy=${heavy.toFixed(2)}`);
    expect(medium).toBeGreaterThan(0.95);
    expect(heavy).toBeGreaterThan(0.95);
    expect(light).toBeLessThan(0.75);
    expect(medium - light).toBeGreaterThan(0.25);
  });

  it('逐对隔离矩阵：环带内灰度差异 ≥ 60px（10 对全覆盖）', () => {
    const rows = armorMatrix('armor_probe', ARMOR_ORDER);
    console.log('[armor] pair                      armorGray armorCvd armorAlpha wholeGray');
    for (const r of rows) {
      console.log(
        `[armor] ${(r.a + ' vs ' + r.b).padEnd(24)} ${String(r.ringGray).padStart(8)} ${String(r.ringCvd).padStart(8)} ${String(r.ringAlpha).padStart(10)} ${String(r.wholeGray).padStart(9)}`,
      );
    }
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(r.ringGray, `${r.a} vs ${r.b} 环带灰度差异`).toBeGreaterThanOrEqual(60);
      expect(r.ringCvd, `${r.a} vs ${r.b} 环带色盲差异`).toBeGreaterThanOrEqual(60);
    }
  });

  it('heavy 与 divine 是唯一"剪影相同"的一对：必须靠颜色 + 四角刻痕区分', () => {
    const rows = armorMatrix('armor_probe', ARMOR_ORDER);
    const hd = rows.find((r) => r.a === 'heavy' && r.b === 'divine')!;
    console.log(`[armor] heavy vs divine: armorAlpha=${hd.ringAlpha} armorGray=${hd.ringGray}`);
    // 两者都是 2px 实线环 → 环带内剪影仅差 divine 的四角金刻痕
    expect(hd.ringGray).toBeGreaterThanOrEqual(60);
    // 颜色也要能分开（亮度差 137），这是"冗余通道"，不是主通道
    expect(Math.abs(luma(resolveArmor('heavy').color) - luma(resolveArmor('divine').color))).toBeGreaterThan(60);
  });

  it('真实数据：thug / heavy_brute / armored_car 的护甲在**并集环带**内可区分', () => {
    const byId = new Map(content.enemies.map((e) => [e.id, e]));
    const pairs: [string, string][] = [
      ['thug', 'heavy_brute'],
      ['thug', 'armored_car'],
      ['heavy_brute', 'armored_car'],
      ['merchant_lock', 'temple_guard'],
      ['bat', 'armored_car'],
    ];
    for (const [idA, idB] of pairs) {
      const a = byId.get(idA)!;
      const b = byId.get(idB)!;
      const fa = renderEnemyFrame(a, 'idle');
      const fb = renderEnemyFrame(b, 'idle');
      const region = unionRing(a, b);
      const g = diffInRegion(fa, fb, region, 'gray');
      const alpha = diffInRegion(fa, fb, region, 'alpha');
      console.log(`[armor:real] ${idA} vs ${idB}: armorGray=${g} armorAlpha=${alpha}（并集环带 ${region.count()} px）`);
      expect(g, `${idA} vs ${idB} 护甲区灰度差异`).toBeGreaterThanOrEqual(60);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) 对照：证明上面的断言**不是空的**
// ---------------------------------------------------------------------------

describe('对照（没有对照的断言无法区分"通过"与"没测到"）', () => {
  it('负对照：边框相同、本体内部不同 → 环带差异必须为 0，而整帧差异必须 > 0', () => {
    const pair = findSameSilhouettePair('medium');
    expect(pair, '没有找到同剪影的对照对 → 负对照本身失效').not.toBeNull();
    const a: EnemyArtInput = { id: pair!.a, armorType: 'medium', flying: false, isBoss: false, stealResist: 0 };
    const b: EnemyArtInput = { id: pair!.b, armorType: 'medium', flying: false, isBoss: false, stealResist: 0 };
    const fa = renderEnemyFrame(a, 'idle');
    const fb = renderEnemyFrame(b, 'idle');
    const sameSilhouette =
      Array.from(enemyBodyPlan(a).body.bits).join('') === Array.from(enemyBodyPlan(b).body.bits).join('');
    expect(sameSilhouette, '负对照要求两者剪影逐位相同').toBe(true);

    const whole = diffWholeFrame(fa, fb, 'gray');
    const inRegion = diffInRegion(fa, fb, armorRegion(a), 'gray');
    console.log(`[control] ${pair!.a} vs ${pair!.b}: 整帧灰度差异=${whole}（本体内部装饰不同）环带内=${inRegion}（边框相同）`);
    expect(whole, '整帧必须有差异，否则这个负对照没意义').toBeGreaterThan(0);
    expect(inRegion, '环带内必须为 0：否则说明环带里混进了本体/装饰像素').toBe(0);
  });

  it('正对照：同一本体只换护甲 → 环带差异必须 > 0', () => {
    const a = renderEnemyFrame(probe({ armorType: 'medium' }), 'idle');
    const b = renderEnemyFrame(probe({ armorType: 'fortified' }), 'idle');
    const region = armorRegion(probe({}));
    const g = diffInRegion(a, b, region, 'gray');
    console.log('[control] medium vs fortified 环带灰度差异 =', g);
    expect(g).toBeGreaterThan(0);
  });

  it('区域敏感对照：用错的区域量护甲会量到 0 —— 这正是上一版翻车的原因', () => {
    const byId = new Map(content.enemies.map((e) => [e.id, e]));
    const a = byId.get('thug')!;
    const b = byId.get('heavy_brute')!;
    const fa = renderEnemyFrame(a, 'idle');
    const fb = renderEnemyFrame(b, 'idle');

    // 错误区域 1：帧外圈 2px 矩形框（主策划的采样区）
    const box = new Mask(32, 32);
    box.setRect(0, 0, 32, 2);
    box.setRect(0, 30, 32, 2);
    box.setRect(0, 0, 2, 32);
    box.setRect(30, 0, 2, 32);
    let boxInk = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) if (box.get(x, y) && fa.pixels[(y * 32 + x) * 4 + 3]! > 0) boxInk++;
    }
    const inBox = diffInRegion(fa, fb, box, 'gray');
    console.log(`[control] 帧外圈 2px 框内：thug 有 ${boxInk} px 实体，两敌差异 = ${inBox}`);
    expect(inBox, '用错的区域必须量到 0 —— 这就是"区域选错"的证据').toBe(0);

    // 正确区域：环带并集
    const correct = diffInRegion(fa, fb, unionRing(a, b), 'gray');
    console.log(`[control] 正确区域（环带并集）内差异 = ${correct}`);
    expect(correct).toBeGreaterThan(60);
  });

  it('区域敏感对照：四角刻痕不在环带里，必须并进护甲采样区', () => {
    const e = probe({ armorType: 'divine' });
    const corners = cornerZone(32);
    const ringOnly = diffInRegion(
      renderEnemyFrame(e, 'idle'),
      renderEnemyFrame(probe({ armorType: 'heavy' }), 'idle'),
      ringOf(e),
      'alpha',
    );
    const withCorners = diffInRegion(
      renderEnemyFrame(e, 'idle'),
      renderEnemyFrame(probe({ armorType: 'heavy' }), 'idle'),
      armorRegion(e),
      'alpha',
    );
    console.log(
      `[control] heavy vs divine 剪影差异：只看环带=${ringOnly}，并上四角=${withCorners}（四角区 ${corners.count()} px）`,
    );
    expect(ringOnly).toBe(0);
    expect(withCorners).toBeGreaterThan(ringOnly);
  });
});

// ---------------------------------------------------------------------------
// 3) 飞行通道：底部留白带 + 翼痕带
// ---------------------------------------------------------------------------

describe('飞行通道隔离（阴影留白带 + 翼痕带 + 中线跨度）', () => {
  const fly = flyingReport('flying_probe');

  it('① 阴影留白：飞行态机身下方 2 行，地面态有实体、飞行态必须空', () => {
    console.log(
      `[flying] 机身下2行(y${fly.airBodyBottom + 1}..${fly.airBodyBottom + 2}): 地面态 ${fly.gapRowGroundInk}px → 飞行态 ${fly.gapRowAirInk}px，差异 ${fly.gapRowDiff}px`,
    );
    expect(fly.airBodyBottom).toBe(fly.groundBodyBottom - 2);
    expect(fly.gapRowGroundInk).toBeGreaterThan(10);
    expect(fly.gapRowDiff).toBeGreaterThanOrEqual(10);
  });

  it('② 翼痕：把护甲环向外顶出，地面态本体包围盒之外出现实体', () => {
    console.log(
      `[flying] 翼痕带: 地面态 ${fly.wingZoneGroundInk}px → 飞行态 ${fly.wingZoneAirInk}px，差异 ${fly.wingZoneDiff}px`,
    );
    expect(fly.wingZoneDiff).toBeGreaterThanOrEqual(12);
    expect(fly.wingZoneAirInk).toBeGreaterThan(fly.wingZoneGroundInk * 2);
  });

  it('③ 中线跨度：飞行态明显更宽（两侧各约 3px）', () => {
    console.log(
      `[flying] y=${fly.wingRow} 跨度: 地面态 ${fly.wingRowSpanGround}px → 飞行态 ${fly.wingRowSpanAir}px`,
    );
    expect(fly.wingRowSpanAir - fly.wingRowSpanGround).toBeGreaterThanOrEqual(4);
  });

  it('④ 质心抬高 ≥ 1.5px（2px 留白的独立证据）', () => {
    console.log(`[flying] 质心抬高 = ${fly.centroidLift.toFixed(2)}px`);
    expect(fly.centroidLift).toBeGreaterThanOrEqual(1.5);
  });

  it('区域敏感对照：帧最低 6 行几乎量不到飞行差异 —— 说明"区域选错会量到 0"', () => {
    const ground = probe({ id: 'flying_probe' });
    const air: EnemyArtInput = { ...ground, flying: true };
    const fg = renderEnemyFrame(ground, 'idle');
    const fa = renderEnemyFrame(air, 'idle');
    const band = new Mask(32, 32);
    band.setRect(0, 26, 32, 6);
    const bottom = diffInRegion(fg, fa, band, 'alpha');
    console.log(`[flying] 帧最低 6 行差异 = ${bottom}px（两种状态的机身都不在那里）`);
    expect(bottom).toBeLessThan(10);
    // 而整帧差异很大 —— 证明"整体差异大"完全可能由无关信号主导
    expect(fly.wholeDiff).toBeGreaterThan(bottom * 10);
  });

  it('真实数据：每个飞行敌人的翼痕带实体都比地面态多（含 96 帧 BOSS）', () => {
    const flying = content.enemies.filter((e) => e.flying);
    expect(flying.map((e) => e.id)).toEqual(['bat', 'ascendant']);
    for (const e of flying) {
      const z = flyingZones(e);
      const fg = renderEnemyFrame(z.ground, 'idle');
      const fa = renderEnemyFrame(z.air, 'idle');
      const gInk = inkIn(fg, z.wing);
      const aInk = inkIn(fa, z.wing);
      const gapG = inkIn(fg, z.gap);
      const gapA = inkIn(fa, z.gap);
      console.log(
        `[flying:real] ${e.id}(${z.wing.width}px 帧): 翼痕带 ${gInk} → ${aInk} px；留白带 ${gapG} → ${gapA} px`,
      );
      expect(aInk, `${e.id} 翼痕带应有更多实体`).toBeGreaterThan(gInk);
      expect(gapG, `${e.id} 留白带地面态应有实体`).toBeGreaterThan(0);
      // ⚠️ 不要用"整帧左右跨度"测 ascendant：四角金刻痕把跨度顶满到 96px，
      //    地面态与飞行态都是 96 —— 那又是"区域选错"。
      expect(gapA, `${e.id} 留白带飞行态应更少`).toBeLessThan(gapG);
    }
  });
});
