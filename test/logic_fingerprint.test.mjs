// logic_fingerprint.mjs のテスト。
// 実測バグ再発防止(2026-09-22): 「キャッシュは当日分だが判定ロジックが
// 変更されていた」ため、コードを直してもindex.htmlに一切反映されて
// いなかった。cache.date===todayだけでなく、判定ロジックの主要ファイルの
// 内容ハッシュも一致しなければキャッシュを有効とみなさないようにする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLogicFingerprint, isCacheFresh, LOGIC_FINGERPRINT_FILES } from '../logic_fingerprint.mjs';

test('computeLogicFingerprint: 同じ内容のファイル群からは同じフィンガープリントを返す（決定的）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp_test_'));
  try {
    for (const f of LOGIC_FINGERPRINT_FILES) fs.writeFileSync(path.join(dir, f), `// ${f} content v1`);
    const fp1 = computeLogicFingerprint(dir);
    const fp2 = computeLogicFingerprint(dir);
    assert.equal(fp1, fp2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeLogicFingerprint: 対象ファイルの中身が1つでも変われば別のフィンガープリントになる（実測バグの再発防止の核心）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp_test_'));
  try {
    for (const f of LOGIC_FINGERPRINT_FILES) fs.writeFileSync(path.join(dir, f), `// ${f} content v1`);
    const before = computeLogicFingerprint(dir);
    // indicators.mjs相当のファイルだけ1バイト変更する（ラベル文言修正のような小さな変更を模す）。
    fs.writeFileSync(path.join(dir, 'indicators.mjs'), '// indicators.mjs content v2 (changed)');
    const after = computeLogicFingerprint(dir);
    assert.notEqual(before, after, 'ロジックファイルが変更されたのに同じフィンガープリントを返してはいけない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeLogicFingerprint: 対象外ファイル（例: scraper.mjs）の変更はフィンガープリントに影響しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp_test_'));
  try {
    for (const f of LOGIC_FINGERPRINT_FILES) fs.writeFileSync(path.join(dir, f), `// ${f} content v1`);
    fs.writeFileSync(path.join(dir, 'scraper.mjs'), '// scraper.mjs v1');
    const before = computeLogicFingerprint(dir);
    fs.writeFileSync(path.join(dir, 'scraper.mjs'), '// scraper.mjs v2 (changed, but not a scoring file)');
    const after = computeLogicFingerprint(dir);
    assert.equal(before, after, 'LOGIC_FINGERPRINT_FILESに含まれないファイルの変更は無視してよい（表示専用コードの変更まで毎回フルスキャンにしないため）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isCacheFresh: 日付・フィンガープリントの両方が一致すればtrue', () => {
  const cache = { date: '2026-09-22', results: [{ code: '1234' }], logicFingerprint: 'abc123' };
  assert.equal(isCacheFresh(cache, '2026-09-22', 'abc123'), true);
});

test('isCacheFresh: 日付が同じでもフィンガープリントが違えばfalse（実測バグの再発防止。CASE準拠）', () => {
  const cache = { date: '2026-09-22', results: [{ code: '1234' }], logicFingerprint: 'old-fingerprint' };
  assert.equal(isCacheFresh(cache, '2026-09-22', 'new-fingerprint'), false, '判定ロジックが変わっていれば、日付が同じでもキャッシュを無効にする');
});

test('isCacheFresh: 日付が違えばfalse（従来通りの日次キャッシュの考え方は維持）', () => {
  const cache = { date: '2026-09-21', results: [{ code: '1234' }], logicFingerprint: 'abc123' };
  assert.equal(isCacheFresh(cache, '2026-09-22', 'abc123'), false);
});

test('isCacheFresh: logicFingerprintを持たない旧形式のキャッシュはfalse（安全側＝再計算に倒す）', () => {
  const cache = { date: '2026-09-22', results: [{ code: '1234' }] };
  assert.equal(isCacheFresh(cache, '2026-09-22', 'abc123'), false);
});

test('isCacheFresh: resultsが無ければfalse', () => {
  assert.equal(isCacheFresh({ date: '2026-09-22', logicFingerprint: 'abc123' }, '2026-09-22', 'abc123'), false);
});

test('isCacheFresh: cache自体がnull/undefinedでもクラッシュしない', () => {
  assert.equal(isCacheFresh(null, '2026-09-22', 'abc123'), false);
  assert.equal(isCacheFresh(undefined, '2026-09-22', 'abc123'), false);
});
