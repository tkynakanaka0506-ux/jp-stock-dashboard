// ==================================================================
// us_screener.mjs — 米国株版AMBUSH（決算前カタリスト先読み、Phase 1）
//
//  screener.mjs（日本株AMBUSH）と同じ2段構成:
//   Stage 1 … Finnhub決算カレンダーでT+14〜45日の銘柄に絞り込み
//             （ここが「全米市場を毎日スキャンしなくて済む」理由）、
//             Yahoo Financeの日足で乖離率・RSI・出来高Zを算出。
//   Stage 2 … Stage1通過銘柄だけSEC EDGARで財務データを取得。
//
//  ■ Phase 1でのスコープ縮小（日本版との違い、計画時に確定済み）
//  - TDnet相当の「好材料開示・月次KPI」の先行カタリスト検出は無い
//    （米国に相当する一元的な適時開示検索サイトが無料で無いため）。
//    そのためevidence（先行カタリストの有無）によるランク制限は行わない。
//  - セクター/業種モメンタムは非対応（Phase 2で検討）。
//  - 期待値のワナ（consensusTrapSignal相当）は米国に「公式通期予想」の
//    開示制度が無いため非対応。代わりにusEarningsTrendSignal（四半期
//    実績の前年同期比トレンド）を使う。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailyBars } from './us_yahoo.mjs';
import { loadTickerCikMap, fetchCompanyFacts, extractBalanceSheetSnapshot, extractQuarterlyTrend } from './us_edgar.mjs';
import { computeLogicFingerprint, isCacheFresh } from './logic_fingerprint.mjs';
import { loadUsEarningsCalendar, fetchProfile } from './us_finnhub.mjs';
import {
  kairi, rsi, volumeZScore, stage1, unpricedScore, STAGE1,
  netNetSignal, receivablesAnomalySignal, usEarningsTrendSignal, usTaxEffectCautionSignal,
  returnPct, priceLevelVsRange, marketCapYen, repricingLagScore, repricingGapScore, marketCapExclusion,
} from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'us_ambush_cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_GAP = 250; // Yahoo/EDGARとも十分に余裕を持たせる

// AMBUSHのWINDOW（screener.mjs）と同じ考え方・v7.3改修（項目4/5、日本株側と
// 揃える）: 「決算まで7〜60日」を3段階（PRE/WATCH/NOW）に分ける。
export const US_WINDOW = { nowMin: 7, sweetMin: 14, nowMax: 30, watchMin: 31, watchMax: 45, preMin: 46, preMax: 60 };

// screener.mjsのAMBUSH_MAX_MARKET_CAP_JPY（1000億円）と同じ発想。
// テンバガーTier Bの米国側上限（$10B）と同水準を採用する。
export const US_AMBUSH_MAX_MARKET_CAP_USD = 10_000; // 百万USD（$10B）

// cheapExclusion（indicators.mjs）はJPY建ての閾値（300円・1億円/日）が
// ハードコードされているため米国株には転用できない。ドル建ての初期値
// として置いたもので、実運用データを見てから調整する前提の値。
const US_EXCLUDE = { minPrice: 5, minLiquidityUsd: 2_000_000, liquidityDays: 5 };

function usCheapExclusion({ price, closes, volumes }) {
  const reasons = [];
  if (!Number.isFinite(price)) reasons.push('株価N/A');
  else if (price < US_EXCLUDE.minPrice) reasons.push(`株価$${price} < $${US_EXCLUDE.minPrice}`);
  const n = US_EXCLUDE.liquidityDays;
  if (!closes || !volumes || closes.length < n || volumes.length < n) {
    reasons.push('流動性N/A');
  } else {
    const recentCloses = closes.slice(-n), recentVols = volumes.slice(-n);
    const avgUsd = recentCloses.reduce((sum, c, i) => sum + c * (recentVols[i] ?? 0), 0) / n;
    if (avgUsd < US_EXCLUDE.minLiquidityUsd) {
      reasons.push(`5日平均売買代金$${Math.round(avgUsd).toLocaleString()} < $${US_EXCLUDE.minLiquidityUsd.toLocaleString()}`);
    }
  }
  return { excluded: reasons.length > 0, reasons };
}

// 実データで発覚したバグ: REVENUE_TAGS（us_edgar.mjs）はASC606「顧客との
// 契約による収益」ベースのタグのため、銀行の受取利息（ASC606の対象外）を
// 一切捕捉できず、手数料収入等ごく一部だけを「売上高」として拾ってしまう
// （実測: GBCI・WAFDのPSRが66〜86倍という、500倍の上限ガードには
// 引っかからないが明らかに実態より高い水準になっていた。GBCIの受取利息は
// 四半期$365M相当ある一方、拾えていたのは手数料収入の$26.6Mのみだった）。
// REIT(Real Estate)・保険(Insurance)・Financial Servicesは実データで
// PSRが妥当な水準だったため対象外とし、直接確認できたBankingのみ
// TTM売上高・PSR計算から除外する。
export function supportsRevenueTags(industry) {
  return industry !== 'Banking';
}

function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d1 = new Date(`${today}T00:00:00Z`), d2 = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((d2 - d1) / 86400000);
}

// screener.mjsのAMBUSH_BONUS_FIELDS/AMBUSH_PENALTY_FIELDSと同じ「単一の
// 情報源」パターン。米国版はPhase 1でシグナル数が少ないため2つの配列に
// 分けず、usScoreの計算式に直接持たせる（増えてきたらJP版と同じ配列化を
// 検討する）。
//
// ■ 実データで発覚したバグ: SCOREが何日も同じ値のまま動かない
// ALOYのSCOREが2026-08-30〜09-02の4日間、価格($10.40→$9.98)・RSI(49→
// 43.2)・出来高Z(-1.94→-0.5)・仕込みゾーン(priced_in→pre_move)が
// 全て変化しているにもかかわらず、一貫して70のまま固定されていた。
// 原因はnetNet/earningsTrendがSEC EDGARの四半期実績（四半期に1回しか
// 更新されない）のみに依存し、receivablesAnomalyはPhase 1で常に
// checked:false（実質無効）だったため。screener.mjs（日本株）は
// technical: unpricedScore(kairi) を base scoreに含めている
// （MAX_WEIGHT.technical=10）のに対し、us_screener.mjsはunpricedScoreを
// importしていながらusScoreの計算式に一度も渡していなかった
// （「importしたが配線を忘れた」、ALOYのrepricingLag→ambushVerdict
// 配線漏れと同型のバグ）。乖離率（kairi）による技術点を加点し、
// 日々の値動きがSCORE・ひいては順位に反映されるようにする。
export function usScore({ netNet, receivablesAnomaly, earningsTrend, kairi }) {
  let score = 50;
  if (netNet?.level === 'good') score += 15;
  if (earningsTrend?.level === 'good') score += 20;
  if (earningsTrend?.level === 'bad') score -= 15;
  if (receivablesAnomaly?.level === 'bad') score -= 15;
  if (receivablesAnomaly?.level === 'warn') score -= 8;
  score += unpricedScore(kairi) ?? 0;
  return Math.max(0, Math.min(100, score));
}

export const usRankOf = (s) => (s >= 80 ? 'S' : s >= 70 ? 'A' : s >= 60 ? 'B' : s >= 50 ? 'C' : 'D');

export async function runUsScreen({ today, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  const logicFingerprint = computeLogicFingerprint();
  if (!force && isCacheFresh(cache, today, logicFingerprint)) {
    console.log(`💾 米国株AMBUSHキャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }
  if (!force && cache.date === today && cache.results && cache.logicFingerprint !== logicFingerprint) {
    console.log(`⚠️ 米国株AMBUSHキャッシュは当日分ですが判定ロジックが変更されているため再計算します (${today})`);
  }

  const calendar = await loadUsEarningsCalendar({ today, horizonDays: 60, force });
  if (calendar.degraded) {
    console.error('  ⚠️ 米国株AMBUSH: 決算カレンダーが取得できなかったためスキップします');
    return { date: today, universe: 0, results: [], degraded: true };
  }

  const universe = Object.values(calendar.stocks)
    .map((s) => ({ ...s, daysLeft: daysUntil(s.earningsDate, today) }))
    .filter((s) => s.daysLeft !== null && s.daysLeft >= US_WINDOW.nowMin && s.daysLeft <= US_WINDOW.preMax);
  console.log(`🎯 米国株AMBUSHユニバース: ${universe.length}銘柄（決算まで${US_WINDOW.nowMin}〜${US_WINDOW.preMax}日）`);
  if (!universe.length) {
    const out = { date: today, universe: 0, results: [], logicFingerprint };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
    return out;
  }

  // --- Stage 1: Yahoo Financeで日足を取得し、乖離率・RSI・出来高Zで足切り
  console.log(`🔍 Stage 1: テクニカル足切り (${universe.length}リクエスト)`);
  const survivors = [];
  let s1err = 0, s1excluded = 0;
  for (const s of universe) {
    try {
      const bars = await fetchDailyBars(s.code);
      const excl = usCheapExclusion(bars);
      if (excl.excluded) { s1excluded++; continue; }
      const tech = {
        price: bars.price, changePct: bars.changePct,
        kairi: kairi(bars.price, bars.closes), rsi: rsi(bars.closes), volZ: volumeZScore(bars.volumes),
        closes: bars.closes.slice(-20),
        // 仕込み妙味スコア（repricingLagScore）用。closesをslice(-20)する
        // 前の全期間データが必要なため、tech.closesとは別にここで計算して
        // 保持しておく（Stage2では日足を再取得しないため、ここで計算
        // しておかないと60営業日分のclosesが失われる）。
        return1m: returnPct(bars.closes, 20),
        return3m: returnPct(bars.closes, 60),
        priceLevelPct: priceLevelVsRange(bars.closes, 60),
      };
      if (stage1(tech).pass) survivors.push({ ...s, tech });
    } catch {
      s1err++;
    }
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 通過 ${survivors.length}/${universe.length}（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}）`);

  // --- Stage 2: SEC EDGARで財務データを取得
  console.log(`🔬 Stage 2: ファンダ照合 (${survivors.length}銘柄)`);
  const cikMap = await loadTickerCikMap();
  const results = [];
  let s2err = 0, s2excludedCap = 0;
  for (const s of survivors) {
    // marketCapはEDGARのfactsに入っていない（貸借対照表の項目ではない）
    // ためFinnhubのprofile2から補う（百万USD単位。indicators.mjsの
    // marketCapYen()はkabutanの「百万円」と同じ「100万単位→生単位」の
    // 変換をするだけで通貨に依存しないため、百万USD単位のまま渡せる）。
    // 時価総額の大型株除外（AMBUSH_MAX_MARKET_CAP_USD）判定にも使うため、
    // EDGAR取得より先にprofileを取得し、超過が確定した銘柄はEDGARの
    // リクエスト自体を無駄打ちしない（screener.mjsの大型株除外と同じ
    // 「除外確定なら後続リクエストを増やさない」方針）。
    let profile = {};
    try {
      await sleep(REQ_GAP);
      profile = await fetchProfile(s.code);
    } catch { /* marketCap無し→netNetはchecked:falseのまま */ }

    const mexcl = marketCapExclusion({ marketCap: profile.marketCap ?? null, maxMarketCap: US_AMBUSH_MAX_MARKET_CAP_USD });
    if (mexcl.excluded) { s2excludedCap++; continue; }

    const cik = cikMap[s.code];
    let bs = {}, trend = [];
    if (cik) {
      try {
        await sleep(REQ_GAP);
        const facts = await fetchCompanyFacts(cik);
        bs = extractBalanceSheetSnapshot(facts);
        trend = extractQuarterlyTrend(facts);
      } catch {
        s2err++;
      }
    }
    const netNet = netNetSignal({ cash: bs.cash, totalAssets: bs.totalAssets, equity: bs.equity, marketCap: profile.marketCap ?? null, receivables: bs.receivables });
    const earningsTrend = usEarningsTrendSignal(trend, today);
    // 第6優先改修②（ユーザー報告「税効果」）: netIncomeGrowthPct（税引後）
    // とpretaxIncomeGrowthPct（税引前、上のearningsTrendで同時に計算済み）
    // の乖離から、税効果の影響を検知する。新規リクエスト無し。
    const taxEffectCaution = usTaxEffectCautionSignal({
      netIncomeGrowthPct: earningsTrend.netIncomeGrowthPct, pretaxIncomeGrowthPct: earningsTrend.pretaxIncomeGrowthPct,
    });
    // 米国は売上債権の伸び率をEDGARの数値からYoYで計算できないため
    // （extractQuarterlyTrendは残高ではなく損益の系列）、Phase 1では
    // receivablesAnomalyはchecked:falseのまま据え置く（Phase 2で残高の
    // 前年同期比を追加する）。
    const receivablesAnomaly = receivablesAnomalySignal({ revenueGrowthPct: null, receivablesGrowthPct: null });

    // 仕込み妙味スコア（Repricing Lag、ユーザー提案）。日本株側と異なり
    // 米国はTDnet相当の先行材料検出＋セクター比較PERが無いためPhase 1の
    // 既知の限界としてhasCatalyst固定false・per/sectorPer固定nullで渡す
    // （PSRのみで株価割安度を判定する）。TTM売上高はtrend（四半期・古い
    // →新しい順）の直近4件を合算。trendの値はEDGARの生ドル単位、
    // profile.marketCapはFinnhubの百万USD単位なのでmarketCapYen()で
    // 単位を揃える（通貨に依存しない「100万単位→生単位」変換のため
    // USDにもそのまま使える）。
    // supportsRevenueTags参照。valuationスコアはpsr:nullとして扱われ、
    // 判定不能・0点になる（捏造した数値を出さない）。
    const skipRevenueTags = !supportsRevenueTags(profile.industry);
    const ttmRevenue = !skipRevenueTags && trend.length >= 4
      ? trend.slice(-4).reduce((sum, e) => sum + (Number.isFinite(e.revenue) ? e.revenue : 0), 0)
      : null;
    const psrRaw = Number.isFinite(ttmRevenue) && ttmRevenue > 0 && Number.isFinite(profile.marketCap)
      ? marketCapYen(profile.marketCap) / ttmRevenue
      : null;
    // ■ 実データで発覚したバグ: REITのXBRL売上高タグが実態と乖離する
    // ケース（REXR実測: revenueタグが四半期$118,000〜156,000という賃貸
    // 収益REITとしてあり得ない極小値。ASC842のリース収益はASC606の
    // 「顧客との契約」収益タグに含まれないため、extractQuarterlyTrendが
    // 拾う汎用タグでは本業の収益を捕捉できていないと考えられる）。結果
    // PSRが33029倍という明らかに非現実的な値になった。同業他社(PLD/FR/
    // SLG等)は4〜15倍程度と妥当なため、これはREXR個別のタグ不整合で
    // あり一般的なREIT特有の問題ではない。上位互換のvaluationスコアは
    // psr>6で一律0点のため実害はないが、カード表示にそのまま出すと
    // 「PSR33029倍」という捏造同然の数字が出てしまうため、現実的にあり
    // 得ない水準（500倍超）はnull（データ不整合で判定不能）として扱う。
    const MAX_PLAUSIBLE_PSR = 500;
    const psr = Number.isFinite(psrRaw) && psrRaw <= MAX_PLAUSIBLE_PSR ? psrRaw : null;
    const repricingLagInputs = {
      return1m: s.tech.return1m,
      return3m: s.tech.return3m,
      priceLevelPct: s.tech.priceLevelPct,
      revenueGrowthPct: earningsTrend.revenueGrowthPct ?? null,
      profitGrowthPct: earningsTrend.netIncomeGrowthPct ?? null,
      per: null,
      sectorPer: null,
      psr,
      hasCatalyst: false,
      daysToEarnings: s.daysLeft,
    };
    // screener.mjs（日本株）と同じ理由でscraper.mjsのナラティブ生成用に
    // 生値も同梱する。
    const repricingLag = { ...repricingLagScore(repricingLagInputs), ...repricingLagInputs, repricingGap: repricingGapScore(repricingLagInputs) };

    const score = usScore({ netNet, receivablesAnomaly, earningsTrend, kairi: s.tech.kairi });
    results.push({
      code: s.code,
      name: profile.name ?? s.code,
      industry: profile.industry ?? null,
      marketCap: profile.marketCap ?? null,
      earningsDate: s.earningsDate,
      daysLeft: s.daysLeft,
      consensusEpsEstimate: s.consensusEpsEstimate,
      consensusRevenueEstimate: s.consensusRevenueEstimate,
      price: s.tech.price,
      changePct: s.tech.changePct,
      kairi: s.tech.kairi,
      rsi: s.tech.rsi,
      volZ: s.tech.volZ,
      closes: s.tech.closes,
      netNet,
      earningsTrend,
      taxEffectCaution,
      receivablesAnomaly,
      repricingLag,
      score,
      rank: usRankOf(score),
      bucket: s.daysLeft > US_WINDOW.watchMax ? 'PRE' : s.daysLeft <= US_WINDOW.nowMax ? 'NOW' : 'WATCH',
    });
  }
  console.log(`   Stage 2 完了（財務取得失敗 ${s2err} / 時価総額上限超過除外 ${s2excludedCap}） / 該当 ${results.length}銘柄`);

  results.sort((a, b) => b.score - a.score);
  const out = { date: today, universe: universe.length, results, logicFingerprint };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
