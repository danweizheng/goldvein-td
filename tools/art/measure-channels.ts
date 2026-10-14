/**
 * 通道审计 CLI —— 把"每个编码通道到底贡献多少像素"打印成表。
 *
 * 这是对主策划质询（"护甲边框通道贡献 0 像素"）的直接回应工具，
 * 也是 `tests/art/channels.spec.ts` 里那批断言的同一个实现（共用 `src/art/audit.ts`）。
 *
 * 运行：`& $node $pnpm exec tsx tools/art/measure-channels.ts`
 */
import { ARMOR_ORDER, type ArmorType } from '../../src/art/palette';
import {
  armorMatrix,
  armorRegion,
  diffInRegion,
  diffWholeFrame,
  findSameSilhouettePair,
  flyingReport,
  maskToAscii,
  radialProfile,
  ringOf,
  ringInkCount,
  unionRing,
} from '../../src/art/audit';
import { enemyBodyPlan, renderEnemyFrame } from '../../src/art/procedural';
import type { EnemyArtInput } from '../../src/art/content';
import { bossRingMask, padlockMask, starMask } from '../../src/art/marks';
import { ARMOR_RING_INNER, ARMOR_RING_OUTER, chebyshevDistance, Mask } from '../../src/art/shapes';

const probe = (patch: Partial<EnemyArtInput>): EnemyArtInput => ({
  id: 'armor_probe',
  armorType: 'medium',
  flying: false,
  isBoss: false,
  stealResist: 0,
  ...patch,
});

console.log('========================================================================');
console.log('1) 护甲通道隔离测量（同一本体 probe，只换 armorType）');
console.log(`   环带定义 = 到本体的切比雪夫距离 ∈ [${ARMOR_RING_INNER}, ${ARMOR_RING_OUTER}]`);
console.log('========================================================================');
const band = ringOf(probe({}));
console.log(`   环带像素总数 = ${band.count()}（32×32 帧，本体半径 8）`);
console.log('');
console.log('   armor        环带内上色像素   径向剖面（距离:像素数）');
for (const armor of ARMOR_ORDER) {
  const e = probe({ armorType: armor });
  const profile = radialProfile(e);
  const parts = Object.keys(profile)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => `${d}:${profile[d]}`)
    .join('  ');
  console.log(`   ${armor.padEnd(12)} ${String(ringInkCount(e)).padStart(4)}          ${parts}`);
}
console.log('');
console.log('   逐对矩阵（armorGray = 护甲区(环带∪四角)内灰度可见差异；wholeGray = 整帧差异，仅对照）');
console.log('   pair                     armorGray armorCvd armorAlpha wholeGray');
for (const row of armorMatrix('armor_probe', ARMOR_ORDER)) {
  console.log(
    `   ${(row.a + ' vs ' + row.b).padEnd(24)} ${String(row.ringGray).padStart(8)} ${String(row.ringCvd).padStart(8)} ${String(row.ringAlpha).padStart(10)} ${String(row.wholeGray).padStart(9)}`,
  );
}

console.log('');
console.log('   armorAlpha = 0 的一对（heavy vs divine）剪影相同（都是 2px 环），');
console.log('   区分靠：颜色（heavy 亮度 103 vs divine 240，Δ=137）+ divine 的四角金刻痕。');

console.log('');
console.log('   —— 环带 ASCII（# = 该处有边框像素，. = 环带内空白，空格 = 环带外）——');
for (const armor of ['light', 'medium', 'heavy', 'fortified'] as const) {
  const e = probe({ armorType: armor });
  const frame = renderEnemyFrame(e, 'idle');
  const rows = maskToAscii(ringOf(e), frame).slice(6, 14);
  console.log(`   [${armor}]`);
  for (const row of rows) console.log(`     |${row}|`);
}

console.log('');
console.log('========================================================================');
console.log('2) 负对照：边框相同、本体不同 → 环带差异必须为 0');
console.log('========================================================================');
const ctrl = findSameSilhouettePair('medium');
if (!ctrl) {
  console.log('   !! 没有找到同剪影的对照对（负对照失效）');
} else {
  const a: EnemyArtInput = { id: ctrl.a, armorType: 'medium', flying: false, isBoss: false, stealResist: 0 };
  const b: EnemyArtInput = { id: ctrl.b, armorType: 'medium', flying: false, isBoss: false, stealResist: 0 };
  const fa = renderEnemyFrame(a, 'idle');
  const fb = renderEnemyFrame(b, 'idle');
  const shared = ringOf(a); // 两者剪影相同 → 环带同一位置
  console.log(`   对照 id: ${ctrl.a} vs ${ctrl.b}`);
  console.log(`   剪影是否逐位相同 : ${Array.from(enemyBodyPlan(a).body.bits).join('') === Array.from(enemyBodyPlan(b).body.bits).join('')}`);
  console.log(`   整帧灰度差异     : ${diffWholeFrame(fa, fb, 'gray')}   ← 必须 > 0（本体内部装饰不同）`);
  console.log(`   环带内灰度差异   : ${diffInRegion(fa, fb, shared, 'gray')}   ← 必须 == 0（边框相同）`);
  console.log(`   环带内剪影差异   : ${diffInRegion(fa, fb, shared, 'alpha')}   ← 必须 == 0`);
}
console.log('');
console.log('   正对照：同一 id 换护甲 → 环带差异必须 > 0');
{
  const m = renderEnemyFrame(probe({ armorType: 'medium' }), 'idle');
  const f = renderEnemyFrame(probe({ armorType: 'fortified' }), 'idle');
  console.log(`   medium vs fortified 环带灰度差异 = ${diffInRegion(m, f, band, 'gray')}`);
}

console.log('');
console.log('========================================================================');
console.log('3) 飞行通道分区域测量（阴影留白带 + 翼痕外凸带）');
console.log('========================================================================');
const fly = flyingReport('flying_probe');
console.log(`   帧尺寸                        : ${fly.size}x${fly.size}`);
console.log(`   地面态机身下缘 y              : ${fly.groundBodyBottom}`);
console.log(`   飞行态机身下缘 y              : ${fly.airBodyBottom}   （上移 ${fly.groundBodyBottom - fly.airBodyBottom}px）`);
console.log('');
console.log(`   ① 阴影留白带 = 飞行态机身下 2 行（y ${fly.airBodyBottom + 1}..${fly.airBodyBottom + 2}）`);
console.log(`      地面态在该带有 ${fly.gapRowGroundInk} px 实体，飞行态 ${fly.gapRowAirInk} px  →  剪影差异 ${fly.gapRowDiff} px`);
console.log('');
console.log('   ② 翼痕带 = 地面态本体水平包围盒之外、机身中线 ±2 行');
console.log(`      地面态 ${fly.wingZoneGroundInk} px，飞行态 ${fly.wingZoneAirInk} px  →  剪影差异 ${fly.wingZoneDiff} px`);
console.log(`      即：翼痕把护甲环向外顶出去了 ${fly.wingZoneDiff} px —— 这才是"两侧翼痕"的隔离证据`);
console.log('');
console.log(`   ③ 翼痕行的剪影跨度（y=${fly.wingRow}）`);
console.log(`      地面态 ${fly.wingRowSpanGround} px 宽，飞行态 ${fly.wingRowSpanAir} px 宽  →  飞行态宽 ${fly.wingRowSpanAir - fly.wingRowSpanGround} px（两侧各 ${(fly.wingRowSpanAir - fly.wingRowSpanGround) / 2} px）`);
console.log(`   ④ 质心抬高 ${fly.centroidLift.toFixed(2)} px`);
console.log(`   （对照）整帧剪影差异 ${fly.wholeDiff} px —— 这个数字**不能**用来证明任何单一通道`);
console.log('');
console.log('   ❌ 反面教材：帧最低 6 行的差异');
{
  const g = renderEnemyFrame(probe({ id: 'flying_probe', armorType: 'medium' }), 'idle');
  const a2 = renderEnemyFrame(probe({ id: 'flying_probe', armorType: 'medium', flying: true }), 'idle');
  let n = 0;
  for (let y = g.height - 6; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const i = (y * g.width + x) * 4;
      if ((g.pixels[i + 3]! > 0) !== (a2.pixels[i + 3]! > 0)) n++;
    }
  }
  console.log(`      只有 ${n} px —— 两种状态的机身都不在帧底那 6 行里。`);
  console.log('      这个区域量到接近 0，是**区域选错**，不是"飞行通道不存在"。');
}

console.log('');
console.log('========================================================================');
console.log('4) 主策划的采样区复现（为什么那里会量到 0）');
console.log('========================================================================');
{
  // (a) 帧外圈 2px 矩形框（不是环带）
  const probeIds = ['thug', 'heavy_brute', 'armored_car'] as const;
  const frames = probeIds.map((id) =>
    renderEnemyFrame({ id, armorType: id === 'thug' ? 'light' : id === 'heavy_brute' ? 'heavy' : 'fortified', flying: false, isBoss: false, stealResist: 0 }, 'idle'),
  );
  const box = new Mask(32, 32);
  box.setRect(0, 0, 32, 2);
  box.setRect(0, 30, 32, 2);
  box.setRect(0, 0, 2, 32);
  box.setRect(30, 0, 2, 32);
  console.log('   (a) 「帧外圈 2px 矩形框」内的差异：');
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const g = diffInRegion(frames[i]!, frames[j]!, box, 'gray');
      const a = diffInRegion(frames[i]!, frames[j]!, box, 'alpha');
      const ink = (() => {
        let n = 0;
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (box.get(x, y) && frames[i]!.pixels[(y * 32 + x) * 4 + 3]! > 0) n++;
        return n;
      })();
      console.log(`       ${probeIds[i]} vs ${probeIds[j]}: gray=${g} alpha=${a}  （该框内 ${probeIds[i]} 只有 ${ink} px 实体）`);
    }
  }
  console.log('       → 精灵本体在帧中央（半径 ~8–9，帧 32），外圈 2px 框里几乎全是空的：');
  console.log('         两个都空 → 差异 0。这不是"边框不存在"，是**采样区在精灵之外**。');
  console.log('');
  console.log('   (b) 同一个框内，帧 y=0 那一行的实体像素数：');
  for (let i = 0; i < frames.length; i++) {
    let n = 0;
    for (let x = 0; x < 32; x++) if (frames[i]!.pixels[(0 * 32 + x) * 4 + 3]! > 0) n++;
    console.log(`       ${probeIds[i].padEnd(12)} y=0 实体像素 = ${n}（0 = 顶上那行本来就是空的）`);
  }
  console.log('');
  console.log('   (c) **正确区域**（各对环带的并集）内的差异，同三只敌：');
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const idA = probeIds[i]!;
      const idB = probeIds[j]!;
      const armorOf = (id: string) => (id === 'thug' ? 'light' : id === 'heavy_brute' ? 'heavy' : 'fortified') as ArmorType;
      const ea: EnemyArtInput = { id: idA, armorType: armorOf(idA), flying: false, isBoss: false, stealResist: 0 };
      const eb: EnemyArtInput = { id: idB, armorType: armorOf(idB), flying: false, isBoss: false, stealResist: 0 };
      const region = unionRing(ea, eb);
      const g = diffInRegion(frames[i]!, frames[j]!, region, 'gray');
      const a = diffInRegion(frames[i]!, frames[j]!, region, 'alpha');
      console.log(`       ${idA} vs ${idB}: armorGray=${g} armorAlpha=${a}  （并集环带 ${region.count()} px）`);
    }
  }
}

console.log('');
console.log('========================================================================');
console.log('4) 其余通道（掩码级，供回归对照）');
console.log('========================================================================');
{
  const size = 96;
  const body = enemyBodyPlan({ id: 'boss_probe', armorType: 'medium', flying: true, isBoss: true, stealResist: 0 }).body;
  const dist = chebyshevDistance(body);
  const ring = bossRingMask(dist, size, size, 7, 8);
  console.log(`   BOSS 金环（96 帧）      : ${ring.count()} px，最近距离 7（护甲边框最大 5）`);
}
console.log(`   精英星点 starMask(7)    : ${starMask(7).count()} px`);
console.log(`   挂锁锁身                : ${padlockMask(false).lock.count()} px`);
console.log(`   挂锁 + 斜杠（免疫）     : 斜杠 ${padlockMask(true).slash.count()} px，切在锁身上 ${(() => {
  const { lock, slash } = padlockMask(true);
  let cut = 0;
  for (let i = 0; i < lock.bits.length; i++) if (lock.bits[i] && slash.bits[i]) cut++;
  return cut;
})()} px`);
