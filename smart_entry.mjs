// ==================================================================
// smart_entry.mjs — 「スマート・エントリー」全銘柄スキャン
//
//  決算スケジュールを無視し、需給と乖離だけで機械的にスクリーニングする。
//  AMBUSHのユニバース（SBI決算カレンダーのT+14〜45日以内）とは独立。
//
//  ■ 対象ユニバース
//  東証の全銘柄マスタは保有していないため、TDnet直近14営業日の開示銘柄
//  （実測: 約3,400銘柄）∪ SBI決算カレンダー銘柄（約270銘柄）∪ 手動
//  ウォッチリスト（watchlist.mjs）の和集合をユニバースとする。開示が
//  全く無い超小型株は漏れうるが、東証上場の大半をカバーできる（仕様書の
//  「全3,800銘柄」に近似）。
//
//  実測ギャップ（ユーザー指摘、2026-09-10）: 直近開示から14営業日以上
//  経過し、かつ次回決算もまだSBI決算カレンダーに載っていない銘柄
//  （実例: シマダヤ250A。1Q決算は既に開示済みだが直近14営業日の枠外、
//  次の2Q決算はまだSBIカレンダーに未掲載）は、TDnet/SBIどちらの経路
//  でも一度も発見されず完全な死角になる。手動ウォッチリストは、この
//  「発見済み」に頼らず個別に追跡するための穴埋め（詳細はwatchlist.mjs）。
//
//  ■ 2段スクリーニング（AMBUSHと同じ考え方）
//  Stage 1 … 全ユニバースを kabuka ページ1枚(1リクエスト)で取得し、
//            低位株・薄商い銘柄を除外した上でパターン①②の技術条件
//            （乖離・RSI・GC・出来高倍率）だけで仮判定する。
//            週次信用残・決算はまだ取らない。
//  Stage 2 … Stage1候補 ∪ コンセンサスを持つSBI銘柄だけに絞って、
//            週次信用残ページ・決算ページ(2リクエスト)を追加取得し、
//            赤字・債務超過を除外した上で3パターンを確定判定する。
//            ここで全銘柄に手を広げるとリクエストが膨れるため、
//            候補を絞ってから叩く。
//
//  ■ 除外フィルター（「一切表示しない」対象）
//  株価300円未満・直近5日平均売買代金1億円未満・直近営業損益が赤字・
//  自己資本比率0%以下（債務超過）のいずれかに該当する銘柄は候補から
//  除く（indicators.mjsのcheapExclusion/fundamentalExclusion）。
//  25日線乖離率+15%超（過熱）やグロース市場の急騰は除外ではなく
//  警告バッジ（scraper.mjs側で付与）。
//
//  ■ パターン③（しこり解消・出遅れ株）の限界
//  コンセンサス予想はSBI決算カレンダーに載っている銘柄（次回決算が
//  近い銘柄）にしか無い。全銘柄分の予想コンセンサスは保有していない
//  ため、パターン③はSBIカレンダー外の銘柄では常にN/A（非該当）になる。
//  推測で埋めない（仕様書§25と同じ方針）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchIntraday, fetchIntradayExtended, fetchWeeklyCredit, fetchFinance, fetchMain, fetchThemeStocks, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, goldenCross, volumeRatio, creditTrend, creditLevelVsRange,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal,
  cheapExclusion, fundamentalExclusion,
  sellingClimaxSignal, netNetSignal, lowPbrSignal, dividendYieldFloorSignal, shortSqueezeSignal, sectorMomentumSignal,
  sectorRotationSignal, SECTOR_ROTATION, marginOverhangSignal, buyingDemandSignal, earningsProximitySignal, receivablesAnomalySignal,
  institutionalShortSignal, majorShareholderSignal, dividendYieldPeakSignal, pbrHistoricalLowSignal, hiddenGemSignal,
  retailExpectationSignal, returnPct, priceLevelVsRange,
  progressStreakSignal, dividendPotentialSignal, hiddenAssetSignal, hasPrecursor, GROWTH_MARKET,
  tenbaggerSignal, midCapGrowthSignal, repricingLagScore, repricingGapScore, latestProfitYoyPct, growthAccelerationSignal, diamondSignal,
  breakoutVolumeSignal, computeFloatRatio, floatSqueezeSignal, aggressiveInvestmentSignal, themeMatchSignal,
  valuationQualityScore, tenbaggerRealizabilityScore, growthPotentialScore, deficitGrowthSignal,
  growthAnomalyCautionSignal, earningsCashFlowQualitySignal, marginImproving, inflectionCauseSignal, turnaroundCountermeasureSignal,
  evEbitda, coreScreeningSignal, inflectionSpreadSignal, inflectionProgressSurpriseSignal, inflectionHurdleRatioSignal,
  inflectionDownsideRiskSignal, inflectionPatternType,
} from './indicators.mjs';
import { sectorTrendPct } from './sector_history.mjs';
import { fetchMajorShareholderTrend, fetchDividendYieldHistory, fetchPbrHistory } from './irbank.mjs';
import { buildDocumentIndex, fetchBalanceSheetSnapshot } from './edinet.mjs';
import { fetchInstitutionalShortInterest } from './karauri.mjs';
import { daysUntil } from './screener.mjs';
import { MANUAL_WATCHLIST, TENBAGGER_WATCHLIST } from './watchlist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'smart_entry_cache.json');

// 表示上限。仕様（新提案）は「毎日10個ほど」だが、複数該当時に何件
// 切り捨てたか分かるよう少し余裕を持たせる。
export const RESULT_LIMIT = 24;

// テーマ性マッチング（themeMatchSignal、ユーザー提案）の手動キュレー
// ションリスト。tenbagger_research_log.mdの手動リサーチで実際に
// kabutan.jpのテーマページが存在すると確認済みの表記のみを載せる
// （実測: "AI"・"自動運転"・"防衛関連"は404だったため採用していない）。
//
// v7.5改修（ユーザー要望「テーマタグ自動付与の拡張」→「他の表記でも
// 問い合わせてほしい」→「再発防止策実行して。もっと範囲広げて」）。
//
// ■ 再発防止策: 「推測ゲーム」をやめ、kabutan.jp自身のサジェストAPIで
// 表記を発見する運用に切り替えた
// これまでは"量子"・"核融合"・"バイオ"・"再エネ"・"AI"・"ヒューマノイド"
// のようにユーザー提案の単語をそのまま試して404を繰り返していた。
// kabutan.jpの検索窓が使っているサジェストAPI
// （kabutan.mjs:fetchThemeSuggestions、search.kabutan.jp/api/v1/suggest）
// は、種語（"AI"「ロボット」等の断片でよい）を投げるとtype:"jp_theme"の
// 候補としてkabutan側の正しい表記をそのまま返してくれる（実測: word=量子
// → "量子コンピューター"「量子暗号通信」を発見）。今後テーマを追加する
// 際は、必ずこのAPIで発見→fetchThemeStocks()で実件数確認、の順に行い、
// 表記を推測しないこと。
//
// ■ このAPI経由で新たに発見・実件数確認済み（8〜15件、いずれも実在）
// 量子コンピューター・量子暗号通信・核融合発電・バイオテクノロジー関連・
// 再生可能エネルギー・人工知能・AIエージェント・フィジカルAI・
// ヒト型ロボット（ヒューマノイドのkabutan側表記）に加え、種語を
// 大きく広げて発見した以下も追加: 半導体製造装置・半導体部材部品・
// 宇宙開発関連・衛星運営・医療機器・医療情報・遠隔医療・自動車電子化・
// 電気自動車関連・セキュリティソフト・バイオ抗がん剤・バイオ後発薬・
// バイオマス発電・バイオ航空燃料・創薬・フィンテック・不動産テック・
// 物流テック・スマート農業・教育ICT・インバウンド・原子力発電・
// 水素ステーション・電池関連・5G・6G・メタバース・仮想通貨・
// クラウドコンピューティング・サーバー冷却・空飛ぶクルマ・
// ウェアラブル端末・脱プラスチック・SaaS・サブスクリプション・
// 洋上風力発電・太陽光発電関連・デジタルツイン・リサイクル・水処理膜・
// スマートシティ。自動発見の仕組みは無いため、今後の追加リサーチで
// 随時追記していく運用（US_TENBAGGER_WATCHLISTと同じ考え方）。
export const THEME_WATCHLIST = [
  'ドローン', '建設DX', '橋梁', '脱炭素', '半導体', 'データセンター',
  '再生医療', 'サイバーセキュリティ', '蓄電池', '水素', '防衛', '自動運転車',
  'ロボット', '生成AI',
  '量子コンピューター', '量子暗号通信', '核融合発電', 'バイオテクノロジー関連',
  '再生可能エネルギー', '人工知能', 'AIエージェント', 'フィジカルAI', 'ヒト型ロボット',
  '半導体製造装置', '半導体部材・部品', '宇宙開発関連', '衛星運営',
  '医療機器', '医療情報', '遠隔医療', '自動車電子化', '電気自動車関連', 'セキュリティソフト',
  'バイオ抗がん剤', 'バイオ後発薬', 'バイオマス発電', 'バイオ航空燃料', '創薬',
  'フィンテック', '不動産テック', '物流テック', 'スマート農業', '教育ICT', 'インバウンド',
  '原子力発電', '水素ステーション', '電池関連', '5G', '6G', 'メタバース', '仮想通貨',
  'クラウドコンピューティング', 'サーバー冷却', '空飛ぶクルマ', 'ウェアラブル端末',
  '脱プラスチック', 'SaaS', 'サブスクリプション', '洋上風力発電', '太陽光発電関連',
  'デジタルツイン', 'リサイクル', '水処理膜', 'スマートシティ',
];

// THEME_WATCHLISTの各テーマページを1回ずつ取得し、コード→該当テーマ名
// 配列のMapを作る（候補ごとではなくスキャン全体で1回だけ。テーマ数は
// 少数なので追加コストは小さい）。404等は黙ってスキップする
// （テーマ名の表記が変わった可能性があるだけで、スキャン全体を止めない）。
async function buildThemeCodeMap() {
  const map = new Map();
  for (const theme of THEME_WATCHLIST) {
    try {
      await sleep(REQ_GAP);
      const codes = await fetchThemeStocks(theme);
      for (const code of codes) {
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(theme);
      }
    } catch (e) {
      console.error(`  ⚠️ テーマページ取得失敗（${theme}）: ${e.message}`);
    }
  }
  return map;
}

// ------------------------------------------------------------------
// ユニバース構築 — TDnetの開示銘柄 ∪ SBI決算カレンダー銘柄 ∪ 手動
// ウォッチリスト（watchlist.mjs。TDnet/SBIどちらの発見経路にも乗らない
// 銘柄の穴埋め。詳細はファイル冒頭のコメント参照）∪ JPX上場銘柄一覧
// （jpx.mjs、ユーザー要望2026-09-13「スキャンの範囲もう少し広げられ
// ませんか」への対応）。
//
// jpxNamesは呼び出し側（scraper.mjs）で市場区分を絞り込んだ後の
// {code: name}を渡す想定（buildUniverse自身は絞り込みをしない）。
// まずはプライム市場のみを追加し、実行時間への影響を見てから段階的に
// 広げる方針（ユーザー判断）のため、市場区分によるフィルタリングを
// 呼び出し側に持たせておくことで、対象市場を増やす変更を呼び出し側
// 1箇所の変更だけで済むようにしている。
export function buildUniverse({ tdNames = {}, sbiStocks = {}, manualWatchlist = MANUAL_WATCHLIST, jpxNames = {} } = {}) {
  const universe = {};
  for (const [code, name] of Object.entries(tdNames)) universe[code] = name;
  for (const [code, s] of Object.entries(sbiStocks)) universe[code] ??= s.name;
  for (const w of manualWatchlist) universe[w.code] ??= w.name;
  for (const [code, name] of Object.entries(jpxNames)) universe[code] ??= name;
  return universe;
}

// 順位付け用の総合スコア。該当パターン数(matched)が主軸だが、それだけで
// 決めると「乖離は深いが信用倍率が高い」ような銘柄が、他の警告材料を
// 一切見ずに1位に来てしまう（実測で確認済み）。底打ち確認の追加根拠や
// 警告、部分該当（データ不足で該当扱いにできないが根拠はある状態）も
// 加味する。scraper.mjs の場中再判定後の並べ直しでも同じ基準を使う。
// smartEntryConvictionが実際に加点する信号の一覧。この配列を唯一の
// 情報源にする（test/conviction.test.mjsがこれをimportして使う。
// screener.mjsのAMBUSH_BONUS_FIELDSと同じ再発防止の考え方）。
//
// 実測バグ（評価の仕組みの横断監査で発覚）: progressStreak（進捗率が
// 加速中）はメインループで既に計算・結果オブジェクトに添付済みで、
// AMBUSH_BONUS_FIELDSには含まれているのに、SMART_ENTRY_BONUS_FIELDSには
// 一度も含まれていなかった（カードのチップ表示・CHIP_SIGNAL_FIELDS経由の
// 赤旗判定には使われるが、順位付けには一切反映されていなかった）。
export const SMART_ENTRY_BONUS_FIELDS = [
  'climax', 'netNet', 'lowPbr', 'divFloor', 'squeeze', 'sectorRotation', 'sectorLag', 'institutionalShort',
  'majorShareholder', 'dividendPeak', 'pbrHistoricalLow', 'hiddenGem', 'progressStreak',
];

// smartEntryConvictionが実際に減点する信号の一覧（SMART_ENTRY_BONUS_FIELDS
// と同じ「単一の情報源」の考え方）。retailExpectationSignal（個人投資家
// の期待織り込み）は「まだ株価に織り込まれていないパターン」を優先する
// ための重要な減点要素（ユーザー要望。screener.mjsのAMBUSH_PENALTY_FIELDS
// と同じ考え方）。
export const SMART_ENTRY_PENALTY_FIELDS = ['sectorLag', 'marginOverhang', 'earningsWarning', 'receivablesAnomaly', 'retailExpectation'];

export function smartEntryConviction(r) {
  let score = r.matched * 100;
  score += [r.sig1, r.sig2, r.sig3].filter((s) => s?.level === 'partial').length * 20;
  // sectorLagは「連れ高(bad)」は減点対象なのに「出遅れ(good)」は加点
  // 対象に入っておらず、似た性質のsectorRotationとの扱いが非対称だった
  // （bottomChipsでは同じ緑チップとして表示されるのに、スコアには
  // 反映されていなかった）。sectorRotationと同様にgoodも加点する。
  score += SMART_ENTRY_BONUS_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good').length * 15;
  score -= SMART_ENTRY_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'bad').length * 25;
  // 実測バグ（評価の仕組みの横断監査で発覚）: 上のコメント通りAMBUSH_
  // PENALTY_FIELDS（screener.mjs/ambushConviction）と「同じ考え方」で
  // 設計したはずが、ambushConvictionはbad(-10)だけでなくwarn(-4、bad
  // より軽い減点)も反映しているのに、smartEntryConvictionにはwarn分の
  // 減点が一度も実装されていなかった（test/conviction.test.mjsにも
  // ambushConviction側のwarnテストしか無く、smartEntryConviction側は
  // badテストしか存在しなかった＝移植漏れの証拠）。marginOverhang等が
  // warnでも、bad未満の軽い減点として反映する（ambushConvictionと同じ
  // bad:warn=10:4の比率をこちらのbad(25)に当てはめ、25:10とする）。
  score -= SMART_ENTRY_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn').length * 10;
  // v7.4改修（ユーザーの実銘柄分析）: 該当パターン数×100＋チップ加点の
  // 整数バケット構成だけでは、実データで検証したところ松屋(PER224・
  // PBR4.3)を含む7銘柄が全く同じ145点で並んでいた。タイブレークが乖離率
  // だけなので、割安度がまるで違う銘柄が同格に扱われる（PER224倍の銘柄が
  // PER17.2倍の銘柄より上位に来る）逆転が起きていた。業種平均PER/PBRとの
  // 比率（最大30点）を加点し、この種の同点を減らす。
  score += valuationQualityScore({ per: r.per, sectorPer: r.sectorPer, pbr: r.pbr, sectorPbr: r.sectorPbr }).score;
  return score;
}

// Stage 1 の安価な部分判定 — 週次信用残を取らずに分かる範囲だけで
// パターン①②の「技術条件が満たされているか」を仮判定する。
// （パターン③は信用残水準が要るのでここでは判定できない）
function cheapCandidate(tech) {
  const p1 = tech.kairi !== null && tech.rsi !== null && tech.kairi <= -10 && tech.rsi <= 30;
  const p2 = tech.cross?.crossed === true && tech.volRatio !== null && tech.volRatio >= 1.5;
  return p1 || p2;
}

// ------------------------------------------------------------------
// 成長株（東証グロース）カタリスト予兆スキャン（ユーザー要望）
//
//  カタリスト予兆セクションはAMBUSHユニバース（決算T+14〜45日・
//  約20〜25銘柄）に限定されていたが、「成長株にも入れて欲しい」という
//  要望に対応し、東証グロース市場銘柄全体を対象に同じ予兆
//  （進捗率加速・株主還元ポテンシャル・含み資産・売掛金急増）を探す。
//
//  ■ 全銘柄にEDINET財務データ取得をかけない理由（コスト）
//  東証グロースは500〜650銘柄あり、全銘柄にEDINET+kabutan決算ページの
//  取得をかけると現状の30〜40分のスキャンにさらに20〜40分以上（実測では
//  それ以上）かかる。ユーザーの了承を得て、Stage1で全銘柄に既に適用
//  済みのcheapExclusion（出来高・株価フィルタ、追加コスト無し）に加え、
//  時価総額の下限でも絞り込む。
//
//  techByCode（Stage1で全銘柄分取得済み）のmarketフィールドで対象を
//  絞れるため、市場区分を得るための追加リクエストは発生しない。
// ------------------------------------------------------------------
export const GROWTH_PRECURSOR = { minMarketCap: 3000 }; // 百万円（30億円）。仕手性の高い超小型株を除外する目的

// テンバガー候補（Tier A）の時価総額上限。300億円未満を「まだ10倍になる
// 余地がある小型株」の目安とする。
export const TENBAGGER_MAX_MARKET_CAP_JPY = 30_000; // 百万円

// 中型成長株候補（Tier B）の時価総額上限。実データで発覚した問題（AUR
// 時価総額$118億は10倍に$1180億必要で非現実的、402A時価総額347億円との
// 規模差が50倍近くあり同じ枠に同居していた）を受け、上限を新設して
// 「テンバガーは無理だが2〜3倍は狙えるグロース中堅株」に再定義した
// （indicators.mjsのmidCapGrowthSignal参照）。
export const MID_CAP_MAX_MARKET_CAP_JPY = 100_000; // 百万円（1000億円）

// 「業績屈折(SECTION D)」の候補判定（ユーザー提案2026-09-12の詳細
// スクリーニング仕様に全面置換。旧isInflectionEligible=quarterYoy<=-10%
// かつ回復ギャップ>=10pt、または黒字転換、という単純な閾値だった）。
//
// 採用した判定方針（ユーザーの「①コア・スクリーニング条件」「最重要の
// キラー指標3つ」「この5つが揃う銘柄を最優先候補にします」という記述を
// 踏まえた設計判断。5条件のうち2つ（月次売上・PER/PBR6ヶ月変化率）は
// データソースが無く実装できなかったため、そのまま5条件AND必須に
// すると候補が一件も出なくなる）:
//   - ①コア・スクリーニング条件（割安・財務レンジ）は必須ゲート
//     （全項目が確認できて条件を満たすこと。未確認/レンジ外は不合格）。
//   - キラー指標3つ（スプレッド・進捗サプライズ・ハードル比率）は
//     「1つでも該当すれば候補入り」（該当数はランキング・表示用に
//     別途保持し、3つ全部そろった銘柄を「最優先候補」として扱う）。
// hasConcreteCause: ユーザー指摘（2026-09-13）「なぜ悪かったか分から
// ない銘柄が業績屈折として抽出されているのは、単にギャップが大きい
// だけで無理やり引っ張ってきている証拠」への対応。inflectionCause
// Signal（indicators.mjs）が原因を1つも特定できなかった銘柄は候補から
// 外す。ただし黒字転換(turnsProfitable)はinflectionCauseSignal自体が
// 「減益の説明」専用（対象外だと常にchecked:false）のため、この要件
// からは除外する（「そもそも聞く意味が無い質問」であって「原因不明」
// ではない）。
export function isInflectionEligible({ coreScreening, killerHits, hasConcreteCause = true } = {}) {
  if (!coreScreening?.passed) return false;
  if (!hasConcreteCause) return false;
  return killerHits >= 1;
}

// 「テンバガー候補監視リスト」（ユーザー提案2026-09-13）。通常の
// テンバガー候補（scanGrowthPrecursors、東証グロース・時価総額300億〜
// 1000億円のレンジのみ）とは完全に独立した、手動選定銘柄の信用需給
// 専用モニター。ユーザーの投資判断が「信用買い残が高すぎるので、それが
// クリアされたら買う」という需給待ちのため、決算日・成長率等では
// 一切絞り込まず、TENBAGGER_WATCHLIST（watchlist.mjs）に登録した銘柄
// だけを毎回、価格・信用残・信用倍率・直近レンジ内の位置で追跡する。
export async function scanTenbaggerWatchlist() {
  const out = [];
  for (const w of TENBAGGER_WATCHLIST) {
    try {
      const [iv, main, weekly] = await Promise.all([
        fetchIntraday(w.code),
        fetchMain(w.code),
        fetchWeeklyCredit(w.code),
      ]);
      const latest = weekly[0] ?? {};
      out.push({
        code: w.code, name: w.name, note: w.note,
        price: iv?.price ?? null, changePct: iv?.changePct ?? null,
        marketCap: main?.marketCap ?? null, market: main?.market ?? null,
        marginBuy: latest.buy ?? null, marginSell: latest.sell ?? null,
        loanRatio: latest.loanRatio ?? null,
        creditTrendPct: creditTrend(weekly),
        creditLevelPct: creditLevelVsRange(weekly),
        creditDate: latest.date ?? null,
      });
    } catch (e) {
      console.error(`  ⚠️ テンバガー候補監視リスト ${w.code} 取得失敗: ${e.message}`);
      out.push({ code: w.code, name: w.name, note: w.note, fetchFailed: true });
    }
    await sleep(REQ_GAP);
  }
  return out;
}

async function scanGrowthPrecursors(techByCode, universe) {
  const growthCodes = Object.entries(techByCode)
    .filter(([, tech]) => tech.market === GROWTH_MARKET)
    .map(([code]) => code);
  console.log(`🌱 成長株カタリスト予兆: 東証グロース${growthCodes.length}銘柄（出来高フィルタ済み）を走査`);

  let edinetIndex = new Map();
  try {
    edinetIndex = await buildDocumentIndex(growthCodes);
  } catch (e) {
    console.error(`  ⚠️ 成長株予兆: EDINET書類一覧の一括取得に失敗: ${e.message}`);
  }
  // テーマ性マッチング（ユーザー提案）。候補ごとではなくスキャン全体で
  // 1回だけ、THEME_WATCHLISTの各テーマページを取得する。
  const themeCodeMap = await buildThemeCodeMap();

  const out = [];
  const tenbaggersA = [];
  const tenbaggersB = [];
  let capExcluded = 0, err = 0;
  for (const [i, code] of growthCodes.entries()) {
    if ((i + 1) % 100 === 0) {
      console.log(`   … ${i + 1}/${growthCodes.length}（該当 ${out.length} / 時価総額除外 ${capExcluded} / 取得失敗 ${err}）`);
    }
    let main = {};
    try {
      main = await fetchMain(code);
    } catch {
      err++;
      await sleep(REQ_GAP);
      continue;
    }
    await sleep(REQ_GAP);
    // 時価総額での絞り込みはfetchMainの結果が無いと判定できないため、
    // ここで初めて弾く（1銘柄1リクエスト分のコストは避けられないが、
    // これ以降のfetchFinance/EDINET ZIP取得の方が重いので、ここで
    // 早期returnする意味は大きい）。
    if (!Number.isFinite(main.marketCap) || main.marketCap < GROWTH_PRECURSOR.minMarketCap) {
      capExcluded++;
      continue;
    }

    let fin = {}, bs = {};
    try {
      fin = await fetchFinance(code);
    } catch { /* フォールバック: progressStreak等はN/Aのまま */ }
    await sleep(REQ_GAP);
    try {
      bs = await fetchBalanceSheetSnapshot(edinetIndex.get(code));
    } catch { /* フォールバック: dividendPotential等はN/Aのまま */ }
    await sleep(REQ_GAP);

    const progressStreak = progressStreakSignal(fin.progressHistory);
    const dividendPotential = dividendPotentialSignal({
      retainedEarnings: bs.retainedEarnings, marketCap: main.marketCap, dividendYield: main.dividendYield,
    });
    const hiddenAsset = hiddenAssetSignal({ investmentSecurities: bs.investmentSecurities, marketCap: main.marketCap });
    const receivablesAnomaly = receivablesAnomalySignal({
      revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
      receivablesGrowthPct: bs.receivablesGrowthPct ?? null,
      operatingCfGrowthPct: bs.operatingCfGrowthPct ?? null,
      advancesReceivedGrowthPct: bs.advancesReceivedGrowthPct ?? null,
      inventoryGrowthPct: bs.inventoryGrowthPct ?? null,
    });
    const tech = techByCode[code];

    // テンバガー候補（ユーザー提案、Tier A/B 2階建て）。progressStreak等の
    // カタリスト予兆シグナルとは判定基準が別物（予兆の有無ではなく
    // 小時価総額×高成長率、またはTier Bは大型でも高成長率が続いているか）
    // のため、下のhasPrecursorによるcontinueより前で判定する
    // （continueしてしまうとカタリスト予兆に該当しないテンバガー候補が
    // 拾えなくなる）。
    // 判定は排他的: 時価総額が上限以下ならTier A、超えていればTier Bの
    // みを判定する（同じ銘柄が両方には出ない）。
    const revenueGrowthPct = fin.revenueGrowth?.growthPct ?? null;
    // v7.5改修（実測バグ再発防止の横断監査で発覚）: growthAcceleration/
    // themeMatchはこれまでtenbaggerHitの分岐内でしか計算しておらず、
    // カタリスト予兆カード（precursorCard、growth-sourced）には一切
    // 露出していなかった。themeCodeMap/fin.revenueGrowthはこのループの
    // 全銘柄で既に取得済みのデータのため、tenbaggerHitの判定より前に
    // 全銘柄向けに計算しておく（追加リクエスト無し）。repricingLag
    // （DIAMOND判定に必要）はivFreshの追加取得が要るため、候補を絞った
    // tenbaggerHit分岐内のみで計算する方針は変えない（全銘柄に広げると
    // 東証グロース500〜650銘柄分の追加リクエストが発生してしまうため）。
    // A指示 項目7「成長加速を独立スコア化する」: 粗利率・営業利益率改善
    // ボーナスも渡す。bsは全銘柄向けに既に取得済みのため追加リクエスト無し。
    // 第6優先改修■3（ユーザー報告）: 売上成長・利益成長とは別に「利益率
    // (MARGIN)が改善しているか」を専用フィールドとして保持する
    // （growthAccelerationSignalの内部でも同じ値を使っているが、これまで
    // 呼び出し側に生値として残しておらず、evaluationAxesから参照できな
    // かった）。marginImproving自体は既存関数の再利用で新規計算は無い。
    const grossMarginImproving = marginImproving(bs.grossProfit, bs.netSales, bs.grossProfitPrior, bs.netSalesPrior);
    const opMarginImproving = marginImproving(bs.operatingIncome, bs.netSales, bs.operatingIncomePrior, bs.netSalesPrior);
    const growthAcceleration = growthAccelerationSignal({
      growthPct: revenueGrowthPct, prevGrowthPct: fin.revenueGrowth?.prevGrowthPct ?? null,
      grossMarginImproving, opMarginImproving,
    });
    const themeMatch = themeMatchSignal({ matchedThemes: themeCodeMap.get(code) ?? [] });
    const withinTierACap = Number.isFinite(main.marketCap) && main.marketCap <= TENBAGGER_MAX_MARKET_CAP_JPY;
    const tenbaggerA = withinTierACap
      ? tenbaggerSignal({ marketCap: main.marketCap, maxMarketCap: TENBAGGER_MAX_MARKET_CAP_JPY, revenueGrowthPct, unitLabel: '百万円' })
      : { level: null, label: null, note: null, checked: true };
    const tenbaggerB = withinTierACap
      ? { level: null, label: null, note: null, checked: true }
      : midCapGrowthSignal({ marketCap: main.marketCap, maxMarketCap: MID_CAP_MAX_MARKET_CAP_JPY, revenueGrowthPct, unitLabel: '百万円' });
    // 「持続的な高成長」の追加確認（手動リサーチで得た教訓の反映）。
    // revenueGrowthPctは年次決算の単一時点の値のため、前期が異常に
    // 悪かった反動での一時的な高成長率を「持続成長」と誤認するリスクが
    // ある。fin.progressHistory（同じ時期の進捗率の複数年推移）は既に
    // progressStreak計算用に取得済みのため、追加リクエスト無しで
    // 「直近の進捗率が前年同期を下回っていないか」を確認できる。
    // 悪化していれば、Tier A/Bいずれの条件を満たしていてもテンバガー
    // 候補からは除外する（Tier A/B共通の質チェック）。
    const ph = fin.progressHistory;
    const progressDeclining = Array.isArray(ph) && ph.length >= 2 && ph.at(-1).progress < ph.at(-2).progress;
    // A指示 項目8「異常成長のベース効果・一時要因を確認する」。bsは
    // 全銘柄向けに既に取得済み（v7.6でoperatingIncomePrior/netSalesPrior/
    // extraordinaryIncome等をextractBalanceSheetSnapshotに追加済み）の
    // ため追加リクエスト無し。
    const growthAnomalyCaution = growthAnomalyCautionSignal({
      revenueGrowthPct, profitGrowthPct: latestProfitYoyPct(ph),
      operatingIncomePrior: bs.operatingIncomePrior, netSalesPrior: bs.netSalesPrior,
      extraordinaryIncome: bs.extraordinaryIncome, extraordinaryLoss: bs.extraordinaryLoss, impairmentLoss: bs.impairmentLoss,
      extraordinaryIncomePrior: bs.extraordinaryIncomePrior, extraordinaryLossPrior: bs.extraordinaryLossPrior, impairmentLossPrior: bs.impairmentLossPrior,
    });
    const tenbaggerHit = !progressDeclining
      ? (tenbaggerA.level === 'good' ? { tier: 'A', signal: tenbaggerA } : tenbaggerB.level === 'good' ? { tier: 'B', signal: tenbaggerB } : null)
      : null;
    if (tenbaggerHit) {
      // 仕込み妙味スコア（「今から買う妙味」軸、Tier判定=「10倍ポテン
      // シャル」軸とは別物）。候補に絞られた銘柄だけ、60日超の日足を
      // 追加取得する（Stage1のtech.closesは1ページ=約30日分しか無く、
      // priceLevelVsRange(60)/returnPct(closes,60)には不足するため。
      // 候補は少数なのでコスト増は許容できる）。
      // hasCatalyst代用: TDnetは見ないスキャンのため、同じ銘柄で既に
      // 計算済みのカタリスト予兆シグナル（progressStreak等）のいずれか
      // がgoodかどうかで代用する（追加コスト無し）。仕込み妙味スコアの
      // 入力に加え、株価帯フィルター（低位株ほど10倍化を狙いやすいと
      // いうユーザー方針）で「材料十分か」の判定にも使う。
      const hasCatalyst = [progressStreak, dividendPotential, hiddenAsset].some((s) => s?.level === 'good');
      // growthAcceleration/themeMatchは上（全銘柄向け）で計算済みのため
      // ここでは再計算しない。
      // 攻めの投資（研究開発費が売上を上回る伸び、ユーザー提案）。
      // bsは既にこのループの上流で取得済み（edinet.mjs）のため追加
      // リクエスト無し。
      const aggressiveInvestment = aggressiveInvestmentSignal({
        rndGrowthPct: bs.rndGrowthPct ?? null, revenueGrowthPct,
      });
      let repricingLag = null, breakoutVolume = { level: null, label: null, note: null, checked: false };
      let floatSqueeze = { level: null, label: null, note: null, checked: false };
      let majorShareholder = { level: null, label: null, note: null, checked: false };
      try {
        await sleep(REQ_GAP);
        const ivFresh = await fetchIntradayExtended(code, 3);
        const psr = Number.isFinite(fin.revenueGrowth?.latestSales) && fin.revenueGrowth.latestSales > 0 && Number.isFinite(main.marketCap)
          ? main.marketCap / fin.revenueGrowth.latestSales
          : null;
        const repricingLagInputs = {
          return1m: returnPct(ivFresh?.closes, 20),
          return3m: returnPct(ivFresh?.closes, 60),
          priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
          revenueGrowthPct, profitGrowthPct: latestProfitYoyPct(ph),
          per: null, sectorPer: null, psr, hasCatalyst,
          daysToEarnings: null, // 決算日非依存スキャンのため取得していない
        };
        // A指示 項目3「Repricing Gap概念を実装」。repricingLagInputsに
        // 既に必要な値（成長率・株価反応率・レンジ内位置）が揃っているため
        // 追加リクエスト無し。
        repricingLag = { ...repricingLagScore(repricingLagInputs), repricingGap: repricingGapScore(repricingLagInputs) };
        // 高値圏×出来高急増（順張りブレイクアウト、ユーザー提案）。
        // ivFreshは既にrepricingLag用に取得済みでvolumesも含むため
        // 追加リクエスト無し。repricingLagとは逆に「高値圏＋出来高」を
        // ポジティブに評価する別軸のため、scraper.mjs側で両者が矛盾なく
        // 併記されるようツールチップを付ける。
        const vol = volumeRatio(ivFresh?.volumes, 20);
        breakoutVolume = breakoutVolumeSignal({ priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60), volumeRatio: vol });
        // 浮動株比率×出来高急増（ユーザー提案）。候補は少数のため
        // fetchMajorShareholderTrendを追加で1リクエスト許容する
        // （ivFresh取得と同じ「候補限定なら追加コストを許容する」方針）。
        try {
          await sleep(REQ_GAP);
          const shareholderInfo = await fetchMajorShareholderTrend(code);
          const floatRatio = computeFloatRatio({ sharesOutstanding: main.sharesOutstanding, top3PctNow: shareholderInfo.top3PctNow });
          floatSqueeze = floatSqueezeSignal({ floatRatio, volumeRatio: vol });
          // v7.3改修 項目13（TENBAGGER SCOREの「株主構成」軸）: shareholderInfoは
          // 上のfloatSqueeze用に既に取得済みのため追加リクエスト無しで
          // 大株主の買い増し（majorShareholderSignal、AMBUSH/SMART ENTRY本体の
          // 判定と同じ関数）を併せて評価できる。
          majorShareholder = majorShareholderSignal(shareholderInfo);
        } catch { /* 失敗してもfloatSqueeze/majorShareholderはchecked:falseのまま */ }
      } catch { /* 失敗しても候補自体は表示する（repricingLag等はデフォルトのまま） */ }
      // v7.5改修（ユーザー提案「テーマ性×小型×高成長×未織り込みが揃ったら
      // DIAMONDにする」）: Tier A/Bの上限どちらでも収まる、より広い
      // MID_CAP_MAX_MARKET_CAP_JPY（1000億円）を「小型」の基準にする
      // （DIAMONDはTier A/Bどちらの候補にも付きうる、より希少な組み合わせ
      // を示すバッジのため）。
      const diamond = diamondSignal({
        themeMatch, marketCap: main.marketCap, maxMarketCap: MID_CAP_MAX_MARKET_CAP_JPY,
        revenueGrowthPct, repricingLagZone: repricingLag?.zone, unitLabel: '百万円',
        growthAcceleration, cash: bs.cash, interestBearingDebt: bs.interestBearingDebt, hasCatalyst,
      });
      // A指示 項目14/36: 「10倍実現可能性」「成長ポテンシャル」を
      // 「今買う妙味」（repricingLag.score、既存）とは別の独立スコアとして
      // 追加する。Tierごとに上限が異なる（Tier A=TENBAGGER_MAX_MARKET_CAP_JPY、
      // Tier B=MID_CAP_MAX_MARKET_CAP_JPY）ため、該当するTierの上限を渡す。
      const tierMaxMarketCap = tenbaggerHit.tier === 'A' ? TENBAGGER_MAX_MARKET_CAP_JPY : MID_CAP_MAX_MARKET_CAP_JPY;
      const realizability = tenbaggerRealizabilityScore({ marketCap: main.marketCap, maxMarketCap: tierMaxMarketCap });
      const growthPotential = growthPotentialScore({ revenueGrowthPct, growthAcceleration });
      // A指示 項目10/11「赤字成長特例」「赤字成長・高リスク」: bsは
      // 関数冒頭で既にEDINETから取得済み（grossProfit/sga/operatingIncome/
      // capex/operatingCfPriorもv7.6でextractBalanceSheetSnapshotに追加
      // 済み）のため追加リクエスト無し。
      const deficitGrowth = deficitGrowthSignal({
        revenueGrowthPct, sgaGrowthPct: bs.sgaGrowthPct,
        grossProfit: bs.grossProfit, grossProfitPrior: bs.grossProfitPrior,
        netSales: bs.netSales, netSalesPrior: bs.netSalesPrior,
        operatingIncome: bs.operatingIncome, operatingIncomePrior: bs.operatingIncomePrior,
        operatingCf: bs.operatingCf, operatingCfPrior: bs.operatingCfPrior,
        capex: bs.capex, capexPrior: bs.capexPrior,
        cash: bs.cash, interestBearingDebt: bs.interestBearingDebt, equity: bs.equity,
      });
      const item = {
        code, name: universe[code] ?? code,
        price: tech.price, changePct: tech.changePct, closes: tech.closes.slice(-20), market: tech.market,
        marketCap: main.marketCap, revenueGrowthPct, tier: tenbaggerHit.tier, tenbagger: tenbaggerHit.signal, repricingLag, hasCatalyst,
        growthAcceleration, breakoutVolume, floatSqueeze, aggressiveInvestment, themeMatch, diamond,
        realizability, growthPotential, deficitGrowth,
        // v7.3改修 項目13（TENBAGGER SCOREの「財務」軸）: bsは関数冒頭で
        // 既にEDINETから取得済み（progressStreak等と同じ入力元）のため
        // 追加リクエスト無し。営業CF・現金・有利子負債という「テンバガー
        // 候補が成長を維持できる体力があるか」の生の裏付け情報を、
        // 閾値による除外はせず（実データで裏付けの無い閾値を作らない
        // 方針）参考情報としてそのまま表示する。
        operatingCf: bs.operatingCf ?? null, cash: bs.cash ?? null, interestBearingDebt: bs.interestBearingDebt ?? null,
        majorShareholder, growthAnomalyCaution,
      };
      if (tenbaggerHit.tier === 'A') tenbaggersA.push(item);
      else tenbaggersB.push(item);
    }

    const r = { progressStreak, dividendPotential, hiddenAsset, receivablesAnomaly };
    if (!hasPrecursor(r)) continue;

    out.push({
      code, name: universe[code] ?? code,
      price: tech.price, changePct: tech.changePct, closes: tech.closes.slice(-20), market: tech.market,
      marketCap: main.marketCap,
      progressStreak, dividendPotential, hiddenAsset, receivablesAnomaly,
      // v7.5改修（実測バグ再発防止の横断監査で発覚）: growthAcceleration/
      // themeMatchが計算済みなのにカタリスト予兆カードには一度も露出して
      // いなかった。diamond（テーマ性×小型×高成長×未織り込み）は
      // repricingLagが無いと判定できず、この銘柄群には未取得のため含めない
      // （tenbaggerHit分岐に該当した銘柄だけがdiamond判定の対象になる）。
      revenueGrowthPct, growthAcceleration, themeMatch, growthAnomalyCaution,
      grossMarginImproving, opMarginImproving,
    });
  }
  console.log(`   成長株予兆スキャン完了（時価総額${GROWTH_PRECURSOR.minMarketCap}百万円未満で除外 ${capExcluded} / 取得失敗 ${err}） / 該当 ${out.length}銘柄 / テンバガー候補 Tier A ${tenbaggersA.length}銘柄・Tier B ${tenbaggersB.length}銘柄`);
  // v7.5改修: themeCodeMap（THEME_WATCHLISTの各テーマページ取得結果、
  // 銘柄コード→該当テーマ名配列）はこの銘柄群（東証グロース）に限らず
  // 全銘柄で使い回せる情報のため、呼び出し元（runSmartEntryScreen）にも
  // 返し、メインの候補選定ループでも再取得せずそのまま使う。
  return { precursors: out, tenbaggersA, tenbaggersB, themeCodeMap };
}

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
export async function runSmartEntryScreen({ today, tdNames, sbiStocks, sectors = {}, sectorHistory = {}, force = false, limit = RESULT_LIMIT, tdByCode = {}, jpxNames = {} } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 スマート・エントリーキャッシュ有効 (${today}) — 該当${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  const universe = buildUniverse({ tdNames, sbiStocks, jpxNames });
  const codes = Object.keys(universe);
  console.log(`🌐 スマート・エントリー Stage 1: 全${codes.length}銘柄をスキャン（30〜40分程度かかります）`);

  const techByCode = {};
  const stage2Set = new Set();
  let s1err = 0, s1excluded = 0;

  for (const [i, code] of codes.entries()) {
    try {
      const iv = await fetchIntraday(code);
      // 低位株・薄商い銘柄は候補にすら上げない（「ゴミ箱排除」フィルター）。
      // ここで弾けば週次信用残ページ(Stage2)への無駄打ちも防げる。
      const excl = cheapExclusion({ price: iv.price, closes: iv.closes, volumes: iv.volumes });
      if (excl.excluded) { s1excluded++; }
      else {
        const tech = {
          price: iv.price,
          changePct: iv.changePct,
          closes: iv.closes,
          volumes: iv.volumes,
          market: iv.market,
          kairi: kairi(iv.price, iv.closes),
          rsi: rsi(iv.closes),
          cross: goldenCross(iv.closes),
          volRatio: volumeRatio(iv.volumes),
        };
        techByCode[code] = tech;
        if (cheapCandidate(tech)) stage2Set.add(code);
      }
    } catch {
      s1err++;
    }
    if ((i + 1) % 200 === 0) console.log(`   … ${i + 1}/${codes.length}（Stage2候補 ${stage2Set.size} / 除外 ${s1excluded} / 取得失敗 ${s1err}）`);
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 完了（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}） / Stage2候補 ${stage2Set.size}`);

  // 成長株カタリスト予兆スキャン（ユーザー要望）。techByCodeはStage1で
  // 全銘柄分取得済みのため、市場区分を得るための追加リクエストは無い。
  // テンバガー候補（ユーザー提案）も同じループ内・同じ既取得データから
  // 判定するため、追加リクエストは発生しない。
  const { precursors: growthPrecursors, tenbaggersA: tenbaggerCandidatesA, tenbaggersB: tenbaggerCandidatesB, themeCodeMap } = await scanGrowthPrecursors(techByCode, universe);
  console.log(`🔭 テンバガー候補監視リスト: ${TENBAGGER_WATCHLIST.length}銘柄の信用需給を確認`);
  const tenbaggerWatchlist = await scanTenbaggerWatchlist();

  // パターン③はコンセンサスを持つSBI銘柄でしか判定できない（上記コメント参照）。
  // Stage 1 は universe = tdNames ∪ sbiStocks を全走査済みなので techByCode に
  // 既に入っているはず。取得に失敗していた場合は techByCode[code] が無く、
  // 下のループで自然に除外される。
  for (const [code, s] of Object.entries(sbiStocks)) {
    if (Number.isFinite(s.estimateProfit) && Number.isFinite(s.consensusProfit) && techByCode[code]) {
      stage2Set.add(code);
    }
  }

  console.log(`🔬 スマート・エントリー Stage 2: 週次信用残・決算を確認 (${stage2Set.size}銘柄 × 2リクエスト、該当銘柄のみ底打ち確認+2リクエスト)`);
  // 貸借対照表項目（売掛金・現金及び預金・自己資本・総資産）はEDINETから
  // 取得する（AMBUSHと同じハイブリッド方針）。EDINETは銘柄単体の検索APIが
  // 無く日付ごとの全件走査しか無いため、Stage2候補全体分をここで1回だけ
  // 走査してメタデータのインデックスを作る（実際のZIP取得・パースは
  // matched>0で実際に表示する銘柄だけに絞って下のループ内で行う）。
  let edinetIndex = new Map();
  try {
    edinetIndex = await buildDocumentIndex([...stage2Set]);
  } catch (e) {
    console.error(`  ⚠️ EDINET書類一覧の一括取得に失敗: ${e.message}`);
  }
  const results = [];
  const inflectionCandidates = [];
  let s2err = 0, s2excluded = 0;
  for (const code of stage2Set) {
    const tech = techByCode[code];
    if (!tech) continue;
    let weekly = [], fin = {};
    try {
      weekly = await fetchWeeklyCredit(code);
      await sleep(REQ_GAP);
      fin = await fetchFinance(code);
    } catch {
      s2err++;
    }

    // 赤字・債務超過はSMART ENTRY本パターン（sig1/2/3）候補には従来通り
    // 使わない（需給の値幅取りが前提のパターンに赤字銘柄はそぐわない）。
    // ただしユーザー指摘（2026-09-12）: 以前はここで即continueしていた
    // ため、下のテンバガー/INFLECTION候補の判定にすら赤字・債務超過銘柄が
    // 一切到達できず、「赤字から黒字になる瞬間が一番株価が跳ねる」ケース
    // （実例: シマダヤ）を機械的に拾えなかった。continueはやめ、
    // 「SMART ENTRY本体のresults.pushだけfexcl.excludedでガードする」形に
    // 変更する（下記）。テンバガー/INFLECTIONは赤字・債務超過どちらも
    // 許容（ユーザー承認済み）。
    const fexcl = fundamentalExclusion({ latestOpProfit: fin.latestOpProfit, equityRatio: fin.equityRatio });
    if (fexcl.excluded) s2excluded++;

    const creditTrendPct = creditTrend(weekly);
    const creditLevelPct = creditLevelVsRange(weekly);
    const loanRatio = weekly[0]?.loanRatio ?? null;
    const s = sbiStocks[code] ?? {};

    const sig1 = reboundPatternSignal({ kairi: tech.kairi, rsi: tech.rsi, creditTrendPct });
    const sig2 = trendReversalPatternSignal({ cross: tech.cross, volRatio: tech.volRatio, loanRatio });
    const sig3 = laggingPatternSignal({
      creditLevelPct, estimateProfit: s.estimateProfit ?? null, consensusProfit: s.consensusProfit ?? null, kairi: tech.kairi,
    });

    const matched = [sig1.level === 'good', sig2.level === 'good', sig3.level === 'good'].filter(Boolean).length;

    // 「業績屈折(SECTION D)」候補のキラー指標3つ（ユーザー提案
    // 2026-09-12の新スペック）。fin.checkpointTrend/nextMilestoneは
    // kabutan.mjsのfetchFinance()で既に取得済みのため追加リクエスト
    // 無しで計算できる。①コア・スクリーニング条件（PER/PBR/ROE等）は
    // main/bs（このブロックの中で初めて取得する、割高な追加リクエスト）
    // が要るため、まずこの無料のキラー指標だけで「割高な追加リクエスト
    // を掛ける価値があるか」を先に絞り込む。
    const ct = fin.checkpointTrend;
    const spread = ct ? inflectionSpreadSignal({
      revenueYoyPct: ct.revenue.pct, revenueYoyState: ct.revenue.state,
      ordinaryProfitYoyPct: ct.ordinaryProfit.pct, ordinaryProfitYoyState: ct.ordinaryProfit.state,
    }) : { level: null, value: null, checked: false };
    const progressSurprise = ct ? inflectionProgressSurpriseSignal({
      progressPct: ct.progressPct, priorProgressPcts: ct.priorProgressPcts,
    }) : { level: null, value: null, checked: false };
    const hurdleRatio = (ct && fin.nextMilestone) ? inflectionHurdleRatioSignal({
      checkpointOrdinaryProfitActual: ct.ordinaryProfit.actual,
      nextMilestoneForecastOrdinaryProfit: fin.nextMilestone.forecastOrdinaryProfit,
      priorCheckpointOrdinaryProfitActuals: ct.priorOrdinaryProfitActuals,
      priorMilestoneOrdinaryProfitActuals: fin.nextMilestone.priorOrdinaryProfitActuals,
    }) : { level: null, value: null, checked: false };
    const killerHits = [spread, progressSurprise, hurdleRatio].filter((s) => s.passed).length;
    // 黒字転換（実額を伴わない状態のためキラー指標のスプレッド計算には
    // 乗らないが、ユーザーが最も重視する状態なので単独でも仮候補入りの
    // 条件にする）。
    const turnsProfitable = ct?.ordinaryProfit.state === 'turned_profitable';
    // 「下方修正リスク（未達のワナ）」のハード除外（ユーザー指摘
    // 2026-09-13）。killerHits等のスコアリングとは別に、1件でも該当
    // したら他がどれだけ良くても除外する（実測: バロックジャパンが
    // 1Q-84.9%→通期予想+321.2%という「絵に描いた餅」を最上位候補に
    // していた再発防止）。
    const downsideRisk = ct ? inflectionDownsideRiskSignal({
      progressPct: ct.progressPct, priorProgressPcts: ct.priorProgressPcts,
    }) : { level: null, checked: false };
    const isPreInflectionCandidate = (killerHits >= 1 || turnsProfitable) && downsideRisk.level !== 'bad';

    if (matched > 0 || isPreInflectionCandidate) {
      // 底打ち確認（＋α）は実際に表示する該当銘柄だけに絞って追加取得する
      // （Stage2候補全体ではなく matched>0 の銘柄のみ＝数件〜十数件程度）。
      let main = {}, ivFresh = null;
      try {
        await sleep(REQ_GAP);
        main = await fetchMain(code);
        await sleep(REQ_GAP);
        ivFresh = await fetchIntradayExtended(code);
      } catch { /* 底打ち確認が無くても表示は続ける（N/Aのまま） */ }

      // ネットネット判定・売掛金異常増加チェックの貸借対照表はEDINETから
      // 補う（法定開示のため失敗しても現金のみの簡易版にフォールバック
      // する）。ZIP取得・パースはmatched>0の該当銘柄だけに絞って行う
      // （日付一覧の走査自体は上でstage2Set全体分を先に済ませている）。
      let bs = {};
      try {
        await sleep(REQ_GAP);
        bs = await fetchBalanceSheetSnapshot(edinetIndex.get(code));
      } catch { /* 簡易版にフォールバック */ }

      const climax = sellingClimaxSignal(ivFresh ?? {});
      const netNet = netNetSignal({ cash: bs.cash, totalAssets: bs.totalAssets, equity: bs.equity, marketCap: main.marketCap, receivables: bs.receivables });
      const receivablesAnomaly = receivablesAnomalySignal({
        revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
        receivablesGrowthPct: bs.receivablesGrowthPct ?? null,
        operatingCfGrowthPct: bs.operatingCfGrowthPct ?? null,
        advancesReceivedGrowthPct: bs.advancesReceivedGrowthPct ?? null,
        inventoryGrowthPct: bs.inventoryGrowthPct ?? null,
      });
      const divFloor = dividendYieldFloorSignal(main.dividendYield);

      // 過去の配当利回りレンジ・PBRレンジ（IR Bank）。コンセンサスが
      // 無い銘柄の「代用物差し」および増配トレンド（お宝候補判定）用。
      let dividendHistory = {}, pbrHistory = {};
      try {
        await sleep(REQ_GAP);
        dividendHistory = await fetchDividendYieldHistory(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      try {
        await sleep(REQ_GAP);
        pbrHistory = await fetchPbrHistory(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      const dividendPeak = dividendYieldPeakSignal({
        currentYield: main.dividendYield, maxYield: dividendHistory.maxYield, maxPeriod: dividendHistory.maxPeriod,
      });
      const pbrHistoricalLow = pbrHistoricalLowSignal({
        currentPbr: main.pbr, minPbr: pbrHistory.minPbr, minPeriod: pbrHistory.minPeriod,
      });

      let institutionalShortInfo = {};
      try {
        await sleep(REQ_GAP);
        institutionalShortInfo = await fetchInstitutionalShortInterest(code);
      } catch { /* 未取得のまま（機関投資家の空売り開示が無い/取得失敗） */ }
      const institutionalShort = institutionalShortSignal(institutionalShortInfo);
      // A指示 項目18: 踏み上げ判定を機関投資家の空売り縮小・出来高急増
      // でも裏付ける（複数一致時のみ高評価にする）。下のretailExpectation
      // と同じivFresh.volumesから計算するため追加リクエスト無し。
      const squeezeVolRatio = volumeRatio(ivFresh?.volumes);
      const squeeze = shortSqueezeSignal(weekly, { institutionalShort, volRatio: squeezeVolRatio });
      let shareholderInfo = {};
      try {
        await sleep(REQ_GAP);
        shareholderInfo = await fetchMajorShareholderTrend(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      const majorShareholder = majorShareholderSignal(shareholderInfo);
      const sec = main.sectorName ? sectors[main.sectorName] : null;
      const lowPbr = lowPbrSignal({ pbr: main.pbr, sectorPbr: sec?.pbr });
      const hiddenGem = hiddenGemSignal({
        consensusProfit: s.consensusProfit, netNet, lowPbr,
        dividendStreakYears: dividendHistory.streakYears, dividendStreakDirection: dividendHistory.streakDirection,
      });
      const sectorLag = sectorMomentumSignal(tech.changePct, sec?.changePct ?? null);
      const sectorRotation = sectorRotationSignal({
        sectorTrendPct: sectorTrendPct(sectorHistory, main.sectorName, today, SECTOR_ROTATION.trendDays),
        kairi: tech.kairi,
        cross: tech.cross,
      });
      // 該当パターンが要求する信用倍率としてではなく、一般的な注意喚起
      // として（該当パターンに関係なく）出す。
      const marginOverhang = marginOverhangSignal(loanRatio);
      // 第7優先改修: 「信用買い残が減っている＝買い需要が強い」を自動
      // 判定しない（indicators.mjsのbuyingDemandSignal参照。新規リクエスト無し）。
      const buyingDemand = buyingDemandSignal({ creditTrendPct, changePct: tech.changePct, volRatio: squeezeVolRatio });
      // SMART ENTRYは決算スケジュールを見ずに選ぶが、「決算直前の新規
      // エントリーは避ける」のは需給とは独立した地雷回避ルールなので、
      // 該当パターンの判定とは別枠で警告する（除外はしない）。
      const earningsDaysLeft = daysUntil(s.earningsDate ?? s.earningsDateApprox, today);
      const earningsWarning = earningsProximitySignal(earningsDaysLeft);
      // 個人投資家による期待の織り込み（軸E）。screener.mjs(AMBUSH)と
      // 同じ考え方。ivFresh/weeklyはselling climax/信用トレンド用に
      // 既に取得済みのため、追加のリクエストは発生しない。
      // volRatioはtech.volRatio（Stage1の非拡張取得）ではなくivFresh
      // （拡張取得）由来にする。return1w/return1m/priceLevelPctと同じ
      // 取得タイミングのデータに揃えないと、株価側の指標だけ違う時点の
      // スナップショットを混ぜて判定することになるため（screener.mjsの
      // ambushConviction側は最初からivFreshで統一している）。
      const retailExpectation = retailExpectationSignal({
        return1w: returnPct(ivFresh?.closes, 5),
        return1m: returnPct(ivFresh?.closes, 20),
        priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
        volRatio: squeezeVolRatio,
        creditTrendPct, creditWeek1Pct: creditTrend(weekly, 1),
        daysToEarnings: earningsDaysLeft,
      });

      // v7.4改修（ユーザー要望「仕込み度と成長性を完全分離する」）:
      // finはこの関数の冒頭（matched>0の判定より前）で既にfetchFinance済み
      // のため、売上・利益成長率は追加リクエスト無しで取得できる（これまで
      // BUY/EXPECTATION/SURPRISEスコアをSMART ENTRYに導入しなかったのは
      // 「元データが無い」という判断だったが、実際には「取得済みだが
      // 露出していなかっただけ」だった）。同じ理由でrepricingLagScore
      // （仕込み度＝未織り込み度）も計算できる。TDnetは見ないスキャン
      // のためhasCatalyst:false、決算日非依存スキャンのためdaysToEarnings:
      // nullは、成長株予兆スキャン（同ファイル内の別関数）と同じ扱い。
      const revenueGrowthPct = fin.revenueGrowth?.growthPct ?? null;
      const profitGrowthPct = latestProfitYoyPct(fin.progressHistory);
      const progressStreak = progressStreakSignal(fin.progressHistory);
      // v7.5改修（ユーザー提案「成長率だけでなく成長の加速を見る」「テーマ
      // タグ自動付与」）: どちらも成長株予兆スキャン（同ファイル内の別
      // 関数）で既に使っている関数・データの再利用で、追加リクエストは
      // 発生しない（growthAccelerationSignalはfin.revenueGrowthに含まれる
      // prevGrowthPctを使うだけ、themeMatchSignalはスキャン全体で1回だけ
      // 取得済みのthemeCodeMapを参照するだけ）。
      // A指示 項目7「成長加速を独立スコア化する」: bsは上で既にEDINETから
      // 取得済みのため追加リクエスト無し。
      // 第6優先改修■3（ユーザー報告）: MARGINトレンド専用フィールド。
      const grossMarginImproving = marginImproving(bs.grossProfit, bs.netSales, bs.grossProfitPrior, bs.netSalesPrior);
      const opMarginImproving = marginImproving(bs.operatingIncome, bs.netSales, bs.operatingIncomePrior, bs.netSalesPrior);
      const growthAcceleration = growthAccelerationSignal({
        growthPct: revenueGrowthPct, prevGrowthPct: fin.revenueGrowth?.prevGrowthPct ?? null,
        grossMarginImproving, opMarginImproving,
      });
      const themeMatch = themeMatchSignal({ matchedThemes: themeCodeMap.get(code) ?? [] });
      // A指示 項目8「異常成長のベース効果・一時要因を確認する」。bsは
      // 上で既にEDINETから取得済みのため追加リクエスト無し。
      const growthAnomalyCaution = growthAnomalyCautionSignal({
        revenueGrowthPct, profitGrowthPct,
        operatingIncomePrior: bs.operatingIncomePrior, netSalesPrior: bs.netSalesPrior,
        extraordinaryIncome: bs.extraordinaryIncome, extraordinaryLoss: bs.extraordinaryLoss, impairmentLoss: bs.impairmentLoss,
        extraordinaryIncomePrior: bs.extraordinaryIncomePrior, extraordinaryLossPrior: bs.extraordinaryLossPrior, impairmentLossPrior: bs.impairmentLossPrior,
      });
      // 第6優先改修（ユーザー報告）: 「利益成長率が高い」だけでは営業
      // キャッシュ・フローが伴っているかまでは分からない。bsは上で既に
      // EDINETから取得済み（receivablesAnomalySignal向けのoperatingCf*と
      // 同じ入力元）のため追加リクエスト無し。
      const earningsCashFlowQuality = earningsCashFlowQualitySignal({
        profitGrowthPct, operatingCf: bs.operatingCf, operatingCfPrior: bs.operatingCfPrior, operatingCfGrowthPct: bs.operatingCfGrowthPct,
        capex: bs.capex, capexPrior: bs.capexPrior,
      });
      const psrForRepricing = Number.isFinite(fin.revenueGrowth?.latestSales) && fin.revenueGrowth.latestSales > 0 && Number.isFinite(main.marketCap)
        ? main.marketCap / fin.revenueGrowth.latestSales
        : null;
      const repricingLagInputs = {
        return1m: returnPct(ivFresh?.closes, 20),
        return3m: returnPct(ivFresh?.closes, 60),
        // Repricing Gap v2用（indicators.mjsのコメント参照）。
        sectorReturn1m: sectorTrendPct(sectorHistory, main.sectorName, today, 20),
        priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
        revenueGrowthPct, profitGrowthPct,
        per: main.per ?? null, sectorPer: sec?.per ?? null, psr: psrForRepricing,
        hasCatalyst: false, daysToEarnings: null,
        progressStreak,
      };
      const repricingLag = { ...repricingLagScore(repricingLagInputs), ...repricingLagInputs, repricingGap: repricingGapScore(repricingLagInputs) };
      // hasCatalyst代用: このループはTDnetを見ないスキャンのため、
      // 上のtenbaggerHit分岐(line ~347)と同じ考え方で、既に計算済みの
      // カタリスト予兆シグナル（progressStreak）で代用する（追加コスト無し）。
      const diamond = diamondSignal({
        themeMatch, marketCap: main.marketCap, maxMarketCap: MID_CAP_MAX_MARKET_CAP_JPY,
        revenueGrowthPct, repricingLagZone: repricingLag.zone, unitLabel: '百万円',
        growthAcceleration, cash: bs.cash, interestBearingDebt: bs.interestBearingDebt,
        hasCatalyst: progressStreak?.level === 'good',
      });

      // SMART ENTRY本体（sig1/2/3のパターン一致）は従来通り赤字・債務超過
      // を除外する。matched>0でもfexcl.excludedなら本体リストには載せない
      // （下のINFLECTION候補には別途、fexclを無視して載る）。
      if (matched > 0 && !fexcl.excluded) {
        results.push({
          code,
          name: universe[code] ?? code,
          price: tech.price,
          changePct: tech.changePct,
          closes: tech.closes.slice(-20),
          kairi: tech.kairi,
          rsi: tech.rsi,
          cross: tech.cross,
          volRatio: tech.volRatio,
          market: tech.market ?? null,
          loanRatio,
          creditTrendPct,
          creditLevelPct,
          estimateProfit: s.estimateProfit ?? null,
          consensusProfit: s.consensusProfit ?? null,
          sectorName: main.sectorName ?? null,
          sectorChangePct: sec?.changePct ?? null,
          dividendYield: main.dividendYield ?? null,
          // 同業他社比較(peerComparisonBlock)・バリュエーション上限目安
          // (ceilingPriceNote)用。screener.mjs(AMBUSH)側では元々渡していたが、
          // smart_entry.mjs(SMART ENTRY)側は渡しておらず、SMART ENTRYの
          // カードには同業他社比較ブロック自体が一度も表示されていなかった
          // （実測: 9052等SMART ENTRY全カードでpeerbox 0件）。
          pbr: main.pbr ?? null,
          sectorPbr: sec?.pbr ?? null,
          per: main.per ?? null,
          sectorPer: sec?.per ?? null,
          sectorDividendYield: sec?.dividendYield ?? null,
          marketCap: main.marketCap ?? null,
          roe: fin.latestRoe ?? null,
          balanceSheetSource: bs.docID ? 'edinet' : null,
          balanceSheetAsOf: bs.periodEnd ?? null,
          // v7.4改修（ユーザー要望「仕込み度と成長性を完全分離する」）:
          // scraper.mjs側のattachScores（buildScoreParts/expectationScore/
          // repricingLagBlock）が参照する。
          revenueGrowthPct, profitGrowthPct, progressStreak, repricingLag, growthAcceleration, themeMatch, diamond,
          growthAnomalyCaution, earningsCashFlowQuality, grossMarginImproving, opMarginImproving,
          climax, netNet, lowPbr, pbrHistoricalLow, dividendPeak, hiddenGem, divFloor, squeeze, institutionalShort,
          institutionalShortPct: institutionalShortInfo.totalPct ?? null,
          majorShareholder,
          majorShareholderTop1Pct: shareholderInfo.top1Pct ?? null,
          dividendMaxYield: dividendHistory.maxYield ?? null,
          dividendMaxPeriod: dividendHistory.maxPeriod ?? null,
          dividendStreakYears: dividendHistory.streakYears ?? 0,
          dividendStreakDirection: dividendHistory.streakDirection ?? null,
          pbrMin: pbrHistory.minPbr ?? null,
          pbrMinPeriod: pbrHistory.minPeriod ?? null,
          sectorLag, sectorRotation, marginOverhang, buyingDemand,
          earningsDaysLeft, earningsWarning, receivablesAnomaly, retailExpectation,
          matched,
          sig1, sig2, sig3,
        });
      }

      // 「業績屈折(SECTION D)」候補（ユーザー提案2026-09-12の新スペック）。
      // 赤字・債務超過も明示的に許容する（ユーザー承認済み。「赤字から
      // 黒字になる瞬間が一番株価が跳ねる」ため）。①コア・スクリーニング
      // 条件はmain/bsが必要なため、事前絞り込み（isPreInflectionCandidate）
      // を通過した銘柄だけでここまで来てから計算する（無料のfin単独の
      // 判定を先に済ませているため、割高な財務レンジ判定を無駄打ちしない）。
      if (isPreInflectionCandidate) {
        const ebitda = evEbitda({
          marketCap: main.marketCap, interestBearingDebt: bs.interestBearingDebt,
          cash: bs.cash, operatingProfit: bs.operatingIncome, dAndA: bs.dAndA,
        });
        const coreScreening = coreScreeningSignal({
          per: main.per, pbr: main.pbr, dividendYield: main.dividendYield,
          roeHistory: fin.roeHistory, equityRatio: fin.equityRatio, debtEquityRatio: fin.debtEquityRatio,
          evEbitda: ebitda.ratio,
        });
        const inflectionCause = inflectionCauseSignal({
          netSales: bs.netSales, netSalesPrior: bs.netSalesPrior,
          grossProfit: bs.grossProfit, grossProfitPrior: bs.grossProfitPrior,
          sgaGrowthPct: bs.sgaGrowthPct,
          operatingIncome: bs.operatingIncome, operatingIncomePrior: bs.operatingIncomePrior,
          extraordinaryLoss: bs.extraordinaryLoss, impairmentLoss: bs.impairmentLoss,
        });
        // ユーザー指摘（2026-09-13）「なぜ悪かったか分からない銘柄が
        // 業績屈折として抽出されているのは、単にギャップが大きいだけで
        // 無理やり引っ張ってきている証拠」への対応。原因が機械的に
        // 特定できない銘柄は候補から外す（黒字転換=turnsProfitableは
        // inflectionCauseSignal自体が「減益の説明」用のため対象外＝
        // 常にchecked:falseになる。これは正常な「原因不明」ではなく
        // 「そもそも聞く意味が無い質問」なので除外条件には含めない）。
        const hasConcreteCause = turnsProfitable || inflectionCause.causes.length > 0;
        if (isInflectionEligible({ coreScreening, killerHits, hasConcreteCause })) {
          const countermeasure = turnaroundCountermeasureSignal(tdByCode[code] ?? []);
          // 「屈折」の2パターン分類（ユーザー提案2026-09-13）。除外は
          // せず、V字回復型／上方修正本命型のどちらのストーリーに
          // 当てはまるかをバッジで示す（indicators.mjs参照）。
          const patternType = inflectionPatternType({
            ordinaryProfitYoyState: ct.ordinaryProfit.state, ordinaryProfitYoyPct: ct.ordinaryProfit.pct,
            hurdleRatioValue: hurdleRatio.value,
          });
          inflectionCandidates.push({
            code, name: universe[code] ?? code,
            price: tech.price, changePct: tech.changePct, closes: tech.closes.slice(-20),
            market: tech.market ?? null, marketCap: main.marketCap ?? null,
            per: main.per, pbr: main.pbr, dividendYield: main.dividendYield,
            checkpointTrend: ct, nextMilestone: fin.nextMilestone,
            spread, progressSurprise, hurdleRatio, downsideRisk, killerHits, turnsProfitable, patternType,
            coreScreening,
            inflectionCause, countermeasure, fundamentalRisk: fexcl,
            revenueGrowthPct, repricingLag, themeMatch,
          });
        }
      }
    }
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 2 完了（取得失敗 ${s2err} / SMART ENTRY本体から赤字・債務超過除外 ${s2excluded}） / 該当 ${results.length}銘柄 / 業績屈折(INFLECTION)候補 ${inflectionCandidates.length}銘柄`);

  // 順位付けは該当パターン数を主軸にしつつ、乖離の深さ「だけ」で
  // 決めていた（実測: 信用倍率39倍で買い方が積み上がった銘柄が、
  // 単に乖離が深いという理由だけで1位になっていた）。smartEntryConviction
  // （底打ち確認の追加根拠・警告・部分該当も加味した総合スコア）で並べ、
  // 乖離はそれでも並んだ場合の最終判定に回す。
  results.sort((a, b) => smartEntryConviction(b) - smartEntryConviction(a) || (a.kairi ?? 999) - (b.kairi ?? 999));
  const shown = results.slice(0, limit);
  const dropped = results.length - shown.length;
  if (dropped > 0) console.log(`   ⚠️ 表示上限${limit}件のため ${dropped}銘柄を切り捨て（該当は${results.length}件）`);

  // 黒字転換(turnsProfitable)を最優先、次にキラー指標3つの該当数
  // （ユーザーの「この5つが揃う銘柄を最優先候補にします」に対応。
  // 実装できた3つが全部揃った銘柄が最上位に来る）、同数ならスプレッド
  // （売上-利益ギャップ）が大きい順。
  inflectionCandidates.sort((a, b) => {
    if (a.turnsProfitable !== b.turnsProfitable) return a.turnsProfitable ? -1 : 1;
    if (a.killerHits !== b.killerHits) return b.killerHits - a.killerHits;
    const spreadA = a.spread?.value ?? -Infinity;
    const spreadB = b.spread?.value ?? -Infinity;
    return spreadB - spreadA;
  });

  const out = {
    date: today,
    universe: codes.length,
    stage2: stage2Set.size,
    matched: results.length,
    dropped,
    results: shown,
    growthPrecursors,
    tenbaggerCandidatesA,
    tenbaggerCandidatesB,
    tenbaggerWatchlist,
    inflectionCandidates,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
