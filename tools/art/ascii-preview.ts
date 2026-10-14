/**
 * 精灵的 ASCII 预览（终端）—— **我（agent）看不见 PNG 时的自查手段**，
 * 也是 CI 里"图没画歪"的低成本门禁。
 *
 * 每个像素按"最接近哪个语义色"映射成一个字符：
 *
 * | 字符 | 含义 | | 字符 | 含义 |
 * |---|---|---|---|---|
 * | `.` | 透明 | | `$` | 金（BOSS 环 / 精英星 / 钱包条） |
 * | `@` | 描边墨色 INK | | `=` | 底座 |
 * | `#` | 敌人本体 | | `l/m/H/F/D` | 轻/中/重/城/神圣 护甲色 |
 * | `+` | 本体亮边 | | `T/A/G/R/B/C/W/S/X` | 九大塔系色 |
 * | `*` | 高光（眼 / 齿 / 挂锁） | | `?` | 未分类（说明调色板没覆盖到） |
 *
 * 运行：
 * ```
 * & $node $pnpm exec tsx tools/art/ascii-preview.ts              # 抽查集
 * & $node $pnpm exec tsx tools/art/ascii-preview.ts master_thief # 指定 id
 * ```
 */
import {
  ARMOR_META,
  ENEMY_BODY,
  ENEMY_BODY_HI,
  ENEMY_CORE_DARK,
  GOLD,
  HILIGHT,
  INK,
  LINE_META,
  PLINTH,
  PLINTH_EDGE,
  WALLET_RING,
  WALLET_SLOT,
  type Rgba,
} from '../../src/art/palette';
import { renderEnemyFrame, renderTowerFrame, type SpriteFrame } from '../../src/art/procedural';
import type { EnemyArtInput, UnitArtInput } from '../../src/art/content';
import { loadContent } from './load-content';

interface ColorClass {
  readonly ch: string;
  readonly color: Rgba;
}

const CLASSES: readonly ColorClass[] = [
  { ch: '.', color: [0, 0, 0, 0] },
  { ch: '@', color: INK },
  { ch: '#', color: ENEMY_BODY },
  { ch: '+', color: ENEMY_BODY_HI },
  { ch: '*', color: HILIGHT },
  { ch: '$', color: GOLD },
  { ch: '=', color: PLINTH },
  { ch: '~', color: PLINTH_EDGE },
  { ch: 'n', color: ENEMY_CORE_DARK },
  { ch: 'w', color: WALLET_SLOT },
  { ch: 'r', color: WALLET_RING },
  { ch: 'l', color: ARMOR_META.light.color },
  { ch: 'm', color: ARMOR_META.medium.color },
  { ch: 'H', color: ARMOR_META.heavy.color },
  { ch: 'F', color: ARMOR_META.fortified.color },
  { ch: 'D', color: ARMOR_META.divine.color },
  { ch: 'T', color: LINE_META.thief.color },
  { ch: 'A', color: LINE_META.archer.color },
  { ch: 'G', color: LINE_META.mage.color },
  { ch: 'R', color: LINE_META.drill.color },
  { ch: 'B', color: LINE_META.beauty.color },
  { ch: 'C', color: LINE_META.cannon.color },
  { ch: 'W', color: LINE_META.worker.color },
  { ch: 'S', color: LINE_META.sprite.color },
  { ch: 'X', color: LINE_META.tech.color },
];

function classify(r: number, g: number, b: number, a: number): string {
  if (a === 0) return '.';
  let best = '?';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of CLASSES) {
    const d = Math.abs(r - c.color[0]) + Math.abs(g - c.color[1]) + Math.abs(b - c.color[2]);
    if (d < bestDist) {
      bestDist = d;
      best = c.ch;
    }
  }
  return best;
}

/** 把一帧打成 ASCII 行（每行一个字符串）。 */
export function frameToAscii(frame: SpriteFrame): string[] {
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    let line = '';
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 4;
      line += classify(frame.pixels[i]!, frame.pixels[i + 1]!, frame.pixels[i + 2]!, frame.pixels[i + 3]!);
    }
    rows.push(line);
  }
  return rows;
}

function printFrame(label: string, frame: SpriteFrame): void {
  console.log(`${label}   (${frame.width}x${frame.height}, anchor ${frame.anchorX},${frame.anchorY})`);
  for (const row of frameToAscii(frame)) console.log(`  ${row}`);
  console.log('');
}

function main(): void {
  const content = loadContent();
  const ids = process.argv.slice(2);

  if (ids.length > 0) {
    for (const id of ids) {
      const unit = content.units.find((u) => u.id === id);
      if (unit) {
        printFrame(`TOWER ${id}:idle`, renderTowerFrame(unit, 'idle'));
        continue;
      }
      const enemy = content.enemies.find((e) => e.id === id);
      if (enemy) {
        printFrame(`ENEMY ${id}:idle`, renderEnemyFrame(enemy, 'idle'));
        continue;
      }
      console.log(`!! 未找到 id: ${id}\n`);
    }
    return;
  }

  // 默认抽查集：九系各一个 T3 + 全部敌人
  const sampleLines = ['thief', 'archer', 'mage', 'drill', 'beauty', 'cannon', 'worker', 'sprite', 'tech'];
  for (const line of sampleLines) {
    const unit = content.units.find((u) => u.line === line && u.tier === 3) ?? content.units.find((u) => u.line === line);
    if (!unit) continue;
    printFrame(`TOWER ${unit.id} (${line} T${unit.tier}):idle`, renderTowerFrame(unit as UnitArtInput, 'idle'));
  }
  for (const enemy of content.enemies) {
    printFrame(`ENEMY ${enemy.id} (${enemy.armorType}):idle`, renderEnemyFrame(enemy as EnemyArtInput, 'idle'));
  }
}

main();
