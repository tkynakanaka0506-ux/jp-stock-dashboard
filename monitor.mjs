#!/usr/bin/env node
// ==================================================================
// monitor.mjs — 稼働監視レポート(読み取り専用、判定ロジックには
// 一切関与しない)。
//
// 2026-09-21ユーザー要望「機能追加より長期的な安定稼働の監視・再発防止
// を優先」への対応。以下を launchd のログファイルから集計する:
//   - 場中ジョブ(stealth-dashboard.log)・日次フルスキャン
//     (stealth-daily.log)それぞれの実行時間
//   - watchdog(scraper.mjs、2026-09-21導入)による強制終了回数
//   - PIDロック(sync_and_push.sh側・scraper.mjs内側の両方)による
//     スキップ回数
//   - ログファイル自体の更新鮮度(launchd自体が動いているか)
//
// 実測上の制約: scraper.mjsの大半のconsole.logにはタイムスタンプが
// 付いていない(4000行規模のファイル全体に後付けするのはリスクが
// 高く、今回の「安定稼働優先・既存ロジックは変更しない」方針に反する
// ため見送った)。ロック関連の2箇所(sync_and_push.sh・scraper.mjsの
// watchdog発火)だけ今回タイムスタンプを追加したので、直近24h/7dの
// 集計はこの2つのイベント種別でのみ可能。実行時間(秒数)はタイムスタンプ
// 非依存(ログの出現順=実行順)なので「直近N件」の統計として出す。
//
// PERSISTENT_STATE_FILES/GENERATED_FILESとの関係(2026-09-21調査結果):
// jp-news-dashboardのupdate.ymlは`git reset --hard`でローカル変更を
// 破棄してから戻す設計のため、退避対象への登録漏れがあると永久に消える
// 事故が起きた。jp-stock-dashboardのsync_and_push.shは`git reset --hard`
// を一切行わず、素直に`git add && git commit && git pull --ff-only &&
// git push`するだけなので、同じ種類の「CIによる消失」は構造的に起こり
// 得ない。そのためニュース側のような永続化ファイル監視はここでは不要
// (重複した監視を増やさないための意図的な省略)。
// ==================================================================
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(process.env.HOME ?? '/Users/takuya', 'Library', 'Logs');
const DASHBOARD_LOG = path.join(LOG_DIR, 'stealth-dashboard.log');
const DAILY_LOG = path.join(LOG_DIR, 'stealth-daily.log');
// 「監視そのものが止まっていないか」(2026-09-21ユーザー要望)。「監視の
// 監視」を新設せず、このスクリプト自身が完走するたびにハートビート
// ファイルを書き換えるだけに留める(例外で途中終了すれば書き換わらない
// ので、最後に正常完走した時刻がそのまま分かる)。
const HEARTBEAT_PATH = path.join(LOG_DIR, 'jp-stock-monitor-heartbeat.txt');

function readLines(filePath) {
  try {
    return readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    return null; // ファイルが無い=ジョブが一度も動いていない(launchd未ロード等)
  }
}

function fileAgeMinutes(filePath) {
  try {
    return (Date.now() - statSync(filePath).mtimeMs) / 60000;
  } catch {
    return null;
  }
}

// 「✅ 完了 / ... / 17.9秒」から秒数だけ抜く。判定ロジックには使わず、
// 実行時間の分布を見るためだけの単純な正規表現。
function extractDurations(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/完了.*\/\s*([0-9.]+)秒/);
    if (m) out.push(parseFloat(m[1]));
  }
  return out;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

// 「YYYY-MM-DD HH:MM:SS ...」(sync_and_push.sh)または
// 「... (YYYY/M/D H:MM:SS)」「... YYYY/M/D H:MM:SS ...」
// (scraper.mjsのtoLocaleString('ja-JP'))のどちらの形式も拾う。
// 見つからなければnull(=期間集計の対象外、全期間カウントにのみ含める)。
function parseTimestamp(line) {
  const iso = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (iso) return new Date(iso[1].replace(' ', 'T'));
  const jp = line.match(/(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})/);
  if (jp) {
    const [, y, mo, d, h, mi, s] = jp.map(Number);
    return new Date(y, mo - 1, d, h, mi, s);
  }
  return null;
}

function countEventsByWindow(lines, pattern) {
  const now = Date.now();
  let total = 0, last24h = 0, last7d = 0, undated = 0;
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    total += 1;
    const ts = parseTimestamp(line);
    if (!ts) { undated += 1; continue; }
    const ageHours = (now - ts.getTime()) / 3600000;
    if (ageHours <= 24) last24h += 1;
    if (ageHours <= 24 * 7) last7d += 1;
  }
  return { total, last24h, last7d, undated };
}

function classifyStatus({ logExists, ageMinutes, expectedFreshMinutes, forcedKills24h, lockSkips24h }) {
  if (!logExists) return ['🔴', 'ログファイルが無い(launchdジョブが一度も実行されていない可能性)'];
  if (ageMinutes === null) return ['🟠', 'ログファイルの更新時刻を取得できませんでした'];
  if (ageMinutes > expectedFreshMinutes * 4) return ['🔴', `想定(${expectedFreshMinutes}分間隔)に対し長時間ログが更新されていません`];
  if (forcedKills24h > 0) return ['🟠', `直近24時間にwatchdogによる強制終了が${forcedKills24h}件あります(ネットワーク不調の可能性)`];
  if (ageMinutes > expectedFreshMinutes * 2) return ['🟡', '想定間隔よりログの更新がやや遅れています'];
  if (lockSkips24h > 10) return ['🟡', `直近24時間のロックスキップが${lockSkips24h}件と多めです`];
  return ['🟢', '正常'];
}

function reportFor(label, logPath, expectedFreshMinutes) {
  const lines = readLines(logPath);
  console.log(`\n--- ${label} (${logPath}) ---`);
  if (lines === null) {
    console.log('🔴 ログファイルが見つかりません(launchdジョブが一度も実行されていない可能性)');
    return;
  }
  const durations = extractDurations(lines);
  const d = stats(durations);
  if (d) {
    console.log(`実行時間: 直近${d.count}件中 最小${d.min.toFixed(1)}秒 / 中央値${d.median.toFixed(1)}秒 / 最大${d.max.toFixed(1)}秒`);
  } else {
    console.log('実行時間: 完了ログが見つかりません');
  }

  const kills = countEventsByWindow(lines, /強制終了します/);
  console.log(
    `watchdog強制終了: 全期間${kills.total}件(タイムスタンプ有り分のうち 直近24h=${kills.last24h} / 直近7d=${kills.last7d}`
    + `${kills.undated ? `、タイムスタンプ無し${kills.undated}件は集計対象外` : ''})`
  );

  const shellSkips = countEventsByWindow(lines, /別のsync_and_push\.sh実行中/);
  const nodeSkips = countEventsByWindow(lines, /別のインスタンスが実行中/);
  console.log(
    `ロックスキップ(shell): 全期間${shellSkips.total}件(直近24h=${shellSkips.last24h} / 直近7d=${shellSkips.last7d})`
  );
  console.log(
    `ロックスキップ(scraper.mjs内): 全期間${nodeSkips.total}件(直近24h=${nodeSkips.last24h} / 直近7d=${nodeSkips.last7d})`
  );

  const ageMinutes = fileAgeMinutes(logPath);
  console.log(`ログ最終更新: ${ageMinutes === null ? '不明' : `${ageMinutes.toFixed(1)}分前`}`);

  const [emoji, msg] = classifyStatus({
    logExists: true,
    ageMinutes,
    expectedFreshMinutes,
    forcedKills24h: kills.last24h,
    lockSkips24h: shellSkips.last24h + nodeSkips.last24h,
  });
  console.log(`${emoji} ${msg}`);
}

function main() {
  let previousHeartbeat = null;
  try { previousHeartbeat = readFileSync(HEARTBEAT_PATH, 'utf-8').trim(); } catch { /* 初回実行 */ }
  console.log(`(前回 monitor.mjs が正常に完走した時刻: ${previousHeartbeat || '記録なし(初回実行)'})`);

  console.log('=== STOCK_DASHBOARD_MONITOR ===');
  // 場中ジョブは5分おき(StartInterval=300)。日次は平日7:00の1回だけなので
  // 「鮮度」の考え方が異なる(24時間更新が無くても正常な日がほとんど)。
  reportFor('場中ジョブ(5分おき、市場時間内のみ)', DASHBOARD_LOG, 5);
  reportFor('日次フルスキャン(平日7:00の1回)', DAILY_LOG, 24 * 60);

  console.log('\n(参考) PERSISTENT_STATE_FILES方式との関係:');
  console.log(
    'jp-news-dashboardのupdate.ymlはgit reset --hardでローカル変更を破棄してから'
    + '戻す設計のため、退避漏れ=永久消失というリスクがあった。sync_and_push.shは'
    + 'git reset --hardを行わず素直にcommit/pushするだけなので、同種のリスクは'
    + '構造的に無い(このため同じ監視をここに重複実装していない)。'
  );

  // ここまで例外無く到達できた=このスクリプト自身が正常に完走した、
  // という意味でハートビートを書き換える。
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(HEARTBEAT_PATH, new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

export { extractDurations, stats, parseTimestamp, countEventsByWindow, classifyStatus };
