// indicators.mjsの評価ロジックの回帰テスト。
//
// これらは全て「実測で見つかった具体的な矛盾」を再発防止のために固定した
// もの。新しい赤旗シグナルを追加するときは、同じ「worsen-only」パターン・
// 「checked」パターンに従っているかをここで確認できるようにしている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ambushVerdict, smartEntryVerdict, receivablesAnomalySignal, dividendYieldPeakSignal,
  overheatSignal, growthSurgeSignal, marginOverhangSignal, netNetSignal, lowPbrSignal,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal, shortSqueezeSignal,
  pbrHistoricalLowSignal, hiddenGemSignal, hasConsensusProfit, retailExpectationSignal, priceLevelVsRange,
  progressStreakSignal, dividendPotentialSignal, hiddenAssetSignal, creditFloatSignal, consensusTrapSignal,
  usEarningsTrendSignal, tenbaggerSignal, midCapGrowthSignal, repricingLagScore, marketCapExclusion,
  computeFloatRatio, floatSqueezeSignal, breakoutVolumeSignal, growthAccelerationSignal, aggressiveInvestmentSignal,
  themeMatchSignal, buyScore, buyScoreRiskPenalty, expectationScore, earningsSurpriseScore, buildScoreParts, confidenceTier, effectiveScore,
  evEbitda, valuationQualityScore, diamondSignal, tenbaggerRealizabilityScore, growthPotentialScore,
  deficitGrowthSignal, growthAnomalyCautionSignal, marginImproving, repricingGapScore, repricingGapBreakdown, REPRICING_GAP, entryPriorityScore,
  riskLevel, riskCoverage, CHIP_SIGNAL_FIELDS, evaluationAxes, dividendYieldFloorSignal, clusterConfirmation,
  tenbaggerDifficultyLabel, inflectionCauseSignal, turnaroundCountermeasureSignal,
  coreScreeningSignal, inflectionSpreadSignal, inflectionProgressSurpriseSignal, inflectionHurdleRatioSignal,
  inflectionDownsideRiskSignal, inflectionPatternType,
} from '../indicators.mjs';

test('marketCapExclusion: 時価総額が上限を超えると除外（実測: しまむらの時価総額720,300百万円がAMBUSHの新設上限100,000百万円を超過）', () => {
  const r = marketCapExclusion({ marketCap: 720_300, maxMarketCap: 100_000 });
  assert.equal(r.excluded, true);
});

test('marketCapExclusion: 上限以下なら除外しない', () => {
  const r = marketCapExclusion({ marketCap: 50_000, maxMarketCap: 100_000 });
  assert.equal(r.excluded, false);
});

test('marketCapExclusion: 時価総額が無ければ判断材料が無いため除外しない', () => {
  assert.equal(marketCapExclusion({ marketCap: null, maxMarketCap: 100_000 }).excluded, false);
  assert.equal(marketCapExclusion({ marketCap: undefined, maxMarketCap: 100_000 }).excluded, false);
});

test('ambushVerdict: 赤旗は悪化方向にしか動かさない（rank DはmarginOverhangがあっても見送りのまま）', () => {
  // 実測バグ: 3038/3415がrank Dで本来「見送り」のところ、marginOverhangの
  // 早期returnにより「様子見」に格上げされてしまっていた。
  const r = { rank: 'D', evidence: false, marginOverhang: { level: 'bad', note: 'x' } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'avoid');
});

test('ambushVerdict: 急騰グロース(growthSurge)が立っていれば買い推奨にはならない', () => {
  // 実測バグ: AMBUSH側だけgrowthSurgeSignalを見ておらず、赤チップと
  // 「買い推奨」が同居する矛盾が起きていた。
  const r = { rank: 'S', evidence: true, market: '東証Ｇ', closes: [100, ...Array(20).fill(160)] };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: スクイーズアウトによる上場廃止決定はランクに関係なく必ず見送り', () => {
  // 実測バグ: 3480ジェイ・エス・ビーがランクC・様子見のまま表示され、
  // 2026-08-10開示のスクイーズアウト決定が一切反映されていなかった。
  const r = {
    rank: 'S', evidence: true,
    warnings: [{ label: '上場廃止（スクイーズアウト）', title: '株式等売渡請求...', date: '2026-08-10' }],
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'avoid');
});

// A指示 項目42「『買い推奨』判定に最低条件を設ける」: 仕込み優先度や
// ランクが高くても、業績大幅悪化・未織り込み要素の欠如・データ不足の
// いずれかがあれば買い推奨にしない（applyMinimumBuyGate）。
test('ambushVerdict: ランクS/Aでも売上高成長率が-20%以下（業績大幅悪化）なら買い推奨にしない', () => {
  const r = { rank: 'S', evidence: true, revenueGrowthPct: -25 };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
  assert.notEqual(v.level, 'strong_buy');
});

test('ambushVerdict: ランクS/Aでも利益成長率が-20%以下（業績大幅悪化）なら買い推奨にしない', () => {
  const r = { rank: 'S', evidence: true, profitGrowthPct: -30 };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: 業績悪化が-20%を上回る（軽微な悪化）だけなら買い推奨の最低条件は満たす', () => {
  const r = { rank: 'S', evidence: true, revenueGrowthPct: -5, profitGrowthPct: -10 };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
});

test('ambushVerdict: repricingLagが確定的に判定済み（checked:true）で未織り込み要素（pre_move/early_move）が無ければ買い推奨にしない', () => {
  const r = { rank: 'S', evidence: true, repricingLag: { checked: true, zone: 're_rating', score: 40 } };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: repricingLagが未確定（checked:false）なら未織り込み要素の欠如で不利益を与えない（推測しない）', () => {
  const r = { rank: 'S', evidence: true, repricingLag: { checked: false, zone: null } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
});

test('ambushVerdict: repricingLagがpre_move/early_moveなら未織り込み要素ありとして買い推奨を維持する', () => {
  const r = { rank: 'S', evidence: true, repricingLag: { checked: true, zone: 'pre_move', score: 80 } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
});

test('ambushVerdict: buyScore.confidence===0（CONFIDENCE UNKNOWN）なら買い推奨にしない（DATAが最低限確保されていること）', () => {
  const r = { rank: 'S', evidence: true, buyScore: { score: null, confidence: 0 } };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: buyScore.confidenceが0より大きければ最低条件のDATA要件は満たす', () => {
  const r = { rank: 'S', evidence: true, buyScore: { score: 60, confidence: 50 } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
});

// 実測バグ（未スキャン領域の横断監査で発覚）: US AMBUSH（us_screener.mjs）
// はrevenueGrowthPct/profitGrowthPctをトップレベルに持たず、
// earningsTrend（usEarningsTrendSignal）経由でしか成長率を持たない。
// しかしearningsTrendのフォールバックはnetIncomeGrowthPct（利益）にしか
// 付いておらず、revenueGrowthPct（売上）側が抜けていたため、「純利益は
// YoY比較不能（null）だが売上高は-25%等と大幅減収」という米国株では
// 現実にあり得るケースで、この最低条件ゲートが一切発動しなかった。
test('ambushVerdict: US AMBUSH相当（revenueGrowthPctがトップレベルに無くearningsTrend経由のみ）でも、売上高の大幅減収（-20%以下）で買い推奨にしない', () => {
  const r = { rank: 'S', evidence: true, earningsTrend: { level: null, checked: true, revenueGrowthPct: -25, netIncomeGrowthPct: null } };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: US AMBUSH相当でearningsTrend.revenueGrowthPctが-20%を上回る（軽微な悪化）だけなら買い推奨の最低条件は満たす', () => {
  const r = { rank: 'S', evidence: true, earningsTrend: { level: null, checked: true, revenueGrowthPct: -5, netIncomeGrowthPct: null } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
});

test('smartEntryVerdict: 買い推奨の最低条件ゲート（applyMinimumBuyGate）はSMART ENTRY側にも同じロジックで適用される', () => {
  const r = { sig1: { level: 'good', note: 'x' }, revenueGrowthPct: -30 };
  const v = smartEntryVerdict(r, overheatSignal(null), growthSurgeSignal(null, null));
  assert.notEqual(v.level, 'buy');
});

test('smartEntryVerdict: overheatはAMBUSHと同じく見送りまで落とす（様子見止まりではない）', () => {
  // 実測バグ: 同じ閾値(kairi>+15%)なのにAMBUSHは見送り、SMART ENTRYは
  // 様子見止まりという不整合があった。
  const r = { sig1: { level: 'good', note: 'x' } };
  const overheat = overheatSignal(20); // kairi=20% > OVERHEAT_KAIRI(15)
  const v = smartEntryVerdict(r, overheat, growthSurgeSignal(null, null));
  assert.equal(v.level, 'avoid');
});

test('receivablesAnomalySignal: bad/warn判定は必ずchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: bad/warnの返り値だけchecked:trueが抜けており、UIが
  // 「確認済みで異常あり」と「未確認」を区別できていなかった。
  const bad = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2 });
  assert.equal(bad.level, 'bad');
  assert.equal(bad.checked, true);

  const warn = receivablesAnomalySignal({ revenueGrowthPct: 10, receivablesGrowthPct: 16 });
  assert.equal(warn.level, 'warn');
  assert.equal(warn.checked, true);

  const clean = receivablesAnomalySignal({ revenueGrowthPct: 10, receivablesGrowthPct: 5 });
  assert.equal(clean.level, null);
  assert.equal(clean.checked, true);

  const unchecked = receivablesAnomalySignal({ revenueGrowthPct: null, receivablesGrowthPct: null });
  assert.equal(unchecked.level, null);
  assert.equal(unchecked.checked, false);
});

// v7.3改修 項目9: 売掛金分析の強化。ユーザー提示の例（売上+5%・売掛金
// +12%で営業CFが悪化なら高リスク、改善なら必ずしも悪材料ではない）を
// そのままロジック化。
test('receivablesAnomalySignal: 売掛金急増でも営業CFが改善していればwarnに緩和する（季節性・M&A・大型案件の可能性を考慮）', () => {
  const worsening = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2 });
  const improving = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, operatingCfGrowthPct: 20 });
  assert.equal(worsening.level, 'bad');
  assert.equal(improving.level, 'warn');
  assert.match(improving.note, /営業キャッシュ・フローは前期比\+20%と改善/);
});

test('receivablesAnomalySignal: 営業CFのデータが無ければ従来通りbadのまま（データ不足で安全側に倒れない方向へは緩和しない）', () => {
  const r = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, operatingCfGrowthPct: null });
  assert.equal(r.level, 'bad');
});

test('receivablesAnomalySignal: 営業CFが悪化していれば緩和しない（ユーザー例: 売上+5%・売掛金+12%・営業CF↓→高リスクのまま）', () => {
  const r = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, operatingCfGrowthPct: -10 });
  assert.equal(r.level, 'bad');
});

// v7.5改修（ユーザー提案「売掛金＋前受金＝最強、はそのまま採用しない。
// 受注・CFまで揃ったら警告緩和にする」）: 前受金の増加も営業CF改善と
// 同じ「警告を1段階弱めるだけ」の裏付け材料として扱う（単独では好材料に
// 反転させない）。
test('receivablesAnomalySignal: 売掛金急増でも前受金が増加していればwarnに緩和する（営業CFが無くても前受金だけで緩和できる）', () => {
  const r = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, advancesReceivedGrowthPct: 30 });
  assert.equal(r.level, 'warn');
  assert.match(r.label, /前受金増加/);
  assert.match(r.note, /前受金が前期比\+30%と増加/);
});

test('receivablesAnomalySignal: 営業CF改善・前受金増加の両方が揃うとラベルにも両方明記する', () => {
  const r = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, operatingCfGrowthPct: 20, advancesReceivedGrowthPct: 30 });
  assert.equal(r.level, 'warn');
  assert.match(r.label, /営業CF・前受金改善/);
  assert.match(r.note, /営業キャッシュ・フローは前期比\+20%と改善しており、さらに前受金が前期比\+30%と増加/);
});

test('receivablesAnomalySignal: 前受金が減少していれば緩和しない（増加していないものを好材料扱いしない）', () => {
  const r = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2, advancesReceivedGrowthPct: -10 });
  assert.equal(r.level, 'bad');
});

// A指示 項目20「売掛金急増の判定を高度化する」ケース8: 売掛金+30%・
// 受注+50%（データ無し）・前受金+40%・営業CF改善→緩和する。受注データは
// 取得手段が無いため、取得可能な前受金・営業CFのみで緩和条件を満たす。
test('receivablesAnomalySignal: A指示ケース8相当（売掛金急増+前受金増加+営業CF改善、棚卸資産の積み上がりなし）は緩和する', () => {
  const r = receivablesAnomalySignal({
    revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2,
    operatingCfGrowthPct: 20, advancesReceivedGrowthPct: 40,
    inventoryGrowthPct: 2,
  });
  assert.equal(r.level, 'warn');
});

// A指示 項目20 ケース9: 売掛金+30%・受注-20%（データ無し）・営業CF悪化→
// 強い警戒。受注減少データが無いため、同時に積み上がる棚卸資産を代替の
// 悪化シグナルとして扱い、営業CF改善・前受金増加があっても緩和しない。
test('receivablesAnomalySignal: 棚卸資産も売上に見合わないペースで積み上がっていれば、営業CF改善・前受金増加があっても緩和しない（A指示ケース9相当: 受注減少の代替シグナル）', () => {
  const r = receivablesAnomalySignal({
    revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2,
    operatingCfGrowthPct: 20, advancesReceivedGrowthPct: 40,
    inventoryGrowthPct: 60,
  });
  assert.equal(r.level, 'bad');
  assert.match(r.label, /棚卸資産も同時増加のため警告維持/);
  assert.match(r.note, /棚卸資産も前期比\+60%と売上に見合わないペースで積み上がっており/);
});

test('receivablesAnomalySignal: 棚卸資産データが無ければ従来通り営業CF改善・前受金増加だけで緩和できる（推測で悪化扱いにしない）', () => {
  const r = receivablesAnomalySignal({
    revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2,
    operatingCfGrowthPct: 20, advancesReceivedGrowthPct: 40,
    inventoryGrowthPct: null,
  });
  assert.equal(r.level, 'warn');
});

// A指示 項目10/11「赤字成長企業の特例枠」「赤字成長・高リスク」。
// 実測データ（G-アクセルスペースホールディングス/402A、有報S100YYV1）:
// 売上高成長率+58.1%・販管費成長率+77.5%（売上以上に伸びている）・
// 営業損益は-24.95億円→-38.23億円と絶対額では赤字拡大——という
// 「粗利は改善しているが販管費が売上以上に膨らみ営業赤字は拡大している」
// 実例で「赤字成長・高リスク」が正しく発火することを確認する。
const REAL_402A_LOSS_WIDENING = {
  revenueGrowthPct: 58.1, sgaGrowthPct: 77.5,
  grossProfit: 797_366_000, grossProfitPrior: 107_764_000,
  netSales: 2_508_363_000, netSalesPrior: 1_586_835_000,
  operatingIncome: -3_822_923_000, operatingIncomePrior: -2_495_052_000,
  operatingCf: -5_123_804_000, operatingCfPrior: -4_329_150_000,
  capex: -1_807_152_000, capexPrior: -88_789_000,
  cash: 5_815_658_000, interestBearingDebt: 3_262_306_000, equity: 6_993_391_000,
};

test('deficitGrowthSignal: 実測（402A）— 売上成長率>販管費成長率を満たさず営業赤字が拡大していれば「赤字成長・高リスク」（A指示ケース6相当: 売上+60%・販管費+90%→高リスク成長株）', () => {
  const r = deficitGrowthSignal(REAL_402A_LOSS_WIDENING);
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '赤字成長・高リスク');
  assert.match(r.note, /-2,495,052,000円→-3,822,923,000円/);
});

test('deficitGrowthSignal: 販管費が売上成長率以下に収まり他の条件も複数揃えば「赤字成長特例」（成長率+40%以上を含め4条件以上）', () => {
  const r = deficitGrowthSignal({
    ...REAL_402A_LOSS_WIDENING,
    sgaGrowthPct: 30, // 売上成長率58.1%を下回るよう仮定
    operatingIncome: -1_000_000_000, operatingIncomePrior: -2_495_052_000, // 赤字幅縮小
    operatingCf: -1_000_000_000, operatingCfPrior: -4_329_150_000, // 赤字幅縮小
    capex: -88_789_000, capexPrior: -88_789_000, // FCF赤字も縮小
  });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '赤字成長特例');
  assert.match(r.note, /販管費抑制/);
  assert.match(r.note, /粗利率改善/);
});

test('deficitGrowthSignal: 売上成長率+40%未満なら、他の条件が揃っていても特例にしない（項目10の必須条件）', () => {
  const r = deficitGrowthSignal({ ...REAL_402A_LOSS_WIDENING, revenueGrowthPct: 20, sgaGrowthPct: 10 });
  assert.notEqual(r.level, 'good');
});

test('deficitGrowthSignal: 営業黒字の企業は対象外（level:null・checked:false）', () => {
  const r = deficitGrowthSignal({ ...REAL_402A_LOSS_WIDENING, operatingIncome: 100_000_000 });
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('deficitGrowthSignal: 営業損益・売上高成長率のデータが無ければ判定不能（checked:false、データ不足を悪材料/好材料として扱わない）', () => {
  const r = deficitGrowthSignal({});
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('deficitGrowthSignal: 売上成長率+40%以上を満たすが他の判定材料が一切無ければchecked:false（データ不足を良悪いずれとも扱わない）', () => {
  const r = deficitGrowthSignal({ revenueGrowthPct: 45, operatingIncome: -100 });
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('deficitGrowthSignal: 条件を満たす数が足りなければlevel:null（good/badどちらでもない中間状態。checked:trueで「判定材料はあったが特例には満たない」ことを示す）', () => {
  // 売上成長率+40%以上（highGrowth）と粗利率改善の2条件のみ真、
  // minGoodChecks(3)未達（goodCount=2 < 必要な4）。他の条件のデータは
  // 一切無い（null）ため、bad判定のsgaDiscipline===false条件にも該当しない。
  const r = deficitGrowthSignal({
    revenueGrowthPct: 45, operatingIncome: -100,
    grossProfit: 200, grossProfitPrior: 100, netSales: 1000, netSalesPrior: 1000,
  });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

// A指示 項目8「異常成長はボーナスで扱うが、異常値だから自動的に1位には
// しない。前年同期の利益水準・特別損益・減損等を確認して本物の成長と
// ベース効果/一時要因を分離する」。指示書の実例（売上+70%/利益+463%）
// をそのまま使う。
test('growthAnomalyCautionSignal: 売上+40%未満または利益+100%未満（異常成長の閾値未満）ならchecked:false（判定対象外）', () => {
  const r = growthAnomalyCautionSignal({ revenueGrowthPct: 15, profitGrowthPct: 20 });
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('growthAnomalyCautionSignal: 前期の営業利益率がほぼゼロ（低いベース）なら「異常成長・要確認」（ベース効果の疑い）', () => {
  const r = growthAnomalyCautionSignal({
    revenueGrowthPct: 70, profitGrowthPct: 463,
    operatingIncomePrior: 5_000_000, netSalesPrior: 1_000_000_000, // 前期営業利益率0.5%
  });
  assert.equal(r.level, 'warn');
  assert.match(r.note, /ベース効果/);
});

test('growthAnomalyCautionSignal: 特別損益・減損が計上されていれば「異常成長・要確認」（一時要因の疑い）', () => {
  const r = growthAnomalyCautionSignal({
    revenueGrowthPct: 70, profitGrowthPct: 463,
    operatingIncomePrior: 100_000_000, netSalesPrior: 1_000_000_000, // 前期営業利益率10%（低ベースではない）
    extraordinaryIncome: 500_000_000,
  });
  assert.equal(r.level, 'warn');
  assert.match(r.note, /特別損益・減損等の一時的な項目/);
});

test('growthAnomalyCautionSignal: 前期の水準も特別損益もどちらも確認され異常が無ければ「本物の成長」', () => {
  const r = growthAnomalyCautionSignal({
    revenueGrowthPct: 70, profitGrowthPct: 463,
    operatingIncomePrior: 100_000_000, netSalesPrior: 1_000_000_000,
    extraordinaryIncome: null, extraordinaryLoss: null, impairmentLoss: null,
  });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '本物の成長（ベース効果なし）');
});

test('growthAnomalyCautionSignal: 異常成長ではあるが確認材料（前期営業利益率・特別損益）が一切無ければchecked:false（推測でベース効果無しと断定しない）', () => {
  const r = growthAnomalyCautionSignal({ revenueGrowthPct: 70, profitGrowthPct: 463 });
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

// marginImproving: deficitGrowthSignal/growthAccelerationSignal（A指示
// 項目7）の両方から使う共通ヘルパー。
test('marginImproving: 当期の比率が前期より高ければtrue', () => {
  assert.equal(marginImproving(300, 1000, 100, 1000), true); // 30% > 10%
});

test('marginImproving: 当期の比率が前期以下ならfalse', () => {
  assert.equal(marginImproving(100, 1000, 300, 1000), false); // 10% < 30%
});

test('marginImproving: 分子・分母いずれかのデータが無ければnull（推測で判定しない）', () => {
  assert.equal(marginImproving(null, 1000, 100, 1000), null);
  assert.equal(marginImproving(300, 1000, null, 1000), null);
  assert.equal(marginImproving(300, 0, 100, 1000), null); // 分母が0
});

// inflectionCauseSignal（「業績屈折(INFLECTION)」セクション向け、
// ユーザー提案2026-09-12「なぜ前四半期が悪かったか」）。
test('inflectionCauseSignal: 営業減益していなければchecked:false（判定対象外）', () => {
  const r = inflectionCauseSignal({ operatingIncome: 100, operatingIncomePrior: 90 });
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('inflectionCauseSignal: 粗利率が悪化していれば「原価/原材料コスト増」を検出する（実データ相当: シマダヤ1Q減益）', () => {
  const r = inflectionCauseSignal({
    operatingIncome: 80, operatingIncomePrior: 100,
    netSales: 10_000, netSalesPrior: 10_000,
    grossProfit: 2_000, grossProfitPrior: 2_500, // 粗利率20%→25%から悪化
  });
  assert.equal(r.level, 'info');
  assert.match(r.label, /原価\/原材料コスト増/);
  assert.match(r.note, /粗利率が25%→20%に悪化/);
});

test('inflectionCauseSignal: 販管費が急増していれば「販管費増加」を検出する', () => {
  const r = inflectionCauseSignal({
    operatingIncome: 80, operatingIncomePrior: 100, sgaGrowthPct: 15,
  });
  assert.equal(r.level, 'info');
  assert.match(r.label, /販管費増加/);
});

test('inflectionCauseSignal: 特別損失・減損があれば「特別損失/減損」を検出する（円→百万円の単位変換込み）', () => {
  // 実測バグの再発防止（ユーザー指摘2026-09-13）: extraordinaryLoss/
  // impairmentLossはEDINETのXBRLタグ値そのまま（円単位）なのに、以前は
  // 変換せず「百万円」と表示していたため桁が100万倍ズレていた（実測:
  // バロック「278,000,000百万円」＝278兆円という異常表示）。テストの
  // 入力値も実際のEDINET値のスケール（円）に合わせる。
  const r = inflectionCauseSignal({
    operatingIncome: 80, operatingIncomePrior: 100, extraordinaryLoss: 500_000_000, impairmentLoss: 300_000_000,
  });
  assert.equal(r.level, 'info');
  assert.match(r.label, /特別損失\/減損/);
  assert.match(r.note, /計800百万円/);
});

test('inflectionCauseSignal: 複数の要因が同時に該当すれば両方とも返す', () => {
  const r = inflectionCauseSignal({
    operatingIncome: 80, operatingIncomePrior: 100,
    netSales: 10_000, netSalesPrior: 10_000,
    grossProfit: 2_000, grossProfitPrior: 2_500,
    sgaGrowthPct: 15,
  });
  assert.equal(r.causes.length, 2);
  assert.match(r.label, /原価\/原材料コスト増/);
  assert.match(r.label, /販管費増加/);
});

test('inflectionCauseSignal: 営業減益しているが機械的に判定できる要因が無ければ「要因不明」で正直に返す（推測で埋めない）', () => {
  const r = inflectionCauseSignal({ operatingIncome: 80, operatingIncomePrior: 100 });
  assert.equal(r.checked, true);
  assert.equal(r.level, null);
  assert.equal(r.label, '要因不明');
  assert.equal(r.causes.length, 0);
});

// turnaroundCountermeasureSignal（同セクション向け「何の対策が打たれたか」）。
// 実測: TDnetタイトルのみからの検出は2,520件中4件（0.16%）、価格改定系は
// 0件だった。ヒットしない場合も正直に「本文までは確認していない」と示す。
test('turnaroundCountermeasureSignal: disclosuresが空ならchecked:false（そもそも直近開示が無い）', () => {
  const r = turnaroundCountermeasureSignal([]);
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('turnaroundCountermeasureSignal: タイトルに価格改定系キーワードがあれば検出する', () => {
  const r = turnaroundCountermeasureSignal([
    { date: '2026-08-10', title: '2026年3月期第1四半期決算短信〔日本基準〕(連結)' },
    { date: '2026-09-01', title: '製品の価格改定に関するお知らせ' },
  ]);
  assert.equal(r.level, 'good');
  assert.match(r.label, /価格改定/);
  assert.equal(r.hits.length, 1);
});

test('turnaroundCountermeasureSignal: タイトルに合理化・コスト削減系（類義語含む）キーワードがあれば検出する', () => {
  const r = turnaroundCountermeasureSignal([
    { date: '2026-08-20', title: '希望退職者の募集に関するお知らせ' },
  ]);
  assert.equal(r.level, 'good');
  assert.match(r.label, /合理化・コスト削減/);
});

test('turnaroundCountermeasureSignal: 該当するタイトルが無ければ、対策が無いと断定せず「本文未確認」を明記する', () => {
  const r = turnaroundCountermeasureSignal([
    { date: '2026-08-10', title: '2026年3月期第1四半期決算短信〔日本基準〕(連結)' },
  ]);
  assert.equal(r.checked, true);
  assert.equal(r.level, null);
  assert.match(r.note, /本文までは確認していない/);
});

// ==================================================================
// SECTION D新スペック（ユーザー提案2026-09-12）: コア・スクリーニング
// 条件とキラー指標3つ。
// ==================================================================

test('coreScreeningSignal: 全条件を満たせばpassed:true', () => {
  const r = coreScreeningSignal({ per: 12, pbr: 1.0, dividendYield: 3.0, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(r.passed, true);
  assert.equal(r.failedReasons.length, 0);
  assert.equal(r.uncheckedFields.length, 0);
});

test('coreScreeningSignal: 1つでもレンジ外ならpassed:false（該当条件をfailedReasonsで返す）', () => {
  const r = coreScreeningSignal({ per: 30, pbr: 1.0, dividendYield: 3.0, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(r.passed, false);
  assert.match(r.failedReasons.join(), /PER/);
});

test('coreScreeningSignal: データが無い項目はunchecked扱いで、推測してpassed扱いにしない（未確認とレンジ外を区別する）', () => {
  const r = coreScreeningSignal({ per: 12, pbr: 1.0, dividendYield: null, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(r.passed, false);
  assert.equal(r.failedReasons.length, 0);
  assert.deepEqual(r.uncheckedFields, ['配当利回り']);
});

// ROE判定のOR条件（ユーザー提案2026-09-13の改良版、A案）: 直近期の
// ROE単体だと「まさに今探している一時的な悪化」自体がROEを押し下げて
// しまう（実測: NISSHA(7915)は直近ROE0.87%）。過去実績平均・今期予想
// のどちらか一方が基準を満たせば良いとする。
test('coreScreeningSignal: ROEは過去実績平均が基準未満でも、今期予想ROEが基準を満たせば通過する（実データ相当: タマホーム直近3.8%→予想13.48%）', () => {
  const r = coreScreeningSignal({
    per: 12, pbr: 1.0, dividendYield: 3.0, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8,
    roeHistory: { actualRoes: [4.07, 3.8], forecastRoe: 13.48 },
  });
  assert.equal(r.checks.find((c) => c.key === 'roe').ok, true);
});

test('coreScreeningSignal: ROEは過去実績平均・今期予想のどちらも基準未満なら不合格（実データ相当: NISSHA直近0.87%・予想2.73%）', () => {
  const r = coreScreeningSignal({
    per: 12, pbr: 1.0, dividendYield: 3.0, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8,
    roeHistory: { actualRoes: [3.42, 0.87], forecastRoe: 2.73 },
  });
  assert.equal(r.checks.find((c) => c.key === 'roe').ok, false);
  assert.equal(r.passed, false);
});

test('coreScreeningSignal: roeHistory自体が無い（データ取得不可）ならROEはunchecked（推測でpassed扱いにしない）', () => {
  const r = coreScreeningSignal({ per: 12, pbr: 1.0, dividendYield: 3.0, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8, roeHistory: null });
  assert.deepEqual(r.uncheckedFields, ['ROE']);
});

test('inflectionSpreadSignal: 実データ(シマダヤ: 1Q売上+1.0%・経常益-21.2%)はスプレッド+22.2ptだが、経常益YoYが-20%の下限を僅かに割り込むため非該当（ユーザー仕様の-20%下限を厳密に適用した結果。実データ検証で判明した境界ケース）', () => {
  const r = inflectionSpreadSignal({ revenueYoyPct: 1.0, revenueYoyState: 'numeric', ordinaryProfitYoyPct: -21.2, ordinaryProfitYoyState: 'numeric' });
  assert.equal(r.checked, true);
  assert.equal(r.value, 22.2);
  assert.equal(r.level, null); // -21.2 < -20（下限）のため非該当
});

test('inflectionSpreadSignal: 経常益YoYが-20%〜0%の範囲内で、スプレッドが+10pt以上なら該当する', () => {
  const r = inflectionSpreadSignal({ revenueYoyPct: 1.0, revenueYoyState: 'numeric', ordinaryProfitYoyPct: -19.0, ordinaryProfitYoyState: 'numeric' });
  assert.equal(r.value, 20);
  assert.equal(r.level, 'good');
});

test('inflectionSpreadSignal: 経常益YoYが-20%を下回る（悪化しすぎ）なら該当しない', () => {
  const r = inflectionSpreadSignal({ revenueYoyPct: 5, revenueYoyState: 'numeric', ordinaryProfitYoyPct: -50, ordinaryProfitYoyState: 'numeric' });
  assert.equal(r.level, null);
  assert.equal(r.passed, false);
});

test('inflectionSpreadSignal: 「黒転」等の特殊state（数値化できない）はchecked:falseにする（無理に当てはめない）', () => {
  const r = inflectionSpreadSignal({ revenueYoyPct: 65.6, revenueYoyState: 'numeric', ordinaryProfitYoyPct: null, ordinaryProfitYoyState: 'turned_profitable' });
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('inflectionProgressSurpriseSignal: 実データ相当（8185: 進捗64.6%・過去平均94.75%）はサプライズがマイナスで非該当', () => {
  const r = inflectionProgressSurpriseSignal({ progressPct: 64.6, priorProgressPcts: [92, 97.5] });
  assert.equal(r.checked, true);
  assert.ok(r.value < 0);
  assert.equal(r.level, null);
});

test('inflectionProgressSurpriseSignal: 今期の進捗率が過去平均を上回れば該当する', () => {
  const r = inflectionProgressSurpriseSignal({ progressPct: 50, priorProgressPcts: [40, 42] });
  assert.equal(r.value, 9); // 50-41
  assert.equal(r.level, 'good');
});

test('inflectionProgressSurpriseSignal: 今期の進捗率が無い（「－」）場合はchecked:false（実測: 250Aの直近期は進捗率が空欄）', () => {
  const r = inflectionProgressSurpriseSignal({ progressPct: null, priorProgressPcts: [43.2, 37.7] });
  assert.equal(r.checked, false);
});

test('inflectionHurdleRatioSignal: 実データ相当（8185: 必要利益601 ÷ 過去平均91.5 ≈ 6.57倍）はハードルが高く非該当', () => {
  const r = inflectionHurdleRatioSignal({
    checkpointOrdinaryProfitActual: 1099, nextMilestoneForecastOrdinaryProfit: 1700,
    priorCheckpointOrdinaryProfitActuals: [1683, 1457], priorMilestoneOrdinaryProfitActuals: [1829, 1494],
  });
  assert.equal(r.checked, true);
  assert.equal(r.value, 6.6);
  assert.equal(r.level, null);
});

test('inflectionHurdleRatioSignal: 必要利益が過去平均以下（1.0倍以下）なら該当する', () => {
  const r = inflectionHurdleRatioSignal({
    checkpointOrdinaryProfitActual: 900, nextMilestoneForecastOrdinaryProfit: 1000,
    priorCheckpointOrdinaryProfitActuals: [800, 800], priorMilestoneOrdinaryProfitActuals: [1000, 1000],
  });
  // 必要利益=100、過去平均2Q相当利益=200、比率=0.5倍
  assert.equal(r.value, 0.5);
  assert.equal(r.level, 'good');
});

test('inflectionHurdleRatioSignal: 通期予想が未開示(null)ならchecked:false（推測しない。実測: 250Aは中間期予想を開示していない）', () => {
  const r = inflectionHurdleRatioSignal({
    checkpointOrdinaryProfitActual: 840, nextMilestoneForecastOrdinaryProfit: null,
    priorCheckpointOrdinaryProfitActuals: [1183, 1066], priorMilestoneOrdinaryProfitActuals: [2740, 2827],
  });
  assert.equal(r.checked, false);
});

test('inflectionHurdleRatioSignal: 過去の該当区間平均が赤字/ゼロ以下なら比率を出さない（符号が意味を持たないため）', () => {
  const r = inflectionHurdleRatioSignal({
    checkpointOrdinaryProfitActual: 100, nextMilestoneForecastOrdinaryProfit: 200,
    priorCheckpointOrdinaryProfitActuals: [100, 100], priorMilestoneOrdinaryProfitActuals: [50, 80], // 区間実績: -50, -20 (共に赤字)
  });
  assert.equal(r.checked, false);
});

// inflectionDownsideRiskSignal（ユーザー指摘2026-09-13「下方修正リスク
// （未達のワナ）」の除外条件。実測: バロックジャパン(3548)が1Q-84.9%→
// 通期予想+321.2%という「絵に描いた餅」を最上位候補にしてしまっていた）。
test('inflectionDownsideRiskSignal: 今期進捗率が過去平均の70%を下回れば下方修正リスク大(bad)', () => {
  const r = inflectionDownsideRiskSignal({ progressPct: 5, priorProgressPcts: [20, 22] });
  assert.equal(r.checked, true);
  assert.equal(r.level, 'bad');
  assert.match(r.note, /下方修正リスク大/);
});

test('inflectionDownsideRiskSignal: 今期進捗率が過去平均の70%以上なら極端な下振れ無し(level:null)', () => {
  const r = inflectionDownsideRiskSignal({ progressPct: 18, priorProgressPcts: [20, 22] });
  assert.equal(r.checked, true);
  assert.equal(r.level, null);
});

test('inflectionDownsideRiskSignal: データが無ければchecked:false（推測で危険と断定しない）', () => {
  const r = inflectionDownsideRiskSignal({ progressPct: null, priorProgressPcts: [20, 22] });
  assert.equal(r.checked, false);
});

// inflectionPatternType（ユーザー提案2026-09-13）: 「経常益YoYがマイナス」
// を必須条件にすると、実データ検証で唯一該当した未来工業(7931、1Q経常益
// +32.6%・ハードル比率0.8倍)のような「会社予想が保守的すぎて上方修正が
// 濃厚な神銘柄」まで弾いてしまう。除外はせず2つのストーリー型に分ける。
test('inflectionPatternType: 経常益YoYがマイナスなら「V字回復型」', () => {
  const r = inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: -21.2, hurdleRatioValue: null });
  assert.equal(r.type, 'v_turnaround');
  assert.match(r.label, /V字回復型/);
});

test('inflectionPatternType: 黒字転換(turned_profitable)も「V字回復型」に含める', () => {
  const r = inflectionPatternType({ ordinaryProfitYoyState: 'turned_profitable', ordinaryProfitYoyPct: null, hurdleRatioValue: null });
  assert.equal(r.type, 'v_turnaround');
});

test('inflectionPatternType: 実データ相当（未来工業: 経常益YoY+32.6%・ハードル比率0.8倍）は「上方修正本命型」', () => {
  const r = inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: 32.6, hurdleRatioValue: 0.8 });
  assert.equal(r.type, 'guidance_conservative');
  assert.match(r.label, /上方修正本命型/);
});

test('inflectionPatternType: 経常益YoYがプラスでもハードル比率が0.8倍を超えれば、どちらの型にも当てはまらない(null)', () => {
  const r = inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: 10, hurdleRatioValue: 1.5 });
  assert.equal(r.type, null);
});

// 実測バグ（2026-09-13、ユーザー報告）: 伯東(7433)は経常益YoY+220%
// （「2.6倍」のようなN倍表記→parseYoyCellでstate='multiple'に変換
// 済み）・ハードル比率0.8倍で「上方修正本命型」に該当するはずだが、
// state==='numeric'のみを見ていたため素通りしてtype:nullになっていた。
test('inflectionPatternType: 実データ相当（伯東: 経常益YoY「N倍」表記＝state:multiple・+220%・ハードル比率0.8倍）も「上方修正本命型」', () => {
  const r = inflectionPatternType({ ordinaryProfitYoyState: 'multiple', ordinaryProfitYoyPct: 220, hurdleRatioValue: 0.8 });
  assert.equal(r.type, 'guidance_conservative');
  assert.match(r.label, /上方修正本命型/);
});

test('dividendYieldPeakSignal: 無配銘柄(maxYield=0)でNaNにならない', () => {
  // 実測バグ: 456Aのような無配銘柄でapproachPctがNaNになっていた。
  const r = dividendYieldPeakSignal({ currentYield: 0, maxYield: 0, maxPeriod: '2024年3月' });
  assert.equal(r.level, null);
  assert.equal(r.note, null);
});

test('marginOverhangSignal: 閾値未満はlevel:null（誤検出しない）', () => {
  assert.equal(marginOverhangSignal(9.9).level, null);
  assert.equal(marginOverhangSignal(10).level, 'bad');
});

test('lowPbrSignal: データが揃っていて割安でない場合もchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: 350A等11銘柄でPBR・業種平均PBRのデータが完全に揃っている
  // のに checked flag が無く、buyRuleChecklistが「？（確認できず）」と
  // 表示していた。
  const notCheap = lowPbrSignal({ pbr: 3.2, sectorPbr: 0.85 });
  assert.equal(notCheap.level, null);
  assert.equal(notCheap.checked, true);

  const cheap = lowPbrSignal({ pbr: 0.5, sectorPbr: 1.0 });
  assert.equal(cheap.level, 'good');
  assert.equal(cheap.checked, true);

  const noData = lowPbrSignal({ pbr: null, sectorPbr: 1.0 });
  assert.equal(noData.checked, false);
});

test('netNetSignal: データが揃っていて解散価値割れでない場合もchecked:trueを持つ', () => {
  const notNetNet = netNetSignal({ cash: 100, totalAssets: 1000, equity: 300, marketCap: 5000, receivables: null });
  assert.equal(notNetNet.level, null);
  assert.equal(notNetNet.checked, true);

  const noData = netNetSignal({ cash: null, totalAssets: 1000, equity: 300, marketCap: 5000 });
  assert.equal(noData.checked, false);
});

test('netNetSignal: cash/totalAssets/equity(円)とmarketCap(百万円)の単位を揃えて計算する（実測の重大バグの再発防止）', () => {
  // 実測バグ: cash等はEDINET由来で単位が「円」、marketCapはkabutan由来で
  // 単位が「百万円」。単位を揃えずに割ると比率が約100万倍に水増しされ、
  // 実際にはネットネットでない銘柄まで「解散価値割れ」と誤判定していた
  // （実測: 6336等でnoteが「時価総額の7804104.5%」のような明らかに
  // 異常な値になっていた）。
  //
  // 現預金3,000,000,000円・総資産10,000,000,000円・自己資本8,000,000,000円
  // → 負債2,000,000,000円 → 純資産(簡易)1,000,000,000円。
  // marketCap=5,000（百万円）＝時価総額50億円。
  // 正しい比率 = 10億円 / 50億円 = 20%（単位を揃えなければ 10億/5,000
  // ＝200,000倍という明らかに異常な比率になっていたはずの銘柄）。
  const r = netNetSignal({ cash: 3_000_000_000, totalAssets: 10_000_000_000, equity: 8_000_000_000, marketCap: 5000, receivables: null });
  assert.equal(r.level, null); // 20% < 70%（warn閾値）なので該当なし
  assert.equal(r.checked, true);

  // 逆に、正しい単位換算をした上で本当にネットネットな銘柄はgoodになる
  // ことも確認する（現預金6,000,000,000円・負債2,000,000,000円
  // → 純資産4,000,000,000円 ＝ 時価総額30億円(marketCap=3000)の133%）。
  const genuine = netNetSignal({ cash: 6_000_000_000, totalAssets: 10_000_000_000, equity: 8_000_000_000, marketCap: 3000, receivables: null });
  assert.equal(genuine.level, 'good');
  assert.match(genuine.note, /133(\.\d+)?%/);
  assert.doesNotMatch(genuine.note, /\d{5,}%/); // 明らかに桁が異常な比率（5桁%以上）になっていないこと
});

test('composePattern: 既知の条件に1つでも不一致があれば、他が未取得でも「非該当」と確定できる（「N/A」と混同しない）', () => {
  // 実測バグ: 9052山陽電鉄のパターン③は信用残水準100%で明確に条件を
  // 満たさない(c1=false)のに、コンセンサス差が未取得(c2=null)という
  // だけで一律「N/A」表示になっていた。AND条件である以上、1つでも
  // 確定的に満たさない条件があれば、残りが未知でも「該当しない」と
  // 言い切ってよいはず。
  const r = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  assert.equal(r.label, '非該当');
  // 「非該当」（確定的な不一致）と「N/A」（総不明）は、以前どちらも
  // level:nullで同じ⚪灰色表示になり、scraper.mjsのsignalRowの🔴（red）
  // が定義はあっても一切到達できないデッドコードになっていた（実測:
  // ユーザーから「信号の赤色が機能していない」との指摘）。level:'none'
  // で区別し、🔴に対応させる。
  assert.equal(r.level, 'none');
});

test('composePattern: 既知の条件が全てtrueで一部未取得なら「一部該当（データ不足）」', () => {
  const r = laggingPatternSignal({ creditLevelPct: 10, estimateProfit: null, consensusProfit: null, kairi: 2 });
  assert.equal(r.label, '一部該当（データ不足）');
  assert.equal(r.level, 'partial');
});

test('composePattern: 条件が1つも判定できなければ「N/A」', () => {
  const r = laggingPatternSignal({ creditLevelPct: null, estimateProfit: null, consensusProfit: null, kairi: null });
  assert.equal(r.label, 'N/A');
});

test('composePattern: 全条件既知かつ全てtrueなら「該当」', () => {
  const r = reboundPatternSignal({ kairi: -12, rsi: 25, creditTrendPct: -5 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '該当');
});

test('composePattern: 全条件既知で一部false（未知は無し）なら「非該当」', () => {
  const r = trendReversalPatternSignal({ cross: { crossed: false }, volRatio: 2, loanRatio: 1 });
  assert.equal(r.label, '非該当');
  assert.equal(r.level, 'none');
});

test('composePattern: 「非該当」(none)と「N/A」(null)はlevelが異なる（signalRowの🔴と⚪を区別するため）', () => {
  const none = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  const na = laggingPatternSignal({ creditLevelPct: null, estimateProfit: null, consensusProfit: null, kairi: null });
  assert.equal(none.level, 'none');
  assert.equal(na.level, null);
  assert.notEqual(none.level, na.level);
});

test('shortSqueezeSignal: 該当しない場合もchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: shortSqueezeSignalにchecked flagが無く、buyRuleChecklist
  // の需給行のOR条件が「marginOverhangが確定的にbadなら、squeezeの
  // 状態を見ずに一律false確定」という誤った3値OR論理になっていた
  // （squeezeが単に未取得なだけの場合でも需給✗と誤表示）。
  const weekly = [
    { buy: 100, sell: 50 }, { buy: 100, sell: 50 }, { buy: 100, sell: 50 },
    { buy: 100, sell: 50 }, { buy: 100, sell: 50 },
  ]; // 変化なし＝踏み上げ条件（買い残減少・売り残増加）を満たさない
  const notSqueeze = shortSqueezeSignal(weekly);
  assert.equal(notSqueeze.level, null);
  assert.equal(notSqueeze.checked, true);

  const noData = shortSqueezeSignal(null);
  assert.equal(noData.checked, false);

  const squeeze = shortSqueezeSignal([
    { buy: 80, sell: 80 }, { buy: 90, sell: 70 }, { buy: 95, sell: 65 },
    { buy: 98, sell: 60 }, { buy: 100, sell: 50 },
  ]);
  assert.equal(squeeze.level, 'good');
  assert.equal(squeeze.checked, true);
});

// A指示 項目18「信用倍率の単純評価をやめる」: 踏み上げ判定は信用買い残/
// 売り残の方向だけでなく、機関投資家の空売り縮小・出来高急増という
// 裏付けが複数一致した場合により高い確度（confirmCount>=3・ラベルに
// 「複合確認」）として扱う。
const SQUEEZE_WEEKLY = [
  { buy: 80, sell: 80 }, { buy: 90, sell: 70 }, { buy: 95, sell: 65 },
  { buy: 98, sell: 60 }, { buy: 100, sell: 50 },
];
test('shortSqueezeSignal: 機関投資家の空売り縮小・出来高急増も同時確認できれば複合確認としてconfirmCountを上げる', () => {
  const base = shortSqueezeSignal(SQUEEZE_WEEKLY);
  assert.equal(base.confirmCount, 2);
  assert.doesNotMatch(base.label, /複合確認/);

  const withInstitutional = shortSqueezeSignal(SQUEEZE_WEEKLY, {
    institutionalShort: { level: 'good' },
  });
  assert.equal(withInstitutional.confirmCount, 3);
  assert.match(withInstitutional.label, /複合確認/);
  assert.match(withInstitutional.note, /機関投資家の空売りも縮小中/);

  const withBoth = shortSqueezeSignal(SQUEEZE_WEEKLY, {
    institutionalShort: { level: 'good' }, volRatio: 2.5,
  });
  assert.equal(withBoth.confirmCount, 4);
  assert.match(withBoth.label, /複合確認/);
  assert.match(withBoth.note, /出来高が20日平均の2.5倍に急増/);
});

test('shortSqueezeSignal: 機関投資家の空売りが「good」以外（未確認・縮小なし）ならconfirmCountに加算しない', () => {
  const r = shortSqueezeSignal(SQUEEZE_WEEKLY, { institutionalShort: { level: null } });
  assert.equal(r.confirmCount, 2);
});

test('shortSqueezeSignal: 出来高倍率がPATTERN2.minVolRatio(1.5倍)未満なら確認済みに数えない', () => {
  const r = shortSqueezeSignal(SQUEEZE_WEEKLY, { volRatio: 1.2 });
  assert.equal(r.confirmCount, 2);
});

test('pbrHistoricalLowSignal: 過去最低PBRちょうどならgood（歴史的最低水準）', () => {
  const r = pbrHistoricalLowSignal({ currentPbr: 0.62, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'PBR歴史的最低水準');
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: 過去最低の90%以上まで接近していればgood（歴史的低水準）', () => {
  const r = pbrHistoricalLowSignal({ currentPbr: 0.65, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'PBR歴史的低水準');
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: 過去最低からまだ遠ければlevel:nullだがchecked:true（未確認と混同しない）', () => {
  // netNetSignal/lowPbrSignalと同じchecked flagパターン。buyRuleChecklistの
  // 「下値」行がnetNet/lowPbrと同じOR条件にこの信号も組み込むため、
  // 「データ不足で未確認」と「確認済みで下値の裏付けにならない」を区別する。
  const r = pbrHistoricalLowSignal({ currentPbr: 1.05, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: データ不足ならlevel:null・checked:false（0除算でNaNにしない）', () => {
  assert.equal(pbrHistoricalLowSignal({ currentPbr: null, minPbr: 0.62 }).level, null);
  assert.equal(pbrHistoricalLowSignal({ currentPbr: null, minPbr: 0.62 }).checked, false);
  assert.equal(pbrHistoricalLowSignal({ currentPbr: 0, minPbr: 0.62 }).checked, false);
});

test('hiddenGemSignal: コンセンサス無し＋解散価値割れ＋増配中ならgood（お宝候補）', () => {
  const r = hiddenGemSignal({
    consensusProfit: null,
    netNet: { level: 'good' },
    lowPbr: { level: null },
    dividendStreakYears: 2,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'お宝候補');
});

test('hiddenGemSignal: コンセンサスがある銘柄では発火しない（この信号の前提そのものが崩れるため）', () => {
  const r = hiddenGemSignal({
    consensusProfit: 500,
    netNet: { level: 'good' },
    lowPbr: { level: null },
    dividendStreakYears: 3,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, null);
});

test('hiddenGemSignal: 財務健全性（解散価値割れ or 割安PBR）が無ければ増配だけでは発火しない', () => {
  const r = hiddenGemSignal({
    consensusProfit: null,
    netNet: { level: null },
    lowPbr: { level: 'warn' }, // '業種平均並み'であって'割安'ではない
    dividendStreakYears: 3,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, null);
});

test('hiddenGemSignal: 増配トレンドが無ければ財務健全でも発火しない', () => {
  const down = hiddenGemSignal({
    consensusProfit: null, netNet: { level: 'good' }, lowPbr: { level: null },
    dividendStreakYears: 3, dividendStreakDirection: 'down',
  });
  assert.equal(down.level, null);
  const none = hiddenGemSignal({
    consensusProfit: null, netNet: { level: 'good' }, lowPbr: { level: null },
    dividendStreakYears: 0, dividendStreakDirection: null,
  });
  assert.equal(none.level, null);
});

test('hasConsensusProfit: consensusProfit===0は「未算出」であって「予想利益0円」ではないためfalse扱い', () => {
  // 再発防止: この非自明なルール（0は有効値ではない）が、かつて
  // indicators.mjs/scraper.mjsの計5箇所に独立にコピーされていた。
  // 単一の情報源(hasConsensusProfit)に統一したので、ここでルール自体を
  // 固定しておく。
  assert.equal(hasConsensusProfit(0), false);
  assert.equal(hasConsensusProfit(null), false);
  assert.equal(hasConsensusProfit(undefined), false);
  assert.equal(hasConsensusProfit(NaN), false);
  assert.equal(hasConsensusProfit(500), true);
  assert.equal(hasConsensusProfit(-500), true); // 赤字予想も「有効なコンセンサス」として扱う
});

test('priceLevelVsRange: 直近期間の終値レンジの中で現在値が最高値なら100%', () => {
  // closesは古い→新しい順（weeklyの新しい→古い順とは逆）。
  const closes = Array.from({ length: 60 }, (_, i) => 1900 + i); // 単調増加、最新が最大
  assert.equal(priceLevelVsRange(closes, 60), 100);
});

test('priceLevelVsRange: データ不足（period未満）ならnull', () => {
  assert.equal(priceLevelVsRange(Array.from({ length: 59 }, (_, i) => 1900 + i), 60), null);
});

test('retailExpectationSignal: 株価急騰＋信用買い残急増＋高値圏 → 期待先行・織り込み大', () => {
  // ユーザー指定ケース1: 株価↑＋信用買い↑↑ → 織り込み大
  const r = retailExpectationSignal({
    return1w: 5, return1m: 20, priceLevelPct: 90, volRatio: 1.2,
    creditTrendPct: 30, creditWeek1Pct: 10, daysToEarnings: null,
  });
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '期待先行・織り込み大');
  assert.match(r.note, /材料出尽くし/);
  assert.match(r.note, /高値圏での急騰/);
});

test('retailExpectationSignal: 決算直前＋急騰＋信用買い残急増 → 強い警戒（決算直前が理由と分かる）', () => {
  // ユーザー指定ケース4
  const r = retailExpectationSignal({
    return1w: 8, return1m: 18, priceLevelPct: null, volRatio: null,
    creditTrendPct: 25, creditWeek1Pct: 12, daysToEarnings: 5,
  });
  assert.equal(r.level, 'bad');
  assert.match(r.note, /決算直前の急騰/);
});

test('retailExpectationSignal: 株価上昇だが信用買い残は横ばい → 織り込みの兆し止まり（織り込み大にはしない）', () => {
  // ユーザー指定ケース2: 株価↑＋信用買い横ばい → 織り込み小〜中
  const r = retailExpectationSignal({
    return1w: 3, return1m: 10, priceLevelPct: 50, volRatio: 1.1,
    creditTrendPct: 2, creditWeek1Pct: 0, daysToEarnings: 30,
  });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みの兆し');
});

test('retailExpectationSignal: 株価低迷＋信用買い残も動きなし → 未織り込み（level:nullだがchecked:true）', () => {
  // ユーザー指定ケース3: 株価低迷＋先行材料強い → 未織り込み
  // （先行材料の有無はこのシグナルの入力ではなく、AMBUSH側の別軸(evidence)で
  // 別途評価される。ここでは株価・信用買い残ともに動きが無いことだけを見る）。
  const r = retailExpectationSignal({
    return1w: 0, return1m: 1, priceLevelPct: 30, volRatio: 0.9,
    creditTrendPct: 0, creditWeek1Pct: 0, daysToEarnings: 40,
  });
  assert.equal(r.level, null);
  assert.equal(r.label, '未織り込み');
  assert.equal(r.checked, true);
});

test('retailExpectationSignal: 株価急騰でも信用買い残が伴わない（大口・機関投資家主導の疑い）は「織り込み大」にしない', () => {
  // ユーザー指定ケース5: 大口買い推定＋信用買い残横ばい → 個人投資家の
  // 織り込みとは別扱い（＝最も重いbad/期待先行の判定にはしない）。
  const r = retailExpectationSignal({
    return1w: 12, return1m: 25, priceLevelPct: 95, volRatio: 3,
    creditTrendPct: 1, creditWeek1Pct: 0, daysToEarnings: 5,
  });
  assert.notEqual(r.level, 'bad');
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みの兆し');
  assert.match(r.note, /機関投資家主導/);
});

test('retailExpectationSignal: 株価・信用買い残とも判定材料が無ければchecked:false', () => {
  const r = retailExpectationSignal({});
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('retailExpectationSignal: 「期待織り込みあり」(warn)は組み合わせが揃うが強い織り込みの条件までは満たさない場合', () => {
  const r = retailExpectationSignal({
    return1w: 4, return1m: 8, priceLevelPct: 50, volRatio: 1.2,
    creditTrendPct: 10, creditWeek1Pct: 3, daysToEarnings: 30,
  });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みあり');
});

test('ambushVerdict: retailExpectationがwarnなら「買い推奨」を維持しつつ理由に織り込みの兆しを補足する', () => {
  // ユーザー要望: 「買い推奨や様子見のところに個人投資家の期待が
  // 織り込まれつつある、といった結論の説明が欲しい」。warn段階は
  // 単独では買い推奨を覆さない（bad段階のみbadChipSignals経由で
  // 見送り/様子見に格下げされる）が、理由文には必ず反映する。
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
  assert.match(v.reason, /期待織り込みの兆し/);
  assert.match(v.reason, /織り込まれつつある/);
});

test('ambushVerdict: retailExpectationが他の赤旗で様子見に格下げされた後も、warnの補足が消えずに残る', () => {
  // worsen()はreasonを丸ごと上書きするため、途中で他の赤旗
  // （marginOverhang等）がworsen()を呼んだ後に追記しないと消えて
  // しまう再発防止。
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    marginOverhang: { level: 'bad', note: '信用過多です' },
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'hold');
  assert.match(v.reason, /信用過多です/);
  assert.match(v.reason, /期待織り込みの兆し/);
});

test('ambushVerdict: retailExpectationが無い/nullなら理由文は変わらない', () => {
  const r = { rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }] };
  const v = ambushVerdict(r);
  assert.doesNotMatch(v.reason, /織り込まれつつある/);
});

test('ambushVerdict: retailExpectationがbadなら（warn補足ではなく）badChipSignals経由の詳細な理由がそのまま出る', () => {
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    retailExpectation: { level: 'bad', note: '株価急騰と信用買い残急増が重なった高値圏での急騰で、材料出尽くしのリスクが高い状態です' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'hold');
  assert.match(v.reason, /材料出尽くし/);
});

test('smartEntryVerdict: retailExpectationがwarnなら「買い推奨」を維持しつつ理由に織り込みの兆しを補足する', () => {
  const r = {
    sig2: { level: 'good', note: 'トレンド転換の初動です' },
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = smartEntryVerdict(r, { level: null }, { level: null });
  assert.equal(v.level, 'buy');
  assert.match(v.reason, /トレンド転換の初動です/);
  assert.match(v.reason, /期待織り込みの兆し/);
});

test('ambushVerdict/smartEntryVerdict: retailExpectationのwarn補足文言は共通の1箇所から来ており、2つのverdict関数間で食い違わない', () => {
  // 再発防止: 以前はこの文言をambushVerdict/smartEntryVerdictの2箇所に
  // 個別に書いており、将来どちらか一方だけ文言を直すと食い違う抜けが
  // 起きうる状態だった。appendRetailExpectationCautionに一本化した後も
  // この一致が保たれることを固定する。
  const retailExpectation = { level: 'warn', label: '期待織り込みの兆し', note: 'x' };
  const ambush = ambushVerdict({ rank: 'S', evidence: true, catalysts: [{ label: 'テスト' }], retailExpectation });
  const smart = smartEntryVerdict({ sig1: { level: 'good', note: 'テスト該当' }, retailExpectation }, { level: null }, { level: null });
  const clause = '期待織り込みの兆し：株価や信用買い残の動きから、好材料への期待の一部が既に株価に織り込まれつつある可能性があります';
  assert.match(ambush.reason, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(smart.reason, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('progressStreakSignal: 同時期の進捗率が2年連続で上昇していればgood（実測: 6336石井表記のパターン）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率' },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率' },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率' },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.label, '進捗率が加速中');
  assert.match(r.note, /2年連続/);
  assert.match(r.note, /91.7%/);
});

test('progressStreakSignal: 経常益(profit)が同時に取得できていれば前年同期比の利益成長率をnoteに添える（実測: 6336石井表記の経常益100→194→376）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率', profit: 100 },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率', profit: 194 },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率', profit: 376 },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.profitYoyPct, 93.8);
  assert.match(r.note, /経常利益は前年同期比\+93\.8%/);
});

test('progressStreakSignal: profitが取得できていなければYoY成長率は添えない（従来通りのnoteのまま）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率' },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率' },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率' },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.profitYoyPct, null);
  assert.doesNotMatch(r.note, /前年同期比/);
});

test('progressStreakSignal: 前年(prev)の経常益が赤字(0以下)なら%が定義できないためprofitYoyPctはnull', () => {
  const history = [
    { period: '24.02-04', progress: 10, label: '対上期進捗率', profit: -80 },
    { period: '25.02-04', progress: 19.8, label: '対上期進捗率', profit: -50 }, // prev=赤字
    { period: '26.02-04', progress: 37.2, label: '対上期進捗率', profit: 100 }, // latest=黒字転換
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.profitYoyPct, null);
});

test('progressStreakSignal: 進捗率は加速していても経常利益が前年同期比マイナスならgoodではなくwarnに格下げする（実測: あさひ3333は進捗率75.3%→86.7%→92.6%と加速も経常益は前年同期比-7.8%）', () => {
  const history = [
    { period: '24.03-05', progress: 75.3, label: '対上期進捗率', profit: 200 },
    { period: '25.03-05', progress: 86.7, label: '対上期進捗率', profit: 150 },
    { period: '26.03-05', progress: 92.6, label: '対上期進捗率', profit: 138.3 }, // (138.3-150)/150 = -7.8%
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '進捗率は加速も利益は前年割れ');
  assert.equal(r.profitYoyPct, -7.8);
  assert.match(r.note, /前年同期比-7\.8%と減益/);
  assert.doesNotMatch(r.note, /好材料が出る可能性があります/); // goodの時の前向きな結論文言を引きずらない
});

test('progressStreakSignal: 直近で下落していれば連続にカウントしない', () => {
  const history = [
    { period: '24.02-04', progress: 40, label: '対上期進捗率' },
    { period: '25.02-04', progress: 60, label: '対上期進捗率' },
    { period: '26.02-04', progress: 30, label: '対上期進捗率' }, // 直近が下落
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('progressStreakSignal: データが1件以下・皆無ならchecked/level差を区別する', () => {
  assert.deepEqual(progressStreakSignal([]), { level: null, label: null, note: null, checked: false });
  const single = progressStreakSignal([{ period: '25.02-04', progress: 30 }]);
  assert.equal(single.level, null);
  assert.equal(single.checked, true); // データはあるが1件では連続と言えない
});

// retainedEarnings/investmentSecuritiesは円、marketCapは百万円（kabutan
// の単位に合わせる。marketCapYen参照）。marketCap:10_000＝時価総額100億円。
test('dividendPotentialSignal: 無配＋利益剰余金が時価総額の20%以上ならgood', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: 0 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '初配・株主還元期待');
  assert.match(r.note, /30%/);
});

test('dividendPotentialSignal: 既に配当を出している銘柄ではgoodにしない（無配が条件）', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: 1.5 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('dividendPotentialSignal: 配当利回りが未取得（null）なら無配と誤認せずchecked:false', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: null });
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('hiddenAssetSignal: 投資有価証券が時価総額の30%以上ならgood', () => {
  const r = hiddenAssetSignal({ investmentSecurities: 4_000_000_000, marketCap: 10_000 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '含み資産あり');
  assert.match(r.note, /40%/);
});

test('hiddenAssetSignal: 比率が閾値未満ならlevel:nullだがchecked:true', () => {
  const r = hiddenAssetSignal({ investmentSecurities: 1_000_000_000, marketCap: 10_000 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('hiddenAssetSignal: データ不足ならchecked:false', () => {
  assert.equal(hiddenAssetSignal({ investmentSecurities: null, marketCap: 10_000 }).checked, false);
});

test('creditFloatSignal: 占有率が20%以上ならbad（上値が重い）', () => {
  // 発行済株式数1,000万株・上位3株主30%保有→推定浮動株700万株。
  // 信用買い残150万株 ÷ 700万株 ≈ 21.4%
  const r = creditFloatSignal({ creditBuyBalance: 1_500_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '信用買い占有率が高い');
  assert.match(r.note, /21\.4%/);
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 21.4); // precursorCardの需給バッジが直接参照する生値
});

test('creditFloatSignal: 占有率が5%以下ならgood（需給が軽い）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '需給が軽い');
  assert.match(r.note, /2\.9%/);
  assert.equal(r.occupancy, 2.9);
});

test('creditFloatSignal: 5%超20%未満ならlevel:nullだがchecked:true。occupancyはこの中間域でも需給バッジ用に返す', () => {
  const r = creditFloatSignal({ creditBuyBalance: 700_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 10);
});

test('creditFloatSignal: occupancyは軽くてもloanRatio(信用倍率)がMARGIN_OVERHANG.heavy以上ならgoodと言い切らずwarnに格下げする（実測: サムコ83.09倍・神戸物産16.26倍・Japan Eyewear 1872倍で「需給が軽い」と「信用過多」が同時に出ていた矛盾の再発防止）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30, loanRatio: 83.09 });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '需給判断に注意');
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 2.9);
  assert.match(r.note, /83\.09倍/);
});

test('creditFloatSignal: loanRatioがMARGIN_OVERHANG.heavy未満ならoccupancyが軽い場合は従来通りgood', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30, loanRatio: 3 });
  assert.equal(r.level, 'good');
});

test('creditFloatSignal: loanRatioが未取得(null)でも従来通りoccupancyだけでgood判定する（loanRatioは任意パラメータ）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'good');
});

test('creditFloatSignal: データ不足ならchecked:false', () => {
  assert.equal(creditFloatSignal({ creditBuyBalance: null, sharesOutstanding: 10_000_000, top3PctNow: 30 }).checked, false);
  assert.equal(creditFloatSignal({}).checked, false);
});

test('creditFloatSignal: 上位3株主保有比率が100%以上（発行済株式数を超過する異常データ）ならchecked:false', () => {
  const r = creditFloatSignal({ creditBuyBalance: 100_000, sharesOutstanding: 10_000_000, top3PctNow: 100 });
  assert.equal(r.checked, false);
});

test('creditFloatSignal: creditBuyBalance/sharesOutstandingは同じ単位（株）のため単位換算しない（実データ確認済み: 6336）', () => {
  // marketCapYenのような換算は不要。実データで両者とも「株」単位であることを確認済み
  // （6336: 信用買い残475,100株・発行済株式数8,176,452株）。上位3株主保有比率を
  // 意図的に高めにして閾値を超えさせ、単位を誤って縮小していれば発生するはずの
  // 桁あふれ（数千〜数百万%）が起きず、常識的な範囲の%になることを確認する。
  const r = creditFloatSignal({ creditBuyBalance: 475_100, sharesOutstanding: 8_176_452, top3PctNow: 75 });
  assert.equal(r.checked, true);
  assert.equal(r.level, 'bad');
  assert.match(r.note, /475,100株/);
  // 推定浮動株数=8,176,452×0.25≈2,044,113株。桁が発行済株式数と近い水準に
  // なっている（100万分の1等に誤って縮小していない）ことを確認する。
  assert.match(r.note, /2,044,11\d株/);
  assert.match(r.note, /23\.\d%/);
});

test('computeFloatRatio: 発行済株式数と上位3株主保有比率から浮動株比率を計算する', () => {
  assert.equal(computeFloatRatio({ sharesOutstanding: 10_000_000, top3PctNow: 60 }), 0.4);
});

test('computeFloatRatio: 上位3株主保有比率が100%以上（異常データ）ならnull', () => {
  assert.equal(computeFloatRatio({ sharesOutstanding: 10_000_000, top3PctNow: 100 }), null);
});

test('computeFloatRatio: データ不足ならnull', () => {
  assert.equal(computeFloatRatio({}), null);
  assert.equal(computeFloatRatio({ sharesOutstanding: 0, top3PctNow: 50 }), null);
});

test('floatSqueezeSignal: 浮動株比率が低く出来高が急増していればgood（ユーザー提案: 浮動株比率×出来高急増）', () => {
  const r = floatSqueezeSignal({ floatRatio: 0.2, volumeRatio: 3 });
  assert.equal(r.level, 'good');
  assert.match(r.note, /20%/);
});

test('floatSqueezeSignal: 浮動株比率が高ければ出来高が急増していてもgoodにならない', () => {
  const r = floatSqueezeSignal({ floatRatio: 0.8, volumeRatio: 3 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('floatSqueezeSignal: 出来高が急増していなければ浮動株比率が低くてもgoodにならない', () => {
  const r = floatSqueezeSignal({ floatRatio: 0.2, volumeRatio: 1 });
  assert.equal(r.level, null);
});

test('floatSqueezeSignal: データ不足ならchecked:false', () => {
  assert.equal(floatSqueezeSignal({}).checked, false);
});

test('breakoutVolumeSignal: 高値圏×出来高急増ならgood（ユーザー提案: 順張りブレイクアウト）', () => {
  const r = breakoutVolumeSignal({ priceLevelPct: 95, volumeRatio: 2.5 });
  assert.equal(r.level, 'good');
});

test('breakoutVolumeSignal: 高値圏でも出来高が伴わなければgoodにならない', () => {
  assert.equal(breakoutVolumeSignal({ priceLevelPct: 95, volumeRatio: 1.2 }).level, null);
});

test('breakoutVolumeSignal: 出来高が急増していても高値圏でなければgoodにならない（レンジ中腹での出来高急増は別物）', () => {
  assert.equal(breakoutVolumeSignal({ priceLevelPct: 50, volumeRatio: 3 }).level, null);
});

test('breakoutVolumeSignal: データ不足ならchecked:false', () => {
  assert.equal(breakoutVolumeSignal({}).checked, false);
});

test('growthAccelerationSignal: 前期より今期の成長率が高ければgood（ユーザー提案: 前々期+10%→前期+15%→今期+30%のような加速）', () => {
  const r = growthAccelerationSignal({ growthPct: 30, prevGrowthPct: 15 });
  assert.equal(r.level, 'good');
  assert.match(r.note, /\+15%/);
  assert.match(r.note, /\+30%/);
});

test('growthAccelerationSignal: 今期の成長率が前期以下なら加速していないのでgoodにならない（減速・横ばい）', () => {
  assert.equal(growthAccelerationSignal({ growthPct: 10, prevGrowthPct: 15 }).level, null);
  assert.equal(growthAccelerationSignal({ growthPct: 15, prevGrowthPct: 15 }).level, null);
});

test('growthAccelerationSignal: 今期の成長率がマイナスなら「加速」とは呼ばない（前期より下落幅が縮んだだけで加速扱いにしない）', () => {
  assert.equal(growthAccelerationSignal({ growthPct: -5, prevGrowthPct: -20 }).level, null);
});

test('growthAccelerationSignal: データ不足ならchecked:false（scoreもnull）', () => {
  const r1 = growthAccelerationSignal({ growthPct: 30, prevGrowthPct: null });
  assert.equal(r1.checked, false);
  assert.equal(r1.score, null);
  assert.equal(growthAccelerationSignal({}).checked, false);
});

// A指示 項目7「成長加速を独立スコア化する」: 前期→今期の伸び率
// （前々期+10%→前期+15%→今期+30%の例なら加速幅+15pt）に加え、
// 営業利益率改善・粗利率改善（deficitGrowthSignal用に追加したEDINET
// タグで計算可能）を織り込んだ連続値scoreを返す。
test('growthAccelerationSignal: 加速幅（今期成長率-前期成長率）に比例したscoreを返す', () => {
  const small = growthAccelerationSignal({ growthPct: 20, prevGrowthPct: 15 }); // 加速幅5pt
  const big = growthAccelerationSignal({ growthPct: 30, prevGrowthPct: 15 }); // 加速幅15pt
  assert.ok(Number.isFinite(small.score) && Number.isFinite(big.score));
  assert.ok(big.score > small.score, '加速幅が大きいほどscoreは高くなるべき');
});

test('growthAccelerationSignal: 粗利率改善・営業利益率改善があればscoreにボーナスが乗る（項目7の評価項目「営業利益率改善」「粗利率改善」）', () => {
  const base = growthAccelerationSignal({ growthPct: 30, prevGrowthPct: 15 });
  const withMargins = growthAccelerationSignal({ growthPct: 30, prevGrowthPct: 15, grossMarginImproving: true, opMarginImproving: true });
  assert.ok(withMargins.score > base.score);
  assert.match(withMargins.note, /粗利率・営業利益率も改善/);
});

test('growthAccelerationSignal: scoreは0-100にクランプされる（成長が加速していなくても粗利率/営業利益率改善だけでは加速スコアが0を超えて良いが、上限は超えない）', () => {
  const r = growthAccelerationSignal({ growthPct: 200, prevGrowthPct: 15, grossMarginImproving: true, opMarginImproving: true });
  assert.ok(r.score <= 100);
});

test('usEarningsTrendSignal: 1つ前の四半期のYoYも計算できればprevRevenueGrowthPctとして返す（成長の「加速」判定用）', () => {
  const trend = [
    { end: '2024-06-27', revenue: 100, netIncome: 10 },
    { end: '2024-09-27', revenue: 105, netIncome: 10 },
    { end: '2025-06-27', revenue: 110, netIncome: 10 }, // 前期のYoY = (110-100)/100 = 10%
    { end: '2025-09-27', revenue: 130, netIncome: 10 }, // 直近のYoY = (130-105)/105 ≈ 23.8%
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.checked, true);
  assert.equal(r.prevRevenueGrowthPct, 10);
});

test('usEarningsTrendSignal: 研究開発費（rnd）があればrndGrowthPctを返す（aggressiveInvestmentSignal用）', () => {
  const trend = [
    { end: '2024-09-27', revenue: 105, netIncome: 10, rnd: 20 },
    { end: '2025-09-27', revenue: 130, netIncome: 10, rnd: 30 },
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.rndGrowthPct, 50); // (30-20)/20*100
});

test('usEarningsTrendSignal: 研究開発費を開示していなければrndGrowthPct:null（推測で埋めない）', () => {
  const trend = [
    { end: '2024-09-27', revenue: 105, netIncome: 10 },
    { end: '2025-09-27', revenue: 130, netIncome: 10 },
  ];
  assert.equal(usEarningsTrendSignal(trend).rndGrowthPct, null);
});

test('aggressiveInvestmentSignal: 研究開発費の伸びが売上高成長率を明確に上回ればgood（ユーザー提案: 攻めの赤字を許容する）', () => {
  const r = aggressiveInvestmentSignal({ rndGrowthPct: 40, revenueGrowthPct: 20 });
  assert.equal(r.level, 'good');
});

test('aggressiveInvestmentSignal: 研究開発費の伸びが売上高成長率を僅かにしか上回らなければgoodにならない', () => {
  assert.equal(aggressiveInvestmentSignal({ rndGrowthPct: 25, revenueGrowthPct: 20 }).level, null);
});

test('aggressiveInvestmentSignal: 研究開発費の伸びが売上高成長率以下ならgoodにならない', () => {
  assert.equal(aggressiveInvestmentSignal({ rndGrowthPct: 15, revenueGrowthPct: 20 }).level, null);
});

test('aggressiveInvestmentSignal: データ不足（研究開発費を開示していない）ならchecked:false', () => {
  assert.equal(aggressiveInvestmentSignal({ rndGrowthPct: null, revenueGrowthPct: 20 }).checked, false);
  assert.equal(aggressiveInvestmentSignal({}).checked, false);
});

test('themeMatchSignal: 該当テーマがあればgood（ユーザー提案: テーマ性とのマッチング。自動発見ではなく手動キュレーションリストとの照合である旨を明記する）', () => {
  const r = themeMatchSignal({ matchedThemes: ['サイバーセキュリティ'] });
  assert.equal(r.level, 'good');
  assert.match(r.note, /自動発見ではなく/);
  assert.match(r.label, /サイバーセキュリティ/);
});

test('themeMatchSignal: 該当テーマが無ければlevel:nullだがchecked:true（照合はできた上で該当が無いだけ）', () => {
  const r = themeMatchSignal({ matchedThemes: [] });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('themeMatchSignal: matchedThemesが配列でなければchecked:false（照合自体ができていない）', () => {
  assert.equal(themeMatchSignal({}).checked, false);
  assert.equal(themeMatchSignal({ matchedThemes: null }).checked, false);
});

test('consensusTrapSignal: 会社予想がコンセンサス比-5%以下なら期待過剰(bad)（WATCHLIST時代に使われていたが呼び出し側だけ削除されデッドコード化していたのを発掘・復活）', () => {
  const r = consensusTrapSignal(950, 1000); // (950-1000)/1000 = -5%
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '期待過剰');
  assert.equal(r.checked, true);
  assert.match(r.note, /暴落する危険地帯/);
});

test('consensusTrapSignal: 会社予想がコンセンサス比+5%以上なら期待薄(good)', () => {
  const r = consensusTrapSignal(1050, 1000); // +5%
  assert.equal(r.level, 'good');
  assert.equal(r.label, '期待薄');
  assert.equal(r.checked, true);
  assert.match(r.note, /跳ねる可能性/);
});

test('consensusTrapSignal: 差が-5%超+5%未満なら中立(warn)', () => {
  const r = consensusTrapSignal(1020, 1000); // +2%
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '中立');
  assert.equal(r.checked, true);
});

test('consensusTrapSignal: 会社予想・コンセンサスのどちらかが無ければchecked:falseで、欠けている方を区別する', () => {
  const noEstimate = consensusTrapSignal(null, 1000);
  assert.equal(noEstimate.checked, false);
  assert.match(noEstimate.note, /会社予想N\/A/);

  const noConsensus = consensusTrapSignal(1000, null);
  assert.equal(noConsensus.checked, false);
  assert.match(noConsensus.note, /^コンセンサスN\/A$/);

  const noConsensusZero = consensusTrapSignal(1000, 0); // 0は「未算出」であって予想利益0円ではない
  assert.equal(noConsensusZero.checked, false);

  const both = consensusTrapSignal(null, null);
  assert.equal(both.checked, false);
  assert.match(both.note, /共にN\/A/);
});

test('usEarningsTrendSignal: 直近四半期の売上高・純利益とも前年同期比+15%以上ならgood（実測: AAPLの2026-06-27四半期で+16.4%/+27.1%）', () => {
  const trend = [
    { end: '2024-12-28', revenue: 124300000000, netIncome: 36330000000 },
    { end: '2025-03-29', revenue: 95359000000, netIncome: 24780000000 },
    { end: '2025-06-28', revenue: 94036000000, netIncome: 23434000000 },
    { end: '2025-12-27', revenue: 143756000000, netIncome: 42097000000 },
    { end: '2026-03-28', revenue: 111184000000, netIncome: 29578000000 },
    { end: '2026-06-27', revenue: 109417000000, netIncome: 29789000000 },
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.level, 'good');
  assert.equal(r.checked, true);
  assert.equal(r.revenueGrowthPct, 16.4);
  assert.equal(r.netIncomeGrowthPct, 27.1);
});

test('usEarningsTrendSignal: 米国会計特有の「Q4単独値が欠けている」ギャップがあっても日付ベースで正しく前年同期を見つける（実測: Appleは2025-06-28の次が2025-12-27であり2025-09-27週のQ3単独値が存在しない）', () => {
  // 2026-06-27 の前年同期は暦日ベースで2025-06-28（約364日前）であるべきで、
  // インデックスで4つ前（2024-12-28）を誤って前年同期にしないことを確認する。
  const trend = [
    { end: '2024-12-28', revenue: 100, netIncome: 10 },
    { end: '2025-03-29', revenue: 100, netIncome: 10 },
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2025-12-27', revenue: 100, netIncome: 10 },
    { end: '2026-03-28', revenue: 100, netIncome: 10 },
    { end: '2026-06-27', revenue: 230, netIncome: 23 }, // 2025-06-28(200)比+15%
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.revenueGrowthPct, 15);
});

test('usEarningsTrendSignal: 売上高が前年同期比-10%以下、または純利益が-20%以下ならbad（減収減益）', () => {
  const trendRevenueDown = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 170, netIncome: 20 }, // -15%
  ];
  assert.equal(usEarningsTrendSignal(trendRevenueDown).level, 'bad');

  const trendProfitDown = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 200, netIncome: 14 }, // netIncome -30%
  ];
  assert.equal(usEarningsTrendSignal(trendProfitDown).level, 'bad');
});

test('usEarningsTrendSignal: 1年前に相当する四半期が無い・データ不足ならchecked:false', () => {
  assert.equal(usEarningsTrendSignal([]).checked, false);
  assert.equal(usEarningsTrendSignal([{ end: '2026-06-27', revenue: 100, netIncome: 10 }]).checked, false);
  // 直近四半期しかなく1年以上遡れる過去データが無い場合
  const tooShort = [
    { end: '2026-03-28', revenue: 100, netIncome: 10 },
    { end: '2026-06-27', revenue: 110, netIncome: 11 },
  ];
  assert.equal(usEarningsTrendSignal(tooShort).checked, false);
});

test('usEarningsTrendSignal: 最新データが古すぎる(200日超)ならchecked:falseにする（実測: BXMTのようなREITが業種特有の理由で汎用売上高タグのquarterly開示を10年以上前にやめており、配列の最後が2014年のデータだったのに「直近四半期」として+117%成長と表示していた重大バグの再発防止）', () => {
  const staleTrend = [
    { end: '2013-12-31', revenue: 50, netIncome: 10 },
    { end: '2014-12-31', revenue: 58, netIncome: 12 }, // 有効なYoYペア（+16%）だが2026年から見れば10年以上前
  ];
  const r = usEarningsTrendSignal(staleTrend, '2026-08-28');
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('usEarningsTrendSignal: asOfを渡さなければ従来通り古さをチェックしない（単体テストの後方互換）', () => {
  const staleTrend = [
    { end: '2013-12-31', revenue: 50, netIncome: 10 },
    { end: '2014-12-31', revenue: 58, netIncome: 12 }, // 前年同期比+16%（有効なYoYペア）
  ];
  const r = usEarningsTrendSignal(staleTrend); // asOf省略
  assert.equal(r.checked, true);
});

test('usEarningsTrendSignal: 最新データが200日以内なら通常通り判定する', () => {
  const trend = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 240, netIncome: 24 },
  ];
  const r = usEarningsTrendSignal(trend, '2026-08-28'); // 2026-06-27から62日後
  assert.equal(r.checked, true);
  assert.equal(r.level, 'good');
});

test('usEarningsTrendSignal: netIncomeが無い/前年が赤字の場合は売上高だけで判定する', () => {
  const trend = [
    { end: '2025-06-28', revenue: 200, netIncome: -5 }, // 前年赤字
    { end: '2026-06-27', revenue: 240, netIncome: 3 }, // +20%
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.netIncomeGrowthPct, null);
  assert.equal(r.revenueGrowthPct, 20);
  assert.equal(r.level, 'good'); // netIncomeGrowthPctがnullならrevenueだけで判定
});

test('tenbaggerSignal: 時価総額が上限以下・売上高成長率が閾値以上ならgood', () => {
  const r = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'テンバガー候補');
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 時価総額がちょうど上限ならgood（<=）', () => {
  const r = tenbaggerSignal({ marketCap: 30_000, maxMarketCap: 30_000, revenueGrowthPct: 25 });
  assert.equal(r.level, 'good');
});

test('tenbaggerSignal: 時価総額が上限超過ならlevel:null（大型株はテンバガー候補にしない）', () => {
  const r = tenbaggerSignal({ marketCap: 30_001, maxMarketCap: 30_000, revenueGrowthPct: 50 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 成長率が閾値未満ならlevel:null（小型でも成長していなければ対象外）', () => {
  const r = tenbaggerSignal({ marketCap: 10_000, maxMarketCap: 30_000, revenueGrowthPct: 24.9 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 日本株(百万円)・米国株(百万USD)どちらも同じ「100万単位」の値として単位変換無しで正しく判定する', () => {
  // 日本株: 時価総額200億円(=20,000百万円) <= 上限300億円(=30,000百万円)
  const jp = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 40 });
  assert.equal(jp.level, 'good');
  // 米国株: 時価総額$1.5B(=1,500百万USD) <= 上限$2B(=2,000百万USD)
  const us = tenbaggerSignal({ marketCap: 1_500, maxMarketCap: 2_000, revenueGrowthPct: 40 });
  assert.equal(us.level, 'good');
});

test('tenbaggerSignal: unitLabelを渡すと時価総額の数値に単位が付く（実測バグ: 単位無しで「時価総額が20,300」と表示され、円なのか百万円なのか読者に分からなかった再発防止）', () => {
  const withUnit = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30, unitLabel: '百万円' });
  assert.ok(withUnit.note.includes('20,000百万円'), `noteに単位付きの数値が含まれていません: ${withUnit.note}`);
  const withoutUnit = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30 });
  assert.ok(withoutUnit.note.includes('20,000'), '単位無し呼び出しは後方互換のため空文字がデフォルトであるべき');
});

test('tenbaggerSignal: データ不足ならchecked:false', () => {
  assert.equal(tenbaggerSignal({ marketCap: null, maxMarketCap: 30_000, revenueGrowthPct: 40 }).checked, false);
  assert.equal(tenbaggerSignal({ marketCap: 10_000, maxMarketCap: 30_000, revenueGrowthPct: null }).checked, false);
  assert.equal(tenbaggerSignal({}).checked, false);
});

test('midCapGrowthSignal: 時価総額が上限以下・売上高成長率が閾値以上ならgood', () => {
  const r = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 40 });
  assert.equal(r.level, 'good');
  assert.equal(r.checked, true);
});

test('midCapGrowthSignal: 時価総額が上限を超えるとlevel:null（実測バグの再発防止: 旧nextGenTenbaggerSignalは上限が無く、AUR時価総額$118億が「10倍に$1180億必要」という非現実的な候補として出続けていた）', () => {
  const r = midCapGrowthSignal({ marketCap: 15_802, maxMarketCap: 10_000, revenueGrowthPct: 40 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

// A指示 項目13「米国テンバガーTierを3段階にする」: v7.4では旧Tier Bの
// 上限を単純に$20,000Mへ引き上げてIONQ($15,802M)・AUR($11,800M)を救済
// していたが、指示書は「Tier B（$1B〜$10B・2〜5倍候補）」「Tier C
// （$10B〜$20B程度・大型化後の超成長株、2〜3倍）」を別枠と定義している。
// IONQ・AURは新しいTier B上限($10,000M)を超えるためTier Bにはならず、
// Tier C上限($20,000M)では該当することを確認する。
test('midCapGrowthSignal: IONQ($15,802M)・AUR($11,800M)相当の時価総額は、新しいTier B上限($10,000M)ではgoodにならず、Tier C上限($20,000M)ではgoodになる', async () => {
  const { US_TIER_B_MAX_MARKET_CAP_USD, US_TIER_C_MAX_MARKET_CAP_USD } = await import('../us_tenbagger.mjs');
  assert.equal(US_TIER_B_MAX_MARKET_CAP_USD, 10_000);
  assert.equal(US_TIER_C_MAX_MARKET_CAP_USD, 20_000);
  const ionqTierB = midCapGrowthSignal({ marketCap: 15_802, maxMarketCap: US_TIER_B_MAX_MARKET_CAP_USD, revenueGrowthPct: 40 });
  const aurTierB = midCapGrowthSignal({ marketCap: 11_800, maxMarketCap: US_TIER_B_MAX_MARKET_CAP_USD, revenueGrowthPct: 40 });
  assert.equal(ionqTierB.level, null);
  assert.equal(aurTierB.level, null);
  const ionqTierC = midCapGrowthSignal({ marketCap: 15_802, maxMarketCap: US_TIER_C_MAX_MARKET_CAP_USD, revenueGrowthPct: 40 });
  const aurTierC = midCapGrowthSignal({ marketCap: 11_800, maxMarketCap: US_TIER_C_MAX_MARKET_CAP_USD, revenueGrowthPct: 40 });
  assert.equal(ionqTierC.level, 'good');
  assert.equal(aurTierC.level, 'good');
});

test('midCapGrowthSignal: label/multipleLabelを渡すと表示ラベル・倍率表現をTierごとに変えられる（Tier B=2〜5倍・Tier C=2〜3倍）', () => {
  const tierB = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 40, label: '中型成長株候補(Tier B)', multipleLabel: '2〜5倍' });
  assert.equal(tierB.label, '中型成長株候補(Tier B)');
  assert.match(tierB.note, /2〜5倍程度の成長余地/);

  const tierC = midCapGrowthSignal({ marketCap: 15_000, maxMarketCap: 20_000, revenueGrowthPct: 40, label: '大型超成長株(Tier C)', multipleLabel: '2〜3倍' });
  assert.equal(tierC.label, '大型超成長株(Tier C)');
  assert.match(tierC.note, /2〜3倍程度の成長余地/);
});

test('midCapGrowthSignal: 成長率が閾値未満ならlevel:null（時価総額が範囲内なだけでは該当しない）', () => {
  const r = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 10 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('midCapGrowthSignal: unitLabelを渡すと時価総額の数値に単位が付く（tenbaggerSignalと同じ再発防止）', () => {
  const withUnit = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 40, unitLabel: '百万USD' });
  assert.ok(withUnit.note.includes('5,000百万USD'), `noteに単位付きの数値が含まれていません: ${withUnit.note}`);
});

test('midCapGrowthSignal: データ不足ならchecked:false', () => {
  assert.equal(midCapGrowthSignal({ marketCap: null, maxMarketCap: 10_000, revenueGrowthPct: 40 }).checked, false);
  assert.equal(midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: null }).checked, false);
  assert.equal(midCapGrowthSignal({}).checked, false);
});

// v7.5改修（ユーザー提案「テーマ性×小型×高成長×未織り込みが揃ったら
// DIAMONDにする」）。A指示 項目17「『テーマ性』だけではDIAMONDにしない」
// で成長加速・財務健全（現金が有利子負債を上回る）・カタリストの3条件を
// 追加し、7条件すべてを要求するよう拡張した。
const DIAMOND_BASE = {
  themeMatch: { level: 'good', label: 'テーマ性あり（防衛）', note: '防衛' },
  marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 30, repricingLagZone: 'pre_move',
  growthAcceleration: { level: 'good' }, cash: 3_000, interestBearingDebt: 1_000, hasCatalyst: true,
};

test('diamondSignal: テーマ・小型・高成長・成長加速・未織り込み・財務健全・カタリストの7条件が全て揃えばgood', () => {
  const r = diamondSignal(DIAMOND_BASE);
  assert.equal(r.level, 'good');
  assert.match(r.label, /DIAMOND/);
});

test('diamondSignal: テーマ性が無ければ他の条件が揃っていてもgoodにならない', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, themeMatch: { level: null } });
  assert.equal(r.level, null);
});

test('diamondSignal: 既に「再評価済み(re_rating)」「織り込み済み(priced_in)」ならgoodにならない（未織り込みではない）', () => {
  assert.equal(diamondSignal({ ...DIAMOND_BASE, repricingLagZone: 're_rating' }).level, null);
  assert.equal(diamondSignal({ ...DIAMOND_BASE, repricingLagZone: 'priced_in' }).level, null);
});

test('diamondSignal: 時価総額が上限を超えていれば「小型」条件を満たさずgoodにならない', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, marketCap: 15_000 });
  assert.equal(r.level, null);
});

test('diamondSignal: unitLabelを渡すと時価総額の数値に単位が付く', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, unitLabel: '百万円' });
  assert.ok(r.note.includes('5,000百万円'), `noteに単位付きの数値が含まれていません: ${r.note}`);
});

test('diamondSignal: 成長が加速していなければ（growthAccelerationがgoodでなければ）goodにならない（A指示項目17: テーマ性だけでDIAMONDにしない）', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, growthAcceleration: { level: null } });
  assert.equal(r.level, null);
});

test('diamondSignal: 現金が有利子負債を下回る（財務健全でない）ならgoodにならない', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, cash: 500, interestBearingDebt: 1_000 });
  assert.equal(r.level, null);
});

test('diamondSignal: cash/interestBearingDebtが未取得（データ不足）ならgoodにならない（データ不足を好材料扱いしない）', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, cash: null, interestBearingDebt: null });
  assert.equal(r.level, null);
});

test('diamondSignal: カタリスト（hasCatalyst）が無ければgoodにならない', () => {
  const r = diamondSignal({ ...DIAMOND_BASE, hasCatalyst: false });
  assert.equal(r.level, null);
});

// A指示 項目14/36「『10倍可能性』と『今買う妙味』を分離」「現在の時価
// 総額から10倍の現実性を計算」: 時価総額がTier上限にどれだけ近いかを
// 0-100の連続値にする。
test('tenbaggerRealizabilityScore: 時価総額がTier上限に近いほど低いスコアになる（実測: AURのような大型成長株は10倍が非現実的）', () => {
  const small = tenbaggerRealizabilityScore({ marketCap: 100, maxMarketCap: 1_000 }); // 上限の10%
  const large = tenbaggerRealizabilityScore({ marketCap: 900, maxMarketCap: 1_000 }); // 上限の90%
  assert.equal(small, 90);
  assert.equal(large, 10);
  assert.ok(small > large, '時価総額が上限に近いほどスコアは低くなるべき');
});

test('tenbaggerRealizabilityScore: 時価総額またはmaxMarketCapが無ければnull', () => {
  assert.equal(tenbaggerRealizabilityScore({ marketCap: null, maxMarketCap: 1_000 }), null);
  assert.equal(tenbaggerRealizabilityScore({ marketCap: 100, maxMarketCap: null }), null);
});

test('tenbaggerRealizabilityScore: 時価総額がTier上限を超えていても0未満にならない（クランプ）', () => {
  const r = tenbaggerRealizabilityScore({ marketCap: 2_000, maxMarketCap: 1_000 });
  assert.equal(r, 0);
});

// A指示 項目15「10倍実現難易度を評価（低/中/高/極めて高）」。
test('tenbaggerDifficultyLabel: 実現可能性スコアが高いほど難易度は低い（4段階ラベル）', () => {
  assert.equal(tenbaggerDifficultyLabel(90), '低');
  assert.equal(tenbaggerDifficultyLabel(75), '低');
  assert.equal(tenbaggerDifficultyLabel(60), '中');
  assert.equal(tenbaggerDifficultyLabel(50), '中');
  assert.equal(tenbaggerDifficultyLabel(30), '高');
  assert.equal(tenbaggerDifficultyLabel(25), '高');
  assert.equal(tenbaggerDifficultyLabel(10), '極めて高');
  assert.equal(tenbaggerDifficultyLabel(0), '極めて高');
});

test('tenbaggerDifficultyLabel: データが無ければnull（推測で難易度を決めない）', () => {
  assert.equal(tenbaggerDifficultyLabel(null), null);
});

// A指示 項目14「成長ポテンシャル」: buildScorePartsのrevenueGrowth評価
// （成長率×2＋成長加速ボーナス15、0-100クランプ）と同じ物差しを流用する。
test('growthPotentialScore: 売上高成長率×2＋成長加速ボーナスを0-100にクランプする（buildScorePartsのrevenueGrowthと同じ物差し）', () => {
  assert.equal(growthPotentialScore({ revenueGrowthPct: 30 }), 60);
  assert.equal(growthPotentialScore({ revenueGrowthPct: 30, growthAcceleration: { level: 'good' } }), 75);
  assert.equal(growthPotentialScore({ revenueGrowthPct: 60 }), 100); // クランプ
  assert.equal(growthPotentialScore({ revenueGrowthPct: null }), null);
});

// Repricing Gap v2再設計（ユーザー報告の実測バグ: 米国株ONDSで売上高成長率
// +1235.4%・利益データ欠損・株価3ヶ月-3.8%という組み合わせからRepricing
// Gap +908.3ptという投資判断上ほぼ無意味な数値が出ていた）。
// 「業績成長率(YoY %)－株価騰落率(%)の単純差分」を廃止し、winsorize・
// 期間統一(1ヶ月)・セクター相対化を経た差分に再設計した（indicators.mjs
// のrepricingGapScore/repricingGapBreakdownのコメント参照）。
// 以下は再設計時にユーザーが指定した8ケースの検証。

test('repricingGapScore: ①業績予想↑・株価ほぼ横ばいは、②業績↑・株価↑↑より大きい（再評価余地ありの方向）', () => {
  const flat = repricingGapScore({ revenueGrowthPct: 40, profitGrowthPct: 30, return1m: 1, priceLevelPct: 30 });
  const surged = repricingGapScore({ revenueGrowthPct: 40, profitGrowthPct: 30, return1m: 40, priceLevelPct: 80 });
  assert.equal(flat, 23.8);
  assert.equal(surged, -1);
  assert.ok(flat > surged, '株価が既に大きく反応済みのケースは、同じ業績改善でもgapが縮む方向であるべき');
});

test('repricingGapScore: ③業績予想↓・株価↓が同程度ならgapはほぼ0（未織り込みとは判定しない）', () => {
  const r = repricingGapScore({ revenueGrowthPct: -20, profitGrowthPct: -20, return1m: -20, priceLevelPct: 30 });
  assert.equal(r, 0);
});

test('repricingGapScore: ③業績↓・株価が業績以上に下げていてgapが正でも、performanceRateの符号で「未織り込み」ではなく下振れ超過と区別できる', () => {
  const r = repricingGapScore({ revenueGrowthPct: -20, profitGrowthPct: -20, return1m: -35, priceLevelPct: 30 });
  const detail = repricingGapBreakdown({ revenueGrowthPct: -20, profitGrowthPct: -20, return1m: -35 });
  assert.equal(r, 10.5);
  assert.ok(r > 0 && detail.performanceRate <= 0, '呼び出し側(scraper.mjs)はperformanceRate<=0を見て「未織り込み」の文言を出さない判断ができる');
});

test('repricingGapScore: ④業績データ（売上・利益とも）が無ければ推定しない（null）', () => {
  assert.equal(repricingGapScore({ revenueGrowthPct: null, profitGrowthPct: null, return1m: 10, priceLevelPct: 30 }), null);
  assert.equal(repricingGapScore({ return1m: 10, priceLevelPct: 30 }), null);
});

test('repricingGapScore: 株価反応データが無ければ推定しない（null）', () => {
  assert.equal(repricingGapScore({ revenueGrowthPct: 30, profitGrowthPct: 20, priceLevelPct: 30 }), null);
});

test('repricingGapBreakdown: ⑤EPS予想の変化は未収集のため常にN/A（null）扱い', () => {
  const d = repricingGapBreakdown({ revenueGrowthPct: 30, profitGrowthPct: 20, return1m: 5 });
  assert.equal(d.epsForecastChange, null);
});

test('repricingGapScore: ⑥前年比売上が異常に大きい(+1235.4%、実測ONDS)だけでGapが異常値化しない（winsorizeで頭打ち）', () => {
  const extreme = repricingGapScore({ revenueGrowthPct: 1235.4, profitGrowthPct: null, return1m: -11.8, priceLevelPct: 26.7 });
  const normal = repricingGapScore({ revenueGrowthPct: REPRICING_GAP.growthCapPct, profitGrowthPct: null, return1m: -11.8, priceLevelPct: 26.7 });
  assert.equal(extreme, 81.9); // 旧式なら+908.3ptだった組み合わせ
  assert.equal(extreme, normal, 'growthCapPctちょうどと、それを大幅に超える値は同じ結果になる（青天井にならない）');
  assert.ok(extreme < 200, '旧式の+908.3ptのような3桁後半の異常値にはならない');
});

test('repricingGapScore: ⑦セクター(業種)の同期間騰落率が分かれば、市場全体・セクター全体の上昇と銘柄固有の反応を区別できる', () => {
  const withoutSector = repricingGapScore({ revenueGrowthPct: 40, profitGrowthPct: 30, return1m: 20, priceLevelPct: 30 });
  const withSector = repricingGapScore({ revenueGrowthPct: 40, profitGrowthPct: 30, return1m: 20, sectorReturn1m: 18, priceLevelPct: 30 });
  assert.equal(withoutSector, 10.5);
  assert.equal(withSector, 23.1);
  assert.notEqual(withoutSector, withSector, 'セクターも同時に+18%上がっていた場合、銘柄固有の反応は+2%しかなく、単純な+20%読みとは異なる結果になるべき');
});

test('repricingGapScore: ⑧売上・利益の片方が欠損している銘柄は、両方揃っている銘柄よりスコアが有利にならない', () => {
  const bothAvailable = repricingGapScore({ revenueGrowthPct: 50, profitGrowthPct: 50, return1m: 5, priceLevelPct: 30 });
  const onlyRevenue = repricingGapScore({ revenueGrowthPct: 50, profitGrowthPct: null, return1m: 5, priceLevelPct: 30 });
  assert.equal(bothAvailable, 31.5);
  assert.equal(onlyRevenue, 14);
  assert.ok(onlyRevenue < bothAvailable, '欠損（利益データ無し）を良い方に補完せず、確認できた指標が少ない分スコアを割り引く');
});

test('repricingGapScore: priceLevelPctが無ければ割り引かない（tempering=1のまま）', () => {
  const r = repricingGapScore({ revenueGrowthPct: 30, profitGrowthPct: 30, return1m: 10 });
  assert.equal(r, 20);
});

test('repricingLagScore: 直近1ヶ月+20%以上騰落していれば、スコアの内訳に関係なく強制的にzone:priced_in（オーバーライドルール）', () => {
  const r = repricingLagScore({
    return1m: 25, return3m: 5, priceLevelPct: 10, // 未織り込み度は高そうに見えるスコア構成
    revenueGrowthPct: 40, profitGrowthPct: 40, per: 5, sectorPer: 20, hasCatalyst: true, daysToEarnings: 5,
  });
  assert.equal(r.zone, 'priced_in');
});

test('repricingLagScore: 直近3ヶ月+40%以上でもオーバーライドが発火する', () => {
  const r = repricingLagScore({ return1m: 2, return3m: 45, priceLevelPct: 20, revenueGrowthPct: 30 });
  assert.equal(r.zone, 'priced_in');
});

test('repricingLagScore: 業績改善あり・株価が60日レンジ下位30%以内・直近1ヶ月の上昇も小さければzone:pre_move（🟢初動前）', () => {
  const r = repricingLagScore({
    return1m: 3, return3m: -5, priceLevelPct: 15,
    revenueGrowthPct: 30, profitGrowthPct: 30, per: 8, sectorPer: 20,
    hasCatalyst: true, daysToEarnings: 10,
  });
  assert.equal(r.zone, 'pre_move');
  assert.equal(r.checked, true);
  assert.ok(r.score > 50, `score should be reasonably high, got ${r.score}`);
});

// A指示 項目6「『仕込みゾーン』を5段階に変更する」: 従来はzone:'re_rating'
// 一段しか無かったが、「高値圏（priceLevelPct>=70）＋短期上昇大
// （return1m>=15%）」の組み合わせは指示書が新設した「🟠過熱警戒」に
// 分類する（re_ratingより一段重い「新規買い慎重」の注意）。
test('repricingLagScore: 業績改善あり・株価が既に上昇し始めている(1ヶ月+10%以上・オーバーライド未満)で高値圏でなければzone:re_rating', () => {
  const r = repricingLagScore({
    return1m: 12, return3m: 15, priceLevelPct: 50,
    revenueGrowthPct: 30, profitGrowthPct: 30,
  });
  assert.equal(r.zone, 're_rating');
});

test('repricingLagScore: 高値圏（priceLevelPct>=70）＋短期上昇大（return1m>=15%）ならzone:overheated（🟠過熱警戒、A指示項目6で新設）', () => {
  const r = repricingLagScore({
    return1m: 15, return3m: 18, priceLevelPct: 70,
    revenueGrowthPct: 30, profitGrowthPct: 30,
  });
  assert.equal(r.zone, 'overheated');
});

test('repricingLagScore: 高値圏でも短期上昇が小さければovertheatedにはせずre_ratingのまま（業績改善が無く株価だけ高い位置にあるケースと区別する）', () => {
  const r = repricingLagScore({
    return1m: 12, return3m: 15, priceLevelPct: 90,
    revenueGrowthPct: 30, profitGrowthPct: 30,
  });
  assert.equal(r.zone, 're_rating');
});

// A指示 項目26「52週位置と騰落率の矛盾を説明する」実例そのもの
// （1M+4%なのに52週位置95%→「まだ反応が乏しい」という文章は禁止）の
// 再発防止。実測バグ: 業績改善データがあり(improvement>0)、直近1ヶ月の
// 上昇がearlyMoveReturn1mMax(10%)未満の場合、priceLevelPctがどれだけ
// 高くてもzone判定がpriceLevelPctを一切見ずにearly_move（🟢初動・
// 「まだ仕込める」）に分類されていた。
test('repricingLagScore: 業績改善データがあっても、直近1ヶ月の上昇が小さいまま52週位置が高値圏（overheatPriceLevelMin以上）ならearly_moveにしない（A指示ケース26）', () => {
  const r = repricingLagScore({ return1m: 4, return3m: 8, priceLevelPct: 95, revenueGrowthPct: 30 });
  assert.notEqual(r.zone, 'early_move');
  assert.equal(r.zone, 're_rating');
});

test('repricingLagScore: 52週位置が低ければ、直近1ヶ月の上昇が小さくても業績改善データがあればearly_moveのまま（誤って厳しくしすぎない）', () => {
  const r = repricingLagScore({ return1m: 4, return3m: 8, priceLevelPct: 40, revenueGrowthPct: 30 });
  assert.equal(r.zone, 'early_move');
});

test('repricingLagScore: 業績改善あり・株価反応もまだ小さくない中間状態ならzone:early_move（🟡初動）', () => {
  const r = repricingLagScore({
    return1m: 5, return3m: 8, priceLevelPct: 50,
    revenueGrowthPct: 20, profitGrowthPct: 20,
  });
  assert.equal(r.zone, 'early_move');
});

test('repricingLagScore: 業績改善が無い（revenueGrowthPct/profitGrowthPctとも低い）のに株価だけ高い位置にあればzone:re_rating（積極評価しない）', () => {
  const r = repricingLagScore({
    return1m: 2, return3m: 3, priceLevelPct: 80,
    revenueGrowthPct: -5, profitGrowthPct: null,
  });
  assert.equal(r.zone, 're_rating');
});

test('repricingLagScore: 判定に最低限必要なデータ（株価位置・業績成長率）が無ければzone:nullかつchecked:false', () => {
  const r = repricingLagScore({});
  assert.equal(r.zone, null);
  assert.equal(r.checked, false);
});

test('repricingLagScore: priceLevelPct/成長率が無くても、直近1ヶ月/3ヶ月の騰落率だけでオーバーライドが発火すればchecked:true（実測バグ: 584A・581Aでzone:priced_inなのにchecked:falseとなり警告バッジが握りつぶされていた再発防止）', () => {
  const viaReturn1m = repricingLagScore({ return1m: 25 });
  assert.equal(viaReturn1m.zone, 'priced_in');
  assert.equal(viaReturn1m.checked, true, 'return1mだけでオーバーライドが発火した場合もcheckedはtrueであるべき');

  const viaReturn3m = repricingLagScore({ return3m: 45 });
  assert.equal(viaReturn3m.zone, 'priced_in');
  assert.equal(viaReturn3m.checked, true, 'return3mだけでオーバーライドが発火した場合もcheckedはtrueであるべき');
});

test('repricingLagScore: 業種平均PERが無くてもPSRで株価割安度を代替評価する（米国株向け）', () => {
  const withSectorPer = repricingLagScore({
    priceLevelPct: 50, revenueGrowthPct: 10, per: 10, sectorPer: 20, // ratio=0.5 <= 0.7 → 15点
  });
  const withPsrOnly = repricingLagScore({
    priceLevelPct: 50, revenueGrowthPct: 10, psr: 0.8, // <=1 → 15点
  });
  assert.equal(withSectorPer.breakdown.valuation, 15);
  assert.equal(withPsrOnly.breakdown.valuation, 15);
});

test('repricingLagScore: 先行材料(hasCatalyst)と決算までの日数(daysToEarnings)がスコアに反映される', () => {
  const withCatalystSoon = repricingLagScore({ priceLevelPct: 50, revenueGrowthPct: 10, hasCatalyst: true, daysToEarnings: 7 });
  const withoutEither = repricingLagScore({ priceLevelPct: 50, revenueGrowthPct: 10, hasCatalyst: false, daysToEarnings: null });
  assert.equal(withCatalystSoon.breakdown.catalyst, 10);
  assert.equal(withCatalystSoon.breakdown.event, 10);
  assert.equal(withoutEither.breakdown.catalyst, 0);
  assert.equal(withoutEither.breakdown.event, 0);
  assert.ok(withCatalystSoon.score > withoutEither.score);
});

// v7.4改修（ユーザーの実銘柄分析、フィットイージー/212Aのケース）:
// pre_moveの判定条件がreturn3mを一切見ておらず、「売上+45.8%・利益+49.6%
// だが3ヶ月+26.5%まで既に株価が動いている」ような銘柄もpre_move
// （未織り込み）に分類されうるバグがあった。
test('repricingLagScore: 1ヶ月の上昇は小さくても3ヶ月で+20%以上動いていればpre_moveにはしない（実測バグ: フィットイージー/212Aの再発防止）', () => {
  const r = repricingLagScore({
    return1m: 3, return3m: 26.5, priceLevelPct: 15,
    revenueGrowthPct: 45.8, profitGrowthPct: 49.6,
  });
  assert.notEqual(r.zone, 'pre_move');
});

test('repricingLagScore: alreadyMovedStrict（1ヶ月+10%以上または3ヶ月+20%以上）ならscoreを大きく減点する（実測バグ: ASTHが1ヶ月+7.6%で妙味77.1のまま高評価だった問題の一般化）', () => {
  const base = { priceLevelPct: 15, revenueGrowthPct: 30, profitGrowthPct: 30, per: 8, sectorPer: 20, hasCatalyst: true, daysToEarnings: 10 };
  const notMoved = repricingLagScore({ ...base, return1m: 3, return3m: 5 });
  const movedVia1m = repricingLagScore({ ...base, return1m: 10, return3m: 5 });
  const movedVia3m = repricingLagScore({ ...base, return1m: 3, return3m: 20 });
  assert.equal(notMoved.alreadyMovedStrict, false);
  assert.equal(movedVia1m.alreadyMovedStrict, true);
  assert.equal(movedVia3m.alreadyMovedStrict, true);
  assert.ok(movedVia1m.score < notMoved.score * 0.6, `1ヶ月+10%で減点されていません（notMoved=${notMoved.score}, movedVia1m=${movedVia1m.score}）`);
  assert.ok(movedVia3m.score < notMoved.score * 0.6, `3ヶ月+20%で減点されていません（notMoved=${notMoved.score}, movedVia3m=${movedVia3m.score}）`);
});

// A指示 項目5-1「1M/3M騰落率のオーバーライドルールの例外」: 業績改善率が
// 株価上昇率を大きく上回る場合は未織り込み判定を完全には消さない
// （指示書の実例: 売上+100%・利益+150%・株価3M+25%）。
test('repricingLagScore: 業績改善率が株価上昇率を大きく上回る極端なケースでは、オーバーライドが発火する条件でもzone:priced_inにしない（例外条項）', () => {
  const withoutException = repricingLagScore({ return3m: 45, priceLevelPct: 80 }); // 業績データ無し
  assert.equal(withoutException.zone, 'priced_in');

  const withException = repricingLagScore({
    return3m: 45, priceLevelPct: 80, revenueGrowthPct: 100, profitGrowthPct: 150, // performanceRate=125, gap=125-45=80>=60
  });
  assert.notEqual(withException.zone, 'priced_in');
});

test('repricingLagScore: 業績改善率と株価上昇率の差が例外の閾値未満なら、従来通りzone:priced_inのまま', () => {
  const r = repricingLagScore({
    return3m: 45, priceLevelPct: 80, revenueGrowthPct: 30, profitGrowthPct: 30, // performanceRate=30, gap=30-45=-15<60
  });
  assert.equal(r.zone, 'priced_in');
});

test('repricingLagScore: 例外が発動する場合、alreadyMovedStrictの減点も0.5倍ではなく0.8倍に緩和する（未織り込み判定を完全には消さない）', () => {
  const base = { priceLevelPct: 15, per: 8, sectorPer: 20, hasCatalyst: true, daysToEarnings: 10 };
  const withoutException = repricingLagScore({ ...base, return1m: 3, return3m: 20, revenueGrowthPct: 30, profitGrowthPct: 30 });
  const withException = repricingLagScore({ ...base, return1m: 3, return3m: 20, revenueGrowthPct: 100, profitGrowthPct: 150 });
  const notMoved = repricingLagScore({ ...base, return1m: 3, return3m: 5, revenueGrowthPct: 100, profitGrowthPct: 150 });
  assert.ok(withException.score > withoutException.score, '例外が発動する場合は減点が緩和され、通常のalreadyMovedStrictより高いスコアになるべき');
  assert.ok(withException.score < notMoved.score, '例外が発動しても完全に無視はしない（notMovedより低いスコアのまま）');
});

// v7.4改修（ユーザーの実銘柄分析、7607進和のケース）: 対通期進捗率が
// 2年連続で加速している（progressStreakSignalがgood）銘柄は、
// revenueGrowthPct/profitGrowthPctだけでは拾いきれない「業績の上振れ
// 基調」を持つ。improvementに反映する。
test('repricingLagScore: progressStreakがgoodならimprovementにボーナスが乗る（実測: 7607進和が妙味56/100止まりだった問題の再発防止）', () => {
  const withoutStreak = repricingLagScore({ priceLevelPct: 20, revenueGrowthPct: 10.7, profitGrowthPct: 5.5 });
  const withStreak = repricingLagScore({ priceLevelPct: 20, revenueGrowthPct: 10.7, profitGrowthPct: 5.5, progressStreak: { level: 'good' } });
  assert.ok(withStreak.breakdown.improvement > withoutStreak.breakdown.improvement);
});

test('repricingLagScore: progressStreakのボーナスを足してもimprovementの上限25点は超えない', () => {
  const r = repricingLagScore({ priceLevelPct: 20, revenueGrowthPct: 100, profitGrowthPct: 100, progressStreak: { level: 'good' } });
  assert.ok(r.breakdown.improvement <= 25);
});

test('repricingLagScore: スコアは0〜100の範囲に収まる', () => {
  const maxCase = repricingLagScore({
    return1m: 0, return3m: 0, priceLevelPct: 0,
    revenueGrowthPct: 100, profitGrowthPct: 100, per: 1, sectorPer: 100,
    hasCatalyst: true, daysToEarnings: 1,
  });
  assert.ok(maxCase.score <= 100);
  const minCase = repricingLagScore({ priceLevelPct: 100, revenueGrowthPct: -50, profitGrowthPct: -50 });
  assert.ok(minCase.score >= 0);
});

// v7.3改修 項目1/2/7/19: BUY/EXPECTATION/SURPRISEスコアの3分割とDATA/
// CONFIDENCE分離。
test('buyScore: 5要素すべて揃っていればconfidence100（=配点満点分のデータが揃っている）', () => {
  const r = buyScore({
    expectedReturn: { value: 80 }, unpriced: { value: 60 }, surprise: { value: 90 },
    timing: { value: 100 }, quality: { value: 50 },
  });
  assert.equal(r.confidence, 100);
  assert.ok(Number.isFinite(r.score));
});

test('buyScore: 一部の要素が欠けていてもscoreは計算でき、confidenceだけ下がる（データ不足を隠さない）', () => {
  const full = buyScore({ expectedReturn: { value: 80 }, unpriced: { value: 80 }, surprise: { value: 80 }, timing: { value: 80 }, quality: { value: 80 } });
  const partial = buyScore({ expectedReturn: { value: 80 }, unpriced: { value: 80 } });
  assert.equal(full.score, 80);
  assert.equal(partial.score, 80); // 揃っている要素だけで見れば同じ水準
  assert.ok(partial.confidence < full.confidence);
});

// 第2優先改修 CASE7「全データ欠損→高スコアにならない・高CONFIDENCEに
// ならない」: buyScore({})は既にscore:null・confidence:0を返す（下の
// テストで確認済み）。coverageScoreも0であることを確認する。
test('buyScore: 全データ欠損ならcoverageScoreも0（CASE7: 全データ欠損→高スコアにならない）', () => {
  const r = buyScore({});
  assert.equal(r.coverageScore, 0);
});

// 第2優先改修 CASE4「10個のスコア項目のうち2個しか取得できない→2項目
// だけで100点換算されない」対応。既存のscore（揃った軸だけで100点満点に
// 再配点する値。AMBUSH/SMART ENTRYの判定条件がこの値の閾値比較を使って
// いるため、値も意味も変更していない）とは別に、「未取得の軸は0点として
// 数えた場合の点数」をcoverageScoreとして追加した（weightedComposite内部
// のgotをそのまま公開するだけの追加フィールドで、既存の分岐・判定条件は
// 一切変えていない）。
test('entryPriorityScore: coverageScoreは未取得の軸を0点として数える（scoreのように100点換算しない。CASE4対応）', () => {
  const parts = { untapped: { value: 100 } }; // 7軸中untapped(25点)だけ
  const r = entryPriorityScore(parts);
  assert.equal(r.score, 100, 'score自体は既存通り、揃った軸だけで100点満点に再配点する（AMBUSH/SMART ENTRYの判定条件を変えないため不変更）');
  assert.equal(r.coverageScore, 25, 'coverageScoreは7軸中untappedの配点(25)だけを反映し、100点換算にはならない');
});

test('buyScore: coverageScoreは5軸中1軸(quality=10点)しか無ければ10点にとどまる（2項目だけで100点換算されない）', () => {
  const r = buyScore({ quality: { value: 100 } });
  assert.equal(r.score, 100);
  assert.equal(r.coverageScore, 10);
});

// 第2優先改修 CASE5「重要なデータが欠損している→HIGH CONFIDENCEに
// ならない」。BUY_SCORE_WEIGHTSの最大配点軸(expectedReturn=30)が欠損して
// いれば、残り4軸を満点で揃えても70点(<80)までしか届かずMEDIUM止まりに
// なることを確認する（既存のconfidenceTier閾値・重み配分は変更していない
// ＝この挙動は既存実装が元々持っていた性質を確認するテスト）。
test('confidenceTier: CASE5 — 最大配点の軸(expectedReturn)が欠損していればBUY SCOREのCONFIDENCEはHIGHにならない', () => {
  const r = buyScore({
    unpriced: { value: 80 }, surprise: { value: 80 }, timing: { value: 80 }, quality: { value: 80 },
  }); // expectedReturn(30点、5軸中最大の配点)だけ欠損
  assert.equal(r.confidence, 70);
  assert.equal(confidenceTier(r.confidence), 'MEDIUM');
});

// 第2優先改修 CASE6/CASE7「RISK LOWを自動付与しない」。CHIP_SIGNAL_FIELDS
// （21種類のリスク系シグナル）が1件もchecked:trueになっていない銘柄は、
// bad級のシグナルが0件でも'LOW'ではなく'UNKNOWN'を返す（「確認して問題
// なかった」と「そもそも確認できていない」を区別する。実測バグ:
// 旧実装はbadChipSignals().length===0だけを見て無条件にLOWにしていた）。
test('riskLevel: CASE7 — 判定材料(CHIP_SIGNAL_FIELDS)が1件もchecked:trueでなければUNKNOWN（LOWと自動判定しない）', () => {
  assert.equal(riskLevel({}), 'UNKNOWN');
});

test('riskLevel: 1件でもchecked:trueで確認できていて、bad級が無ければ従来通りLOW（実データの挙動は変えない）', () => {
  assert.equal(riskLevel({ netNet: { level: null, checked: true } }), 'LOW');
});

test('riskLevel: bad級が1件ならMED・2件以上ならHIGH（従来通り。ただしchecked:trueが前提）', () => {
  assert.equal(riskLevel({ netNet: { level: 'bad', checked: true } }), 'MED');
  assert.equal(riskLevel({ netNet: { level: 'bad', checked: true }, receivablesAnomaly: { level: 'bad', checked: true } }), 'HIGH');
});

test('riskCoverage: 何件中何件を実際に評価できたかを返す（RISK LOWの根拠の薄さを隠さないため。CASE6対応）', () => {
  const cov = riskCoverage({ netNet: { level: null, checked: true }, marginOverhang: { level: null, checked: true } });
  assert.equal(cov.checked, 2);
  assert.equal(cov.total, CHIP_SIGNAL_FIELDS.length);
  assert.equal(riskCoverage({}).checked, 0);
});

test('buyScore: 何も無ければscore:null・confidence:0', () => {
  const r = buyScore({});
  assert.equal(r.score, null);
  assert.equal(r.confidence, 0);
});

// 改修指示書 項目2「財務リスク・希薄化リスク・信用過熱・会計リスク・
// 業績悪化などをリスクペナルティとして反映する」: これまでBUY SCOREは
// リスク要素を一切減点しておらず、verdictが「見送り」に落ちていても
// BUY SCOREの数値自体は高いままという矛盾があった（実測バグ）。
test('buyScore: riskPenaltyを渡すとscoreから減点され、素点はrawScoreBeforeRiskに残る', () => {
  const parts = { expectedReturn: { value: 80 }, unpriced: { value: 80 }, surprise: { value: 80 }, timing: { value: 80 }, quality: { value: 80 } };
  const noRisk = buyScore(parts);
  const withRisk = buyScore(parts, 30);
  assert.equal(noRisk.score, 80);
  assert.equal(withRisk.score, 50);
  assert.equal(withRisk.rawScoreBeforeRisk, 80);
  assert.equal(withRisk.riskPenalty, 30);
});

test('buyScore: riskPenaltyでscoreが0未満にはならない（下限クランプ）', () => {
  const r = buyScore({ expectedReturn: { value: 20 } }, 999);
  assert.equal(r.score, 0);
});

test('buyScore: scoreがnull（データ無し）の場合はriskPenaltyを渡してもnullのまま', () => {
  const r = buyScore({}, 30);
  assert.equal(r.score, null);
});

test('buyScoreRiskPenalty: bad級のリスクシグナル1件につき10点減点する', () => {
  assert.equal(buyScoreRiskPenalty({}), 0);
  assert.equal(buyScoreRiskPenalty({ netNet: { level: 'bad' } }), 10);
  assert.equal(buyScoreRiskPenalty({ netNet: { level: 'bad' }, receivablesAnomaly: { level: 'bad' } }), 20);
  // warn/goodは対象外（badChipSignalsと同じ基準）
  assert.equal(buyScoreRiskPenalty({ netNet: { level: 'warn' } }), 0);
});

test('expectationScore/earningsSurpriseScore: buyScoreと同じ重み付け合成ロジックを使い、それぞれ独立して計算できる', () => {
  const exp = expectationScore({ revenueGrowth: { value: 90 }, profitGrowth: { value: 70 } });
  const surp = earningsSurpriseScore({ consensusGap: { value: 90 } });
  assert.ok(Number.isFinite(exp.score));
  assert.ok(Number.isFinite(surp.score));
});

// A指示 項目1-2「仕込み優先度」100点満点スコアの新設。配点（未織り込み度
// 25・成長加速20・業績の質15・バリュエーション15・カタリスト10・需給10・
// テーマ性5）通りに重み付け合成されることを確認する。
test('entryPriorityScore: 配点通りに重み付け合成する（全軸満点なら100点）', () => {
  const parts = {
    untapped: { value: 100 }, growthAccel: { value: 100 }, quality: { value: 100 },
    valuation: { value: 100 }, catalyst: { value: 100 }, supplyDemand: { value: 100 }, theme: { value: 100 },
  };
  const r = entryPriorityScore(parts);
  assert.equal(r.score, 100);
});

test('entryPriorityScore: 未織り込み度だけ満点・他は0点なら25点（配点通り）', () => {
  const parts = { untapped: { value: 100 } };
  const r = entryPriorityScore(parts);
  assert.equal(r.score, 100); // 未織り込み度のみが軸として存在する場合、その軸だけで100%に再配点される
});

test('entryPriorityScore: データが揃っている軸だけで再配点する（buyScoreと同じweightedCompositeの仕組み）', () => {
  // 未織り込み度(25)・成長加速(20)の2軸だけデータがある場合、
  // 45点満点中の重み付け平均になる（buyScore/expectationScoreと同じ仕組み）。
  const parts = { untapped: { value: 100 }, growthAccel: { value: 0 } };
  const r = entryPriorityScore(parts);
  assert.equal(r.score, Math.round((100 * 25) / 45));
});

test('entryPriorityScore: リスク減点（buyScoreRiskPenaltyと同じ考え方）を適用できる', () => {
  const parts = { untapped: { value: 100 }, growthAccel: { value: 100 }, quality: { value: 100 }, valuation: { value: 100 }, catalyst: { value: 100 }, supplyDemand: { value: 100 }, theme: { value: 100 } };
  const withPenalty = entryPriorityScore(parts, 20);
  assert.equal(withPenalty.score, 80);
  assert.equal(withPenalty.rawScoreBeforeRisk, 100);
});

test('entryPriorityScore: 軸が1つも無ければscore:null', () => {
  assert.equal(entryPriorityScore({}).score, null);
});

test('buildScoreParts: entryPriorityのpartsを組み立てる（未織り込み度=repricingLag.score・成長加速=growthAcceleration.scoreをそのまま再利用）', () => {
  const r = {
    repricingLag: { checked: true, score: 70, zone: 'pre_move' },
    growthAcceleration: { level: 'good', score: 60, note: 'テスト' },
    progressStreak: { checked: true, level: 'good' },
    per: 10, sectorPer: 20, pbr: 1, sectorPbr: 2,
    catalystScore100: 80, catalystTier: 'A',
    squeeze: { checked: true, level: 'good' },
    themeMatch: { checked: true, level: 'good', note: 'テーマ' },
  };
  const parts = buildScoreParts(r);
  assert.equal(parts.entryPriority.untapped.value, 70);
  assert.equal(parts.entryPriority.growthAccel.value, 60);
  assert.ok(Number.isFinite(parts.entryPriority.quality.value));
  assert.ok(Number.isFinite(parts.entryPriority.valuation.value));
  assert.equal(parts.entryPriority.catalyst.value, 80);
  assert.ok(Number.isFinite(parts.entryPriority.supplyDemand.value));
  assert.equal(parts.entryPriority.theme.value, 100);
});

test('buildScoreParts: entryPriorityのcatalystはcatalystScore100が無ければhasCatalystの二値にフォールバックする（SMART ENTRY等）', () => {
  const parts = buildScoreParts({ hasCatalyst: true });
  assert.equal(parts.entryPriority.catalyst.value, 100);
});

// A指示27「先行材料なしを悪材料としない」再発防止: 先行材料が無い銘柄を
// value:0にすると、weightedComposite内でcatalyst weight分だけ分母は
// 残ったまま分子が0になり、「先行材料が無い」だけの銘柄が一律減点される
// （＝「無い」が「悪い」と同じ扱いになる）。null（軸ごと除外）である
// ことを確認する。
test('buildScoreParts: hasCatalyst:falseは0点ではなくnull（軸ごと除外）にする（A指示27: 先行材料なしを悪材料としない）', () => {
  const parts = buildScoreParts({ hasCatalyst: false });
  assert.equal(parts.entryPriority.catalyst, null);
});

test('buildScoreParts: catalystScore100:0（開示はあるが先行材料に該当なし）もnull扱いにする（A指示27）', () => {
  const parts = buildScoreParts({ catalystScore100: 0, catalystTier: null });
  assert.equal(parts.entryPriority.catalyst, null);
});

// A指示27と全く同じ「絶対悪ではない非該当をvalue:0にして一律減点する」
// バグがtheme軸にも残っていた（横展開・再発防止）。themeMatchSignalは
// 手動選定の決め打ちテーマ一覧との照合でしかなく'bad'という概念が無い
// ため、非該当は「このリストでは拾えなかっただけ」であり悪材料ではない。
test('buildScoreParts: themeMatchが非該当(level:null)でも0点ではなくnull（軸ごと除外）にする（A指示27の横展開: テーマ性なしを悪材料としない）', () => {
  const parts = buildScoreParts({ themeMatch: { checked: true, level: null, label: null, note: null } });
  assert.equal(parts.entryPriority.theme, null);
});

test('entryPriorityScore: 先行材料以外の全軸が同じ2銘柄で、先行材料の有無だけが違う場合に、無い方が減点されない（A指示27の実効性確認）', () => {
  const baseParts = {
    untapped: { value: 60 }, growthAccel: { value: 60 }, quality: { value: 60 },
    valuation: { value: 60 }, supplyDemand: { value: 60 }, theme: { value: 60 },
  };
  const withoutCatalyst = entryPriorityScore({ ...baseParts, catalyst: null });
  const withZeroCatalyst = entryPriorityScore({ ...baseParts, catalyst: { value: 0 } });
  // 修正前は catalyst:{value:0} も許容していたが、value:0を明示的に渡すのは
  // 呼び出し側のバグ（buildScorePartsは常にnullを返すべき）なので、ここでは
  // 「軸を渡さない（除外）」ケースがベースラインと同じ60点になることだけを確認する。
  assert.equal(withoutCatalyst.score, 60);
  assert.ok(withZeroCatalyst.score < withoutCatalyst.score);
});

test('confidenceTier: 80以上HIGH・50以上80未満MEDIUM・0より大きく50未満LOW（項目7: DATA%を信頼度として扱う）', () => {
  assert.equal(confidenceTier(100), 'HIGH');
  assert.equal(confidenceTier(80), 'HIGH');
  assert.equal(confidenceTier(79), 'MEDIUM');
  assert.equal(confidenceTier(50), 'MEDIUM');
  assert.equal(confidenceTier(49), 'LOW');
  assert.equal(confidenceTier(1), 'LOW');
  assert.equal(confidenceTier(null), null);
});

test('confidenceTier: confidenceRaw===0はLOWではなくUNKNOWN（A指示項目24: BUY SCOREの5要素が1つもデータが揃わなかった＝そもそも根拠が無い状態はLOWと区別する）', () => {
  assert.equal(confidenceTier(0), 'UNKNOWN');
});

test('effectiveScore: CONFIDENCEが低いほどRaw Scoreを割り引く（項目7: データが不足している銘柄が不当に有利にならないようにする）', () => {
  const high = effectiveScore(88, 95); // HIGH: ×1.0
  const low = effectiveScore(88, 30); // LOW: ×0.65
  assert.equal(high, 88);
  assert.equal(low, Math.round(88 * 0.65));
  assert.ok(low < high, 'SCOREが同じでもCONFIDENCEが低い方がEffective Scoreは低くなるべき');
});

test('effectiveScore: rawScoreが無ければnull', () => {
  assert.equal(effectiveScore(null, 90), null);
});

test('buildScoreParts: JP AMBUSHの結果オブジェクト（既存フィールドのみ）からbuyScore用partsを組み立てられる', () => {
  const r = {
    score: 75, repricingLag: { checked: true, score: 40, zone: 'pre_move' },
    consensusTrap: { checked: true, level: 'good', note: '期待薄' },
    daysLeft: 20, netNet: { checked: true, level: 'good' }, lowPbr: { checked: true, level: null },
  };
  const parts = buildScoreParts(r);
  assert.equal(parts.buy.expectedReturn.value, 75);
  assert.equal(parts.buy.unpriced.value, 40);
  assert.equal(parts.buy.surprise.value, 90);
  assert.equal(parts.buy.timing.value, 100); // daysLeft=20はsweetMin〜nowMaxの核心ゾーン
  assert.equal(parts.buy.quality.value, 50); // netNet good・lowPbrはchecked済みだがgoodでない→1/2
});

test('buildScoreParts: US AMBUSHのように一部フィールドが無い場合はnullになる（推測で埋めない）', () => {
  const r = { score: 60, daysLeft: 20 }; // consensusTrap/progressStreak/hasMonthly等が無い
  const parts = buildScoreParts(r);
  assert.equal(parts.buy.surprise, null);
  assert.equal(parts.surprise.progressMomentum, null);
  assert.equal(parts.surprise.monthlyDisclosure, null);
});

test('buildScoreParts: 決算まで7日未満（TIMING_WINDOWの外側）はtiming:null', () => {
  const parts = buildScoreParts({ daysLeft: 3 });
  assert.equal(parts.buy.timing, null);
});

// v7.5改修（ユーザー提案「成長率だけでなく成長の加速を見る」。ただし
// 「異常値なら無条件で1位」は採用しない＝ボーナスは加えるが既存の
// 0〜100クランプは変えない）。
test('buildScoreParts: growthAcceleration.level==="good"なら成長率評価にボーナスが乗る（A指示項目7でscoreが加速度合いに比例するようになったため、ボーナス幅もscoreに応じて変わる）', () => {
  const withoutAccel = buildScoreParts({ revenueGrowthPct: 20 });
  const withAccel = buildScoreParts({ revenueGrowthPct: 20, growthAcceleration: { level: 'good', score: 100 } });
  assert.ok(withAccel.expectation.revenueGrowth.value > withoutAccel.expectation.revenueGrowth.value);
});

test('buildScoreParts: growthAccelerationのボーナスを足しても成長率評価は100を超えない（異常値の無条件1位化を避ける）', () => {
  const parts = buildScoreParts({ revenueGrowthPct: 90, growthAcceleration: { level: 'good', score: 100 } });
  assert.ok(parts.expectation.revenueGrowth.value <= 100);
});

// v7.3改修 項目10: EV/EBITDA。単純なPER/PBRだけで割安・割高を判断しない。
test('evEbitda: 時価総額・有利子負債・現金・営業利益・減価償却費からEV/EBITDAを計算する（単位: marketCap/operatingProfitは百万円、他はEDINETの生の円）', () => {
  // 時価総額100億円(=1e10円)、有利子負債6億円、現金3億円、営業利益5億円、
  // 減価償却費1億円 → EV=1e10+6e8-3e8=1.03e10、EBITDA=5e8+1e8=6e8
  const r = evEbitda({ marketCap: 10_000, interestBearingDebt: 6e8, cash: 3e8, operatingProfit: 500, dAndA: 1e8 });
  assert.equal(r.ev, 1.03e10);
  assert.equal(r.ebitda, 6e8);
  assert.equal(r.ratio, 17.2); // 1.03e10/6e8を小数第1位に丸め
});

test('evEbitda: 減価償却費が無ければEBITDA≒営業利益として計算する（過小評価側に倒す安全側の近似）', () => {
  const r = evEbitda({ marketCap: 10_000, operatingProfit: 500 });
  assert.equal(r.ebitda, 500 * 1_000_000);
  assert.ok(Number.isFinite(r.ratio));
});

test('evEbitda: 赤字(EBITDA<=0)ならratioは出さない（無意味な指標になるため）', () => {
  const r = evEbitda({ marketCap: 10_000, operatingProfit: -100 });
  assert.equal(r.ratio, null);
  assert.equal(r.checked, true);
});

test('evEbitda: 時価総額・営業利益のどちらかが無ければchecked:false', () => {
  assert.equal(evEbitda({ operatingProfit: 500 }).checked, false);
  assert.equal(evEbitda({ marketCap: 10_000 }).checked, false);
});

// v7.4改修（ユーザーの実銘柄分析）: SMART ENTRYの同点乱発対策
// （松屋PER224・PBR4.3を含む7銘柄がconviction=145で並んでいた問題）。
test('valuationQualityScore: PER/PBRとも業種平均の0.7倍以下なら満点(30点)', () => {
  const r = valuationQualityScore({ per: 7, sectorPer: 14, pbr: 0.7, sectorPbr: 1.42 });
  assert.equal(r.score, 30);
  assert.equal(r.checked, true);
});

test('valuationQualityScore: 業種平均を大きく上回る（松屋: PER224・PBR4.3相当）なら0点', () => {
  const r = valuationQualityScore({ per: 224, sectorPer: 32.2, pbr: 4.3, sectorPbr: 2.35 });
  assert.equal(r.score, 0);
});

test('valuationQualityScore: PER/PBRどちらか一方のデータしか無くても、あるほうだけで計算する', () => {
  const perOnly = valuationQualityScore({ per: 7, sectorPer: 14 });
  assert.equal(perOnly.score, 15);
  assert.equal(perOnly.checked, true);
});

test('valuationQualityScore: データが無ければscore:0・checked:false', () => {
  const r = valuationQualityScore({});
  assert.equal(r.score, 0);
  assert.equal(r.checked, false);
});

// ==================================================================
// evaluationAxes（第3優先改修）: VALUATION/FUNDAMENTALS/CATALYST/
// PRICE_SUPPLY/TIMINGの分離。ユーザー指定のCASE A〜Dをそのまま検証する。
// 既存スコアの配点は変更していないため、ここでは「軸が正しく独立して
// いるか」（割安=近い将来の材料ではない、材料があっても割安とは限らない、
// 株価が動いていても割安評価は自己修正しない）だけを確認する。
// ==================================================================

test('evaluationAxes: CASE A — 低PER/低PBR・カタリストなし・業績/株価横ばい → VALUATIONは高くなり得るがCATALYSTは高くしない', () => {
  const r = {
    per: 8, sectorPer: 15, pbr: 0.7, sectorPbr: 1.3, // 業種平均より明確に割安
    revenueGrowthPct: 0, profitGrowthPct: 0, // 業績横ばい
    kairi: 0, rsi: 50, // 株価横ばい
    // カタリストデータ無し（hasCatalyst/catalystScore100とも未設定）
  };
  const axes = evaluationAxes(r);
  assert.ok(axes.valuation.score >= 80, `割安なのでVALUATIONは高いはず（実際: ${axes.valuation.score}）`);
  assert.equal(axes.catalyst.score, null, 'カタリストのデータが無いのに高いCATALYSTスコアを作ってはいけない');
});

test('evaluationAxes: CASE B — 業績上方修正・受注増加・しかしPERが極端に高い → CATALYST/FUNDAMENTALSは評価できるがVALUATIONは高くしない', () => {
  const r = {
    per: 80, sectorPer: 15, // 業種平均を大幅に上回る＝割高
    revenueGrowthPct: 40, profitGrowthPct: 50, // 業績上方修正・受注増加に相当
    catalystScore100: 90, hasCatalyst: true, catalystTier: 'S',
  };
  const axes = evaluationAxes(r);
  assert.equal(axes.catalyst.score, 90, 'カタリストは正しく評価できるはず');
  assert.equal(axes.fundamentals.components.revenueGrowthPct, 40, '業績データも正しく参照できるはず');
  assert.equal(axes.fundamentals.components.profitGrowthPct, 50);
  assert.ok(axes.valuation.score <= 10, `PERが業種平均の5倍以上なのにVALUATIONを高くしてはいけない（実際: ${axes.valuation.score}）`);
});

test('evaluationAxes: CASE C — 割安・業績改善・カタリストありでも、株価が既に大幅上昇していればPRICE_SUPPLYで別途過熱が見える（VALUATIONが自動で「未織込み」を主張しない）', () => {
  const r = {
    per: 8, sectorPer: 15, pbr: 0.7, sectorPbr: 1.3, // 割安
    revenueGrowthPct: 30, profitGrowthPct: 40, // 業績改善
    catalystScore100: 85, hasCatalyst: true, // カタリストあり
    kairi: 25, rsi: 85, // 株価は既に大幅上昇（過熱）
    repricingLag: { priceLevelPct: 95, return1m: 40, return3m: 60 },
  };
  const axes = evaluationAxes(r);
  assert.ok(axes.valuation.score >= 80, 'VALUATIONは割安さそのものを表すため、株価の動きだけでは変化しない（自己修正しない）');
  assert.equal(axes.priceSupply.components.kairi, 25);
  assert.equal(axes.priceSupply.components.rsi, 85);
  assert.equal(axes.priceSupply.components.priceLevelPct, 95, '「割安だから未織込み」と自動判断せず、株価位置は別軸(PRICE_SUPPLY)にそのまま出す');
});

test('evaluationAxes: CASE D — 割安・業績改善・カタリストあり・株価低迷 → 5軸が互いに干渉せず独立して存在する', () => {
  const r = {
    per: 8, sectorPer: 15, pbr: 0.7, sectorPbr: 1.3,
    revenueGrowthPct: 30, profitGrowthPct: 40,
    catalystScore100: 85, hasCatalyst: true,
    kairi: -15, rsi: 25,
    repricingLag: { priceLevelPct: 10, return1m: -10, return3m: -5 },
    daysLeft: 20,
  };
  const axes = evaluationAxes(r);
  assert.ok(axes.valuation.score >= 80);
  assert.equal(axes.fundamentals.components.revenueGrowthPct, 30);
  assert.equal(axes.catalyst.score, 85);
  assert.equal(axes.priceSupply.components.kairi, -15);
  assert.equal(axes.priceSupply.components.priceLevelPct, 10);
  assert.equal(axes.timing.components.daysLeft, 20);
});

test('evaluationAxes: 何も無ければ全軸score:null（推測で埋めない）', () => {
  const axes = evaluationAxes({});
  assert.equal(axes.valuation.score, null);
  assert.equal(axes.fundamentals.score, null);
  assert.equal(axes.catalyst.score, null);
  assert.equal(axes.priceSupply.score, null);
  assert.equal(axes.timing.score, null);
});

// 実データで見つかった重複の再発防止用スナップショット: repricingLag.score
// が2つの見出しスコア（BUY SCOREのunpriced・entryPriorityScoreのuntapped）
// に同時に使われることを明示的に確認する（buildScoreParts参照）。
test('buildScoreParts: repricingLag.scoreは buy.unpriced と entryPriority.untapped の両方に同じ値が使われる（見出しスコア間の重複を可視化）', () => {
  const r = { repricingLag: { checked: true, score: 42, zone: 'pre_move' } };
  const parts = buildScoreParts(r);
  assert.equal(parts.buy.unpriced.value, 42);
  assert.equal(parts.entryPriority.untapped.value, 42);
});

// ==================================================================
// 第4優先改修（ユーザー報告）: バリュエーション表示の意味の正確化。
// 「業種平均PBR/PERまで戻れば株価が上がる」「高配当利回りなら下値が
// 固い」といった、計算根拠以上の予測・保証を自動的に主張していないかを
// ユーザー指定のCASE A〜Fで検証する。
// ==================================================================

test('lowPbrSignal: CASE A — PBR0.5・業界平均PBR1.0は「相対的に低PBR」と判定できるが、ノートは価格予測をしない', () => {
  const r = lowPbrSignal({ pbr: 0.5, sectorPbr: 1.0 });
  assert.equal(r.level, 'good');
  assert.match(r.note, /相対的に割安/);
  assert.doesNotMatch(r.note, /まで(戻|上が|到達)/, '「PBR1倍まで戻る」のような価格予測をしてはいけない');
  assert.doesNotMatch(r.note, /円/, '個別の目標株価(円)を主張してはいけない');
});

test('valuationQualityScore: CASE B — PER8倍・業界平均15倍は相対的に低PERとして評価できるが、score自体は0-30の相対点にとどまり「上昇余地」という言葉は一切含まない', () => {
  const r = valuationQualityScore({ per: 8, sectorPer: 15 });
  assert.ok(r.score > 0, '相対的に低PERなので加点されるべき');
  assert.ok(!('note' in r) || !/上昇余地/.test(JSON.stringify(r)), 'valuationQualityScoreの返り値に「上昇余地」という表現を含めてはいけない（数値のみ返す設計を維持）');
});

test('dividendYieldFloorSignal: CASE C — 配当利回り5%は高利回りと判定できるが「下値が固い」とは自動判定しない', () => {
  const r = dividendYieldFloorSignal(5);
  assert.equal(r.level, 'good');
  assert.doesNotMatch(r.note, /下値.*(固い|支え|下支え)|下支え.*期待/, '「下値が固い」「下支えが期待できる」という自動判定をしてはいけない');
  assert.match(r.note, /下値を保証するものではありません/);
});

test('dividendYieldFloorSignal: warn段階(3%以上4%未満)も同様に下値保証の文言を含まない', () => {
  const r = dividendYieldFloorSignal(3.5);
  assert.equal(r.level, 'warn');
  assert.doesNotMatch(r.note, /下支えが期待できる/);
  assert.match(r.note, /下値を保証するものではありません/);
});

test('netNetSignal: CASE準拠 — 解散価値割れでも「下値は極めて限定的」と言い切らず、業績・CF悪化が続けば目減りしうる旨を明記する', () => {
  const r = netNetSignal({ cash: 2_000_000, totalAssets: 1000, equity: 1000, marketCap: 1, receivables: 0 });
  assert.equal(r.level, 'good');
  assert.doesNotMatch(r.note, /下値は極めて限定的/);
  assert.match(r.note, /目減りする可能性/);
});

test('evaluationAxes: CASE D — 低PBR(割安)と業績悪化(growthAnomalyCaution:bad)が同時に存在できる（一方が他方を打ち消さない）', () => {
  const r = {
    per: 8, sectorPer: 15, pbr: 0.5, sectorPbr: 1.0, // 割安
    growthAnomalyCaution: { level: 'bad', checked: true }, // 業績悪化
  };
  const axes = evaluationAxes(r);
  assert.ok(axes.valuation.score >= 80, '割安であることはVALUATIONにそのまま反映される');
  assert.equal(axes.fundamentals.components.growthAnomalyCaution, 'bad', '業績悪化もFUNDAMENTALSにそのまま反映され、VALUATIONによって隠されたり打ち消されたりしない');
});

test('evaluationAxes: CASE E — 高ROE・高PBRでも、VALUATIONの低さとROEの高さは別々の値として両方見える（高PBRだけで単純な割高断定にしない）', () => {
  const r = {
    per: 40, sectorPer: 15, pbr: 5, sectorPbr: 1.5, // 業種平均より明確に割高（PER/PBRとも）
    roe: 25, // ただし高ROE
  };
  const axes = evaluationAxes(r);
  assert.equal(axes.valuation.score, 0, 'PER/PBRとも業種平均を大きく上回るためVALUATIONは低い（相対バリュエーションとしては正しい）');
  assert.equal(axes.fundamentals.components.roe, 25, '高ROEという文脈はFUNDAMENTALS側に別途保持され、VALUATIONの低さに埋もれて消えない');
});

test('valuationQualityScore/lowPbrSignal/ceilingPrice: CASE F — 業界平均データが欠損していれば0や平均で補完せずUNKNOWN(checked:false/null)として扱う', () => {
  assert.equal(valuationQualityScore({ per: 8 }).checked, false, '業界平均PERが無ければcheckedはfalse（0点をそのまま「割高」と誤読させない）');
  assert.equal(lowPbrSignal({ pbr: 0.5 }).checked, false, '業界平均PBRが無ければUNKNOWN扱い（checked:false）');
  assert.equal(evaluationAxes({ per: 8 }).valuation.score, null, 'evaluationAxesもvaluation.scoreをnullのままにする（0点で埋めない）');
});

// ==================================================================
// 第5優先改修（ユーザー報告）: クラスタ内の相関・二重/三重カウントの
// 洗い出しと抑制。clusterConfirmation()はraw指標・既存SCOREの配点を
// 一切変更せず、「同じ現象を指す指標が複数PASSしても、クラスタとしては
// 1件としてしか数えない」新しい並行の診断指標を追加したもの。
// ユーザー指定のCASE A〜Eをそのまま検証する。
// ==================================================================

test('clusterConfirmation: CASE A — RSI低い・乖離率大幅マイナス・52週位置低い・1M/3Mリターンマイナスは「株価低迷」という1つの現象。rawHitCountは5でもindependentClusterCountはPRICE分の1のみ', () => {
  const r = {
    kairi: -12, rsi: 25,
    repricingLag: { priceLevelPct: 15, return1m: -8, return3m: -5 },
  };
  const cc = clusterConfirmation(r);
  assert.deepEqual(cc.clusters.PRICE.sort(), ['kairi', 'priceLevelPct', 'return1m', 'return3m', 'rsi']);
  assert.equal(cc.rawHitCount, 5, '生の指標ヒット数は5件（raw指標自体は変更していない）');
  assert.equal(cc.independentClusterCount, 1, '「株価低迷」という同じ現象なので、独立した根拠としては1件のみ数える（4倍評価しない）');
});

test('clusterConfirmation: CASE B — PER低い・PBR低い・配当利回り高いは「割安性」という1つの現象。3件PASSしてもVALUATIONは1件', () => {
  const r = { per: 8, sectorPer: 15, lowPbr: { level: 'good' }, dividendYield: 5 };
  const cc = clusterConfirmation(r);
  assert.equal(cc.clusters.VALUATION.length, 3);
  assert.equal(cc.rawHitCount, 3);
  assert.equal(cc.independentClusterCount, 1, '「割安性」が3倍評価されてはいけない');
});

test('clusterConfirmation: CASE C — 信用倍率低い・信用買い残トレンド改善(squeeze)・信用買い占有率低いは「信用需給改善」という1つの現象', () => {
  const r = { loanRatio: 2, squeeze: { level: 'good' }, creditFloat: { level: null, occupancy: 3 } };
  const cc = clusterConfirmation(r);
  assert.equal(cc.clusters.SUPPLY_CREDIT.length, 3);
  assert.equal(cc.rawHitCount, 3);
  assert.equal(cc.independentClusterCount, 1, '「信用需給改善」が過剰評価されてはいけない');
});

test('clusterConfirmation: CASE D — 売上成長率・利益成長率・成長加速はいずれも「業績成長」という同じ現象による重複', () => {
  const r = { revenueGrowthPct: 30, profitGrowthPct: 40, growthAcceleration: { level: 'good' } };
  const cc = clusterConfirmation(r);
  assert.equal(cc.clusters.FUNDAMENTALS.length, 3);
  assert.equal(cc.rawHitCount, 3);
  assert.equal(cc.independentClusterCount, 1, '同じ業績成長という現象による過剰加点を抑制する（EPS成長率は現状未実装のため対象外）');
});

test('clusterConfirmation: CASE E — 5クラスタすべてで独立した根拠が本当に存在する場合は、抑制せずきちんと5と評価する', () => {
  const r = {
    kairi: -12, // PRICE
    per: 8, sectorPer: 15, // VALUATION
    loanRatio: 2, // SUPPLY_CREDIT
    revenueGrowthPct: 30, // FUNDAMENTALS
    catalystScore100: 80, // CATALYST
  };
  const cc = clusterConfirmation(r);
  assert.equal(cc.independentClusterCount, 5, '5つの独立したクラスタが本当に確認できる場合は、抑制しすぎず5と評価できなければならない');
});

test('clusterConfirmation: 該当が無いクラスタは空配列（推測で埋めない）。全データ欠損ならindependentClusterCount:0', () => {
  const cc = clusterConfirmation({});
  assert.equal(cc.independentClusterCount, 0);
  assert.equal(cc.rawHitCount, 0);
  for (const hits of Object.values(cc.clusters)) assert.deepEqual(hits, []);
});
