// health_check.mjs（Production Health Check、ユーザー提案）の回帰テスト。
// 「次回スキャンを見に行く」のではなく、スキャン自身に自己検査させる
// ための仕組み。判定ロジックを新設せず、既に出力された結果が
// 「壊れていないか」だけを検査する読み取り専用モジュール。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeHealthCheck, HEALTH_STATUS } from '../health_check.mjs';
import { creditSupplyTags } from '../indicators.mjs';

// 完全に矛盾の無いAMBUSH結果1件（実際のcreditSupplyTags()で再計算した
// tagsを使うことで、tag_mismatch側のテストと対称になるようにする）。
function healthyResult(overrides = {}) {
  const creditSupplyQuality = {
    checked: true, creditAsOf: '26/09/11', bounceQuality: 'IMPROVING', isStale: false,
    buyBalance: 1_240_000, sellBalance: 62_000, creditRatio: 20, pattern: 'SUPPLY_IMPROVING',
    ...overrides.creditSupplyQuality,
  };
  const tags = creditSupplyTags({ creditSupplyQuality });
  return {
    code: '1001', name: 'テスト銘柄', scoreInvariantOk: true,
    creditSupplyQuality,
    creditSupplyTimeline: {
      checked: true,
      points: [
        { date: '2026-09-04', close: 3280, buyBalance: 1_400_000, buyChangePct: -4.1, sellBalance: 68_000, sellChangePct: -2.9, creditRatio: 20.6 },
        { date: '2026-09-11', close: 3350, buyBalance: 1_240_000, buyChangePct: -11.4, sellBalance: 62_000, sellChangePct: -8.8, creditRatio: 20 },
      ],
      latestDate: '2026-09-11', pending: false, tags,
      sourceDates: ['2026-09-04', '2026-09-11'],
      ...overrides.creditSupplyTimeline,
    },
    ...overrides.top,
  };
}

test('computeHealthCheck: 矛盾の無い結果だけならstatus:PASS', () => {
  const h = computeHealthCheck({ results: [healthyResult()], previousHealth: null, logicFingerprint: 'abc', gitSha: 'xyz', generatedAt: 'now', todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.PASS);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.coverage.creditQualityChecked, 1);
  assert.equal(h.coverage.timelineChecked, 1);
});

test('ERROR: 信用残の最終発表日が未来日付ならERROR（future_date）', () => {
  const r = healthyResult({ creditSupplyQuality: { creditAsOf: '26/12/31' } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'future_date' && e.affected.includes('1001')));
});

test('ERROR: creditSupplyQualityの数値フィールドがNaN/InfinityならERROR', () => {
  const r = healthyResult({ creditSupplyQuality: { buyPressureDays: Infinity } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'nan_or_infinity'));
});

test('ERROR: bounceQuality:PENDINGなのにisStale:trueでなければERROR（pending_isstale_mismatch）', () => {
  const r = healthyResult({ creditSupplyQuality: { bounceQuality: 'PENDING', isStale: false } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'pending_isstale_mismatch'));
});

test('ERROR: creditSupplyTimeline.pointsが6件を超えていればERROR（timeline_too_many_points）', () => {
  const points = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-0${i + 1}`, close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 }));
  const r = healthyResult({ creditSupplyTimeline: { points } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'timeline_too_many_points'));
});

test('ERROR: creditSupplyTimeline.pointsに日付重複があればERROR（timeline_duplicate_dates）', () => {
  const points = [
    { date: '2026-09-04', close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 },
    { date: '2026-09-04', close: 101, buyBalance: 101, buyChangePct: 1, sellBalance: 51, sellChangePct: 1, creditRatio: 2 },
  ];
  const r = healthyResult({ creditSupplyTimeline: { points } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'timeline_duplicate_dates'));
});

test('ERROR: creditSupplyTimeline.pointsが古い→新しい順になっていなければERROR（timeline_date_order）', () => {
  const points = [
    { date: '2026-09-11', close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 },
    { date: '2026-09-04', close: 99, buyBalance: 99, buyChangePct: -1, sellBalance: 49, sellChangePct: -1, creditRatio: 2 },
  ];
  const r = healthyResult({ creditSupplyTimeline: { points } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'timeline_date_order'));
});

test('ERROR: creditSupplyTimeline.pointsの日付が未来日付ならERROR', () => {
  const points = [{ date: '2026-12-31', close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 }];
  const r = healthyResult({ creditSupplyTimeline: { points } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'future_date'));
});

test('ERROR: creditSupplyTimeline.pointsの数値フィールドがNaN/InfinityならERROR', () => {
  const points = [{ date: '2026-09-11', close: NaN, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 }];
  const r = healthyResult({ creditSupplyTimeline: { points } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'nan_or_infinity'));
});

test('ERROR: 未定義のタグが出力されていればERROR（unknown_tag）', () => {
  const r = healthyResult({ creditSupplyTimeline: { tags: ['未知のタグ'] } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'unknown_tag'));
});

test('ERROR: tagsが既存creditSupplyTags(r)の再計算結果と一致しなければERROR（tag_mismatch。signalとタグの矛盾検出）', () => {
  const r = healthyResult({ creditSupplyTimeline: { tags: ['買残整理'] } }); // 実際はSUPPLY_IMPROVINGなので「需給改善」のはず
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'tag_mismatch'));
  assert.equal(h.tagConsistencyFailures, 1);
});

test('ERROR: scoreInvariantOk:falseがあればERROR（score_invariant_failed）', () => {
  const r = healthyResult({ top: { scoreInvariantOk: false } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'score_invariant_failed'));
  assert.equal(h.scoreInvariantFailures, 1);
});

test('WARNING: creditQualityChecked/timelineCheckedが前回より減少（0にはならない）ならWARNING扱い（固定閾値は使わない）', () => {
  const previousHealth = { coverage: { creditQualityChecked: 10, timelineChecked: 10, closeMissingCount: 0, pendingCount: 0 } };
  const results = [healthyResult(), { code: '1002', creditSupplyQuality: { checked: false }, creditSupplyTimeline: { checked: false } }];
  const h = computeHealthCheck({ results, previousHealth, todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.WARNING);
  assert.ok(h.warnings.some((w) => w.code === 'credit_quality_checked_decreased'));
  assert.ok(h.warnings.some((w) => w.code === 'timeline_checked_decreased'));
});

test('ERROR: creditQualityChecked/timelineCheckedが前回>0から今回0になればERROR（0件化。データ取得経路が死んでいる可能性）', () => {
  const previousHealth = { coverage: { creditQualityChecked: 10, timelineChecked: 10, closeMissingCount: 0, pendingCount: 0 } };
  const results = [{ code: '1002', creditSupplyQuality: { checked: false }, creditSupplyTimeline: { checked: false } }];
  const h = computeHealthCheck({ results, previousHealth, todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'credit_quality_checked_zero'));
  assert.ok(h.errors.some((e) => e.code === 'timeline_checked_zero'));
});

test('WARNING: close欠損点数・PENDING件数が前回より増加していればWARNING', () => {
  const previousHealth = { coverage: { creditQualityChecked: 1, timelineChecked: 1, closeMissingCount: 0, pendingCount: 0 } };
  const r = healthyResult({ creditSupplyQuality: { bounceQuality: 'PENDING', isStale: true } });
  r.creditSupplyTimeline.points[0].close = null;
  const h = computeHealthCheck({ results: [r], previousHealth, todayIso: '2026-09-11' });
  assert.ok(h.warnings.some((w) => w.code === 'close_missing_increased'));
  assert.ok(h.warnings.some((w) => w.code === 'pending_increased'));
});

test('INFO: logicFingerprintが前回から変化していればinfo(logic_changed)を記録する（severityは上げない）', () => {
  const previousHealth = { coverage: { creditQualityChecked: 1, timelineChecked: 1, closeMissingCount: 0, pendingCount: 0 }, logicFingerprint: 'AAA' };
  const h = computeHealthCheck({ results: [healthyResult()], previousHealth, logicFingerprint: 'BBB', todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.PASS); // ロジック変更自体はERROR/WARNINGにしない
  assert.ok(h.info.some((i) => i.code === 'logic_changed'));
});

test('checked:false/データ無しの銘柄は検査対象から除外される（未取得を異常として誤検知しない）', () => {
  const r = { code: '9999', creditSupplyQuality: { checked: false }, creditSupplyTimeline: { checked: false } };
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.PASS);
  assert.equal(h.coverage.creditQualityChecked, 0);
  assert.equal(h.coverage.timelineChecked, 0);
});

// ==================================================================
// 棚卸し（ユーザー指摘）で発覚した4件の追加対応。
// ①UIチェック(SVG破損検出) ②日付形式そのものの不正 ③timeline points
// とweekly(sourceDates)の突き合わせ ④健康状態JSONのフラット構造。
// ==================================================================

test('①再発防止: 需給タイムラインのSVGタグ数が開始・終了で一致しなければERROR（broken_svg）', () => {
  const html = '<article><div class="credit-timeline"><div class="ctl-head">需給タイムライン</div><svg class="ctl-svg" width="1" height="1"></article>'; // </svg>が無い
  const h = computeHealthCheck({ results: [healthyResult()], todayIso: '2026-09-11', html });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'broken_svg'));
});

test('①再発防止: SVGが正しく閉じていればhtmlを渡してもERRORにならない', () => {
  const html = '<article><div class="credit-timeline"><div class="ctl-head">需給タイムライン</div><svg class="ctl-svg" width="1" height="1"></svg><div class="ctl-foot">最終信用残 9/11</div></div></article>';
  const h = computeHealthCheck({ results: [healthyResult()], todayIso: '2026-09-11', html });
  assert.equal(h.status, HEALTH_STATUS.PASS);
});

test('①再発防止: htmlを渡さなければUIチェックはスキップされる（省略可能な後方互換）', () => {
  const h = computeHealthCheck({ results: [healthyResult()], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.PASS);
});

test('②再発防止: creditAsOfの日付形式そのものが不正ならERROR（invalid_date。future_dateチェックはnullを渡されると静かに素通りしていた）', () => {
  const r = healthyResult({ creditSupplyQuality: { creditAsOf: '2026年9月11日' } }); // "26/09/18"形式ではない
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'invalid_date'));
  assert.equal(h.invalidDateCount, 1);
});

test('②再発防止: creditSupplyTimeline.points[].dateがnull（元の日付形式が不正）ならERROR', () => {
  const r = healthyResult({ creditSupplyTimeline: { points: [{ date: null, close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 }] } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.ok(h.errors.some((e) => e.code === 'invalid_date'));
});

test('③再発防止: creditSupplyTimeline.pointsの日付がsourceDates（元のweekly）に存在しなければERROR（timeline_source_mismatch）', () => {
  const r = healthyResult({
    creditSupplyTimeline: {
      points: [{ date: '2026-01-01', close: 100, buyBalance: 100, buyChangePct: 0, sellBalance: 50, sellChangePct: 0, creditRatio: 2 }],
      sourceDates: ['2026-09-04', '2026-09-11'], // 2026-01-01を含まない
    },
  });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.ERROR);
  assert.ok(h.errors.some((e) => e.code === 'timeline_source_mismatch'));
});

test('③再発防止: sourceDatesが省略されていれば突き合わせチェックはスキップされる（後方互換）', () => {
  const r = healthyResult({ creditSupplyTimeline: { sourceDates: undefined } });
  const h = computeHealthCheck({ results: [r], todayIso: '2026-09-11' });
  assert.equal(h.status, HEALTH_STATUS.PASS);
});

test('④再発防止: 健康状態JSONのカバレッジ系フィールドがトップレベルにフラットに出る（ユーザー提示例と同じ構造）', () => {
  const h = computeHealthCheck({ results: [healthyResult()], todayIso: '2026-09-11' });
  assert.equal(h.stocksChecked, 1);
  assert.equal(h.creditQualityChecked, 1);
  assert.equal(h.timelineChecked, 1);
  assert.equal(h.timelineMissing, 0);
  assert.equal(h.pendingCount, 0);
  assert.equal(h.invalidDateCount, 0);
  assert.equal(typeof h.tagCounts, 'object');
});

// indicators.mjs: creditSupplyTimeline()が実際にsourceDatesを公開しているか
// （③の突き合わせチェックが機能するための前提）。
test('③前提確認: creditSupplyTimeline()はweekly全体の日付をsourceDatesとして公開する', async () => {
  const { creditSupplyTimeline } = await import('../indicators.mjs');
  const weekly = [
    { date: '26/09/18', buy: 100, sell: 50, loanRatio: 2, close: 100 },
    { date: '26/09/11', buy: 90, sell: 45, loanRatio: 2, close: 95 },
    { date: '26/07/03', buy: 80, sell: 40, loanRatio: 2, close: 90 }, // 表示6件には入らない古い週
  ];
  const tl = creditSupplyTimeline({ weekly });
  assert.ok(tl.sourceDates.includes('2026-07-03'), '表示件数(6件)より古い週の日付もsourceDatesには含まれているべき');
  assert.ok(tl.sourceDates.includes('2026-09-18'));
});

// health_history.mjs（日次履歴の保存・読み込み）。一時ディレクトリで
// 実ファイルI/Oを検証する。
test('health_history: recordHealthSnapshot→latestPriorHealthで前日分が読み込める', async () => {
  const { recordHealthSnapshot, latestPriorHealth } = await import('../health_history.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health_test_'));
  const historyPath = path.join(dir, 'history.json');
  const latestPath = path.join(dir, 'latest.json');
  try {
    const day1 = computeHealthCheck({ results: [healthyResult()], todayIso: '2026-09-11' });
    recordHealthSnapshot('2026-09-11', day1, { historyPath, latestPath });
    const prior = latestPriorHealth('2026-09-12', historyPath);
    assert.equal(prior.status, HEALTH_STATUS.PASS);
    assert.equal(prior.coverage.creditQualityChecked, 1);
    assert.ok(fs.existsSync(latestPath));
    assert.equal(JSON.parse(fs.readFileSync(latestPath, 'utf-8')).status, HEALTH_STATUS.PASS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health_history: 同日内の再記録は上書きする（最初の1回だけ、ではない。直近の状態を保持する）', async () => {
  const { recordHealthSnapshot, loadHealthHistory } = await import('../health_history.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health_test_'));
  const historyPath = path.join(dir, 'history.json');
  const latestPath = path.join(dir, 'latest.json');
  try {
    recordHealthSnapshot('2026-09-11', { status: 'PASS', coverage: { creditQualityChecked: 1 } }, { historyPath, latestPath });
    recordHealthSnapshot('2026-09-11', { status: 'WARNING', coverage: { creditQualityChecked: 2 } }, { historyPath, latestPath });
    const hist = loadHealthHistory(historyPath);
    assert.equal(Object.keys(hist).length, 1);
    assert.equal(hist['2026-09-11'].status, 'WARNING');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latestPriorHealth: 履歴が無ければnull（新規判定を推測しない）', async () => {
  const { latestPriorHealth } = await import('../health_history.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health_test_'));
  const historyPath = path.join(dir, 'history.json');
  try {
    assert.equal(latestPriorHealth('2026-09-11', historyPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================================================================
// SCORE Shadow Check（screener.mjs/scraper.mjs側の配線）とProduction
// Health Checkのscraper.mjs main()への配線。ソースコード検査で固定する
// （main()を実際に呼ぶには実ネットワークアクセスを伴うため）。
// ==================================================================

const root = path.dirname(new URL(import.meta.url).pathname).replace(/\/test$/, '');

test('screener.mjs: SUPPLY_QUALITY_SHADOW_KEYSを使ってbuyScoreをもう一度計算し、scoreInvariantOkとしてresults.pushに含めている', () => {
  const src = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8');
  assert.ok(src.includes('SUPPLY_QUALITY_SHADOW_KEYS'), 'SUPPLY_QUALITY_SHADOW_KEYSが使われていません');
  assert.ok(src.includes('buyScoreShadow'), 'shadow側のbuyScore計算が見つかりません');
  assert.ok(src.includes('scoreInvariantOk,'), 'scoreInvariantOkがresults.pushに含まれていません');
});

test('scraper.mjs: attachScores内でもSUPPLY_QUALITY_SHADOW_KEYSを使ったshadow計算を行っている（rをまるごと受け取る設計のため、ここが本命のチェック地点）', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  const attachScoresStart = src.indexOf('const attachScores = (results) => results.map((r) => {');
  const attachScoresEnd = src.indexOf('\n  });', attachScoresStart);
  const fn = src.slice(attachScoresStart, attachScoresEnd);
  assert.ok(fn.includes('SUPPLY_QUALITY_SHADOW_KEYS'), 'attachScores内でSUPPLY_QUALITY_SHADOW_KEYSが使われていません');
  assert.ok(fn.includes('scoreInvariantOk'), 'attachScores内でscoreInvariantOkが計算・付与されていません');
});

test('scraper.mjs: main()はcomputeHealthCheckの結果を使い、ERRORならindex.htmlの書き込み前にprocess.exit(1)する', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  const writeIdx = src.indexOf('fs.writeFileSync(OUT_FILE, html);');
  const healthCheckIdx = src.indexOf('computeHealthCheck({');
  const exitIdx = src.indexOf("health?.status === HEALTH_STATUS.ERROR");
  assert.ok(healthCheckIdx !== -1, 'computeHealthCheckの呼び出しが見つかりません');
  assert.ok(exitIdx !== -1, 'ERROR時のprocess.exit(1)分岐が見つかりません');
  assert.ok(healthCheckIdx < writeIdx, 'Health Checkがindex.html書き込みより後に呼ばれています（書き込み前にチェックすべき）');
  assert.ok(exitIdx < writeIdx, 'ERROR時のprocess.exit(1)判定がindex.html書き込みより後にあります');
  assert.ok(src.includes('recordHealthSnapshot('), 'recordHealthSnapshotが呼ばれていません（health_historyへの保存漏れ）');
});
