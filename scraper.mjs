// ==================================================================
// STEALTH v7.3 "AMBUSH + SMART ENTRY"
//
//  v7.1（決算前の先行カタリストを探す AMBUSH）に、決算スケジュールを
//  無視して需給と乖離だけで機械的に仕込み時を探す SMART ENTRY を追加。
//  固定ウォッチリストは廃止 — 常時登録銘柄を眺めていても他の銘柄が
//  仕込み時なら意味がないため、全銘柄スキャンでその日ごとに入れ替わる。
//
//  さらに、全セクション共通の除外フィルター（低位株・薄商い・赤字/
//  債務超過は一切表示しない）と、初心者向けの結論表示（買い推奨/
//  様子見/見送りのステータスランプ・平易な日本語訳・過熱警告）を追加。
//
//  ■ データソース
//   決算予定日  : SBI証券 決算発表スケジュール（実体はIRISのJSONP・公開API）
//   適時開示    : TDnet（ルールベース判定。LLM APIは使わない）
//   株価/指標   : kabutan（kabukaページ1枚で価格・30日終値・出来高・市場区分）
//   信用残推移  : kabutan 週次信用残ページ（SMART ENTRYのみ）
//   業種騰落    : kabutan 東証【業種別】騰落ランキング（3リクエスト）
//   ※ Yahoo Finance は実測でIP単位の429、stooq はJS challenge のため不使用
//
//  ■ 1日のリクエスト数（実測）
//   SBI決算カレンダー   … 約32
//   TDnet 14営業日      … 約90
//   AMBUSH Stage 1      … 約250 / Stage 2 … 通過数 × 2
//   SMART ENTRY Stage 1 … 全銘柄（約3,400〜3,800）/ Stage 2 … 候補数 × 2
//   いずれも日次キャッシュ。場中の5分更新では 0件。
//   場中は AMBUSH・SMART ENTRY それぞれ上位のみを再取得する。
//
//  実行:
//    node scraper.mjs                通常
//    node scraper.mjs --force        日次キャッシュを強制再取得
//    node scraper.mjs --no-open      ブラウザを開かない（自動実行向け）
//    node scraper.mjs --market-hours 場外なら即終了（launchd向け）
//    node scraper.mjs --daily-only   日次パートだけ流す（寄り前バッチ用）
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, execFileSync } from 'child_process';

import { fetchIntraday, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, volumeZScore, unpricedScore, goldenCross, volumeRatio,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal,
  marketLabel, overheatSignal, growthSurgeSignal, describeRsi, describeKairi,
  ambushVerdict, smartEntryVerdict, stage1, STAGE1, CHIP_SIGNAL_FIELDS, VALUATION_CHIP_FIELDS, hasConsensusProfit,
  OVERHEAT_KAIRI, hasPrecursor, PRECURSOR_GOOD_FIELDS, PRECURSOR_CAUTION_FIELDS, VERDICT_SEVERITY,
  buildScoreParts, buyScore, buyScoreRiskPenalty, expectationScore, earningsSurpriseScore, confidenceTier, effectiveScore, badChipSignals,
  entryPriorityScore, tenbaggerDifficultyLabel, riskLevel, riskCoverage, repricingGapBreakdown, REPRICING_GAP, evaluationAxes,
  clusterConfirmation, creditSupplyBreakdown, ambushTimingBreakdown, financialQualityBreakdown, CREDIT_PATTERN,
  CREDIT_SUPPLY_TAGS, creditSupplyTags, buyPressureBandLabel, creditSupplyTimeline,
} from './indicators.mjs';
import { loadEarningsCalendar } from './sbi.mjs';
import { loadHolidays, isMarketHoliday } from './holidays.mjs';
import { loadDisclosures, evaluate } from './tdnet.mjs';
import { runScreen, WINDOW, ambushConviction, AMBUSH_BONUS_FIELDS, AMBUSH_PENALTY_FIELDS } from './screener.mjs';
import { runSmartEntryScreen, smartEntryConviction } from './smart_entry.mjs';
import { runUsScreen, US_WINDOW } from './us_screener.mjs';
import { runUsTenbaggerScreen } from './us_tenbagger.mjs';
import { loadSectorHistory, appendSectorHistory } from './sector_history.mjs';
import { MANUAL_WATCHLIST_CODES } from './watchlist.mjs';
import { loadListedIssues } from './jpx.mjs';
import { loadPolicyCatalystByCode } from './policy_catalyst.mjs';
import { computePolicyCatalystScore } from './policy_catalyst_score.mjs';
import { recordPolicyCatalystSnapshot, policyCatalystBacktestStatus } from './policy_catalyst_backtest.mjs';
import { recordAmbushTimingSnapshot, ambushTimingBacktestStatus } from './ambush_timing_backtest.mjs';
import { groupPolicyCatalystByTheme, AXIS_LABEL } from './policy_catalyst_compare.mjs';
import { loadAiCapexCatalystByCode } from './ai_capex_catalyst.mjs';
import { recordAiCapexCatalystSnapshot, aiCapexCatalystBacktestStatus } from './ai_capex_catalyst_backtest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, 'index.html');
// 別リポジトリ(jp-news-dashboard、Python製。旧フォルダ名jp-daytrade-dashboard)
// が書き出す「今アクティブな政策材料」スナップショット。存在しない/壊れていても
// loadPolicyCatalystByCode側がavailable:falseを返すだけで、このプロジェクトの
// 生成処理は止めない。
const POLICY_CATALYST_PATH = path.join(
  __dirname, '..', '..', 'jp-news-dashboard', 'newssite', 'data', 'policy_catalyst_signals.json'
);

const FORCE = process.argv.includes('--force');
const NO_OPEN = process.argv.includes('--no-open');
const MARKET_HOURS_ONLY = process.argv.includes('--market-hours');
const DAILY_ONLY = process.argv.includes('--daily-only');

// 実測バグ(2026-09-21発見): kabutan.mjsのgetText()は1リクエストあたり
// 30秒タイムアウト+2リトライ(個々のハングは防げている)だが、スキャン
// ループ全体には上限が無いため、ネットワークが広範囲に不調な時間帯には
// 「多くの銘柄それぞれが最悪ケース(30秒×3回)を踏む」が積み重なって
// 合計2時間以上かかることがあった。5分おきの場中ジョブがこれで数時間
// ブロックされ、「ダッシュボードが止まっている」ように見えていた実測
// 事故の再発防止として、場中ジョブ(--market-hours)にだけwatchdogを
// 入れる。
//
// 訂正(2026-09-21、監視基盤の実装中に発覚): 導入直後は日次フルスキャン
// にも2時間のwatchdogを入れていたが、実際のログ(stealth-daily.log)を
// 集計したところ、正常完了した日次実行が最大149分(2.5時間)かかって
// おり、2時間のwatchdogは正常なフルスキャンを誤って強制終了しうる
// ことが判明した。さらに、setTimeoutはDate.now()と同じくOSの壁時計に
// 基づくため、Macスリープ中も「経過時間」に含まれてしまう
// (lockOwnerAlive()のコメント参照: 2026-08-17にスリープで13時間中断
// された実例があり、経過時間で判断すると誤検知する設計課題が既にここに
// 明記されていた。watchdog導入時にこの制約を見落としていた)。日次ジョブは
// 1日1回・スリープ跨ぎの正常な長時間化がありうるため、経過時間ベースの
// watchdogを入れず、既存の生存確認ベースのロック(lockOwnerAlive)だけに
// 委ねる。場中ジョブは5分おきに何度も再試行される・スリープなら誰も見て
// いない可能性が高い、という非対称性から、こちらだけ経過時間ベースの
// watchdogを採用する(誤検知の実害が小さい)。
const WATCHDOG_MS = MARKET_HOURS_ONLY ? 20 * 60 * 1000 : null;

// 場中に価格を再取得する AMBUSH 銘柄数。
// 全通過銘柄を5分ごとに叩くとリクエストが膨らむので上位のみに絞る。
const AMBUSH_LIVE = 12;

// 場中に再判定する SMART ENTRY 銘柄数。AMBUSHと同じ理由で上位のみ。
const SMART_LIVE = 12;

// ユーザー要望「順位は10位までにして」。rankBadge（N位表示）を使う
// ランキング形式の全セクション（AMBUSH NOW/WATCH・SMART ENTRY・
// カタリスト予兆・米国株AMBUSH・テンバガー候補）で表示件数の上限を
// 統一する。AMBUSH_LIVE/SMART_LIVE（場中の価格再取得対象数）とは別物
// （こちらは表示のみを絞る。価格再取得ロジックには影響させない）。
const RANK_TOP_N = 10;

// SECTION C に並べる監視候補の上限。Stage 1 通過は100銘柄を超えることが
// あるので、全部出すと画面が使い物にならない。
const AMBUSH_WATCH_MAX = RANK_TOP_N;

// 祝日セットは main() で読み込んでここに入れる（launchdから5分ごとに
// 呼ばれるので、判定のたびに取得しないよう30日キャッシュを使う）
let HOLIDAYS = new Set();

function isMarketHours() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = jst.toISOString().slice(0, 10);
  if (isMarketHoliday(iso, HOLIDAYS)) return false; // 土日＋国民の祝日＋年末年始
  const mins = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 50;
}

// ------------------------------------------------------------------
// 多重起動の防止
//
//  日次ジョブ(寄り前)と場中ジョブ(5分間隔)は本来ぶつからないが、
//  Macがスリープしていて寄り前ジョブが起床時に走ると、場中ジョブと
//  同時に動く可能性がある。両方が同じキャッシュを書くと壊れるので、
//  PIDロックで後発を降ろす。
//  ・記録されたPIDが生きた scraper.mjs なら降りる（経過時間は見ない）
//  ・プロセスが死んでいる／別物にPIDが再利用された／内容が壊れたロックは奪う
// ------------------------------------------------------------------
const LOCK_FILE = path.join(__dirname, '.scraper.lock');

// ロックの内容。素のPIDだけを書いていた頃の形式も読めるようにしておく。
function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    if (raw.startsWith('{')) return JSON.parse(raw);
    const pid = Number(raw);
    return Number.isFinite(pid) ? { pid, startedAt: null } : null;
  } catch {
    return null; // 読めない＝壊れている
  }
}

// 持ち主が「今も動いている scraper.mjs か」を確かめる。
//
//  ■ 経過時間で判断してはいけない
//  以前は「mtimeが30分より古ければ死んだ」と見なしていたが、これは
//  Macがスリープすると誤判定する。実測 2026-08-17 の07:00バッチは
//  Stage 1 の途中でスリープに入り、蓋を開けた20:26まで13時間中断された
//  （プロセスは生きたまま）。経過時間だけ見ると「古い＝死んだ」と判定され、
//  5分ごとの日中ジョブがロックを奪って同時実行になりうる。
//  スリープで止まったプロセスはハートビートも打てないので、
//  生存確認そのものを唯一の判断材料にする。
//
//  PIDは使い回されるため、生存＝即ロック有効とはしない。ps で中身を照合し、
//  無関係なプロセスがPIDを引き継いだ場合は奪えるようにする。
//
//  照合は「実行ファイルが node」かつ「引数に scraper.mjs」の両方を要求する。
//  command= の部分一致だけだと緩すぎて、scraper.mjs という文字列を
//  コマンドラインに含む無関係なプロセス（起動用のシェル、tail、grep など）を
//  持ち主と誤認する。実測: `node scraper.mjs` を含むシェルのPIDを書いたら
//  ロックが有効と判定されてしまった。
function lockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0); // シグナル0＝存在確認のみ。送信はしない
  } catch (e) {
    if (e.code !== 'EPERM') return false; // EPERM＝居るが他人のもの
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm=,args='], { encoding: 'utf-8' }).trim();
    if (!out) return false;
    const [comm, ...rest] = out.split(/\s+/);
    return /(^|\/)node(js)?$/.test(comm) && rest.join(' ').includes('scraper.mjs');
  } catch {
    return false; // ps に出てこない＝もう居ない
  }
}

let lockHolder = null; // 取れなかったときに持ち主を表示するため

function acquireLock() {
  // 'wx' は「存在しなければ作る、あれば失敗」をOSレベルで不可分に行う。
  // readFileSync→writeFileSync の順で書くと、同時起動した全プロセスが
  // 「ロック無し」を同時に観測して全員が通ってしまう（実測で3本とも通過）。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      const owner = readLock();
      if (owner && lockOwnerAlive(owner.pid)) {
        lockHolder = owner; // 生きている → 奪わない
        return false;
      }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 他が先に消した */ }
      // 1度だけ取り直しを試す
    }
  }
  return false;
}

function releaseLock() {
  const owner = readLock();
  if (owner?.pid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* 既に消えている */ }
  }
}

// ==================================================================
// ユーティリティ
// ==================================================================
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = (v, u = '') => (v === null || v === undefined ? '--' : `${v}${u}`);

// ==================================================================
// 描画パーツ
// ==================================================================
function generateSparkline(closes, id) {
  if (!closes || closes.length < 5) return '';
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const [w, h] = [150, 40];
  const xy = closes.map((v, i) => [
    (i / (closes.length - 1)) * w,
    h - ((v - min) / range) * (h - 6) - 3,
  ]);
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = closes.at(-1) >= closes[0];
  const color = up ? '#22ffc4' : '#ff3d71';
  const [lx, ly] = xy.at(-1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".38"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="0,${h} ${pts} ${w},${h}" fill="url(#g${id})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"
              stroke-linejoin="round" stroke-linecap="round" filter="drop-shadow(0 0 4px ${color})"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="${color}">
      <animate attributeName="r" values="2.6;4.6;2.6" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;.35;1" dur="2s" repeatCount="indefinite"/>
    </circle>
  </svg>`;
}

function scoreGauge(prob) {
  if (prob === null) {
    return `<svg class="gauge" width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r="26" fill="none" stroke="#1d2735" stroke-width="4"/>
      <text x="34" y="33" text-anchor="middle" class="gauge-v" fill="#c3d2ec">N/A</text>
      <text x="34" y="45" text-anchor="middle" class="gauge-u">NO DATA</text>
    </svg>`;
  }
  const r = 26, c = 2 * Math.PI * r;
  const hue = prob >= 80 ? '#22ffc4' : prob >= 70 ? '#31e0ff' : prob >= 60 ? '#4d9fff' : prob >= 50 ? '#ffb43d' : '#ff3d71';
  // ユーザー指摘: メインのSCORE（技術・財務の総合力）とカード下部の
  // 「妙味スコア」（今から買うタイミング/織り込み度）が別軸なのに説明が
  // 無く、どちらを信じればいいか分からなかった（実測: APLDでSCORE70・
  // 妙味スコア44.5と乖離）。SVGタイトル（ホバー説明）で軸の違いを明記する。
  return `<svg class="gauge" width="68" height="68" viewBox="0 0 68 68">
      <title>SCORE＝技術・財務の総合力（素点）。実際の順位はBUY SCORE（期待リターン・未織り込み度・サプライズ期待・タイミング・企業クオリティを合成した値にCONFIDENCEで補正したEffective Score）で決まります。カード下部の「妙味スコア」はBUY SCOREの「未織り込み度」要素と同じ値です</title>
      <circle cx="34" cy="34" r="${r}" fill="none" stroke="#1d2735" stroke-width="4"/>
      <circle cx="34" cy="34" r="${r}" fill="none" stroke="${hue}" stroke-width="4"
              stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}"
              stroke-dashoffset="${(c * (1 - prob / 100)).toFixed(1)}"
              transform="rotate(-90 34 34)" filter="drop-shadow(0 0 5px ${hue})"/>
      <text x="34" y="33" text-anchor="middle" class="gauge-v" fill="${hue}">${prob}</text>
      <text x="34" y="45" text-anchor="middle" class="gauge-u">SCORE</text>
  </svg>`;
}

// 決算日の確度をそのままバッジにする（推測で「確定」と言わない）
function earningsBadge(r) {
  if (r.earningsDateStatus === 'confirmed') {
    return `<span class="chip cyan" title="取引所発表の確定日 (${esc(r.earningsDateSource ?? '')})">決算 T-${r.daysLeft}d · 確定</span>`;
  }
  if (r.earningsDateStatus === 'estimated') {
    return `<span class="chip amber" title="前年同期の発表日を置き換えた参考値 (${esc(r.earningsDateRaw ?? '')})">決算 T-${r.daysLeft}d · 参考値</span>`;
  }
  return `<span class="chip gray" title="SBIの予定表（約2ヶ月先まで）に次回決算日が未掲載">決算日 未確定</span>`;
}

// 強い買い候補(緑)/買い候補(青)/様子見(黄)/織り込み警戒(橙)/見送り(赤)の
// ステータスランプ（v7.3で3段階から5段階に拡張）。
// 理由を1行添えて、初心者が数値を読まなくても結論が分かるようにする。
// A指示 項目34「『参考銘柄』と『本命銘柄』を分離」: 10銘柄を全部同じ
// 価値で表示しない。verdict（結論）だけでは「買い推奨」内の候補同士の
// 質の差（仕込み優先度・リスク）が伝わらないため、仕込み優先度
// （entryPriorityScore）とリスク（badChipSignals由来のriskLevel）を
// 組み合わせた4段階の表示カテゴリを追加する。ランキング順位自体は
// 変えない（表示上の分類のみ）。
const DISPLAY_CATEGORY = {
  TOP_PICK: { emoji: '🔥', label: 'TOP PICK', cls: 'mint', title: '本当に仕込みたい候補（買い推奨・仕込み優先度が高く、リスクも低〜中）' },
  SPECULATIVE: { emoji: '💡', label: 'SPECULATIVE', cls: 'amber', title: '爆発力はあるがリスクが高い候補（bad級のリスクシグナルが複数該当）' },
  WATCH: { emoji: '👀', label: 'WATCH', cls: 'flat', title: '監視候補（買い推奨または様子見だが、TOP PICKほどの決め手は無い）' },
  REFERENCE: { emoji: '⚪', label: 'REFERENCE', cls: 'gray', title: '条件の一部だけ該当する参考銘柄' },
};

export function displayCategoryKey(verdictLevel, priority, risk) {
  if (!verdictLevel || !Number.isFinite(priority)) return null;
  if (risk === 'HIGH' && priority >= 50) return 'SPECULATIVE';
  // 第2優先改修（CASE6/CASE7対応）: risk==='UNKNOWN'（リスク評価材料が
  // 事実上無い）はriskLevelの新設状態。「HIGHではない」という理由だけで
  // 「本当に仕込みたい候補」に分類しない（確認できていないリスクを
  // 低リスクと同じ扱いにしない）。SPECULATIVE（明確なbad級シグナル複数）
  // に押し込むのも実態と違うため、TOP_PICKの対象から外すに留める
  // （WATCH/REFERENCEへの自然なフォールスルーに任せる）。
  if ((verdictLevel === 'strong_buy' || verdictLevel === 'buy') && priority >= 70 && risk !== 'HIGH' && risk !== 'UNKNOWN') return 'TOP_PICK';
  if (verdictLevel === 'strong_buy' || verdictLevel === 'buy' || verdictLevel === 'hold') return 'WATCH';
  return 'REFERENCE';
}

function displayCategoryBadge(v, r) {
  const key = displayCategoryKey(v?.level, r?.entryPriorityScore?.score, riskLevel(r));
  if (!key) return '';
  const c = DISPLAY_CATEGORY[key];
  return `<span class="chip ${c.cls}" title="${esc(c.title)}">${c.emoji} ${c.label}</span>`;
}

function verdictBlock(v, r) {
  if (!v) return '';
  return `<div class="verdict v-${v.level}">
        <span class="verdict-lamp"></span><span class="verdict-label">${esc(v.label)}</span>
        ${displayCategoryBadge(v, r)}
        <span class="verdict-reason">${esc(v.reason ?? '')}</span>
      </div>`;
}

// v7.3改修（ユーザー指示書 項目1/2/7/15）: BUY/EXPECTATION/SURPRISEスコアと
// CONFIDENCEの表示。上部のSCOREガウジは「素点」のまま残し、実際の順位に
// 使うEffective Score（=BUY SCORE×CONFIDENCE係数）の内訳をここで明示する。
//
// 実測バグ（指示書の生テキストまで遡った再監査で発覚）: 項目15の最終
// ランキング画面のモックアップは「BUY SCORE/EXPECTATION/SURPRISE」だけで
// なく「UNPRICED（未織り込み度）」「TIMING（タイミング）」「RISK（低/中/
// 高）」も1銘柄ごとの独立した数値として表示する設計だった。UNPRICED/
// TIMINGはBUY SCOREの内訳（buyScore.detail.unpriced/timing）として既に
// 計算済みなのに、単独の数値としては一度も画面に出しておらず、RISKに
// 至っては相当する表示自体が存在しなかった（badChipSignals由来のリスク
// 件数はreasonBlockの箇条書きにしか出ていない）。
const RISK_LEVEL_CLS = { LOW: 'mint', MED: 'amber', HIGH: 'red', UNKNOWN: 'gray' };
export function scoreTrio(r) {
  if (!r.buyScore) return '';
  // A指示 項目24「CONFIDENCEを実質的な投資判断信頼度にする」:
  // HIGH/MEDIUM/LOWの3段階に加えUNKNOWN（根拠が弱すぎる＝BUY SCOREの
  // 5要素のうち1つもデータが揃わなかった状態）を追加する。従来は
  // confidenceTierがnull（=r.confidenceTier未設定）のとき何も表示せず
  // 黙って情報を隠していたが、それ自体が「判定材料が無い」という重要な
  // シグナルなので明示する。
  const tierCls = { HIGH: 'mint', MEDIUM: 'amber', LOW: 'red', UNKNOWN: 'gray' };
  const confidenceLabel = r.confidenceTier ?? 'UNKNOWN';
  const fmtScore = (s) => Number.isFinite(s?.score) ? s.score : '--';
  const confBadge = `<span class="chip ${tierCls[confidenceLabel]}" title="BUY SCOREの算出に使えたデータの充実度（DATA${r.buyScore.confidence}%）。低いほどEffective Score（実際の順位に使う値）がSCOREより割り引かれます。UNKNOWNはBUY SCOREの5要素のうち1つもデータが揃わなかった状態です">CONFIDENCE ${confidenceLabel}</span>`;
  const effectiveNote = Number.isFinite(r.effectiveScore) && r.effectiveScore !== r.buyScore.score
    ? ` <i title="Effective Score = BUY SCORE × CONFIDENCE係数。実際の順位はこちらを使います">実質${r.effectiveScore}</i>` : '';
  const unpriced = r.buyScore.detail?.unpriced?.value;
  const timing = r.buyScore.detail?.timing?.value;
  const risk = riskLevel(r);
  // 第2優先改修（CASE6/CASE7対応）: RISK LOWは「bad級のシグナルが0件」
  // という意味で、「確認した結果リスクが無かった」とは限らない。何件中
  // 何件を実際に評価できたかを添えて、UNKNOWN（判定材料が事実上無い）
  // との違い・LOWの根拠の薄さの両方を透明にする。
  const { checked: riskChecked, total: riskTotal } = riskCoverage(r);
  const riskTitle = risk === 'UNKNOWN'
    ? `リスクを評価できる材料（${riskTotal}種類のシグナル）が1件も確認できていません。「リスクが低い」のではなく「リスクを判定できていない」状態です`
    : `bad級のリスクシグナル該当件数（0件=LOW/1件=MED/2件以上=HIGH）。判定材料は${riskTotal}件中${riskChecked}件を確認できています（LOWでも確認件数が少ない場合はご注意ください）。詳細は下の理由欄またはリスクのチップを確認してください`;
  // A指示 項目1-2/32「仕込み優先度」: 「ユーザーが最も見たい実戦用
  // スコア」として、BUY/実質SCOREより先頭に表示する。
  // A指示 項目23「DATA%を順位に反映する」: 仕込み優先度自体にも
  // BUY SCOREと同じConfidence Adjustment（実質仕込み優先度）を併記し、
  // 判断材料が薄い銘柄の数値をそのまま鵜呑みにしないよう促す。
  const priorityEffectiveNote = Number.isFinite(r.entryPriorityEffective) && r.entryPriorityEffective !== r.entryPriorityScore?.score
    ? ` <i title="実質仕込み優先度 = 仕込み優先度 × CONFIDENCE係数（判断材料の充実度）。数値の信頼性を判断する目安です">実質${r.entryPriorityEffective}</i>` : '';
  const priorityBadge = Number.isFinite(r.entryPriorityScore?.score)
    ? `<span class="chip priority" title="仕込み優先度（未織り込み度25・成長加速20・業績の質15・バリュエーション15・カタリスト10・需給10・テーマ性5の100点満点、リスク減点適用後）。SCORE/実質SCOREより優先して見てほしい実戦用スコアです">🎯 仕込み優先度 ${r.entryPriorityScore.score}${priorityEffectiveNote}</span>`
    : '';
  const catalystBadge = catalystScoreBadge(r.policyCatalystScore);
  return `<div class="score-trio">
        ${priorityBadge}
        <span class="chip flat" title="今この銘柄を仕込む価値。期待リターン30・未織り込み度25・決算サプライズ期待20・タイミング15・企業クオリティ10の100点満点">BUY ${fmtScore(r.buyScore)}${effectiveNote}</span>
        ${catalystBadge}
        <span class="chip flat" title="企業そのものの中長期的な成長期待（売上高成長率・利益成長率・企業クオリティ・セクターモメンタム）">EXPECTATION ${fmtScore(r.expectationScore)}</span>
        <span class="chip flat" title="次回決算で市場予想を上回る可能性（会社予想とコンセンサスの差・進捗率モメンタム・月次開示の有無）">SURPRISE ${fmtScore(r.earningsSurpriseScore)}</span>
        ${Number.isFinite(unpriced) ? `<span class="chip flat" title="好材料がまだ株価に織り込まれていない度合い（BUY SCOREの内訳。妙味スコアを流用）">UNPRICED ${unpriced}</span>` : ''}
        ${Number.isFinite(timing) ? `<span class="chip flat" title="決算までの日数から見た仕込みタイミングの良さ（BUY SCOREの内訳）">TIMING ${timing}</span>` : ''}
        <span class="chip ${RISK_LEVEL_CLS[risk]}" title="${esc(riskTitle)}">RISK ${risk}</span>
        ${confBadge}
      </div>`;
}

// 市場区分チップ（プライム/スタンダード/グロース）
function marketChip(market) {
  if (!market) return '';
  return `<span class="chip gray">${esc(marketLabel(market))}</span>`;
}

// 底打ち確認（＋α）— セリングクライマックス近似・ネットネット・配当下限・
// 踏み上げ狙い・業種出遅れなどのシグナルを、該当したものだけチップで出す。
// 除外/減点には使わない（根拠を積み増す一言メモという位置づけ）。
//
// フィールド一覧はindicators.mjsのCHIP_SIGNAL_FIELDSを参照する（ここで
// 独自に列挙しない）。ambushVerdict/smartEntryVerdictも同じ一覧を見て
// いるため、新しいシグナルをCHIP_SIGNAL_FIELDSに1行足すだけでチップ表示
// とverdictへの反映が両方とも自動的に効く（「表示だけして判定側に
// 配線し忘れる」という、このセッションで2回実際に起きたバグの再発防止）。
// コンセンサス（アナリスト予想）が無い銘柄は「未来の期待値」との比較が
// そもそもできないため、代わりに「過去の事実」に基づくチップ
// （VALUATION_CHIP_FIELDS＝お宝候補・解散価値・PBR・配当）を先頭に出す。
export function bottomChips(r) {
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  const fields = hasConsensus
    ? CHIP_SIGNAL_FIELDS
    : [...VALUATION_CHIP_FIELDS, ...CHIP_SIGNAL_FIELDS.filter((k) => !VALUATION_CHIP_FIELDS.includes(k))];
  const items = fields.map((k) => r[k]).filter((s) => s && s.level);
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return items
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`)
    .join('');
}

// 「1日30分の銘柄調査ルーティン」の自分ルール（需給/下値/期待値/タイミング/
// 財務）をカード側で自動チェックする。財務（売上債権と売上高の伸び率比較）
// だけはIR Bank側に該当データが無く自動化できないため、常に「要手動確認」
// として区別する（できない判定を偽って自動化はしない）。
export function buyRuleChecklist(r) {
  const rows = [];

  // 元の自分ルールは「信用倍率が過度に高くない、または空売りが積み上がっている」
  // というOR条件。squeezeが'good'ならmarginOverhangが'bad'でも需給面の裏付け
  // ありとして扱う（踏み上げ期待の方が根拠として優先＝noteもsqueeze側を出す）。
  // marginOverhang.level:nullは「信用倍率データが無い」場合と「データは
  // あり信用過多ではないと確認できた」場合があるため、checked flagで
  // 区別する（実測: 石井表記等4銘柄はloanRatio自体が無いのに「✓ 信用過多
  // の兆候なし」＝確認済みと誤表示していた）。
  // 「信用倍率が過度に高くない、または空売りが積み上がっている」という
  // OR条件は、どちらか一方が確定的にtrueなら全体がtrue、両方とも確定的に
  // falseなら全体がfalse、それ以外（一方でも未確認）は結論を出せない
  // （厳密な3値OR論理）。以前は「marginOverhangが確定的にbadなら、
  // squeezeの状態を見ずに一律✗」としており、squeezeが単に未取得なだけ
  // （踏み上げ狙いを確認できなかった訳ではなくデータ自体が無い）でも
  // 誤って「OR全体がfalseと確定」扱いにしていた（実測: 3038神戸物産等
  // 6銘柄でmarginOverhangがbad・squeezeが週次信用残データ未取得のまま
  // 需給✗と表示されていた）。
  const supplyBad = r.marginOverhang?.level === 'bad';
  const supplyChecked = r.marginOverhang?.checked === true;
  const squeezeGood = r.squeeze?.level === 'good';
  const squeezeChecked = r.squeeze?.checked === true;
  const orConfirmedTrue = (supplyChecked && !supplyBad) || squeezeGood;
  const orConfirmedFalse = supplyChecked && supplyBad && squeezeChecked && !squeezeGood;
  let supplyNote;
  if (squeezeGood) supplyNote = r.squeeze.note;
  else if (orConfirmedTrue) supplyNote = '信用過多の兆候なし';
  else if (orConfirmedFalse) supplyNote = r.marginOverhang.note;
  else if (supplyBad) supplyNote = `${r.marginOverhang.note}（空売りデータ不足のため踏み上げの有無は未確認）`;
  else supplyNote = '信用倍率または空売りのデータが不足しています';
  rows.push({
    label: '需給', ok: orConfirmedTrue ? true : (orConfirmedFalse ? false : null),
    note: supplyNote,
  });

  // ネットネットは実測でほぼ発動しない（AMBUSH候補21銘柄中0件）ため、
  // 元の自分ルール通り「PBRが業種平均以下」も下値の裏付けとして見る
  // （netNetOk OR lowPbrOk OR pbrHistoricalLowOk というOR条件）。
  // pbrHistoricalLow（過去自身の最低PBRへの接近度）は、コンセンサスが
  // 無い銘柄向けに追加した3つ目の下値裏付け（indicators.mjs参照）。
  // netNet/lowPbr/pbrHistoricalLowのlevel:nullは「データ不足で判定
  // できない」場合と「データは揃っていて下値の裏付けは無いと確認できた」
  // 場合の両方があり得るため、checked flagで区別する（実測: 350A等11銘柄
  // はPBR・業種平均PBRのデータが完全に揃っているのに「確認できず」と
  // 表示されていた）。
  // OR条件が確定的にfalseと言えるのは「3つとも確認済みで、3つとも
  // 該当しない」場合だけ（需給行と同じ3値OR論理）。いずれかだけ確認済みで
  // 該当しない場合、他が未確認のままではOR全体を確定できない
  // （OR判定なのに「いずれか一つさえ確認できればfalse確定」としていた
  // のは論理的に誤り）。
  const netNetOk = r.netNet?.level === 'good' || r.netNet?.level === 'warn';
  const lowPbrOk = r.lowPbr?.level === 'good' || r.lowPbr?.level === 'warn';
  const pbrHistoricalLowOk = r.pbrHistoricalLow?.level === 'good';
  const netNetChecked = r.netNet?.checked === true;
  const lowPbrChecked = r.lowPbr?.checked === true;
  const pbrHistoricalLowChecked = r.pbrHistoricalLow?.checked === true;
  const downsideConfirmedFalse = netNetChecked && lowPbrChecked && pbrHistoricalLowChecked;
  const downsideNote = r.netNet?.note ?? r.lowPbr?.note ?? r.pbrHistoricalLow?.note;
  rows.push({
    label: '下値', ok: (netNetOk || lowPbrOk || pbrHistoricalLowOk) ? true : (downsideConfirmedFalse ? false : null),
    note: downsideNote ?? (downsideConfirmedFalse ? '解散価値・PBR（業種比・歴史的水準）いずれでも下値の裏付けなし' : '解散価値・PBR判定に必要なデータが不足しています'),
  });

  // 「コンセンサスN/A」と一括りにしていたが、実際には
  // ①会社予想(estimateProfit)が無い（SBI決算カレンダー側に未収録）ケースと
  // ②コンセンサス(consensusProfit)が無い（アナリスト非カバー）ケースは
  // 原因が別。どちらが欠けているかで表示を分けないと、コンセンサスは
  // あるのに会社予想が無いだけの銘柄（例: 4716日本オラクル）まで
  // 「コンセンサスN/A」と誤表示してしまう。
  // なお「会社が通期予想を非開示」と断定するのは誤り（実測: 7921は
  // kabutanの決算ページ自体には来期予想の数値が載っているのに、SBI側の
  // カレンダーには収録されていなかった）。原因を決めつけず「このデータ
  // ソースには無い」という事実だけを伝える。
  let diffPct = null;
  const hasEstimate = Number.isFinite(r.estimateProfit);
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  if (hasEstimate && hasConsensus) {
    diffPct = Math.round(((r.estimateProfit - r.consensusProfit) / Math.abs(r.consensusProfit)) * 1000) / 10;
  }
  let expectedNote;
  if (diffPct !== null) {
    expectedNote = `会社予想はコンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%`;
  } else if (!hasEstimate && hasConsensus) {
    expectedNote = '会社予想N/A（決算カレンダーに未収録）';
  } else if (hasEstimate && !hasConsensus) {
    expectedNote = 'コンセンサスN/A';
  } else {
    expectedNote = '会社予想・コンセンサス共にN/A';
  }
  rows.push({
    label: '期待値', ok: diffPct === null ? null : Math.abs(diffPct) <= 10,
    note: expectedNote,
  });

  // SMART ENTRYは決算スケジュールを見ない設計のため決算日が無い銘柄が
  // 多い（daysLeft:null）。この場合earningsWarningは常にlevel:null
  // （'bad'ではない）になり、!timingBadが常にtrueになって「決算日が
  // わからない」のに「近くないと確認できた」かのように✓を表示していた。
  // 財務行と同じく「未確認」と「確認済みで問題なし」を区別する。
  const timingBad = r.earningsWarning?.level === 'bad';
  const daysLeft = r.earningsDaysLeft ?? r.daysLeft ?? null;
  rows.push({
    label: 'タイミング', ok: daysLeft === null ? null : !timingBad,
    note: timingBad ? r.earningsWarning.note : (daysLeft !== null ? `決算まであと${daysLeft}日` : '決算日情報不明のため判定不能'),
  });

  // 売上債権(IR Bank)と売上高(kabutan)の年度成長率を自動比較。どちらか
  // 一方でも取得できない銘柄は checked:false になるため、okはnullのまま
  // 返す（「異常なし」と「判定不能」を混同しない＝未確認の「？」表示）。
  // levelが'warn'（やや増加・様子見レベル）でも「✓」を付けると、注意文言
  // (note)と結論(✓)が矛盾して見える。「異常なし」と言えるのは level が
  // 完全にnull（warnもbadも出ていない）のときだけにする。
  const fin = r.receivablesAnomaly;
  rows.push({
    label: '財務', ok: fin?.checked ? fin.level === null : null,
    note: fin?.level ? fin.note : (fin?.checked ? '売上債権の伸びは売上高に対して異常なし' : '売上高または売上債権のデータ不足で判定不能'),
  });

  return rows;
}

export function ruleChecklistBlock(r) {
  const rows = buyRuleChecklist(r);
  // 実測バグ（2026-09-22、ユーザー報告。例: 9048名古屋鉄道は期待値/
  // タイミング/財務の3項目が判定不能（？）なのに「2/2」と表示されて
  // いた）。旧実装はok:null（＝UNKNOWN、判定不能）の項目を分母から
  // 除外してから「合格数/残った分母」を出しており、5項目中2項目しか
  // 判定できていない銘柄が、あたかも「2項目中2項目クリア＝フルスコア」
  // であるかのように見えていた。UNKNOWNは「合格」でも「不合格」でも
  // ないため、分母は必ず元のルール総数（rows.length）で固定し、
  // PASS/FAIL/UNKNOWNの内訳を分けて数える（第2優先改修 CASE1〜3）。
  const passed = rows.filter((row) => row.ok === true).length;
  const failed = rows.filter((row) => row.ok === false).length;
  const unknown = rows.filter((row) => row.ok === null).length;
  const pills = rows.map((row) => {
    const mark = row.ok === true ? '✓' : row.ok === false ? '✗' : '？';
    const cls = row.ok === true ? 'mint' : row.ok === false ? 'red' : 'gray';
    return `<span class="rule ${cls}" title="${esc(row.note)}">${mark} ${esc(row.label)}</span>`;
  }).join('');
  const unknownNote = unknown > 0 ? `<span class="rulebox-unknown" title="判定に必要なデータが無く、合格・不合格のどちらとも判定できていない項目です（分母には含めていますが、達成済みとして扱ってはいません）">（うちUNKNOWN ${unknown}）</span>` : '';
  return `<div class="rulebox">
        <div class="rulebox-head">自分ルール <span class="rulebox-score" title="PASS ${passed} / FAIL ${failed} / UNKNOWN ${unknown}（分母は元のルール総数${rows.length}で固定。UNKNOWNは合格に数えていません）">${passed}/${rows.length}</span>${unknownNote}</div>
        <div class="rulebox-rows">${pills}</div>
      </div>`;
}

// 同業他社比較（提案3番目）— PER/PBR/利回りは業種平均と並べて表示する
// （fetchSectorMomentumの業種別ページに元々あった列を流用、追加取得は
// 無し）。ROEは個別銘柄のみ（kabutan側に業種平均ROEのページが無いため
// 非対応と明記する。推測で埋めない）。
function peerComparisonBlock(r) {
  const rows = [];
  if (Number.isFinite(r.per) || Number.isFinite(r.sectorPer)) {
    rows.push(['PER', fmt(r.per, '倍'), fmt(r.sectorPer, '倍')]);
  }
  if (Number.isFinite(r.pbr) || Number.isFinite(r.sectorPbr)) {
    rows.push(['PBR', fmt(r.pbr, '倍'), fmt(r.sectorPbr, '倍')]);
  }
  if (Number.isFinite(r.dividendYield) || Number.isFinite(r.sectorDividendYield)) {
    rows.push(['利回り', fmt(r.dividendYield, '%'), fmt(r.sectorDividendYield, '%')]);
  }
  if (Number.isFinite(r.roe)) {
    rows.push(['ROE', fmt(r.roe, '%'), '業種平均非対応']);
  }
  // v7.3改修 項目10: PER/PBRだけでなくEV/EBITDAも併記する（単純な
  // PER/PBR比較だけで割安・割高を判断しないという方針）。業種平均を
  // 出す仕組みが無いためROE同様「非対応」と明記する。
  if (Number.isFinite(r.evEbitda?.ratio)) {
    rows.push(['EV/EBITDA', fmt(r.evEbitda.ratio, '倍'), '業種平均非対応']);
  }
  // 時価総額も本来は同業他社比較の対象だが、業種平均時価総額を出す
  // ページがkabutan側に見当たらず非対応（ROEと同じ理由で「無い」ことを
  // 明示し、比較対象から静かに外すことはしない）。
  if (Number.isFinite(r.marketCap)) {
    rows.push(['時価総額', `${Math.round(r.marketCap / 100).toLocaleString()}億円`, '業種平均非対応']);
  }
  if (!rows.length) return '';
  return `<div class="peerbox">
        <div class="peerbox-head">同業他社比較 <span class="peerbox-sub">${esc(r.sectorName ?? '業種N/A')}</span></div>
        <table class="peer-table">
          <tr><th></th><th>個別</th><th>業種平均</th></tr>
          ${rows.map(([label, own, peer]) => `<tr><td>${esc(label)}</td><td>${own}</td><td>${peer}</td></tr>`).join('')}
        </table>
        ${ceilingPriceNote(r)}
      </div>`;
}

// netNet/lowPbr/pbrHistoricalLow・お宝候補は「下値」の裏付け（なぜ今が
// 割安か）を示すが、逆に「どこまで上がったらその裏付けが薄れるか」の
// 目安が無かった。上昇局面でこれらの緑チップだけを見ると、実際には
// 機関投資家の物色等で織り込まれつつある可能性を見落とし、「まだ割安
// だから」と高値まで買い上がるリスクがある（ユーザー指摘: 9052の
// 株価上昇局面で「割安」の根拠ばかりが並ぶ状態）。
// 業種平均PBRに現在のPBRが追いつく株価を、割安という相対評価の根拠が
// どこまで有効かの参考値として示す。overheatSignal（乖離+${OVERHEAT_KAIRI}%超の
// 短期過熱）とは別の切り口であることを明記する（短期的な過熱と中長期の
// バリュエーション上の参考値は別物であり、混同すると「乖離は正常だから
// まだ買える」と誤読されるおそれがあるため）。
//
// 第4優先改修（ユーザー報告）: 「業種平均PBRに到達する株価」という
// 機械的な計算結果を、あたかも「そこまで株価が上がる」という予測・
// 適正株価であるかのように読める表現になっていた（「目安株価」「到達」
// 「利益確定を検討」という言い回し）。業種平均PBRは同業他社の単純平均に
// すぎず、個別銘柄の理論株価・適正株価ではない。計算式自体（現在PBRが
// 業種平均PBRと数値上一致する株価）は変更せず、"PBRが業種平均まで戻れば
// 株価が○円になる"という予測ではなく"割安という相対評価の根拠が薄れて
// いく参考値"であることを明記する表現に改める。
export function ceilingPrice(r) {
  if (![r.pbr, r.sectorPbr, r.price].every(Number.isFinite) || r.pbr <= 0) return null;
  if (r.pbr >= r.sectorPbr) return null; // 既に業種平均以上なら「割安の相対評価」という前提自体が成立しない
  return Math.round(r.price * (r.sectorPbr / r.pbr));
}

export function ceilingPriceNote(r) {
  const cp = ceilingPrice(r);
  if (cp === null) return '';
  return `<div class="peerbox-note">📐 業種平均PBRとの相対差（参考値）：現在PBR${r.pbr}倍・業種平均PBR${r.sectorPbr}倍。同じ倍率だと仮定して機械的に計算すると株価は約${cp.toLocaleString()}円になりますが、これは株価がそこまで上がることを予測するものでも、適正株価・目標株価でもありません。株価が上がってこの水準に近づくほど「業種内で割安」という相対評価の根拠は薄れます（乖離+${OVERHEAT_KAIRI}%超の短期過熱とは別の、中長期の参考値です）</div>`;
}

// 「いつまでに仕込むべきか」の目安（ユーザー要望。AMBUSH専用——SMART
// ENTRYは決算スケジュールを見ない設計のため対象外）。
// AMBUSHは決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日を「狙い目」とし、
// 決算まで${WINDOW.nowMax + 1}〜45日は様子見期間として扱っている（section C
// の説明文と同じ考え方）。カード単体でも「いつ頃までに動くべきか」が
// 分かるよう、決算の実日付とゾーンの目安をここで明記する。
//
// 実測: AMBUSH候補の半数近く(23銘柄中10銘柄)はearningsDateStatusが
// 'estimated'（取引所未確定・前年同期を置き換えた参考値）でr.earningsDate
// がnullのため、r.earningsDateのみを見ているとこれらのカードに一切
// 表示されなかった。r.earningsDateRaw（"2026/09 下旬"等の旬表記。
// sbi.mjsの参考値はこの形式で入る）を目安としてフォールバックに使う。
//
// verdictを渡すのは矛盾防止のため。「狙い目ゾーン」はdaysLeft<=30の
// 機械的な判定だが、bucket='WATCH'（daysLeft 31〜45）でもスコア70以上・
// 先行カタリストありならambushVerdictは「買い推奨」を返しうる（rankOf
// はevidenceが有ればS/Aランクを止めない。bucket分けとverdict計算は
// 別々の条件式のため）。日数だけを見て「まだ様子見期間です」と言い
// 切ると、真上の「買い推奨」バッジと矛盾する（実測ではまだ発生して
// いないが、スコア70以上かつ先行カタリストありでdaysLeftが31〜45の
// 銘柄が現れれば必ず起きる）。verdictが'buy'のときは日数に関わらず
// 狙い目メッセージを優先する。
// entryTimingNote/exitPlanBlock（v7.4）共通の決算日ラベル算出。
function earningsDateLabel(r) {
  if (r.earningsDate) {
    return new Date(`${r.earningsDate}T00:00:00+09:00`).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });
  }
  if (r.earningsDateRaw) {
    return `${r.earningsDateRaw}ごろ（前年同期からの参考値・未確定）`;
  }
  return null;
}

export function entryTimingNote(r, verdict) {
  const daysLeft = r.daysLeft;
  if (!Number.isFinite(daysLeft)) return '';
  const dateLabel = earningsDateLabel(r);
  if (dateLabel === null) return '';
  // 実測バグ（v7.3でPRE-AMBUSH＝決算まで46〜60日を新設した際の再発）:
  // verdict==='buy'を無条件の上書き条件にしていたため、決算まで53〜59日
  // というPRE-AMBUSH（まだ早期監視段階）の米国株が、rank/scoreだけで
  // 'buy'判定になった途端「決算をまたぐ新規エントリーは避け、発表前には
  // 手仕舞いを検討してください」という差し迫った文言になってしまって
  // いた（この上書きは元々、WATCH帯(31〜45日)でも強い根拠があれば
  // 'buy'になりうるケース用に設計されたもので、PRE-AMBUSH帯(46〜60日)
  // までは想定していなかった）。上書きが効く範囲をWATCH帯の上限
  // （watchMax）までに制限する。
  // 横展開（exitPlanBlockのisBuyLikeとの非対称の再発防止）: 'buy'だけを
  // 見ていたため、将来strong_buy（VERDICT_SEVERITY上は既に存在するが
  // 現時点のambushVerdict/smartEntryVerdictからは未使用）が実際に返る
  // ようになった際、exitPlanBlock側は対応済みでもentryTimingNote側だけ
  // 取り残されて同じ矛盾が再発する。isBuyLikeと同じ判定に揃える。
  const isBuyLike = verdict?.level === 'strong_buy' || verdict?.level === 'buy';
  const inZone = daysLeft <= WINDOW.nowMax || (isBuyLike && daysLeft <= WINDOW.watchMax);
  const guidance = inZone
    ? `決算をまたぐ新規エントリーは避け、発表前には手仕舞いを検討してください`
    : `あと${daysLeft - WINDOW.nowMax}日ほどでAMBUSHの狙い目ゾーン（決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日）に入ります。それまでは様子見期間です`;
  return `<div class="timing-note">📅 決算発表 ${dateLabel}（あと${daysLeft}日）。${guidance}</div>`;
}

// v7.4改修（ユーザー要望）: 「いつまでに仕込むべきか」「いつどうなった
// タイミングで手放すべきか」を明示する。新しい判定ロジックは追加せず、
// 既存のWINDOW（決算までの日数）・verdict・overheatSignalの閾値
// （OVERHEAT_KAIRI）・repricingLagのzone・ceilingPrice（業種平均PBR
// 到達の目安株価）を、具体的なチェックリストとして再構成するだけ。
// AMBUSH専用（entryTimingNoteと同じ理由でSMART ENTRYは対象外——決算
// スケジュールを見ない設計のため「決算までの仕込み期限」という概念が
// 成立しない）。
export function exitPlanBlock(r, verdict) {
  const daysLeft = r.daysLeft;
  const dateLabel = earningsDateLabel(r);
  if (!Number.isFinite(daysLeft) || dateLabel === null) return '';

  // entryTimingNoteと同じ実測バグの再発防止（PRE-AMBUSH帯=決算まで
  // 46〜60日までisBuyLikeの上書きが効いてしまっていた）。上書きが効く
  // 範囲をWATCH帯の上限（watchMax=45日）までに制限する。
  const isBuyLike = (verdict?.level === 'strong_buy' || verdict?.level === 'buy') && daysLeft <= WINDOW.watchMax;
  let deadline;
  if (daysLeft < WINDOW.sweetMin && !isBuyLike) {
    deadline = `決算まであと${daysLeft}日と間近です。新規の仕込みは推奨しません（織り込み警戒ゾーン）`;
  } else if (daysLeft <= WINDOW.nowMax || isBuyLike) {
    deadline = `決算発表 ${dateLabel} の前営業日までが仕込み期限の目安です（あと${daysLeft}日）`;
  } else {
    deadline = `決算まであと${daysLeft}日。あと${daysLeft - WINDOW.nowMax}日でAMBUSHの狙い目ゾーンに入ります。仕込みはまだ早めです`;
  }

  // 第8優先改修（ユーザー報告）: 「決算をまたぐと危険」は検証済みの事実
  // ではなく、決算発表による急変動リスクを避けるためのリスク管理ルール
  // （RISK CONTROL RULE）として扱う。ルール自体（決算前に手仕舞う）は
  // 変更しない。決算を跨いだ場合との比較検証は、ambush_timing_backtest.mjs
  // が記録するdaysToEarnings/bucketのスナップショットを将来分析すれば
  // 可能（今回はバックテスト結果を捏造したり、最適な売却日数を決めたり
  // しない）。
  const exits = ['決算発表の前営業日までに手仕舞う（決算をまたぐリスクを避けるためのリスク管理ルールで、決算を跨いだ方が良い結果になるかは別途検証が必要です）'];
  exits.push('判定が🟠織り込み警戒／🔴見送りに悪化したら手放す（次回更新時に確認）');
  if (Number.isFinite(r.kairi)) {
    exits.push(`乖離率が+${OVERHEAT_KAIRI}%を超えたら手放す（現在${r.kairi >= 0 ? '+' : ''}${r.kairi}%）`);
  }
  if (r.repricingLag?.checked) {
    exits.push('妙味ゾーンが「織り込み済み」になったら手放す');
  }
  const cp = ceilingPrice(r);
  if (cp !== null) {
    exits.push(`業種平均PBRとの相対差の参考値（約¥${cp.toLocaleString()}、株価予測ではありません）に近づくほど「業種内で割安」の根拠が薄れるため、利益確定の検討材料にする`);
  }

  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 仕込み期限・手放すタイミング</div>
        <div class="exit-plan-deadline">${deadline}</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.4改修（ユーザー要望「SMART ENTRYにもない」）: SMART ENTRYは決算
// スケジュールを見ない設計のため「仕込み期限」（決算まで○日）という
// 概念自体が無いが、「手放すタイミング」はAMBUSHと同じ考え方
// （verdict・overheatの閾値・バリュエーション上限）で明示できる。
// exitPlanBlockとは別関数にする（daysLeft/earningsDateが無い前提の
// ロジックのため、無理に共通化すると条件分岐が複雑になる）。
export function smartEntryExitPlanBlock(r, verdict, overheat, growthSurge, patternExpired) {
  const exits = [
    patternExpired
      ? '選定時の仕込みパターン（①②③のいずれか）に該当しなくなったら手放す（現在: 該当なし）'
      : '選定時の仕込みパターン（①②③のいずれか）に該当しなくなったら手放す',
    '判定が様子見／見送りに悪化したら手放す（次回更新時に確認）',
  ];
  if (Number.isFinite(r.kairi)) {
    exits.push(`乖離率が+${OVERHEAT_KAIRI}%を超えたら手放す（現在${r.kairi >= 0 ? '+' : ''}${r.kairi}%）`);
  }
  if (growthSurge?.level === 'bad') {
    exits.push('急騰グロース（直近1ヶ月+50%超）は既に過熱、手放しを検討');
  }
  const cp = ceilingPrice(r);
  if (cp !== null) {
    exits.push(`業種平均PBRとの相対差の参考値（約¥${cp.toLocaleString()}、株価予測ではありません）に近づくほど「業種内で割安」の根拠が薄れるため、利益確定の検討材料にする`);
  }
  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 手放すタイミング</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.3改修（ユーザー指示書 項目15/16）: 「なぜこの銘柄が上位に来たのか」を
// 既存の各シグナルから組み立てて表示する。新しい判定ロジックは作らず、
// 既に計算済みの値（catalystTier/repricingLag/badChipSignals/daysLeft等）
// を5カテゴリ（上昇要因/未織り込み要因/タイミング要因/リスク/次に確認
// すべきイベント）に振り分けるだけ。checkReasonConsistency（項目17）が
// この戻り値をそのまま検証できるよう、表示文字列と生データの両方を
// 保持した構造で返す。
export function buildReasons(r, verdict) {
  const up = [];
  if (r.catalystTier) up.push({ text: `先行材料${r.catalystTier}ランク（${esc(r.catalysts?.[0]?.label ?? '')}）`, kind: 'catalyst' });
  if (r.progressStreak?.level === 'good') up.push({ text: '業績の進捗率が連続上振れ', kind: 'profit_improving' });
  if (Number.isFinite(r.score) && r.score >= 70) up.push({ text: `SCORE(素点)${r.score}と高水準`, kind: 'score' });

  const unpriced = [];
  if (r.repricingLag?.checked && (r.repricingLag.zone === 'pre_move' || r.repricingLag.zone === 'early_move')) {
    unpriced.push({ text: `妙味スコア${r.repricingLag.score}/100（${REPRICING_ZONE[r.repricingLag.zone]?.label ?? r.repricingLag.zone}）`, kind: 'unpriced' });
  }

  const timing = [];
  if (Number.isFinite(r.daysLeft)) timing.push({ text: `決算まで${r.daysLeft}日`, kind: 'timing' });

  const risks = badChipSignals(r).map((s) => ({ text: s.note ?? s.label, kind: 'risk' }));

  const nextEvents = [];
  if (r.earningsDate) nextEvents.push({ text: `次回決算（${esc(r.earningsDate)}）`, kind: 'event' });
  else if (r.earningsDateRaw) nextEvents.push({ text: `次回決算（${esc(r.earningsDateRaw)}ごろ・未確定）`, kind: 'event' });

  return { up, unpriced, timing, risks, nextEvents };
}

function reasonBlock(r, verdict) {
  const reasons = buildReasons(r, verdict);
  const groups = [
    ['📈 上昇要因', reasons.up], ['🔍 未織り込み要因', reasons.unpriced],
    ['⏱ タイミング要因', reasons.timing], ['⚠️ リスク', reasons.risks],
    ['🔔 次に確認すべきイベント', reasons.nextEvents],
  ].filter(([, items]) => items.length);
  if (!groups.length) return '';
  return `<div class="reason-block">
        ${groups.map(([title, items]) => `<div class="reason-group"><span class="reason-title">${title}</span><ul>${items.map((i) => `<li>${i.text}</li>`).join('')}</ul></div>`).join('')}
      </div>`;
}

// A指示 項目40/41「最終出力に『今なぜ仕込むのか』を必ず表示」:
// なぜ今？（業績・株価・未織り込み・カタリストを要約した文章）＋
// 最大のリスク＋次に確認する数字＋買い増し条件＋見送り条件。
// reasonBlockは箇条書きの一覧だが、指示書は「2〜4行の要約文章」を
// 求めていたため、既存のbuildReasons()の中身を再利用しつつ文章として
// 組み立て直す（新規計算は要約文・買い増し/見送り条件のみ）。
export function whyNowBlock(r, verdict) {
  const reasons = buildReasons(r, verdict);
  const whyParts = [...reasons.up.map((i) => i.text), ...reasons.unpriced.map((i) => i.text)];
  if (!whyParts.length) return '';
  const whyNow = `${whyParts.join('。')}。`;

  const biggestRisk = reasons.risks[0]?.text
    ?? '特に大きなリスクは検出されていません（自動取得できないリスク要因が残っている可能性はあります）';

  const nextChecks = [
    ...reasons.nextEvents.map((i) => i.text),
    Number.isFinite(r.revenueGrowthPct) ? '売上高成長率の維持・鈍化' : null,
    r.repricingLag?.checked ? '仕込みゾーンの変化（初動→再評価進行→過熱警戒への移行）' : null,
  ].filter(Boolean);

  const zoneLabel = r.repricingLag?.checked ? REPRICING_ZONE[r.repricingLag.zone]?.label ?? '仕込みゾーン' : null;
  const addMoreCondition = zoneLabel
    ? `${zoneLabel}のまま業績改善（売上・利益成長率）が続けば買い増しを検討できます`
    : '業績改善（売上・利益成長率）が確認できれば買い増しを検討できます';
  const passCondition = riskLevel(r) === 'HIGH' || riskLevel(r) === 'UNKNOWN' || r.repricingLag?.zone === 'priced_in'
    ? '既にリスクシグナルが複数該当、または株価が織り込み済みの水準まで動いています。ここからの新規の買い増しは見送るのが無難です'
    : '仕込みゾーンが「過熱警戒」「織り込み済み」まで進む、または新たなリスクシグナルが出た場合は見送りを検討してください';

  return `<div class="why-now-block">
        <div class="why-now-item"><span class="why-now-h">🤔 なぜ今？</span><p>${esc(whyNow)}</p></div>
        <div class="why-now-item"><span class="why-now-h">⚠️ 最大のリスク</span><p>${esc(biggestRisk)}</p></div>
        ${nextChecks.length ? `<div class="why-now-item"><span class="why-now-h">🔍 次に確認する数字</span><ul>${nextChecks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
        <div class="why-now-item"><span class="why-now-h">➕ 買い増し条件</span><p>${esc(addMoreCondition)}</p></div>
        <div class="why-now-item"><span class="why-now-h">➖ 見送り条件</span><p>${esc(passCondition)}</p></div>
      </div>`;
}

// v7.3改修 項目17: 生成した理由文と数値の整合性チェック。ユーザー例
// （「業績改善」なのに利益-19%、「買い候補」なのに重大リスクが複数ある
// 場合に警告）をそのままロジック化する。verdictはambushVerdict/
// smartEntryVerdictの`worsen()`カスケードで既にbad系シグナルがあれば
// hold以下に落ちる設計のため、通常は矛盾しないはずだが、新しいシグナルを
// 追加した際に配線を忘れる再発（ALOY repricingLagの実例）を検知する
// セーフティネットとして機能する。
export function checkReasonConsistency(r, verdict, reasons) {
  const warnings = [];
  const isBuyLike = verdict?.level === 'strong_buy' || verdict?.level === 'buy';
  if (reasons.up.some((i) => i.kind === 'profit_improving') && Number.isFinite(r.earningsTrend?.netIncomeGrowthPct) && r.earningsTrend.netIncomeGrowthPct < 0) {
    warnings.push(`上昇要因に業績改善の記述があるが、利益成長率は${r.earningsTrend.netIncomeGrowthPct}%とマイナス`);
  }
  // v7.6改修（A指示 項目25/26「売上-5%・利益-57%なのに業績改善と表示する
  // ような矛盾を禁止」の横断監査で発覚）: 上のチェックはUS側の
  // earningsTrendしか見ておらず、'profit_improving'の実際の発生源である
  // JP側のprogressStreak（buildReasonsの'up'を参照）とは一致しない
  // 組み合わせだった（progressStreak.level==='good'はprogressStreakSignal
  // 自身が既にprofitYoyPct<0ならwarnに格下げする設計のため、実際には
  // 到達し得ない「死んだ」チェックになっていた）。progressStreak側の
  // profitYoyPctも同じ意図で見ておくことで、将来progressStreakSignalの
  // 内部ロジックが変わってこの安全装置が壊れた場合にも検知できるようにする。
  if (reasons.up.some((i) => i.kind === 'profit_improving') && Number.isFinite(r.progressStreak?.profitYoyPct) && r.progressStreak.profitYoyPct < 0) {
    warnings.push(`上昇要因に業績改善の記述があるが、進捗率の裏付けとなる利益成長率は${r.progressStreak.profitYoyPct}%とマイナス`);
  }
  if (isBuyLike && r.consensusTrap?.level === 'bad') {
    warnings.push(`verdictは${verdict.label}だがconsensusTrapは期待過剰(bad)`);
  }
  if (isBuyLike && reasons.risks.length >= 2) {
    warnings.push(`verdictは${verdict.label}だがリスクが${reasons.risks.length}件検出されている（worsen()配線漏れの疑い）`);
  }
  return warnings;
}

// コンセンサス（アナリスト予想）が無い銘柄は、自分ルールの「期待値」行や
// SMART ENTRYパターン③の「コンセンサス差」が常にN/Aになる。それ自体は
// 正しい表示（存在しないデータを捏造しない）だが、代わりに参照できる
// 根拠（お宝候補・解散価値割れ・PBR・配当の「過去の事実」系シグナル。
// VALUATION_CHIP_FIELDS）が bottomChips の中に埋もれてチップのラベルだけ
// しか見えず、根拠の中身（実際の数値）はホバー時のtitle属性頼みだった。
// スマホでは長押ししないとtitleが見えないため見落としやすい。ここでは
// 常時見える形で中身をそのまま列挙する（ユーザー要望: 視覚的な分かり
// やすさ・代替根拠の記載を増やす）。
export function consensusEvidenceBlock(r) {
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  if (hasConsensus) return '';
  const items = VALUATION_CHIP_FIELDS
    .map((k) => r[k])
    .filter((s) => s && (s.level === 'good' || s.level === 'warn') && s.note);
  if (!items.length) return '';
  return `<div class="altbox">
        <div class="altbox-head">📊 コンセンサス非公開 — 代わりの根拠</div>
        <ul class="altbox-list">${items.map((s) => `<li><b>${esc(s.label)}</b>：${esc(s.note)}</li>`).join('')}</ul>
      </div>`;
}

// creditAsOf（"26/09/18"のような2桁年/ゼロ埋め月日）をカード表示用に
// "9/18"へ短縮する（年は当年表示が前提の週次テーブルのため省略）。
function formatCreditAsOf(dateStr) {
  const m = /^\d{2}\/(\d{2})\/(\d{2})$/.exec(dateStr ?? '');
  if (!m) return dateStr ?? '—';
  return `${Number(m[1])}/${Number(m[2])}`;
}

const CREDIT_PATTERN_ARROWS = {
  CLEANUP: '株価 ↓ × 買残 ↓',
  OVERHANG_BUILDUP: '株価 ↓ × 買残 ↑',
  SUPPLY_IMPROVING: '株価 ↑ × 買残 ↓',
  LEVERAGED_RISE: '株価 ↑ × 買残 ↑',
};

const BOUNCE_QUALITY_TEXT = {
  IMPROVING: { arrow: '株価 ↑ × 買残 ↓', label: '需給改善' },
  WEAK: { arrow: '株価 ↑', label: '信用整理を伴わない反発' },
  PENDING: { arrow: '株価 ↑ × 出来高 ↑', label: '信用データ未反映（確認中）' },
};

export function creditSupplyQualityBlock(r) {
  const cs = r.creditSupplyQuality;
  if (!cs || !cs.checked) return '';
  const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '▲' : '▼'}${Math.abs(v)}%` : '—');

  const pressureLabel = buyPressureBandLabel(cs.buyPressureDays);
  const pressureRow = Number.isFinite(cs.buyPressureDays)
    ? `<div class="csq-row"><span class="csq-k">買残負担</span><span class="csq-v">${cs.buyPressureDays}日</span><span class="csq-tag">${esc(pressureLabel)}</span></div>`
    : '';

  const patternArrow = cs.pattern ? CREDIT_PATTERN_ARROWS[cs.pattern] : null;
  const patternLabel = cs.pattern ? CREDIT_PATTERN[cs.pattern]?.label : null;
  const patternBlock = patternArrow
    ? `<div class="csq-sub"><div class="csq-sub-head">需給変化</div><div class="csq-sub-arrow">${esc(patternArrow)}</div><div class="csq-sub-result">→ ${esc(patternLabel)}</div></div>`
    : '';

  const bq = cs.bounceQuality ? BOUNCE_QUALITY_TEXT[cs.bounceQuality] : null;
  const bounceBlock = bq
    ? `<div class="csq-sub"><div class="csq-sub-head">反発品質</div><div class="csq-sub-arrow">${esc(bq.arrow)}${Number.isFinite(cs.avgVolumeRatio) ? `<br>出来高 ${cs.avgVolumeRatio}×` : ''}</div><div class="csq-sub-result">→ ${esc(bq.label)}</div></div>`
    : '';

  return `<div class="credit-supply">
        <div class="csq-head">信用需給</div>
        <div class="csq-row"><span class="csq-k">買残</span><span class="csq-v">${Number.isFinite(cs.buyBalance) ? cs.buyBalance.toLocaleString() : '—'}株</span><span class="csq-chg ${cs.buyChangePct >= 0 ? 'up' : 'down'}">${signed(cs.buyChangePct)}</span></div>
        <div class="csq-row"><span class="csq-k">売残</span><span class="csq-v">${Number.isFinite(cs.sellBalance) ? cs.sellBalance.toLocaleString() : '—'}株</span><span class="csq-chg ${cs.sellChangePct >= 0 ? 'up' : 'down'}">${signed(cs.sellChangePct)}</span></div>
        <div class="csq-row"><span class="csq-k">信用倍率</span><span class="csq-v">${fmt(cs.creditRatio, '倍')}</span></div>
        ${pressureRow}
        ${patternBlock}
        ${bounceBlock}
        <div class="csq-foot">最終信用残 ${esc(formatCreditAsOf(cs.creditAsOf))}${Number.isFinite(cs.creditDataAgeDays) && cs.creditDataAgeDays > 0 ? `（${cs.creditDataAgeDays}日前）` : ''}</div>
      </div>`;
}

// 第9優先改修 Phase6（ユーザー提案）: 信用需給タグでのワンタップ絞り込み。
// CREDIT_SUPPLY_TAGS/creditSupplyTags自体はindicators.mjsに定義（純粋な
// ラベル化ロジックのため、需給タイムライン（creditSupplyTimeline）とも
// 共有する）。ここではUIの組み立てのみ行う。
//
// 複数タグを選んだ場合はAND（絞り込みが進むほど対象が狭まる）にする。
// タグはほぼ排他的なcreditPattern由来（同時に複数該当しない）のため、
// 2つ選ぶと「その組み合わせに完全一致する銘柄だけ」になる想定（例:
// 「需給改善」×「信用買い重い」＝需給は改善しつつまだ買い残の絶対量は
// 重い銘柄、のような絞り込み）。クリックしたタグ名をdata-tagとして
// button要素に持たせ、JS側（toggleCreditFilter）でトグルする。
export function creditFilterBar() {
  const chips = CREDIT_SUPPLY_TAGS
    .map((t) => `<button type="button" class="credit-filter-chip" data-tag="${esc(t)}" onclick="toggleCreditFilter('${esc(t)}')">${esc(t)}</button>`)
    .join('');
  return `<div class="credit-filter-bar" id="credit-filter-bar">
    <span class="credit-filter-label">信用需給で絞り込み</span>
    ${chips}
    <button type="button" class="credit-filter-clear" onclick="clearCreditFilter()">クリア</button>
  </div>`;
}

// 第9優先改修 Phase6 ④（ユーザー提案）: 需給タイムライン。
// creditSupplyTimeline（indicators.mjs）が整形済みのデータをSVGで
// 描くだけで、ここでも新しい判定は行わない。カードを開かずに見える
// 大きさに収める（「チャートを見るためにカードを開く」のではなく、
// カードを見た瞬間に需給の流れが分かるサイズ、というユーザー要望）。

// ISO日付("2026-08-07")をラベル用に"08/07"へ短縮する。
function formatTimelineDate(iso) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[1]}/${m[2]}` : (iso ?? '—');
}

// 信用買残バー（横棒グラフ）。最大値を基準に正規化（＝同一銘柄内の
// 時系列比較が目的。銘柄間比較のための絶対値スケールではない、という
// ユーザー方針どおり）。
function timelineBuyBars(points, w, h) {
  const vals = points.map((p) => p.buyBalance);
  const finite = vals.filter(Number.isFinite);
  const max = finite.length ? Math.max(...finite) : 0;
  const n = vals.length || 1;
  const gap = w / n;
  const barW = Math.max(gap * 0.55, 2);
  const bars = vals.map((v, i) => {
    if (!Number.isFinite(v) || max <= 0) return '';
    const barH = Math.max((v / max) * (h - 3), 1);
    const x = i * gap + (gap - barW) / 2;
    const y = h - barH;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="#22ffc4" fill-opacity="0.85"/>`;
  }).join('');
  return `<svg class="ctl-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
}

// 売残・株価用の細線。null（データ欠損）をまたぐ区間は補間せず線を切る
// （ユーザー方針「推測値による補完は禁止」）ため、null点で複数の
// <polyline>に分割する。1〜2点しか有効値が無い場合は線を引かず終値点
// だけ打つ（折れ線として意味を持たないため）。
function timelineLine(values, w, h, color, { pad = 2, dot = false } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return `<svg class="ctl-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  const min = Math.min(...finite), max = Math.max(...finite);
  const range = max - min || 1;
  const n = values.length;
  const xy = values.map((v, i) => (Number.isFinite(v)
    ? [n > 1 ? (i / (n - 1)) * w : w / 2, h - ((v - min) / range) * (h - pad * 2) - pad]
    : null));
  const segments = [];
  let current = [];
  for (const p of xy) {
    if (p === null) { if (current.length >= 2) segments.push(current); current = []; }
    else current.push(p);
  }
  if (current.length >= 2) segments.push(current);
  const polylines = segments.map((seg) => {
    const pts = seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const dots = dot ? xy.filter(Boolean).map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" fill="${color}"/>`).join('') : '';
  return `<svg class="ctl-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${polylines}${dots}</svg>`;
}

const CTL_W = 160, CTL_BAR_H = 26, CTL_LINE_H = 16;

export function creditSupplyTimelineBlock(r) {
  const tl = r.creditSupplyTimeline;
  if (!tl || !tl.checked || !tl.points.length) {
    return `<div class="credit-timeline is-empty">
        <div class="ctl-head">需給タイムライン</div>
        <div class="ctl-empty">データ不足</div>
      </div>`;
  }
  const pts = tl.points;
  const n = pts.length;
  const priceUp = Number.isFinite(pts.at(-1)?.close) && Number.isFinite(pts[0]?.close) && pts.at(-1).close >= pts[0].close;

  const buyBars = timelineBuyBars(pts, CTL_W, CTL_BAR_H);
  const sellLine = timelineLine(pts.map((p) => p.sellBalance), CTL_W, CTL_LINE_H, '#8aa0c0');
  const priceLine = timelineLine(pts.map((p) => p.close), CTL_W, CTL_LINE_H, priceUp ? '#22ffc4' : '#ff3d71', { dot: true });

  const dateLabels = n <= 4
    ? `<div class="ctl-dates">${pts.map((p) => `<span>${esc(formatTimelineDate(p.date))}</span>`).join('')}</div>`
    : `<div class="ctl-dates ctl-dates-endpoints"><span>${esc(formatTimelineDate(pts[0].date))}</span><span class="ctl-date-arrow">→</span><span>${esc(formatTimelineDate(pts.at(-1).date))}</span></div>`;

  const tagsLine = tl.tags.length
    ? `<div class="ctl-tags">${tl.tags.map((t) => `<span class="ctl-tag">✓ ${esc(t)}</span>`).join('')}</div>`
    : '';

  return `<div class="credit-timeline">
        <div class="ctl-head">需給タイムライン${tl.pending ? '<span class="ctl-pending">PENDING</span>' : ''}</div>
        <div class="ctl-row"><span class="ctl-label">買残</span>${buyBars}</div>
        <div class="ctl-row"><span class="ctl-label">売残</span>${sellLine}</div>
        <div class="ctl-row"><span class="ctl-label">株価</span>${priceLine}</div>
        ${dateLabels}
        ${tagsLine}
        <div class="ctl-foot">最終信用残 ${esc(formatTimelineDate(tl.latestDate))}</div>
      </div>`;
}

// 配当金推移（円/株・実績）と増配/減配履歴を表示する。IR Bankの
// dividendページを既に取得済み（dividendPeak算出のため）なので、
// 追加リクエストなしで表示できる。
function dividendTrendBlock(r) {
  const yen = r.dividendYenHistory ?? [];
  if (yen.length < 2) return '';
  const trail = yen.map((y) => y.amount).join('→');
  let note;
  if (r.dividendStreakYears >= 2) {
    note = r.dividendStreakDirection === 'up'
      ? `${r.dividendStreakYears}期連続増配中`
      : `${r.dividendStreakYears}期連続減配`;
  } else {
    const last = yen.at(-1).amount;
    const prev = yen.at(-2).amount;
    note = last > prev ? '直近は増配' : last < prev ? '直近は減配' : '直近は据え置き';
  }
  return `<div class="divtrend">
        <span class="divtrend-head">配当金推移(円)</span>
        <span class="divtrend-row">${esc(trail)}</span>
        <span class="divtrend-note">${esc(note)}</span>
      </div>`;
}

// 仕込み妙味スコア（Repricing Lag、ユーザー提案）— screener.mjs/
// us_screener.mjsが計算したrepricingLag（score/zone/breakdown/生値）を
// カードに表示する。目的は「割安」の発見ではなく「業績側は改善している
// のに株価がまだ反応していない（再評価が遅れている）銘柄」を仕込み前に
// 見つけること（ユーザー指定の最重要ルール＝12番目の指示）。
// ナラティブは自然言語の完全自動生成ではなく、実測値をそのまま埋め込む
// 定型文生成（スコアの内訳を捏造しない）。zone:priced_inでもオーバー
// ライドルールの説明として表示自体は行う（除外は呼び出し側のverdictの
// 仕事であり、この関数はあくまで根拠の可視化に徹する）。
// A指示 項目25「自動生成説明文の矛盾を完全修正」: 増収増益→業績改善・
// 減収減益→業績悪化・増収減益→売上は改善、利益は悪化・減収増益→
// 売上は悪化、利益率改善・データ不足→業績判定不能、の5パターンを
// そのままロジック化する。データが片方だけある場合はその一方だけで
// 判定する（推測で埋めない）。
function performanceDirectionText(revenueGrowthPct, profitGrowthPct) {
  const revenueUp = Number.isFinite(revenueGrowthPct) ? revenueGrowthPct > 0 : null;
  const profitUp = Number.isFinite(profitGrowthPct) ? profitGrowthPct > 0 : null;
  if (revenueUp === null && profitUp === null) return '業績判定不能';
  if (revenueUp === null || profitUp === null) {
    const up = revenueUp ?? profitUp;
    return up ? '業績改善' : '業績悪化';
  }
  if (revenueUp && profitUp) return '業績改善';
  if (!revenueUp && !profitUp) return '業績悪化';
  if (revenueUp && !profitUp) return '売上は改善、利益は悪化';
  return '売上は悪化、利益率改善';
}

// A指示 項目6「『仕込みゾーン』を5段階に変更する」: 🟢初動前・🟢初動
// （まだ仕込める＝pre_moveと同じ「良い」系統として緑に統一）・
// 🟡再評価進行・🟠過熱警戒（新設）・🔴織り込み済みの5段階。
const REPRICING_ZONE = {
  pre_move: { emoji: '🟢', label: '初動前', cls: 'mint' },
  early_move: { emoji: '🟢', label: '初動', cls: 'mint' },
  re_rating: { emoji: '🟡', label: '再評価進行', cls: 'amber' },
  overheated: { emoji: '🟠', label: '過熱警戒', cls: 'amber' },
  priced_in: { emoji: '🔴', label: '織り込み済み', cls: 'red' },
};

// Repricing Gap（再評価余地）の表示行。仕込み妙味スコア（repricingLagScore、
// zone/whyNote/caveat）とは独立した別指標のため、repricingLagBlock本体の
// 文言（whyNote/caveat）は一切変更せず、この行だけを差し替える。
// 「なぜGapが出たのか」を内訳（業績側・株価側）で見せる（ユーザー要望）。
function repricingGapLine(rl) {
  if (!Number.isFinite(rl.repricingGap)) return '';
  const d = repricingGapBreakdown({
    revenueGrowthPct: rl.revenueGrowthPct, profitGrowthPct: rl.profitGrowthPct,
    return1m: rl.return1m, sectorReturn1m: rl.sectorReturn1m,
  });
  const signed = (v) => `${v > 0 ? '+' : ''}${v}%`;
  const perfPart = d.performanceRate === null ? '業績データ不足' : `業績改善(実績YoY平均)${signed(d.performanceRate)}`;
  const pricePart = d.priceReaction === null
    ? '株価反応データ不足'
    : `株価反応(1ヶ月${d.sectorAdjusted ? '・業種相対' : ''})${signed(d.priceReaction)}`;
  // 業績も株価もマイナスの場合、Gapが正でも「未織り込み」の意味ではない
  // （株価が業績以上に売られているだけの可能性がある）ため注記する。
  const overshootNote = d.performanceRate !== null && d.performanceRate <= 0 && rl.repricingGap > 0
    ? '　※業績側もマイナスのため「未織り込み」ではなく株価の下振れ超過の可能性があります'
    : '';
  return `<li title="業績側(売上・利益成長率YoYの平均、±${REPRICING_GAP.growthCapPct}%で丸め)－株価側(直近1ヶ月の騰落率、可能なら同業種の同期間騰落率を差し引いた超過リターン)の差。妙味スコアとは別の単独指標（v2再設計）">Repricing Gap（再評価余地）：${rl.repricingGap > 0 ? '+' : ''}${rl.repricingGap}pt　${perfPart} − ${pricePart}${overshootNote}</li>`;
}

export function repricingLagBlock(r, { isUs = false } = {}) {
  const rl = r.repricingLag;
  if (!rl || !rl.checked || !rl.zone) return ''; // データ不足時は「無い」ことにする（捏造しない）
  const z = REPRICING_ZONE[rl.zone];
  if (!z) return '';
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : 'データ無し');
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  // 52週高値は米国株のみ取得できる（Yahoo Financeのmeta由来）。日本株は
  // 同等データを安価に取る手段が見つからなかったため、priceLevelVsRange
  // （直近60営業日＝約3ヶ月レンジでの位置）で代用する（計画時に明記済み
  // のPhase 1の非対称な扱い）。
  const priceLevelLabel = isUs ? '52週レンジ内の位置' : '直近3ヶ月レンジ内の位置（52週データの代用）';
  const growthText = Number.isFinite(rl.revenueGrowthPct) || Number.isFinite(rl.profitGrowthPct)
    ? `売上高${pct(rl.revenueGrowthPct)}${Number.isFinite(rl.profitGrowthPct) ? `・利益${pct(rl.profitGrowthPct)}` : ''}`
    : null;
  // A指示 項目25「自動生成説明文の矛盾を完全修正」実例（「売上-5%、
  // 利益-57%と業績側は改善」は禁止）の再発防止。実測バグ: 従来は
  // growthTextが存在すれば（＝データさえあれば）無条件に「業績側は
  // 改善が見られる」と書いており、実際の符号を一切見ていなかった
  // （zone=pre_move/early_moveはprogressStreakの加点だけでimprovement>0
  // になり得るため、売上・利益が両方マイナスでもこの文言に到達し得た）。
  const performanceDirectionLabel = performanceDirectionText(rl.revenueGrowthPct, rl.profitGrowthPct);
  const valuationText = Number.isFinite(rl.per) && Number.isFinite(rl.sectorPer)
    ? `PER${rl.per}倍（業種平均${rl.sectorPer}倍）`
    : Number.isFinite(rl.psr) ? `PSR${r2(rl.psr)}倍` : '株価指標データ不足';

  // A指示 項目26「52週位置と騰落率の矛盾を説明する」実例（1M+4%なのに
  // 52週位置95%→「まだ反応が乏しい」という文章は禁止）の再発防止:
  // 直近1ヶ月/3ヶ月の騰落率だけを見て「まだ反応が乏しい」と言い切ると、
  // レンジ内の位置自体が既に高値圏（re_rating/overheated、上のzone
  // 判定ロジックで既にそう分類済み）の銘柄と矛盾する。zoneがpre_move/
  // early_move（本当に反応が乏しい早期段階）の場合だけこの文言を使い、
  // re_rating/overheatedは「短期の上昇は小さくても長期的には既に高値圏」
  // という正しい説明にする。
  let whyNote;
  if (rl.zone === 'priced_in') {
    whyNote = `直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}と株価が既に大きく動いており、期待が織り込まれ始めている可能性が高いため、新規の仕込み対象としては見送り推奨です。`;
  } else if (rl.zone === 're_rating' || rl.zone === 'overheated') {
    const growthPart = growthText ? `${growthText}（${performanceDirectionLabel}）に対し、` : '';
    // re_ratingは「短期の上昇は小さいがレンジ内の位置は既に高い」場合と
    // 「短期の上昇自体が既に一定水準に達している」場合の2通りで発生する
    // ため、実際のpriceLevelPctを見て文言を出し分ける（zoneラベルだけで
    // 「高値圏」と決め打ちしない）。
    whyNote = Number.isFinite(rl.priceLevelPct) && rl.priceLevelPct >= 70
      ? `${growthPart}直近1ヶ月の上昇は${pct(rl.return1m)}と限定的でも、${priceLevelLabel}${fmt(rl.priceLevelPct, '%')}と長期的には既に高値圏に位置しているため、新規の仕込み妙味は低下しています。`
      : `${growthPart}株価は直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}と既に動き始めており、初動〜再評価の段階に入っている可能性があります。新規の仕込みは値動きを確認しながら慎重に判断してください。`;
  } else if (growthText) {
    whyNote = `${growthText}（${performanceDirectionLabel}）に対し、株価は直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}とまだ反応が乏しく（${priceLevelLabel}${fmt(rl.priceLevelPct, '%')}）、再評価が遅れている可能性があります。`;
  } else {
    whyNote = `株価は直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}と動いていますが、売上・利益成長率のデータが不足しており、業績改善の裏付けは確認できていません。`;
  }
  // ユーザー指定の必須項目「既に織り込まれている可能性」への言及は、
  // ゾーン判定に関係なく必ず併記する（このスコアはSNS言及数・検索急増・
  // アナリスト評価の変化・決算以外のイベントを一切見ていないため）。
  const caveat = rl.zone === 'priced_in'
    ? 'オーバーライドルール発動：直近の急騰により、内訳スコアに関係なく強制的に「織り込み済み」と判定しています。'
    : `内訳スコア${rl.score}/100点。SNS言及数・検索急増・アナリスト評価の変化・決算以外のイベントは自動取得できていないため（Phase 1の既知の限界）、実際には既に一部織り込まれている可能性もある点にご注意ください。`;

  return `<div class="repricing">
        <div class="repricing-head"><span class="chip ${z.cls}">${z.emoji} 仕込みゾーン：${z.label}</span><span class="repricing-score" title="上部のSCOREとは別軸（今から買うタイミング/織り込み度）。SCOREによる順位には使っていません。未織り込み度・業績改善・株価割安度・成長率・先行材料・イベントの6要素を合成した相対評価で、目標株価や期待リターン(%)を意味する数値ではありません（第4優先改修で明記）">妙味スコア ${rl.score}/100</span></div>
        <ul class="repricing-fields">
          <li>${priceLevelLabel}：${fmt(rl.priceLevelPct, '%')}</li>
          <li>1ヶ月騰落率：${pct(rl.return1m)}　3ヶ月騰落率：${pct(rl.return3m)}</li>
          <li>${valuationText}</li>
          <li>成長率：${growthText ?? 'データ不足'}</li>
          <li>先行材料：${rl.hasCatalyst ? 'あり' : 'なし／未検出'}　次回決算まで：${Number.isFinite(rl.daysToEarnings) ? `あと${rl.daysToEarnings}日` : '不明'}</li>
          ${repricingGapLine(rl)}
        </ul>
        <div class="repricing-why">${esc(whyNote)}</div>
        <div class="repricing-caveat">⚠️ ${esc(caveat)}</div>
      </div>`;
}

const kairiTone = (k) => (k === null ? '' : k < 0 ? 'up' : k > 5 ? 'down' : '');
const rsiTone = (v) => (v === null ? '' : v > 70 ? 'down' : v < 40 ? 'up' : '');
const volZTone = (v) => (v === null ? '' : v > 2 ? 'down' : v < 0 ? 'up' : '');
const progressTone = (p, basis) => {
  if (p === null || basis === null) return '';
  const excess = p - basis;
  return excess >= 5 ? 'up' : excess < -10 ? 'down' : '';
};

// 進捗率は「何に対する%か」で意味が変わる。基準だけでなく分母も出す。
// 例: 次回本決算＋対通期 →「基準75% · 通期」、次回中間＋対上期 →「基準50% · 上期」
function progressBasisLabel(r) {
  if (r.progressBasis === null || r.progressBasis === undefined) {
    // 次回がQ1の銘柄は当期の累計実績が無く進捗率が定義上N/Aになるが、
    // 過去のQ1が年間実績に占めていた比率（決算のクセ）が分かれば
    // 「1Q発表を待たずにどの程度を期待してよいか」の参考になる。
    if (r.quarter === '1Q' && r.q1Seasonality) {
      return `進捗N/A（過去Q1平均${r.q1Seasonality.avgSharePct}%）`;
    }
    return r.progress === null || r.progress === undefined ? '進捗N/A' : '基準N/A';
  }
  const denom = r.progressSource === 'sbi'
    ? '通期·SBI'
    : r.progressLabel?.includes('対上期') ? '上期·株探'
    : r.progressLabel?.includes('対通期') ? '通期·株探' : '株探';
  return `基準${r.progressBasis}% · ${denom}`;
}

// セクション内の表示順そのものを「順位」として見せるバッジ。
// 既存の並び順（AMBUSHはevidence優先→score順、SMART ENTRYはmatched数→
// 乖離が深い順）を変えずに、その順位を数字として可視化するだけ。
function rankBadge(i) {
  const n = i + 1;
  const cls = n === 1 ? 'r1' : n === 2 ? 'r2' : n === 3 ? 'r3' : '';
  return `<span class="rankpos ${cls}">${n}位</span>`;
}

// 順位はambushConviction（素点score＋底打ち確認/同業他社比較の裏付け
// 加点）で決まるため、素点(scoreGauge)だけを見ているとスコアが低い
// 銘柄が上位に来て矛盾しているように見える（実測で発生：3333あさひ
// score48が3038神戸物産score49より上位）。加点があるときだけ、その
// 内訳が分かる注記を素点の下に出す。
export function convictionNote(r) {
  // AMBUSH_BONUS_FIELDS/AMBUSH_PENALTY_FIELDS（screener.mjs）をそのまま
  // importして使う。以前はここに独自の信号リストをハードコードしており、
  // ambushConvictionが加点対象を追加してもここを更新し忘れる抜けが実際に
  // 起きていた（institutionalShort・majorShareholderが実スコアには
  // 反映されているのに「+pt」の内訳表示には出ていなかった）。単一の
  // 情報源にすることで構造的に再発しないようにする。
  // retailExpectationSignal（個人投資家の期待織り込み）導入でambush
  // Convictionに初めて減点が入ったため、この表示も加点だけでなく
  // 減点込みの正味の増減を出す（減点だけ表示から漏れると、同じ
  // 「表示と実スコアの不一致」バグを繰り返すことになる）。
  const bonusCount = AMBUSH_BONUS_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good').length;
  const streakBonus = (r.dividendStreakYears >= 3 && r.dividendStreakDirection === 'up') ? 1 : 0;
  const badPenaltyCount = AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'bad').length;
  const warnPenaltyCount = AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn').length;
  if (bonusCount === 0 && streakBonus === 0 && badPenaltyCount === 0 && warnPenaltyCount === 0) return '';
  const bonus = (bonusCount + streakBonus) * 5;
  const penalty = badPenaltyCount * 10 + warnPenaltyCount * 4;
  const net = bonus - penalty;
  const parts = [];
  if (bonusCount > 0) parts.push(`底打ち確認等の裏付け${bonusCount}件(+${bonusCount * 5}点)`);
  if (streakBonus) parts.push(`${r.dividendStreakYears}期連続増配(+5点)`);
  if (badPenaltyCount > 0) parts.push(`個人投資家の期待織り込み大${badPenaltyCount}件(-${badPenaltyCount * 10}点)`);
  if (warnPenaltyCount > 0) parts.push(`個人投資家の期待織り込み注意${warnPenaltyCount}件(-${warnPenaltyCount * 4}点)`);
  const sign = net >= 0 ? '+' : '';
  const total = (r.score ?? 0) + net;
  // 実測の「違和感」: リング表示のSCORE（素点）だけを見ると、SCOREが
  // 低い銘柄がSCOREの高い銘柄より上位に来ているように見え、順位が
  // おかしいと誤解されやすかった（例: SCORE73の銘柄がSCORE83の銘柄より
  // 上位——実際はconviction 98 vs 83で正しい）。以前は差分（+25pt）だけを
  // 表示しており、素点への加算を暗算しないと実際の順位用の値が分から
  // なかった。「順位」というラベルと、暗算不要で分かる合計値を前面に
  // 出すことで、SCOREと順位が別の指標であることをその場で示す。
  return `<div class="conviction-note${net < 0 ? ' neg' : ''}" title="順位は素点(${r.score ?? 0})に${parts.join('・')}ぶん(${sign}${net}点)を加えた${total}点で計算しています">順位${total}pt(${sign}${net})</div>`;
}

// POLICY CATALYST(政策材料)チップ。Python側(jp-news-dashboard)が
// 判定したtheme/direction/scoreをそのまま表示するだけで、ここでは
// 再判定もBUY SCOREへの加算もしない(r.policyCatalystの配線はmain()側)。
// 同一銘柄に複数の政策イベントがある場合は、topScoreに紐づくイベントを
// 代表として表示する(その他はtitle属性の件数で示す)。
export function policyCatalystChip(r) {
  const pc = r.policyCatalyst;
  if (!pc || !Array.isArray(pc.events) || pc.events.length === 0) return '';
  const top = pc.events.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
  const more = pc.events.length > 1 ? `他${pc.events.length - 1}件` : '';
  const title = `${top.theme || top.primaryTheme || ''}: ${top.reason || ''}${more ? `(${more}の政策材料あり)` : ''}`;
  return `<span class="chip violet" title="${esc(title)}">🟣 POLICY ${pc.topScore ?? 0}</span>`;
}

// AI CAPEX CATALYST(Phase1/2相当)チップ。POLICY CATALYSTとは完全に別の
// 入力(巨大テックの設備投資起点)であり、スコアも合算しない(ユーザー
// 指示、必ず守ること)。ai_capex_catalyst.mjsの配線はmain()側。
// ai_demand_risk(資金負担リスク)はスコア化された買い材料としては扱わず、
// 「⚠ AI需要・資金負担リスク」という警戒表示だけを別に出す(売りシグナル
// に変換しない)。
export function aiCapexCatalystChip(r) {
  const ac = r.aiCapexCatalyst;
  if (!ac) return '';
  const hasScore = Array.isArray(ac.events) && ac.events.length > 0;
  const hasRisk = Array.isArray(ac.riskFlags) && ac.riskFlags.length > 0;
  if (!hasScore && !hasRisk) return '';

  let scoreBadge = '';
  if (hasScore) {
    const top = ac.events.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
    const more = ac.events.length > 1 ? `他${ac.events.length - 1}件` : '';
    const title = `${top.theme || ''}: ${top.reason || ''}${more ? `(${more}のAI Capex材料あり)` : ''}。Policy Impact Scoreとは別物で合算していません`;
    scoreBadge = `<span class="chip cyan" title="${esc(title)}">🖥️ AI CAPEX ${ac.topScore ?? 0}</span>`;
  }
  if (hasRisk) {
    const title = ac.riskFlags.map((f) => `${f.theme}: ${f.reason}`).join(' / ');
    scoreBadge += `<span class="chip amber" title="${esc(title)}">⚠ AI需要・資金負担リスク</span>`;
  }
  return scoreBadge;
}

// ①「既に織り込み済み」検知(ユーザー指示、必ず守ること):
// pcs.score(4要素の加重平均)をそのまま見出しにすると、「政策は強いが
// UNPRICEDは低い」という矛盾が平均されて埋もれる。ここではPOLICYと
// UNPRICEDの生の値を並べて見せた上で、verdict(policy_catalyst_score.mjs
// が判定済み、ここでは再判定しない)がPRICED_IN_RISKのときだけ見た目を
// amber(警告色)に切り替える。「加点する/しない」ではなく「見え方を
// 変えるだけ」なので、既存のBUY SCORE等の計算には一切影響しない。
const CATALYST_VERDICT_STYLE = {
  STRONG: { cls: 'violet', emoji: '🟣', note: '' },
  PRICED_IN_RISK: { cls: 'amber', emoji: '⚠', note: '(織込み済み?)' },
  STRONG_UNKNOWN_PRICING: { cls: 'violet', emoji: '🟣', note: '(未織込データなし)' },
  WEAK: { cls: 'violet', emoji: '🟣', note: '' },
};

export function catalystScoreBadge(pcs) {
  if (!pcs) return '';
  const style = CATALYST_VERDICT_STYLE[pcs.verdict] ?? CATALYST_VERDICT_STYLE.WEAK;
  const unpricedText = Number.isFinite(pcs.parts.unpriced) ? pcs.parts.unpriced : 'N/A';
  const title = `POLICY(政策そのものの強さ)${pcs.parts.policy ?? 'N/A'}・UNPRICED(株価への未織込み度、BUY SCOREのUNPRICEDと同じ値)${pcs.parts.unpriced ?? 'N/A'}・TIMING(業績・受注への到達時期)${pcs.parts.timing ?? 'N/A'}・EXPOSURE(恩恵の直接度)${pcs.parts.exposure ?? 'N/A'}の加重平均(40/30/15/15、参考値)。CONFIDENCE${pcs.confidence}%はこの4要素のうち何%ぶんのデータが揃ったか。VERDICT=${pcs.verdict}(政策が強くUNPRICEDが低いPRICED_IN_RISKのときは、政策自体は強くても既に株価に織り込まれている可能性が高いという警告)。テーマ: ${esc(pcs.theme)}。既存BUY/EXPECTATION/SURPRISE/UNPRICED/TIMINGの計算には一切使っていない独立スコアです`;
  return `<span class="chip ${style.cls}" title="${title}">${style.emoji} CATALYST 政策${pcs.parts.policy ?? 'N/A'}×未織込${unpricedText}${style.note}</span>`;
}

// ③ 同一政策テーマ内の競合比較(policy_catalyst_compare.mjs参照)。
// ランキング自体はgroupPolicyCatalystByTheme()側で確定済みで、ここでは
// その結果をそのまま表にするだけ(再判定しない)。
export function policyThemeComparisonSection(comparisons) {
  if (!comparisons.length) return '';
  const rows = comparisons.map(({ theme, stocks }) => {
    const body = stocks.map((s) => {
      const style = CATALYST_VERDICT_STYLE[s.verdict] ?? CATALYST_VERDICT_STYLE.WEAK;
      return `<tr class="${s.rank === 1 ? 'pcc-top' : ''}">
        <td class="pcc-rank">${s.rank}</td>
        <td class="pcc-name"><span class="code">${esc(s.code)}</span> ${esc(s.name)}</td>
        <td>${esc(s.tierLabel ?? '--')}</td>
        <td>${s.policyImpactScore ?? '--'}</td>
        <td>${s.axes.untapped ?? '--'}</td>
        <td>${s.axes.growthAccel ?? '--'}</td>
        <td>${s.axes.valuation ?? '--'}</td>
        <td>${s.axes.supplyDemand ?? '--'}</td>
        <td><span class="chip ${style.cls}" title="政策${s.policyImpactScore ?? 'N/A'}×未織込${s.axes.untapped ?? 'N/A'}">${style.emoji} ${s.verdict ?? '--'}</span></td>
      </tr>`;
    }).join('');
    return `
    <div class="pcc-theme">
      <div class="pcc-theme-head">🏆 ${esc(theme)} <span class="pcc-count">(${stocks.length}銘柄で比較)</span></div>
      <div class="pcc-table-wrap"><table class="pcc-table">
        <thead><tr>
          <th>順位</th><th>銘柄</th><th>受益</th><th>政策</th>
          <th>${esc(AXIS_LABEL.untapped)}</th><th>${esc(AXIS_LABEL.growthAccel)}</th>
          <th>${esc(AXIS_LABEL.valuation)}</th><th>${esc(AXIS_LABEL.supplyDemand)}</th><th>判定</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }).join('');
  return `
  <details class="sec" id="pcc" open>
    <summary class="sec-head">
      <h2><span class="ico">🏆</span>POLICY CATALYST 競合比較</h2>
      <p>同じ政策テーマに複数の受益銘柄がある場合に、未織り込み・業績感応度(成長加速で代用)・バリュエーション・需給の順で比較し、テーマ内で一番仕込む価値があるのはどこかを並べます。今回のビルドでAMBUSH/SMART ENTRYの足切りを通った銘柄のみが比較対象です(足切り前の銘柄は対象外という既知の限界があります)。BUY SCORE等の計算には一切使っていません。</p>
    </summary>
    ${rows}
  </details>`;
}

export function card(r, i, opts = {}) {
  const rankCls = r.rank === 'S' ? 's-rank' : r.rank === 'A' ? 'a-rank' : '';
  const verdict = ambushVerdict(r);
  const overheat = overheatSignal(r.kairi);
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  // Stage1（乖離≤+5% / RSI≤60 / 出来高Z≤0.5）は日次スキャン時点の足切り。
  // 場中は上位銘柄の価格だけ再取得して表示するため（Stage1の再判定はしない）、
  // 値動きが進んでスキャン時点の「未織込」基準を後から超えることがある。
  // 黙って通し続けると「期待値が織り込まれた株」を仕込み候補のまま見せて
  // しまうので、超えたら分かるようにバッジで警告する（除外はしない＝
  // 一覧から消すと「何が通過していたか」が追えなくなるため）。
  const pricedIn = r.kairi !== null && r.rsi !== null && r.volZ !== null
    && !stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass;
  const catalystChips = (r.catalysts ?? []).slice(0, 3)
    .map((c) => `<span class="chip mint" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');
  const warnChips = (r.warnings ?? []).slice(0, 2)
    .map((c) => `<span class="chip red" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');
  const creditTags = creditSupplyTags(r);

  return `
      <article class="card ${rankCls}" id="card-${esc(r.code)}" style="--i:${i}" data-credit-tags="${esc(creditTags.join(','))}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}" title="SCORE(素点=月次30+PR30+進捗20+セクター10+テクニカル10)だけを基準にしたランクです。BUY SCORE・判定（見送り〜強い買い候補）とは別の指標のため、実際の仕込み判断はBUY SCORE・判定を優先してください">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          <div class="score-col">
            ${scoreGauge(r.score)}
            ${convictionNote(r)}
          </div>
        </header>
        ${verdictBlock(verdict, r)}
        ${scoreTrio(r)}
        ${entryTimingNote(r, verdict)}
        ${exitPlanBlock(r, verdict)}
        ${reasonBlock(r, verdict)}
        ${whyNowBlock(r, verdict)}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="stats">
          <div class="cell"><span class="k">乖離率<i>未織込 ${fmt(unpricedScore(r.kairi), '/10')} · ${describeKairi(r.kairi)}</i></span><span class="v ${kairiTone(r.kairi)}">${fmt(r.kairi, '%')}</span></div>
          <div class="cell"><span class="k">RSI<i>14日 · ${describeRsi(r.rsi)}</i></span><span class="v ${rsiTone(r.rsi)}">${fmt(r.rsi)}</span></div>
          <div class="cell"><span class="k">出来高Z<i>20日</i></span><span class="v ${volZTone(r.volZ)}">${fmt(r.volZ)}</span></div>
          <div class="cell"><span class="k">進捗<i>${progressBasisLabel(r)}</i></span><span class="v ${progressTone(r.progress, r.progressBasis)}">${fmt(r.progress, '%')}</span></div>
        </div>

        <div class="meta">
          <span>${esc(r.sectorName ?? '業種N/A')} ${r.sectorChangePct !== null && r.sectorChangePct !== undefined ? `<b class="${r.sectorChangePct >= 0 ? 'up' : 'down'}">${r.sectorChangePct > 0 ? '+' : ''}${r.sectorChangePct}%</b>` : ''}</span>
          <span>信用 ${fmt(r.loanRatio, '倍')}</span>
          <span>PER ${fmt(r.per, '倍')}</span>
          <span class="conf" title="旧SCORE（月次/PR/進捗/セクター/テクニカルの素点）算出に使えた情報量です。下のBUY SCOREのCONFIDENCE（別の5要素を基準にした信頼度）とは別の指標のため、数値が一致しないことがあります${r.confidenceRaw && r.confidenceRaw !== r.confidence ? `。方向不明の開示があるため ${r.confidenceRaw}% から ${r.confidenceRaw - r.confidence}pt 控除` : ''}">SCORE用DATA ${r.confidence ?? 0}%</span>
        </div>
        ${ruleChecklistBlock(r)}
        ${consensusEvidenceBlock(r)}
        ${peerComparisonBlock(r)}
        ${dividendTrendBlock(r)}
        ${repricingLagBlock(r, { isUs: false })}
        ${creditSupplyQualityBlock(r)}
        ${creditSupplyTimelineBlock(r)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${bottomChips(r)}
          ${catalystChips}${warnChips}${policyCatalystChip(r)}${aiCapexCatalystChip(r)}
          ${earningsBadge(r)}
          ${overheat.level === 'bad' ? `<span class="chip red" title="${esc(overheat.note)}">${esc(overheat.label)}</span>` : ''}
          ${growthSurge.level === 'bad' ? `<span class="chip red" title="${esc(growthSurge.note)}">${esc(growthSurge.label)}</span>` : ''}
          ${overheat.level !== 'bad' && pricedIn ? `<span class="chip amber" title="スキャン時点は未織込条件（乖離≤+${STAGE1.maxKairi}%・RSI≤${STAGE1.maxRsi}）を満たしていましたが、その後の値動きで乖離${r.kairi}%・RSI${r.rsi}まで進み、基準を超えました">織込み進行</span>` : ''}
          ${r.ambiguous ? `<span class="chip gray" title="「業績予想の修正」等、題名から上方/下方が判別できない開示">方向不明 ${r.ambiguous}</span>` : ''}
          ${r.hasMonthly ? '<span class="chip flat" title="月次開示あり。前年比の数値はPDF内のため未取得">月次あり</span>' : ''}
          ${catalystTierBadge(r)}
          ${HORIZON_BADGE.short}
          ${opts.stale ? '<span class="chip gray">日次値</span>' : ''}
        </footer>
      </article>`;
}

// v7.3改修（ユーザー指示書 項目6）: 「先行材料あり/なし」の2値をS/A/B/C
// ランクに強弱化。r.rank（SCORE 0-100から出す銘柄ランクS/A/B/C/D）と
// 文字が重複するため、混同しないよう必ず「材料」を頭に付けて表示する。
const CATALYST_TIER_CLS = { S: 'mint', A: 'cyan', B: 'amber', C: 'gray' };

// v7.3改修（ユーザー指示書 項目13/14）: 「短期で上がりそうな株」と
// 「3〜5年で10倍を狙える株」を同じランキングに混在させない。判定ロジック
// 自体は変えず、投資期間の目安を表示に追加するだけ（AMBUSHは決算前の
// 待ち伏せなのでSHORT、SMART ENTRYは需給・出遅れ系の仕込みなのでSWING。
// テンバガーは既存の別セクション・別スコアのまま=3〜5年以上）。
const HORIZON_BADGE = {
  short: '<span class="chip flat" title="想定保有期間の目安（1〜3ヶ月）。決算前の値動きを狙う短期の仕込みです">⏱ SHORT</span>',
  swing: '<span class="chip flat" title="想定保有期間の目安（3〜12ヶ月）。需給・出遅れの解消を待つ中期の仕込みです">⏱ SWING</span>',
};
function catalystTierBadge(r) {
  if (!r.catalystTier) {
    return '<span class="chip gray" title="TDnetに好材料の開示も月次KPIも無いため、先行カタリストの根拠がありません。スコアが高くてもAMBUSH NOWには入れていません">材料なし</span>';
  }
  // 実測: 「契約締結」（Aランク・+10）と「中止」（悪材料・-14）が同一銘柄で
  // 同時に開示され、tier='A'なのに相殺後のscore100が0点になるケースが
  // あった（一見矛盾して見える）。tierは「見つかった好材料の中で最も
  // 強いもの」、score100は「悪材料も差し引いた後の正味の値」という別々の
  // 意味だと明記し、矛盾していないことが分かるようにする。
  const netNote = r.catalystScore100 === 0 && r.catalystTier
    ? '（同時に悪材料の開示もあり、正味では相殺されています）'
    : '';
  return `<span class="chip ${CATALYST_TIER_CLS[r.catalystTier]}" title="TDnet開示の中で最も強い好材料のランク（S＞A＞B＞C）。100点換算の正味スコア（悪材料と相殺後）は${r.catalystScore100 ?? '--'}点${netNote}">材料${r.catalystTier}ランク</span>`;
}

// ------------------------------------------------------------------
// SMART ENTRY専用: 仕込みパターンカード（AMBUSHのスコア/ランクは使わない）
// ------------------------------------------------------------------
// good=条件全て該当 / partial=一部該当（データ不足で確定できない）/
// none=既知の条件だけで確定的に非該当（見送ってよい） / null=判定材料が
// 何も無い総N/A。noneとnullは以前どちらもlevel:nullで区別が無く、
// 🔴（bad）が定義上ずっと到達不能なデッドコードだった（indicators.mjsの
// composePatternのコメント参照）。
const SIG_EMOJI = { good: '🟢', partial: '🟡', none: '🔴', null: '⚪' };
const SIG_CLASS = { good: 'mint', partial: 'amber', none: 'red', null: 'gray' };

export function signalRow(title, sig) {
  const emoji = SIG_EMOJI[sig.level ?? 'null'];
  const cls = SIG_CLASS[sig.level ?? 'null'];
  return `<div class="sig">
        <div class="sig-head"><span class="sig-e">${emoji}</span><span class="sig-t">${esc(title)}</span><span class="chip ${cls}">${esc(sig.label)}</span></div>
        <div class="sig-n">${esc(sig.note)}</div>
      </div>`;
}

// SMART ENTRYの順位は乖離の深さだけでなく、底打ち確認の裏付け(+15/+20)や
// 警告(-25)も加味した総合スコア(smartEntryConviction)で決めている。
// AMBUSHのscoreGauge(0-100%のリング表示)とはスケールが違う（該当
// パターン数×100が基準点なので0〜300pt程度になりうる）ため、同じ
// ビジュアルを使うと誤解を招く。数値をそのまま出すシンプルな表示にする。
function smartScoreBadge(score) {
  // SMART_ENTRY_PENALTY_FIELDS（smart_entry.mjs）に何を足しても、ここの
  // 説明文だけ更新し忘れる抜けが起きうる（実測: retailExpectationSignal
  // 追加時、この静的な説明文には反映し忘れていた）。ここは動的な内訳
  // 表示ではなく固定の一文なので配列を自動でimportして組み立てる作りには
  // していないが、SMART_ENTRY_PENALTY_FIELDSの中身が変わったら合わせて
  // このコメントと文言も見直すこと。
  return `<div class="smart-score" title="該当パターン数×100 ＋ 一部該当(+20)・底打ち確認等の裏付け1つにつき(+15) − 信用過多/連れ高/売掛金急増/決算間近/個人投資家の期待織り込み大などの警告1つにつき(-25) ＋ 業種平均PER/PBRとの比較(最大+30) の合計。乖離の深さ「だけ」では決めていません">
    <span class="smart-score-v">${score}</span><span class="smart-score-u">SCORE</span>
  </div>`;
}

export function smartEntryCard(r, i) {
  const overheat = overheatSignal(r.kairi);
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  const verdict = smartEntryVerdict(r, overheat, growthSurge);
  // 選定時点はいずれかのパターンに該当していたが、場中の値動きで
  // 3条件どれも「該当」でなくなった状態。初心者にも分かるよう
  // 「なぜもう買い時ではないのか」を一言で示す。
  const patternExpired = ![r.sig1, r.sig2, r.sig3].some((s) => s?.level === 'good');

  return `
      <article class="card" id="card-${esc(r.code)}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${smartScoreBadge(smartEntryConviction(r))}
        </header>
        ${verdictBlock(verdict, r)}
        ${scoreTrio(r)}
        ${smartEntryExitPlanBlock(r, verdict, overheat, growthSurge, patternExpired)}
        ${reasonBlock(r, verdict)}
        ${whyNowBlock(r, verdict)}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="signals">
          ${signalRow('① リバウンド狙い（逆張り）', r.sig1)}
          ${signalRow('② トレンド転換の初動（順張り）', r.sig2)}
          ${signalRow('③ しこり解消・出遅れ株', r.sig3)}
        </div>
        ${ruleChecklistBlock(r)}
        ${consensusEvidenceBlock(r)}
        ${peerComparisonBlock(r)}
        ${dividendTrendBlock(r)}
        ${repricingLagBlock(r, { isUs: false })}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${bottomChips(r)}
          ${diamondBadge(r.diamond)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${explosionBadges(r)}
          ${policyCatalystChip(r)}${aiCapexCatalystChip(r)}
          ${overheat.level === 'bad' ? `<span class="chip red" title="${esc(overheat.note)}">${esc(overheat.label)}</span>` : ''}
          ${growthSurge.level === 'bad' ? `<span class="chip red" title="${esc(growthSurge.note)}">${esc(growthSurge.label)}</span>` : ''}
          ${patternExpired ? '<span class="chip red" title="選んだ時点では3つの仕込みパターンのいずれかに当てはまっていましたが、その後の値動きでどれにも当てはまらなくなりました。今から新規に買う根拠にはなりません">条件外れ</span>' : ''}
          ${HORIZON_BADGE.swing}
        </footer>
      </article>`;
}

// カタリスト予兆セクションのhasPrecursor/PRECURSOR_*_FIELDSはindicators.mjs
// に移設した（screener.mjsだけでなくsmart_entry.mjsからも同じ判定基準を
// 使い回すため。scraper.mjsに置いたままだとsmart_entry.mjsからimportする
// 際にscraper.mjs→smart_entry.mjs→scraper.mjsの循環importになってしまう）。

// 需給ワンポイント表示（ユーザー提案）。業績加速の予兆（🔮）があっても
// 信用買いが積み上がっていれば「出尽くし売り」を食らいうるため、
// 予兆カード単位で常に一目でわかるバッジを1つだけ添える。データ不足
// （checked:false）の銘柄では何も出さない（無い情報を捏造しない）。
function creditFloatBadge(cf) {
  if (!cf?.checked || !Number.isFinite(cf.occupancy)) return '';
  const cls = cf.level === 'good' ? 'is-good' : cf.level === 'bad' ? 'is-bad' : 'is-mid';
  const icon = cf.level === 'good' ? '🟢' : cf.level === 'bad' ? '🔴' : '🟡';
  const title = cf.note ?? '信用買い占有率（信用買い残 ÷ 推定浮動株数の近似値）';
  return `<div class="precursor-supply-badge ${cls}" title="${esc(title)}">${icon} 信用買い占有率 ${cf.occupancy}%</div>`;
}

// 利益の質チェック（ユーザー提案）。売掛金急増（receivablesAnomaly）が
// bad/warnの銘柄は、予兆カードの枠自体を色付けして「この銘柄はN/A評価が
// 多くても要注意」と一目でわかるようにする。
function receivablesFlagClass(r) {
  const level = r.receivablesAnomaly?.level;
  return level === 'bad' ? 'flag-bad' : level === 'warn' ? 'flag-warn' : '';
}

// カタリスト予兆セクションの並び順キー。実測バグ（ユーザー指摘「なんで
// リンガーハット1位になってるの」）: 好材料(good)も注意材料(bad/warn)も
// 同じ「該当件数」として合算していたため、売掛金急増(bad)のような
// 悪材料が付いているだけで件数が1件増え、悪材料の無い銘柄より上位に
// 来てしまっていた。goodは降順（多いほど上位）、cautionは昇順
// （悪材料が少ないほど上位）に分離する。
export function precursorRank(r) {
  return {
    good: PRECURSOR_GOOD_FIELDS.filter((k) => r[k]?.level === 'good').length,
    caution: PRECURSOR_CAUTION_FIELDS.filter((k) => r[k]?.level === 'warn' || r[k]?.level === 'bad').length,
    effective: r.effectiveScore ?? -1,
  };
}

export function precursorCard(r, i) {
  const hits = PRECURSOR_GOOD_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good');
  const cautions = PRECURSOR_CAUTION_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn' || s?.level === 'bad');
  // 実測（ユーザー報告: 8200リンガーハットのカタリスト予兆カードに
  // 🚪仕込み期限・手放すタイミングブロックが無い）: AMBUSH由来
  // （precursorSource==='ambush'）の銘柄はr.rank/r.daysLeft等AMBUSHの
  // フィールドを持っているのに、exitPlanBlockがcard()/usCard()にしか
  // 配線されておらず、このカードには一度も出したことが無かった。
  // 成長株予兆（precursorSource==='growth'）はrank等のAMBUSH専用
  // フィールドを持たないため、ambushVerdictを計算すると意味のない
  // 「見送り」になってしまう（rankが無いとrankOf相当の分岐がelseに
  // 落ちるため）。既存のentryTimingNoteと同じ「growthなら出さない」
  // 判定をverdict計算にも適用する。
  const verdict = r.precursorSource === 'growth' ? null : ambushVerdict(r);
  return `
      <article class="card precursor-card ${receivablesFlagClass(r)}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${creditFloatBadge(r.creditFloat)}
        </header>
        ${verdictBlock(verdict, r)}
        ${scoreTrio(r)}
        ${r.precursorSource === 'growth' ? HORIZON_BADGE.swing : HORIZON_BADGE.short}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
        </div>

        <div class="precursor-list">
          ${hits.map((s) => `<div class="precursor-item">
            <div class="precursor-item-head">🔮 ${esc(s.label)}</div>
            <div class="precursor-item-note">${esc(s.note)}</div>
          </div>`).join('')}
          ${cautions.map((s) => `<div class="precursor-item precursor-caution ${s.level === 'bad' ? 'is-bad' : 'is-warn'}">
            <div class="precursor-item-head">⚠️ ${esc(s.label)}</div>
            <div class="precursor-item-note">${esc(s.note)}</div>
          </div>`).join('')}
        </div>
        ${r.precursorSource === 'growth' ? '' : entryTimingNote(r, verdict)}
        ${r.precursorSource === 'growth' ? '' : exitPlanBlock(r, verdict)}
        ${r.precursorSource === 'growth' ? '' : reasonBlock(r, verdict)}
        ${r.precursorSource === 'growth' ? '' : whyNowBlock(r, verdict)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${diamondBadge(r.diamond)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${explosionBadges(r)}
          ${r.precursorSource === 'growth'
            ? '<span class="chip flat" title="決算スケジュールとは無関係に、東証グロース市場銘柄全体から財務データだけで探した予兆です。AMBUSH（決算まで14〜60日）の候補ではありません">成長株（東証グロース）</span>'
            : '<span class="chip flat" title="AMBUSH（決算先読み）の候補銘柄としても表示中。詳しくはそちらのカードを確認してください">AMBUSH候補にも表示中</span>'}
        </footer>
      </article>`;
}

// A指示 項目40/41「今なぜ仕込むのか」ブロックのINFLECTION版
// （ユーザー要望2026-09-13「カード内にあるこれ関連の内容も」＝他
// セクションのwhyNowBlockと同じ5項目構成をSECTION Dにも入れてほしい）。
// 一般セクション向けのwhyNowBlockはbuyScore/verdict/repricingLag/
// badChipSignals等、INFLECTION候補が持たないフィールドに依存している
// ため流用できない（上のコメントの通り、あえて一般スコアリングを
// 通していない設計のため）。INFLECTION候補が実際に持つフィールド
// （coreScreening/patternType/キラー指標3つ/downsideRisk/
// fundamentalRisk）から同じ5項目を組み立てる。
export function inflectionWhyNowBlock(r) {
  const killerNotes = [r.spread, r.progressSurprise, r.hurdleRatio].filter((s) => s?.passed).map((s) => s.note);
  const storyNote = r.patternType?.type ? r.patternType.note : null;
  const whyNow = [
    storyNote,
    killerNotes.length ? killerNotes.join('。') : null,
    'コア・スクリーニング条件（PER/PBR/ROE/自己資本比率等の割安財務レンジ）も満たしています',
  ].filter(Boolean).join('。') + '。';

  const biggestRisk = r.fundamentalRisk?.excluded
    ? r.fundamentalRisk.reasons.join('・')
    : r.downsideRisk?.level === 'bad'
      ? r.downsideRisk.note
      : '特に大きなリスクは検出されていません（自動取得できないリスク要因が残っている可能性はあります）';

  const nextChecks = [
    r.checkpointTrend?.progressLabel ? `次回決算での進捗率の推移（${r.checkpointTrend.progressLabel}）` : null,
    r.hurdleRatio?.checked ? 'ハードル比率の変化（会社予想が据え置かれるか、上方修正されるか）' : null,
    r.countermeasure?.level !== 'good' ? '決算説明資料等での対策（価格改定・合理化等）への言及の有無' : null,
  ].filter(Boolean);

  const addMoreCondition = r.patternType?.type === 'guidance_conservative'
    ? '次回決算で会社予想の上方修正が発表されれば、さらなる上値余地を確認できます'
    : '進捗サプライズ・スプレッドの改善が続けば買い増しを検討できます';

  const passCondition = (r.coreScreening?.passed === false || r.downsideRisk?.level === 'bad')
    ? 'コア・スクリーニング条件から外れる、または下方修正リスクが高まった場合は見送りを検討してください'
    : 'ハードル比率が悪化する、または特別損失等の新たなリスクシグナルが出た場合は見送りを検討してください';

  return `<div class="why-now-block">
        <div class="why-now-item"><span class="why-now-h">🤔 なぜ今？</span><p>${esc(whyNow)}</p></div>
        <div class="why-now-item"><span class="why-now-h">⚠️ 最大のリスク</span><p>${esc(biggestRisk)}</p></div>
        ${nextChecks.length ? `<div class="why-now-item"><span class="why-now-h">🔍 次に確認する数字</span><ul>${nextChecks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
        <div class="why-now-item"><span class="why-now-h">➕ 買い増し条件</span><p>${esc(addMoreCondition)}</p></div>
        <div class="why-now-item"><span class="why-now-h">➖ 見送り条件</span><p>${esc(passCondition)}</p></div>
      </div>`;
}

// ------------------------------------------------------------------
// 「業績屈折(INFLECTION／ターンアラウンド)」カード（ユーザー提案
// 2026-09-12。実例: シマダヤ「1Q減益はコスト高が要因、通期予想は
// 維持、10月価格改定でH2以降マージン改善を見込む」というシナリオ）。
//
// 他セクションと違い、buyScore/verdictBlock等の一般スコアリングは
// あえて通さない。理由: applyMinimumBuyGate（indicators.mjs）は
// revenueGrowthPct/profitGrowthPctが-20%以下の銘柄を機械的にhold
// まで格下げする設計だが、INFLECTION候補は「直近の減益（まさに
// -20%を超えうる）を確認した上で、それでも先の回復シナリオに賭ける」
// という前提そのものが違うセクションのため、この2つのスコアリング
// 前提は両立しない。ユーザー要望通り「なぜ悪かったか」「対策（確認
// できた場合のみ）」「予想跳躍率」の3行に絞ったシンプルなカードにする。
export function inflectionCard(r, i) {
  const riskChip = r.fundamentalRisk?.excluded
    ? `<span class="chip red" title="${esc(r.fundamentalRisk.reasons.join('・'))}">⚠️ 財務リスクあり（赤字/債務超過。SECTION Dは許容表示）</span>`
    : '';
  const turnChip = r.turnsProfitable ? `<span class="chip mint">黒字転換見込み</span>` : '';
  // ユーザー仕様「この5つが揃う銘柄を最優先候補にします」（実装できた
  // 3つのキラー指標が全て該当した場合のバッジ。月次売上・PER/PBR6ヶ月
  // 変化率の2条件はデータソースが無く未実装のため対象外）。
  const topPickBadge = r.killerHits >= 3
    ? `<span class="chip mint" title="スプレッド・進捗サプライズ・ハードル比率のキラー指標3つが全て該当">🎯 最優先候補</span>` : '';

  const ct = r.checkpointTrend;
  // ユーザー指摘（2026-09-13）: 「上方修正本命型」（1Qは実際には増益）
  // なのに「📉 なぜ悪かったか」という見出しのままだと、そもそも「悪く」
  // ない銘柄に不自然な見出しが付く（実測: 未来工業は+32.6%増益なのに
  // 「なぜ悪かったか」と表示されていた）。タイプに応じて見出しを変える。
  const causeLabel = r.patternType?.type === 'guidance_conservative' ? '📌 特損・留意事項' : '📉 なぜ悪かったか';
  const causeLine = r.inflectionCause?.checked && r.inflectionCause.causes?.length
    ? esc(r.inflectionCause.note)
    : '粗利率悪化・販管費増加・特別損失/減損のいずれにも該当しませんでした（開示本文の確認をおすすめします）';

  // ユーザー指摘（2026-09-13）: 対策がTDnetタイトルからほぼ検出できず
  // （実測: 10社中10社が未検出）、それでも毎回同じ長文が表示され続けて
  // カードの場所を無駄に取っていた。検出できた場合だけ詳細を出し、
  // できなかった場合は場所を取らない短い注記1行に畳む。
  const measureLine = r.countermeasure?.level === 'good'
    ? esc(r.countermeasure.note)
    : '未検出（本文未確認・対策が無いとは限りません）';

  // ユーザー指摘（2026-09-13）: 「予想跳躍率」というラベルなのに、
  // 表示していたのは直近四半期の実績YoYだけだった（「跳躍」＝実績と
  // 通期予想のギャップが見えていなかった）。nextMilestoneの会社予想と
  // 前年同期実績から通期予想YoYを逆算し、実績→予想のギャップを示す
  // （実データ相当: 未来工業は直近+32.6% → 通期予想+5.9%となり、
  // 「会社計画が保守的」というストーリーがそのまま数字で見える）。
  const opYoy = ct?.ordinaryProfit;
  const priorYearMilestoneActual = r.nextMilestone?.priorOrdinaryProfitActuals?.at(-1);
  const forecastOrdinaryProfit = r.nextMilestone?.forecastOrdinaryProfit;
  const forecastYoyPct = (Number.isFinite(forecastOrdinaryProfit) && Number.isFinite(priorYearMilestoneActual) && priorYearMilestoneActual > 0)
    ? Math.round(((forecastOrdinaryProfit - priorYearMilestoneActual) / priorYearMilestoneActual) * 1000) / 10
    : null;
  const leapLine = opYoy?.state === 'turned_profitable'
    ? `${ct.period}時点の経常益実績が赤字→黒字に転換`
    : (opYoy?.state === 'numeric' || opYoy?.state === 'multiple')
      ? (forecastYoyPct !== null
        ? `直近四半期 前年比${opYoy.pct >= 0 ? '+' : ''}${opYoy.pct}% → 通期会社予想 前年比${forecastYoyPct >= 0 ? '+' : ''}${forecastYoyPct}%${(opYoy.pct - forecastYoyPct) >= 10 ? '（会社計画は保守的）' : ''}`
        : `${ct.period}時点 経常益 前年比${opYoy.pct >= 0 ? '+' : ''}${opYoy.pct}%（通期会社予想は非開示のため実績との比較はできません）`)
      : '直近チェックポイントの経常益YoYは未算出（特殊な変化のため機械的な数値化ができないか、データ不足です）';

  // キラー指標3つをミニ計器盤（3分割グリッド）で表示する（ユーザー
  // 要望「もっと分かりやすく未来チックなレイアウトに」2026-09-13）。
  // スラッシュ区切りの1行テキストより、該当数が一目で分かる。
  const killerCells = [
    { label: 'スプレッド', s: r.spread, fmt: (v) => `${v >= 0 ? '+' : ''}${v}pt` },
    { label: '進捗サプライズ', s: r.progressSurprise, fmt: (v) => `${v >= 0 ? '+' : ''}${v}pt` },
    { label: 'ハードル比率', s: r.hurdleRatio, fmt: (v) => `${v}倍` },
  ].map(({ label, s, fmt }) => {
    const value = s?.checked ? fmt(s.value) : '—';
    return `<div class="infl-killer-cell${s?.passed ? ' hit' : ''}">
              <div class="kv">${esc(value)}${s?.passed ? ' ✓' : ''}</div>
              <div class="kl">${esc(label)}</div>
            </div>`;
  }).join('');

  const coreFails = r.coreScreening?.failedReasons ?? [];
  const coreUnchecked = r.coreScreening?.uncheckedFields ?? [];

  // 「屈折」の2パターン分類（ユーザー提案2026-09-13）。V字回復型
  // （1Q経常益YoYが実際にマイナス）と上方修正本命型（1Q経常益YoYは
  // プラスだが会社予想のハードルが低い＝上方修正が濃厚）の2ストーリー
  // は、投資のゴール（次の決算で市場を驚かせる）が同じなので除外は
  // せずバッジで区別する（実測: 未来工業(7931)は経常益+32.6%増益・
  // ハードル比率0.8倍で後者に該当）。色もタイプごとに変える
  // （V字回復型=cyan、上方修正本命型=mint）。
  const patternTypeClass = r.patternType?.type === 'v_turnaround' ? 'v-turnaround'
    : r.patternType?.type === 'guidance_conservative' ? 'guidance-conservative' : '';
  const patternBadge = r.patternType?.type
    ? `<span class="infl-type ${patternTypeClass}" title="${esc(r.patternType.note ?? '')}">${esc(r.patternType.label)}</span>`
    : '';

  return `
      <article class="card inflection-card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${topPickBadge}${turnChip}
        </header>

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
        </div>
        ${patternBadge}

        <div class="inflection-lines">
          <div class="infl-line"><b>${causeLabel}</b><div>${causeLine}</div></div>
          <div class="infl-line"><b>🛠 対策</b><div>${measureLine}</div></div>
          <div class="infl-line"><b>📈 予想跳躍率</b><div>${leapLine}</div></div>
          <div class="infl-line">
            <b>🎯 キラー指標（${r.killerHits ?? 0}/3該当）</b>
            <div class="infl-killers">${killerCells}</div>
          </div>
        </div>
        ${inflectionWhyNowBlock(r)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${riskChip}
          <span class="chip flat" title="PER${esc(String(r.per ?? 'N/A'))}倍・PBR${esc(String(r.pbr ?? 'N/A'))}倍・配当利回り${esc(String(r.dividendYield ?? 'N/A'))}%">コア割安条件クリア</span>
          ${coreFails.length ? `<span class="chip red" title="${esc(coreFails.join('・'))}">条件外あり</span>` : ''}
          ${coreUnchecked.length ? `<span class="chip flat" title="データ未取得のため未判定: ${esc(coreUnchecked.join('・'))}">一部未確認</span>` : ''}
          <span class="chip flat" title="決算スケジュールに関わらず、コア・スクリーニング条件とキラー指標から機械的に抽出した候補です">業績屈折候補</span>
        </footer>
      </article>`;
}

// ------------------------------------------------------------------
// 米国株AMBUSH（Phase 1）カード。
//
//  日本株のcard()と違い、TDnet相当の先行カタリスト検出・セクター
//  モメンタム・期待値のワナが無いため、chip/verdictの作りは大幅に単純化
//  している（Phase 1の既知の制約。plan参照）。netNet/earningsTrend/
//  receivablesAnomalyのうちlevelが付いたものだけをチップとして出す
//  （CHIP_SIGNAL_FIELDSと同じ「levelがある物だけ拾う」考え方）。
// ------------------------------------------------------------------
const US_CHIP_FIELDS = ['netNet', 'earningsTrend', 'receivablesAnomaly'];

function usChips(r) {
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return US_CHIP_FIELDS.map((k) => r[k]).filter((s) => s && s.level)
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`).join('');
}

function usCard(r, i) {
  // 実測バグ（ユーザー報告）: 米国株AMBUSHにはambushVerdictによる
  // 買い推奨/様子見/見送りの結論ランプが無く、SCORE/rankだけで上位表示
  // されていた銘柄が、カード下部のrepricingLagBlock（仕込み妙味）の
  // 説明文では「見送り推奨です」と明記されており、順位と結論が矛盾して
  // 見えていた（JP AMBUSHのcard()には元々あった結論ランプがusCardには
  // 抜けていた）。JPと同じverdictBlockをここにも追加する。
  const verdict = ambushVerdict(r);
  return `
      <article class="card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}" title="SCORE(素点=月次30+PR30+進捗20+セクター10+テクニカル10)だけを基準にしたランクです。BUY SCORE・判定（見送り〜強い買い候補）とは別の指標のため、実際の仕込み判断はBUY SCORE・判定を優先してください">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${scoreGauge(r.score)}
        </header>
        ${verdictBlock(verdict, r)}
        ${scoreTrio(r)}
        ${entryTimingNote(r, verdict)}
        ${exitPlanBlock(r, verdict)}
        ${reasonBlock(r, verdict)}
        ${whyNowBlock(r, verdict)}

        <div class="price-row">
          <div class="price">$${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="stats">
          <div class="cell"><span class="k">乖離率<i>未織込 ${fmt(unpricedScore(r.kairi), '/10')} · ${describeKairi(r.kairi)}</i></span><span class="v ${kairiTone(r.kairi)}">${fmt(r.kairi, '%')}</span></div>
          <div class="cell"><span class="k">RSI<i>14日 · ${describeRsi(r.rsi)}</i></span><span class="v ${rsiTone(r.rsi)}">${fmt(r.rsi)}</span></div>
          <div class="cell"><span class="k">出来高Z<i>20日</i></span><span class="v ${volZTone(r.volZ)}">${fmt(r.volZ)}</span></div>
          <div class="cell"><span class="k">決算<i>あと${r.daysLeft}日</i></span><span class="v">${esc(r.earningsDate ?? '--')}</span></div>
        </div>

        <div class="meta">
          <span>${esc(r.industry ?? '業種N/A')}</span>
          <span>時価総額 ${Number.isFinite(r.marketCap) ? `$${Math.round(r.marketCap).toLocaleString()}M` : '--'}</span>
          <span>EPS予想 ${fmt(r.consensusEpsEstimate)}</span>
        </div>
        ${repricingLagBlock(r, { isUs: true })}

        <footer class="c-foot">
          <span class="chip flat" title="米国株AMBUSH（Phase 1）。TDnet相当の先行カタリスト検出・セクターモメンタムには未対応です">🇺🇸 US AMBUSH</span>
          ${usChips(r)}
          ${HORIZON_BADGE.short}
        </footer>
      </article>`;
}

// ------------------------------------------------------------------
// テンバガー候補カード（ユーザー提案）。日本株・米国株を同じ枠組みで
// 表示する。日本株はsmart_entry.mjsのscanGrowthPrecursorsが返す最小限の
// 形（code/name/price/changePct/closes/market/marketCap/tenbagger）、
// 米国株はus_screener.mjsのresults（US AMBUSHの結果そのもの、tenbagger
// フィールド付き）と形が異なるため、共通して使うフィールドだけで描画する。
// ------------------------------------------------------------------
// Tier B（中型成長株候補）専用。実測バグ: 旧版は「10倍達成に必要な
// 時価総額」を示していたが、AUR（時価総額$118億→10倍$1180億は
// Uber・Intel級で非現実的）のように数字自体が「無理だ」という抑制効果を
// 生んでいた。Tier Bは「テンバガーは無理だが2〜3倍は狙えるグロース
// 中堅株」に再定義したため、目安も2倍・3倍に変更する。
// indicators.mjs側では計算せず表示専用の値。
function midCapMultipleNote(marketCap, currency) {
  if (!Number.isFinite(marketCap)) return '';
  const fmtCap = (v) => `${currency}${Math.round(v).toLocaleString()}M`;
  return `<div class="precursor-item-note">2倍・3倍時の時価総額目安: ${fmtCap(marketCap * 2)} ／ ${fmtCap(marketCap * 3)}（テンバガー(10倍)は現実的ではありません）</div>`;
}

// A指示 項目36/37「現在の時価総額から10倍の現実性を計算」「現在時価
// 総額・10倍時時価総額・2倍時・3倍時を表示」: Tier Bの2倍・3倍目安
// （midCapMultipleNote、既存）に加え、Tier Aも含む全候補で「現在→2倍/
// 3倍/10倍」の絶対額を示す。Tier Bでも10倍時の金額をあえて表示する
// ことで「なぜ非現実的か」を数字で実感できるようにする（指示書の実例:
// AUR時価総額$118億→10倍$1,180億はUber・Intel級）。
function marketCapMultiplesNote(marketCap, currency) {
  if (!Number.isFinite(marketCap)) return '';
  const fmtCap = (v) => `${currency}${Math.round(v).toLocaleString()}M`;
  return `<div class="precursor-item-note">時価総額: 現在${fmtCap(marketCap)} → 2倍${fmtCap(marketCap * 2)} ／ 3倍${fmtCap(marketCap * 3)} ／ 10倍${fmtCap(marketCap * 10)}</div>`;
}

// A指示 項目14「『10倍可能性』と『今買う妙味』を分離」・「成長ポテン
// シャル」: 3軸を並べて表示する（仕込み妙味はrepricingLag.score・
// tenbaggerRepricingBadgeで既に別軸表示済みのため、ここでは残る2軸の
// バッジのみ追加する）。
function tenbaggerScoreTrio(r) {
  const parts = [];
  if (Number.isFinite(r.growthPotential)) {
    parts.push(`<span class="chip flat" title="成長ポテンシャル（売上高成長率×2＋成長加速ボーナス、0-100）。10倍実現可能性・今買う妙味とは別軸です">成長ポテンシャル ${r.growthPotential}</span>`);
  }
  if (Number.isFinite(r.realizability)) {
    // A指示 項目15「10倍実現難易度を評価（低/中/高/極めて高）」。
    const difficulty = tenbaggerDifficultyLabel(r.realizability);
    parts.push(`<span class="chip flat" title="10倍実現可能性（現在の時価総額がTierの上限にどれだけ近いか、0-100）。小型なほど高く、上限に近いほど10倍達成に必要な絶対額が大きくなり低くなります">10倍実現可能性 ${r.realizability}（難易度：${difficulty}）</span>`);
  }
  return parts.length ? `<div class="score-trio">${parts.join('')}</div>` : '';
}

// 仕込み妙味スコアのzoneバッジ（AMBUSHカードのrepricingLagBlockと同じ
// REPRICING_ZONEマッピングを流用。「10倍ポテンシャル」（Tier A/B）とは
// 別軸の「今から買う妙味」を示す。ランキング順位には使わない
// （ユーザー要望: 2軸を混同しない）。
function tenbaggerRepricingBadge(repricingLag) {
  const z = repricingLag?.checked && repricingLag.zone ? REPRICING_ZONE[repricingLag.zone] : null;
  if (!z) return '<span class="chip gray" title="仕込みゾーン判定に必要なデータ（株価位置・成長率）が不足しています">仕込みゾーン判定不可</span>';
  const gapNote = Number.isFinite(repricingLag.repricingGap)
    ? `。Repricing Gap（再評価余地）${repricingLag.repricingGap > 0 ? '+' : ''}${repricingLag.repricingGap}pt`
    : '';
  return `<span class="chip ${z.cls}" title="今から買う妙味（織り込み度）。10倍ポテンシャルの判定とは別軸です。妙味スコア${repricingLag.score}/100${gapNote}">${z.emoji} ${z.label}</span>`;
}

// 株価帯フィルター（ユーザー方針）。低位株の方が10倍化までの値幅を
// 狙いやすいという考え方から、100〜700円(JP)/$1〜$7(US)を理想帯、
// 材料（先行カタリスト）が十分にあれば1500円(JP)/$15(US)まで許容する。
// 当初は警告バッジのみでランキングに残していたが、ユーザー要望
// 「株価が高いものはやはり除外して」により、この帯を外れる候補は
// テンバガー候補セクションから完全に除外する（他のセクションには影響
// しない、あくまでテンバガー候補限定のフィルター）。
const PRICE_BAND = {
  jp: { ideal: 700, hard: 1500 },
  us: { ideal: 7, hard: 15 },
};
// v7.5改修（ユーザー承認済み: 「DIAMOND該当なら価格帯フィルターをスキップ
// （時価総額上限のみ適用）」）: 株価帯フィルターは「まだ織り込まれて
// いない安い株」を掴むための粗い代理指標だが、DIAMOND（diamondSignal）
// は既にrepricingLag（妙味ゾーンpre_move/early_move）というより精密な
// 未織り込み判定を必須条件にしている。実測でIONQ（$39.52、Tier B該当・
// $16B）・135A VRAIN Solution（¥4,180、DIAMOND該当）が株価帯フィルター
// だけで表示から除外されていたことを確認したため、DIAMOND該当銘柄は
// 価格帯フィルターの対象外にする（時価総額上限は別途Tier A/Bの判定で
// 既に適用されているため、無防備にはならない）。
export function passesPriceBand(price, hasCatalyst, isUs, isDiamond = false) {
  if (isDiamond) return true;
  if (!Number.isFinite(price)) return true; // 株価データ自体が無い場合は除外の判断材料が無いので通す
  const band = isUs ? PRICE_BAND.us : PRICE_BAND.jp;
  if (price <= band.ideal) return true;
  if (price <= band.hard && hasCatalyst) return true;
  return false;
}

// 実測バグ（ユーザー報告）: Tier A 1位のG-MFS(196A)がzone:'priced_in'
// （🔴織り込み済み）なのに1位に居座り続けており、「ダッシュボードで
// 今すぐ検討できる銘柄が1位に来るべき」という目的に反していた
// （AMBUSH側のALOYと同種の問題）。ただし「10倍ポテンシャル」と
// 「今から買う妙味」を混同しないという設計方針自体は維持し、
// revenueGrowthPct降順を完全に捨てるのではなく、zone:'priced_in'の
// 銘柄だけを「同じ条件を満たす他の候補があるうちは」下に沈める
// 2段階ソート（zone優先→同groupならgrowth降順）にする。
export const tenbaggerGrowthPct = (r) => r.revenueGrowthPct ?? r.earningsTrend?.revenueGrowthPct ?? null;
export const tenbaggerPricedInRank = (r) => (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in' ? 1 : 0);

// 「爆発の3条件」（ユーザー提案: 成長加速・出来高急増ブレイクアウト・
// 浮動株薄×出来高急増）の単一の情報源。これらはTier A/B判定自体
// （時価総額・成長率25%の可否）を変えない加点シグナルで、候補内の
// 並び順だけを補正する。フィールドを追加するだけで並び順・バッジ表示の
// 両方に自動反映される（AMBUSH_BONUS_FIELDSと同じパターン）。
export const EXPLOSION_SIGNAL_FIELDS = ['growthAcceleration', 'breakoutVolume', 'floatSqueeze', 'aggressiveInvestment', 'themeMatch'];
export const explosionScore = (r) => EXPLOSION_SIGNAL_FIELDS.filter((k) => r[k]?.level === 'good').length;

export function byTenbaggerRank(a, b) {
  return tenbaggerPricedInRank(a) - tenbaggerPricedInRank(b)
    || explosionScore(b) - explosionScore(a)
    || (tenbaggerGrowthPct(b) ?? -Infinity) - (tenbaggerGrowthPct(a) ?? -Infinity);
}

// A指示 項目31「SMART ENTRYの新しい最終ランキング仕様」+ 項目33
// 「同点を極力なくす」: 結論(買い推奨>様子見>見送り)→仕込み優先度→
// 未織り込み度→成長加速→業績の質→バリュエーション→カタリスト→需給、
// の8段階カスケードで並べ、それでも同点ならRepricing Gap→52週位置
// （低い方が優先）→1M騰落率（低い方が優先）→DATA%でさらに比較する。
// buildScoreParts()はentryPriorityScoreが既に持つ内訳と同じ入力から
// 再計算するだけの純粋関数のため、ソート内で毎回呼んでも実害は無い
// （既存のverdict再計算パターンと同じ考え方）。バリュエーション・
// カタリストは項目33にも同名の基準があるが、項目31の同じ基準を再利用
// すれば数値としては同一（重複による効果は無い）ため二重実装しない。
export function smartEntryRank(a, b) {
  const va = smartEntryVerdict(a, overheatSignal(a.kairi), growthSurgeSignal(a.market, a.closes));
  const vb = smartEntryVerdict(b, overheatSignal(b.kairi), growthSurgeSignal(b.market, b.closes));
  const pa = buildScoreParts(a).entryPriority;
  const pb = buildScoreParts(b).entryPriority;
  const val = (p, k) => (Number.isFinite(p[k]?.value) ? p[k].value : -Infinity);
  return (VERDICT_SEVERITY[va.level] - VERDICT_SEVERITY[vb.level])
    || ((b.entryPriorityScore?.score ?? -Infinity) - (a.entryPriorityScore?.score ?? -Infinity))
    || (val(pb, 'untapped') - val(pa, 'untapped'))
    || (val(pb, 'growthAccel') - val(pa, 'growthAccel'))
    || (val(pb, 'quality') - val(pa, 'quality'))
    || (val(pb, 'valuation') - val(pa, 'valuation'))
    || (val(pb, 'catalyst') - val(pa, 'catalyst'))
    || (val(pb, 'supplyDemand') - val(pa, 'supplyDemand'))
    || ((b.repricingLag?.repricingGap ?? -Infinity) - (a.repricingLag?.repricingGap ?? -Infinity))
    || ((a.repricingLag?.priceLevelPct ?? 999) - (b.repricingLag?.priceLevelPct ?? 999))
    || ((a.repricingLag?.return1m ?? 999) - (b.repricingLag?.return1m ?? 999))
    || ((b.buyScore?.confidence ?? -Infinity) - (a.buyScore?.confidence ?? -Infinity));
}

// explosionScoreの内訳をカードに表示する（level:'good'の項目だけ）。
// bottomChips()と同じ{level,label,note}パターンを使い回す。
function explosionBadges(r) {
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return EXPLOSION_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s?.level)
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`)
    .join('');
}

// v7.4改修（ユーザー要望「反映していないところがある」）: テンバガー候補
// にも「見直す・手放すタイミング」を明示する。AMBUSH/SMART ENTRYと違い
// 決算スケジュールにもverdictにも依存しない長期（3〜5年）のテーマの
// ため、「仕込み期限」という概念は無い。既存のrepricingLagのzone・
// Tier区分をそのまま再構成するだけ。
export function tenbaggerExitPlanBlock(r) {
  const exits = [];
  if (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in') {
    exits.push('妙味ゾーンが既に「織り込み済み」です。一部利益確定を検討してください');
  } else if (r.repricingLag?.checked) {
    exits.push('妙味ゾーンが「織り込み済み」に変わったら一部利益確定を検討');
  }
  exits.push('売上高成長率が閾値（+25%）を下回ったら、テンバガー候補としての前提を見直す');
  exits.push(r.tier === 'B' || r.tier === 'C'
    ? '2倍・3倍の目安株価に達したら一部利益確定を検討（10倍は非現実的な水準のため）'
    : '時価総額が中型成長株候補(Tier B)の上限を超えたら、10倍ポテンシャルの前提が変わる点に注意');
  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 見直す・手放すタイミング</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.3改修 項目13（TENBAGGER SCOREの「財務」「株主構成」軸）: 実測で
// 「営業CF赤字＋有利子負債過多で何%なら危険」という具体的な閾値の根拠が
// 無いため、除外条件は作らず（推測で線引きしない）、判断材料になる生の
// 事実だけを参考情報として表示する。米国株テンバガー（us_tenbagger.mjs）
// はこれらのフィールドを持たないため、値が無ければ何も表示しない。
export function tenbaggerFinancialBlock(r) {
  const notes = [];
  if (Number.isFinite(r.cash) && Number.isFinite(r.interestBearingDebt)) {
    const netCash = r.cash - r.interestBearingDebt;
    notes.push(netCash >= 0
      ? `実質無借金（現金${Math.round(r.cash).toLocaleString()}円が有利子負債${Math.round(r.interestBearingDebt).toLocaleString()}円を上回る）`
      : `有利子負債${Math.round(r.interestBearingDebt).toLocaleString()}円が現金${Math.round(r.cash).toLocaleString()}円を上回っています（希薄化・借入依存のリスクを確認してください）`);
  }
  if (Number.isFinite(r.operatingCf)) {
    notes.push(r.operatingCf >= 0
      ? `営業CFは黒字（${Math.round(r.operatingCf).toLocaleString()}円）で、成長投資を自己資金でまかなえています`
      : `営業CFが赤字（${Math.round(r.operatingCf).toLocaleString()}円）で、成長を借入・増資に頼っている可能性があります`);
  }
  const shareholderNote = r.majorShareholder?.checked && r.majorShareholder?.level === 'good' ? r.majorShareholder.note : null;
  if (!notes.length && !shareholderNote) return '';
  return `<div class="precursor-item">
            <div class="precursor-item-head">💰 財務・株主構成（参考情報。除外条件ではありません）</div>
            ${notes.map((t) => `<div class="precursor-item-note">${esc(t)}</div>`).join('')}
            ${shareholderNote ? `<div class="precursor-item-note">${esc(shareholderNote)}</div>` : ''}
          </div>`;
}

function tenbaggerCard(r, i) {
  const isUs = r.tenbaggerSource === 'us';
  const currency = isUs ? '$' : '¥';
  // A指示 項目13「米国テンバガーTierを3段階にする」: Tier C（$10B〜$20B
  // 程度・大型化後の超成長株。米国株のみ、JP側には存在しない）を追加。
  const tierBadge = r.tier === 'C'
    ? '<span class="chip amber" title="時価総額$10B〜$20B程度(米国のみ)の枠。10倍（テンバガー）は非現実的ですが、既に大型化した後も高成長が続けば2〜3倍程度を狙える超成長株として監視する枠です">🏢 大型超成長株(Tier C)</span>'
    : r.tier === 'B'
    ? '<span class="chip amber" title="時価総額300億〜1000億円(日本)/$1B〜$10B(米国)の枠。10倍（テンバガー）は非現実的ですが、日本は2〜3倍・米国は2〜5倍程度の成長余地を狙えるグロース中堅株です">🌱 中型成長株候補(Tier B)</span>'
    : '<span class="chip mint" title="低時価総額×高成長率の、本来のテンバガー候補の枠">🚀 テンバガー候補(Tier A)</span>';
  return `
      <article class="card" id="card-${esc(r.code)}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
        </header>

        <div class="price-row">
          <div class="price">${currency}${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="precursor-list">
          <div class="precursor-item">
            <div class="precursor-item-head">💎 ${esc(r.tenbagger.label)}</div>
            <div class="precursor-item-note">${esc(r.tenbagger.note)}</div>
            ${r.tier === 'B' || r.tier === 'C' ? midCapMultipleNote(r.marketCap, currency) : ''}
            ${marketCapMultiplesNote(r.marketCap, currency)}
          </div>
          ${tenbaggerScoreTrio(r)}
          ${tenbaggerFinancialBlock(r)}
        </div>
        ${tenbaggerExitPlanBlock(r)}

        <footer class="c-foot">
          ${isUs ? marketChip(null) : marketChip(r.market)}
          <span class="chip flat">${isUs ? '🇺🇸 米国株' : '🇯🇵 日本株'}</span>
          ${tierBadge}
          ${diamondBadge(r.diamond)}
          ${deficitGrowthBadge(r.deficitGrowth)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${tenbaggerRepricingBadge(r.repricingLag)}
          ${explosionBadges(r)}
          <span class="chip flat" title="時価総額（${isUs ? '百万USD' : '百万円'}）">時価総額 ${currency}${Math.round(r.marketCap).toLocaleString()}M</span>
        </footer>
      </article>`;
}

// 「テンバガー候補監視リスト」カード（ユーザー提案2026-09-13）。
// Tier A/B/Cの自動判定（時価総額レンジ・成長率）とは無関係に、ユーザーが
// 個別選定した銘柄の信用需給（週次信用残・信用倍率・直近13週レンジ内の
// 位置）を追跡する。実例: TOWA(6315、東証プライム・時価総額約1,591億円
// は自動判定のTier A/B範囲外）で「信用買い残が直近13週の高値圏（100%）
// に張り付いているので、これがクリアされたら買う」という需給待ちの
// 監視。「クリア」の具体的な閾値はユーザー自身の判断に委ねる（推測で
// 決め打ちの合否ラインを作らない）ため、生の数値と直近レンジ内の位置
// （高値圏/中間圏/安値圏）だけを毎回示す。
export function creditLevelZoneLabel(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct >= 67) return '高値圏';
  if (pct <= 33) return '安値圏';
  return '中間圏';
}

export function tenbaggerWatchCard(r, i) {
  if (r.fetchFailed) {
    return `
      <article class="card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident"><span class="code">${esc(r.code)}</span><h2 class="name">${esc(r.name)}</h2></div>
        </header>
        <div class="empty">データ取得に失敗しました（次回の更新で再試行します）</div>
      </article>`;
  }
  const zone = creditLevelZoneLabel(r.creditLevelPct);
  const zoneClass = zone === '高値圏' ? 'is-bad' : zone === '安値圏' ? 'is-good' : 'is-mid';
  return `
      <article class="card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
        </header>

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
        </div>

        <div class="inflection-lines">
          <div class="infl-line"><b>📝 監視メモ</b><div>${esc(r.note ?? '')}</div></div>
          <div class="infl-line">
            <b>📊 信用需給（${r.creditDate ?? '週次'}時点）</b>
            <div class="infl-killers">
              <div class="infl-killer-cell"><div class="kv">${r.marginBuy != null ? r.marginBuy.toLocaleString() : '—'}</div><div class="kl">信用買い残(株)</div></div>
              <div class="infl-killer-cell"><div class="kv">${r.loanRatio != null ? r.loanRatio + '倍' : '—'}</div><div class="kl">信用倍率</div></div>
              <div class="infl-killer-cell${zone === '安値圏' ? ' hit' : ''}"><div class="kv">${r.creditLevelPct != null ? r.creditLevelPct + '%' : '—'}</div><div class="kl">直近13週内位置</div></div>
            </div>
          </div>
        </div>

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${zone ? `<span class="precursor-supply-badge ${zoneClass}" title="信用買い残が直近13週レンジのどの位置にあるか（0%=直近最少・100%=直近最多）">需給 ${zone}</span>` : ''}
          ${Number.isFinite(r.creditTrendPct) ? `<span class="chip flat" title="4週前と比べた信用買い残の増減率">4週比 ${r.creditTrendPct >= 0 ? '+' : ''}${r.creditTrendPct}%</span>` : ''}
          <span class="chip flat" title="時価総額（百万円）">時価総額 ¥${Math.round(r.marketCap ?? 0).toLocaleString()}M</span>
          <span class="chip flat" title="決算日・成長率レンジ等の自動判定条件とは無関係に、ユーザーが個別選定した監視銘柄です">監視リスト（手動選定）</span>
        </footer>
      </article>`;
}

// v7.5改修（ユーザー提案「テーマ性×小型×高成長×未織り込みが揃ったら
// DIAMONDにする」）。通常のtierBadge（🚀/🌱）と見分けやすいよう専用の
// 色（diamond、CSSでグラデーションを付ける）にする。
function diamondBadge(diamond) {
  if (diamond?.level !== 'good') return '';
  return `<span class="chip diamond" title="${esc(diamond.note)}">${esc(diamond.label)}</span>`;
}

// A指示 項目10/11「赤字成長特例」「赤字成長・高リスク」。levelがgood/bad
// どちらの場合も表示する（テンバガー候補で赤字企業の場合のみchecked:true
// になるため、黒字企業のカードには何も表示されない）。
function deficitGrowthBadge(deficitGrowth) {
  if (deficitGrowth?.level !== 'good' && deficitGrowth?.level !== 'bad') return '';
  const cls = deficitGrowth.level === 'good' ? 'mint' : 'red';
  return `<span class="chip ${cls}" title="${esc(deficitGrowth.note)}">${esc(deficitGrowth.label)}</span>`;
}

// A指示 項目8「異常成長・要確認」（level:warn）/「本物の成長」
// （level:good）。levelがwarn/goodどちらの場合も表示する（異常成長の
// 閾値未満の銘柄はchecked:falseのままなので何も表示されない）。
function growthAnomalyCautionBadge(growthAnomalyCaution) {
  if (growthAnomalyCaution?.level !== 'good' && growthAnomalyCaution?.level !== 'warn') return '';
  const cls = growthAnomalyCaution.level === 'good' ? 'mint' : 'amber';
  return `<span class="chip ${cls}" title="${esc(growthAnomalyCaution.note)}">${esc(growthAnomalyCaution.label)}</span>`;
}

// 初心者向けガイド（色・記号・専門用語の意味）。
//
// 実測: カードには乖離率・RSI・信用残・PBR/PER・SCORE・自分ルールの
// 需給/下値/期待値/タイミング/財務など、説明が無いと分からない専門用語が
// 多数出てくるが、その意味を示す場所がページ内のどこにも無かった
// （チップの説明はtitle属性=ホバー/スマホでは長押し頼みで、初見では
// 気づきにくい）。ユーザー要望「初心者にとって視覚情報・説明文章が
// 分かりにくい所を分かりやすくして」に対応し、常時アクセスできる用語
// ガイドを追加する。<details>はJS無しで開閉でき、初回は開いた状態にして
// 存在に気づきやすくする（voidなdisabledは無いのでopen属性で対応）。
export function beginnerGuide() {
  return `<details class="guide" open>
    <summary>🔰 初心者ガイド — 色・記号・用語の見方（タップで折りたたみ）</summary>
    <div class="guide-body">
      <div class="guide-col">
        <div class="guide-h">色・記号の意味</div>
        <ul class="guide-list">
          <li><span class="chip mint">緑（mint）</span>プラス材料・条件クリア</li>
          <li><span class="chip amber">黄（amber）</span>中立〜軽い注意</li>
          <li><span class="chip red">赤（red）</span>明確な警戒サイン</li>
          <li><span class="chip gray">灰色（gray）</span>データ不足で未確認。「悪い」という意味ではありません</li>
          <li>「自分ルール」の <b>✓</b>＝条件クリア　<b>✗</b>＝条件を満たさない　<b>？</b>＝判定に必要なデータが無い（不合格ではありません）。右上の「n/5」の分母は常に5項目固定で、？の項目があっても分母を減らして表示することはありません</li>
          <li>信号🟢🟡🔴⚪も同じ考え方（🔴＝そのパターンには明確に該当しない、⚪＝判定材料が無い）</li>
        </ul>
      </div>
      <div class="guide-col">
        <div class="guide-h">よく出てくる指標</div>
        <ul class="guide-list">
          <li><b>乖離率</b>：25日移動平均線から株価がどれだけ離れているか。プラスが大きいほど「短期的に買われすぎ」の目安</li>
          <li><b>RSI</b>：買われすぎ・売られすぎを0〜100で表す指標。目安70超で買われすぎ、30未満で売られすぎ</li>
          <li><b>信用残</b>：個人投資家の信用取引（借りたお金や株で売買する仕組み）の残高。急増は個人の期待の高まりのサイン</li>
          <li><b>PBR</b>：株価が「会社を今解散した場合の取り分（純資産）」の何倍かを示す指標。1倍未満は理論上「割安」の目安</li>
          <li><b>PER</b>：株価が「1年分の利益」の何倍かを示す指標。業種平均と比べて割安・割高を判断します</li>
          <li><b>SCORE</b>：総合評価点。AMBUSHは0〜100点満点、SMART ENTRYは複数の根拠を積み上げる仕組みのため100点を超えることがあります</li>
          <li><b>順位とSCOREの違い</b>：カード左上の順位は、SCOREにチップの裏付け・警告ぶんの加減点（「順位◯pt(+N)」の表示）を加えた値で決まります。そのため、SCOREが低いカードがSCOREの高いカードより上位に来ることがあります（意図的な仕様で、順位ずれではありません）</li>
          <li><b>DATA</b>：スコア算出に使えた情報の充実度（%）。100%未満は一部の情報が欠けている状態です</li>
        </ul>
      </div>
      <div class="guide-col">
        <div class="guide-h">「自分ルール」5項目</div>
        <ul class="guide-list">
          <li><b>需給</b>：信用取引が過熱していないか・踏み上げ（買い戻し）の可能性</li>
          <li><b>下値</b>：解散価値割れ（資産の裏付けがある、が業績・キャッシュフロー悪化が続けば目減りしうる）、または業種平均PBR・自社の過去PBRと比べて相対的に割安（あくまで相対比較で、下値を保証するものではない）のいずれかに該当するか</li>
          <li><b>期待値</b>：会社自身の予想とアナリスト予想（コンセンサス）の差</li>
          <li><b>タイミング</b>：決算発表が近すぎて新規に手を出しにくい時期でないか</li>
          <li><b>財務</b>：売上債権（売掛金）が売上に対して異常に増えていないか</li>
        </ul>
      </div>
    </div>
  </details>`;
}

// ユーザー要望「セクションごとに折りたたみ機能を追加して」に対応し、
// <section>を<details>に変え、見出し部分(sec-head)を<summary>にする。
// beginnerGuide()の.guideで既に確立済みの「▾アイコン＋sessionStorageで
// 開閉状態を覚える」パターンをセクション単位に一般化する（下のscript内
// のsectionOpen処理を参照）。
// ユーザー要望「セクションをカテゴリの右上に書いて。ワク作って」に対応。
// SECTION A/B/Cは「場中にライブ更新する対象か」を表す内部用語だったが
// UI上には一切表示されておらず、ユーザーがこれを見つけられなかった
// （前回のやり取り参照）。該当する3カテゴリ（AMBUSH NOW=A/SMART
// ENTRY=B/AMBUSH WATCH=C）の見出し右上に、枠付きバッジとして明示する。
const sectionBadge = (label) => label ? `<span class="sec-badge">SECTION ${label}</span>` : '';
const section = (id, icon, title, desc, cards, empty, sectionLabel = null) => `
  <details class="sec" id="${id}" open>
    <summary class="sec-head">
      <h2><span class="ico">${icon}</span>${title}</h2>
      ${sectionBadge(sectionLabel)}
      <p>${desc}</p>
    </summary>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">${empty}</div>`}
  </details>`;

// ==================================================================
// 出力前の自己監査 — 「赤チップ（bad）を出しているのに買い推奨」の
// ような、このセッション中に何度も見つかった矛盾を毎回の生成時に自動で
// 検出する。これまでは手作業でPythonスクリプトを書いて確認していたが、
// 新しい赤旗シグナルを追加した開発者がverdict側への配線を忘れる
// （growthSurge・上場廃止で実際に起きた）のを機械的に防ぐための恒久策。
// 誤検出で日次バッチが止まると本末転倒なので、ファイル書き込みは止めず
// コンソールに大きく警告を出すだけにする（holidays.mjs等と同じ「警告は
// するが処理は止めない」方針）。
// 自分ルールの「✓/✗」マークは"rule mint"/"rule red"クラスで出る（"rule gray"
// が「？」＝未確認）。titleに「データが無い/確認できない」旨の文言が入って
// いるのに✓/✗が付いていたら、「未確認」と「確認済み」を混同する再発
// バグ（実測: 需給・下値で発見）を検出する。
const UNCONFIRMED_NOTE_PATTERN = /データが?(不足|無い|ありません)|確認できず|判定不能|情報不明|情報なし|未収録|非開示/;

export function auditGeneratedHtml(html) {
  const cards = html.match(/<article class="card.*?<\/article>/gs) ?? [];
  const issues = [];
  for (const c of cards) {
    const code = c.match(/<span class="code">([^<]*)<\/span>/)?.[1] ?? '?';
    const name = c.match(/<h2 class="name">([^<]*)<\/h2>/)?.[1] ?? '?';

    // 「買い推奨」と同居してはいけない赤チップは、実際に警告を意味する
    // footer（bottomChips・警告チップ）側だけを見る。SMART ENTRYの
    // .signals（sig1〜3）に出る🔴は「このパターンは非該当」という意味で
    // あって警告ではなく、他のパターンが該当していれば「買い推奨」と
    // 正常に同居する（実測: sig1が非該当・sig2が該当のSMART ENTRY銘柄を
    // 誤検知していた。composePatternのlevel:'none'導入で🔴が初めて実際に
    // 出るようになった際に発覚）。
    const footer = c.match(/<footer class="c-foot">[\s\S]*?<\/footer>/)?.[0] ?? '';
    // 実測バグ（3日ぶりの本番再稼働後の監査で発覚）: VERDICT_LABEL（
    // indicators.mjs）は実際には「🟢 買い候補」「🔥 強い買い候補」であり
    // 「買い推奨」という文字列を一度も出力しない。一方「買い推奨」は
    // DISPLAY_CATEGORY.WATCHのtitle（strong_buy/buy/holdのどれでも出る
    // 固定文言）やMINIMUM_BUY_GATEのhold降格理由文（「買い推奨の最低条件
    // …を満たしません」）にも現れるため、`c.includes('買い推奨')`は
    // verdictがholdの銘柄でも高確率で真になり、本来は矛盾ではない
    // hold×赤チップの組み合わせを誤検知していた（実測: verdict:'hold'の
    // 3087含む3銘柄を誤検知）。verdictBlockが出す実際のCSSクラス
    // （`verdict v-${v.level}`）で判定することで、表示テキストの
    // 言い回し変更や別の場所に偶然同じ部分文字列が現れることに影響
    // されないようにする。
    const isBuyVerdict = /class="verdict v-(strong_buy|buy)"/.test(c);
    if (isBuyVerdict && footer.includes('chip red')) {
      issues.push(`${code} ${name}: 買い推奨なのに赤チップ（bad級シグナル）が同居しています`);
    }

    // 実測バグの再発防止: bucket分け（daysLeft<=30かどうか）とambush
    // Verdictの「買い推奨」判定は別々の条件式のため、daysLeftが31〜45
    // でもスコア70以上・先行カタリストありなら「買い推奨」になりうる。
    // entryTimingNoteがverdictを見ずに日数だけで「様子見期間です」と
    // 言い切ると、カード上部の「買い推奨」バッジと直接矛盾する
    // （entryTimingNote側でverdictを見て回避する実装にしたが、この
    // 監査でも独立に検知できるようにしておく）。
    // 上のisBuyVerdictと同じ再発防止（「買い推奨」の部分文字列一致は
    // WATCHバッジのtitleやMINIMUM_BUY_GATEのhold降格理由文にも現れ、
    // verdict:'hold'の銘柄を誤検知する）ため、実際のverdict CSSクラス
    // で判定する。
    // 実測バグ（本番index.htmlでの再検証で発覚）: 上記のisBuyVerdict化
    // だけでは終わらず、daysLeft46〜60（PRE-AMBUSH帯）のverdict:'buy'
    // 銘柄（実測: BHF/ASTH/ECVT等10銘柄、いずれもdaysLeft54〜57）を
    // 依然として誤検知していた。entryTimingNote自身はこの帯では意図的
    // に「様子見期間です」を返す設計（上のコメント・v7.3の実測バグ修正
    // 参照）なのに、この監査側はdaysLeftを見ずに「isBuyVerdict×様子見
    // 期間です」の組み合わせだけで矛盾と決めつけていたため、entryTiming
    // Note自身の分岐条件（daysLeft<=WINDOW.watchMaxでなければ様子見表示
    // が正しい）を全く反映していなかった。timing-note文中の「あと(\d+)
    // 日」からdaysLeftを復元し、entryTimingNoteと同じ条件で判定する。
    const daysLeftMatch = c.match(/あと(\d+)日/);
    const daysLeft = daysLeftMatch ? Number(daysLeftMatch[1]) : null;
    const inWatchZone = daysLeft === null || daysLeft <= WINDOW.watchMax;
    if (isBuyVerdict && inWatchZone && c.includes('様子見期間です')) {
      issues.push(`${code} ${name}: 買い推奨なのにentryTimingNoteが「様子見期間です」と矛盾した案内をしています`);
    }

    for (const m of c.matchAll(/<span class="rule (mint|red)" title="([^"]*)">/g)) {
      if (UNCONFIRMED_NOTE_PATTERN.test(m[2])) {
        issues.push(`${code} ${name}: 自分ルールの✓/✗表示なのにtitleが「未確認」を示唆しています（"${m[2]}"）`);
      }
    }

    // A指示 項目25「自動生成説明文の矛盾を完全修正」（「売上-5%、利益
    // -57%と業績側は改善」という文章は禁止）の再発防止策。performance
    // DirectionTextの実装ミスや将来の別の文章生成箇所での再発を検知する
    // ため、生成後のHTML自体からも独立に監査する（数値の符号と「改善」
    // 系の文言が矛盾していないかを機械的に確認する）。
    for (const m of c.matchAll(/売上高([+-]?[\d.]+)%(?:・利益([+-]?[\d.]+)%)?(?:と|（)([^、。）]*)/g)) {
      const revenue = Number(m[1]);
      const profit = m[2] !== undefined ? Number(m[2]) : null;
      const label = m[3];
      const bothNegative = revenue < 0 && (profit === null || profit < 0);
      if (bothNegative && /業績(側は)?改善/.test(label)) {
        issues.push(`${code} ${name}: 売上高${m[1]}%${profit !== null ? `・利益${m[2]}%` : ''}と両方マイナスなのに「${label}」と表示しています`);
      }
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ 自己監査で矛盾を検出しました（新しい赤旗シグナルをverdict側に配線し忘れていないか、checked flagの扱いを確認してください） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return { totalCards: cards.length, issues };
}

// これらのシグナルは「データ不足で判定できない(checked:false)」と
// 「データは揃っていて該当なしと確認できた(checked:true)」を区別する
// 設計になっている（netNet/lowPbr/marginOverhang/receivablesAnomaly）。
// signal関数の実装を直しても、既にキャッシュ済みのJSONに残っている
// 古い形（checkedフィールドが無い）を再計算し忘れると、矛盾は起きない
// もののbuyRuleChecklistが必要以上に「？」を出し続ける（実測: AMBUSH側の
// キャッシュだけ再計算し、SMART ENTRY側のキャッシュを更新し忘れていた）。
// これは「表示が壊れる」バグではなく検出しにくいため、キャッシュの
// シグナル形状そのものを検証してコンソールに警告する。
// pbrHistoricalLowはnetNet/lowPbrと同じchecked flagパターンで実装した
// （buyRuleChecklistの「下値」行の3値OR条件に組み込むため）。ここへの
// 追加を忘れると、このファイル自身が防ごうとしている「checked flag無し
// の古いキャッシュを検出できない」抜けを新しいシグナルで再生産する。
const CHECKED_AWARE_FIELDS = [
  'netNet', 'lowPbr', 'marginOverhang', 'receivablesAnomaly', 'pbrHistoricalLow', 'retailExpectation',
  'progressStreak', 'dividendPotential', 'hiddenAsset', 'creditFloat', 'consensusTrap', 'earningsTrend',
  'tenbagger',
  // v7.5改修（再発防止策の横断監査で発覚）: growthAcceleration/themeMatch/
  // diamondも{level,label,note,checked}の同じ形で追加したのに、この
  // ファイル自身が防ごうとしている「checked flag無しの古いキャッシュを
  // 検出できない」抜けをここへの追記漏れで再生産していた。
  'growthAcceleration', 'themeMatch', 'diamond',
  // A指示 項目10/11で追加したdeficitGrowth（赤字成長特例/赤字成長・
  // 高リスク）も同じ{level,label,note,checked}パターン。追記忘れの
  // 再発防止のため、上と同じコメントを繰り返す代わりにここへ追加する。
  'deficitGrowth',
  // A指示 項目8で追加したgrowthAnomalyCaution（異常成長・要確認/本物の
  // 成長）も同じパターン。
  'growthAnomalyCaution',
];

export function auditSignalShapes(results, sourceLabel) {
  const issues = [];
  for (const r of results ?? []) {
    for (const key of CHECKED_AWARE_FIELDS) {
      const s = r[key];
      if (s && typeof s === 'object' && 'level' in s && typeof s.checked !== 'boolean') {
        issues.push(`[${sourceLabel}] ${r.code} ${r.name}: ${key}にchecked flagが無い古い形のままキャッシュされています（再計算漏れの疑い）`);
      }
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ キャッシュのシグナル形状が古いままです（checked flag追加後の再計算漏れ） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return issues;
}

// v7.3改修 項目17: 生成した理由文と数値の矛盾をバッチ全体で検知する
// （auditSignalShapesと同じ「実行のたびに自己点検してconsole.errorに
// 出す」パターン）。verdictFnはambushVerdict/smartEntryVerdictのどちらか
// （呼び出し側の性質に合わせる）。
export function auditReasonConsistency(results, verdictFn, sourceLabel) {
  const issues = [];
  for (const r of results ?? []) {
    const verdict = verdictFn(r);
    const reasons = buildReasons(r, verdict);
    for (const msg of checkReasonConsistency(r, verdict, reasons)) {
      issues.push(`[${sourceLabel}] ${r.code} ${r.name}: ${msg}`);
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ 生成した理由文と数値が矛盾している銘柄があります（verdict配線漏れの疑い） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return issues;
}

// ==================================================================
// モバイル専用UI（PWA・5画面構成、ユーザー方針2026-09-19）
//
// PC版のテーブル/カードをそのまま縮小するのではなく、スマホでは
// 「カード・大きな数字・タップできるボタン」中心の別レイアウトにする。
// 判定ロジック・データは一切新規計算せず、main()が既に組み立てた配列
// （now/later/smart.results/tenbaggerCandidates等）をそのまま参照する
// だけ（PC版とスマホ版で判定結果が食い違うことが無いようにするため）。
// 「詳細を見る」は、desktop側の該当<article id="card-${code}">を
// ボトムシートにその場で複製して見せる（2026-09-19改修: 以前はPC版
// 画面ごと切り替えていたが「PCのサイトに飛ぶ」と不評だったため）。
// 複製元はdesktop側が生成した完成済みHTMLなので、同じ情報をスマホ用に
// 二重に作り込むことにはならない。
// ==================================================================

// タブバーのアイコン（ユーザー要望2026-09-19: 絵文字は「ダサい」ため、
// サイバーネオン方向のライン画SVGに刷新。currentColorでCSS側の
// ネオングロー(--cyanのdrop-shadow)をそのまま適用できるようにする）。
const MOBILE_TAB_ICONS = {
  home: '<svg class="m-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 11.5 12 4l8 7.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 19v-5h4v5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  signal: '<svg class="m-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 14h4l2.5 6L13 5l2.5 9H21" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stealth: '<svg class="m-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 4 9v6l8 6 8-6V9z" stroke-linejoin="round"/><path d="M12 8v8M9 11l3-3 3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stock: '<svg class="m-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="16.5" y="3.5" width="4" height="16.5" rx="1"/></svg>',
  settings: '<svg class="m-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" stroke-linecap="round"/></svg>',
};

// セクション見出しのアイコン（絵文字廃止・ユーザー要望2026-09-19）。
// h2直前に置くライン画SVGで、色はCSS側でセクションごとに塗り分ける
// （.m-h2.accent-amber等、下の彩色ルール参照）。
const MOBILE_H2_ICONS = {
  brand: '<svg class="m-h2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 16 9 10l4 4 8-9" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 5h6v6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  market: '<svg class="m-h2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="16.5" y="3.5" width="4" height="16.5" rx="1"/></svg>',
  focus: '<svg class="m-h2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>',
  catalyst: '<svg class="m-h2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2c2.5 3 4 6.5 4 10a4 4 0 0 1-8 0c0-3.5 1.5-7 4-10Z" stroke-linejoin="round"/><path d="M9.5 17c-2 1-3 2.7-3 4.5M14.5 17c2 1 3 2.7 3 4.5" stroke-linecap="round"/></svg>',
  star: '<svg class="m-h2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3.5 14.6 9.2 21 10l-4.7 4.3L17.5 21 12 17.7 6.5 21l1.2-6.7L3 10l6.4-.8Z" stroke-linejoin="round"/></svg>',
  settings: MOBILE_TAB_ICONS.settings.replace('m-tab-icon', 'm-h2-icon'),
  monitor: '<svg class="m-cta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M8.5 20h7M12 16.5V20" stroke-linecap="round"/></svg>',
};

// 順位・SCOREを一目で分かるようにする（ユーザー要望2026-09-19）。
// Figmaプロトタイプで検証したスコアバー（グラデーション塗り）をそのまま
// モバイル本番に移植。新規計算はせず既存フィールドをそのまま可視化する。
// AMBUSH由来はr.score（技術・財務の総合力、desktop版scoreGauge()と同じ）
// を使うが、SMART ENTRY由来はこのフィールドを持たず、代わりに
// r.entryPriorityScore（「仕込み優先度」＝コード内で「SCORE/実質SCOREより
// 優先して見てほしい実戦用スコア」と明記されている値、scoreTrio()参照）
// を使う。どちらも0-100点満点で表示は共通化できる。
function mobileScoreBar(r) {
  const score = r.score ?? r.entryPriorityScore?.score ?? r.effectiveScore ?? r.buyScore?.score;
  const label = r.score != null ? 'SCORE' : '仕込み優先度';
  if (!Number.isFinite(score)) return '';
  const pct = Math.max(0, Math.min(100, score));
  return `
      <div class="m-score-row">
        <div class="m-score-bar"><div class="m-score-fill" style="width:${pct}%"></div></div>
        <span class="m-score-n">${label} ${score}</span>
      </div>`;
}

function mobileStockRow(r, i) {
  const pct = r.changePct ?? 0;
  return `
  <a class="m-row" href="#card-${esc(r.code)}" onclick="return mobileShowDesktopCard('${esc(r.code)}')">
    <div class="m-row-main">
      <div class="m-row-top">
        ${Number.isInteger(i) ? `<span class="m-rank" data-top="${i + 1 <= 3 ? i + 1 : 0}">${i + 1}</span>` : ''}
        <span class="m-code">${esc(r.code)}</span>
        <span class="m-name">${esc(r.name)}</span>
      </div>
      ${mobileScoreBar(r)}
    </div>
    <div class="m-row-side">
      <span class="m-price">¥${r.price?.toLocaleString() ?? '--'}</span>
      <span class="m-chg ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct}%</span>
    </div>
  </a>`;
}

function mobileStealthRow(r, i) {
  const tierLabel = r.tier === 'A' ? 'Tier A' : r.tier === 'B' ? 'Tier B' : 'Tier C';
  const tierCls = r.tier === 'A' ? 'm-tier-a' : r.tier === 'B' ? 'm-tier-b' : 'm-tier-c';
  const growth = r.revenueGrowthPct ?? r.earningsTrend?.revenueGrowthPct ?? null;
  return `
  <a class="m-row m-stealth-row" href="#card-${esc(r.code)}" onclick="return mobileShowDesktopCard('${esc(r.code)}')">
    <div class="m-row-main">
      <div class="m-row-top">
        <span class="m-rank" data-top="${i + 1 <= 3 ? i + 1 : 0}">${i + 1}</span>
        <span class="m-code">${esc(r.code)}</span>
        <span class="m-name">${esc(r.name)}</span>
      </div>
      ${mobileScoreBar(r)}
    </div>
    <div class="m-row-side">
      <span class="m-tier-badge ${tierCls}">${tierLabel}</span>
      ${growth !== null ? `<span class="m-growth">売上成長 +${growth}%</span>` : ''}
    </div>
  </a>`;
}

export function buildMobileApp({ now, later, smart, tenbaggerCandidates, macro, amb }) {
  // 「今日の注目」はAMBUSH NOW（決算確定日・SCORE70以上・未織込条件クリア）
  // を最優先にする。無ければSMART ENTRY（需給・乖離ベースの機械的仕込み
  // 候補）で代替する（PC版の並び順・判定基準をそのまま踏襲するだけ）。
  const topPicks = (now.length ? now : smart.results).slice(0, 5);
  const signalList = [...now, ...later, ...smart.results].slice(0, 20);
  const stealthList = tenbaggerCandidates.slice(0, 20);

  const searchIndex = [...amb.results, ...smart.results, ...tenbaggerCandidates]
    .reduce((map, r) => { if (r?.code && !map.has(r.code)) map.set(r.code, r); return map; }, new Map());
  const searchData = [...searchIndex.values()].map((r) => ({
    code: r.code, name: r.name, price: r.price ?? null, changePct: r.changePct ?? null,
  }));
  const policyCount = [...searchIndex.values()].filter((r) => (r.policyCatalyst?.events?.length ?? 0) > 0).length;
  const aiCapexCount = [...searchIndex.values()].filter((r) => (r.aiCapexCatalyst?.events?.length ?? 0) > 0).length;
  const earningsCount = amb.universe ?? 0;
  const nowLabel = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

  return `
<div id="mobile-app">
  <header class="m-topbar">
    <div class="m-brand">${MOBILE_H2_ICONS.brand}日本株 Dashboard</div>
    <div class="m-updated">${nowLabel} 更新</div>
  </header>

  <main class="m-screens">
    <section class="m-screen is-active" data-screen="home">
      <h2 class="m-h2 accent-cyan">${MOBILE_H2_ICONS.market}市場状況</h2>
      <div class="m-market">
        <div class="m-market-cell"><span class="m-k">NIKKEI 225</span><span class="m-v">${macro.nikkei?.toLocaleString() ?? '--'}</span></div>
        <div class="m-market-cell"><span class="m-k">USD/JPY</span><span class="m-v">${macro.usdjpy ?? '--'}</span></div>
      </div>

      <h2 class="m-h2 accent-amber">${MOBILE_H2_ICONS.focus}今日の注目</h2>
      <div class="m-list">
        ${topPicks.length ? topPicks.map((r, i) => mobileStockRow(r, i)).join('') : '<p class="m-empty">本日の該当銘柄はありません</p>'}
      </div>

      <h2 class="m-h2 accent-violet">${MOBILE_H2_ICONS.catalyst}Catalyst</h2>
      <div class="m-stat-row">
        <button class="m-stat" onclick="mobileGoTo('signal')"><span class="m-stat-n">${earningsCount}</span><span class="m-stat-l">決算接近</span></button>
        <button class="m-stat" onclick="mobileGoTo('signal')"><span class="m-stat-n">${policyCount}</span><span class="m-stat-l">政策</span></button>
        <button class="m-stat" onclick="mobileGoTo('signal')"><span class="m-stat-n">${aiCapexCount}</span><span class="m-stat-l">AI</span></button>
      </div>

      <h2 class="m-h2 accent-magenta">${MOBILE_H2_ICONS.star}STEALTH</h2>
      <button class="m-cta" onclick="mobileGoTo('stealth')">仕込み候補 ${stealthList.length}銘柄を見る →</button>
    </section>

    <section class="m-screen" data-screen="signal">
      <h2 class="m-h2 accent-amber">${MOBILE_H2_ICONS.focus}SIGNAL — 今日動きそうな銘柄</h2>
      <div class="m-list">
        ${signalList.length ? signalList.map((r, i) => mobileStockRow(r, i)).join('') : '<p class="m-empty">該当銘柄はありません</p>'}
      </div>
    </section>

    <section class="m-screen" data-screen="stealth">
      <h2 class="m-h2 accent-magenta">${MOBILE_H2_ICONS.star}STEALTH — 中長期の仕込み候補</h2>
      <div class="m-list">
        ${stealthList.length ? stealthList.map((r, i) => mobileStealthRow(r, i)).join('') : '<p class="m-empty">該当銘柄はありません</p>'}
      </div>
    </section>

    <section class="m-screen" data-screen="stock">
      <h2 class="m-h2 accent-cyan">${MOBILE_H2_ICONS.market}STOCK — 銘柄検索</h2>
      <input type="search" id="m-search-input" class="m-search" placeholder="コードまたは銘柄名で検索" inputmode="search" autocomplete="off">
      <div class="m-list" id="m-search-result"></div>
    </section>

    <section class="m-screen" data-screen="settings">
      <h2 class="m-h2">${MOBILE_H2_ICONS.settings}SETTINGS</h2>
      <div class="m-settings-row"><span>最終更新</span><span>${nowLabel}</span></div>
      <div class="m-settings-row"><span>スキャン対象</span><span>${(amb.universe ?? 0) + (smart.universe ?? 0)}銘柄</span></div>
      <button class="m-cta" onclick="mobileShowDesktop()">${MOBILE_H2_ICONS.monitor}PC版を表示</button>
      <p class="m-note">このモバイル画面はβ版です。詳細な判定根拠・全項目はPC版でご確認ください。</p>
    </section>
  </main>

  <nav class="m-tabbar">
    <button class="m-tab is-active" data-tab="home" onclick="mobileGoTo('home')">${MOBILE_TAB_ICONS.home}<i>HOME</i></button>
    <button class="m-tab" data-tab="signal" onclick="mobileGoTo('signal')">${MOBILE_TAB_ICONS.signal}<i>SIGNAL</i></button>
    <button class="m-tab" data-tab="stealth" onclick="mobileGoTo('stealth')">${MOBILE_TAB_ICONS.stealth}<i>STEALTH</i></button>
    <button class="m-tab" data-tab="stock" onclick="mobileGoTo('stock')">${MOBILE_TAB_ICONS.stock}<i>STOCK</i></button>
    <button class="m-tab" data-tab="settings" onclick="mobileGoTo('settings')">${MOBILE_TAB_ICONS.settings}<i>SET</i></button>
  </nav>
</div>
<button id="m-back-btn" onclick="mobileShowMobile()">${MOBILE_TAB_ICONS.home}モバイル表示に戻る</button>
<button id="m-top-btn" onclick="mobileScrollToTop()" aria-label="上へ戻る">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V6M6 11l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>
<div id="m-card-modal" class="m-modal">
  <div class="m-modal-scrim" onclick="mobileCloseCard()"></div>
  <div class="m-modal-sheet">
    <button class="m-modal-close" onclick="mobileCloseCard()" aria-label="閉じる">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
    </button>
    <div class="m-modal-body" id="m-modal-body"></div>
  </div>
</div>
<script id="m-search-data" type="application/json">${JSON.stringify(searchData)}</script>`;
}

// ==================================================================
// メイン
// ==================================================================
async function main() {
  const t0 = Date.now();

  // 祝日判定は場外スキップの前に必要。30日キャッシュなので通常は0リクエスト。
  const hol = await loadHolidays({ force: FORCE });
  HOLIDAYS = hol.dates;
  if (hol.source === 'unavailable') {
    console.error('  ⚠️ 祝日データが無いため、土日判定のみで動作します');
  } else if (hol.coverageEnd && hol.coverageEnd < todayJST()) {
    console.error(`  ⚠️ 祝日データが ${hol.coverageEnd} までしかありません。内閣府CSVの更新を確認してください`);
  }

  if (MARKET_HOURS_ONLY && !isMarketHours()) {
    console.log(`⏸  場外のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
    return;
  }
  // 場外判定の「後」にロックを取る。場外スキップは一瞬なので競合しない。
  if (!acquireLock()) {
    const since = lockHolder?.startedAt
      ? new Date(lockHolder.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : null;
    const held = lockHolder ? ` — PID ${lockHolder.pid}${since ? ` が ${since} から実行中` : ''}` : '';
    console.log(`⏸  別のインスタンスが実行中のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})${held}`);
    return;
  }
  // WATCHDOG_MSの定義コメント参照。場中ジョブ(--market-hours)だけ、
  // ここから先の重い処理が長時間かかりすぎたら自発的に諦めて終了し、
  // ロック(このプロセス内・sync_and_push.sh側の両方)を解放する。
  // 日次フルスキャンはWATCHDOG_MS===nullのため何もしない(既存の
  // 生存確認ベースのロックだけに委ねる)。
  if (WATCHDOG_MS != null) {
    setTimeout(() => {
      // 監視基盤(monitor.mjs)が直近24h/7dの強制終了回数を集計できる
      // よう日時を明記する(2026-09-21ユーザー要望)。
      console.error(
        `${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} `
        + `❌ ${(WATCHDOG_MS / 60000).toFixed(0)}分を超えたため強制終了します`
        + `(ネットワーク不調で個々のリクエストのリトライが積み重なった可能性。次回tickに委ねます)`
      );
      process.exit(1);
    }, WATCHDOG_MS).unref();
  }
  console.log('🚀 STEALTH v7.3 "AMBUSH + SMART ENTRY" 起動');
  const today = todayJST();

  // ---- 日次パート（キャッシュ）------------------------------------
  // extraCodes: 手動ウォッチリスト（watchlist.mjs）。SBIのカレンダーは
  // 「発表がある日」しか列挙しないため、次回決算日がまだ確定/掲載されて
  // いない銘柄は一切拾えない（実測: シマダヤ250A）。extraCodesは銘柄別
  // APIで個別に発表日を確認するために元から用意されていたが、ここに何も
  // 渡されておらず一度も機能していなかった。
  const sbi = await loadEarningsCalendar({ today, horizonDays: 60, extraCodes: MANUAL_WATCHLIST_CODES, force: FORCE });
  const td = await loadDisclosures({ today, days: 14, force: FORCE });
  // 出遅れ修正（セクターローテーション）判定用。今日の値を混ぜると
  // 「業種は既に反発済み」の判定に場中の未確定値が入ってしまうため、
  // 過去日までの履歴を渡してから、今日ぶんは実行後に積み増す。
  const sectorHistory = loadSectorHistory();
  const amb = await runScreen({ today, sbiStocks: sbi.stocks, disclosures: td.byCode, sectorHistory, force: FORCE });
  appendSectorHistory(today, amb.sectors ?? {});
  // SMART ENTRYのスキャン範囲拡張（ユーザー要望2026-09-13「スキャンの
  // 範囲もう少し広げられませんか」）。TDnet直近14営業日∪SBI決算カレン
  // ダーだけだと、直近開示の無い大型株（実例: TOWA）が universe に
  // 一切乗らない。JPX上場銘柄一覧（jpx.mjs、無料・新規依存ライブラリ
  // 無しで取得可能）から、まずはプライム市場銘柄だけを追加する
  // （ユーザー判断: 全市場一気にではなく実行時間への影響を見ながら
  // 段階的に広げる）。取得失敗時はissuesが空配列になり、従来通り
  // TDnet/SBIのみのユニバースにフォールバックする。
  const { issues: jpxIssues } = await loadListedIssues();
  const jpxNames = Object.fromEntries(
    jpxIssues.filter((i) => i.market === 'プライム（内国株式）').map((i) => [i.code, i.name])
  );
  const smart = await runSmartEntryScreen({ today, tdNames: td.names ?? {}, sbiStocks: sbi.stocks, sectors: amb.sectors ?? {}, sectorHistory, force: FORCE, tdByCode: td.byCode ?? {}, jpxNames });
  // 米国株AMBUSH（ユーザー要望）。米国市場が動くのはJST深夜〜早朝のため、
  // JP市場時間限定の5分間隔ジョブには乗せず、日次パート（07:00ジョブ）
  // 側で1日1回更新する。runUsScreen自身がcache.date===todayで日中の
  // 再実行を無料化するため、ここで無条件に呼んでも実害は無い（sbi/td/
  // amb/smartと同じ設計）。
  const us = await runUsScreen({ today, force: FORCE });
  // v7.3改修（ユーザー指示書 項目1/2/7/19）: BUY/EXPECTATION/SURPRISE
  // スコアとDATA/CONFIDENCE/Effective Scoreを、ソート・カード描画の
  // どちらからも同じ値を参照できるよう、結果配列にあらかじめ1回だけ
  // 計算して埋め込む（sort()内で毎回再計算すると同じ値を何度も計算する
  // 無駄が出るため）。
  // A指示 項目1-2/32「仕込み優先度」: 「ユーザーが最も見たい実戦用
  // スコア」。既存のリスク減点（buyScoreRiskPenalty、badChipSignals該当
  // 件数×10点）をentryPriorityにも同じ考え方で適用する。
  const attachScores = (results) => results.map((r) => {
    const parts = buildScoreParts(r);
    const riskPenalty = buyScoreRiskPenalty(r);
    const buy = buyScore(parts.buy, riskPenalty);
    const priority = entryPriorityScore(parts.entryPriority, riskPenalty);
    return {
      ...r,
      buyScore: buy,
      expectationScore: expectationScore(parts.expectation),
      earningsSurpriseScore: earningsSurpriseScore(parts.surprise),
      confidenceTier: confidenceTier(buy.confidence),
      effectiveScore: effectiveScore(buy.score, buy.confidence),
      entryPriorityScore: priority,
      // 第3優先改修: VALUATION/FUNDAMENTALS/CATALYST/PRICE_SUPPLY/TIMING
      // への分類（読み取り専用の集計。既存スコアの配点は変更しない。
      // indicators.mjsのevaluationAxes()参照）。
      evaluationAxes: evaluationAxes(r),
      // 第5優先改修: クラスタ内の重複カウント抑制（読み取り専用の新規
      // 診断指標。既存スコアの配点は変更しない。indicators.mjsの
      // clusterConfirmation()参照）。
      clusterConfirmation: clusterConfirmation(r),
      // 第7優先改修: 信用需給の意味の分離（SUPPLY_PRESSURE/BUYING_DEMAND/
      // SQUEEZE_POTENTIAL/LIQUIDITY_QUALITY、読み取り専用。既存スコアの
      // 配点は変更しない。indicators.mjsのcreditSupplyBreakdown()参照）。
      creditSupplyBreakdown: creditSupplyBreakdown(r),
      // 第8優先改修: AMBUSHの時間軸とシグナルの分離（EARNINGS_DISTANCE/
      // EARNINGS_DATE_CONFIDENCE/CATALYST_SIGNAL/PRICE_REACTION/
      // PRICING_STATUS、読み取り専用。既存のWINDOW/bucket判定・
      // ambushVerdictの条件は変更しない。indicators.mjsの
      // ambushTimingBreakdown()参照）。
      ambushTimingBreakdown: ambushTimingBreakdown(r),
      // 第6優先改修■5: 財務品質のまとめ表示構造（読み取り専用。既存
      // シグナルの判定は変更しない。indicators.mjsのfinancialQuality
      // Breakdown()参照）。
      financialQualityBreakdown: financialQualityBreakdown(r),
      // A指示 項目23「DATA%を順位に反映する（Confidence Adjustmentを
      // 最終スコアに追加する）」: BUY SCOREにはeffectiveScoreで既に
      // 適用済みだが、項目32が「ユーザーが見るべき」と明言した仕込み
      // 優先度自体には confidence（entryPriorityの7軸のうち何軸に
      // データが揃ったか）による割り引きが一切適用されていなかった
      // （実測: 判断材料がほぼ無い銘柄でも仕込み優先度が高い数値に
      // なり得た）。BUY SCOREと同じconfidenceTier/CONFIDENCE_ADJUSTMENT
      // の仕組みをそのまま再利用する。
      entryPriorityConfidenceTier: confidenceTier(priority.confidence),
      entryPriorityEffective: effectiveScore(priority.score, priority.confidence),
    };
  });
  amb.results = attachScores(amb.results ?? []);
  us.results = attachScores(us.results ?? []);
  // POLICY CATALYST(Phase2、非侵食の独立入力)。読み込み失敗時は
  // available:falseになるだけで、既存のBUY SCORE等には一切触れない
  // （policy_catalyst.mjsのIMPORTANT参照）。米国株(us.results)は
  // 政策シグナル側が日本株コードのみのため対象外。
  const policyCatalyst = loadPolicyCatalystByCode(POLICY_CATALYST_PATH);
  // Phase3(検証フェーズ): Policy Catalyst Scoreは既存BUY SCORE等とは
  // 完全に独立した別計算(policy_catalyst_score.mjs参照)。ここではrに
  // 新しいフィールドを2つ足すだけで、既存フィールドは一切書き換えない。
  const attachPolicyCatalyst = (results) => results.map((r) => {
    const pc = policyCatalyst.available ? (policyCatalyst.byCode[r.code] ?? null) : null;
    return {
      ...r,
      policyCatalyst: pc,
      policyCatalystScore: computePolicyCatalystScore(pc, r),
    };
  });
  amb.results = attachPolicyCatalyst(amb.results);
  // v7.4改修（ユーザー要望「仕込み度と成長性を完全分離する」）: SMART
  // ENTRYの結果オブジェクトにも、buildScoreParts/buyScore/expectationScore
  // が参照するフィールド（revenueGrowthPct/repricingLag等）を露出させた
  // ため、AMBUSHと同じattachScoresがそのまま使える。r.score/r.daysLeft/
  // r.consensusTrapはSMART ENTRYに存在しないため該当partsはnullのまま
  // 縮退する（既存の設計通り）。
  smart.results = attachScores(smart.results ?? []);
  smart.results = attachPolicyCatalyst(smart.results);
  // AI CAPEX CATALYST(Phase1/2相当、非侵食の独立入力)。POLICY CATALYSTと
  // 同じJSONファイルを読むが、完全に別の集約結果(ai_capex_catalyst.mjs
  // 参照)であり、スコアは一切合算しない(ユーザー指示、必ず守ること)。
  const aiCapexCatalyst = loadAiCapexCatalystByCode(POLICY_CATALYST_PATH);
  const attachAiCapexCatalyst = (results) => results.map((r) => ({
    ...r,
    aiCapexCatalyst: aiCapexCatalyst.available ? (aiCapexCatalyst.byCode[r.code] ?? null) : null,
  }));
  amb.results = attachAiCapexCatalyst(amb.results);
  smart.results = attachAiCapexCatalyst(smart.results);
  // ③ 同一政策テーマ内の競合比較(policy_catalyst_compare.mjs参照)。
  // 今回のビルドでentryPriorityScoreが計算済みの銘柄(=amb/smart両方の
  // 足切りを通った銘柄)だけが比較対象になるという既知の限界がある。
  const policyThemeComparisons = groupPolicyCatalystByTheme([...amb.results, ...smart.results]);
  // Phase3(検証フェーズ)の記録基盤: 既存BUY SCOREとPolicy Catalyst
  // Scoreを同じ日のスナップショットとして残す。まだ検証(前方リターンとの
  // 突き合わせ)はしない — Nが溜まってから別途行う。失敗してもサイト
  // 生成自体は止めない(jp-news-dashboard側の記録処理と同じ方針)。
  try {
    const added = recordPolicyCatalystSnapshot(today, [...(amb.results ?? []), ...(smart.results ?? [])]);
    if (added > 0) {
      const status = policyCatalystBacktestStatus();
      console.log(`📊 POLICY CATALYST検証ログ: 本日+${added}件(累計${status.days}日分・${status.totalSnapshots}件、${status.firstDate}〜${status.lastDate})`);
    }
  } catch (e) {
    console.error(`⚠️ POLICY CATALYST検証ログの記録に失敗しました(${e?.message ?? e})。サイト生成は続行します。`);
  }
  // 第8優先改修: AMBUSHの時間軸区分（7〜30日等）が将来検証できるよう、
  // AMBUSH側だけを対象に記録する（POLICY CATALYSTとは別ファイル・別集計）。
  try {
    const addedTiming = recordAmbushTimingSnapshot(today, amb.results ?? []);
    if (addedTiming > 0) {
      const status = ambushTimingBacktestStatus();
      console.log(`📊 AMBUSH時間軸検証ログ: 本日+${addedTiming}件(累計${status.days}日分・${status.totalSnapshots}件、${status.firstDate}〜${status.lastDate})`);
    }
  } catch (e) {
    console.error(`⚠️ AMBUSH時間軸検証ログの記録に失敗しました(${e?.message ?? e})。サイト生成は続行します。`);
  }
  // AI CAPEX CATALYSTも同じ方針で記録する(POLICY CATALYSTとは別ファイル・
  // 別集計。合算しない)。
  try {
    const addedCapex = recordAiCapexCatalystSnapshot(today, [...(amb.results ?? []), ...(smart.results ?? [])]);
    if (addedCapex > 0) {
      const status = aiCapexCatalystBacktestStatus();
      console.log(`📊 AI CAPEX CATALYST検証ログ: 本日+${addedCapex}件(累計${status.days}日分・${status.totalSnapshots}件、${status.firstDate}〜${status.lastDate})`);
    }
  } catch (e) {
    console.error(`⚠️ AI CAPEX CATALYST検証ログの記録に失敗しました(${e?.message ?? e})。サイト生成は続行します。`);
  }
  // 実測バグ（横断監査で発覚）: precursorCard()はprecursorSource==='growth'
  // （成長株予兆スキャン、smart.growthPrecursors）に対してもscoreTrio(r)
  // を無条件に呼んでいるが、smart.growthPrecursorsだけattachScoresを
  // 一度も通していなかったため、r.buyScoreが常にundefinedとなり
  // scoreTrio内の`if (!r.buyScore) return ''`で毎回黙って空文字を返して
  // いた（＝仕込み優先度/BUY/EXPECTATION/SURPRISE/RISK/CONFIDENCEの
  // チップが成長株予兆カードにだけ一つも出ない状態が続いていた）。
  // per/sectorPer等は無くbuyScoreのconfidenceは低くなるが、
  // revenueGrowthPct/growthAcceleration/themeMatch/growthAnomalyCautionは
  // 既にこのオブジェクトに含まれているため、仕込み優先度の該当軸だけは
  // 意味のある値になる（exitPlanBlock配線忘れと全く同じ原因パターン。
  // precursorCard関数冒頭のコメント参照）。
  smart.growthPrecursors = attachScores(smart.growthPrecursors ?? []);
  // テンバガー探索（決算日非依存）。AMBUSH（米国株、決算日依存）とは
  // 完全に分離した独立スキャン。手動キュレーションリストのみを対象と
  // するため軽量で、runUsScreenと同様ここで無条件に呼んでも実害は無い。
  const usTenbagger = await runUsTenbaggerScreen({ today, force: FORCE });
  auditSignalShapes(amb.results, 'AMBUSH');
  auditSignalShapes(smart.results, 'SMART ENTRY');
  auditSignalShapes(smart.growthPrecursors ?? [], '成長株予兆');
  auditSignalShapes(smart.tenbaggerCandidatesA ?? [], 'テンバガー候補Tier A(JP)');
  auditSignalShapes(smart.tenbaggerCandidatesB ?? [], 'テンバガー候補Tier B(JP)');
  auditSignalShapes(us.results ?? [], '米国株AMBUSH');
  auditSignalShapes(usTenbagger.results ?? [], 'テンバガー候補(US)');
  // v7.3改修 項目17: 理由文と数値の矛盾チェック（自動生成した「なぜこの
  // 順位か」がverdictと食い違っていないかの自己点検）。
  auditReasonConsistency(amb.results, ambushVerdict, 'AMBUSH');
  auditReasonConsistency(us.results ?? [], ambushVerdict, '米国株AMBUSH');
  auditReasonConsistency(smart.results, (r) => smartEntryVerdict(r, overheatSignal(r.kairi), growthSurgeSignal(r.market, r.closes)), 'SMART ENTRY');

  if (DAILY_ONLY) {
    console.log(`✅ 日次パート完了 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    return;
  }

  // ---- SECTION A / C: AMBUSH（上位のみ場中も価格更新）---------------
  // NOW = 先行カタリストありの本命。
  // SECTION C には 決算まで31〜45日(WATCH) だけでなく、NOW条件を満たさなかった
  // 決算まで7〜30日(NEAR) も入れる。ゲートで落ちた銘柄を画面から消してしまうと
  // 「Stage 1 を通過した銘柄が何だったのか」が追えなくなるため。
  // 先行カタリストを持つものを上に、次にスコア順。
  // nowも後段のlive選定（AMBUSH_LIVE件に絞って価格更新）で使うため、
  // filter直後の未整列のままにせず、ここでconviction順にしておく
  // （NOW該当が稀に12件を超えた場合、整列していないと価格更新対象の
  // 選定が実質ランダムな順序になってしまう）。
  const now = amb.results
    .filter((r) => r.bucket === 'NOW')
    .sort((a, b) => ambushConviction(b) - ambushConviction(a));
  const later = amb.results
    .filter((r) => r.bucket !== 'NOW' && r.bucket !== 'PRE')
    .sort((a, b) => (b.evidence === true) - (a.evidence === true) || (ambushConviction(b) - ambushConviction(a)))
    .slice(0, AMBUSH_WATCH_MAX);
  // NOW条件（確定日・SCORE70以上）は満たさなかったが、TDnetに好材料の開示や
  // 月次KPIなど「先行カタリストの根拠」があるものだけを仕込み候補として分離する。
  // 根拠が無い銘柄はスコアが高くても、進捗率/セクター/テクニカルだけで
  // 積み上がった数字なので参考程度（section()のグループ分けで可視化）。
  const laterEvidence = later.filter((r) => r.evidence);
  const laterNoEvidence = later.filter((r) => !r.evidence);
  // v7.3改修 項目5: PRE-AMBUSH（決算まで46〜60日、早期監視）。WATCHと
  // 同じ「先行カタリストの有無」基準で仕込み候補/参考に分ける（新しい
  // 判定軸を増やさず、既存のevidenceベースの分類をそのまま流用する）。
  const pre = amb.results
    .filter((r) => r.bucket === 'PRE')
    .sort((a, b) => (b.evidence === true) - (a.evidence === true) || (ambushConviction(b) - ambushConviction(a)))
    .slice(0, AMBUSH_WATCH_MAX);
  const preEvidence = pre.filter((r) => r.evidence);
  const preNoEvidence = pre.filter((r) => !r.evidence);
  // NOW該当だけでAMBUSH_LIVE件を超えることは今のところ実測で起きていない
  // （NOWは決算間近＋SCORE70以上＋根拠ありという厳しいAND条件のため）。
  // 起きた場合はlater側が一切価格更新されなくなり見た目に気づきにくいため、
  // 想定外の事態として警告だけ出しておく。
  if (now.length > AMBUSH_LIVE) {
    console.error(`  ⚠️ AMBUSH NOW該当が${now.length}件でAMBUSH_LIVE(${AMBUSH_LIVE})を超えています。WATCH側が価格更新されません`);
  }
  const live = [...now, ...later].slice(0, AMBUSH_LIVE);

  let macro = { nikkei: null, usdjpy: null };
  if (live.length) {
    console.log(`🔄 AMBUSH上位${live.length}銘柄の価格を更新`);
    for (const r of live) {
      try {
        const iv = await fetchIntraday(r.code);
        if (iv.macro.nikkei) macro = iv.macro;
        r.price = iv.price;
        r.changePct = iv.changePct;
        r.closes = iv.closes.slice(-20);
        r.kairi = kairi(iv.price, iv.closes);
        r.rsi = rsi(iv.closes);
        r.volZ = volumeZScore(iv.volumes);
        r.live = true;
      } catch (e) {
        console.error(`  ⚠️ ${r.code} 価格更新失敗: ${e.message}`);
      }
      await sleep(REQ_GAP);
    }
  }

  // SMART ENTRYと同じ理由（場中の値動きで結論が「買い推奨」から落ちた
  // 銘柄が、朝のバッチ時点の並び順のまま上位に居座るのを防ぐ）で、
  // ステータスランプを最優先の基準に並べ直す。
  const verdictRank = (r) => VERDICT_SEVERITY[ambushVerdict(r).level] ?? VERDICT_SEVERITY.hold;
  // v7.3改修 項目19: 「BUY SCORE→未織り込み度→サプライズ→タイミング→
  // CONFIDENCE」の優先順位で同一verdict内を並べる。verdict（結論）自体を
  // 最優先の基準にする設計は維持する（「高SCORE＋様子見」が「低SCORE＋
  // 強い買い候補」より上位に来る矛盾を避けるため。項目19後半の注記）。
  const scoreRank = (r) => ({
    effective: r.effectiveScore ?? -1,
    unpriced: r.buyScore?.detail?.unpriced?.value ?? -1,
    surprise: r.buyScore?.detail?.surprise?.value ?? -1,
    timing: r.buyScore?.detail?.timing?.value ?? -1,
  });
  const byVerdict = (a, b) => {
    const rankDiff = verdictRank(a) - verdictRank(b);
    if (rankDiff !== 0) return rankDiff;
    const sa = scoreRank(a), sb = scoreRank(b);
    return (sb.effective - sa.effective)
      || (sb.unpriced - sa.unpriced)
      || (sb.surprise - sa.surprise)
      || (sb.timing - sa.timing)
      || (ambushConviction(b) - ambushConviction(a));
  };
  now.sort(byVerdict);
  laterEvidence.sort(byVerdict);
  laterNoEvidence.sort(byVerdict);
  preEvidence.sort(byVerdict);
  preNoEvidence.sort(byVerdict);
  // 実測バグ（ユーザー報告）: 米国株AMBUSHはus_screener.mjs側でSCORE降順
  // にしか並んでおらず、verdict（買い推奨/様子見/見送り）による並び替えが
  // 一切行われていなかった。ALOYがSCORE 70で1位表示されながら、
  // ambushVerdictは（上で追加したrepricingLag.zone==='priced_in'の
  // 配線により）見送りと判定するのに、順位はそれを一切反映しないという
  // 矛盾があった。JPのnow/later同様、verdict最優先→同verdict内は
  // ambushConviction降順で並べ直す。
  us.results = (us.results ?? []).sort(byVerdict);

  // ---- カタリスト予兆セクション ---------------------------------
  // 元々はAMBUSHが既に取得済みのデータ（対象は決算まで7〜60日の銘柄）
  // だけが対象だったが、ユーザー要望「成長株にも入れて欲しい」に対応し、
  // smart_entry.mjsが東証グロース市場銘柄全体から出来高・時価総額で
  // 絞り込んで別途スキャンした結果（smart.growthPrecursors）も合流させる。
  //
  // 実測バグ（ユーザー指摘「カタリスト予兆でなんでリンガーハット1位に
  // なってるの」）: 旧ロジックは好材料の予兆(good)も注意予兆(bad/warn)も
  // 同じ「該当件数」として合算し降順に並べていたため、「売掛金急増
  // (bad)」のような悪材料が付いているだけで件数が1件増え、悪材料の無い
  // 銘柄より上位に来てしまっていた（実測: 8200リンガーハット・
  // 3608TSI・6505東洋電機はいずれも「進捗率加速(good)×1＋売掛金急増
  // (bad)×1＝2件」で、進捗率加速だけ(good×1＝1件)の6469・7607・4187
  // より上に来ていた。悪材料の有無で順位が入れ替わっていない状態）。
  // good件数は引き続き降順（多いほど上位）にしつつ、caution件数は
  // 昇順（悪材料が少ないほど上位）に直し、さらに同点の場合はAMBUSH由来
  // ならeffectiveScore（BUY SCORE×CONFIDENCE係数）でも並べる。
  const precursors = [
    ...amb.results.filter(hasPrecursor).map((r) => ({ ...r, precursorSource: 'ambush' })),
    ...(smart.growthPrecursors ?? []).map((r) => ({ ...r, precursorSource: 'growth' })),
  ].sort((a, b) => {
    const ra = precursorRank(a), rb = precursorRank(b);
    return (rb.good - ra.good) || (ra.caution - rb.caution) || (rb.effective - ra.effective);
  });

  // ---- テンバガー候補セクション（ユーザー提案、Tier A/B 2階建て）---
  // 決算日には一切依存しない（AMBUSHとは完全分離）。日本株は
  // smart_entry.mjsの東証グロース向け成長株予兆スキャンから、米国株は
  // us_tenbagger.mjsの決算日非依存キュレーションリストスキャンから、
  // どちらも既にTier A(tenbaggerSignal: 低時価総額×高成長率、本来の
  // テンバガー候補)/Tier B(midCapGrowthSignal: 300億〜1000億円/
  // $1B〜$10Bの、10倍は非現実的だが2〜3倍は狙えるグロース中堅株)
  // で絞り込み済みのものを合流させる（追加のフィルタ・リクエストは無い）。
  // 日本株(百万円)と米国株(百万USD)は通貨単位が異なり、時価総額を
  // そのまま数値比較すると円建ての値が見かけ上大きくなり公平な順位に
  // ならないため、市場をまたいだ時価総額比較はしない。各Tier内は
  // 仕込みゾーンが🔴織り込み済みの銘柄を下位に回した上でrevenueGrowthPct
  // （成長ポテンシャルの強さの目安）降順に日本株→米国株の順で連結する
  // （byTenbaggerRank参照。ユーザー報告: Tier A 1位のG-MFSがzone:
  // 'priced_in'なのに1位に居座り続けていた問題の再発防止）。
  // JP側はrevenueGrowthPctを直接、US側はearningsTrend.revenueGrowthPctに
  // 持つ（データソースの構造差。us_tenbagger.mjs参照）。
  // 実測バグ: 以前はここで件数を切らず、Tier A/Bの小見出し・HUDの
  // 「💎テンバガー」件数バッジには未カットの合計（例: Tier B 11件）を
  // 表示しながら、カード自体はrender呼び出し側の.slice(0, RANK_TOP_N)で
  // 10件までしか出しておらず、「(11件)」と見出しに書いてあるのにカードは
  // 10枚しか無い、という表示上の矛盾が発生していた。AMBUSH WATCH（later
  // 変数）が既にconst定義時点で.slice(0, AMBUSH_WATCH_MAX)している
  // パターンに揃え、ここで一度だけ切ることで見出し・HUD・カード枚数を
  // 常に一致させる。
  // 株価帯フィルター（ユーザー要望「株価が高いものはやはり除外して」）。
  // テンバガー候補セクション限定で、低位株の理想帯を外れる銘柄は
  // Tier A/Bどちらでも候補自体から外す（他セクションには影響しない）。
  const inPriceBand = (r) => passesPriceBand(r.price, r.hasCatalyst, r.tenbaggerSource === 'us', r.diamond?.level === 'good');
  const tenbaggersA = [
    ...(smart.tenbaggerCandidatesA ?? []).map((r) => ({ ...r, tenbaggerSource: 'jp' })),
    ...(usTenbagger.results ?? []).filter((r) => r.tier === 'A').map((r) => ({ ...r, tenbaggerSource: 'us' })),
  ].filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  const tenbaggersB = [
    ...(smart.tenbaggerCandidatesB ?? []).map((r) => ({ ...r, tenbaggerSource: 'jp' })),
    ...(usTenbagger.results ?? []).filter((r) => r.tier === 'B').map((r) => ({ ...r, tenbaggerSource: 'us' })),
  ].filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  // A指示 項目13「米国テンバガーTierを3段階にする」: Tier C（$10B〜$20B
  // 程度・大型化後の超成長株）はJP側には存在しない（米国株のみ）ため
  // us_tenbagger.mjsの結果のみをフィルタする。
  const tenbaggersC = (usTenbagger.results ?? []).filter((r) => r.tier === 'C').map((r) => ({ ...r, tenbaggerSource: 'us' }))
    .filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  const tenbaggerCandidates = [...tenbaggersA, ...tenbaggersB, ...tenbaggersC];
  // 「テンバガー候補監視リスト」（ユーザー提案2026-09-13）。Tier A/B/Cの
  // 自動判定条件（時価総額レンジ・成長率等）とは無関係に、ユーザーが
  // 個別選定した銘柄の信用需給を毎回追跡する（実例: TOWA(6315)、
  // 信用買い残が高すぎるので下がったら買うという需給待ちの監視）。
  const tenbaggerWatchlist = smart.tenbaggerWatchlist ?? [];

  // ---- SECTION B: SMART ENTRY（上位のみ場中も再判定）----------------
  // 信用残（週次）と決算は日次スキャン時点のまま据え置き、テクニカルだけ
  // 再取得して3パターンの該当状況を再判定する。
  const smartLive = smart.results.slice(0, SMART_LIVE);
  if (smartLive.length) {
    console.log(`🔄 SMART ENTRY上位${smartLive.length}銘柄を再判定`);
    for (const r of smartLive) {
      try {
        const iv = await fetchIntraday(r.code);
        if (!macro.nikkei && iv.macro.nikkei) macro = iv.macro;
        r.price = iv.price;
        r.changePct = iv.changePct;
        r.closes = iv.closes.slice(-20);
        r.kairi = kairi(iv.price, iv.closes);
        r.rsi = rsi(iv.closes);
        r.cross = goldenCross(iv.closes);
        r.volRatio = volumeRatio(iv.volumes);
        r.sig1 = reboundPatternSignal({ kairi: r.kairi, rsi: r.rsi, creditTrendPct: r.creditTrendPct });
        r.sig2 = trendReversalPatternSignal({ cross: r.cross, volRatio: r.volRatio, loanRatio: r.loanRatio });
        r.sig3 = laggingPatternSignal({
          creditLevelPct: r.creditLevelPct, estimateProfit: r.estimateProfit, consensusProfit: r.consensusProfit, kairi: r.kairi,
        });
        r.matched = [r.sig1.level === 'good', r.sig2.level === 'good', r.sig3.level === 'good'].filter(Boolean).length;
        r.live = true;
      } catch (e) {
        console.error(`  ⚠️ ${r.code} 再判定失敗: ${e.message}`);
      }
      await sleep(REQ_GAP);
    }
  }

  // 場中の再判定で「買い推奨」→「様子見/見送り」に変わった銘柄が、
  // 朝のバッチ時点の並び順のまま上位に居座らないよう、結論（ステータス
  // ランプ）を最優先の基準にして並べ直す。順位バッジは表示直前の
  // この配列の並びをそのまま数字にしているため、ここで直す必要がある。
  // A指示 項目31/33: 結論→仕込み優先度→未織り込み度→…の8段階カスケード
  // （+同点解消）に更新（smartEntryRank参照）。
  smart.results.sort(smartEntryRank);

  if (!smart.results.length && !amb.results.length) {
    console.error('❌ 1銘柄も取得できませんでした。index.html は更新しません。');
    process.exit(1);
  }

  const caution = macro.usdjpy !== null && macro.usdjpy < 145;
  const readout = (label, value, unit = '', cls = '') =>
    `<div class="ro"><span class="ro-k">${label}</span><span class="ro-v ${cls}">${value}<i>${unit}</i></span></div>`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<!-- これが無いとモバイルSafariは幅980pxで描画して全体を縮小するため、
     @media(max-width:520px) が発火せず文字が読めない。スマホ表示の必須項目。
     user-scalable は制限しない（拡大したい場面があるため）。 -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#05070d">
<!-- ホーム画面に追加したときに全画面で開く -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="STEALTH">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.json">
<title>STEALTH v7.3 AMBUSH + SMART ENTRY</title>
<style>
  :root{
    --bg:#05070d; --panel:rgba(17,24,38,.62); --line:rgba(90,130,190,.20);
    --txt:#ffffff; --dim:#e3eeff; --cyan:#31e0ff; --mint:#22ffc4;
    --rose:#ff3d71; --amber:#ffb43d; --blue:#4d9fff; --violet:#a78bfa;
    --mono:"SF Mono",'JetBrains Mono',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}

  body{
    background:var(--bg); color:var(--txt); min-height:100vh; padding:32px 28px 48px;
    font-family:"Helvetica Neue","Hiragino Sans","Noto Sans JP",sans-serif;
    -webkit-font-smoothing:antialiased; position:relative; overflow-x:hidden;
  }
  body::before{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background:
      radial-gradient(900px 600px at 12% -10%, rgba(49,224,255,.13), transparent 60%),
      radial-gradient(800px 520px at 92% 4%, rgba(124,77,255,.13), transparent 62%),
      radial-gradient(700px 700px at 50% 115%, rgba(34,255,196,.07), transparent 60%);
  }
  body::after{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;
    background-image:linear-gradient(rgba(90,140,200,.055) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(90,140,200,.055) 1px,transparent 1px);
    background-size:46px 46px;
    mask-image:radial-gradient(circle at 50% 30%,#000 30%,transparent 82%);
  }
  .wrap{position:relative;z-index:1;max-width:1560px;margin:0 auto}

  .top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px}
  .brand{display:flex;align-items:center;gap:14px}
  .logo{width:38px;height:38px;border:1px solid rgba(49,224,255,.5);border-radius:9px;
        display:grid;place-items:center;background:rgba(49,224,255,.07);
        box-shadow:0 0 22px rgba(49,224,255,.28) inset,0 0 18px rgba(49,224,255,.14)}
  .logo span{font:700 20px/1 var(--mono);color:var(--cyan)}
  h1{font-size:27px;font-weight:600;letter-spacing:.16em}
  h1 b{color:var(--cyan);font-weight:600}
  .sub{font:400 14px/1 var(--mono);color:var(--dim);letter-spacing:.24em;margin-top:6px}
  .live{display:flex;align-items:center;gap:7px;font:500 14px/1 var(--mono);
        color:var(--mint);letter-spacing:.18em}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--mint);
       box-shadow:0 0 9px var(--mint);animation:blink 1.9s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.8)}}

  .hud{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--line);border-radius:13px;
       background:linear-gradient(180deg,rgba(20,29,46,.8),rgba(11,17,29,.62));
       backdrop-filter:blur(9px);overflow:hidden;margin-bottom:26px;
       border-left:2px solid ${caution ? 'var(--rose)' : 'var(--mint)'}}
  .ro{flex:1;min-width:150px;padding:14px 20px;border-right:1px solid var(--line)}
  .ro:last-child{border-right:0}
  .ro-k{display:block;font:500 13px/1 var(--mono);color:var(--dim);letter-spacing:.2em;margin-bottom:7px}
  .ro-v{font:600 27px/1 var(--mono);color:var(--txt);letter-spacing:.01em}
  .ro-v i{font-style:normal;font-size:14.5px;color:var(--dim);margin-left:3px}

  /* ── 初心者ガイド ── */
  .guide{border:1px solid var(--line);border-radius:13px;
         background:linear-gradient(180deg,rgba(20,29,46,.8),rgba(11,17,29,.62));
         backdrop-filter:blur(9px);margin-bottom:26px;padding:0 20px}
  .guide summary{list-style:none;cursor:pointer;padding:14px 0;
                 font:600 15px/1 var(--mono);color:var(--cyan);letter-spacing:.06em;
                 display:flex;align-items:center;gap:8px;user-select:none}
  .guide summary::-webkit-details-marker{display:none}
  .guide summary::after{content:"▾";margin-left:auto;color:var(--dim);transition:transform .2s}
  .guide[open] summary::after{transform:rotate(180deg)}
  .guide-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
              gap:22px;padding-bottom:18px;border-top:1px solid var(--line);padding-top:16px}
  .guide-h{font:700 13px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:10px}
  .guide-list{list-style:none;display:flex;flex-direction:column;gap:9px}
  .guide-list li{font:400 14.5px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
                 color:var(--dim)}
  .guide-list li b{color:var(--txt);font-weight:600}
  .guide-list .chip{margin-right:6px;pointer-events:none}
  @media(max-width:520px){
    .guide{padding:0 15px}
    .guide-body{grid-template-columns:1fr;gap:16px}
  }

  /* ── セクション（<details>化して折りたたみ可能に） ── */
  .sec{margin-bottom:34px}
  .sec-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:15px;
            padding-bottom:11px;border-bottom:1px solid var(--line);
            cursor:pointer;list-style:none}
  .sec-head::-webkit-details-marker{display:none}
  .sec-head h2{font-size:20px;font-weight:600;letter-spacing:.13em;display:flex;align-items:center;gap:9px}
  .ico{font-size:20px}
  /* ユーザー要望「セクションをカテゴリの右上に書いて。ワク作って」:
     SECTION A/B/Cは内部コード用語でUI上に一切表示されておらず、
     ユーザーが見つけられなかった（前回のやり取り参照）。見出しの右上
     （h2の直後・pより前）に枠付きバッジとして明示する。margin-left:auto
     で右へ寄せ、pにflex-basis:100%を付けて必ず次の行へ折り返させる
     ことで、既存の▾開閉アイコン（同じflexコンテナのafter擬似要素で
     margin-left:autoを使っている）と衝突せず両立させる。 */
  .sec-badge{margin-left:auto;font:600 13px/1 var(--mono);letter-spacing:.08em;color:var(--dim);
             border:1px solid var(--line);border-radius:5px;padding:4px 9px;white-space:nowrap;flex-shrink:0}
  .sec-head p{font:400 14px/1.6 var(--mono);color:var(--dim);letter-spacing:.06em;flex-basis:100%}
  .sec-head::after{content:"▾";margin-left:auto;color:var(--dim);transition:transform .2s;flex-shrink:0}
  .sec:not([open]) .sec-head{margin-bottom:0;border-bottom:none}
  .sec:not([open]) .sec-head::after{transform:rotate(-90deg)}
  .empty{padding:26px 22px;border:1px dashed var(--line);border-radius:12px;
         font:400 15px/1.8 var(--mono);color:var(--dim);background:rgba(12,18,30,.4)}

  /* ── ③ POLICY CATALYST 競合比較 ── */
  .pcc-theme{margin:0 0 24px}
  .pcc-theme-head{font:700 14px/1 var(--mono);color:var(--violet);margin-bottom:10px}
  .pcc-count{color:var(--dim);font-weight:400;font-size:12px}
  .pcc-table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
  .pcc-table{width:100%;border-collapse:collapse;font:400 13px/1.5 var(--mono);white-space:nowrap}
  .pcc-table th,.pcc-table td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line)}
  .pcc-table th{color:var(--dim);font-weight:700;font-size:11.5px;letter-spacing:.05em}
  .pcc-table tr:last-child td{border-bottom:none}
  .pcc-table tr.pcc-top td{background:rgba(167,139,250,.08)}
  .pcc-rank{color:var(--violet);font-weight:700}
  .pcc-name .code{color:var(--dim);margin-right:4px}

  /* ── AMBUSH WATCHのサブグループ見出し（仕込み候補 / 参考） ── */
  .subhead{font:700 13.5px/1 var(--mono);letter-spacing:.1em;margin:22px 0 13px;
           padding-bottom:8px;border-bottom:1px dashed var(--line)}
  .sec .grid + .subhead{margin-top:26px}
  .subhead.sub-good{color:var(--mint)}
  .subhead.sub-ref{color:var(--dim)}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:19px}
  .card{position:relative;padding:19px 21px 15px;border-radius:15px;
        background:var(--panel);backdrop-filter:blur(13px);
        border:1px solid var(--line);
        box-shadow:0 12px 34px rgba(0,0,0,.46);
        animation:rise .5s cubic-bezier(.2,.8,.3,1) backwards;
        animation-delay:calc(var(--i) * 55ms);transition:transform .3s,box-shadow .3s,border-color .3s}
  @keyframes rise{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:none}}
  .card:hover{transform:translateY(-4px);border-color:rgba(49,224,255,.42);
              box-shadow:0 18px 44px rgba(0,0,0,.55),0 0 26px rgba(49,224,255,.14)}
  .card::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;
    background:linear-gradient(90deg,transparent,rgba(49,224,255,.55),transparent)}
  .s-rank{border-color:rgba(34,255,196,.44);box-shadow:0 12px 34px rgba(0,0,0,.46),0 0 30px rgba(34,255,196,.14)}
  .s-rank::before{background:linear-gradient(90deg,transparent,var(--mint),transparent)}
  .a-rank{border-color:rgba(49,224,255,.36)}

  .br{position:absolute;width:9px;height:9px;border:1px solid rgba(49,224,255,.42);opacity:.8}
  .tl{top:8px;left:8px;border-right:0;border-bottom:0}
  .tr{top:8px;right:8px;border-left:0;border-bottom:0}
  .bl{bottom:8px;left:8px;border-right:0;border-top:0}
  .br2{bottom:8px;right:8px;border-left:0;border-top:0}

  .c-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .code{font:600 13.5px/1 var(--mono);color:var(--cyan);letter-spacing:.22em;
        padding:4px 8px;border:1px solid rgba(49,224,255,.3);border-radius:5px;
        background:rgba(49,224,255,.07);display:inline-block}
  .rank{font:700 13.5px/1 var(--mono);letter-spacing:.1em;padding:4px 7px;border-radius:5px;
        margin-left:5px;display:inline-block;border:1px solid}
  .r-S{color:#05070d;background:var(--mint);border-color:var(--mint)}
  .r-A{color:var(--cyan);background:rgba(49,224,255,.14);border-color:rgba(49,224,255,.5)}
  .r-B{color:var(--blue);background:rgba(77,159,255,.12);border-color:rgba(77,159,255,.4)}
  .r-C{color:var(--amber);background:rgba(255,180,61,.1);border-color:rgba(255,180,61,.35)}
  .r-D{color:var(--dim);background:rgba(125,144,173,.08);border-color:var(--line)}

  /* ── セクション内の順位バッジ ── */
  .rankpos{font:700 13px/1 var(--mono);letter-spacing:.06em;padding:4px 8px;border-radius:5px;
           display:inline-block;border:1px solid var(--line);color:var(--dim);margin-right:2px}
  .rankpos.r1{color:#05070d;background:var(--mint);border-color:var(--mint)}
  .rankpos.r2{color:var(--cyan);background:rgba(49,224,255,.14);border-color:rgba(49,224,255,.5)}
  .rankpos.r3{color:var(--amber);background:rgba(255,180,61,.12);border-color:rgba(255,180,61,.4)}
  .name{font-size:22.5px;font-weight:600;margin-top:9px;letter-spacing:.03em}
  .gauge{flex:none;margin:-2px -3px 0 0}
  .gauge-v{font:600 22.5px/1 var(--mono)}
  .gauge-u{font:500 10px/1 var(--mono);fill:var(--dim);letter-spacing:.16em}
  .score-col{display:flex;flex-direction:column;align-items:center;gap:2px}
  .conviction-note{font:700 12px/1 var(--mono);color:var(--mint);letter-spacing:.04em;cursor:default}
  .conviction-note.neg{color:var(--rose)}

  /* ── SMART ENTRYの総合スコア（AMBUSHのリング型scoreGaugeとは
     スケールが違うため、シンプルな数値表示にしている） ── */
  .smart-score{flex:none;text-align:right;cursor:default}
  .smart-score-v{display:block;font:600 22.5px/1 var(--mono);color:var(--cyan)}
  .smart-score-u{font:500 10px/1 var(--mono);color:var(--dim);letter-spacing:.16em}

  /* ── ステータスランプ（買い推奨/様子見/見送り） ── */
  .score-trio{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
  .score-trio i{font-style:normal;color:var(--dim);font-size:13px}
  .reason-block{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--line)}
  .reason-group{margin-bottom:4px}
  .reason-group:last-child{margin-bottom:0}
  .reason-title{font:700 13px/1.4 var(--mono);color:var(--dim);letter-spacing:.03em}
  .reason-group ul{margin:2px 0 0;padding-left:18px;font:500 13.5px/1.5 var(--mono);color:var(--txt)}
  .exit-plan{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(77,159,255,.06);border:1px solid rgba(77,159,255,.25)}
  .exit-plan-h{font:700 13px/1.4 var(--mono);color:var(--blue);letter-spacing:.03em}
  .exit-plan-deadline{margin-top:2px;font:600 13.5px/1.4 var(--mono);color:var(--txt)}
  .exit-plan ul{margin:4px 0 0;padding-left:18px;font:500 13px/1.5 var(--mono);color:var(--dim)}
  .verdict{display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px;
           margin-top:12px;padding:8px 12px;border-radius:9px;border:1px solid}
  .verdict-lamp{width:9px;height:9px;border-radius:50%;flex:none}
  .verdict-label{font:700 16px/1 var(--mono);letter-spacing:.06em}
  .verdict-reason{flex-basis:100%;font:500 13.5px/1.4 var(--mono);color:var(--dim);letter-spacing:.02em}
  .v-buy{border-color:rgba(49,224,255,.4);background:rgba(49,224,255,.08)}
  .v-buy .verdict-lamp{background:var(--cyan);box-shadow:0 0 8px var(--cyan)}
  .v-buy .verdict-label{color:var(--cyan)}
  .v-hold{border-color:rgba(255,180,61,.4);background:rgba(255,180,61,.08)}
  .v-hold .verdict-lamp{background:var(--amber);box-shadow:0 0 8px var(--amber)}
  .v-hold .verdict-label{color:var(--amber)}
  .v-avoid{border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.08)}
  .v-avoid .verdict-lamp{background:var(--rose);box-shadow:0 0 8px var(--rose)}
  .v-avoid .verdict-label{color:var(--rose)}
  .v-strong_buy{border-color:rgba(34,255,196,.5);background:rgba(34,255,196,.1)}
  .v-strong_buy .verdict-lamp{background:var(--mint);box-shadow:0 0 8px var(--mint)}
  .v-strong_buy .verdict-label{color:var(--mint)}
  .v-priced_in_caution{border-color:rgba(255,140,61,.4);background:rgba(255,140,61,.08)}
  .v-priced_in_caution .verdict-lamp{background:#ff8c3d;box-shadow:0 0 8px #ff8c3d}
  .v-priced_in_caution .verdict-label{color:#ff8c3d}

  .price-row{display:flex;align-items:flex-end;gap:11px;margin:15px 0 4px;position:relative}
  .price{font:600 36px/1 var(--mono);letter-spacing:-.01em}
  .chg{font:600 16.5px/1 var(--mono);padding-bottom:4px}
  .chg .arrow{font-size:11px;margin-right:2px;vertical-align:1px}
  .spark{margin-left:auto;margin-bottom:-2px}

  .stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:15px;
         background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .cell{background:rgba(9,14,24,.72);padding:10px 12px;display:flex;
        justify-content:space-between;align-items:baseline;gap:8px}
  .k{font:500 13px/1.35 var(--mono);color:var(--dim);letter-spacing:.11em}
  .k i{font-style:normal;opacity:.6;font-size:12px;display:block;margin-top:2px}
  .v{font:600 19px/1 var(--mono)}

  .signals{display:flex;flex-direction:column;gap:8px;margin-top:15px}
  .sig{background:rgba(9,14,24,.72);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  .sig-head{display:flex;align-items:center;gap:7px}
  .sig-e{font-size:17.5px;line-height:1}
  .sig-t{font:500 13px/1.2 var(--mono);color:var(--dim);letter-spacing:.08em;flex:1}
  .sig-n{margin-top:5px;font:500 13px/1.4 var(--mono);color:var(--dim);letter-spacing:.02em}

  /* ── 自分ルール（1日30分ルーティンの自動チェック） ── */
  .rulebox{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
           background:rgba(9,14,24,.72)}
  .rulebox-head{font:700 12px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:7px}
  .rulebox-score{color:var(--txt);font-weight:700}
  .rulebox-rows{display:flex;flex-wrap:wrap;gap:6px}
  .rule{font:600 12px/1 var(--mono);letter-spacing:.04em;padding:4px 8px;border-radius:14px;
        border:1px solid;cursor:default}
  .rule.mint{color:var(--mint);border-color:rgba(34,255,196,.38);background:rgba(34,255,196,.1)}
  .rule.red{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.1)}
  .rule.gray{color:var(--dim);border-color:var(--line);background:rgba(125,144,173,.08)}

  /* ── 同業他社比較（AMBUSHのみ） ── */
  .peerbox{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
           background:rgba(9,14,24,.72)}
  .peerbox-head{font:700 12px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:7px}
  .peerbox-sub{color:var(--txt);font-weight:700;margin-left:4px}
  .peer-table{width:100%;border-collapse:collapse;font:500 13px/1.6 var(--mono)}
  .peer-table th{color:var(--dim);font-weight:500;text-align:right;letter-spacing:.06em;font-size:11.5px}
  .peer-table th:first-child,.peer-table td:first-child{text-align:left;color:var(--dim)}
  .peer-table td{text-align:right;color:var(--txt)}
  .peerbox-note{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);
                font:500 12.5px/1.5 var(--mono);color:var(--amber);letter-spacing:.01em}

  /* ── いつまでに仕込むべきかの目安（AMBUSH専用） ── */
  .timing-note{margin-top:8px;padding:7px 12px;border:1px solid rgba(49,224,255,.25);
               border-radius:9px;background:rgba(49,224,255,.05);
               font:500 13px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}

  /* ── カタリスト予兆セクション ── */
  .precursor-card{border-color:rgba(124,77,255,.4)}
  .precursor-list{margin-top:13px;display:flex;flex-direction:column;gap:9px}
  .precursor-item{padding:9px 12px;border:1px solid rgba(124,77,255,.3);border-radius:9px;
                  background:rgba(124,77,255,.07)}
  .precursor-item-head{font:700 13.5px/1 var(--mono);color:#b39cff;letter-spacing:.04em;margin-bottom:6px}
  .precursor-item-note{font:500 13px/1.6 var(--mono);color:var(--dim);letter-spacing:.01em}
  .precursor-item.precursor-caution{background:rgba(255,180,61,.08);border-color:rgba(255,180,61,.35)}
  .precursor-item.precursor-caution .precursor-item-head{color:var(--amber)}
  .precursor-item.precursor-caution.is-bad{background:rgba(255,61,113,.08);border-color:rgba(255,61,113,.35)}
  .precursor-item.precursor-caution.is-bad .precursor-item-head{color:var(--rose)}
  /* 需給ワンポイントバッジ */
  .precursor-supply-badge{flex-shrink:0;padding:4px 9px;border-radius:7px;border:1px solid;
                           font:700 12.5px/1 var(--mono);letter-spacing:.02em;white-space:nowrap}
  .precursor-supply-badge.is-good{color:var(--mint);border-color:rgba(61,255,166,.4);background:rgba(61,255,166,.08)}
  .precursor-supply-badge.is-bad{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.08)}
  .precursor-supply-badge.is-mid{color:var(--amber);border-color:rgba(255,180,61,.4);background:rgba(255,180,61,.08)}
  /* 利益の質チェック（売掛金急増）でカード全体の枠を色付け */
  .precursor-card.flag-warn{border-color:rgba(255,180,61,.6)}
  .precursor-card.flag-bad{border-color:rgba(255,61,113,.65)}

  /* ── 「今なぜ仕込むのか」ブロック（whyNowBlock/inflectionWhyNowBlock、
     A指示 項目40/41）。card/usCard/precursorCard/inflectionCardが
     共通で使うのに、これまでCSSが一切定義されておらずスタイルの
     当たっていない素のdiv/p/ulのまま表示されていた（ユーザー指摘
     2026-09-13で発覚）。他ブロックと同じ「濃色パネル＋mono見出し」に
     揃える。 ── */
  .why-now-block{display:flex;flex-direction:column;gap:9px;margin-top:13px}
  .why-now-item{background:rgba(9,14,24,.72);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  .why-now-h{display:block;font:700 12px/1 var(--mono);color:var(--cyan);letter-spacing:.1em;margin-bottom:6px}
  .why-now-item p{font:500 13.5px/1.6 var(--mono);color:var(--txt);letter-spacing:.01em}
  .why-now-item ul{list-style:none;display:flex;flex-direction:column;gap:4px}
  .why-now-item li{font:500 13px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}
  .why-now-item li::before{content:"▸ ";color:var(--cyan)}

  /* ── 業績屈折(SECTION D)カード（ユーザー要望「もっと分かりやすく
     未来チックなレイアウトに」2026-09-13）。他セクションの.sig/
     .precursor-item/.repricingと同じ「濃色パネル＋mono見出し」の
     語彙に揃えつつ、キラー指標だけは3分割のミニ計器盤（.infl-killers）
     にして一目で該当数が分かるようにする。 ── */
  .inflection-card{border-color:rgba(255,180,61,.4)}
  .inflection-card::before{background:linear-gradient(90deg,transparent,var(--amber),transparent)}
  .infl-type{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;
             font:700 13.5px/1 var(--mono);letter-spacing:.06em;border:1px solid;margin:10px 0 2px}
  .infl-type.v-turnaround{color:var(--cyan);border-color:rgba(49,224,255,.42);background:rgba(49,224,255,.09);
                           box-shadow:0 0 14px rgba(49,224,255,.16)}
  .infl-type.guidance-conservative{color:var(--mint);border-color:rgba(34,255,196,.42);background:rgba(34,255,196,.09);
                                    box-shadow:0 0 14px rgba(34,255,196,.16)}
  .inflection-lines{display:flex;flex-direction:column;gap:9px;margin-top:13px}
  .infl-line{background:rgba(9,14,24,.72);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  .infl-line b{display:block;font:700 12px/1 var(--mono);color:var(--dim);letter-spacing:.1em;
               margin-bottom:6px;text-transform:uppercase}
  .infl-line div{font:500 13.5px/1.6 var(--mono);color:var(--txt);letter-spacing:.01em}
  .infl-killers{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
  .infl-killer-cell{background:rgba(9,14,24,.6);border:1px solid var(--line);border-radius:7px;
                     padding:7px 6px;text-align:center}
  .infl-killer-cell.hit{border-color:rgba(34,255,196,.45);background:rgba(34,255,196,.08)}
  .infl-killer-cell .kv{font:700 16px/1.25 var(--mono);color:var(--txt);white-space:nowrap}
  .infl-killer-cell.hit .kv{color:var(--mint)}
  .infl-killer-cell .kl{font:500 10.5px/1.3 var(--mono);color:var(--dim);letter-spacing:.03em;margin-top:3px}
  @media(max-width:420px){.infl-killers{grid-template-columns:1fr 1fr}}

  .divtrend{margin-top:8px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;
            background:rgba(9,14,24,.72);display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;
            font:500 13px/1.5 var(--mono)}
  .divtrend-head{color:var(--dim);letter-spacing:.06em;font-size:11.5px}
  .divtrend-row{color:var(--txt)}
  .divtrend-note{color:var(--mint);font-weight:700}

  /* ── コンセンサス非公開銘柄の代わりの根拠（ホバー任せにせず常時表示） ── */
  .altbox{margin-top:13px;padding:9px 12px;border:1px solid rgba(34,255,196,.3);border-radius:9px;
          background:rgba(34,255,196,.05)}
  .altbox-head{font:700 12px/1 var(--mono);color:var(--mint);letter-spacing:.08em;margin-bottom:7px}
  .altbox-list{list-style:none;display:flex;flex-direction:column;gap:6px}
  .altbox-list li{font:500 13px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}
  .altbox-list li b{color:var(--txt);font-weight:700}

  /* ── 仕込み妙味スコア（Repricing Lag） ── */
  .repricing{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
             background:rgba(9,14,24,.72)}
  .repricing-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  .repricing-score{font:700 12.5px/1 var(--mono);color:var(--dim);letter-spacing:.04em}
  .repricing-fields{list-style:none;display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
  .repricing-fields li{font:500 12.5px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}
  .repricing-why{font:500 13px/1.6 var(--mono);color:var(--txt);letter-spacing:.01em}
  .repricing-caveat{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);
                     font:500 12px/1.5 var(--mono);color:var(--amber);letter-spacing:.01em}

  /* ── 第9優先改修 Phase6: 信用需給（creditSupplyQualitySignal） ── */
  .credit-supply{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
                  background:rgba(9,14,24,.72);font:500 13px/1.5 var(--mono)}
  .csq-head{color:var(--dim);letter-spacing:.06em;font-size:11.5px;margin-bottom:6px}
  .csq-row{display:flex;align-items:baseline;gap:8px;margin-bottom:3px}
  .csq-k{color:var(--dim);min-width:5.2em}
  .csq-v{color:var(--txt);font-weight:700}
  .csq-chg{margin-left:auto}
  .csq-tag{color:var(--amber);font-size:11.5px}
  .csq-sub{margin-top:7px;padding-top:7px;border-top:1px dashed var(--line)}
  .csq-sub-head{color:var(--dim);letter-spacing:.04em;font-size:11.5px;margin-bottom:3px}
  .csq-sub-arrow{color:var(--txt)}
  .csq-sub-result{color:var(--mint);font-weight:700;margin-top:2px}
  .csq-foot{margin-top:7px;padding-top:6px;border-top:1px dashed var(--line);
             color:var(--dim);font-size:11.5px}

  /* ── 第9優先改修 Phase6: 信用需給タグの絞り込みバー ── */
  .credit-filter-bar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:10px 0}
  .credit-filter-label{color:var(--dim);font:500 12px/1 var(--mono);letter-spacing:.04em}
  .credit-filter-chip{font:600 12px/1 var(--mono);color:var(--dim);letter-spacing:.02em;
                       background:rgba(9,14,24,.72);border:1px solid var(--line);border-radius:999px;
                       padding:6px 12px;cursor:pointer;transition:all .15s}
  .credit-filter-chip:hover{border-color:var(--mint)}
  .credit-filter-chip.is-active{color:#04140f;background:var(--mint);border-color:var(--mint);font-weight:700}
  .credit-filter-clear{font:500 12px/1 var(--mono);color:var(--dim);background:transparent;
                        border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer}
  .credit-filter-clear:hover{color:var(--txt);border-color:var(--txt)}

  /* ── 第9優先改修 Phase6 ④: 需給タイムライン ── */
  .credit-timeline{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
                    background:rgba(9,14,24,.72)}
  .credit-timeline.is-empty{padding:9px 12px}
  .ctl-head{display:flex;align-items:center;justify-content:space-between;
             color:var(--dim);letter-spacing:.06em;font:700 11.5px/1 var(--mono);margin-bottom:6px}
  .ctl-empty{color:var(--dim);font:500 12.5px/1.4 var(--mono)}
  .ctl-pending{color:#04140f;background:var(--amber);border-radius:999px;
               font:700 10px/1 var(--mono);padding:3px 8px;letter-spacing:.04em}
  .ctl-row{display:flex;align-items:center;gap:8px;margin-bottom:2px}
  .ctl-label{color:var(--dim);font:600 11px/1 var(--mono);min-width:2.6em;letter-spacing:.02em}
  .ctl-svg{display:block;flex:1}
  .ctl-dates{display:flex;justify-content:space-between;margin-top:4px;padding-left:2.6em;
             color:var(--dim);font:500 10px/1 var(--mono);letter-spacing:.01em}
  .ctl-dates-endpoints{justify-content:space-between}
  .ctl-date-arrow{color:var(--dim);opacity:.6}
  .ctl-tags{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);
            display:flex;flex-wrap:wrap;gap:4px 10px}
  .ctl-tag{color:var(--mint);font:600 11px/1.4 var(--mono)}
  .ctl-foot{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);
            color:var(--dim);font-size:11px}

  .meta{display:flex;flex-wrap:wrap;gap:11px;margin-top:11px;
        font:500 13px/1 var(--mono);color:var(--dim);letter-spacing:.08em}
  .meta b{font-weight:600}
  .conf{margin-left:auto}

  .up{color:var(--mint)} .down{color:var(--rose)} .warn{color:var(--amber)}

  .c-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px;padding-top:12px;
          border-top:1px solid var(--line)}
  .chip{font:500 13px/1 var(--mono);letter-spacing:.1em;padding:5px 9px;border-radius:20px;border:1px solid;cursor:default}
  .cyan{color:var(--cyan);border-color:rgba(49,224,255,.34);background:rgba(49,224,255,.08)}
  .mint{color:var(--mint);border-color:rgba(34,255,196,.38);background:rgba(34,255,196,.1)}
  .amber{color:var(--amber);border-color:rgba(255,180,61,.36);background:rgba(255,180,61,.09)}
  .red{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.1)}
  .gray{color:var(--dim);border-color:var(--line);background:rgba(125,144,173,.08)}
  .flat{color:var(--dim);border-color:transparent;background:rgba(125,144,173,.07)}
  .violet{color:var(--violet);border-color:rgba(167,139,250,.4);background:rgba(167,139,250,.1)}
  /* v7.5改修: テーマ性×小型×高成長×未織り込みが揃った希少な組み合わせ
     （diamondSignal）。通常のmint/amberチップと見分けやすいよう、
     グラデーション+わずかな光彩を付ける。 */
  .diamond{color:#fff;border-color:rgba(180,210,255,.6);
           background:linear-gradient(135deg,#7dd3fc,#a78bfa,#f472b6);
           box-shadow:0 0 8px rgba(167,139,250,.45);font-weight:700}
  /* A指示 項目1-2/32「仕込み優先度」: 「ユーザーが最も見たい実戦用
     スコア」。SCORE/実質SCOREより優先して見てほしい値なので、他の
     フラットなチップより目立つ専用色にする。 */
  .priority{color:#fff;border-color:rgba(125,211,252,.6);
           background:linear-gradient(135deg,#22d3ee,#3b82f6);
           box-shadow:0 0 8px rgba(59,130,246,.4);font-weight:700}

  .stamp{margin-top:26px;font:400 13.5px/1.7 var(--mono);color:var(--dim);letter-spacing:.13em}
  /* ── スマホ ────────────────────────────────────────────────
     viewportメタタグを入れたのでここが初めて実際に効くようになった。
     iPhoneの幅390pxを基準に、横スクロールが出ないことを条件に詰める。 */
  @media(max-width:520px){
    /* 左右パディング28px×2は390px幅では大きすぎる。カードの実効幅を稼ぐ */
    body{padding:16px 13px 34px}
    body::after{background-size:32px 32px}
    .top{gap:12px;margin-bottom:16px}
    .grid{grid-template-columns:1fr;gap:13px}
    .card{padding:16px 15px 13px}
    .price{font-size:31px}
    /* HUDは min-width:150px + padding40px = 190px で2列に収まらない。
       flexの2列に固定して、右列の縦罫線を消す */
    .ro{min-width:0;flex:1 1 calc(50% - 1px);padding:11px 13px}
    .ro:nth-child(2n){border-right:none}
    /* スパークラインは150px固定だと株価と衝突する */
    .spark{width:96px;height:30px}
    .sec-head{margin-bottom:12px}
    .name{font-size:21.5px}
    .chip{font-size:12.5px;padding:5px 8px}
  }
  /* 特に狭い端末（iPhone SE = 375px, mini = 360px）では2列の数値も窮屈 */
  @media(max-width:380px){
    .stats{grid-template-columns:1fr}
    .ro{flex:1 1 100%;border-right:none}
  }

  /* ================================================================
     モバイル専用UI（PWA・5画面構成、ユーザー方針2026-09-19）
     PC版をそのまま縮小するのではなく、520px以下では別レイアウト
     （#mobile-app）に完全に切り替える。#desktop-viewはCSSでの非表示
     だけでDOMからは消さない（「詳細を見る」タップ時にJSで強制的に
     表示してその銘柄までスクロールするため）。
     ================================================================ */
  #mobile-app{display:none}
  @media(max-width:520px){
    #desktop-view{display:none}
    #mobile-app{display:block}
  }
  /* 「詳細を見る」タップでPC版を強制表示している間は、520px以下でも
     desktop-viewを表示する（JSがdisplay:blockをインラインstyleで
     上書きする。インラインstyleはmedia query内の指定より優先される）。 */

  /* スモークガラス・トークン(Figmaで検証した配色を移植、2026-09-19)。
     中立白ではなく青紫がかったティント(--glass-tint)にすることで
     「未来的な冷たいガラス」の質感を出す。背景も暗めのAurora Meshに。 */
  #mobile-app{
    --glass-tint:168,184,255;
    --glass-bg:rgba(var(--glass-tint),.06); --glass-border:rgba(var(--glass-tint),.24);
    --glass-highlight:inset 0 1px 0 rgba(255,255,255,.08);
    min-height:100vh; padding-bottom:80px; /* 下部タブバーの高さぶん */
    font-family:"Helvetica Neue","Hiragino Sans","Noto Sans JP",sans-serif;
    /* 黒×多色の融合を強める（ユーザー要望2026-09-19）: 漆黒ベースの面積を
       広く保ちつつ、彩度の高い色帯を増やして黒との対比でカラフルに見せる。 */
    background:
      radial-gradient(46% 26% at 16% 2%, rgba(157,143,255,.30), transparent 66%),
      radial-gradient(50% 28% at 86% 10%, rgba(63,224,245,.26), transparent 66%),
      radial-gradient(46% 28% at 90% 78%, rgba(240,138,212,.22), transparent 64%),
      radial-gradient(40% 24% at 6% 86%, rgba(255,203,112,.14), transparent 60%),
      radial-gradient(34% 20% at 50% 46%, rgba(180,237,74,.08), transparent 58%),
      radial-gradient(38% 22% at 62% 68%, rgba(255,133,149,.08), transparent 58%),
      linear-gradient(180deg,#020309 0%,#050814 34%,#0a0e24 62%,#111a3d 100%);
  }
  .m-topbar{
    position:sticky; top:0; z-index:20; display:flex; justify-content:space-between; align-items:center;
    padding:14px 16px; background:rgba(2,3,9,.6); backdrop-filter:blur(22px) saturate(180%);
    -webkit-backdrop-filter:blur(22px) saturate(180%);
    border-bottom:1px solid var(--glass-border); box-shadow:var(--glass-highlight);
  }
  .m-brand{font-weight:800; font-size:16px; letter-spacing:.01em; display:flex; align-items:center; gap:8px}
  .m-updated{font-size:11px; color:var(--dim); font-family:var(--mono); opacity:.85}
  .m-screens{padding:16px 14px 8px}
  .m-screen{display:none}
  .m-screen.is-active{display:block}
  .m-h2{font-size:12.5px; margin:22px 0 10px; color:#7f93b0; letter-spacing:.09em; text-transform:uppercase;
    font-family:var(--mono); display:flex; align-items:center; gap:7px}
  .m-h2:first-child{margin-top:4px}
  .m-h2-icon, .m-cta-icon{width:15px; height:15px; flex-shrink:0; stroke:currentColor}
  .m-brand .m-h2-icon{width:19px; height:19px; color:var(--cyan)}
  .m-cta-icon{width:16px; height:16px; margin-right:6px; vertical-align:-3px}
  /* セクション見出しの彩色（単色一辺倒を避け、意味の近い色に塗り分ける） */
  .m-h2.accent-cyan{color:var(--cyan)}
  .m-h2.accent-amber{color:#ffcb70}
  .m-h2.accent-violet{color:#b9aeff}
  .m-h2.accent-magenta{color:#f0a8dd}

  /* ガラス板上端のsheen(反射ライン)。全ガラスカード共通(Figmaで検証)。 */
  .m-market-cell::before, .m-row::before, .m-stat::before, .m-cta::before{
    content:""; position:absolute; top:0; left:8%; right:8%; height:1.5px; pointer-events:none;
    background:linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
  }

  .m-market{display:grid; grid-template-columns:1fr 1fr; gap:10px}
  .m-market-cell{
    position:relative;
    background:var(--glass-bg); backdrop-filter:blur(20px) saturate(200%); -webkit-backdrop-filter:blur(20px) saturate(200%);
    border:1px solid var(--glass-border); box-shadow:var(--glass-highlight), 0 12px 32px -12px rgba(0,0,0,.55);
    border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:4px;
  }
  .m-k{font-size:10.5px; color:var(--dim); letter-spacing:.04em}
  .m-v{font-size:22px; font-weight:800; font-family:var(--mono)}

  .m-list{display:flex; flex-direction:column; gap:8px}
  /* 枠デザイン改良（ユーザー要望2026-09-19）: 左端にカラーアクセントバーを
     入れて騰落を一目で分かるようにし、角の一つだけ深く落として単調な
     角丸カードに変化を付ける（チケット風のシェイプ）。 */
  .m-row{
    position:relative;
    display:flex; justify-content:space-between; align-items:center; gap:10px;
    background:var(--glass-bg); backdrop-filter:blur(20px) saturate(200%); -webkit-backdrop-filter:blur(20px) saturate(200%);
    border:1px solid var(--glass-border); box-shadow:var(--glass-highlight), 0 12px 32px -12px rgba(0,0,0,.55);
    border-radius:14px 14px 14px 4px; padding:13px 14px 13px 16px; text-decoration:none; color:var(--txt); min-height:44px;
    transition:border-color .15s ease, background .15s ease, transform .1s ease;
    overflow:hidden;
  }
  .m-row::after{
    content:""; position:absolute; top:10px; bottom:10px; left:0; width:3px; border-radius:0 3px 3px 0;
    background:var(--dim); opacity:.5;
  }
  .m-row:has(.m-chg.up)::after{background:var(--mint); box-shadow:0 0 8px rgba(34,255,196,.6); opacity:1}
  .m-row:has(.m-chg.down)::after{background:var(--rose); box-shadow:0 0 8px rgba(255,133,149,.6); opacity:1}
  .m-row:active{background:rgba(49,224,255,.08); border-color:rgba(49,224,255,.35); transform:scale(.985)}
  .m-row-main{display:flex; flex-direction:column; gap:6px; min-width:0; flex:1}
  .m-row-top{display:flex; align-items:baseline; gap:8px; min-width:0}
  .m-row-side{display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0}
  .m-code{font-family:var(--mono); font-size:11px; color:var(--dim)}
  .m-name{font-size:15.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:44vw}
  .m-price{font-family:var(--mono); font-size:15px; font-weight:700}
  .m-chg{font-family:var(--mono); font-size:13px; font-weight:700}
  .m-chg.up{color:var(--mint); text-shadow:0 0 10px rgba(34,255,196,.35)} .m-chg.down{color:var(--rose)}
  /* 順位は円形グローバッジにして数字が沈まないようにする（視認性改善要望） */
  .m-rank{
    flex-shrink:0; width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center;
    font-family:var(--mono); font-size:11px; font-weight:800; color:var(--cyan); border-radius:50%;
    background:rgba(49,224,255,.14); border:1px solid rgba(49,224,255,.4); box-shadow:0 0 8px rgba(49,224,255,.35);
  }
  /* 順位1〜3は特別に金銀銅トーンでハイライト（一目で上位と分かるように） */
  .m-rank[data-top="1"]{color:#ffd76b; background:rgba(255,215,107,.16); border-color:rgba(255,215,107,.5); box-shadow:0 0 10px rgba(255,215,107,.5)}
  .m-rank[data-top="2"]{color:#d9e2f2; background:rgba(217,226,242,.14); border-color:rgba(217,226,242,.4); box-shadow:0 0 8px rgba(217,226,242,.35)}
  .m-rank[data-top="3"]{color:#e3a875; background:rgba(227,168,117,.14); border-color:rgba(227,168,117,.4); box-shadow:0 0 8px rgba(227,168,117,.35)}
  /* SCOREバー（Figmaプロトタイプで検証した表現を本番に移植） */
  .m-score-row{display:flex; align-items:center; gap:8px}
  .m-score-bar{flex:1; max-width:120px; height:4px; border-radius:2px; background:rgba(255,255,255,.08); overflow:hidden}
  .m-score-fill{height:100%; border-radius:2px; background:linear-gradient(90deg,var(--violet,#9d8fff),var(--cyan))}
  .m-score-n{font-family:var(--mono); font-size:10.5px; color:var(--dim); flex-shrink:0}
  .m-tier-badge{font-family:var(--mono); font-size:10px; font-weight:800; letter-spacing:.03em; padding:3px 8px; border-radius:999px}
  .m-tier-a{color:#ffd48a; background:rgba(251,191,90,.15); border:1px solid rgba(251,191,90,.35)}
  .m-tier-b{color:#c3b8ff; background:rgba(139,123,255,.16); border:1px solid rgba(139,123,255,.35)}
  .m-tier-c{color:#c3cbdb; background:rgba(148,163,184,.14); border:1px solid rgba(148,163,184,.3)}
  .m-growth{font-size:11px; color:var(--dim)}
  .m-empty{color:var(--dim); font-size:13px; padding:20px 4px; text-align:center}

  /* 便利機能: モバイル画面の「上へ戻る」ボタン（リストが長くなりやすい
     SIGNAL/STEALTH/STOCK画面向け、ユーザー要望2026-09-19） */
  #m-top-btn{
    display:none; position:fixed; right:16px; bottom:96px; z-index:35;
    width:42px; height:42px; border-radius:50%; align-items:center; justify-content:center;
    background:rgba(20,26,42,.7); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    border:1px solid var(--glass-border); color:var(--cyan); box-shadow:var(--glass-highlight), 0 10px 24px -8px rgba(0,0,0,.6);
  }
  #m-top-btn.is-visible{display:flex}
  #m-top-btn svg{width:18px; height:18px}

  .m-stat-row{display:grid; grid-template-columns:repeat(3,1fr); gap:8px}
  .m-stat{
    position:relative;
    background:var(--glass-bg); backdrop-filter:blur(20px) saturate(200%); -webkit-backdrop-filter:blur(20px) saturate(200%);
    border:1px solid var(--glass-border); box-shadow:var(--glass-highlight), 0 12px 32px -12px rgba(0,0,0,.55);
    border-radius:14px; padding:14px 8px; display:flex; flex-direction:column; align-items:center; gap:4px; color:var(--txt);
  }
  .m-stat-n{font-size:22px; font-weight:800; font-family:var(--mono); color:var(--cyan); text-shadow:0 0 10px rgba(49,224,255,.4)}
  .m-stat-l{font-size:11px; color:var(--dim)}

  .m-cta{
    position:relative;
    display:block; width:100%; background:linear-gradient(135deg,rgba(157,143,255,.18),rgba(240,138,212,.16));
    backdrop-filter:blur(20px) saturate(200%); -webkit-backdrop-filter:blur(20px) saturate(200%);
    border:1px solid rgba(157,143,255,.4); box-shadow:var(--glass-highlight), 0 0 24px -6px rgba(157,143,255,.35);
    color:var(--cyan); font-weight:800; font-size:15px; border-radius:14px;
    padding:16px; margin-top:4px;
  }
  .m-cta:active{opacity:.85}

  .m-search{
    width:100%; padding:13px 14px; border-radius:14px; border:1px solid var(--glass-border);
    background:var(--glass-bg); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    box-shadow:var(--glass-highlight); color:var(--txt); font-size:15px; margin-bottom:12px;
  }
  .m-search:focus{outline:none; border-color:rgba(49,224,255,.5); box-shadow:var(--glass-highlight), 0 0 0 3px rgba(49,224,255,.12)}
  .m-settings-row{
    display:flex; justify-content:space-between; padding:13px 4px; border-bottom:1px solid var(--glass-border); font-size:14px;
  }
  .m-note{font-size:12px; color:var(--dim); margin-top:16px; line-height:1.6}

  /* サイバーネオン×ミニマルガラス（ユーザー選定2026-09-19）。
     ガラスパネル(半透明+強めのblur+内側ハイライト)の上に、選択中タブだけ
     ネオングローを乗せる。彩度・発光は最小限に絞り「ミニマル」を保つ。 */
  .m-tabbar{
    position:fixed; left:0; right:0; bottom:0; z-index:30; display:flex;
    background:rgba(8,12,22,.62); backdrop-filter:blur(22px) saturate(160%);
    -webkit-backdrop-filter:blur(22px) saturate(160%);
    border-top:1px solid rgba(255,255,255,.08);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.06), 0 -12px 30px -14px rgba(49,224,255,.18);
    padding:9px 4px calc(6px + env(safe-area-inset-bottom));
  }
  .m-tab{
    flex:1; display:flex; flex-direction:column; align-items:center; gap:4px;
    background:none; border:none; color:#5c7290; padding:6px 0 5px; border-radius:12px;
    position:relative; transition:color .2s ease;
  }
  .m-tab-icon{width:22px; height:22px; display:block}
  .m-tab i{font-style:normal; font-size:9.5px; letter-spacing:.06em; font-family:var(--mono)}
  .m-tab.is-active{color:var(--cyan)}
  .m-tab.is-active .m-tab-icon{filter:drop-shadow(0 0 6px rgba(49,224,255,.85))}
  .m-tab.is-active::before{
    content:""; position:absolute; top:-9px; left:50%; transform:translateX(-50%);
    width:22px; height:2px; border-radius:2px;
    background:linear-gradient(90deg,transparent,var(--cyan),transparent);
    box-shadow:0 0 8px 1px rgba(49,224,255,.9);
  }

  #m-back-btn{
    display:none; align-items:center; gap:7px; position:fixed; left:50%; transform:translateX(-50%); bottom:16px; z-index:40;
    background:rgba(20,26,42,.6); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    color:var(--cyan); font-weight:800; font-size:13px; border:1px solid rgba(49,224,255,.4);
    border-radius:999px; padding:10px 18px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 0 20px -4px rgba(49,224,255,.4);
  }
  #m-back-btn .m-tab-icon{width:15px; height:15px}

  /* 銘柄詳細ボトムシート: タップした銘柄の全項目をモバイル画面内その場に
     出す（ユーザー要望2026-09-19「影響が出る株がPCのサイトに飛ぶ」対策）。
     PC版の該当カードをそのままクローンして流し込む＝判定ロジックも
     カード組み立てロジックも二重に作らない（既存のPC版と一言一句同じ内容）。 */
  #m-card-modal{position:fixed; inset:0; z-index:60; display:none}
  #m-card-modal.is-open{display:block}
  .m-modal-scrim{position:absolute; inset:0; background:rgba(2,4,10,.72); backdrop-filter:blur(2px)}
  .m-modal-sheet{
    position:absolute; left:0; right:0; bottom:0; max-height:88vh; overflow-y:auto;
    background:linear-gradient(180deg,#0a0e1c,#05070d);
    border-top:1px solid var(--glass-border); border-radius:20px 20px 0 0;
    box-shadow:0 -20px 50px -10px rgba(0,0,0,.7);
    padding:18px 16px calc(24px + env(safe-area-inset-bottom));
    animation:mModalUp .22s ease-out;
  }
  @keyframes mModalUp{from{transform:translateY(24px); opacity:.4} to{transform:translateY(0); opacity:1}}
  .m-modal-close{
    position:sticky; top:0; margin-left:auto; display:flex; width:34px; height:34px; border-radius:50%;
    align-items:center; justify-content:center; background:rgba(255,255,255,.06); border:1px solid var(--glass-border);
    color:var(--dim); z-index:2;
  }
  .m-modal-close svg{width:16px; height:16px}
  .m-modal-body{margin-top:-34px}
  .m-modal-body .card{width:100%; margin:0}
</style>
</head>
<body>
${buildMobileApp({ now, later, smart, tenbaggerCandidates, macro, amb })}
<div id="desktop-view">
<div class="wrap">
  <div class="top">
    <div class="brand">
      <div class="logo"><span>S7</span></div>
      <div>
        <h1>STEALTH <b>v7.3</b> AMBUSH + SMART ENTRY</h1>
        <div class="sub">SBI EARNINGS CALENDAR × TDNET × KABUTAN</div>
      </div>
    </div>
    <div class="live"><span class="dot"></span>LIVE · ${live.length + smartLive.length} SYMBOLS LIVE / ${amb.results.length + smart.results.length} SCREENED</div>
  </div>

  <div class="hud">
    ${readout('NIKKEI 225', macro.nikkei?.toLocaleString() ?? '--', ' 円')}
    ${readout('USD / JPY', fmt(macro.usdjpy), '', caution ? 'down' : '')}
    <!-- 実測バグ: 米国株AMBUSHで「該当48/126」とHUDに出ていたのに、
         セクション本文はRANK_TOP_N(10)件しかカードを出しておらず、
         48件見つかると期待してクリックすると10件しか無い、という
         見出し件数とカード枚数の不一致があった（テンバガー候補の
         Tier小見出しで見つかった同種バグと同じ原因）。AMBUSH NOW・
         SMART ENTRY・米国株AMBUSHのHUDは、Math.min(実件数, RANK_TOP_N)
         でカード枚数の上限と揃える（AMBUSH WATCH/テンバガー候補は
         既にconst定義時点でスライス済みなので対応不要）。 -->
    ${readout('AMBUSH NOW', String(Math.min(now.length, RANK_TOP_N)), ' 件', now.length ? 'up' : '')}
    ${readout('AMBUSH WATCH', String(later.length), ' 件')}
    <a href="#n" style="text-decoration:none;color:inherit" title="業績屈折(INFLECTION)セクションへジャンプ">${readout('📉 業績屈折', String((smart.inflectionCandidates ?? []).length), ' 候補', (smart.inflectionCandidates ?? []).length ? 'up' : '')}</a>
    <a href="#q" style="text-decoration:none;color:inherit" title="PRE-AMBUSHセクションへジャンプ">${readout('PRE-AMBUSH', String(pre.length), ' 件')}</a>
    ${readout('SMART ENTRY', `${Math.min(smart.matched, RANK_TOP_N)}/${smart.universe}`, ' 該当', smart.matched ? 'up' : '')}
    <a href="#u" style="text-decoration:none;color:inherit" title="米国株AMBUSHセクションへジャンプ">${readout('🇺🇸 米国株', `${Math.min(us.results?.length ?? 0, RANK_TOP_N)}/${us.universe ?? 0}`, ' 該当', us.results?.length ? 'up' : '')}</a>
    <a href="#t" style="text-decoration:none;color:inherit" title="テンバガー候補セクションへジャンプ">${readout('💎 テンバガー', String(tenbaggerCandidates.length), ' 候補', tenbaggerCandidates.length ? 'up' : '')}</a>
    ${readout('先行材料あり', String(amb.results.filter((r) => r.evidence).length), ' 件')}
    ${readout('UNIVERSE', `${amb.passed}/${amb.universe}`, ' 通過')}
    ${readout('LAST SYNC', new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }), ' JST')}
  </div>

  ${creditFilterBar()}

  ${beginnerGuide()}

  ${section('a', '🔥', 'AMBUSH NOW',
    `決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日 · 取引所確定日 · 先行カタリストあり · SCORE 70以上 · 未織込条件クリア · 上位${RANK_TOP_N}件`,
    now.slice(0, RANK_TOP_N).map((r, i) => card(r, i, { stale: !r.live })).join(''),
    `該当なし。ユニバース${amb.universe}銘柄中 Stage 1 通過は${amb.passed}銘柄でしたが、TDnetに先行カタリスト（好材料の開示・月次KPI）を持つ確定日銘柄はありませんでした。SECTION C に監視候補を出しています。`, 'A')}

  ${section('b', '🎯', 'SMART ENTRY',
    `決算スケジュールは見ず、需給と乖離だけで機械的にスクリーニングした「仕込み時」の銘柄。固定の登録銘柄ではなく、条件に合う銘柄がその日ごとに入れ替わります。低位株・薄商い・赤字/債務超過は全セクション共通で除外済み。底打ちを裏付ける根拠（出来高急増・解散価値割れ・配当下限・空売り膨張・業種の出遅れ）が見つかった銘柄にはチップを表示し、結論（買い推奨→様子見→見送り）を最優先の基準に、同じ結論内ではSCORE（乖離の深さだけでなく裏付け・警告も加味した総合点）が高い順に並べています。SCOREが高くても結論が「様子見/見送り」の銘柄は、SCOREの低い「買い推奨」より下に来ます。上位${RANK_TOP_N}件のみ表示します。`,
    smart.results.slice(0, RANK_TOP_N).map((r, i) => smartEntryCard(r, i)).join(''),
    `該当なし。ユニバース${smart.universe}銘柄をスキャンしましたが、3つの仕込みパターンのいずれにも合致する銘柄がありませんでした。`, 'B')}

  <details class="sec" id="c" open>
    <summary class="sec-head">
      <h2><span class="ico">👀</span>AMBUSH WATCH</h2>
      ${sectionBadge('C')}
      <p>Stage 1 通過 ${amb.passed}銘柄のうち NOW 条件を満たさなかったもの（決算まで${WINDOW.watchMin}〜${WINDOW.watchMax}日）· 上位${AMBUSH_WATCH_MAX}件 · 先行カタリストの有無で「仕込み候補」「参考」に分け、各グループ内は結論（買い推奨→様子見→見送り）を最優先に、同じ結論内では素点SCORE＋底打ち確認/同業他社比較の裏付け加点（カード内「+○pt」）の合計が高い順に並べています。「参考」グループはこの合計が高くても先行カタリストが無いため上のグループより下に表示されます</p>
    </summary>
    ${!later.length ? `<div class="empty">Stage 1 を通過した銘柄はありません。</div>` : `
    ${laterEvidence.length ? `
    <div class="subhead sub-good">🟢 仕込み候補 — 先行カタリストの根拠あり（${laterEvidence.length}件）</div>
    <div class="grid">${laterEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    ${laterNoEvidence.length ? `
    <div class="subhead sub-ref">⚪ 参考 — 先行材料なし・スコアは目安程度（${laterNoEvidence.length}件）</div>
    <div class="grid">${laterNoEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    `}
  </details>

  ${section('n', '📉', '業績屈折（INFLECTION）',
    `直近四半期は減益（コスト増・特別損失等）だったものの、割安な財務指標（PER/PBR/ROE/自己資本比率等）と、通期の会社予想が底堅い/黒字転換を見込む「キラー指標」（売上-利益スプレッド・進捗サプライズ・ハードル比率）のいずれかを満たす銘柄です。「悪い四半期を見て売られたところを、確定した先の材料を見て拾う」という考え方に基づくセクションで、他セクションと異なり赤字・債務超過も候補から除外しません（⚠️財務リスクありのチップで明示します）。「対策」欄はTDnetの適時開示タイトルから機械的に検出できた場合のみ表示し、見つからなくても本文までは確認していないため対策が無いとは限りません。キラー指標3つ全てが該当する銘柄には🎯最優先候補バッジを付けます。上位${RANK_TOP_N}件のみ表示します。`,
    (smart.inflectionCandidates ?? []).slice(0, RANK_TOP_N).map((r, i) => inflectionCard(r, i)).join(''),
    `該当なし。コア・スクリーニング条件（PER/PBR/ROE/自己資本比率等の割安財務レンジ）を満たし、かつキラー指標（スプレッド・進捗サプライズ・ハードル比率）のいずれかに該当する銘柄はありませんでした。`, 'D')}

  ${section('p', '🔮', 'カタリスト予兆',
    `「材料が出てから買う」のではなく「材料が出るしかない財務状況」を先回りして拾うセクションです。決算の開示（TDnetの好材料・月次KPI）がまだ無くても、財務データから客観的に読み取れる好材料の予兆（進捗率の連続上振れ・株主還元ポテンシャル・含み資産）に加え、粉飾や見た目ほど強気ではない兆候を先取りする注意予兆（⚠️売掛金の急増・進捗率加速も減益）も表示します。カード右上の需給バッジ（信用買い占有率）は「材料が出た場合に伸びやすいか」を示す補助情報で、これ単体では掲載基準にしていません（実測で需給が軽いだけの銘柄が大半を占めてしまったため分離）。対象はAMBUSHユニバース（決算まで7〜60日の銘柄）と、東証グロース市場銘柄全体（出来高・時価総額で絞り込み）の2つです。「成長株（東証グロース）」チップの付いたカードは決算スケジュールとは無関係の予兆で、AMBUSHの候補ではありません。予兆はあくまで確率的な手がかりであり、確定した好材料・悪材料ではない点にご注意ください。該当予兆の種類が多い順に上位${RANK_TOP_N}件のみ表示します。`,
    precursors.slice(0, RANK_TOP_N).map((r, i) => precursorCard(r, i)).join(''),
    `該当なし。AMBUSHユニバース${amb.universe}銘柄・東証グロース市場銘柄中、進捗率の連続上振れ・株主還元ポテンシャル・含み資産・売掛金急増のいずれかに該当する銘柄はありませんでした。`)}

  <details class="sec" id="q" open>
    <summary class="sec-head">
      <h2><span class="ico">🔵</span>PRE-AMBUSH</h2>
      <p>決算まで${WINDOW.preMin}〜${WINDOW.preMax}日の早期監視枠（v7.3新設）· 上位${AMBUSH_WATCH_MAX}件 · AMBUSH WATCH/NOWと同じ判定基準を先行して適用しているだけで、判定ロジック自体は共通です。今後カタリストが発生しWATCH・NOWに「昇格」する可能性がある銘柄を早期に把握するための枠です</p>
    </summary>
    ${!pre.length ? `<div class="empty">決算まで${WINDOW.preMin}〜${WINDOW.preMax}日の銘柄はありません。</div>` : `
    ${preEvidence.length ? `
    <div class="subhead sub-good">🟢 仕込み候補 — 先行カタリストの根拠あり（${preEvidence.length}件）</div>
    <div class="grid">${preEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    ${preNoEvidence.length ? `
    <div class="subhead sub-ref">⚪ 参考 — 先行材料なし・スコアは目安程度（${preNoEvidence.length}件）</div>
    <div class="grid">${preNoEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    `}
  </details>

  ${section('u', '🇺🇸', '米国株 AMBUSH（Phase 1）',
    `Finnhub決算カレンダーで決算まで${US_WINDOW.nowMin}〜${US_WINDOW.preMax}日の米国企業に絞り込み（全米市場対象・銘柄を限定していません）、Yahoo Financeの日足で乖離率・RSI・出来高Zの技術的な足切り、SEC EDGARの財務データで解散価値割れ・四半期実績の前年同期比トレンドを判定しています。日本株AMBUSHと異なり、TDnet相当の先行カタリスト検出・セクターモメンタム・期待値のワナ（会社予想とコンセンサスの比較）には対応していません（米国には公式な通期業績予想の開示制度が無いため）。無料プランのFinnhubは確定日と見込み日を区別せずに返すため、アナリスト網羅度の低い小型株ほど決算日・あと○日の表示精度が落ちる点にご注意ください。1日1回（日本時間早朝）更新・SCORE上位${RANK_TOP_N}件のみ表示します。`,
    (us.results ?? []).slice(0, RANK_TOP_N).map((r, i) => usCard(r, i)).join(''),
    us.degraded
      ? 'Finnhub決算カレンダーが取得できませんでした（FINNHUB_API_KEY未設定または取得失敗）。'
      : `該当なし。ユニバース${us.universe ?? 0}銘柄をスキャンしましたが、条件に合う銘柄がありませんでした。`)}

  <details class="sec" id="t" open>
    <summary class="sec-head">
      <h2><span class="ico">💎</span>テンバガー候補</h2>
      <p>決算日に依存しない、日本株・米国株共通のテーマ性成長株セクションです（AMBUSHとは分離）。<b>Tier A</b>＝時価総額300億円/$1B以下・本来のテンバガー(10倍)候補。<b>Tier B</b>＝300億〜1000億円/$1B〜$10Bの、10倍は非現実的だが2〜3倍は狙えるグロース中堅株（いずれも売上高成長率+25%以上）。株価が100〜700円(日本)/$1〜$7(米国)の理想帯を外れ先行材料も乏しい銘柄は候補から除外し、仕込みゾーンが🔴織り込み済みの銘柄は除外はせず各Tier内で下位に回します。TAM・受注/RPO等は無料データソースが無く未対応、値動きは荒い点にご注意ください。各Tier上位${RANK_TOP_N}件のみ表示します。</p>
    </summary>
    ${!tenbaggerCandidates.length ? `<div class="empty">該当なし。日本株（東証グロース市場銘柄）・米国株（キュレーションリスト）とも、Tier A/B/C（Tier Cは米国株のみ）いずれの条件にも合う銘柄が無いか、株価帯フィルター（100〜700円/$1〜$7、材料十分なら1500円/$15まで許容）で除外されました。</div>` : `
    ${tenbaggersA.length ? `
    <div class="subhead sub-good">🚀 Tier A — 低時価総額テンバガー候補（${tenbaggersA.length}件）</div>
    <div class="grid">${tenbaggersA.map((r, i) => tenbaggerCard(r, i)).join('')}</div>` : ''}
    ${tenbaggersB.length ? `
    <div class="subhead sub-ref">🌱 Tier B — 中型成長株候補（2〜3倍目安、${tenbaggersB.length}件）</div>
    <div class="grid">${tenbaggersB.map((r, i) => tenbaggerCard(r, i)).join('')}</div>` : ''}
    `}
    ${tenbaggerWatchlist.length ? `
    <div class="subhead sub-ref">🌱 TierAB — テンバガー銘柄監視リスト（手動選定・信用需給を継続監視、${tenbaggerWatchlist.length}件）</div>
    <div class="grid">${tenbaggerWatchlist.map((r, i) => tenbaggerWatchCard(r, i)).join('')}</div>` : ''}
  </details>

  ${policyThemeComparisonSection(policyThemeComparisons)}

  <div class="stamp">
    UPDATED ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ·
    決算日 SBI証券(${sbi.retrievedAt?.slice(0, 16).replace('T', ' ') ?? '--'}) ·
    開示 TDnet ${td.days}営業日/${td.total}件 ·
    株価 kabutan(20分ディレイ) · AUTO-REFRESH 60s<br>
    SCOREは取得できた項目のみで100点換算しています。DATA%が分母（情報量）です。
    低位株(300円未満)・薄商い(5日平均売買代金1億円未満)・赤字/債務超過の銘柄は全セクションで非表示にしています。
  </div>
</div>
</div><!-- /#desktop-view -->
<script>
// 第9優先改修 Phase6（ユーザー提案）: 信用需給タグのワンタップ絞り込み。
// card()側で各カードのarticleにdata-credit-tags（カンマ区切り）を
// 埋め込み済み（creditSupplyTags(r)、scraper.mjs参照）。ここではその
// 属性を見てカードの表示/非表示を切り替えるだけで、新しい判定は行わない。
// 複数タグ選択時はAND（絞り込みが進むほど対象が狭まる）。
(function () {
  var active = new Set();
  window.toggleCreditFilter = function (tag) {
    if (active.has(tag)) active.delete(tag); else active.add(tag);
    applyCreditFilter();
  };
  window.clearCreditFilter = function () {
    active.clear();
    applyCreditFilter();
  };
  function applyCreditFilter() {
    document.querySelectorAll('.credit-filter-chip').forEach(function (btn) {
      btn.classList.toggle('is-active', active.has(btn.dataset.tag));
    });
    var activeList = Array.from(active);
    document.querySelectorAll('#desktop-view .card').forEach(function (card) {
      if (!activeList.length) { card.style.display = ''; return; }
      var tags = (card.dataset.creditTags || '').split(',').filter(Boolean);
      var matches = activeList.every(function (t) { return tags.indexOf(t) !== -1; });
      card.style.display = matches ? '' : 'none';
    });
  }
})();

// 初心者ガイドの開閉状態を覚えておく。60秒ごとの自動リロードのたびに
// サーバー側では常にopen属性付きで生成しているため、これが無いと
// 一度読んで畳んだユーザーでも1分後に強制的に再展開されてしまう。
(function () {
  var KEY = 'ambush.guideOpen';
  var el = document.querySelector('.guide');
  if (!el) return;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved === '0') el.removeAttribute('open');
  } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
  el.addEventListener('toggle', function () {
    try { sessionStorage.setItem(KEY, el.open ? '1' : '0'); } catch (e) { }
  });
})();

// セクション（AMBUSH NOW・カタリスト予兆・SMART ENTRY等）ごとの折りたたみ
// 開閉状態を覚えておく（ユーザー要望）。.guideと同じ理由（60秒ごとの
// 自動リロードでサーバー側は常にopen属性付きで生成するため、これが無いと
// 畳んでもすぐ再展開されてしまう）でsessionStorageに保存する。
// セクションはidで区別する（section()呼び出し時に渡している既存のid、
// 例: 'p'=カタリスト予兆, 'a'=AMBUSH NOW 等）。
(function () {
  var PREFIX = 'ambush.sectionOpen.';
  document.querySelectorAll('details.sec[id]').forEach(function (el) {
    var key = PREFIX + el.id;
    try {
      var saved = sessionStorage.getItem(key);
      if (saved === '0') el.removeAttribute('open');
    } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
    el.addEventListener('toggle', function () {
      try { sessionStorage.setItem(key, el.open ? '1' : '0'); } catch (e) { }
    });
  });
})();

// 自動更新。meta refresh だとスマホで読んでいる途中に毎分先頭へ飛ばされるので、
// スクロール位置を保存してから再読込し、復帰後に戻す。
// 裏に回っているタブは更新しない（無駄なリクエストとバッテリー消費を避ける）。
(function () {
  var KEY = 'ambush.scrollY';
  function save() { try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) { } }
  try {
    var y = sessionStorage.getItem(KEY);
    if (y) window.scrollTo(0, parseInt(y, 10) || 0);
  } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
  addEventListener('pagehide', save);
  addEventListener('beforeunload', save);
  setInterval(function () {
    if (!document.hidden) { save(); location.reload(); }
  }, 60000);
})();

// ==================================================================
// モバイル専用UI（#mobile-app）のタブ切り替え・銘柄検索・
// 「詳細を見る」→PC版該当カードへのジャンプ、PWA用Service Worker登録。
// ==================================================================
(function () {
  var TAB_KEY = 'ambush.mobileTab';

  window.mobileGoTo = function (screen) {
    document.querySelectorAll('#mobile-app .m-screen').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.screen === screen);
    });
    document.querySelectorAll('#mobile-app .m-tab').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.tab === screen);
    });
    try { sessionStorage.setItem(TAB_KEY, screen); } catch (e) { }
    var screensEl = document.querySelector('#mobile-app .m-screens');
    if (screensEl) screensEl.scrollTop = 0;
  };

  // 60秒ごとの自動リロードのたびにHOMEへ戻されると使いづらいので、
  // 直前に見ていたタブを復元する（.guideや.sectionOpenと同じ理由）。
  try {
    var savedTab = sessionStorage.getItem(TAB_KEY);
    if (savedTab) window.mobileGoTo(savedTab);
  } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }

  // 便利機能: 「上へ戻る」ボタン（ユーザー要望2026-09-19）。
  // #mobile-appは独自スクロールコンテナを持たずwindowがスクロールする
  // ため、window.scrollYで判定する。PC版表示中（desktop-view）は
  // 別のスクロール挙動になるため出さない。
  window.mobileScrollToTop = function () {
    window.scrollTo(0, 0);
  };
  window.addEventListener('scroll', function () {
    var btn = document.getElementById('m-top-btn');
    if (!btn) return;
    var mobileApp = document.getElementById('mobile-app');
    var isMobileVisible = mobileApp && getComputedStyle(mobileApp).display !== 'none';
    btn.classList.toggle('is-visible', isMobileVisible && window.scrollY > 400);
  }, { passive: true });

  // 「詳細を見る」: PC版へ画面ごと飛ばすとモバイル画面に戻れず分かりにくい
  // という指摘（2026-09-19）を受け、PC版（#desktop-view）のDOMに既にある
  // 該当カードをその場でボトムシートに複製して見せる形に変更。カードの
  // 組み立てロジックは複製せず、PC版が生成した同一のHTMLをそのまま
  // 使う（判定結果がPC版とズレない）。
  window.mobileShowDesktopCard = function (code) {
    // #desktop-view側の原本にしか id="card-<code>" を残さない。
    // クローン側にも同じidを残すと、同じ銘柄を2回目にタップした際に
    // document.getElementById()が（DOM順で先に出てくる）前回のクローン
    // を拾ってしまい、以後ずっと古い内容のまま更新されなくなる
    // （実測バグ2026-09-19: モーダル化した直後は気づきにくいが、
    // 60秒の自動リロードを挟まずに同じ銘柄を開き直すと再現する）。
    var src = document.getElementById('card-' + code);
    var body = document.getElementById('m-modal-body');
    var modal = document.getElementById('m-card-modal');
    if (!body || !modal) return false;
    if (src) {
      var clone = src.cloneNode(true);
      clone.removeAttribute('id');
      body.innerHTML = '';
      body.appendChild(clone);
    } else {
      body.innerHTML = '<p class="m-empty">この銘柄の詳細カードは現在の集計対象外です。PC版でご確認ください。</p>';
    }
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    return false;
  };

  window.mobileCloseCard = function () {
    var modal = document.getElementById('m-card-modal');
    if (modal) modal.classList.remove('is-open');
    document.body.style.overflow = '';
  };

  window.mobileShowDesktop = function () {
    document.getElementById('mobile-app').style.display = 'none';
    document.getElementById('desktop-view').style.display = 'block';
    var back = document.getElementById('m-back-btn');
    if (back) back.style.display = 'flex';
  };

  window.mobileShowMobile = function () {
    document.getElementById('mobile-app').style.display = '';
    document.getElementById('desktop-view').style.display = '';
    var back = document.getElementById('m-back-btn');
    if (back) back.style.display = 'none';
    window.scrollTo(0, 0);
  };

  // 銘柄検索（STOCKタブ）。判定ロジックには触れず、コード/銘柄名の
  // 部分一致でスマホ用の簡易一覧を絞り込むだけ。
  var searchDataEl = document.getElementById('m-search-data');
  var searchInput = document.getElementById('m-search-input');
  var searchResult = document.getElementById('m-search-result');
  if (searchDataEl && searchInput && searchResult) {
    var stocks = [];
    try { stocks = JSON.parse(searchDataEl.textContent || '[]'); } catch (e) { stocks = []; }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function renderResults(list) {
      if (!list.length) {
        searchResult.innerHTML = '<p class="m-empty">該当銘柄がありません</p>';
        return;
      }
      searchResult.innerHTML = list.slice(0, 30).map(function (r) {
        var pct = r.changePct ?? 0;
        return '<a class="m-row" href="#card-' + esc(r.code) + '" onclick="return mobileShowDesktopCard(\\'' + esc(r.code) + '\\')">'
          + '<div class="m-row-main"><span class="m-code">' + esc(r.code) + '</span><span class="m-name">' + esc(r.name) + '</span></div>'
          + '<div class="m-row-side"><span class="m-price">' + (r.price != null ? '¥' + r.price.toLocaleString() : '--') + '</span>'
          + '<span class="m-chg ' + (pct >= 0 ? 'up' : 'down') + '">' + (pct >= 0 ? '+' : '') + pct + '%</span></div></a>';
      }).join('');
    }
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim().toLowerCase();
      if (!q) { searchResult.innerHTML = ''; return; }
      renderResults(stocks.filter(function (r) {
        return String(r.code).toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q);
      }));
    });
  }

  // PWAインストール可否の必須条件（Service Worker登録実績）を満たす。
  // HTTPS/localhost以外（今回のLAN内HTTP配信）では登録自体が失敗するが、
  // その場合も他の機能には一切影響しないよう例外を握りつぶすだけにする。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { });
  }
})();
</script>
</body>
</html>`;

  auditGeneratedHtml(html);
  fs.writeFileSync(OUT_FILE, html);
  publishToICloud(html);
  if (!NO_OPEN) exec(`open ${JSON.stringify(OUT_FILE)}`);
  console.log(
    `✅ 完了 / SMART ENTRY ${smart.results.length}件 · AMBUSH NOW ${now.length}件 · WATCH ${later.length}件 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`
  );
  // 実測: 手動で起動した--forceの長時間実行中にMacがスリープ/バッテリー
  //切れになり、約36時間中断された後に実行が再開・完了した事例が発生した
  // （ロック機構は「プロセスが生きているか」だけを見る設計なので、
  // スリープ中もロックは正しく保持され続け、二重実行は防げていたが、
  // その間キャッシュが更新されず順位が2日以上古いまま配信され続けた）。
  // todayはmain()の先頭で1度だけ捕捉した値なので、実行が日をまたいで
  // 中断された場合はキャッシュのdateフィールドが開始日のまま古くなる。
  // ログを見ただけで異常に気付けるよう、実行時間が2時間を超えた場合は
  // 明示的に警告する（原因調査に日をまたいだログの突き合わせが必要
  // だった反省）。
  const elapsedHours = (Date.now() - t0) / 3600000;
  if (elapsedHours > 2) {
    console.error(`  ⚠️ 実行に${elapsedHours.toFixed(1)}時間かかりました（通常は1時間未満）。途中でスリープ/バッテリー切れが無かったか確認してください。todayは開始時点の${today}のまま記録されています`);
  }
}

// ------------------------------------------------------------------
// スマホ向けの配信 — iCloud Drive にコピーする
//
//  Macのローカルファイルはスマホから開けない。LAN配信(python -m http.server)
//  でも見られるが、Macが起きていて同じWi-Fiに居ることが条件になる。
//  実測でこのMacは日中よくスリープする（2026-08-17 は07:00バッチが
//  20:26まで中断された）ので、外出先でも見られる iCloud 経由を既定にする。
//
//  index.html は画像もCSSも全て内蔵した1枚なので、ファイルを置くだけで動く。
//  iPhone側: ファイルアプリ → iCloud Drive → AMBUSH → AMBUSH.html
//
//  iCloudを使っていないMacでは黙ってスキップする（失敗させない）。
// ------------------------------------------------------------------
const ICLOUD_DIR = path.join(
  process.env.HOME ?? '',
  'Library/Mobile Documents/com~apple~CloudDocs/AMBUSH'
);

function publishToICloud(html) {
  const root = path.dirname(ICLOUD_DIR);
  if (!fs.existsSync(root)) return; // iCloud Drive 未使用
  try {
    fs.mkdirSync(ICLOUD_DIR, { recursive: true });
    // 同期中の半端なファイルを見せないよう、別名で書いてから置き換える
    const dest = path.join(ICLOUD_DIR, 'AMBUSH.html');
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, dest);
    console.log(`📱 iCloudへ配信: ${dest}`);
  } catch (e) {
    console.error(`  ⚠️ iCloudへの配信失敗: ${e.message}`);
  }
}

// 異常終了でもロックを残さない（残った場合も次回に生存確認で回収される）
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(1); });

// `node scraper.mjs` として直接実行された時だけmain()を走らせる。
// テストからbuyRuleChecklist等をimportする際に、スクレイピング本体まで
// 副作用として動いてしまわないようにするためのガード。
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ 異常終了: ${e.stack ?? e.message}`);
    releaseLock();
    process.exit(1);
  });
}
