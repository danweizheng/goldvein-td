/**
 * tests/data/types.spec.ts —— 生成类型 vs 策划案 §14.1 / 契约 §3.3 / §3.4（data-arch 所有）
 *
 * 三件事：
 *  ① 生成物必须是 §14.1 手写类型的**超集**：14.1 出现的每个字段名都必须在生成类型里。
 *  ② 生成物必须包含契约 §3.3 列出的每一个 BalanceConstants 键。
 *  ③ src/data/types.generated.ts 必须与 `pnpm gen-types` 的当前输出完全一致（防止手改 / 忘记重生成）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OUT_FILE, buildTypesSource } from '../../tools/gen-types.js';
import { ROOT } from '../../tools/validate-data.js';

const generated = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';

/** 取出某个 `export interface X { ... }` 的正文 */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) return '';
  let depth = 0;
  let i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(from + 1, i);
}

/** 正文顶层的字段名（缩进恰好 2 空格） */
function fieldNames(source: string, name: string): string[] {
  const body = interfaceBody(source, name);
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

describe('types.generated.ts —— §14.1 手写类型的超集', () => {
  /**
   * ★ 契约 v0.1.2 的两处**有意偏离**（主策划裁决，不是遗漏）：
   *  - UnitDef：§14.1 的单对象 `aura` 弃用 → 由 `auras: Aura[]` 取代（避免「引擎读 aura、数据写 auras」静默失效）
   *  - EnemyDef：§14.1 的 `bounty`（语义陷阱：名为 gold 却要求按曲线缩放）→ 由 `bountyRatio`（千分比 × 当波钱包）取代
   * 因此下面这两份字段清单**不含** aura / bounty，并另有用例显式断言它们已被移除。
   */
  const PLAN_14_1: Record<string, string[]> = {
    UnitDef: [
      'id', 'name', 'line', 'tier', 'cost', 'attack', 'attackInterval', 'range', 'attackType',
      'stealBase', 'critRate', 'critMul', 'auras', 'abilities', 'block', 'slowWhileBlocked',
      'upgradesTo', 'sellsFor', 'icon', 'sprite', 'description', 'roleTag',
    ],
    EnemyDef: [
      'id', 'name', 'armorType', 'baseHp', 'baseWallet', 'speed', 'flying', 'stealResist',
      'dodge', 'bountyRatio', 'isBoss', 'hooks', 'sprite',
    ],
    WaveDef: ['wave', 'prepTime', 'groups', 'reward', 'hint'],
    TechDef: ['id', 'name', 'maxLevel', 'effectMode', 'target', 'effectPerLevel', 'effectCap', 'effectUnit', 'costPerLevel', 'archivable', 'requires', 'description'],
    RelicDef: ['id', 'name', 'maxLevel', 'effectPerLevel', 'crystalCostPerLevel', 'unlocksUnit', 'description'],
    DifficultyDef: [
      'id', 'name', 'hpMul', 'walletMul', 'counterMode', 'divineArmorAllWaves', 'startGold',
      'startWood', 'lives', 'openLanes', 'crystalMul', 'description',
    ],
    // 契约 §11.2（v0.1.1 增补的第 9 张表）
    AudioDef: ['id', 'file', 'category', 'bus', 'gain', 'loop', 'fadeInMs', 'fadeOutMs', 'description'],
    // 契约 §14.11（v0.1.4 增补的第 10 张表）
    MapDef: ['id', 'name', 'grid', 'vault', 'buildDepth', 'haltPointsPerLane', 'paths', 'openLanes', 'description'],
  };

  for (const [name, fields] of Object.entries(PLAN_14_1)) {
    it(`${name} 覆盖 §14.1 的全部 ${fields.length} 个字段`, () => {
      const have = new Set(fieldNames(generated, name));
      const missing = fields.filter((f) => !have.has(f));
      expect(missing, `${name} 缺少字段：${missing.join(', ')}`).toEqual([]);
    });
  }

  it('§14.1 的 AttackType / ArmorType 枚举值完整', () => {
    expect(generated).toContain("export type AttackType = 'normal' | 'pierce' | 'magic' | 'siege' | 'chaos';");
    expect(generated).toContain("export type ArmorType = 'light' | 'medium' | 'heavy' | 'fortified' | 'divine';");
  });

  it('★ 契约 v0.1.2 有意偏离：`aura` 与 `bounty` 已从生成类型中移除（不是遗漏）', () => {
    expect(fieldNames(generated, 'UnitDef')).not.toContain('aura');
    expect(fieldNames(generated, 'EnemyDef')).not.toContain('bounty');
    // 取代它们的新字段必须在
    expect(fieldNames(generated, 'UnitDef')).toContain('auras');
    expect(fieldNames(generated, 'EnemyDef')).toContain('bountyRatio');
  });

  it('UnitDef.line 已扩为 9 个本期可用值 + hero（M6 保留）', () => {
    const lineField = interfaceBody(generated, 'UnitDef')
      .split('\n')
      .find((l) => /^\s{2}line:/.test(l));
    expect(lineField?.trim().replace(/;$/, '')).toBe(
      "line: 'thief' | 'archer' | 'mage' | 'drill' | 'beauty' | 'cannon' | 'worker' | 'sprite' | 'tech' | 'hero'",
    );
  });

  it('EquipmentDef 的 targetLine 枚举与 units 的 line 枚举同步（不得停留在旧的 7 值）', () => {
    const target = generated.slice(generated.indexOf('targetLine'));
    const oneLine = target.slice(0, target.indexOf('\n'));
    for (const v of ["'worker'", "'sprite'", "'tech'"]) {
      expect(oneLine, `targetLine 缺 ${v}`).toContain(v);
    }
  });

  it('附加扩展字段被保留（auras / effectUnit / equipSlot / availableFrom）', () => {
    expect(fieldNames(generated, 'UnitDef')).toContain('auras');
    expect(fieldNames(generated, 'TechDef')).toContain('effectUnit');
    expect(fieldNames(generated, 'RelicDef')).toContain('effectUnit');
    expect(fieldNames(generated, 'EquipmentDef')).toContain('equipSlot');
    expect(fieldNames(generated, 'EquipmentDef')).toContain('availableFrom');
  });
});

describe('types.generated.ts —— 契约 §3.3 BalanceConstants 键', () => {
  const REQUIRED = [
    'tickRate', 'fixedScale', 'baseHp', 'hpIndex', 'baseWallet', 'walletIndex', 'enemyCountBase',
    'enemyCountSlope', 'levelMul', 'stealAtkCoef', 'critRateBase', 'critRateCap', 'critMulBase',
    'critMulPerLevel', 'critMulCap', 'stealResistDefault', 'counterMatrixStandard',
    'compressedFactor', 'compressedFloor', 'haltPointStopDuration', 'crystalDivisor',
    'difficultyCrystalMul', 'salaryCooldown', 'salaryMultiplier', 'brambleCooldown', 'brambleDuration',
  ];

  it('§3.3 列出的每一个键都存在（键名不得改名）', () => {
    const have = new Set(fieldNames(generated, 'BalanceConstants'));
    const missing = REQUIRED.filter((k) => !have.has(k));
    expect(missing, `缺少：${missing.join(', ')}`).toEqual([]);
  });

  it('§3.3 之外新增的键（按契约允许微调/追加）也在类型里', () => {
    const have = new Set(fieldNames(generated, 'BalanceConstants'));
    for (const k of ['waveTotal', 'undoWindow', 'undoRefundPct', 'stealWoodRatio', 'ascensionMinWave', 'achievementMuls', 'map', 'hero', 'economyTargets', 'acceptanceTargets']) {
      expect(have.has(k), k).toBe(true);
    }
  });
});

describe('types.generated.ts —— 生成物一致性', () => {
  it('文件已提交且与 `pnpm gen-types` 当前输出逐字节一致（禁止手改 / 禁止忘记重生成）', async () => {
    const { source } = await buildTypesSource(join(ROOT, 'src', 'data', 'schema'));
    expect(generated).toBe(source);
  });

  it('没有重复导出的类型名（跨表同名 definition 必须已合并）', () => {
    const names = [...generated.matchAll(/^export (?:interface|type|const) ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    const seen = new Set<string>();
    const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });

  it('导出全部 10 张表的根类型与表级别名', () => {
    for (const name of ['UnitDef', 'EnemyDef', 'WaveDef', 'TechDef', 'RelicDef', 'EquipmentDef', 'DifficultyDef', 'BalanceConstants', 'AudioDef', 'MapDef']) {
      expect(generated).toContain(`export interface ${name} {`);
    }
    for (const alias of ['UnitTable', 'EnemyTable', 'WaveTable', 'TechTable', 'RelicTable', 'EquipmentTable', 'DifficultyTable', 'AudioTable']) {
      expect(generated).toContain(`export type ${alias} =`);
    }
    expect(generated).toContain('export interface ConfigTables {');
    expect(generated).toContain('export const TABLE_ROOT_TYPES = {');
  });

  it('★ TechDef 的 effectMode 是契约 §14.2 的枚举（add | mul）', () => {
    const body = interfaceBody(generated, 'TechDef');
    const line = body.split('\n').find((l) => /^\s{2}effectMode:/.test(l));
    expect(line?.trim().replace(/;$/, '')).toBe("effectMode: 'add' | 'mul'");
  });

  it('★ TechDef 的 target 是契约 §14.20 的 8 值枚举（引擎据此删除硬编码映射表）', () => {
    const body = interfaceBody(generated, 'TechDef');
    const line = body.split('\n').find((l) => /^\s{2}target\??:/.test(l));
    expect(line?.trim().replace(/;$/, '')).toBe(
      "target: 'attack' | 'speed' | 'range' | 'steal' | 'critRate' | 'critMul' | 'population' | 'baseLevel'",
    );
    // 必填（不得是 target?）
    expect(line).not.toContain('target?');
  });

  it('AudioDef 的 category / bus 是契约 §11.2 / §11.3 的枚举（没有 voice 总线）', () => {
    const body = interfaceBody(generated, 'AudioDef');
    expect(body).toContain("category: 'bgm' | 'sfx' | 'ambience';");
    // bus 的类型字面量里不得出现 voice（JSDoc 里提到「没有 voice」不算）
    const busLine = body.split('\n').find((l) => /^\s*bus\s*:/.test(l));
    expect(busLine?.trim()).toBe("bus: 'bgm' | 'sfx';");
  });
});
