// ambush_timing_backtest.mjs のテスト。
// policy_catalyst_backtest.test.mjsと同じ方針: 「BUY SCORE等の記録が
// 正しくできるか」だけを確認する（検証・分析自体はまだしない）。
// 実ファイル(ambush_timing_backtest_cache.json)は汚さず、テストごとに
// 一時ファイルを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAmbushTimingBacktest, recordAmbushTimingSnapshot, ambushTimingBacktestStatus } from '../ambush_timing_backtest.mjs';

function tmpFile() {
  return path.join(os.tmpdir(), `ambush_timing_backtest_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

function sampleResult(overrides = {}) {
  return {
    code: '7203', name: 'トヨタ自動車', daysLeft: 18,
    earningsDate: '2026-10-10', earningsDateStatus: 'confirmed', earningsDateSource: 'sbi_exchange',
    bucket: 'NOW', hasCatalyst: true, catalystTier: 'S', catalystScore100: 90,
    kairi: 3, repricingLag: { return1m: 5, return3m: 8, zone: 'pre_move' },
    ...overrides,
  };
}

test('存在しないファイルを読んでも空オブジェクトを返す(クラッシュしない)', () => {
  assert.deepEqual(loadAmbushTimingBacktest('/nonexistent/ambush_timing_backtest.json'), {});
});

test('daysLeftが無い銘柄は記録しない(時間軸の検証という目的に使えないため)', () => {
  const file = tmpFile();
  try {
    const added = recordAmbushTimingSnapshot('2026-09-22', [sampleResult({ daysLeft: null })], file);
    assert.equal(added, 0);
    assert.ok(!fs.existsSync(file));
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('EARNINGS_DISTANCE/CATALYST_SIGNAL/PRICE_REACTION/EARNINGS_DATE_CONFIDENCEを分離して記録する', () => {
  const file = tmpFile();
  try {
    const added = recordAmbushTimingSnapshot('2026-09-22', [sampleResult()], file);
    assert.equal(added, 1);
    const row = loadAmbushTimingBacktest(file)['2026-09-22']['7203'];
    assert.equal(row.daysToEarnings, 18);
    assert.equal(row.earningsDistanceUnit, 'calendar_days');
    assert.equal(row.bucket, 'NOW');
    assert.equal(row.earningsDateStatus, 'CONFIRMED');
    assert.equal(row.catalystExists, true);
    assert.equal(row.catalystTier, 'S');
    assert.equal(row.kairi, 3);
    assert.equal(row.return1m, 5);
    assert.equal(row.repricingLagZone, 'pre_move');
    assert.equal(row.catalystFirstSeen, '2026-09-22', '初めて観測した日はその日自身になる');
  } finally {
    fs.unlinkSync(file);
  }
});

test('catalystFirstSeenは記録基盤の観測開始日以降で最も古い日付を引き継ぐ（過去に遡って推測はしない）', () => {
  const file = tmpFile();
  try {
    recordAmbushTimingSnapshot('2026-09-20', [sampleResult()], file);
    recordAmbushTimingSnapshot('2026-09-22', [sampleResult()], file);
    const row = loadAmbushTimingBacktest(file)['2026-09-22']['7203'];
    assert.equal(row.catalystFirstSeen, '2026-09-20');
  } finally {
    fs.unlinkSync(file);
  }
});

test('同じ日に複数回呼んでも(場中再実行を想定)、最初の1回だけが残り上書きされない', () => {
  const file = tmpFile();
  try {
    recordAmbushTimingSnapshot('2026-09-22', [sampleResult({ daysLeft: 18 })], file);
    const added2 = recordAmbushTimingSnapshot('2026-09-22', [sampleResult({ daysLeft: 99 })], file);
    assert.equal(added2, 0);
    const row = loadAmbushTimingBacktest(file)['2026-09-22']['7203'];
    assert.equal(row.daysToEarnings, 18, '2回目の99で上書きされてはいけない');
  } finally {
    fs.unlinkSync(file);
  }
});

test('ambushTimingBacktestStatus: 記録日数・件数・期間を集計する', () => {
  const file = tmpFile();
  try {
    recordAmbushTimingSnapshot('2026-09-20', [sampleResult({ code: '7203' })], file);
    recordAmbushTimingSnapshot('2026-09-22', [sampleResult({ code: '9984' })], file);
    const status = ambushTimingBacktestStatus(file);
    assert.equal(status.days, 2);
    assert.equal(status.totalSnapshots, 2);
    assert.equal(status.firstDate, '2026-09-20');
    assert.equal(status.lastDate, '2026-09-22');
  } finally {
    fs.unlinkSync(file);
  }
});
