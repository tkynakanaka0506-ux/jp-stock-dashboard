// 第9優先改修（ユーザー提案）: 既存のSUPPLY_CREDIT（信用倍率・信用買い
// 残の「残高の絶対量」中心の判定）を、「残高×価格×出来高の変化」を見る
// 判定へ拡張する。Phase1は「信用買残の重さ」（buyPressureDays/
// buyPressureValueDays）のみ。buyChangePct/sellChangePctは既存の
// creditTrend/shortTrend（lookback=1）をそのまま再利用するため新規
// 関数は追加しない（indicators.mjs参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditBuyPressureDays, creditTrend, shortTrend, CREDIT_BUY_PRESSURE, creditPatternSignal, bounceQualitySignal, lowBreakBuyBuildupSignal, LOW_BREAK_BUY_BUILDUP, CHIP_SIGNAL_FIELDS, creditSupplyQualitySignal, clusterConfirmation } from '../indicators.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');

const makeSeries = (n, startClose, vol) => {
  const closes = Array.from({ length: n }, (_, i) => startClose + i);
  const volumes = Array.from({ length: n }, () => vol);
  return { closes, volumes };
};

test('creditBuyPressureDays: 信用買残 ÷ 20日平均出来高（実測どおりの計算）', () => {
  const { closes, volumes } = makeSeries(20, 1000, 100_000);
  const r = creditBuyPressureDays({ creditBuyBalance: 500_000, price: closes.at(-1), closes, volumes });
  assert.equal(r.checked, true);
  assert.equal(r.days, 5);
  assert.equal(r.valueDays, 5.05);
  assert.ok(r.note.includes('20日平均出来高'));
});

test('creditBuyPressureDays: closes/volumesが20日未満ならchecked:false（未確認、推測しない）', () => {
  const { closes, volumes } = makeSeries(10, 1000, 100_000);
  const r = creditBuyPressureDays({ creditBuyBalance: 500_000, price: 1000, closes, volumes });
  assert.equal(r.checked, false);
  assert.equal(r.days, null);
  assert.equal(r.valueDays, null);
});

test('creditBuyPressureDays: creditBuyBalanceが無ければchecked:false', () => {
  const { closes, volumes } = makeSeries(20, 1000, 100_000);
  const r = creditBuyPressureDays({ creditBuyBalance: null, price: 1000, closes, volumes });
  assert.equal(r.checked, false);
});

test('creditBuyPressureDays: priceが無くてもdaysは計算できる（valueDaysのみnull）', () => {
  const { closes, volumes } = makeSeries(20, 1000, 100_000);
  const r = creditBuyPressureDays({ creditBuyBalance: 500_000, closes, volumes });
  assert.equal(r.checked, true);
  assert.equal(r.days, 5);
  assert.equal(r.valueDays, null);
});

test('creditBuyPressureDays: CREDIT_BUY_PRESSURE.avgDaysは20日（固定閾値として決め打ちしているのはこの平均日数のみで、日数の帯分けは行わない）', () => {
  assert.equal(CREDIT_BUY_PRESSURE.avgDays, 20);
});

// buyChangePct/sellChangePctは既存関数の再利用で足りることの確認
// （新しい関数を作らない、という第9優先改修の調査結果どおり）。
test('buyChangePct相当: creditTrend(weekly, 1) で直近週 vs 前回週の信用買い残変化率が取れる', () => {
  const weekly = [{ buy: 90_000, sell: 10_000 }, { buy: 100_000, sell: 10_000 }];
  assert.equal(creditTrend(weekly, 1), -10);
});

test('sellChangePct相当: shortTrend(weekly, 1) で直近週 vs 前回週の信用売り残変化率が取れる', () => {
  const weekly = [{ buy: 90_000, sell: 12_000 }, { buy: 100_000, sell: 10_000 }];
  assert.equal(shortTrend(weekly, 1), 20);
});

// Phase2: 「株価×信用買残」4パターン（ユーザー提案②）。
test('creditPatternSignal: 株価↓・買残↓ ＝ CLEANUP（買残整理）', () => {
  const r = creditPatternSignal({ priceChangePct: -3, buyChangePct: -10 });
  assert.equal(r.checked, true);
  assert.equal(r.pattern, 'CLEANUP');
  assert.equal(r.label, '買残整理');
});

test('creditPatternSignal: 株価↓・買残↑ ＝ OVERHANG_BUILDUP（買残積み上がり）', () => {
  const r = creditPatternSignal({ priceChangePct: -3, buyChangePct: 10 });
  assert.equal(r.pattern, 'OVERHANG_BUILDUP');
  assert.equal(r.label, '買残積み上がり');
});

test('creditPatternSignal: 株価↑・買残↓ ＝ SUPPLY_IMPROVING（需給改善）', () => {
  const r = creditPatternSignal({ priceChangePct: 3, buyChangePct: -10 });
  assert.equal(r.pattern, 'SUPPLY_IMPROVING');
  assert.equal(r.label, '需給改善');
});

test('creditPatternSignal: 株価↑・買残↑ ＝ LEVERAGED_RISE（買残増加上昇）', () => {
  const r = creditPatternSignal({ priceChangePct: 3, buyChangePct: 10 });
  assert.equal(r.pattern, 'LEVERAGED_RISE');
  assert.equal(r.label, '買残増加上昇');
});

test('creditPatternSignal: ちょうど0%は「上昇/増加」側として扱う（境界を曖昧にしない決め）', () => {
  const r = creditPatternSignal({ priceChangePct: 0, buyChangePct: 0 });
  assert.equal(r.pattern, 'LEVERAGED_RISE');
});

test('creditPatternSignal: どちらかが未取得ならchecked:false（推測しない）', () => {
  assert.equal(creditPatternSignal({ priceChangePct: null, buyChangePct: 10 }).checked, false);
  assert.equal(creditPatternSignal({ priceChangePct: 3, buyChangePct: null }).checked, false);
});

test('creditPatternSignal: この段階ではlevel（good/bad等）を持たない（価値判断はPhase5の統合方針で決める）', () => {
  const r = creditPatternSignal({ priceChangePct: 3, buyChangePct: -10 });
  assert.equal('level' in r, false);
});

// Phase2時点ではscreener.mjsにcreditPattern単体を配線していたが、Phase5
// でcreditSupplyQualitySignalに統合されたため、個別配線の確認テストは
// 末尾のPhase5セクションに置き換えた（creditPatternSignal自体は
// creditSupplyQualitySignalの内部実装として引き続き使われている）。

// Phase3: 「反発の質」（ユーザー提案③）。
test('bounceQualitySignal: 株価↑・買残↓・出来高確認 ＝ IMPROVING（信用整理を伴う反発）', () => {
  const r = bounceQualitySignal({ priceChangePct: 3, buyChangePct: -10, volRatio: 2.5 });
  assert.equal(r.checked, true);
  assert.equal(r.bounceQuality, 'IMPROVING');
});

test('bounceQualitySignal: 株価↑・買残↑（積み上がり） ＝ WEAK（信用整理を伴わない反発）', () => {
  const r = bounceQualitySignal({ priceChangePct: 3, buyChangePct: 5, volRatio: 0.8 });
  assert.equal(r.bounceQuality, 'WEAK');
  assert.ok(r.note.includes('減少しておらず'));
});

test('bounceQualitySignal: 株価↑・買残↓だが出来高が伴わない ＝ WEAK（出来高で裏付けが取れていない）', () => {
  const r = bounceQualitySignal({ priceChangePct: 3, buyChangePct: -10, volRatio: 0.9 });
  assert.equal(r.bounceQuality, 'WEAK');
  assert.ok(r.note.includes('出来高の増加が伴っていません'));
});

test('bounceQualitySignal: 株価が反発局面でなければ（0%以下）判定対象外（checked:trueでbounceQuality:null）', () => {
  const r = bounceQualitySignal({ priceChangePct: -1, buyChangePct: -10, volRatio: 2.5 });
  assert.equal(r.checked, true);
  assert.equal(r.bounceQuality, null);
});

test('bounceQualitySignal: priceChangePct/buyChangePctが未取得ならchecked:false（推測しない）', () => {
  assert.equal(bounceQualitySignal({ priceChangePct: null, buyChangePct: -10 }).checked, false);
  assert.equal(bounceQualitySignal({ priceChangePct: 3, buyChangePct: null }).checked, false);
});

test('bounceQualitySignal: volRatio未取得でも判定は成立する（IMPROVINGにはならないがWEAKとして判定できる）', () => {
  const r = bounceQualitySignal({ priceChangePct: 3, buyChangePct: -10, volRatio: null });
  assert.equal(r.checked, true);
  assert.equal(r.bounceQuality, 'WEAK');
});

// Phase2と同様、Phase5でcreditSupplyQualitySignalに統合されたため、
// 個別配線の確認テストは末尾のPhase5セクションに置き換えた。

// Phase4: 「安値更新×買残増加」（ユーザー提案④、独立フラグ）。
const monotonicDecline20 = Array.from({ length: 20 }, (_, i) => 1100 - i); // 単調下落、直近5日以内が期間最安値
const vShape20 = [
  1100, 1090, 1080, 1070, 1060, 1050, 1040, 1030, 1020, 1010, 1000, // 10本目(=直近から10本前)が最安値1000
  1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100,
];

test('LOW_BREAK_BUY_BUILDUP: 新安値の判定窓は20営業日（ユーザー確認済み）', () => {
  assert.equal(LOW_BREAK_BUY_BUILDUP.lowWindowDays, 20);
});

test('lowBreakBuyBuildupSignal: 直近5営業日以内に20日安値を更新し、信用買い残も増加 ＝ true（下がるたびに信用買いが入っている）', () => {
  const r = lowBreakBuyBuildupSignal({ closes: monotonicDecline20, buyChangePct: 5 });
  assert.equal(r.checked, true);
  assert.equal(r.lowBreakBuyBuildUp, true);
});

test('lowBreakBuyBuildupSignal: 20日安値を更新したが信用買い残は増加していない ＝ false', () => {
  const r = lowBreakBuyBuildupSignal({ closes: monotonicDecline20, buyChangePct: -5 });
  assert.equal(r.checked, true);
  assert.equal(r.lowBreakBuyBuildUp, false);
});

test('lowBreakBuyBuildupSignal: 直近5営業日以内が期間最安値でなければ（V字回復済み）、信用買い残が増加していてもfalse', () => {
  const r = lowBreakBuyBuildupSignal({ closes: vShape20, buyChangePct: 5 });
  assert.equal(r.checked, true);
  assert.equal(r.lowBreakBuyBuildUp, false);
  assert.equal(r.note, null);
});

test('lowBreakBuyBuildupSignal: closesが20日未満、またはbuyChangePct未取得ならchecked:false（推測しない）', () => {
  assert.equal(lowBreakBuyBuildupSignal({ closes: monotonicDecline20.slice(-10), buyChangePct: 5 }).checked, false);
  assert.equal(lowBreakBuyBuildupSignal({ closes: monotonicDecline20, buyChangePct: null }).checked, false);
});

// Phase2/3と同様、Phase5でcreditSupplyQualitySignalに統合されたため、
// 個別配線の確認テストは末尾のPhase5セクションに置き換えた。

// ==================================================================
// Phase5: 統合（ユーザー提案）。Phase1〜4をcreditSupplyQualitySignalに
// まとめ、SUPPLY_CREDITクラスタへlevel:'good'時のみ1件加算する。
// ==================================================================

const risingWeekly = [{ date: '26/09/18', buy: 90_000, sell: 10_000 }, { date: '26/09/11', buy: 100_000, sell: 10_000 }];
const buildupWeekly = [{ date: '26/09/18', buy: 110_000, sell: 10_000 }, { date: '26/09/11', buy: 100_000, sell: 10_000 }];

test('creditSupplyQualitySignal: 株価↑・買残↓ ＝ pattern:SUPPLY_IMPROVING・level:good', () => {
  const { closes, volumes } = makeSeries(20, 1000, 100_000);
  const risingCloses = closes.map((c, i) => c + i); // 直近ほど高い＝株価上昇
  const r = creditSupplyQualitySignal({
    weekly: risingWeekly, closes: risingCloses, volumes, price: risingCloses.at(-1),
    loanRatio: 3.5, today: '2026-09-18',
  });
  assert.equal(r.pattern, 'SUPPLY_IMPROVING');
  assert.equal(r.level, 'good');
  assert.equal(r.buyBalance, 90_000);
  assert.equal(r.buyBalancePrior, 100_000);
  assert.equal(r.buyChangePct, -10);
  assert.equal(r.sellBalance, 10_000);
  assert.equal(r.creditRatio, 3.5);
  assert.ok(Number.isFinite(r.buyPressureDays));
  assert.equal(r.creditAsOf, '26/09/18');
  assert.ok(Array.isArray(r.reasonCodes) && r.reasonCodes.includes('CREDIT_PATTERN_SUPPLY_IMPROVING'));
});

test('creditSupplyQualitySignal: 株価↓・買残↑ ＝ pattern:OVERHANG_BUILDUP・level:warn', () => {
  const { volumes } = makeSeries(20, 1000, 100_000);
  const fallingCloses = Array.from({ length: 20 }, (_, i) => 1020 - i); // 単調下落
  const r = creditSupplyQualitySignal({
    weekly: buildupWeekly, closes: fallingCloses, volumes, price: fallingCloses.at(-1),
    loanRatio: 3.5, today: '2026-09-18',
  });
  assert.equal(r.pattern, 'OVERHANG_BUILDUP');
  assert.equal(r.level, 'warn');
});

test('creditSupplyQualitySignal: creditDataAgeDaysは信用残発表日(creditAsOf)からtodayまでの日数', () => {
  const { closes, volumes } = makeSeries(20, 1000, 100_000);
  const r = creditSupplyQualitySignal({ weekly: risingWeekly, closes, volumes, price: 1000, today: '2026-09-25' });
  assert.equal(r.creditDataAgeDays, 7); // 26/09/18 → 2026-09-25
});

test('creditSupplyQualitySignal: 固定の日数を決め打ちせず、銘柄自身の過去の発表間隔を超えて未発表ならPENDING（株価↑・出来高↑が前提）', () => {
  // volumeRatioはperiod+1(=21)本必要。直近1本だけ急増させ、20日平均比3倍にする。
  const volumes = [...Array.from({ length: 20 }, () => 100_000), 300_000];
  const risingCloses = Array.from({ length: 21 }, (_, i) => 1000 + i * 5); // はっきりした上昇
  // risingWeeklyの発表間隔は26/09/11→26/09/18の7日。todayを26/09/30にすると
  // 12日経過（7日を超過）＝次回発表が既に来ていておかしくない古さ。
  const r = creditSupplyQualitySignal({
    weekly: risingWeekly, closes: risingCloses, volumes, price: risingCloses.at(-1), today: '2026-09-30',
  });
  assert.equal(r.creditDataAgeDays, 12);
  assert.equal(r.bounceQuality, 'PENDING');
});

test('creditSupplyQualitySignal: 発表間隔内（未経過）ならPENDINGにならない（通常どおりIMPROVING/WEAKを返す）', () => {
  const { volumes } = makeSeries(20, 1000, 300_000);
  const risingCloses = Array.from({ length: 20 }, (_, i) => 1000 + i * 5);
  const r = creditSupplyQualitySignal({
    weekly: risingWeekly, closes: risingCloses, volumes, price: risingCloses.at(-1), today: '2026-09-20', // 26/09/18から2日後、発表間隔7日以内
  });
  assert.notEqual(r.bounceQuality, 'PENDING');
});

test('creditSupplyQualitySignal: lowBreakBuyBuildUpがtrueならlevel:warn・reasonCodesにLOW_BREAK_BUY_BUILDUPを含む', () => {
  const decliningCloses = Array.from({ length: 20 }, (_, i) => 1100 - i); // 単調下落＝直近5日以内が20日安値
  const { volumes } = makeSeries(20, 1000, 100_000);
  const r = creditSupplyQualitySignal({
    weekly: buildupWeekly, closes: decliningCloses, volumes, price: decliningCloses.at(-1), today: '2026-09-18',
  });
  assert.equal(r.lowBreakBuyBuildUp, true);
  assert.equal(r.level, 'warn');
  assert.ok(r.reasonCodes.includes('LOW_BREAK_BUY_BUILDUP'));
});

test('creditSupplyQualitySignal: weeklyが空/未取得ならchecked:false', () => {
  const r = creditSupplyQualitySignal({ weekly: [], closes: null, volumes: null, today: '2026-09-18' });
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('CHIP_SIGNAL_FIELDS: creditSupplyQualityを含まない（SCOREへの新規加点はまだ行わない）', () => {
  assert.equal(CHIP_SIGNAL_FIELDS.includes('creditSupplyQuality'), false);
});

test('screener.mjs: creditSupplyQualityをresults.push()の表示フィールドとして公開しているが、riskPenaltyInputsには渡していない（旧creditPattern/bounceQuality/lowBreakBuyBuildupの個別配線はPhase5で統合済み）', () => {
  const src = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8');
  const pushBlockStart = src.indexOf('results.push({');
  const pushBlockEnd = src.indexOf('\n    });', pushBlockStart);
  const pushBlock = src.slice(pushBlockStart, pushBlockEnd);
  assert.ok(pushBlock.includes('creditSupplyQuality,'), 'results.push()にcreditSupplyQualityが含まれていません');
  assert.ok(!pushBlock.includes('creditPattern,'), '旧creditPatternの個別配線が残っています（Phase5で統合したはず）');
  assert.ok(!pushBlock.includes('bounceQuality,'), '旧bounceQualityの個別配線が残っています（Phase5で統合したはず）');
  assert.ok(!pushBlock.includes('lowBreakBuyBuildup,'), '旧lowBreakBuyBuildupの個別配線が残っています（Phase5で統合したはず）');

  const riskInputsMatch = src.match(/const riskPenaltyInputs = \{[\s\S]*?\};/);
  assert.ok(!riskInputsMatch[0].includes('creditSupplyQuality'), 'creditSupplyQualityがriskPenaltyInputsに紛れ込んでいます（スコアに影響してはいけない）');
});

test('clusterConfirmation: creditSupplyQuality.level===goodのときだけSUPPLY_CREDITクラスタに1件加算される（1クラスタ1回のルールを維持）', () => {
  const base = { loanRatio: 50 }; // MARGIN_OVERHANG.heavy(10)以上なのでloanRatioヒットは発生しない
  const withGood = clusterConfirmation({ ...base, creditSupplyQuality: { level: 'good' } });
  assert.ok(withGood.clusters.SUPPLY_CREDIT.includes('creditSupplyQuality'));
  assert.equal(withGood.independentClusterCount, 1); // SUPPLY_CREDITクラスタとして1件のみ

  const withWarn = clusterConfirmation({ ...base, creditSupplyQuality: { level: 'warn' } });
  assert.ok(!withWarn.clusters.SUPPLY_CREDIT.includes('creditSupplyQuality'), 'level:warnはヒットに数えない（goodのときだけ）');
});
