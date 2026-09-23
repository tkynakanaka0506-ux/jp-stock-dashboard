// 第9優先改修（ユーザー提案）: 既存のSUPPLY_CREDIT（信用倍率・信用買い
// 残の「残高の絶対量」中心の判定）を、「残高×価格×出来高の変化」を見る
// 判定へ拡張する。Phase1は「信用買残の重さ」（buyPressureDays/
// buyPressureValueDays）のみ。buyChangePct/sellChangePctは既存の
// creditTrend/shortTrend（lookback=1）をそのまま再利用するため新規
// 関数は追加しない（indicators.mjs参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditBuyPressureDays, creditTrend, shortTrend, CREDIT_BUY_PRESSURE, creditPatternSignal, bounceQualitySignal, lowBreakBuyBuildupSignal, LOW_BREAK_BUY_BUILDUP, CHIP_SIGNAL_FIELDS, creditSupplyQualitySignal, clusterConfirmation, creditSupplyTags, CREDIT_SUPPLY_TAGS, buyPressureBandLabel, creditSupplyTimeline } from '../indicators.mjs';
import { creditSupplyQualityBlock, creditFilterBar, creditSupplyTimelineBlock } from '../scraper.mjs';
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

// ==================================================================
// Phase6: カード表示（ユーザー提案）。creditSupplyQualityBlockは
// scraper.mjs側でcreditSupplyQualitySignalの結果をそのまま表示する
// だけで、新しい判定ロジックは持たない。
// ==================================================================

const fullCreditSupplyQuality = {
  checked: true,
  pattern: 'SUPPLY_IMPROVING',
  bounceQuality: 'IMPROVING',
  buyBalance: 1_240_000, buyBalancePrior: 1_516_136, buyChangePct: -18.2,
  sellBalance: 62_000, sellBalancePrior: 65_300, sellChangePct: -5.1,
  creditRatio: 20.0,
  buyPressureDays: 0.45, buyPressureValueDays: 0.52,
  avgVolumeRatio: 1.34,
  lowBreakBuyBuildUp: false,
  creditAsOf: '26/09/18', creditDataAgeDays: 4,
  reasonCodes: ['CREDIT_PATTERN_SUPPLY_IMPROVING', 'BOUNCE_QUALITY_IMPROVING'],
};

test('creditSupplyQualityBlock: checked:falseまたはデータ無しなら空文字（カードに何も表示しない）', () => {
  assert.equal(creditSupplyQualityBlock({}), '');
  assert.equal(creditSupplyQualityBlock({ creditSupplyQuality: { checked: false } }), '');
});

test('creditSupplyQualityBlock: 買残・売残・信用倍率・買残負担・最終信用残を表示する', () => {
  const html = creditSupplyQualityBlock({ creditSupplyQuality: fullCreditSupplyQuality });
  assert.ok(html.includes('信用需給'));
  assert.ok(html.includes('1,240,000株'));
  assert.ok(html.includes('▼18.2%'));
  assert.ok(html.includes('62,000株'));
  assert.ok(html.includes('20倍'));
  assert.ok(html.includes('0.45日'));
  assert.ok(html.includes('軽い')); // buyPressureDays<0.5 の帯ラベル
  assert.ok(html.includes('9/18')); // creditAsOfの短縮表示（26/09/18→9/18）
});

test('creditSupplyQualityBlock: 需給変化（4パターン）を矢印付きで表示する', () => {
  const html = creditSupplyQualityBlock({ creditSupplyQuality: fullCreditSupplyQuality });
  assert.ok(html.includes('需給変化'));
  assert.ok(html.includes('株価 ↑ × 買残 ↓'));
  assert.ok(html.includes('→ 需給改善'));
});

test('creditSupplyQualityBlock: 反発品質（IMPROVING）を出来高倍率付きで表示する', () => {
  const html = creditSupplyQualityBlock({ creditSupplyQuality: fullCreditSupplyQuality });
  assert.ok(html.includes('反発品質'));
  assert.ok(html.includes('出来高 1.34×'));
});

test('creditSupplyQualityBlock: bounceQuality:PENDINGは「信用データ未反映（確認中）」と表示する（実際に信用整理が進んだと誤解させない）', () => {
  const html = creditSupplyQualityBlock({ creditSupplyQuality: { ...fullCreditSupplyQuality, bounceQuality: 'PENDING' } });
  assert.ok(html.includes('信用データ未反映'));
});

test('buyPressureBandLabel相当: 0.45日→軽い/0.99日→やや重い/1.77日→重い（ユーザー提示の3例、SCORE閾値ではなく表示用の帯）', () => {
  const at = (days) => creditSupplyQualityBlock({ creditSupplyQuality: { ...fullCreditSupplyQuality, buyPressureDays: days } });
  assert.ok(at(0.45).includes('軽い'));
  assert.ok(at(0.99).includes('やや重い'));
  assert.ok(at(1.77).includes('重い') && !at(1.77).includes('やや重い'));
});

test('card()（AMBUSHカード）にcreditSupplyQualityBlockが配線されている', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  const cardFnStart = src.indexOf('function card(r, i, opts = {}) {');
  const cardFnEnd = src.indexOf('\nfunction ', cardFnStart + 1);
  const cardFn = src.slice(cardFnStart, cardFnEnd === -1 ? cardFnStart + 3000 : cardFnEnd);
  assert.ok(cardFn.includes('creditSupplyQualityBlock(r)'), 'card()にcreditSupplyQualityBlockが配線されていません');
});

// ==================================================================
// Phase6続き: 信用需給タグのワンタップ絞り込み（ユーザー提案）。
// creditSupplyTagsは既存のcreditSupplyQualitySignalの結果をラベル化
// するだけで、新しい判定基準は作らない。
// ==================================================================

test('CREDIT_SUPPLY_TAGSは6種類（需給改善/買残整理/買残積み上がり/信用買い重い/買残増加上昇/安値更新＋買残増）', () => {
  assert.deepEqual(CREDIT_SUPPLY_TAGS, ['需給改善', '買残整理', '買残積み上がり', '信用買い重い', '買残増加上昇', '安値更新＋買残増']);
});

test('creditSupplyTags: データ無しなら空配列', () => {
  assert.deepEqual(creditSupplyTags({}), []);
  assert.deepEqual(creditSupplyTags({ creditSupplyQuality: { checked: false } }), []);
});

test('creditSupplyTags: pattern:SUPPLY_IMPROVING ＝「需給改善」', () => {
  const tags = creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'SUPPLY_IMPROVING', buyPressureDays: 0.3 } });
  assert.deepEqual(tags, ['需給改善']);
});

test('creditSupplyTags: bounceQuality:IMPROVINGだけでも「需給改善」がつく（patternがLEVERAGED_RISEでも）', () => {
  const tags = creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'LEVERAGED_RISE', bounceQuality: 'IMPROVING', buyPressureDays: 0.3 } });
  assert.ok(tags.includes('需給改善'));
  assert.ok(tags.includes('買残増加上昇'));
});

test('creditSupplyTags: pattern:CLEANUP ＝「買残整理」、OVERHANG_BUILDUP ＝「買残積み上がり」', () => {
  assert.deepEqual(creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'CLEANUP', buyPressureDays: 0.3 } }), ['買残整理']);
  assert.deepEqual(creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'OVERHANG_BUILDUP', buyPressureDays: 0.3 } }), ['買残積み上がり']);
});

test('creditSupplyTags: buyPressureDays>1.0（帯:重い）＝「信用買い重い」が独立して付く（pattern問わず併存しうる）', () => {
  const tags = creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'CLEANUP', buyPressureDays: 1.77 } });
  assert.deepEqual(tags.sort(), ['信用買い重い', '買残整理'].sort());
});

test('creditSupplyTags: lowBreakBuyBuildUp:true ＝「安値更新＋買残増」が独立して付く', () => {
  const tags = creditSupplyTags({ creditSupplyQuality: { checked: true, pattern: 'OVERHANG_BUILDUP', lowBreakBuyBuildUp: true, buyPressureDays: 0.3 } });
  assert.ok(tags.includes('安値更新＋買残増'));
  assert.ok(tags.includes('買残積み上がり'));
});

test('creditFilterBar: 6タグ全部をボタンとして出力し、toggleCreditFilterに接続している', () => {
  const html = creditFilterBar();
  for (const t of CREDIT_SUPPLY_TAGS) {
    assert.ok(html.includes(`toggleCreditFilter('${t}')`), `タグ「${t}」のボタンが見つかりません`);
  }
  assert.ok(html.includes('clearCreditFilter()'));
});

test('card(): data-credit-tags属性にcreditSupplyTags(r)の結果を埋め込んでいる（JSフィルタが参照する属性）', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  assert.ok(src.includes('data-credit-tags="${esc(creditTags.join(\',\'))}"'), 'card()にdata-credit-tags属性が見つかりません');
  const cardFnStart = src.indexOf('export function card(r, i, opts = {}) {');
  const cardFnEnd = src.indexOf('\nfunction ', cardFnStart + 1);
  const cardFn = src.slice(cardFnStart, cardFnEnd);
  assert.ok(cardFn.includes('creditSupplyTags(r)'), 'card()がcreditSupplyTags(r)を呼んでいません');
});

test('main()テンプレートにcreditFilterBar()が配線されている（絞り込みバーがページに表示される）', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  assert.ok(src.includes('${creditFilterBar()}'), 'creditFilterBar()がページテンプレートに配線されていません');
});

test('JS: toggleCreditFilter/clearCreditFilterがwindowに公開され、#desktop-view .cardの表示/非表示を切り替える', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  const scriptStart = src.indexOf('<script>\n// 第9優先改修 Phase6');
  assert.ok(scriptStart !== -1, '信用需給フィルタ用のJSブロックが見つかりません');
  const scriptEnd = src.indexOf('</script>', scriptStart);
  const js = src.slice(scriptStart, scriptEnd);
  assert.ok(js.includes('window.toggleCreditFilter'));
  assert.ok(js.includes('window.clearCreditFilter'));
  assert.ok(js.includes("querySelectorAll('#desktop-view .card')"));
  assert.ok(js.includes('card.dataset.creditTags'), 'JS側がdata-credit-tags属性（DOMではdataset.creditTags）を参照していません');
});

// ==================================================================
// Phase6 ④: 需給タイムライン（ユーザー提案、項目1〜14）。
// creditSupplyTimelineはcreditSupplyQualitySignalに新しいロジックを
// 足さず、UI表示用に整形するだけの純粋関数（項目12）。必須テスト
// CASE A〜J（項目14）をそのまま実装する。
// ==================================================================

// 6件+古い方の前回比算出用に1件多い、実測に近い週次信用残フィクスチャ
// （新しい週が先頭。買残は古→新で単調減少＝需給改善、株価もおおむね
// 上昇。26/08/28は終値欠損＝CASE C用）。
const timelineWeekly = [
  { date: '26/09/18', buy: 1_240_000, sell: 62_000, loanRatio: 20.0, close: 3420 },
  { date: '26/09/11', buy: 1_320_000, sell: 65_000, loanRatio: 20.3, close: 3350 },
  { date: '26/09/04', buy: 1_400_000, sell: 68_000, loanRatio: 20.6, close: 3280 },
  { date: '26/08/28', buy: 1_460_000, sell: 70_000, loanRatio: 20.9, close: null },
  { date: '26/08/21', buy: 1_500_000, sell: 72_000, loanRatio: 21.2, close: 3150 },
  { date: '26/08/07', buy: 1_550_000, sell: 74_000, loanRatio: 21.5, close: 3050 },
  { date: '26/07/31', buy: 1_600_000, sell: 76_000, loanRatio: 21.8, close: 2990 },
];

test('CASE A: weeklyが6件以上あれば6点を古い→新しいの順で返す（最新点はweekly[0]と一致）', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly });
  assert.equal(tl.checked, true);
  assert.equal(tl.points.length, 6);
  assert.equal(tl.points[0].date, '2026-08-07'); // 最も古い
  assert.equal(tl.points.at(-1).date, '2026-09-18'); // 最新
  assert.equal(tl.points.at(-1).buyBalance, 1_240_000);
  assert.equal(tl.latestDate, '2026-09-18');
});

test('CASE B: weeklyが4件しかなければ4点だけ表示する（推測で埋めない）', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly.slice(0, 4) });
  assert.equal(tl.points.length, 4);
  assert.equal(tl.points[0].date, '2026-08-28'); // 4件しかないので最も古いのはこれ
  assert.equal(tl.points.at(-1).date, '2026-09-18');
});

test('CASE C: 株価データが欠損している週はclose:null（前後の値で補完しない）', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly });
  const missing = tl.points.find((p) => p.date === '2026-08-28');
  assert.equal(missing.close, null);
  // 前後の値(3150/3280)を使って補間していないことも明示的に確認
  assert.notEqual(missing.close, 3150);
  assert.notEqual(missing.close, 3280);
});

test('CASE D: 買残の増減がバーの高さに正しく反映される（買残が多い週ほどバーが高い）', () => {
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: creditSupplyTimeline({ weekly: timelineWeekly }) });
  const heights = [...html.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(heights.length, 6);
  // buyBalanceは古い→新しいで単調減少なので、バーの高さも単調減少するはず
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] <= heights[i - 1], `バーの高さが単調減少になっていません（${heights.join(',')}）`);
  }
  // 最大値(1,550,000、最古点)は正規化の基準なので最大高さになるはず
  assert.equal(heights[0], Math.max(...heights));
});

test('CASE E: 株価↓・買残↑（直近週）なら既存OVERHANG_BUILDUPの表示と矛盾しない', () => {
  const weekly = [
    { date: '26/09/18', buy: 1_600_000, sell: 74_000, loanRatio: 21.5, close: 2990 },
    { date: '26/09/11', buy: 1_500_000, sell: 72_000, loanRatio: 21.2, close: 3150 },
    { date: '26/09/04', buy: 1_400_000, sell: 68_000, loanRatio: 20.6, close: 3280 },
  ];
  const closes = Array.from({ length: 20 }, (_, i) => 3280 - i); // 20日平均出来高計算用（下落トレンド）
  const volumes = Array.from({ length: 20 }, () => 100_000);
  const cs = creditSupplyQualitySignal({ weekly, closes, volumes, price: 2990, today: '2026-09-18' });
  assert.equal(cs.pattern, 'OVERHANG_BUILDUP');
  const tl = creditSupplyTimeline({ weekly, creditSupplyQuality: cs });
  assert.ok(tl.tags.includes('買残積み上がり'));
  // タイムライン側の直近点の生データも同じ方向（買残↑）を示している
  const latest = tl.points.at(-1);
  assert.ok(latest.buyChangePct > 0);
});

test('CASE F: 株価↑・買残↓（直近週）なら既存SUPPLY_IMPROVINGと整合する', () => {
  const cs = creditSupplyQualitySignal({
    weekly: timelineWeekly, closes: Array.from({ length: 20 }, (_, i) => 3200 + i), volumes: Array.from({ length: 20 }, () => 100_000),
    price: 3420, today: '2026-09-18',
  });
  assert.equal(cs.pattern, 'SUPPLY_IMPROVING');
  const tl = creditSupplyTimeline({ weekly: timelineWeekly, creditSupplyQuality: cs });
  assert.ok(tl.tags.includes('需給改善'));
  const latest = tl.points.at(-1);
  assert.ok(latest.buyChangePct < 0);
});

test('CASE G: データが古い(PENDING)場合はタイムラインを表示したままPENDINGも示す（データ不足扱いにしない）', () => {
  const volumes = [...Array.from({ length: 20 }, () => 100_000), 300_000];
  const closes = Array.from({ length: 21 }, (_, i) => 3000 + i * 10);
  const cs = creditSupplyQualitySignal({
    weekly: timelineWeekly, closes, volumes, price: closes.at(-1), today: '2026-09-30', // 26/09/18から12日後、発表間隔7日を超過
  });
  assert.equal(cs.bounceQuality, 'PENDING');
  assert.equal(cs.isStale, true);
  const tl = creditSupplyTimeline({ weekly: timelineWeekly, creditSupplyQuality: cs });
  assert.equal(tl.checked, true);
  assert.equal(tl.pending, true);
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  assert.ok(html.includes('PENDING'));
  assert.ok(html.includes('ctl-svg')); // チャート自体は表示され続ける
  assert.ok(!html.includes('データ不足'));
});

test('CASE H: checked:falseならチャートを生成せず「データ不足」だけ表示する', () => {
  const tl = creditSupplyTimeline({ weekly: [] });
  assert.equal(tl.checked, false);
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  assert.ok(html.includes('データ不足'));
  assert.ok(!html.includes('ctl-svg'));
  assert.ok(!html.includes('<rect'));
});

test('CASE H(補足): creditSupplyTimeline自体が無い（r.creditSupplyTimeline未定義）場合も同様に「データ不足」', () => {
  const html = creditSupplyTimelineBlock({});
  assert.ok(html.includes('データ不足'));
});

test('CASE I: 需給タイムラインを追加してもSCOREは1点も変わらない（creditSupplyTimelineがSCORE計算経路に一切登場しない）', () => {
  const src = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8');
  const riskInputsMatch = src.match(/const riskPenaltyInputs = \{[\s\S]*?\};/);
  const buildScoreMatch = src.match(/buildScoreParts\(\{[\s\S]*?\}\)/);
  assert.ok(!riskInputsMatch[0].includes('creditSupplyTimeline'), 'creditSupplyTimelineがriskPenaltyInputsに紛れ込んでいます');
  assert.ok(!buildScoreMatch[0].includes('creditSupplyTimeline'), 'creditSupplyTimelineがbuildScorePartsに紛れ込んでいます');
  assert.equal(CHIP_SIGNAL_FIELDS.includes('creditSupplyTimeline'), false);
});

test('CASE J: creditSupplyTimeline.tagsは既存creditSupplyTags(r)の結果と完全に一致する（タイムライン独自のタグ判定を作らない）', () => {
  const cs = creditSupplyQualitySignal({
    weekly: timelineWeekly, closes: Array.from({ length: 20 }, (_, i) => 3200 + i), volumes: Array.from({ length: 20 }, () => 100_000),
    price: 3420, today: '2026-09-18',
  });
  const tl = creditSupplyTimeline({ weekly: timelineWeekly, creditSupplyQuality: cs });
  assert.deepEqual(tl.tags, creditSupplyTags({ creditSupplyQuality: cs }));
});

// ==================================================================
// 棚卸し（ユーザー指摘）で発覚した3件の未対応の再発防止テスト。
// 項目3・4・7（ホバー詳細）、項目9（安値更新＋買残増マーカー）、
// 項目6（日付ラベルは表示点数ではなく画面幅で切り替える）。
// ==================================================================

test('項目3・4・7 再発防止: 買残バー・売残線・株価線のいずれにも各観測点の詳細（日付・株価・買残・買残前回比・売残・売残前回比・信用倍率）がSVG<title>として埋め込まれている', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly });
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
  assert.ok(titles.length > 0, 'SVGに<title>（ホバー詳細）が1つも見つかりません');
  // 最新点（2026-09-18、買残1,240,000株、前回比-6.1%、信用倍率20倍）の詳細が
  // 少なくとも1つのtitleに含まれていること（買残バー由来のtitleで確認できる）。
  const latestTitle = titles.find((t) => t.includes('2026/09/18'));
  assert.ok(latestTitle, '最新点(2026/09/18)のtitleが見つかりません');
  assert.ok(latestTitle.includes('買残 1,240,000株'));
  assert.ok(latestTitle.includes('前回比-6.1%'));
  // 売残線・株価線側のtitleには売残・信用倍率も含まれる（項目4「買残/売残/
  // 信用倍率を同時表示」・項目7「株価含む全項目」）。
  const detailedTitle = titles.find((t) => t.includes('2026/09/18') && t.includes('売残') && t.includes('信用倍率'));
  assert.ok(detailedTitle, '売残・信用倍率を含む詳細titleが見つかりません（項目4・7）');
  assert.ok(detailedTitle.includes('株価 ¥3,420'));
});

test('項目9 再発防止: lowBreakBuyBuildUpが最新点で該当していれば、株価線の該当点に視覚的なマーカー(ctl-marker)が描かれる', () => {
  // 最新週で20日安値更新×買残増加が成立する状況を作る（単調下落の日次終値
  // ＋最新週の信用買い残が前週比プラス）。
  const decliningCloses = Array.from({ length: 20 }, (_, i) => 1100 - i);
  const weekly = [
    { date: '26/09/18', buy: 1_600_000, sell: 74_000, loanRatio: 21.5, close: decliningCloses.at(-1) },
    { date: '26/09/11', buy: 1_500_000, sell: 72_000, loanRatio: 21.2, close: decliningCloses.at(-1) + 10 },
  ];
  const cs = creditSupplyQualitySignal({
    weekly, closes: decliningCloses, volumes: Array.from({ length: 20 }, () => 100_000),
    price: decliningCloses.at(-1), today: '2026-09-18',
  });
  assert.equal(cs.lowBreakBuyBuildUp, true); // 前提の確認
  const tl = creditSupplyTimeline({ weekly, creditSupplyQuality: cs });
  assert.ok(tl.tags.includes('安値更新＋買残増'));
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  assert.ok(html.includes('ctl-marker'), '安値更新＋買残増が該当しているのに株価線にマーカーが描かれていません');
});

test('項目9 再発防止: lowBreakBuyBuildUpが該当していなければマーカーは描かない（過去分への遡及マーカーを作らない、という制約の裏返しの確認）', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly }); // creditSupplyQualityを渡さない＝tags:[]
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  assert.ok(!html.includes('ctl-marker'));
});

test('項目6 再発防止: 日付ラベルは表示点数に関わらず全点をDOMに出力する（画面幅はCSSのmedia queryで切り替える。表示点数で始点・終点だけに絞らない）', () => {
  const tl = creditSupplyTimeline({ weekly: timelineWeekly }); // 6点
  const html = creditSupplyTimelineBlock({ creditSupplyTimeline: tl });
  for (const p of tl.points) {
    assert.ok(html.includes(formatDateForAssert(p.date)), `日付ラベル${p.date}がDOMに出力されていません`);
  }
  // 先頭・末尾はctl-date-edge、中間はctl-date-midクラスが付いている
  const edgeCount = [...html.matchAll(/ctl-date-edge/g)].length;
  const midCount = [...html.matchAll(/ctl-date-mid/g)].length;
  assert.equal(edgeCount, 2);
  assert.equal(midCount, tl.points.length - 2);
});

test('項目6 再発防止: .ctl-date-midを狭い画面（max-width:420px）でだけ隠すCSSが存在する', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  assert.ok(/@media\(max-width:420px\)\{\.ctl-date-mid\{display:none\}\}/.test(src), '.ctl-date-midを狭い画面で隠すmedia queryが見つかりません');
});

function formatDateForAssert(iso) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[1]}/${m[2]}` : iso;
}
