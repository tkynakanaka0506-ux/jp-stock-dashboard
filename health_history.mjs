// ==================================================================
// health_history.mjs — Production Health Checkの日次履歴保存。
//
// 「いつから信用需給データが減った？」「いつからtimelineが生成されなく
// なった？」「いつSCORE不変条件が壊れた？」を後から追えるようにする
// （ユーザー提案）。1日1エントリ（同日内の再実行は上書き＝直近の状態を
// 保持する。バックテスト記録基盤(ambush_timing_backtest.mjs等)の
// 「1日1回・最初の1件だけ」とは目的が違うため、あえて上書きにする）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'health_history_cache.json');
const LATEST_FILE = path.join(__dirname, 'stock_dashboard_health_cache.json');
const KEEP_DAYS = 365;

export function loadHealthHistory(filePath = HISTORY_FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

// today（YYYY-MM-DD）より前の直近の日のエントリを返す（無ければnull）。
// computeHealthCheck()のpreviousHealthに渡し、日次の推移比較に使う。
export function latestPriorHealth(today, filePath = HISTORY_FILE) {
  const hist = loadHealthHistory(filePath);
  const dates = Object.keys(hist).filter((d) => d < today).sort();
  const last = dates.at(-1);
  return last ? hist[last] : null;
}

// today分を記録（同日内は上書き）。latestFilePathには常に最新版を
// 複製保存する（ユーザー提案の`stock_dashboard_health.json`相当。
// このプロジェクトのsync_and_push.shが`git add index.html *_cache.json`
// で拾える命名規則（*_cache.json）に合わせている）。
export function recordHealthSnapshot(today, health, { historyPath = HISTORY_FILE, latestPath = LATEST_FILE } = {}) {
  const hist = loadHealthHistory(historyPath);
  hist[today] = health;
  const dates = Object.keys(hist).sort();
  while (dates.length > KEEP_DAYS) delete hist[dates.shift()];
  fs.writeFileSync(historyPath, JSON.stringify(hist, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(health, null, 2));
}
