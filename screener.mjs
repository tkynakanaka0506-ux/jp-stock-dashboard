// ==================================================================
// screener.mjs — AMBUSH 2段スクリーニング
//
//  Stage 1 … 株価・MA25・乖離率・RSI(14)・出来高Zスコアのみで足切り。
//            「まだ動いていない」ことの確認であって良し悪しの判定ではない。
//            kabuka ページ1枚（1リクエスト）で完結する。
//  Stage 2 … 通過銘柄だけに対して TDnet / 月次 / 進捗率 / 業種 を取りに行く。
//
//  ■ スコアの正規化について
//  仕様書の配点は 月次30 + PR30 + 進捗20 + セクター10 + テクニカル10 = 100。
//  ただし取得できなかった項目を 0点 として扱うと「情報が無い銘柄」が
//  「悪い銘柄」に化けてしまう（仕様書§25はN/Aの数値化を禁じている）。
//  そこで取得できた項目の満点合計を分母にして100点換算し、
//  分母そのものを DATA CONFIDENCE として別に表示する。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchIntraday, fetchIntradayExtended, fetchMain, fetchFinance, fetchWeeklyCredit, fetchSectorMomentum, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, volumeZScore, stage1, unpricedScore, STAGE1, cheapExclusion, fundamentalExclusion, marketCapExclusion,
  sellingClimaxSignal, netNetSignal, lowPbrSignal, dividendYieldFloorSignal, shortSqueezeSignal, sectorMomentumSignal,
  sectorRotationSignal, SECTOR_ROTATION, marginOverhangSignal, buyingDemandSignal, receivablesAnomalySignal, dividendYieldPeakSignal,
  institutionalShortSignal, majorShareholderSignal, pbrHistoricalLowSignal, hiddenGemSignal,
  retailExpectationSignal, returnPct, priceLevelVsRange, volumeRatio, creditTrend,
  progressStreakSignal, dividendPotentialSignal, hiddenAssetSignal, creditFloatSignal, creditSupplyQualitySignal, creditSupplyTimeline, consensusTrapSignal,
  latestProfitYoyPct, repricingLagScore, repricingGapScore, evEbitda, buildScoreParts, buyScore, buyScoreRiskPenalty,
} from './indicators.mjs';
import { evaluate } from './tdnet.mjs';
import { sectorTrendPct } from './sector_history.mjs';
import { fetchDividendYieldHistory, fetchMajorShareholderTrend, fetchPbrHistory } from './irbank.mjs';
import { fetchInstitutionalShortInterest } from './karauri.mjs';
import { fetchBalanceSheetSnapshots } from './edinet.mjs';
import { computeLogicFingerprint, isCacheFresh } from './logic_fingerprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'ambush_cache.json');

// v7.3改修（ユーザー指示書 項目4/5）: 「T+14〜T+30」という表記が「決算後
// 14〜30日」と読めてしまい、実際の意味（daysUntil()が返す「次回決算まで
// あと○日」というカウントダウン）と逆に誤解されやすかった。ロジック自体
// （daysLeftは既に「決算まであと○日」）は変更せず、表示文言を「決算まで
// ○日」に統一する。あわせてAMBUSHを3段階化する:
//   PRE-AMBUSH: 決算まで46〜60日（新設。早期監視）
//   AMBUSH WATCH: 決算まで31〜45日
//   AMBUSH NOW: 決算まで7〜30日（従来は14日始まりだったが、ユーザー要望で
//     7日まで拡張。ただし7〜13日は決算直前のため、狙い目の核（sweetMin）
//     ではなく「織り込み警戒」に倒しやすくする＝ambushVerdict側で別途考慮）
export const WINDOW = { nowMin: 7, sweetMin: 14, nowMax: 30, watchMin: 31, watchMax: 45, preMin: 46, preMax: 60 };

// AMBUSH（決算前の待ち伏せ）に大型株が混ざるとノイズになるという指摘
// （実測: 良品計画・しまむらが上位に出ていた。しまむらの時価総額は
// 720,300百万円=7203億円で大きく超過）。テンバガーTier B（US側$10B）と
// 同じ水準を採用する。テンバガー候補の判定ロジックとは無関係で、
// AMBUSH自体の逆張り・決算前待ち伏せロジックは変更しない。
export const AMBUSH_MAX_MARKET_CAP_JPY = 100_000; // 百万円（1000億円）
export const MAX_WEIGHT = { monthly: 30, pr: 30, progress: 20, sector: 10, technical: 10 };

// ------------------------------------------------------------------
// 順位付け用の総合スコア。旧来のcomposite scoreだけを並べ替えの基準に
// していたため、底打ち確認・同業他社比較で追加した根拠（解散価値割れ・
// 業種内で割安・配当下限・配当利回り史上最高・出遅れ・踏み上げ）が
// 「表示されるだけで順位には一切反映されない」抜けがあった
// （smart_entry.mjsのsmartEntryConvictionは同じ設計で既に反映済み）。
// 既存のverdict（買い推奨→様子見→見送り）による並び替えを最優先に
// した上で、同じ結論内の順位だけをこのスコアで補正する（scoreの
// 意味そのものは変えない）。
// ambushConvictionが実際に加点する信号の一覧。この配列を唯一の情報源
// にする（scraper.mjsのconvictionNote表示・test/conviction.test.mjsの
// 両方がこれをimportして使う）。新しいシグナルを加点対象にする場合は
// ここに1行足すだけで、表示・テストの両方に自動的に反映される
// （「表示だけして順位への配線を忘れる」「表示側だけリストが古くなる」
// という、このファイルとconvictionNoteの両方で実際に起きた抜けの
// 再発防止）。
export const AMBUSH_BONUS_FIELDS = [
  'netNet', 'lowPbr', 'divFloor', 'squeeze', 'sectorRotation', 'dividendPeak', 'institutionalShort',
  'majorShareholder', 'pbrHistoricalLow', 'hiddenGem', 'progressStreak', 'dividendPotential', 'hiddenAsset',
  'creditFloat', 'consensusTrap',
];

// ambushConvictionが実際に減点する信号の一覧（AMBUSH_BONUS_FIELDSの
// 減点版・単一の情報源）。retailExpectationSignal（個人投資家の期待
// 織り込み）は「良い会社」ではなく「まだ株価に織り込まれていない
// 良い会社」を優先するための重要な減点要素（ユーザー要望）。
// creditFloatSignal（信用買い占有率）は浮動株に対して信用買いが積み
// 上がっている＝上値が重い状態を減点する（ユーザー提案の需給フィルタ）。
// consensusTrapSignal（期待値のワナ）は会社予想がコンセンサスを下回る
// ＝上方修正しても届かず暴落する危険地帯を減点する（WATCHLIST時代に
// 使われていたが呼び出し側だけ削除されデッドコード化していたのを復活）。
export const AMBUSH_PENALTY_FIELDS = ['retailExpectation', 'creditFloat', 'consensusTrap'];

export function ambushConviction(r) {
  let score = r.score ?? 0;
  score += AMBUSH_BONUS_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good').length * 5;
  // 増配履歴（配当利回りの水準ではなく配当額そのものの伸びの継続性）は
  // dividendPeak（利回り対比の高低）とは別の情報を捉えているため、
  // 一定年数以上の連続増配は独立した裏付けとして加点する。
  if (r.dividendStreakYears >= 3 && r.dividendStreakDirection === 'up') score += 5;
  score -= AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'bad').length * 10;
  score -= AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn').length * 4;
  return score;
}

export function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const a = new Date(`${today}T00:00:00Z`);
  const b = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

// ------------------------------------------------------------------
// 進捗率の「折返し基準」
//
//  ■ 直そうとしている間違い
//  以前は kabutan の見出しだけを見て「対通期なら25% / それ以外は50%」と
//  していた。これは *次回* 決算期を見ておらず、実測で 86銘柄中63銘柄が
//  満点20/20（超過の中央値 +37.7%）という壊れた分布になっていた。
//  例: 3662 は次回が本決算＝3Qまで開示済みなのに基準25%と比較され、
//  対通期43.3% が「+18.3%で満点」と評価されていた。正しくは基準75%に
//  対する大幅な未達である。
//
//  ■ 正しい考え方
//  基準 = (開示済みの四半期数) / (予想の対象四半期数)
//  分子は SBI の *次回* 決算期から逆算する。次回が本決算なら3Qまで開示
//  済み、次回が3Qなら中間まで、次回が中間なら1Qまで。
//  分母は kabutan の見出しで決まる。「対通期進捗率」は通期予想=4Q分、
//  「対上期進捗率」は上期予想=2Q分が分母（実測: 4334/1758は対上期）。
//
//  ■ 埋めないもの（仕様書§25）
//  ・次回が1Q … 直前の開示は前期の本決算なので当期の累計が存在しない
//  ・見出しが取れない … 分母が不明。以前は黙って50%を仮定していた
//  いずれも null を返し、進捗項目はスコアから外して DATA CONFIDENCE を下げる。
// ------------------------------------------------------------------

// 決算発表前（AMBUSHユニバースは常にこちら）: 次回決算期 →
// 当期で既に開示が終わっている四半期の本数
export function reportedQuarters(nextQuarter = '') {
  if (nextQuarter.includes('本決算')) return 3; // 3Qまで開示済み
  if (nextQuarter.includes('3Q')) return 2; // 中間まで
  if (nextQuarter.includes('中間') || nextQuarter.includes('2Q')) return 1; // 1Qまで
  if (nextQuarter.includes('1Q')) return 0; // 当期の累計はまだ無い
  return null;
}

// 進捗率の見出し → 分母にあたる四半期数
export function forecastQuarters(label = '') {
  if (label?.includes('対通期')) return 4;
  if (label?.includes('対上期')) return 2;
  return null; // 不明。推測しない
}

// 基準(%) = 開示済み四半期数 / 予想対象四半期数
//   done >= denom は「予想期間が既に終わっている」状態で、進捗率は定義上
//   ほぼ100%になり情報を持たない（例: 本決算発表後の対通期進捗）。
//   満点でも0点でもなく評価対象外なので null。
export function basisOf(done, label) {
  const denom = forecastQuarters(label);
  if (done === null || denom === null) return null;
  if (done <= 0 || done >= denom) return null;
  return Math.round((done / denom) * 100);
}

// 決算発表前（AMBUSH）— kabutanの進捗率と次回決算期から
export const progressBasis = (nextQuarter, label) => basisOf(reportedQuarters(nextQuarter), label);

// ------------------------------------------------------------------
// 各項目のスコアリング（取得できなければ null を返す）
// ------------------------------------------------------------------

// 月次KPI(30) — TDnetの題名には前年比%が出ないため「開示の有無」までしか
// 判定できない。中身を読まずに満点を与えるのは推測なので、存在確認ぶんの
// 半分を上限とし、中身は N/A として DATA CONFIDENCE に反映する。
export function monthlyScore(ev) {
  if (!ev || ev.score === null) return { value: null, note: '開示なし' };
  if (!ev.hasMonthly) return { value: null, note: '月次開示なし' };
  return { value: 15, note: '月次開示あり（中身はPDF内のためN/A）' };
}

export function prScore(ev) {
  if (!ev || ev.score === null) return { value: null, note: '開示なし' };
  return { value: ev.score, note: ev.negatives.length ? '悪材料あり' : ev.positives.length ? '好材料あり' : '中立' };
}

// 業績進捗(20) — 折返し基準に対する超過分で評価する
export function progressScore(progress, basis) {
  if (progress === null || progress === undefined || basis === null) return { value: null, note: 'N/A' };
  const excess = progress - basis;
  let v;
  if (excess >= 10) v = 20;
  else if (excess >= 5) v = 16;
  else if (excess >= 2) v = 12;
  else if (excess >= -2) v = 8;
  else if (excess >= -10) v = 4;
  else v = 0;
  return { value: v, note: `基準${basis}%に対し${excess > 0 ? '+' : ''}${Math.round(excess * 10) / 10}%` };
}

export function sectorScore(changePct) {
  if (changePct === null || changePct === undefined) return { value: null, note: 'N/A' };
  let v;
  if (changePct >= 2) v = 10;
  else if (changePct >= 1) v = 8;
  else if (changePct >= 0) v = 6;
  else if (changePct >= -1) v = 3;
  else v = 0;
  return { value: v, note: `業種${changePct > 0 ? '+' : ''}${changePct}%` };
}

// ------------------------------------------------------------------
// 合成: 取得できた項目だけで100点換算し、分母を信頼度として返す
// ------------------------------------------------------------------
export function composite(parts) {
  let got = 0, max = 0;
  const detail = {};
  for (const [k, w] of Object.entries(MAX_WEIGHT)) {
    const p = parts[k];
    detail[k] = p;
    if (p && p.value !== null) { got += p.value; max += w; }
  }
  if (max === 0) return { score: null, confidence: 0, detail, coverageScore: 0 };
  return {
    score: Math.round((got / max) * 100),
    confidence: Math.round((max / 100) * 100), // 満点合計＝取得できた情報量(%)
    // coverageScore: 未取得の軸を0点として数えた場合の点数（indicators.mjs
    // のweightedComposite()と同じ考え方。第2優先改修、CASE4対応）。
    // scoreは既存通りrankOf()等の判定に使われている値のため変更しない。
    coverageScore: Math.round(got),
    detail,
  };
}

// ------------------------------------------------------------------
// 「読めなかった開示」ぶんの信頼度控除
//
//  「業績予想の修正」は題名に上方/下方が書かれないことが多い（実測:
//  671件中642件＝96%が方向不明）。これは加点も減点もできないが、
//  “情報が無い” のではなく “情報はあるのに読めていない” 状態なので、
//  DATA CONFIDENCE には反映させる（表示上の控除。スコアの分母は変えない。
//  分母を減らすと got/max が上がってスコアが逆に良化してしまうため）。
//
//  控除量は推測せず、実測比から出す:
//    PRの配点30 × 方向不明件数 /（方向不明件数 + 方向が読めた件数）
//  例) 好材料2件・方向不明1件 → 30 × 1/3 = 10ポイント控除。
// ------------------------------------------------------------------
export function confidencePenalty(ev) {
  if (!ev || ev.score === null) return 0; // PR自体が未取得ならcompositeが既に除外済み
  const unreadable = ev.ambiguous.length;
  if (unreadable === 0) return 0;
  const readable = ev.positives.length + ev.negatives.length;
  return Math.round(MAX_WEIGHT.pr * (unreadable / (unreadable + readable)));
}

export const reportedConfidence = (confidence, ev) =>
  Math.max(0, confidence - confidencePenalty(ev));

// ------------------------------------------------------------------
// カタリスト必須ゲート
//
//  仕様書の哲学は GOOD CATALYST + UPCOMING EARNINGS + LOW PRICED-IN。
//  ところが実測では Stage 1 通過111銘柄のうち 月次null=110 / PR null=105 で、
//  「進捗+セクター+テクニカル」だけが埋まった銘柄が満点40を100点換算して
//  Sランクに化けていた（71/111がS判定、カタリスト保有は0件）。
//  セクターは同業種の全銘柄で同じ値、テクニカルは乖離率の言い換えなので、
//  この3項目だけでは「先行カタリスト」の根拠にならない。
//
//  そこで TDnet 由来の先行シグナル（好材料の開示 or 月次KPIの開示）が
//  無い銘柄には S/A を与えず、NOW にも入れない。スコアは正規化のまま
//  表示し、根拠不足であることを rank と bucket の側で表現する。
// ------------------------------------------------------------------
export const hasEvidence = (ev) => Boolean(ev && (ev.positives.length > 0 || ev.hasMonthly));

export const rankOf = (s, evidence = true) => {
  if (s === null) return 'N/A';
  const r = s >= 80 ? 'S' : s >= 70 ? 'A' : s >= 60 ? 'B' : s >= 50 ? 'C' : 'D';
  // 先行カタリストが無い銘柄は上位2ランクを与えない（B止まり）
  if (!evidence && (r === 'S' || r === 'A')) return 'B';
  return r;
};

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
export async function runScreen({ today, sbiStocks, disclosures, sectorHistory = {}, force = false, stage1Limit = 400 } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  const logicFingerprint = computeLogicFingerprint();
  if (!force && isCacheFresh(cache, today, logicFingerprint)) {
    console.log(`💾 AMBUSHキャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }
  if (!force && cache.date === today && cache.results && cache.logicFingerprint !== logicFingerprint) {
    console.log(`⚠️ AMBUSHキャッシュは当日分ですが判定ロジックが変更されているため再計算します (${today})`);
  }

  // --- ユニバース確定 ---------------------------------------------
  const universe = Object.values(sbiStocks)
    .map((s) => {
      const ref = s.earningsDate ?? s.earningsDateApprox;
      return { ...s, daysLeft: daysUntil(ref, today), refDate: ref };
    })
    .filter(
      (s) =>
        ['confirmed', 'estimated'].includes(s.earningsDateStatus) &&
        s.daysLeft !== null &&
        s.daysLeft >= WINDOW.nowMin &&
        s.daysLeft <= WINDOW.preMax
    )
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, stage1Limit);

  console.log(`🎯 AMBUSHユニバース: ${universe.length}銘柄（決算まで${WINDOW.nowMin}〜${WINDOW.preMax}日）`);
  if (!universe.length) {
    // ユニバースが空でも、SECTION B のスコアリングに業種騰落が要る
    let sectorsOnly = {};
    try { sectorsOnly = await fetchSectorMomentum(); } catch { /* 失敗時はN/A */ }
    const out = { date: today, universe: 0, passed: 0, results: [], stage1: STAGE1, sectors: sectorsOnly, logicFingerprint };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
    return out;
  }

  // --- Stage 1 ----------------------------------------------------
  console.log(`🔍 Stage 1: テクニカル足切り (${universe.length}リクエスト)`);
  const survivors = [];
  let s1err = 0, s1excluded = 0;
  for (const [i, s] of universe.entries()) {
    try {
      const iv = await fetchIntraday(s.code);
      // 低位株・薄商い銘柄は候補にすら上げない（「ゴミ箱排除」フィルター）。
      // kabukaページ1枚で判定できるのでここで弾き、Stage2の無駄打ちを防ぐ。
      const excl = cheapExclusion({ price: iv.price, closes: iv.closes, volumes: iv.volumes });
      if (excl.excluded) { s1excluded++; continue; }
      const t = {
        price: iv.price,
        changePct: iv.changePct,
        kairi: kairi(iv.price, iv.closes),
        rsi: rsi(iv.closes),
        volZ: volumeZScore(iv.volumes),
        closes: iv.closes,
        volumes: iv.volumes,
        vol: iv.vol,
        market: iv.market,
      };
      const v = stage1(t);
      if (v.pass) survivors.push({ ...s, tech: t });
    } catch (e) {
      s1err++;
    }
    if ((i + 1) % 50 === 0) console.log(`   … ${i + 1}/${universe.length} 通過${survivors.length}（除外${s1excluded}）`);
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 通過 ${survivors.length}/${universe.length}（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}）`);

  // --- セクター騰落（3リクエスト・全銘柄で共用）------------------
  let sectors = {};
  try {
    sectors = await fetchSectorMomentum();
  } catch (e) {
    console.error(`  ⚠️ 業種別騰落の取得失敗: ${e.message}`);
  }

  // --- Stage 2 ----------------------------------------------------
  console.log(`🔬 Stage 2: ファンダ照合 (${survivors.length}銘柄 × 最大8リクエスト、赤字/債務超過は2リクエストで除外確定)`);
  // 貸借対照表項目（売掛金・現金及び預金・自己資本・総資産）はEDINETの
  // 法定開示書類から取得する（ハイブリッド方針：営業利益・進捗率は鮮度
  // 優先でkabutan、貸借対照表は正確性優先でEDINET）。EDINETには銘柄単体の
  // 検索APIが無く日付ごとの全件走査しか無いため、全survivors分をまとめて
  // 1回の日次走査で済ませる（銘柄ごとに逐次走査すると27銘柄×400日規模の
  // リクエストになり非現実的）。
  let edinetSnapshots = new Map();
  try {
    edinetSnapshots = await fetchBalanceSheetSnapshots(survivors.map((s) => s.code));
  } catch (e) {
    console.error(`  ⚠️ EDINET貸借対照表の一括取得に失敗: ${e.message}`);
  }
  const results = [];
  let s2excluded = 0, s2excludedCap = 0, s2excludedRisk = 0;
  for (const s of survivors) {
    let main = {}, fin = {};
    try {
      await sleep(REQ_GAP);
      main = await fetchMain(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} Stage2失敗(main): ${e.message}`);
    }

    // 時価総額が大きすぎる銘柄はAMBUSH（決算前の待ち伏せ）候補として
    // 出す意味が薄いという指摘（実測: 良品計画・しまむらが上位常連化）
    // への対応。fin取得より前に弾き、無駄なリクエストを増やさない。
    // 実測バグの再発防止: 当初は下のs2excluded（赤字・債務超過）と同じ
    // カウンタを共用しており、ログの「赤字・債務超過除外」件数に時価
    // 総額超過分が紛れ込んで実態と食い違っていた。原因を別カウンタに分離する。
    const mexcl = marketCapExclusion({ marketCap: main.marketCap, maxMarketCap: AMBUSH_MAX_MARKET_CAP_JPY });
    if (mexcl.excluded) { s2excludedCap++; continue; }

    try {
      await sleep(REQ_GAP);
      fin = await fetchFinance(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} Stage2失敗(fin): ${e.message}`);
    }

    // 赤字・債務超過は決算ページ(fetchFinance)だけで分かるので、ここで
    // 弾く。「一切表示しない」対象なので、他のセクションにも一切出さない。
    // 除外が確定した銘柄のために週次信用残・四本値・IR Bankへの3リクエスト
    // を無駄打ちしないよう、これらより前に判定する（実測で修正: 以前は
    // 除外前に全て取得していたため、赤字・債務超過銘柄の分だけ無駄な
    // リクエストが発生していた）。
    const fexcl = fundamentalExclusion({ latestOpProfit: fin.latestOpProfit, equityRatio: fin.equityRatio });
    if (fexcl.excluded) { s2excluded++; continue; }

    let weekly = [], ivFresh = null;
    try {
      await sleep(REQ_GAP);
      weekly = await fetchWeeklyCredit(s.code);
      // 底打ち確認（＋α）用の四本値。Stage1は乖離/RSI用にclose/volしか
      // 保持していないため、候補にだけ絞ってここで取り直す（全銘柄分は
      // 保持コストが見合わないため）。セリングクライマックス判定に
      // 35日以上必要なので、通常のkabuka(30日)より1ページ多く遡って取る。
      // ■ pages=3（実測で発覚したバグの修正）
      // 仕込み妙味スコアのreturn3m=returnPct(closes,60)は60本前(=61件目)の
      // 終値を必要とするが、pages=2は実測で常にちょうど60件しか返さず
      // （1ページ約30営業日×2）、1件足りずreturn3mが実データで常にnullに
      // なっていた（AMBUSH候補9銘柄全件で確認）。pages=3(約90件)にして
      // 安全マージンを持たせる。
      await sleep(REQ_GAP);
      ivFresh = await fetchIntradayExtended(s.code, 3);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} 底打ち確認取得失敗: ${e.message}`);
    }
    // ネットネット判定の売掛金・売掛金異常増加チェック用の貸借対照表は
    // Stage2ループの前でEDINETからまとめて取得済み（fetchBalanceSheetSnapshots）。
    const bs = edinetSnapshots.get(s.code) ?? {};

    // 過去5年の配当利回りレンジ（IR Bank）。ネットキャッシュ/PBRに次ぐ
    // 「下値の目安」の3つ目の視点として、AMBUSHのみに追加する。
    let dividendHistory = {};
    try {
      await sleep(REQ_GAP);
      dividendHistory = await fetchDividendYieldHistory(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} IR Bank配当履歴取得失敗: ${e.message}`);
    }
    // currentYieldはIR Bank自身の値ではなくkabutan(main.dividendYield)を
    // 渡す。取得元がずれると同じカードに2つの異なる「現在利回り」が
    // 同居してしまうため（実測: 7921でkabutan4.21%・IR Bank4.29%）。
    const dividendPeak = dividendYieldPeakSignal({
      currentYield: main.dividendYield, maxYield: dividendHistory.maxYield, maxPeriod: dividendHistory.maxPeriod,
    });

    // 過去のPBRレンジ（IR Bank）。コンセンサスが無い銘柄の「代用物差し」
    // として、業種平均比（lowPbrSignal）に加え自分自身の過去レンジの
    // 中での位置も見る。
    let pbrHistory = {};
    try {
      await sleep(REQ_GAP);
      pbrHistory = await fetchPbrHistory(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} IR Bank PBR推移取得失敗: ${e.message}`);
    }
    // currentPbrはIR Bank自身の値ではなくkabutan(main.pbr)を渡す
    // （dividendPeakと同じ理由。同じカードに2つの異なる「現在PBR」が
    // 同居する矛盾を避ける）。
    const pbrHistoricalLow = pbrHistoricalLowSignal({
      currentPbr: main.pbr, minPbr: pbrHistory.minPbr, minPeriod: pbrHistory.minPeriod,
    });

    // 機関投資家の空売り残高（karauri.net・大量保有報告に基づく法定開示）。
    // kabutanの信用残（個人投資家中心）とは投資主体が異なる別データ。
    let institutionalShortInfo = {};
    try {
      await sleep(REQ_GAP);
      institutionalShortInfo = await fetchInstitutionalShortInterest(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} karauri.net取得失敗: ${e.message}`);
    }
    const institutionalShort = institutionalShortSignal(institutionalShortInfo);

    // 大株主の買い増し（IR Bank・大株主一覧）。Ulletの「大株主構成・
    // 浮動株比率」提案の代替として、既に統合済みのIR Bankの同等ページで補う。
    let shareholderInfo = {};
    try {
      await sleep(REQ_GAP);
      shareholderInfo = await fetchMajorShareholderTrend(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} IR Bank大株主取得失敗: ${e.message}`);
    }
    const majorShareholder = majorShareholderSignal(shareholderInfo);

    const ev = evaluate(disclosures[s.code] ?? []);
    // v7.3改修 項目8: 上場廃止決定・大規模希薄化進行中の銘柄は、判定を
    // 悪化させるだけでなく候補一覧から丸ごと除外する（減点では「様子見」
    // 「見送り」として表示され続けてしまい、決算先読みの前提自体が崩れて
    // いることが伝わりにくいため）。tdnet.mjsのsevere:trueキーワード参照。
    if (ev.severeRiskHits.length) { s2excludedRisk++; continue; }
    const sec = main.sectorName ? sectors[main.sectorName] : null;

    // 進捗率は kabutan の決算ページから取る。
    // SBIの達成率(achievedRate)は決算発表前の銘柄には存在しない（実測:
    // 260銘柄中6件のみ、しかもその6件は全て earningsDateStatus='unknown'
    // ＝既に決算を出したウォッチリスト銘柄）。AMBUSHユニバースは
    // confirmed/estimated のみなので、ここでSBI側を見ても常に空振りになる。
    const progress = fin.progress ?? null;
    const basis = progressBasis(s.quarter ?? '', fin.progressLabel);

    const parts = {
      monthly: monthlyScore(ev),
      pr: prScore(ev),
      progress: progressScore(progress, basis),
      sector: sectorScore(sec?.changePct ?? null),
      technical: { value: unpricedScore(s.tech.kairi), note: `乖離${s.tech.kairi}%` },
    };
    const { score, confidence, detail, coverageScore } = composite(parts);
    const evidence = hasEvidence(ev);

    // 底打ち確認（＋α）— 除外/加点には使わず、根拠を積み増す一言メモとして
    // カード側に出す（仕様書§25と同じ方針でN/Aは null のまま主張しない）。
    const climax = sellingClimaxSignal(ivFresh ?? {});
    const netNet = netNetSignal({ cash: bs.cash, totalAssets: bs.totalAssets, equity: bs.equity, marketCap: main.marketCap, receivables: bs.receivables });
    const lowPbr = lowPbrSignal({ pbr: main.pbr, sectorPbr: sec?.pbr });
    // v7.3改修 項目10: PER/PBRだけでなくEV/EBITDAも併記する（新規リクエスト
    // 無し、bs/finとも既に取得済みのデータから計算）。
    const evEbitdaResult = evEbitda({
      marketCap: main.marketCap, interestBearingDebt: bs.interestBearingDebt,
      cash: bs.cash, operatingProfit: fin.latestOpProfit, dAndA: bs.dAndA,
    });
    const divFloor = dividendYieldFloorSignal(main.dividendYield);
    // A指示 項目18: 踏み上げ判定を機関投資家の空売り縮小・出来高急増
    // でも裏付ける（複数一致時のみ高評価にする）。expectation.technical
    // で後述するvolumeRatio(ivFresh?.volumes)と同じ計算を先に済ませて使う
    // （追加リクエスト無し）。
    const squeezeVolRatio = volumeRatio(ivFresh?.volumes);
    const squeeze = shortSqueezeSignal(weekly, { institutionalShort, volRatio: squeezeVolRatio });
    const sectorLag = sectorMomentumSignal(s.tech.changePct, sec?.changePct ?? null);
    const sectorRotation = sectorRotationSignal({
      sectorTrendPct: sectorTrendPct(sectorHistory, main.sectorName, today, SECTOR_ROTATION.trendDays),
      kairi: s.tech.kairi,
      cross: null, // AMBUSHはゴールデンクロスを算出していないため乖離のみで判定
    });
    const marginOverhang = marginOverhangSignal(main.loanRatio);
    // 第7優先改修: 「信用買い残が減っている＝買い需要が強い」を自動判定
    // しない。株価・出来高と組み合わせて「需給改善」と「単なる低人気」を
    // 分離する（indicators.mjsのbuyingDemandSignal参照。新規リクエスト無し）。
    const buyingDemand = buyingDemandSignal({
      creditTrendPct: creditTrend(weekly, 4), changePct: s.tech.changePct, volRatio: squeezeVolRatio,
    });
    const receivablesAnomaly = receivablesAnomalySignal({
      revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
      receivablesGrowthPct: bs.receivablesGrowthPct ?? null,
      operatingCfGrowthPct: bs.operatingCfGrowthPct ?? null,
      advancesReceivedGrowthPct: bs.advancesReceivedGrowthPct ?? null,
      inventoryGrowthPct: bs.inventoryGrowthPct ?? null,
    });
    // 個人投資家による期待の織り込み（軸E）。「決算が良さそう」だけで
    // 買い判定にせず、その期待が既に株価へ反映済みでないかを見る。
    // ivFresh/weeklyはselling climax/squeeze用に既に取得済みのため、
    // 追加のリクエストは発生しない。
    const retailExpectation = retailExpectationSignal({
      return1w: returnPct(ivFresh?.closes, 5),
      return1m: returnPct(ivFresh?.closes, 20),
      priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
      volRatio: squeezeVolRatio,
      creditTrendPct: creditTrend(weekly, 4),
      creditWeek1Pct: creditTrend(weekly, 1),
      daysToEarnings: s.daysLeft,
    });
    const hiddenGem = hiddenGemSignal({
      consensusProfit: s.consensusProfit, netNet, lowPbr,
      dividendStreakYears: dividendHistory.streakYears, dividendStreakDirection: dividendHistory.streakDirection,
    });
    // カタリスト予兆（ユーザー提案）。「材料が出てから買う」のではなく
    // 「材料が出るしかない財務状況」を先回りして拾う。bs（EDINET）・
    // fin（kabutan決算ページ）とも既に取得済みのデータから計算するため、
    // 追加のリクエストは発生しない。
    const progressStreak = progressStreakSignal(fin.progressHistory);
    const dividendPotential = dividendPotentialSignal({
      retainedEarnings: bs.retainedEarnings, marketCap: main.marketCap, dividendYield: main.dividendYield,
    });
    const hiddenAsset = hiddenAssetSignal({ investmentSecurities: bs.investmentSecurities, marketCap: main.marketCap });
    // 信用買い占有率（ユーザー提案）。weekly/shareholderInfoとも既に
    // squeeze・majorShareholder算出用に取得済みのため追加リクエスト無し。
    const creditFloat = creditFloatSignal({
      creditBuyBalance: weekly[0]?.buy ?? null,
      sharesOutstanding: main.sharesOutstanding ?? null,
      top3PctNow: shareholderInfo.top3PctNow ?? null,
      loanRatio: main.loanRatio ?? null,
    });
    // 第9優先改修 Phase5（ユーザー提案）: Phase1〜4（信用買残の重さ・
    // 4パターン・反発品質・安値更新×買残増加）を1つのcreditSupplyQuality
    // Signalにまとめる。weekly/ivFresh.closes/volumesとも既に取得済みの
    // ため追加リクエスト無し。表示専用でSCORE/buyScoreRiskPenaltyには
    // 一切渡さない（riskPenaltyInputsに含めない）。SUPPLY_CREDITクラスタ
    // へのlevel:'good'時のみの1件加算はclusterConfirmation側で行う。
    const creditSupplyQuality = creditSupplyQualitySignal({
      weekly, closes: ivFresh?.closes, volumes: ivFresh?.volumes,
      price: s.tech.price, loanRatio: main.loanRatio ?? null, today,
    });
    // 第9優先改修 Phase6 ④（ユーザー提案）: 需給タイムライン用の整形。
    // creditSupplyQualitySignalに新しいロジックを足さず、既に計算済みの
    // weekly/creditSupplyQualityをそのまま渡すだけ（新規リクエスト無し・
    // 新しい判定無し）。表示専用でSCOREには一切渡さない。
    const creditSupplyTimelineData = creditSupplyTimeline({ weekly, creditSupplyQuality });
    // 期待値のワナ（過去にWATCHLIST時代の「エントリー健康診断」カードで
    // 使われていたが、SMART ENTRY化の際に呼び出し側だけ削除され関数定義
    // だけがデッドコード化していたのを発掘・復活。s.estimateProfit/
    // s.consensusProfitとも既に取得済みのため追加リクエスト無し。
    const consensusTrap = consensusTrapSignal(s.estimateProfit, s.consensusProfit);
    // 仕込み妙味スコア（Repricing Lag、ユーザー提案）。「割安」と「仕込み
    // どき」を区別するための評価軸。return1m/priceLevelPctはretail
    // Expectationと同じivFresh.closesから算出可能なため再計算のみで追加
    // リクエストは発生しない（return3mも同様）。profitGrowthPctは
    // progressStreakSignal専用だったYoY計算をlatestProfitYoyPctとして
    // 切り出し、streak条件を満たさない銘柄でも計算できるようにした。
    // PSRはkabutan.mjsが今回追加したlatestSales（百万円）とmain.marketCap
    // （百万円）が同じ単位のため、そのまま割るだけで求まる。
    const psr = Number.isFinite(fin.revenueGrowth?.latestSales) && fin.revenueGrowth.latestSales > 0 && Number.isFinite(main.marketCap)
      ? main.marketCap / fin.revenueGrowth.latestSales
      : null;
    const repricingLagInputs = {
      return1m: returnPct(ivFresh?.closes, 20),
      return3m: returnPct(ivFresh?.closes, 60),
      // Repricing Gap v2用。「株価反応」を業種の同期間(直近20営業日)累積
      // 騰落率で相対化するための入力（sector_history.mjsの日次履歴、
      // 30日分保持。履歴が足りない間はnull→repricingGapScore側が単純な
      // return1mにフォールバックする）。
      sectorReturn1m: sectorTrendPct(sectorHistory, main.sectorName, today, 20),
      priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
      revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
      profitGrowthPct: latestProfitYoyPct(fin.progressHistory),
      per: main.per ?? null,
      sectorPer: sec?.per ?? null,
      psr,
      hasCatalyst: ev.positives.length > 0,
      daysToEarnings: s.daysLeft,
      progressStreak, // v7.4改修: 進捗率の連続加速をrepricingLagScoreにも反映する
    };
    // scraper.mjs側のカード描画（テンプレ文ナラティブ生成）が実測値を
    // そのまま埋め込めるよう、スコア/ゾーンだけでなく入力値そのものも
    // repricingLagに同梱する（indicators.mjs側は純粋な計算関数のまま
    // 保ち、表示用の生値保持は呼び出し側の責務にする）。
    const repricingLag = { ...repricingLagScore(repricingLagInputs), ...repricingLagInputs, repricingGap: repricingGapScore(repricingLagInputs) };

    // v7.3改修 項目5: AMBUSH NOWの条件「BUY SCORE 70以上」は、指示書上は
    // 新設したBUY SCORE（100点、buyScore()）を指すが、これまではAMBUSH
    // NOWのゲートに旧SCORE（composite()の素点、月次30+PR30+進捗20+
    // セクター10+テクニカル10=100点）をそのまま使い続けていた（BUY SCOREは
    // scraper.mjs側でこの後段のattachScoresが計算するため、bucket決定
    // 時点ではまだ存在しない）。ここでBUY SCOREの元になる5要素のうち、
    // screener.mjs側で既に計算済みの値（score/repricingLag/consensusTrap/
    // daysLeft/netNet等/sectorChangePct/progressStreak/hasMonthly）だけを
    // 使ってbuyScoreを前倒しで計算し、NOWの判定に使う（scraper.mjs側の
    // attachScoresは表示用に同じ入力から同じ計算をやり直すだけなので、
    // 二重計算にはなるが結果は一致する）。
    // v7.3改修 項目2: BUY SCOREのリスクペナルティ。badChipSignalsが参照する
    // CHIP_SIGNAL_FIELDSのうち、この時点で計算済みのものだけを渡す
    // （results.pushする最終オブジェクトと同じ値。ここではbucket決定用に
    // 前倒しで計算するための最小限の複製）。
    const riskPenaltyInputs = {
      climax, netNet, lowPbr, pbrHistoricalLow, dividendPeak, hiddenGem, divFloor, squeeze,
      institutionalShort, majorShareholder, sectorLag, sectorRotation, marginOverhang,
      receivablesAnomaly, retailExpectation, progressStreak, dividendPotential, hiddenAsset,
      creditFloat, consensusTrap,
    };
    const buyScoreForBucket = buyScore(buildScoreParts({
      score, repricingLag, consensusTrap, daysLeft: s.daysLeft,
      netNet, lowPbr, hiddenGem, pbrHistoricalLow,
      sectorChangePct: sec?.changePct ?? null,
      progressStreak, hasMonthly: ev.hasMonthly,
    }).buy, buyScoreRiskPenalty(riskPenaltyInputs));

    results.push({
      code: s.code,
      name: s.name,
      earningsDate: s.earningsDate,
      earningsDateRaw: s.earningsDateRaw,
      earningsDateStatus: s.earningsDateStatus,
      earningsDateSource: s.earningsDateSource,
      earningsDateRetrievedAt: s.earningsDateRetrievedAt,
      daysLeft: s.daysLeft,
      quarter: s.quarter,
      q1Seasonality: fin.q1Seasonality ?? null,
      estimateProfit: s.estimateProfit,
      consensusProfit: s.consensusProfit,
      price: s.tech.price,
      changePct: s.tech.changePct,
      kairi: s.tech.kairi,
      rsi: s.tech.rsi,
      volZ: s.tech.volZ,
      closes: s.tech.closes?.slice(-20) ?? [],
      market: s.tech.market ?? null,
      sectorName: main.sectorName ?? null,
      sectorChangePct: sec?.changePct ?? null,
      loanRatio: main.loanRatio ?? null,
      per: main.per ?? null,
      progress,
      progressBasis: basis,
      progressLabel: fin.progressLabel ?? null,
      progressSource: 'kabutan',
      catalysts: ev.positives.map((p) => ({ label: p.label, date: p.date, title: p.title, tier: p.tier })),
      catalystTier: ev.tier, // v7.3改修 項目6: S/A/B/C（tdnet.mjs:evaluate参照）
      catalystScore100: ev.score100,
      warnings: ev.negatives.map((p) => ({ label: p.label, date: p.date, title: p.title })),
      ambiguous: ev.ambiguous.length,
      hasMonthly: ev.hasMonthly,
      score,
      // 未取得の軸を0点として数えた場合の参考値（第2優先改修、CASE4対応）。
      // rank/verdictの判定には使わない（scoreの意味自体は変えない）。
      coverageScore,
      rank: rankOf(score, evidence),
      confidence: reportedConfidence(confidence, ev),
      confidenceRaw: confidence, // スコアの分母（= 取得できた配点合計）
      evidence,
      detail,
      dividendYield: main.dividendYield ?? null,
      evEbitda: evEbitdaResult, // v7.3改修 項目10
      // 同業他社比較（提案3番目）用。sectorPer/sectorPbr/sectorDividendYield
      // はfetchSectorMomentumの業種別ページに元々列があった値を流用（追加
      // リクエスト無し）。業種平均ROEはkabutan側に該当ページが無く非対応。
      pbr: main.pbr ?? null,
      marketCap: main.marketCap ?? null,
      roe: fin.latestRoe ?? null,
      sectorPer: sec?.per ?? null,
      sectorPbr: sec?.pbr ?? null,
      sectorDividendYield: sec?.dividendYield ?? null,
      balanceSheetSource: bs.docID ? 'edinet' : null,
      balanceSheetAsOf: bs.periodEnd ?? null,
      climax,
      netNet,
      lowPbr,
      pbrHistoricalLow,
      pbrMin: pbrHistory.minPbr ?? null,
      pbrMinPeriod: pbrHistory.minPeriod ?? null,
      dividendPeak,
      dividendMaxYield: dividendHistory.maxYield ?? null,
      dividendMaxPeriod: dividendHistory.maxPeriod ?? null,
      dividendYenHistory: dividendHistory.yenHistory ?? [],
      dividendStreakYears: dividendHistory.streakYears ?? 0,
      dividendStreakDirection: dividendHistory.streakDirection ?? null,
      hiddenGem,
      divFloor,
      squeeze,
      institutionalShort,
      institutionalShortPct: institutionalShortInfo.totalPct ?? null,
      institutionalShortAsOf: institutionalShortInfo.asOfDate ?? null,
      majorShareholder,
      majorShareholderTop1Pct: shareholderInfo.top1Pct ?? null,
      majorShareholderAsOf: shareholderInfo.asOfPeriod ?? null,
      sectorLag,
      sectorRotation,
      marginOverhang,
      buyingDemand,
      receivablesAnomaly,
      retailExpectation,
      progressStreak,
      dividendPotential,
      hiddenAsset,
      creditFloat,
      creditSupplyQuality,
      creditSupplyTimeline: creditSupplyTimelineData,
      consensusTrap,
      repricingLag,
      buyScore: buyScoreForBucket, // v7.3改修 項目5: NOWのゲートに使う。scraper.mjs側のattachScoresが表示用に再計算して上書きする
      // v7.3改修 項目5: AMBUSHを3段階化（PRE-AMBUSH/WATCH/NOW）。
      // NOW条件の「BUY SCORE 70以上」は指示書上、新設のBUY SCORE
      // （100点）を指す。以前は旧SCORE（composite()の素点）で判定して
      // おり、BUY SCOREが新設された後もNOWのゲートだけ旧SCOREのまま
      // 取り残されていた（実測バグ）。
      bucket:
        s.daysLeft > WINDOW.watchMax
          ? 'PRE'
          : s.daysLeft >= WINDOW.nowMin && s.daysLeft <= WINDOW.nowMax
            ? (s.earningsDateStatus === 'confirmed' && buyScoreForBucket.score !== null && buyScoreForBucket.score >= 70 && evidence ? 'NOW' : 'NEAR')
            : 'WATCH',
    });
  }

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const out = {
    date: today,
    universe: universe.length,
    passed: survivors.length,
    stage1: STAGE1,
    sectors, // SECTION B のスコアリングでも使い回す（再取得しない）
    results,
    logicFingerprint,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ AMBUSH: NOW ${results.filter((r) => r.bucket === 'NOW').length} / WATCH ${results.filter((r) => r.bucket === 'WATCH').length} / 圏外 ${results.filter((r) => r.bucket === 'NEAR').length}（赤字・債務超過除外 ${s2excluded} / 時価総額上限超過除外 ${s2excludedCap} / 上場廃止・大規模希薄化除外 ${s2excludedRisk}）`);
  return out;
}
