// policy_catalyst_backtest.mjs のテスト。
//
// このモジュールはまだ「検証」(前方リターンとの突き合わせ)はしない。
// 「BUY SCOREとPolicy Catalyst Scoreを同じ日のスナップショットとして
// 正しく記録できるか」だけを確認する。実ファイル(policy_catalyst_
// backtest_cache.json)は汚さず、テストごとに一時ファイルを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicyCatalystBacktest, recordPolicyCatalystSnapshot, policyCatalystBacktestStatus,
} from '../policy_catalyst_backtest.mjs';

function tmpFile() {
  return path.join(os.tmpdir(), `policy_catalyst_backtest_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

function sampleResult(overrides = {}) {
  return {
    code: '8035', name: '東京エレクトロン', price: 25000,
    buyScore: { score: 72, confidence: 80, detail: { unpriced: { value: 45 }, timing: { value: 60 } } },
    expectationScore: { score: 60 },
    earningsSurpriseScore: { score: 50 },
    policyCatalystScore: {
      score: 86, confidence: 100, eventId: 'news-1|8035', theme: '半導体産業政策', direction: 'positive',
      parts: { policy: 88, unpriced: 80, timing: 100, exposure: 100 },
    },
    // riskLevel()はCASE7再発防止(indicators.mjs参照)で、CHIP_SIGNAL_FIELDS
    // が1件もchecked:trueでなければ'UNKNOWN'を返すようになった。このモックは
    // 「確認した結果bad級シグナルが無かった」ケースを表すため、最低1件は
    // checked:trueにしておく（実際のnetNetSignal等も判定できた場合は
    // 必ずchecked:trueを伴う）。
    netNet: { level: null, label: null, note: null, checked: true },
    ...overrides,
  };
}

test('存在しないファイルを読んでも空オブジェクトを返す(クラッシュしない)', () => {
  assert.deepEqual(loadPolicyCatalystBacktest('/nonexistent/policy_catalyst_backtest.json'), {});
});

test('policyCatalystScoreが無い銘柄は記録しない(BUY SCOREだけの銘柄でログを膨らませない)', () => {
  const file = tmpFile();
  try {
    const added = recordPolicyCatalystSnapshot('2026-09-13', [sampleResult({ policyCatalystScore: null })], file);
    assert.equal(added, 0);
    assert.ok(!fs.existsSync(file), '1件も追加が無ければファイル自体を作らない');
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('既存BUY SCOREとPolicy Catalyst Scoreを同じ日のスナップショットとして記録する(将来のロジック変更後も再現できるよう、当時の生の値をそのまま保存する)', () => {
  const file = tmpFile();
  try {
    const added = recordPolicyCatalystSnapshot('2026-09-13', [sampleResult()], file);
    assert.equal(added, 1);
    const hist = loadPolicyCatalystBacktest(file);
    const row = hist['2026-09-13']['8035|news-1|8035'];
    // 識別情報
    assert.equal(row.date, '2026-09-13');
    assert.equal(row.code, '8035');
    assert.equal(row.theme, '半導体産業政策');
    assert.equal(row.direction, 'positive', 'Python側のdirectionをそのまま透過するべき');
    // BUY SCORE側の内訳(当時の生の値)
    assert.equal(row.policyImpactScore, 88, '生のPolicy Impact Score(policyCatalystParts.policy)も別途保存するべき');
    assert.equal(row.buyScore, 72, '既存BUY SCOREをそのまま記録すべき');
    assert.equal(row.buyConfidence, 80);
    assert.equal(row.expectationScore, 60);
    assert.equal(row.earningsSurpriseScore, 50);
    assert.equal(row.unpriced, 45, 'BUY SCORE内訳のUNPRICED(r.buyScore.detail.unpriced.value)を保存するべき');
    assert.equal(row.timing, 60, 'BUY SCORE内訳のTIMING(r.buyScore.detail.timing.value)を保存するべき');
    assert.equal(row.risk, 'LOW', 'badChipSignalsが0件のサンプルなのでLOWになるべき');
    // Policy Catalyst Score側
    assert.equal(row.policyCatalystScore, 86, 'Policy Catalyst Scoreをそのまま記録すべき');
    assert.equal(row.policyCatalystConfidence, 100);
    assert.deepEqual(row.policyCatalystParts, { policy: 88, unpriced: 80, timing: 100, exposure: 100 });
  } finally {
    fs.unlinkSync(file);
  }
});

test('buyScore.detailが無ければunpriced/timingはnullになる(推測で埋めない)', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-13', [sampleResult({ buyScore: { score: 72, confidence: 80 } })], file);
    const row = loadPolicyCatalystBacktest(file)['2026-09-13']['8035|news-1|8035'];
    assert.equal(row.unpriced, null);
    assert.equal(row.timing, null);
  } finally {
    fs.unlinkSync(file);
  }
});

test('badChipSignals該当のシグナルがあればriskがLOWより悪化する(riskLevelをそのまま反映する)', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-13', [sampleResult({ netNet: { level: 'bad', label: 'ネットネット割れ', note: 'テスト', checked: true } })], file);
    const row = loadPolicyCatalystBacktest(file)['2026-09-13']['8035|news-1|8035'];
    assert.equal(row.risk, 'MED');
  } finally {
    fs.unlinkSync(file);
  }
});

test('同じ日に複数回呼んでも(場中5分再実行を想定)、最初の1回だけが残り上書きされない', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-13', [sampleResult({ buyScore: { score: 50, confidence: 80 } })], file);
    const added2 = recordPolicyCatalystSnapshot('2026-09-13', [sampleResult({ buyScore: { score: 99, confidence: 80 } })], file);
    assert.equal(added2, 0, '同日・同キーの2回目は追加件数0であるべき');
    const hist = loadPolicyCatalystBacktest(file);
    const row = hist['2026-09-13']['8035|news-1|8035'];
    assert.equal(row.buyScore, 50, '最初に記録した値のまま(2回目の99で上書きされてはいけない)');
  } finally {
    fs.unlinkSync(file);
  }
});

test('同一銘柄が別の政策イベント(eventId違い)なら別サンプルとして記録される', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-13', [sampleResult()], file);
    const added = recordPolicyCatalystSnapshot('2026-09-13', [
      sampleResult({ policyCatalystScore: { ...sampleResult().policyCatalystScore, eventId: 'news-2|8035', theme: '防衛政策' } }),
    ], file);
    assert.equal(added, 1);
    const hist = loadPolicyCatalystBacktest(file);
    assert.equal(Object.keys(hist['2026-09-13']).length, 2);
  } finally {
    fs.unlinkSync(file);
  }
});

test('別日に呼べば別日のキーとして追記される(既存日を上書きしない)', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-13', [sampleResult()], file);
    recordPolicyCatalystSnapshot('2026-09-14', [sampleResult({ buyScore: { score: 65, confidence: 80 } })], file);
    const hist = loadPolicyCatalystBacktest(file);
    assert.equal(hist['2026-09-13']['8035|news-1|8035'].buyScore, 72);
    assert.equal(hist['2026-09-14']['8035|news-1|8035'].buyScore, 65);
  } finally {
    fs.unlinkSync(file);
  }
});

test('policyCatalystBacktestStatus: 蓄積日数・件数・期間を正しく集計する', () => {
  const file = tmpFile();
  try {
    recordPolicyCatalystSnapshot('2026-09-10', [sampleResult()], file);
    recordPolicyCatalystSnapshot('2026-09-13', [
      sampleResult(),
      sampleResult({ code: '7011', policyCatalystScore: { ...sampleResult().policyCatalystScore, eventId: 'news-3|7011' } }),
    ], file);
    const status = policyCatalystBacktestStatus(file);
    assert.equal(status.days, 2);
    assert.equal(status.totalSnapshots, 3);
    assert.equal(status.firstDate, '2026-09-10');
    assert.equal(status.lastDate, '2026-09-13');
  } finally {
    fs.unlinkSync(file);
  }
});

test('policyCatalystBacktestStatus: ファイルが無ければ0件で返す(クラッシュしない)', () => {
  const status = policyCatalystBacktestStatus('/nonexistent/policy_catalyst_backtest.json');
  assert.equal(status.days, 0);
  assert.equal(status.totalSnapshots, 0);
  assert.equal(status.firstDate, null);
  assert.equal(status.lastDate, null);
});
