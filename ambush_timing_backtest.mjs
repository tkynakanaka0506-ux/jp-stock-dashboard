// ==================================================================
// ambush_timing_backtest.mjs — 第8優先改修「AMBUSHの時間軸を検証可能
// にする」の記録基盤
//
// 目的: 「決算まで7〜30日」というAMBUSHの時間軸区分が、実際に有効
// だったのかを後から検証するための材料を貯めること。このファイル自体は
// 検証(分析)を行わない — 記録するだけ（policy_catalyst_backtest.mjsと
// 同じ方針。「有効性は未検証であって、無効ではない」。小標本で結論を
// 急がない）。
//
// 1日1回、その日最初に見たスナップショットだけを記録する
// （policy_catalyst_backtest.mjsと同じ理由。5分間隔の再実行でイントラ
// デイの値動きノイズが「別のサンプル」に紛れ込むのを防ぐ）。
//
// ■ 保存する項目とその理由
// snapshot_date/code/earningsDate/daysToEarnings/earningsDateStatus/
// bucket/catalystExists/catalystTier/kairi/return1m/return3m/
// repricingLagZoneは、いずれも記録時点でscraper.mjsが既に持っている値
// をそのままコピーするだけで、追加のデータ取得は発生しない。
//
// ■ 今回あえて保存しないもの（ユーザー提案にあったが見送った項目）
// price_return_7d/price_return_14d/price_return_to_earnings/
// benchmark_return/relative_returnは、「決算日に実際到達した時点」で
// 事後的に埋める必要がある将来値であり、現時点のスナップショットだけ
// からは作れない（存在しないデータを推測で埋めない方針）。将来、
// 決算発表後の値を別途追記する仕組み（Phase2）を検討する余地がある、
// という設計メモとしてここに残す。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ambushTimingBreakdown } from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'ambush_timing_backtest_cache.json');
// 検証には決算1サイクル（四半期）以上のサンプルが要るため、長めに保持する。
const KEEP_DAYS = 365;

export function loadAmbushTimingBacktest(filePath = FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

// results: amb.results（AMBUSH、bucket/daysLeft/earningsDateStatus等を
// 持つ銘柄群）。decliningLeft（daysLeftが無い/決算日未確定）銘柄は
// 「時間軸の検証」という本来の目的に使えないため記録しない。
// 第8優先改修 section5対応: 「最初のカタリスト観測日」はこのリポジトリ
// のどこにも保存されていない（TDnetは毎回取得し直すだけで、過去の
// 観測履歴を持たない）。過去に遡って捏造することはできないため、
// 「この記録基盤が観測を開始した日以降」に限定して、コード単位で
// catalystExists:trueを最初に記録した日をcatalystFirstSeenとして
// 保存する（jp-news-dashboardのpolicy_lifecycle.pyと同じ「追跡開始日
// より前は遡らない」方針）。それより前の情報はUNKNOWN（null）のまま。
function findCatalystFirstSeen(hist, today, code) {
  const dates = Object.keys(hist).filter((d) => d < today).sort();
  for (const d of dates) {
    if (hist[d]?.[code]?.catalystExists) return hist[d][code].catalystFirstSeen ?? d;
  }
  return null;
}

export function recordAmbushTimingSnapshot(today, results, filePath = FILE) {
  const hist = loadAmbushTimingBacktest(filePath);
  const day = hist[today] ?? (hist[today] = {});
  let added = 0;
  for (const r of results ?? []) {
    if (!Number.isFinite(r.daysLeft)) continue; // 時間軸が無い銘柄は対象外
    if (day[r.code]) continue; // 同日内は最初の1回だけ
    const b = ambushTimingBreakdown(r);
    const priorFirstSeen = findCatalystFirstSeen(hist, today, r.code);
    day[r.code] = {
      snapshotDate: today,
      code: r.code,
      name: r.name,
      earningsDate: r.earningsDate ?? r.earningsDateRaw ?? null,
      daysToEarnings: b.earningsDistance.days,
      earningsDistanceUnit: b.earningsDistance.unit,
      bucket: b.earningsDistance.bucket, // 記録時点のstrategy_stage(NOW/WATCH/NEAR等)。参考情報で、検証対象そのもの。
      earningsDateStatus: b.earningsDateConfidence.status, // CONFIRMED/ESTIMATED/UNKNOWN
      earningsDateSource: b.earningsDateConfidence.source,
      catalystExists: b.catalystSignal.hasCatalyst,
      catalystTier: b.catalystSignal.catalystTier,
      catalystScore100: b.catalystSignal.catalystScore100,
      // この記録基盤の観測開始日以降でしか追跡できない（それより前は
      // UNKNOWN=null。過去に遡って推測はしない）。
      catalystFirstSeen: b.catalystSignal.hasCatalyst ? (priorFirstSeen ?? today) : null,
      kairi: b.priceReaction.kairi,
      return1m: b.priceReaction.return1m,
      return3m: b.priceReaction.return3m,
      repricingLagZone: b.pricingStatus.repricingLagZone,
    };
    added += 1;
  }
  if (added > 0) {
    const dates = Object.keys(hist).sort();
    while (dates.length > KEEP_DAYS) delete hist[dates.shift()];
    fs.writeFileSync(filePath, JSON.stringify(hist, null, 2));
  }
  return added;
}

export function ambushTimingBacktestStatus(filePath = FILE) {
  const hist = loadAmbushTimingBacktest(filePath);
  const dates = Object.keys(hist).sort();
  const totalSnapshots = dates.reduce((sum, d) => sum + Object.keys(hist[d]).length, 0);
  return {
    days: dates.length,
    totalSnapshots,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
  };
}
