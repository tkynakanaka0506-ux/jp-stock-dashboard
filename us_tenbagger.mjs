// ==================================================================
// us_tenbagger.mjs — 米国株テンバガー候補（決算日非依存、ユーザー提案）
//
//  us_screener.mjs（米国株AMBUSH）とは完全に分離する。AMBUSHは「決算前
//  の待ち伏せ」ロジックなので決算T+14〜45日のユニバースで正しいが、
//  テンバガー探索は決算時期に関係なく「現在の株価・業績・テーマから
//  将来の大幅成長余地があるか」を見るべきもの。
//
//  ■ 実データで発覚した旧設計の欠陥
//  以前はテンバガー候補の米国株をus_screener.mjs（AMBUSHユニバース）
//  から流用していたため、次回決算が窓の外にある銘柄が機械的に除外
//  されていた（実測: IONQは決算カレンダー取得範囲60日以内に無く
//  ユニバース外、Aurora Innovation/AURは決算が58日後でAMBUSHの窓
//  (T+45日)を超えるため除外）。
//
//  ■ ユニバースの作り方（キュレーションリスト方式、ユーザー承認済み）
//  無料で米国株全銘柄（数千社）を毎日走査する手段が無い（Finnhubの
//  時価総額取得(/stock/profile2)は1銘柄1リクエストのため数千銘柄は
//  非現実的）。日本株のテーマ調査（tenbagger_research_log.md）と同じ
//  「手動リサーチで対象を絞り込む」手法をコードに落とし込み、
//  US_TENBAGGER_WATCHLISTに追記していく運用にする（自動発見はしない）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailyBars } from './us_yahoo.mjs';
import { loadTickerCikMap, fetchCompanyFacts, extractQuarterlyTrend } from './us_edgar.mjs';
import { fetchProfile, loadUsEarningsCalendar } from './us_finnhub.mjs';
import {
  returnPct, priceLevelVsRange, usEarningsTrendSignal, usTaxEffectCautionSignal, volumeRatio,
  tenbaggerSignal, midCapGrowthSignal, repricingLagScore, repricingGapScore, marketCapYen,
  growthAccelerationSignal, breakoutVolumeSignal, aggressiveInvestmentSignal, themeMatchSignal,
  tenbaggerRealizabilityScore, growthPotentialScore,
} from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'us_tenbagger_cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_GAP = 250;

// smart_entry.mjsのTENBAGGER_MAX_MARKET_CAP_JPY（300億円）と同じ考え方の
// Tier A（低時価総額）上限。
export const US_TENBAGGER_MAX_MARKET_CAP_USD = 1_000; // 百万USD（$1B）

// Tier B（2〜5倍候補）の上限。実データで発覚した問題（AUR時価総額$118億
// は10倍に$1180億必要でUber・Intel級の非現実的な目標、IONQ$158億も同様）
// を受け、上限を新設して「テンバガーは無理だが規模なりの成長余地は
// 狙えるグロース中堅株」に再定義した（indicators.mjsのmidCapGrowthSignal
// 参照）。
export const US_TIER_B_MAX_MARKET_CAP_USD = 10_000; // 百万USD（$10B）

// A指示 項目13「米国テンバガーTierを3段階にする」: 当初はTier Bの上限を
// 単純に$20Bへ引き上げてIONQ($158億)・AUR($118億)を救済していたが
// （v7.4）、指示書は「Tier B（$1B〜$10B・2〜5倍候補）」「Tier C（$10B〜
// $20B程度・大型化後の超成長株、2〜3倍を狙える）」を明確に別枠と定義
// している。IONQ・AURのような「既に大型化しているが高成長が続けば
// さらに2〜3倍を狙える」企業を、Tier Bの中堅株と同格に扱わず、独立した
// Tier Cとして監視できるようにする。
export const US_TIER_C_MAX_MARKET_CAP_USD = 20_000; // 百万USD（$20B）

// 決算日に依存しない手動キュレーションリスト。今後のテーマ調査で追記
// していく（tenbagger_research_log.mdと同じ運用）。
export const US_TENBAGGER_WATCHLIST = [
  { code: 'IONQ', theme: '量子コンピュータ' },
  { code: 'AUR', theme: '自動運転（トラック）' },
];

// us_screener.mjsで実測されたREXR（REIT）のEDGAR売上高タグ不整合バグ
// と同じガード。PSRが非現実的な水準になった場合はデータ不整合として
// null扱いにする。
const MAX_PLAUSIBLE_PSR = 500;

export async function runUsTenbaggerScreen({ today, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 米国株テンバガー候補キャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  // AMBUSHと同じキャッシュを再利用（追加リクエスト無し）。イベント軸
  // （daysToEarnings）の補助情報としてのみ使う。決算日でユニバースを
  // 絞り込むことはしない。
  const calendar = await loadUsEarningsCalendar({ today, horizonDays: 60, force: false });
  const cikMap = await loadTickerCikMap();

  console.log(`🚀 米国株テンバガー候補: ウォッチリスト${US_TENBAGGER_WATCHLIST.length}銘柄をスキャン`);
  const results = [];
  let err = 0;
  for (const w of US_TENBAGGER_WATCHLIST) {
    try {
      await sleep(REQ_GAP);
      const bars = await fetchDailyBars(w.code);
      await sleep(REQ_GAP);
      const profile = await fetchProfile(w.code);

      let trend = [];
      const cik = cikMap[w.code];
      if (cik) {
        await sleep(REQ_GAP);
        const facts = await fetchCompanyFacts(cik);
        trend = extractQuarterlyTrend(facts);
      }
      const earningsTrend = usEarningsTrendSignal(trend, today);
      // 第6優先改修②（ユーザー報告「税効果」）。新規リクエスト無し。
      const taxEffectCaution = usTaxEffectCautionSignal({
        netIncomeGrowthPct: earningsTrend.netIncomeGrowthPct, pretaxIncomeGrowthPct: earningsTrend.pretaxIncomeGrowthPct,
      });

      const marketCap = profile.marketCap ?? null;
      const revenueGrowthPct = earningsTrend.revenueGrowthPct ?? null;
      const withinTierACap = Number.isFinite(marketCap) && marketCap <= US_TENBAGGER_MAX_MARKET_CAP_USD;
      const withinTierBCap = Number.isFinite(marketCap) && marketCap <= US_TIER_B_MAX_MARKET_CAP_USD;
      const tenbaggerA = withinTierACap
        ? tenbaggerSignal({ marketCap, maxMarketCap: US_TENBAGGER_MAX_MARKET_CAP_USD, revenueGrowthPct, unitLabel: '百万USD' })
        : { level: null, label: null, note: null, checked: true };
      const tenbaggerB = !withinTierACap && withinTierBCap
        ? midCapGrowthSignal({
          marketCap, maxMarketCap: US_TIER_B_MAX_MARKET_CAP_USD, revenueGrowthPct, unitLabel: '百万USD',
          label: '中型成長株候補(Tier B)', multipleLabel: '2〜5倍',
        })
        : { level: null, label: null, note: null, checked: true };
      // A指示 項目13「Tier C（$10B〜$20B程度・大型化後の超成長株）」:
      // IONQ・AURのような「テンバガーは非現実的だが高成長が続けば2〜3倍
      // を狙える」大型成長株を、Tier Bの中堅株と別枠で監視する。
      const tenbaggerC = !withinTierACap && !withinTierBCap
        ? midCapGrowthSignal({
          marketCap, maxMarketCap: US_TIER_C_MAX_MARKET_CAP_USD, revenueGrowthPct, unitLabel: '百万USD',
          label: '大型超成長株(Tier C)', multipleLabel: '2〜3倍',
        })
        : { level: null, label: null, note: null, checked: true };
      const tier = tenbaggerA.level === 'good' ? 'A' : tenbaggerB.level === 'good' ? 'B' : tenbaggerC.level === 'good' ? 'C' : null;
      if (!tier) continue; // 成長率が閾値未満、またはTier Cの上限（$20B）超過。ウォッチリストに載せているだけでは候補にしない

      const ttmRevenue = trend.length >= 4
        ? trend.slice(-4).reduce((sum, e) => sum + (Number.isFinite(e.revenue) ? e.revenue : 0), 0)
        : null;
      const psrRaw = Number.isFinite(ttmRevenue) && ttmRevenue > 0 && Number.isFinite(marketCap)
        ? marketCapYen(marketCap) / ttmRevenue
        : null;
      const psr = Number.isFinite(psrRaw) && psrRaw <= MAX_PLAUSIBLE_PSR ? psrRaw : null;

      // 成長の「加速」（ユーザー提案）。earningsTrendは既に取得済みの
      // データなので追加リクエスト無し。
      const growthAcceleration = growthAccelerationSignal({
        growthPct: revenueGrowthPct, prevGrowthPct: earningsTrend.prevRevenueGrowthPct ?? null,
      });
      // 高値圏×出来高急増（順張りブレイクアウト、ユーザー提案）。
      // bars（fetchDailyBars, range:'6mo'）は既にvolumesを含むため
      // 追加リクエスト無し。floatSqueezeはFinnhub無料枠に浮動株比率相当の
      // データが無いためUS側は非対応（checked:false固定）。
      const breakoutVolume = breakoutVolumeSignal({
        priceLevelPct: priceLevelVsRange(bars.closes, 60),
        volumeRatio: volumeRatio(bars.volumes, 20),
      });
      // 攻めの投資（研究開発費が売上を上回る伸び、ユーザー提案）。
      // earningsTrendは既に取得済みのデータなので追加リクエスト無し。
      const aggressiveInvestment = aggressiveInvestmentSignal({
        rndGrowthPct: earningsTrend.rndGrowthPct ?? null, revenueGrowthPct,
      });
      // テーマ性マッチング（ユーザー提案）。US側は一元的なテーマページが
      // 無いため、ウォッチリストに手動で付けたthemeフィールドをそのまま
      // 根拠にする（実質、既存の手動キュレーションの延長）。
      const themeMatch = themeMatchSignal({ matchedThemes: w.theme ? [w.theme] : [] });

      // Phase 1の既知の限界（US側にTDnet相当の先行カタリスト検出は無い
      // ため常にfalse固定）。株価帯フィルターの「材料十分か」判定にも
      // 使うため、この制約下では$7超の候補は常に警告バッジが付く。
      const hasCatalyst = false;
      const repricingLagInputs = {
        return1m: returnPct(bars.closes, 20),
        return3m: returnPct(bars.closes, 60),
        priceLevelPct: priceLevelVsRange(bars.closes, 60),
        revenueGrowthPct, profitGrowthPct: earningsTrend.netIncomeGrowthPct ?? null,
        per: null, sectorPer: null, psr,
        hasCatalyst, // Phase 1の既知の限界（US側にTDnet相当の先行カタリスト検出は無い）
        daysToEarnings: (() => {
          const d = calendar?.stocks?.[w.code]?.earningsDate;
          if (!d) return null;
          return Math.round((new Date(`${d}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
        })(),
      };
      // A指示 項目3「Repricing Gap概念を実装」。repricingLagInputsに既に
      // 必要な値が揃っているため追加リクエスト無し。
      const repricingLag = { ...repricingLagScore(repricingLagInputs), repricingGap: repricingGapScore(repricingLagInputs) };

      // A指示 項目14/36: 「10倍実現可能性」「成長ポテンシャル」をJP側
      // （smart_entry.mjs）と同じ考え方で独立スコア化する。
      const tierMaxMarketCap = tier === 'A' ? US_TENBAGGER_MAX_MARKET_CAP_USD
        : tier === 'B' ? US_TIER_B_MAX_MARKET_CAP_USD
        : US_TIER_C_MAX_MARKET_CAP_USD;
      const realizability = tenbaggerRealizabilityScore({ marketCap, maxMarketCap: tierMaxMarketCap });
      const growthPotential = growthPotentialScore({ revenueGrowthPct, growthAcceleration });

      results.push({
        code: w.code, name: profile.name ?? w.code, theme: w.theme,
        industry: profile.industry ?? null, marketCap,
        price: bars.price, changePct: bars.changePct, closes: bars.closes.slice(-20),
        fiftyTwoWeekHigh: bars.fiftyTwoWeekHigh,
        tier, tenbagger: tier === 'A' ? tenbaggerA : tier === 'B' ? tenbaggerB : tenbaggerC,
        earningsTrend, taxEffectCaution, repricingLag, hasCatalyst,
        growthAcceleration, breakoutVolume, aggressiveInvestment, themeMatch,
        realizability, growthPotential,
        floatSqueeze: { level: null, label: null, note: null, checked: false }, // Phase 1の既知の限界: US側は非対応
      });
    } catch (e) {
      err++;
      console.error(`  ⚠️ ${w.code} 取得失敗: ${e.message}`);
    }
  }
  console.log(`   米国株テンバガー候補スキャン完了（取得失敗 ${err}） / 該当 ${results.length}銘柄`);

  const out = { date: today, universe: US_TENBAGGER_WATCHLIST.length, results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
