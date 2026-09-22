// ==================================================================
// us_edgar.mjs — SEC EDGAR XBRL Company Facts APIから米国企業の財務諸表を取得
//
//  EDINET（edinet.mjs）の米国版。無料・鍵不要（EDINET_API_KEYのような
//  登録は不要）。SECのfair-use policyによりUser-Agentに連絡先を含める
//  ことが求められているため、固定のUser-Agentを使う。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKER_CACHE_FILE = path.join(__dirname, 'us_ticker_cik_cache.json');
const TICKER_REFRESH_MS = 30 * 24 * 3600 * 1000; // 30日（EDINET同様、頻繁には変わらない）

// SECのfair use policy（https://www.sec.gov/os/webmaster-faq#developers）で
// User-Agentに連絡先を含めることが求められている。
const UA = 'AMBUSH-dashboard research (tkynakanaka0506@gmail.com)';
export const REQ_GAP = 200; // SECは「秒間10リクエストまで」を明示的に許容している

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 30_000;

async function getJson(url, retries = 2) {
  for (let i = 0; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (res.ok) return await res.json();
      if (res.status === 404) return null; // 該当企業がXBRL未提出（新規上場等）
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ティッカー→CIK（EDGARの企業識別番号）の対応表。全社分を1回で取得できる
// ため、EDINETの書類一覧走査と同じ「まとめて1回・以降はキャッシュ」の
// パターンにする。
export async function loadTickerCikMap({ force = false } = {}) {
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(TICKER_CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  const fresh = cache?.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < TICKER_REFRESH_MS;
  if (!force && fresh && cache.map) return cache.map;

  const json = await getJson('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const entry of Object.values(json ?? {})) {
    if (!entry?.ticker || !Number.isFinite(entry.cik_str)) continue;
    map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
  }
  fs.writeFileSync(TICKER_CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), map }, null, 2));
  return map;
}

export async function fetchCompanyFacts(cik) {
  return getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
}

// 複数の候補タグ名から最初に存在するものを使う（EDINETのRECEIVABLES_IDS
// 等と同じ「候補配列」パターン。会社によって使うXBRLタグが異なるため）。
function pickConcept(usgaap, candidates) {
  for (const name of candidates) {
    if (usgaap?.[name]?.units?.USD) return usgaap[name].units.USD;
  }
  return null;
}

// 貸借対照表項目（残高＝ある時点のスナップショット）の最新値を取る。
// 同じend日付に複数回の提出（訂正等）があり得るため、filedが一番新しい
// ものを採用する。
function latestBalance(entries) {
  if (!entries?.length) return null;
  const byEnd = new Map();
  for (const e of entries) {
    if (!Number.isFinite(e.val) || !e.end) continue;
    const prev = byEnd.get(e.end);
    if (!prev || (e.filed ?? '') > (prev.filed ?? '')) byEnd.set(e.end, e);
  }
  const sorted = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  return sorted.at(-1) ?? null;
}

const RETAINED_EARNINGS_TAGS = ['RetainedEarningsAccumulatedDeficit'];
const CASH_TAGS = ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'];
const ASSETS_TAGS = ['Assets'];
const EQUITY_TAGS = ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'];
const RECEIVABLES_TAGS = ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'];
const INVESTMENTS_TAGS = ['MarketableSecuritiesNoncurrent', 'LongTermInvestments'];

// EDINETのextractBalanceSheetSnapshotに相当。indicators.mjsの
// netNetSignal/dividendPotentialSignal/hiddenAssetSignal/
// receivablesAnomalySignalがそのまま使える形（円建てのbs.*と同じキー名・
// 単位=通貨そのまま）で返す。
export function extractBalanceSheetSnapshot(facts) {
  const usgaap = facts?.facts?.['us-gaap'];
  if (!usgaap) return {};
  const pick = (tags) => latestBalance(pickConcept(usgaap, tags))?.val ?? null;
  return {
    cash: pick(CASH_TAGS),
    totalAssets: pick(ASSETS_TAGS),
    equity: pick(EQUITY_TAGS),
    receivables: pick(RECEIVABLES_TAGS),
    retainedEarnings: pick(RETAINED_EARNINGS_TAGS),
    investmentSecurities: pick(INVESTMENTS_TAGS),
  };
}

const REVENUE_TAGS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'];
const NET_INCOME_TAGS = ['NetIncomeLoss'];
// 「攻めの赤字」判定（aggressiveInvestmentSignal、ユーザー提案）用。
// 標準的なUS GAAPタグで、AAPLのcompanyfacts実データで存在を確認済み。
const RND_TAGS = ['ResearchAndDevelopmentExpense'];
// 第6優先改修②（ユーザー報告「税効果」）用。AAPLの実データ
// （CIK0000320193のcompanyfacts）で四半期(duration 75〜100日)の実測値が
// 取得できることを確認済み（2026Q3実測: 税引前36,267,000,000ドル -
// 法人税等6,478,000,000ドル = 純利益29,789,000,000ドルとNetIncomeLossの
// 実値が一致することも確認済み）。
const PRETAX_INCOME_TAGS = ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'];

// ■ 単一四半期 vs 累計（YTD）の混在に注意（実データ検証で発覚）
// XBRLの売上高・純利益タグには「その四半期単独」の値と「年度開始からの
// 累計（YTD）」の値が同じタグ名の中に混在している（例: Q3提出の中に
// 単独四半期(start=Q3開始, end=Q3終了)と、累計(start=期首, end=Q3終了)の
// 両方が入っている）。durationが約2.5〜3.5ヶ月の行だけを「単一四半期」
// として抽出しないと、YoY成長率が大きく狂う。
function isQuarterDuration(entry) {
  if (!entry.start || !entry.end) return false;
  const days = (new Date(entry.end) - new Date(entry.start)) / 86400000;
  return days >= 75 && days <= 100;
}

function quarterlySeries(entries) {
  if (!entries?.length) return [];
  const byEnd = new Map();
  for (const e of entries) {
    if (!Number.isFinite(e.val) || !isQuarterDuration(e)) continue;
    const prev = byEnd.get(e.end);
    if (!prev || (e.filed ?? '') > (prev.filed ?? '')) byEnd.set(e.end, e);
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// カタリスト予兆（進捗率加速）の米国版=usEarningsTrendSignal用。
// 単一四半期の売上高・純利益を古い→新しい順で返す。
export function extractQuarterlyTrend(facts) {
  const usgaap = facts?.facts?.['us-gaap'];
  if (!usgaap) return [];
  const revenue = quarterlySeries(pickConcept(usgaap, REVENUE_TAGS));
  const netIncome = quarterlySeries(pickConcept(usgaap, NET_INCOME_TAGS));
  const rnd = quarterlySeries(pickConcept(usgaap, RND_TAGS));
  // 第6優先改修②（税効果）: 税引前利益。取得できない企業も多いため
  // （pickConcept自体がタグ不在ならnullを返す）、無理に補完しない。
  const pretaxIncome = quarterlySeries(pickConcept(usgaap, PRETAX_INCOME_TAGS));
  const niByEnd = new Map(netIncome.map((e) => [e.end, e.val]));
  const rndByEnd = new Map(rnd.map((e) => [e.end, e.val]));
  const pretaxByEnd = new Map(pretaxIncome.map((e) => [e.end, e.val]));
  return revenue.map((e) => ({
    end: e.end, revenue: e.val, netIncome: niByEnd.get(e.end) ?? null, rnd: rndByEnd.get(e.end) ?? null,
    pretaxIncome: pretaxByEnd.get(e.end) ?? null,
  }));
}
