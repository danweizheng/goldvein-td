/**
 * tests/data/audio.spec.ts —— 第 9 张表 audio.json vs 契约 §11（v0.1.1 增补）（data-arch 所有）
 *
 * 重点验证「跨文件一致性」：清单 ↔ 磁盘 public/assets/audio/*.ogg 必须**不多不少**。
 * 这是本次增补的核心要求——只校验 JSON 内部一致性会漏掉
 * 「清单写了但文件不存在」与「文件存在但清单没写」两类错误。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AUDIO_CATEGORY_COUNTS, PUBLIC_AUDIO_DIR, TABLES, loadTables, validateAllData } from '../../tools/validate-data';

const T = loadTables();
const byId = new Map<string, any>(T.audio.map((a) => [a.id, a]));

const diskIds = readdirSync(PUBLIC_AUDIO_DIR)
  .filter((f) => f.toLowerCase().endsWith('.ogg'))
  .map((f) => f.replace(/\.ogg$/i, ''))
  .sort();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('audio.json —— 条目数与跨文件一致性（契约 §11.1 / §11.2 第 1 条）', () => {
  it('恰好 40 条', () => {
    expect(T.audio).toHaveLength(40);
    expect(TABLES.find((t) => t.file === 'audio.json')?.count).toBe(40);
  });

  it('磁盘上恰好 40 个 .ogg', () => {
    expect(diskIds).toHaveLength(40);
  });

  it('★ id 集合与磁盘文件名一一对应（不多不少）', () => {
    const ids = T.audio.map((a) => a.id).sort();
    expect(ids).toEqual(diskIds);
  });

  it('清单里没有磁盘上不存在的 id', () => {
    const diskSet = new Set(diskIds);
    expect(T.audio.filter((a) => !diskSet.has(a.id)).map((a) => a.id)).toEqual([]);
  });

  it('磁盘上没有未登记的 .ogg', () => {
    expect(diskIds.filter((id) => !byId.has(id))).toEqual([]);
  });

  it('file == `assets/audio/<id>.ogg`（扁平命名，§11.1）', () => {
    for (const a of T.audio) expect(a.file, a.id).toBe(`assets/audio/${a.id}.ogg`);
  });

  it('id 前缀合法（bgm_ / sfx_），且不含大写或空格', () => {
    for (const a of T.audio) expect(a.id, a.id).toMatch(/^(bgm|sfx)_[a-z0-9_]+$/);
  });
});

describe('audio.json —— 类别 / 总线 / 循环 / 音量（契约 §11.2 / §11.3）', () => {
  it('类别计数 = bgm 4 / sfx 34 / ambience 2（对照策划案 §7.3）', () => {
    const counts = T.audio.reduce<Record<string, number>>((a, r) => ((a[r.category] = (a[r.category] ?? 0) + 1), a), {});
    expect(counts).toEqual(AUDIO_CATEGORY_COUNTS);
  });

  it('混音总线只有 bgm 与 sfx，没有 voice（§11.3 裁决）', () => {
    const buses = new Set(T.audio.map((a) => a.bus));
    expect([...buses].sort()).toEqual(['bgm', 'sfx']);
  });

  it('bgm 走 bgm 总线且 loop；sfx/ambience 走 sfx 总线；sfx 不 loop', () => {
    for (const a of T.audio) {
      if (a.category === 'bgm') {
        expect(a.bus, a.id).toBe('bgm');
        expect(a.loop, a.id).toBe(true);
      } else {
        expect(a.bus, a.id).toBe('sfx');
      }
      if (a.category === 'sfx') expect(a.loop, a.id).toBe(false);
      if (a.category === 'ambience') expect(a.loop, a.id).toBe(true);
    }
  });

  it('gain 统一 1000（=100%）（本次增补不发明平衡数值）', () => {
    for (const a of T.audio) expect(a.gain, a.id).toBe(1000);
  });

  it('每条都有中文 description（取自台账「用途」列）', () => {
    for (const a of T.audio) {
      expect(a.description, a.id).toBeTruthy();
      expect(a.description.length, a.id).toBeGreaterThan(1);
    }
  });
});

describe('audio.json —— ambience 淡化硬约束（契约 §11.2 第 2 条）', () => {
  const ambience = T.audio.filter((a) => a.category === 'ambience');

  it('恰好 2 条 ambience：sfx_amb_vault / sfx_amb_street', () => {
    expect(ambience.map((a) => a.id).sort()).toEqual(['sfx_amb_street', 'sfx_amb_vault']);
  });

  it('★ 两条 ambience 的 fadeInMs / fadeOutMs 都必须 ≥ 100ms（否则循环点会咔哒）', () => {
    for (const a of ambience) {
      expect(typeof a.fadeInMs, `${a.id}.fadeInMs`).toBe('number');
      expect(typeof a.fadeOutMs, `${a.id}.fadeOutMs`).toBe('number');
      expect(a.fadeInMs, `${a.id}.fadeInMs`).toBeGreaterThanOrEqual(100);
      expect(a.fadeOutMs, `${a.id}.fadeOutMs`).toBeGreaterThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// 跨文件校验必须是「真的在查磁盘」
// ---------------------------------------------------------------------------

describe('audio.json —— 跨文件校验的反例（写坏了必须被拦住）', () => {
  function validateMutatedAudio(mutate: (rows: any[]) => void, diskFilter?: (f: string) => boolean) {
    const rows = JSON.parse(JSON.stringify(T.audio)) as any[];
    mutate(rows);
    const dir = mkdtempSync(join(tmpdir(), 'goldvein-audio-'));
    tempDirs.push(dir);
    const all = readdirSync(PUBLIC_AUDIO_DIR).filter((f) => f.toLowerCase().endsWith('.ogg'));
    for (const f of all) {
      if (diskFilter && !diskFilter(f)) continue;
      writeFileSync(join(dir, f), Buffer.alloc(0));
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'goldvein-audio-data-'));
    tempDirs.push(dataDir);
    for (const t of TABLES) {
      const key = t.file.replace(/\.json$/, '') as keyof ReturnType<typeof loadTables>;
      const value = key === 'audio' ? rows : (T as any)[key];
      if (value === undefined) continue;
      writeFileSync(join(dataDir, t.file), JSON.stringify(value, null, 2), 'utf8');
    }
    return validateAllData({ dataDir, audioDir: dir }).issues.filter((i) => i.file === 'audio.json');
  }

  it('清单里有但磁盘上没有 → 报「文件不存在」', () => {
    const issues = validateMutatedAudio(() => {}, (f) => f !== 'sfx_ui_click.ogg');
    const hit = issues.find((i) => i.field === 'id' && i.message.includes('sfx_ui_click'));
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('不存在');
  });

  it('磁盘上有但清单里没有 → 报「未登记」', () => {
    const issues = validateMutatedAudio((rows) => {
      const i = rows.findIndex((r) => r.id === 'sfx_win');
      rows.splice(i, 1);
    });
    expect(issues.some((x) => x.message.includes('sfx_win.ogg') && x.message.includes('没有登记'))).toBe(true);
  });

  it('ambience 的 fadeInMs 降到 50 → 被拦住（契约 §11.2 第 2 条）', () => {
    const issues = validateMutatedAudio((rows) => {
      rows.find((r) => r.id === 'sfx_amb_vault').fadeInMs = 50;
    });
    const hit = issues.find((i) => i.id === 'sfx_amb_vault' && i.field === 'fadeInMs');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('100');
  });

  it('ambience 缺 fadeOutMs → 被拦住', () => {
    const issues = validateMutatedAudio((rows) => {
      delete rows.find((r) => r.id === 'sfx_amb_street').fadeOutMs;
    });
    expect(issues.some((i) => i.id === 'sfx_amb_street' && i.field === 'fadeOutMs')).toBe(true);
  });

  it('file 与 id 不一致 → 被拦住', () => {
    const issues = validateMutatedAudio((rows) => {
      rows[0].file = 'assets/audio/wrong_name.ogg';
    });
    expect(issues.some((i) => i.field === 'file')).toBe(true);
  });

  it('把 sfx 的 loop 改成 true → 被拦住', () => {
    const issues = validateMutatedAudio((rows) => {
      rows.find((r) => r.id === 'sfx_ui_click').loop = true;
    });
    expect(issues.some((i) => i.id === 'sfx_ui_click' && i.field === 'loop')).toBe(true);
  });

  it('出现 bus: "voice" → Schema 枚举拦住（§11.3：没有 voice 总线）', () => {
    const issues = validateMutatedAudio((rows) => {
      rows[0].bus = 'voice';
    });
    expect(issues.some((i) => i.field === 'bus')).toBe(true);
  });
});
