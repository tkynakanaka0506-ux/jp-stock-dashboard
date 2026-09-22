// ==================================================================
// indicators.mjs — テクニカル指標
//
//  すべて kabutan の kabuka ページ1枚（直近30営業日の終値・売買高）
//  だけで計算できるものに限定している。外部API依存ゼロ。
//
//  データが足りない場合は 0 や適当な代替値を返さず null を返す。
//  （仕様書§25: N/A を数値に変換しない）
// ==================================================================

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 25日移動平均。25本に満たない場合は本数不足を明示して null を返す。
// （旧版は常に25で割っていたためMAが最大16%過小になり、乖離率が過大に出ていた）
export function ma(closes, period = 25) {
  if (!closes || closes.length < period) return null;
  const w = closes.slice(-period);
  return w.reduce((a, b) => a + b, 0) / period;
}

// 移動平均乖離率(%)
export function kairi(price, closes, period = 25) {
  const m = ma(closes, period);
  if (m === null || !Number.isFinite(price) || m === 0) return null;
  return round1((price / m - 1) * 100);
}

// RSI(14) — Wilder の平滑化。
// 初期14本を単純平均、以降を平滑化していく標準的な実装。
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return ag === 0 ? 50 : 100; // 下落が一度もない期間
  return round1(100 - 100 / (1 + ag / al));
}

// 出来高Zスコア — 直近 period 本（当日を除く）に対する当日の乖離。
// 母集団が動かない（標準偏差0）銘柄は判定不能として null。
export function volumeZScore(volumes, period = 20) {
  if (!volumes || volumes.length < period + 1) return null;
  const hist = volumes.slice(-(period + 1), -1).filter(Number.isFinite);
  const today = volumes.at(-1);
  if (hist.length < period || !Number.isFinite(today)) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  if (sd === 0) return null;
  return round2((today - mean) / sd);
}

// 直近 n 営業日の騰落率(%)（セクターモメンタム用）
export function returnPct(closes, n = 5) {
  if (!closes || closes.length < n + 1) return null;
  const base = closes.at(-(n + 1));
  if (!Number.isFinite(base) || base === 0) return null;
  return round1((closes.at(-1) / base - 1) * 100);
}

// ------------------------------------------------------------------
// Stage 1 判定
//
//  「まだ織り込まれていない」ことの確認であって、良し悪しの判定ではない。
//  仕様書§Stage1: 乖離率 ≤ +5% / RSI ≤ 60 / 出来高Zスコア ≤ 0.5
//
//  指標が null（＝算出不能）の場合は通過させない。
//  未取得を「条件を満たした」と読み替えるのは誤検出の温床になるため。
// ------------------------------------------------------------------
export const STAGE1 = { maxKairi: 5, maxRsi: 60, maxVolZ: 0.5 };

export function stage1(t) {
  const reasons = [];
  if (t.kairi === null) reasons.push('乖離率N/A');
  else if (t.kairi > STAGE1.maxKairi) reasons.push(`乖離${t.kairi}%>+${STAGE1.maxKairi}%`);

  if (t.rsi === null) reasons.push('RSI N/A');
  else if (t.rsi > STAGE1.maxRsi) reasons.push(`RSI${t.rsi}>${STAGE1.maxRsi}`);

  if (t.volZ === null) reasons.push('出来高Z N/A');
  else if (t.volZ > STAGE1.maxVolZ) reasons.push(`VolZ${t.volZ}>${STAGE1.maxVolZ}`);

  return { pass: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------
// テクニカル未織込スコア（10点）
//   仕様書の刻み: 0〜+2%→10 / +2〜3%→8 / +3〜4%→6 / +4〜5%→3 / ≥+5%→0
//   マイナス乖離（＝MAより下）は最も織り込まれていない状態なので満点。
// ------------------------------------------------------------------
export function unpricedScore(k) {
  if (k === null) return null;
  if (k < 2) return 10;
  if (k < 3) return 8;
  if (k < 4) return 6;
  if (k < 5) return 3;
  return 0;
}

// ------------------------------------------------------------------
// （旧）エントリー健康診断 — 大型株WATCHLIST専用の「4つの信号」
//
//  ここにあった valueSignal（お買い得度）・creditSignal（上値の重さ）は
//  SMART ENTRY化（コミットdec2509）で呼び出し側だけ削除され、長期間
//  デッドコード化していたのを発見。復活はさせず削除した — 復活すると
//  現行の overheatSignal（乖離+15%）・marginOverhangSignal（信用倍率
//  10倍）と同じ指標を別の閾値（乖離+10%・信用倍率6倍）で二重に判定する
//  ことになり、同じ銘柄で「過熱」と「過熱でない」のような矛盾した表示が
//  再発しかねない（実測: creditFloatSignalとmarginOverhangSignalの矛盾を
//  同日に修正したばかり）。同じ枠にあったconsensusTrapSignal（期待値の
//  ワナ）だけは他の現行シグナルと重複しない独自の判定だったため、
//  screener.mjsに配線し直して復活させた。
// ------------------------------------------------------------------

export const CONSENSUS_TRAP = { tooHigh: -5, tooLow: 5 };

// コンセンサス（アナリスト予想）が実在するかの判定。consensusProfit===0は
// SBI側の「未算出」を意味し「予想利益0円」ではないため除外する。
//
// ■ なぜ関数として括り出したか
// 同じ式 `Number.isFinite(consensusProfit) && consensusProfit !== 0` が
// indicators.mjs(consensusTrapSignal/hiddenGemSignal)とscraper.mjs
// (bottomChips/buyRuleChecklist/consensusEvidenceBlock)の計5箇所に
// 独立にコピーされていた。「コンセンサス有り」の定義を変える（例:
// 0を有効値として扱うようにする）場合、5箇所すべてを見つけて直さないと
// 判定がズレる危険な状態だったため、単一の情報源に統一した。
export function hasConsensusProfit(consensusProfit) {
  return Number.isFinite(consensusProfit) && consensusProfit !== 0;
}

// 期待値のワナ — 会社予想 vs 市場コンセンサス
//
// ■ 発掘の経緯（再発防止の一環）
// この関数はWATCHLIST時代（エントリー健康診断カード）で実際に使われて
// いたが、SMART ENTRY への置き換え（コミットdec2509）で呼び出し側だけ
// 削除され、関数定義だけが取り残されて長期間デッドコード化していた。
// 「会社予想がコンセンサス比-5%以下＝期待過剰（上方修正しても届かず
// 暴落する危険地帯）」「+5%以上＝期待薄（跳ねる可能性）」という判定は
// buyRuleChecklistの「期待値」行（|diff|<=10%かどうかの対称なOK/NG）
// では代替できない非対称な判断で、AMBUSHの加点/減点にも一切使われて
// いなかった。CHIP_SIGNAL_FIELDS/AMBUSH_BONUS・PENALTY_FIELDSに配線し
// 直す（screener.mjs）。
export function consensusTrapSignal(estimateProfit, consensusProfit) {
  if (!Number.isFinite(estimateProfit) || !Number.isFinite(consensusProfit) || consensusProfit === 0) {
    // 会社予想とコンセンサスは欠ける原因が別（前者はSBI決算カレンダー側の
    // 未収録、後者はアナリスト非カバー）なので、どちらが実際に欠けている
    // かで文言を分ける。両方欠けている場合のみ「コンセンサスN/A」と言うと、
    // コンセンサスはあるのに会社予想が無いだけの銘柄まで誤って「コンセン
    // サスが無い」と伝えてしまう。「会社が通期予想を非開示」と断定する
    // のも誤り（実測: 7921はkabutanの決算ページには来期予想の数値が
    // 載っているのに、SBI側のカレンダーには収録されていなかった）ため、
    // 原因を決めつけず「このデータソースには無い」という事実だけを伝える。
    const hasEstimate = Number.isFinite(estimateProfit);
    const hasConsensus = hasConsensusProfit(consensusProfit);
    const note = !hasEstimate && hasConsensus ? '会社予想N/A（決算カレンダーに未収録）'
      : hasEstimate && !hasConsensus ? 'コンセンサスN/A'
      : '会社予想・コンセンサス共にN/A';
    return { level: null, label: 'N/A', note, checked: false };
  }
  const diffPct = Math.round(((estimateProfit - consensusProfit) / Math.abs(consensusProfit)) * 1000) / 10;
  if (diffPct <= CONSENSUS_TRAP.tooHigh) {
    return { level: 'bad', label: '期待過剰', checked: true, note: `会社予想がコンセンサス比${diffPct}%・上方修正しても予想に届かず暴落する危険地帯` };
  }
  if (diffPct >= CONSENSUS_TRAP.tooLow) {
    return { level: 'good', label: '期待薄', checked: true, note: `会社予想がコンセンサス比+${diffPct}%・ちょっと良い数字が出るだけで跳ねる可能性` };
  }
  return { level: 'warn', label: '中立', checked: true, note: `コンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%` };
}

// ------------------------------------------------------------------
// スマート・エントリー — 「仕込みパターン」3種
//
//  仕様（新提案）: 決算スケジュールは見ず、需給と乖離だけで機械的に判定する。
//  各パターンは3条件のANDで、1つでもN/A（算出不能）なら「該当」とは言えない
//  ので good にはしない（仕様書§25と同じ考え方: 未取得を満たしたと読み替えない）。
// ------------------------------------------------------------------

// 信用買い残の増減トレンド — 直近週 vs lookback週前 の変化率(%)
// weekly は fetchWeeklyCredit() の戻り値（新しい週が先頭）。
export function creditTrend(weekly, lookback = 4) {
  if (!weekly || weekly.length <= lookback) return null;
  const latest = weekly[0]?.buy, past = weekly[lookback]?.buy;
  if (!Number.isFinite(latest) || !Number.isFinite(past) || past === 0) return null;
  return round1(((latest - past) / past) * 100);
}

// 信用売り残（空売り）の増減トレンド — creditTrend と同じ考え方で sell 列を見る。
export function shortTrend(weekly, lookback = 4) {
  if (!weekly || weekly.length <= lookback) return null;
  const latest = weekly[0]?.sell, past = weekly[lookback]?.sell;
  if (!Number.isFinite(latest) || !Number.isFinite(past) || past === 0) return null;
  return round1(((latest - past) / past) * 100);
}

// 直近 period 週（既定13週≒3ヶ月）レンジの中で今どの位置か（0%=最低水準・100%=最高水準）
export function creditLevelVsRange(weekly, period = 13) {
  const w = (weekly ?? []).slice(0, period).map((r) => r.buy).filter(Number.isFinite);
  if (w.length < period) return null;
  const latest = w[0], min = Math.min(...w), max = Math.max(...w);
  if (max === min) return 0;
  return round1(((latest - min) / (max - min)) * 100);
}

// 直近 period 営業日（既定60日≒3ヶ月）の終値レンジの中で今の株価がどの
// 位置か（0%=期間最安値・100%=期間最高値）。creditLevelVsRangeと同じ
// 考え方だが、closesは古い→新しい順（weeklyは新しい→古い順）と並びが
// 逆なので取り出し方が異なる点に注意。retailExpectationSignalの
// 「既に高値圏か」の判定に使う。
export function priceLevelVsRange(closes, period = 60) {
  const w = (closes ?? []).slice(-period).filter(Number.isFinite);
  if (w.length < period) return null;
  const latest = w.at(-1), min = Math.min(...w), max = Math.max(...w);
  if (max === min) return 0;
  return round1(((latest - min) / (max - min)) * 100);
}

// ゴールデンクロス — 直近 lookback 営業日以内にMA5がMA25を下から上に抜けたか
export function goldenCross(closes, lookback = 3) {
  if (!closes || closes.length < 26) return null;
  const maAt = (period, endIdx) => {
    if (endIdx < period) return null;
    const w = closes.slice(endIdx - period, endIdx);
    return w.reduce((a, b) => a + b, 0) / period;
  };
  for (let back = 0; back < lookback; back++) {
    const idx = closes.length - back, prevIdx = idx - 1;
    if (prevIdx < 25) break;
    const m5 = maAt(5, idx), m25 = maAt(25, idx), pm5 = maAt(5, prevIdx), pm25 = maAt(25, prevIdx);
    if ([m5, m25, pm5, pm25].some((v) => v === null)) continue;
    if (pm5 <= pm25 && m5 > m25) return { crossed: true, daysAgo: back };
  }
  return { crossed: false };
}

// 出来高倍率 — 当日 / 直近period日平均（当日を除く）
export function volumeRatio(volumes, period = 20) {
  if (!volumes || volumes.length < period + 1) return null;
  const hist = volumes.slice(-(period + 1), -1).filter(Number.isFinite);
  const today = volumes.at(-1);
  if (hist.length < period || !Number.isFinite(today)) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  if (mean === 0) return null;
  return round2(today / mean);
}

const condText = (label, value, unit, ok) =>
  `${label}${value === null || value === undefined ? 'N/A' : `${value}${unit}`}${ok === null ? '' : ok ? '○' : '×'}`;

// 3条件すべて既知かつ真のときだけ「該当」。それ以外は根拠の内訳をそのまま見せる。
// データが1つでも欠けると「N/A」の一言で片付けていたが、それだと
// 「3条件中2つは条件クリア・1つだけ未取得」という有力な状態と
// 「3条件とも丸ごと不明」という無情報の状態が同じ表記になってしまい、
// 実際には根拠がある銘柄が「情報なし」に見えてしまう問題があった
// （実測: 7061のパターン③は信用残水準○・乖離○で条件クリア、
// コンセンサスだけ未取得なのに「N/A」表記だった）。
// 分かっている条件が全てクリアなら「一部該当」として区別し、
// それでも matched（該当パターン数）には数えない（推測で加点はしない）。
function composePattern(conds, matchedNote) {
  const note = conds.map((c) => c.text).join(' / ');
  const known = conds.filter((c) => c.ok !== null);
  if (conds.every((c) => c.ok === true)) return { level: 'good', label: '該当', note: matchedNote };
  // 既知の条件のうち1つでも明確に「不一致」なら、残りの条件が未取得でも
  // 「該当しない」と確定できる（AND条件なので1つでも満たさなければ
  // 他がどうであれ該当し得ない）。これを見ずに「未知が1つでもあれば
  // 一律N/A」としていたため、実際には根拠があるのに「総不明」と誤表示
  // していた（実測: 9052山陽電鉄のパターン③は信用残水準100%で明確に
  // 条件を満たさないのに、コンセンサス差が未取得というだけで「N/A」
  // 表示になっていた）。
  //
  // 「非該当」（既知の条件だけで確定的に不一致と判定できた）と「N/A」
  // （何一つ判定材料が無い）は、どちらもlevel:nullにしていたため
  // scraper.mjsのsignalRow（🟢🟡🔴⚪の信号表示）ではどちらも同じ⚪灰色
  // になり、「確定的に該当しない」という積極的な結論と「何も分からない」
  // という無情報が視覚的に区別できていなかった（実測: ユーザーから
  // 「信号の赤色が機能していない」との指摘。SIG_EMOJI/SIG_CLASSに
  // bad:'🔴'/'red'の定義はあったが、composePatternが'bad'を一切返さない
  // ため到達不能なデッドコードになっていた）。「非該当」を専用の
  // level:'none'にし、signalRow側で🔴（確定的に非該当＝見送り）として
  // 扱う。matched集計（level==='good'のみ数える）には影響しない。
  if (known.some((c) => c.ok === false)) return { level: 'none', label: '非該当', note };
  if (known.length > 0) return { level: 'partial', label: '一部該当（データ不足）', note };
  return { level: null, label: 'N/A', note };
}

// パターン① リバウンド狙い（逆張り）— 乖離-10%以下 / RSI30以下 / 信用買い残減少
export const PATTERN1 = { maxKairi: -10, maxRsi: 30 };
export function reboundPatternSignal({ kairi, rsi, creditTrendPct }) {
  const c1 = kairi === null ? null : kairi <= PATTERN1.maxKairi;
  const c2 = rsi === null ? null : rsi <= PATTERN1.maxRsi;
  const c3 = creditTrendPct === null ? null : creditTrendPct < 0;
  return composePattern(
    [
      { ok: c1, text: condText('乖離', kairi, '%', c1) },
      { ok: c2, text: condText('RSI', rsi, '', c2) },
      { ok: c3, text: condText('信用残4週比', creditTrendPct, '%', c3) },
    ],
    '売られすぎの極致。リバウンドの初動を狙える位置です'
  );
}

// パターン② トレンド転換の初動（順張り）— ゴールデンクロス / 出来高1.5倍以上 / 信用倍率が低い
export const PATTERN2 = { minVolRatio: 1.5, maxLoanRatio: 3 };
export function trendReversalPatternSignal({ cross, volRatio, loanRatio }) {
  const c1 = !cross ? null : cross.crossed;
  const c2 = volRatio === null ? null : volRatio >= PATTERN2.minVolRatio;
  const c3 = loanRatio === null || loanRatio === undefined ? null : loanRatio < PATTERN2.maxLoanRatio;
  return composePattern(
    [
      { ok: c1, text: `GC${c1 === null ? 'N/A' : c1 ? `○(${cross.daysAgo}日前)` : '×'}` },
      { ok: c2, text: condText('出来高倍率', volRatio, '倍', c2) },
      { ok: c3, text: condText('信用倍率', loanRatio, '倍', c3) },
    ],
    'トレンド転換。大きな上昇トレンドの入り口かもしれません'
  );
}

// パターン③ しこり解消・出遅れ株 — 信用残が3ヶ月レンジの下位20%以内 / コンセンサスが会社予想より高い / 株価未反応
export const PATTERN3 = { lowLevelMaxPct: 20, consensusGapMax: -5, maxKairi: 5 };
export function laggingPatternSignal({ creditLevelPct, estimateProfit, consensusProfit, kairi }) {
  const c1 = creditLevelPct === null ? null : creditLevelPct <= PATTERN3.lowLevelMaxPct;
  let diffPct = null;
  if (Number.isFinite(estimateProfit) && Number.isFinite(consensusProfit) && consensusProfit !== 0) {
    diffPct = round1(((estimateProfit - consensusProfit) / Math.abs(consensusProfit)) * 100);
  }
  const c2 = diffPct === null ? null : diffPct <= PATTERN3.consensusGapMax;
  const c3 = kairi === null ? null : kairi < PATTERN3.maxKairi;
  return composePattern(
    [
      { ok: c1, text: condText('信用残水準', creditLevelPct, '%', c1) },
      { ok: c2, text: condText('コンセンサス差', diffPct, '%', c2) },
      { ok: c3, text: condText('乖離', kairi, '%', c3) },
    ],
    '需給はスカスカ。火がつければ一気に飛ぶ準備ができています'
  );
}

export const SECTOR_MOMENTUM = { hot: 1.5, hotGap: -0.5, laggingSector: 0.5, laggingGap: -1 };

// セクターの勢い — 当日騰落率 vs 業種当日騰落率
export function sectorMomentumSignal(changePct, sectorChangePct) {
  if (sectorChangePct === null || sectorChangePct === undefined) return { level: null, label: 'N/A', note: '業種騰落N/A' };
  if (!Number.isFinite(changePct)) return { level: null, label: 'N/A', note: '騰落率N/A' };
  const gap = round1(changePct - sectorChangePct);
  if (sectorChangePct > SECTOR_MOMENTUM.hot && gap > SECTOR_MOMENTUM.hotGap) {
    return { level: 'bad', label: '連れ高', note: `業種+${sectorChangePct}%・業種全体が上がりきっている` };
  }
  if (sectorChangePct > SECTOR_MOMENTUM.laggingSector && gap <= SECTOR_MOMENTUM.laggingGap) {
    return { level: 'good', label: '出遅れ', note: `業種+${sectorChangePct}%に対し銘柄${gap > 0 ? '+' : ''}${gap}pt・この銘柄だけ置いていかれている（狙い目）` };
  }
  return { level: 'warn', label: '中立', note: `業種${sectorChangePct > 0 ? '+' : ''}${sectorChangePct}%` };
}

// ==================================================================
// 全セクション共通の除外フィルター（ゴミ箱排除）
//
//  「表示してから警告する」のではなく「候補にすら上げない」。
//  ここで弾かれた銘柄はAMBUSH/SMART ENTRYどちらにも一切表示しない。
//  2段階に分けているのは、株価・流動性はkabukaページ1枚（Stage1で
//  既に取得済み）で判定でき追加コストが無いのに対し、赤字・債務超過は
//  決算ページの取得が要る（Stage2の候補にしか回さない）ため。
// ==================================================================
export const EXCLUDE = {
  minPrice: 300,                  // 倒産リスク・仕手性の高い低位株を除外
  minLiquidityYen: 100_000_000,   // 直近5日平均売買代金。買えても売れない銘柄を除外
  liquidityDays: 5,
};

// Stage1（kabukaページのみ）で判定できる除外条件
export function cheapExclusion({ price, closes, volumes }) {
  const reasons = [];
  if (price === null || price === undefined) reasons.push('株価N/A');
  else if (price < EXCLUDE.minPrice) reasons.push(`株価${price}円 < ${EXCLUDE.minPrice}円`);

  const n = EXCLUDE.liquidityDays;
  if (!closes || !volumes || closes.length < n || volumes.length < n) {
    reasons.push('流動性N/A');
  } else {
    const recentCloses = closes.slice(-n), recentVols = volumes.slice(-n);
    const avgYen = recentCloses.reduce((sum, c, i) => sum + c * (recentVols[i] ?? 0), 0) / n;
    if (avgYen < EXCLUDE.minLiquidityYen) {
      reasons.push(`5日平均売買代金${Math.round(avgYen / 1e4).toLocaleString()}万円 < ${EXCLUDE.minLiquidityYen / 1e8}億円`);
    }
  }
  return { excluded: reasons.length > 0, reasons };
}

// Stage2（決算ページ取得後）で判定する除外条件 — 赤字・債務超過
// latestOpProfit/equityRatioはkabutan.mjsのfetchFinance()が返す単位（百万円/%）のまま。
export function fundamentalExclusion({ latestOpProfit, equityRatio }) {
  const reasons = [];
  if (latestOpProfit !== null && latestOpProfit !== undefined && latestOpProfit < 0) {
    reasons.push(`直近営業損益が赤字(${latestOpProfit.toLocaleString()}百万円)`);
  }
  if (equityRatio !== null && equityRatio !== undefined && equityRatio <= 0) {
    reasons.push(`債務超過の疑い(自己資本比率${equityRatio}%)`);
  }
  return { excluded: reasons.length > 0, reasons };
}

// AMBUSH向けの時価総額上限（ユーザー提案: 良品計画・しまむらのような
// 大型株が「決算前の待ち伏せ」候補として上位に出てくるのはノイズという
// 指摘への対応）。テンバガー候補（tenbaggerSignal/midCapGrowthSignal）
// とは別の判定軸であり、AMBUSH自体の逆張り・決算前待ち伏せロジックは
// 変更しない。marketCap/maxMarketCapは呼び出し側の単位（JP:百万円/
// US:百万USD）のまま渡せば良い（通貨非依存）。
export function marketCapExclusion({ marketCap, maxMarketCap }) {
  const reasons = [];
  if (Number.isFinite(marketCap) && Number.isFinite(maxMarketCap) && marketCap > maxMarketCap) {
    reasons.push(`時価総額${Math.round(marketCap).toLocaleString()} > 上限${maxMarketCap.toLocaleString()}`);
  }
  return { excluded: reasons.length > 0, reasons };
}

// ------------------------------------------------------------------
// ハメ込み防止バッジ — 25日線乖離率+15%超は「一切表示しない」ではなく
// 「赤信号を出した上で表示する」。除外ではなく警告。
// ------------------------------------------------------------------
export const OVERHEAT_KAIRI = 15;

export function overheatSignal(kairi) {
  if (kairi === null || kairi === undefined) return { level: null, label: null, note: null };
  if (kairi > OVERHEAT_KAIRI) {
    return { level: 'bad', label: '過熱', note: `乖離+${kairi}%・超割高。今買うのは高値掴みの危険あり` };
  }
  return { level: null, label: null, note: null };
}

// グロース市場の急騰銘柄 — 時価総額の履歴は保有していないため、
// 直近30営業日の終値騰落率で代用する（発行株数が急変しなければ近似できる）。
export const GROWTH_MARKET = '東証Ｇ';
export const GROWTH_SURGE_PCT = 50;

export function growthSurgeSignal(market, closes) {
  if (market !== GROWTH_MARKET || !closes || closes.length < 20) return { level: null, label: null, note: null };
  const base = closes[0];
  if (!Number.isFinite(base) || base === 0) return { level: null, label: null, note: null };
  const pct = round1((closes.at(-1) / base - 1) * 100);
  if (pct >= GROWTH_SURGE_PCT) {
    return { level: 'bad', label: '急騰グロース', note: `直近1ヶ月+${pct}%・上がってもすぐ利確売りに押される重い株` };
  }
  return { level: null, label: null, note: null };
}

// ------------------------------------------------------------------
// 市場区分の日本語表記
// ------------------------------------------------------------------
export const MARKET_LABEL = { '東証Ｐ': 'プライム', '東証Ｓ': 'スタンダード', '東証Ｇ': 'グロース' };
export const marketLabel = (m) => MARKET_LABEL[m] ?? m ?? '市場N/A';

// ------------------------------------------------------------------
// 初心者向け：指標の平易な日本語訳
// ------------------------------------------------------------------
export function describeRsi(v) {
  if (v === null || v === undefined) return 'N/A';
  if (v <= 30) return '売られすぎ（底値圏）';
  if (v >= 70) return '買われすぎ（高値圏）';
  return '中立';
}

export function describeKairi(k) {
  if (k === null || k === undefined) return 'N/A';
  if (k <= -10) return '売られすぎ';
  if (k > OVERHEAT_KAIRI) return '超割高';
  if (k > 5) return 'やや割高';
  if (k < 0) return '割安';
  return '中立';
}

export function describeCross(cross) {
  if (!cross) return 'N/A';
  return cross.crossed ? '上昇トレンド開始' : '転換シグナルなし';
}

// ------------------------------------------------------------------
// ステータスランプ — 買い推奨/様子見/見送りの一言結論
// ------------------------------------------------------------------

// AMBUSH: スコアランクを軸に、過熱（ハメ込み）を最優先で見送りに落とす
//
//  ランクは日次スキャン時点のStage1（未織込）判定を前提に付いているが、
//  場中の価格再取得はランクを再計算しない。値動きが進んでStage1基準
//  （乖離≤+5%・RSI≤60・出来高Z≤0.5）を後から超えた銘柄まで「買い推奨」と
//  表示すると、期待値が織り込まれた株を仕込み時と誤認させてしまうため、
//  過熱ゲートと同様にここで先に弾く。
// ステータスランプの「悪化させる方向にしか働かない」重み付け。
// 以前は赤旗チェックを先に判定して即returnしていたため、ベースの結論が
// 既に「見送り」（rank D等）の銘柄でも、赤旗（信用過多等）が1つ見つかった
// 時点で「様子見」（見送りより甘い）に上書きされてしまうバグがあった
// （実測: 3038/3415がrank Dで本来「見送り」のところ、marginOverhangの
// 早期returnにより「様子見」表示になっていた）。ベース判定→赤旗は
// 「より悪い方向にだけ」動かす、の2段階に直して再発を防ぐ。
// v7.3改修（ユーザー指示書 項目12）: 「買い推奨」という断定的な3段階
// （買い推奨/様子見/見送り）を廃止し、5段階に拡張する。strong_buyは
// Phase 1-B（buyScore導入後）まではambushVerdict/smartEntryVerdictから
// 実際に返されることは無いが、severityの並び自体は先に用意しておく。
// priced_in_caution（🟠織り込み警戒）は「見送り」ほど重くない、
// 「期待が既に株価に織り込まれつつある」ことに特化した中間段階
// （既存のrepricingLag priced_in判定・決算間近の判定をここに再マップ）。
// scraper.mjs側のソート（byVerdict/VERDICT_ORDER）でも同じ重大度順序を
// 使うため export する（以前は3段階の頃からscraper.mjs側に別コピーが
// 2箇所あり、5段階化で更新を1箇所忘れるとNaN比較でソートが壊れる
// リスクがあった。単一の情報源に統一する）。
export const VERDICT_SEVERITY = { strong_buy: 0, buy: 1, hold: 2, priced_in_caution: 3, avoid: 4 };
const VERDICT_LABEL = {
  strong_buy: '🔥 強い買い候補', buy: '🟢 買い候補', hold: '🟡 様子見',
  priced_in_caution: '🟠 織り込み警戒', avoid: '🔴 見送り',
};
// screener.mjs/us_screener.mjsのWINDOW.sweetMin/US_WINDOW.sweetMinと同じ値
// （14日）。indicators.mjsはscreener.mjsからimportされる側のため、循環
// importを避けてここに複製する（WINDOW定数自体を変えたらここも合わせる）。
const NEAR_EARNINGS_MIN_DAYS = 14;

// v7.3改修: labelをVERDICT_LABELから自動的に引くようにし（呼び出し側で
// 手書きの文字列を渡さない）、level/labelの綴りが食い違うリスクを消す
// （単一の情報源パターン。今回5段階に増やすタイミングで統一した）。
function worsen(current, candidateLevel, candidateReason) {
  if (VERDICT_SEVERITY[candidateLevel] <= VERDICT_SEVERITY[current.level]) return current;
  return { level: candidateLevel, label: VERDICT_LABEL[candidateLevel], reason: candidateReason };
}

// ------------------------------------------------------------------
// 「底打ち確認」チップとして画面に出す全シグナルの一覧（単一の情報源）。
//
// ■ 再発防止の経緯
// growthSurgeSignal・上場廃止(スクイーズアウト)は、カード側で赤チップと
// して表示されているのに、verdict計算（ambushVerdict）側にその判定を
// 追加し忘れており、「赤チップが出ているのに買い推奨」という矛盾が
// 2回実際に発生した（このセッションで発見・修正済み）。原因は「表示する
// シグナルの一覧」と「verdictを悪化させるシグナルの一覧」が別々の場所に
// 手書きで重複していたこと。ここに列挙した r のフィールド名は
// scraper.mjsのbottomChips()（チップ表示）とambushVerdict/
// smartEntryVerdict（verdict計算）の両方から参照する単一の情報源にし、
// 新しいシグナルを追加するときはここに1行足すだけで両方に自動的に
// 反映されるようにする。
//
// ※ overheat（乖離+15%超）・growthSurge（急騰グロース）・上場廃止
// （r.warningsの内容チェック）は、r[key].levelの単純な参照ではなく
// 追加の計算や別データ（kairi/market/closes/warnings）を要するため、
// このリストには含めず、ambushVerdict/smartEntryVerdict内で個別に
// 判定している。この3つを増やす・変えるときは、そのすぐ下のコメントに
// 「チップ表示側と対応させること」という注意書きがあるので、必ず両方を
// 同時に直すこと。
export const CHIP_SIGNAL_FIELDS = [
  'climax', 'netNet', 'lowPbr', 'pbrHistoricalLow', 'dividendPeak', 'hiddenGem', 'divFloor', 'squeeze',
  'institutionalShort', 'majorShareholder', 'sectorLag', 'sectorRotation', 'marginOverhang', 'earningsWarning',
  'receivablesAnomaly', 'retailExpectation', 'progressStreak', 'dividendPotential', 'hiddenAsset', 'creditFloat',
  'consensusTrap',
];

// コンセンサス（アナリスト予想）が無い銘柄のカードでは、「未来の期待値」
// ではなく「過去の事実」に基づくチップ（解散価値・PBR・配当・お宝候補）を
// 優先して先頭に並べる（scraper.mjsのbottomChipsが参照する）。
export const VALUATION_CHIP_FIELDS = ['hiddenGem', 'netNet', 'lowPbr', 'pbrHistoricalLow', 'dividendPeak'];

// CHIP_SIGNAL_FIELDS のうち、実際に level:'bad' が付いているものだけを返す。
export function badChipSignals(r) {
  return CHIP_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s && s.level === 'bad');
}

// bad級のリスクシグナル該当件数からLOW/MED/HIGH/UNKNOWNの4段階に丸める。
// scraper.mjs(scoreTrioのRISKバッジ)とpolicy_catalyst_backtest.mjs
// (検証ログのrisk項目)の両方から同じ定義を参照する単一の情報源。
//
// ■ 実測バグ（2026-09-22、ユーザー報告）の再発防止
// CHIP_SIGNAL_FIELDS（21種類のリスク系シグナル）が1つも`checked:true`に
// なっていない銘柄（＝リスクを評価できる材料が実質ゼロ）でも、
// badChipSignals()が単に空配列を返すため、旧実装は無条件に'LOW'（リスク
// 低い）と判定していた。「bad級のシグナルが0件」と「そもそも判定材料が
// 0件」は全く別の状態であり、後者を'LOW'と呼ぶと「検知できるリスクが
// 少なかっただけ」を「リスクが低い」と誤読させる（confidenceTierの
// UNKNOWN=confidenceRaw===0と同じ考え方）。判定材料が1件もチェックできて
// いない場合だけ'UNKNOWN'にする（実データでは滅多に起きない極端な
// ケースのため、通常の銘柄でのLOW/MED/HIGHの分布は変えない）。
export function riskLevel(r) {
  const checked = CHIP_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s?.checked === true).length;
  if (checked === 0) return 'UNKNOWN';
  const n = badChipSignals(r).length;
  return n === 0 ? 'LOW' : n === 1 ? 'MED' : 'HIGH';
}

// riskLevel()の判定に実際何件のシグナルが評価できたか（分母固定・
// 欠損を隠さない）。scraper.mjs側でRISK LOW/MED/HIGHのチップに
// 「n/21件で判定」という根拠を添えるための補助情報（CASE6対応:
// LOWが「確認して問題なかった」のか「ほとんど確認できていない」のかを
// 区別できるようにする）。
export function riskCoverage(r) {
  const total = CHIP_SIGNAL_FIELDS.length;
  const checked = CHIP_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s?.checked === true).length;
  return { checked, total };
}

// retailExpectationがwarn段階のとき、結論の理由に必ず一言補足する
// （ambushVerdict/smartEntryVerdictの両方から使う単一の情報源。以前は
// 同じ文言を2箇所に個別に書いており、将来どちらか一方だけ文言を直して
// 食い違う抜けが起きうる状態だった）。呼び出し側でworsen()呼び出しが
// 全て終わった最後に呼ぶことで、途中のworsen()による上書きで消えない
// ようにする。
function appendRetailExpectationCaution(v, r) {
  if (r.retailExpectation?.level !== 'warn') return v;
  return { ...v, reason: `${v.reason}。${r.retailExpectation.label}：株価や信用買い残の動きから、好材料への期待の一部が既に株価に織り込まれつつある可能性があります` };
}

// A指示 項目42「『買い推奨』判定に最低条件を設ける」: 仕込み優先度や
// ランクが高くても、以下を満たさなければ買い推奨にしない
// （ambushVerdict/smartEntryVerdictの両方から使う単一の情報源）。
//   (1) 重大な財務悪化がない → 既存のbadChipSignalsループで対応済み
//       （bad級シグナルが1件でもあれば既にholdまで落ちている）。
//   (2) 業績が大幅悪化していない → 新規。売上高・利益成長率のどちらかが
//       deepDeclinePct以下なら買い推奨の最低条件を満たさない。
//   (3) 株価が極端な高値圏ではない → 既存のkairi過熱判定/repricingLag.
//       zone==='priced_in'判定で対応済み。
//   (4) 未織り込み要素が存在する → 新規。repricingLagが確定的に判定済み
//       （checked:true）なのにzoneがpre_move/early_moveのいずれでもなければ、
//       「未織り込み要素は無い」と確定できる。データが無い（checked:false）
//       場合は判定不能のため悪材料扱いしない（推測しない）。
//   (5) DATAが最低限確保されている → 新規。buyScore.confidence===0
//       （CONFIDENCE UNKNOWN、A指示項目24）なら判断材料が無いまま
//       買い推奨にしない。
export const MINIMUM_BUY_GATE = { deepDeclinePct: -20 };

function applyMinimumBuyGate(v, r) {
  // 実測バグ（未スキャン領域の横断監査で発覚）: JP AMBUSH/SMART ENTRY
  // （screener.mjs/smart_entry.mjs）はrevenueGrowthPct/profitGrowthPctを
  // 結果オブジェクトのトップレベルに持つが、US AMBUSH（us_screener.mjs）
  // はこれらを一切トップレベルに持たず、earningsTrend（usEarningsTrend
  // Signal）経由でしか成長率を持たない。にもかかわらずearningsTrendの
  // フォールバックはnetIncomeGrowthPct（利益）にしか付いておらず、
  // revenueGrowthPct（売上）側の対応漏れがあった。そのため米国株は
  // 「純利益はYoY比較不能（null）だが売上高が-25%等と大幅減収」という
  // 現実にあり得るケースで、この最低条件ゲートが一切発動しなかった
  // （実測確認済み）。
  const deepDecline = (Number.isFinite(r.revenueGrowthPct) && r.revenueGrowthPct <= MINIMUM_BUY_GATE.deepDeclinePct)
    || (Number.isFinite(r.profitGrowthPct) && r.profitGrowthPct <= MINIMUM_BUY_GATE.deepDeclinePct)
    || (Number.isFinite(r.earningsTrend?.revenueGrowthPct) && r.earningsTrend.revenueGrowthPct <= MINIMUM_BUY_GATE.deepDeclinePct)
    || (Number.isFinite(r.earningsTrend?.netIncomeGrowthPct) && r.earningsTrend.netIncomeGrowthPct <= MINIMUM_BUY_GATE.deepDeclinePct);
  if (deepDecline) {
    v = worsen(v, 'hold', `売上高または利益成長率が${MINIMUM_BUY_GATE.deepDeclinePct}%以下と大幅に悪化しており、買い推奨の最低条件（業績が大幅悪化していないこと）を満たしません`);
  }
  if (r.repricingLag?.checked && r.repricingLag.zone !== 'pre_move' && r.repricingLag.zone !== 'early_move') {
    v = worsen(v, 'hold', '未織り込み要素（仕込みゾーンが初動前・初動のいずれか）が確認できないため、買い推奨の最低条件を満たしません');
  }
  if (r.buyScore?.confidence === 0) {
    v = worsen(v, 'hold', 'BUY SCOREの算出に使えるデータが確認できず（CONFIDENCE UNKNOWN）、買い推奨の最低条件（DATAが最低限確保されていること）を満たしません');
  }
  return v;
}

export function ambushVerdict(r) {
  // 1. ベース判定（ランク・根拠のみ。赤旗はまだ見ない）
  let v;
  if (r.rank === 'S' || r.rank === 'A') {
    const top = r.catalysts?.[0]?.label;
    v = {
      level: 'buy', label: VERDICT_LABEL.buy,
      reason: top ? `${top}という好材料があり、決算に向けて上昇余地があると判断しました` : 'テクニカル・需給ともに良好で、決算に向けて上昇余地があると判断しました',
    };
  } else if (r.rank === 'B' || r.rank === 'C') {
    v = { level: 'hold', label: VERDICT_LABEL.hold, reason: '好材料はあるものの根拠がやや弱く、様子見が無難です' };
  } else {
    v = {
      level: 'avoid', label: VERDICT_LABEL.avoid,
      reason: r.evidence === false ? '先行カタリストが見当たらず、根拠不足のため見送り推奨です' : 'スコアが低く、積極的に狙う理由が乏しいです',
    };
  }

  // 2. 赤旗は「より悪い方向にだけ」ベースを上書きする。
  if (r.kairi !== null && r.kairi !== undefined && r.kairi > OVERHEAT_KAIRI) {
    v = worsen(v, 'avoid', `乖離+${r.kairi}%は過熱圏。高値掴みのリスクが高いため見送り推奨です`);
  }
  const pricedIn = r.kairi !== null && r.rsi !== null && r.volZ !== null
    && r.kairi !== undefined && r.rsi !== undefined && r.volZ !== undefined
    && !stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass;
  if (pricedIn) {
    v = worsen(v, 'priced_in_caution', `乖離${r.kairi}%・RSI${r.rsi}まで値動きが進み、未織込の基準を超えました。期待値が既に織り込まれつつあります`);
  }
  // 「連れ高」（業種全体が上がりきっている）・信用過多・売掛金の異常増加
  // など、bottomChips()に出る赤チップ全てを一括で見る（CHIP_SIGNAL_FIELDS
  // 参照）。新しいシグナルをbottomChipsに追加すれば、ここにも手を加える
  // ことなく自動的に反映される（配線忘れの再発防止）。
  for (const s of badChipSignals(r)) {
    v = worsen(v, 'hold', s.note);
  }
  // 急騰グロース（グロース市場で直近1ヶ月+50%）は card() で赤チップとして
  // 出しているのに、以前はここで見ておらず「買い推奨」のまま矛盾しうる
  // 状態だった（SMART ENTRY側は元々見ていたのにAMBUSH側だけ抜けていた）。
  // ※ この判定はCHIP_SIGNAL_FIELDSに含まれていない（r.market/r.closesから
  // 計算する必要があるため）。チップ表示側（card()）を変えるときはここも
  // 必ず対応させること。
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  if (growthSurge.level === 'bad') v = worsen(v, 'hold', growthSurge.note);

  // スクイーズアウトによる上場廃止決定は「決算カタリストで株価が動く」
  // というAMBUSHの前提そのものを壊す（株価は買収価格に固定され、以後
  // 決算に反応しなくなる）。ランクがどれだけ高くても必ず見送りにする
  // （実測: 3480ジェイ・エス・ビーはランクCで様子見のまま表示されて
  // いたが、2026-08-10にスクイーズアウト決定が開示されていた）。
  // ※ この判定もCHIP_SIGNAL_FIELDSに含まれていない（r.warningsの中身を
  // 検索する必要があるため）。warnChips（scraper.mjs）の表示条件を
  // 変えるときはここも必ず対応させること。
  const delisting = r.warnings?.find((w) => w.label?.includes('上場廃止'));
  if (delisting) v = worsen(v, 'avoid', `${delisting.title}。上場廃止が決定しており、決算カタリストによる株価反応はもう見込めません`);

  // 実測バグ（ユーザー報告: 米国株ALOYがSCORE 70・rank Aで1位表示なのに、
  // カード内の仕込み妙味スコア（repricingLagBlockのwhyNote）は
  // 「新規の仕込み対象としては見送り推奨です」と明記しており、順位と
  // 結論が矛盾していた）。repricingLagScoreのオーバーライドルール
  // （直近急騰でzone:'priced_in'）はambushVerdictに一切配線されて
  // おらず、verdictBlockの公式な結論とrepricingLagBlockの説明文が
  // 別々に矛盾したメッセージを出せる状態だった。zone:'priced_in'が
  // 確定的に判定できた（checked:true）場合は、repricingLagBlockの文言と
  // 整合させるため見送りまで落とす。r.repricingLagが無いオブジェクト
  // （SMART ENTRY等）ではoptional chainingにより何もしない。
  if (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in') {
    v = worsen(v, 'priced_in_caution', `直近1ヶ月・3ヶ月の株価上昇により仕込み妙味スコアが「織り込み済み」（オーバーライドルール発動）。新規の仕込み対象としては様子見〜織り込み警戒が妥当です`);
  }

  // v7.3改修（ユーザー指示書 項目4）: 「決算直前は買い時ではなく織り込み
  // 警戒を強める」。AMBUSH NOWの下限を14日→7日に広げたため、7〜13日
  // （決算直前・sweetMinの外側）は「まだ狙い目の核ではない」ことを
  // verdictにも反映する。daysLeftが無い呼び出し元（SMART ENTRY等）は
  // 対象外。
  // 第8優先改修（ユーザー報告）: この理由文は「決算までの日数が近い」
  // という時間軸だけを根拠にしており、上のpricedIn判定（stage1の
  // 価格・出来高ベースの判定）とは異なる情報源から来ている。同じ
  // 'priced_in_caution'状態・似た文言を使うと「決算が近い＝織り込み
  // 済み」であるかのように読め、TIMINGとPRICING/UNPRICEDを混同させる
  // （このリポジトリでは「決算まで7〜30日」という時間軸自体、
  // バックテストで検証済みの事実ではなく仮説として扱う方針にした）。
  // 判定条件（NEAR_EARNINGS_MIN_DAYS=14、v.levelの重大度）は変更せず、
  // 理由文だけを「決算をまたぐリスク管理」という時間軸由来の理由だと
  // 明確に分かる表現に変える。
  if (Number.isFinite(r.daysLeft) && r.daysLeft >= 0 && r.daysLeft < NEAR_EARNINGS_MIN_DAYS) {
    v = worsen(v, 'priced_in_caution', `決算まであと${r.daysLeft}日と間近です。株価が織り込み済みと確認されたわけではなく、決算をまたぐこと自体のリスク管理（決算発表による急変動リスク）として、新規の仕込みには注意が必要な時期です`);
  }

  // retailExpectationSignal（個人投資家の期待織り込み）がbad段階なら
  // badChipSignalsのループで既にreasonが書き換わっている。warn段階は
  // 単独で「買い推奨」を覆すほどの赤旗ではないが、「良い会社」と
  // 「まだ株価に織り込まれていない良い会社」を見分けるための重要な
  // 文脈なので、結論の理由に必ず一言添える（ユーザー要望: 「買い推奨や
  // 様子見のところにもう少し結論の説明が欲しい」）。
  v = applyMinimumBuyGate(v, r);
  v = appendRetailExpectationCaution(v, r);

  return v;
}

// SMART ENTRY: 既に条件を満たしたパターンだけが並ぶので基本は買い推奨。
// AMBUSHと同じ「ベース判定→悪化方向のみ上書き」の2段階にしている
// （場中にパターンが崩れて「見送り」が妥当な銘柄が、赤旗の早期return
// によって「様子見」に上書きされる同種のバグを防ぐため）。
export function smartEntryVerdict(r, overheat, growthSurge) {
  const top = [r.sig1, r.sig2, r.sig3].find((s) => s?.level === 'good');
  // 場中の値動きでパターンが崩れ、3条件どれも「該当」でなくなることがある
  // （sig1〜3が再判定される場中ライブ更新後）。根拠が無いのに「複数の
  // シグナルが揃っています」と言い切るのは仕様書の方針に反するため、
  // その場合は見送りに落とす（買い推奨には絶対にしない）。
  let v = top
    ? { level: 'buy', label: VERDICT_LABEL.buy, reason: top.note }
    : { level: 'avoid', label: VERDICT_LABEL.avoid, reason: '値動きが進み、選定時点の仕込みパターンにはもう該当しなくなりました' };

  // 過熱（乖離+15%超）はAMBUSH側でも「見送り」まで落とす最重要の赤旗
  // なので、同じ閾値・同じ関数(overheatSignal)を使うSMART ENTRY側も
  // 揃える（以前はここだけ「様子見」止まりで、同じ危険度の乖離が
  // セクションによって結論の重さが違うという矛盾があった）。
  // ※ overheat/growthSurgeはCHIP_SIGNAL_FIELDSに含まれていない
  // （r.kairi/r.market/r.closesから計算するため、呼び出し側で
  // 事前計算して渡している）。card()側の表示条件を変えるときは
  // ここも必ず対応させること。
  if (overheat?.level === 'bad') v = worsen(v, 'avoid', overheat.note);
  if (growthSurge?.level === 'bad') v = worsen(v, 'hold', growthSurge.note);
  // bottomChips()に出る赤チップ全てを一括で見る（CHIP_SIGNAL_FIELDS参照）。
  // 新しいシグナルをbottomChipsに追加すれば、ここにも手を加えることなく
  // 自動的に反映される（配線忘れの再発防止）。
  for (const s of badChipSignals(r)) {
    v = worsen(v, 'hold', s.note);
  }

  // ambushVerdictと同じ理由でwarn段階を結論の理由に必ず補足する
  // （ユーザー要望。文言はappendRetailExpectationCautionに一本化し、
  // 2箇所で個別に書いて将来食い違う抜けを防ぐ）。
  v = applyMinimumBuyGate(v, r);
  v = appendRetailExpectationCaution(v, r);

  return v;
}

// ==================================================================
// v7.3改修（ユーザー指示書 項目1/2/7/19）: BUY SCORE / EXPECTATION SCORE /
// EARNINGS SURPRISE SCOREの3分割と、DATA/CONFIDENCE分離＋Effective Score。
//
//  「銘柄そのものが良いか」（EXPECTATION）と「今この瞬間に仕込む価値が
//  あるか」（BUY）と「次の決算で市場予想を上回りそうか」（SURPRISE）を
//  混同しない、というユーザー方針に対応する。新規データ取得はせず、
//  既存の信号（score/repricingLag/consensusTrap/daysLeft/netNet等）を
//  5要素・3要素にそれぞれ再配点する。JP/US双方から呼べるよう、raw値
//  ではなく{value:0-100,note}形式のpartsを受け取る（screener.mjs:
//  composite()と同じgot/max正規化パターン）。
//
//  ■ JP/US差分の吸収は呼び出し側（各screener.mjs）の責務
//  US側にはconsensusTrap/progressStreak/hasMonthly等が存在しないため、
//  該当partsはnull（未計算）になる。それ自体はconfidenceの低下として
//  正しく反映され、「データが少ない銘柄が不当に有利にならない」という
//  項目7の方針とも整合する。
// ------------------------------------------------------------------

function weightedComposite(parts, weights) {
  let got = 0, max = 0, knownCount = 0;
  const totalCount = Object.keys(weights).length;
  const detail = {};
  for (const [k, w] of Object.entries(weights)) {
    const p = parts[k];
    detail[k] = p ?? null;
    if (p && Number.isFinite(p.value)) { got += (p.value / 100) * w; max += w; knownCount += 1; }
  }
  // 第2優先改修 ### 3再送分（ユーザー報告）: SIGNAL SCORE/DATA COVERAGE/
  // CONFIDENCEを明示的に分離する。
  //  - signalScore（=coverageScore）: 未取得の軸を0点として数えた点数。
  //    「10項目中4項目しか取得できないのに、その4項目だけで100点満点
  //    相当になる」設計を禁止するというユーザー指示に対応する値
  //    （weightsは常に固定の全軸合計＝100点満点の表なので、分母を
  //    縮めずに済む）。
  //  - dataCoverage（=confidence）: 必要データのうち何%を確認できたか
  //    （固定100点満点基準の実カバー率）。
  //  - confidence（後述confidenceTier）: scoreを一切参照せず、
  //    dataCoverageだけから算出する（低スコア+データ十分でもLOWにしない、
    // 高スコア+データ不足でもHIGHにしない。confidenceTier()参照）。
  //  - ruleCoverage: 何軸中何軸にデータがあったか（PASS/FAIL/UNKNOWNの
  //    自分ルールと同じ考え方を、重み付け合成スコアの軸にも適用したもの）。
  // scoreは既存通り「揃った軸だけで100点満点に再配点した値」のまま変更
  // しない（AMBUSH/SMART ENTRYの判定条件＝BUY SCORE等の閾値比較がこの
  // 値を参照しているため、ここを変えると判定条件自体が変わってしまう）。
  // 新しい表示・報告にはscoreではなくsignalScore/dataCoverageを使うこと。
  if (max === 0) {
    return {
      score: null, confidence: 0, detail, coverageScore: 0,
      signalScore: 0, dataCoverage: 0, ruleCoverage: { known: 0, total: totalCount },
    };
  }
  return {
    score: Math.round((got / max) * 100), confidence: Math.round(max), detail,
    coverageScore: Math.round(got),
    signalScore: Math.round(got), dataCoverage: Math.round(max),
    ruleCoverage: { known: knownCount, total: totalCount },
  };
}

export const BUY_SCORE_WEIGHTS = { expectedReturn: 30, unpriced: 25, surprise: 20, timing: 15, quality: 10 };
// 改修指示書 項目2「財務リスク・希薄化リスク・信用過熱・会計リスク・
// 業績悪化などをリスクペナルティとして反映する」: BUY SCOREはこれまで
// 100点配点の合成だけで、リスク側は一切減点していなかった（重大な
// リスクは既にworsen()でverdictを見送りまで落とす/severeRiskHitsで
// ハード除外しているが、BUY SCOREの数値自体はリスクの有無に関係なく
// 高いままになりうる矛盾があった＝実測バグ）。個別リスクごとの正確な
// 減点幅の根拠となる実データが無いため、既存のbadChipSignals（bad級の
// リスクシグナル。財務リスク=netNet等、希薄化リスク=将来的な該当項目、
// 信用過熱=marginOverhang、会計リスク=receivablesAnomaly、業績悪化=
// earningsWarning等を包含）の該当件数×一律の減点で反映する。
export const BUY_SCORE_RISK_PENALTY_PER_SIGNAL = 10;
export function buyScoreRiskPenalty(r) {
  return badChipSignals(r).length * BUY_SCORE_RISK_PENALTY_PER_SIGNAL;
}
export function buyScore(parts = {}, riskPenalty = 0) {
  const base = weightedComposite(parts, BUY_SCORE_WEIGHTS);
  if (base.score === null || !riskPenalty) return base;
  return { ...base, score: Math.max(0, base.score - riskPenalty), rawScoreBeforeRisk: base.score, riskPenalty };
}

export const EXPECTATION_SCORE_WEIGHTS = { revenueGrowth: 40, profitGrowth: 30, quality: 20, sectorMomentum: 10 };
export function expectationScore(parts = {}) {
  return weightedComposite(parts, EXPECTATION_SCORE_WEIGHTS);
}

export const SURPRISE_SCORE_WEIGHTS = { consensusGap: 60, progressMomentum: 20, monthlyDisclosure: 20 };
export function earningsSurpriseScore(parts = {}) {
  return weightedComposite(parts, SURPRISE_SCORE_WEIGHTS);
}

// A指示 項目1-2「仕込み優先度」: 「ユーザーが最も見たい実戦用スコア」
// として100点満点で新設する。指示書の配点（未織り込み度25・成長加速20・
// 業績の質15・バリュエーション15・カタリスト10・需給10・テーマ性5）を
// そのまま重みにする。buyScore/expectationScore/earningsSurpriseScoreと
// 同じweightedComposite（データが無い軸は分母からも除外し、揃った軸だけで
// 再配点する）を使い、buildScoreParts()が組み立てるparts.entryPriorityを
// 入力にする。リスク減点もBUY SCOREと同じ考え方（badChipSignals該当件数
// ×一律10点、buyScoreRiskPenaltyをそのまま再利用）で適用する。
export const ENTRY_PRIORITY_WEIGHTS = {
  untapped: 25, growthAccel: 20, quality: 15, valuation: 15, catalyst: 10, supplyDemand: 10, theme: 5,
};
export function entryPriorityScore(parts = {}, riskPenalty = 0) {
  const base = weightedComposite(parts, ENTRY_PRIORITY_WEIGHTS);
  if (base.score === null || !riskPenalty) return base;
  return { ...base, score: Math.max(0, base.score - riskPenalty), rawScoreBeforeRisk: base.score, riskPenalty };
}

// buyScoreの「タイミング」要素用の目安（screener.mjs WINDOW/us_screener.mjs
// US_WINDOWと同じ閾値。indicators.mjsは循環importを避けるため値を複製する
// ＝WINDOW側の値を変えたらここも合わせて変更すること）。
const TIMING_WINDOW = { nowMin: 7, sweetMin: 14, nowMax: 30, watchMax: 45, preMax: 60 };

// buyScore/expectationScore/earningsSurpriseScoreの各partsを、AMBUSH
// 結果オブジェクト（JP/US共通の最小限のフィールドのみ参照）から組み立てる。
// r.score/r.repricingLag/r.consensusTrap/r.progressStreak/r.hasMonthly/
// r.netNet/r.revenueGrowthPct等、既存の各screener.mjsが既に計算済みの
// フィールドだけを使い、新規リクエストは発生しない。
export function buildScoreParts(r) {
  const expectedReturn = Number.isFinite(r.score) ? { value: r.score, note: '既存SCORE(素点)を流用' } : null;
  const unpriced = r.repricingLag?.checked && Number.isFinite(r.repricingLag.score)
    ? { value: r.repricingLag.score, note: `妙味スコア${r.repricingLag.score}/100（zone:${r.repricingLag.zone}）` }
    : null;
  const surpriseMap = { good: 90, warn: 50, bad: 10 };
  const surprise = r.consensusTrap?.checked && r.consensusTrap.level in surpriseMap
    ? { value: surpriseMap[r.consensusTrap.level], note: r.consensusTrap.note }
    : null;
  let timing = null;
  if (Number.isFinite(r.daysLeft) && r.daysLeft >= 0) {
    const d = r.daysLeft;
    const v = d < TIMING_WINDOW.nowMin ? null
      : d < TIMING_WINDOW.sweetMin ? 40
        : d <= TIMING_WINDOW.nowMax ? 100
          : d <= TIMING_WINDOW.watchMax ? 60
            : d <= TIMING_WINDOW.preMax ? 20 : null;
    if (v !== null) timing = { value: v, note: `決算まで${d}日` };
  }
  const qualityFields = ['netNet', 'lowPbr', 'hiddenGem', 'pbrHistoricalLow'];
  const qualityChecked = qualityFields.map((k) => r[k]).filter((s) => s?.checked);
  const quality = qualityChecked.length
    ? { value: Math.round((qualityChecked.filter((s) => s.level === 'good').length / qualityChecked.length) * 100), note: `下値・割安系シグナル${qualityChecked.filter((s) => s.level === 'good').length}/${qualityChecked.length}件該当` }
    : null;

  // v7.5改修（ユーザー提案「成長率だけでなく成長の加速を見る」）:
  // 「前期→今期で成長率自体が加速しているか」をボーナスとして加える。
  // ユーザー要望「異常値なら無条件で1位にしない」に対応するため、
  // revenueGrowth自体の評価軸（率の大きさ）は変えずボーナスのみ加算し、
  // 既存の0〜100クランプはそのまま維持する（値が極端に大きくても
  // 100で頭打ちになる既存の仕組みと同じ考え方で、加速していても
  // 無条件に上限を突破させない）。
  // A指示 項目7「成長加速を独立スコア化する」: 従来はlevel:'good'かどうか
  // の二値で+15固定だったが、growthAccelerationSignalがscore（0-100、
  // 加速度合い＋粗利率/営業利益率改善ボーナスを反映した連続値）を返す
  // ようになったため、加速の強さに比例したボーナスにする（上限15は
  // 従来と同じ、上限を超えて無条件加点しない設計は維持）。
  const growthAccelBonus = Math.round((r.growthAcceleration?.score ?? 0) * 15 / 100);
  const revenueGrowth = Number.isFinite(r.revenueGrowthPct)
    ? { value: Math.max(0, Math.min(100, Math.round(r.revenueGrowthPct * 2) + growthAccelBonus)), note: `売上高成長率+${r.revenueGrowthPct}%${growthAccelBonus ? '（加速中）' : ''}` }
    : null;
  const profitGrowth = Number.isFinite(r.earningsTrend?.netIncomeGrowthPct ?? r.profitGrowthPct)
    ? { value: Math.max(0, Math.min(100, Math.round((r.earningsTrend?.netIncomeGrowthPct ?? r.profitGrowthPct) * 2))), note: '利益成長率' }
    : null;
  const sectorMomentum = Number.isFinite(r.sectorChangePct)
    ? { value: Math.max(0, Math.min(100, Math.round(50 + r.sectorChangePct * 10))), note: `業種騰落率${r.sectorChangePct}%` }
    : null;

  const progressMomentum = r.progressStreak?.checked
    ? { value: r.progressStreak.level === 'good' ? 90 : r.progressStreak.level === 'warn' ? 40 : 50, note: r.progressStreak.note ?? '進捗率トレンド' }
    : null;
  const monthlyDisclosure = typeof r.hasMonthly === 'boolean'
    ? { value: r.hasMonthly ? 70 : 30, note: r.hasMonthly ? '月次開示あり' : '月次開示なし' }
    : null;

  // A指示 項目1-2「仕込み優先度」100点満点スコアの内訳。既存のbuy/
  // expectation/surpriseの各partsで既に計算済みの値（unpriced=未織り込み
  // 度、growthAccelBonusの元になったgrowthAcceleration.score=成長加速）を
  // 再利用し、新たに「業績の質」「バリュエーション」「カタリスト」
  // 「需給」「テーマ性」を追加する。
  //
  // 「業績の質」: 下値/割安系のqualityとは別概念（進捗率トレンド・成長の
  // 裏付け・赤字成長リスクという「業績そのものの信頼性」を見る）。
  const qualitySignals = [];
  if (r.progressStreak?.checked) qualitySignals.push(r.progressStreak.level === 'good' ? 90 : r.progressStreak.level === 'warn' ? 40 : 50);
  if (r.growthAnomalyCaution?.checked) qualitySignals.push(r.growthAnomalyCaution.level === 'good' ? 90 : r.growthAnomalyCaution.level === 'warn' ? 30 : 50);
  if (r.deficitGrowth?.checked) qualitySignals.push(r.deficitGrowth.level === 'good' ? 80 : r.deficitGrowth.level === 'bad' ? 10 : 50);
  const earningsQuality = qualitySignals.length
    ? { value: Math.round(qualitySignals.reduce((a, b) => a + b, 0) / qualitySignals.length), note: '業績の質（進捗率トレンド・成長の裏付け・赤字成長リスク）' }
    : null;

  // 「バリュエーション」: 既存のvaluationQualityScore（0-30点、業種平均
  // PER/PBRとの比較）を0-100スケールに揃え直すだけ（新規計算無し）。
  const valuationRaw = valuationQualityScore({ per: r.per, sectorPer: r.sectorPer, pbr: r.pbr, sectorPbr: r.sectorPbr });
  const valuation = valuationRaw.checked
    ? { value: Math.round((valuationRaw.score / 30) * 100), note: `バリュエーション（PER/PBRの業種平均比）${valuationRaw.score}/30点` }
    : null;

  // 「カタリスト」: JP AMBUSH（screener.mjs）はTDnet開示の正味スコア
  // catalystScore100（0-100、既存）をそのまま使う。それが無い呼び出し元
  // （SMART ENTRY/テンバガー等）はhasCatalystの二値にフォールバックする。
  // A指示27「先行材料なしを悪材料としない」: 先行材料が無い（=0点/false）
  // 場合をvalue:0にすると、weightedComposite内でcatalyst weight(10点)が
  // 分母に残ったまま分子だけ0になり、先行材料が無いだけの銘柄すべてが
  // 一律に減点される（=「無い」が「悪い」と同じ扱いになってしまう）。
  // 正しくは軸ごと除外（null）して分母からも外し、実際に先行材料が
  // ある銘柄だけを加点対象にする。
  const catalyst = Number.isFinite(r.catalystScore100) && r.catalystScore100 > 0
    ? { value: r.catalystScore100, note: `先行材料${r.catalystTier ?? ''}ランク（正味${r.catalystScore100}点）` }
    : r.hasCatalyst === true
      ? { value: 100, note: '先行材料あり' }
      : null;

  // 「需給」: 信用倍率(marginOverhang)・踏み上げ(squeeze)・浮動株に対する
  // 信用買い比率(creditFloat)という既存の需給系シグナル3つを平均する。
  const supplyDemandSignals = [];
  if (r.squeeze?.checked) supplyDemandSignals.push(r.squeeze.level === 'good' ? 90 : 50);
  if (r.creditFloat?.checked) supplyDemandSignals.push(r.creditFloat.level === 'good' ? 90 : r.creditFloat.level === 'bad' ? 20 : 50);
  if (r.marginOverhang?.checked) supplyDemandSignals.push(r.marginOverhang.level === 'bad' ? 20 : 70);
  const supplyDemand = supplyDemandSignals.length
    ? { value: Math.round(supplyDemandSignals.reduce((a, b) => a + b, 0) / supplyDemandSignals.length), note: '需給（信用倍率・踏み上げ・信用買い占有率）' }
    : null;

  // 「テーマ性」: themeMatchSignalは'good'かnullしか返さない（手動選定の
  // 決め打ちテーマ一覧との照合のため、'bad'という概念が無い＝掲載が無い
  // ことは「テーマ性が無いと確認された」わけではなく単に「このリストでは
  // 拾えなかった」だけ）。catalystと全く同じ理由（A指示27の再発防止・
  // 横展開）で、非該当をvalue:0にするとweightedComposite内でtheme
  // weight(5点)ぶん一律減点され続けるため、該当した場合のみ加点しnull
  // （軸ごと除外）にする。
  const theme = r.themeMatch?.level === 'good'
    ? { value: 100, note: r.themeMatch.note }
    : null;

  return {
    buy: { expectedReturn, unpriced, surprise, timing, quality },
    expectation: { revenueGrowth, profitGrowth, quality, sectorMomentum },
    surprise: { consensusGap: surprise, progressMomentum, monthlyDisclosure },
    entryPriority: {
      untapped: unpriced,
      growthAccel: Number.isFinite(r.growthAcceleration?.score) ? { value: r.growthAcceleration.score, note: r.growthAcceleration.note ?? '成長加速' } : null,
      quality: earningsQuality,
      valuation,
      catalyst,
      supplyDemand,
      theme,
    },
  };
}

// DATA/CONFIDENCE分離（項目7）。confidenceRaw（0-100、composite()系関数の
// confidence=取得できた配点合計）をHIGH/MEDIUM/LOWの3段階に丸める。
//
// A指示 項目24: confidenceRaw===0（BUY SCOREの5要素のうち1つもデータが
// 揃わなかった状態。weightedComposite()がmax===0のとき返す値）は、
// 「49%のように一部データはあるが閾値未満」なLOWとは意味が根本的に違う
// （score自体がnullになる＝そもそも算出不能）。これをLOWに丸めて表示すると
// 「弱いなりに信頼度がある」ように誤解されるため、HIGH/MEDIUM/LOWとは別の
// UNKNOWN（根拠が弱すぎる＝判定材料が無い）として区別する。
export const CONFIDENCE_TIER = { high: 80, medium: 50 };
export function confidenceTier(confidenceRaw) {
  if (!Number.isFinite(confidenceRaw)) return null;
  if (confidenceRaw === 0) return 'UNKNOWN';
  if (confidenceRaw >= CONFIDENCE_TIER.high) return 'HIGH';
  if (confidenceRaw >= CONFIDENCE_TIER.medium) return 'MEDIUM';
  return 'LOW';
}

// Effective Score = Raw Score × Confidence係数（項目7）。元のSCORE表示は
// 別途保持し、ランキングにはこちらを使う。データが薄いのに高得点な銘柄が
// 不当に上位へ来るのを防ぐ。UNKNOWN（confidenceRaw===0）はweightedComposite
// の設計上rawScore自体もnullになるため実際には掛け算まで到達しないが、
// 万一直接呼ばれてもNaNにならないようLOWと同じ最も厳しい係数を割り当てる。
export const CONFIDENCE_ADJUSTMENT = { HIGH: 1.0, MEDIUM: 0.85, LOW: 0.65, UNKNOWN: 0.65 };
export function effectiveScore(rawScore, confidenceRaw) {
  if (!Number.isFinite(rawScore)) return null;
  const tier = confidenceTier(confidenceRaw) ?? 'LOW';
  return Math.round(rawScore * CONFIDENCE_ADJUSTMENT[tier]);
}

// ==================================================================
// 評価軸の分離（第3優先改修、ユーザー報告）
//
// ■ 問題
// SCORE（composite）/BUY SCORE/仕込み優先度などの各複合スコアは、
// 「割安性(PER/PBR)」「業績」「カタリスト（適時開示・受注・政策等）」
// 「需給・テクニカル」「決算タイミング」という性質の異なる情報を、
// 銘柄ごとに異なる配点で1つの数値に積み上げている。そのため「割安だから
// 評価が高い」のか「近い将来に株価が動く材料が強いから評価が高い」のかが
// 数字だけでは区別できない。
//
// ■ 今回やること・やらないこと
// 既存スコアの配点・重みは一切変更しない（AMBUSH/SMART ENTRYの判定条件、
// Repricing Gap、欠損データの扱いは全て前回までの改修のまま）。ここでは
// 既に計算済みの値を、後から5つの評価軸（VALUATION/FUNDAMENTALS/
// CATALYST/PRICE_SUPPLY/TIMING）に分類し直すだけの、読み取り専用の
// 集計レイヤーを追加する。
//
// ■ 各軸のscoreを「新規に合成しない」方針について
// 「配分が最適」と仮定した新スコアをバックテスト無しで作らないという
// 禁止事項に従い、各軸のscoreは「その軸の意味に一致する既存のcomposite
// 値をそのまま流用できる場合だけ」設定する。
//  - valuation: valuationQualityScore()（既存、PER/PBRの業種平均比）を
//    entryPriorityScoreと同じ式で0-100に換算し直したもの（新規の重みは
//    無い）。
//  - catalyst: catalystScore100（既存、TDnet開示ベース）をそのまま流用。
//  - timing: buildScoreParts().buy.timingの値（既存、決算までの日数）を
//    そのまま流用。
//  - fundamentals/priceSupply: 複数指標をまとめた既存の単一composite値が
//    無い（expectationScoreはsectorMomentumが混入・entryPriority.
//    supplyDemandはRSI/乖離率/52週位置を含まない等）ため、新規に重みを
//    決めて合成することはせず、score:nullのまま個別指標の一覧
//    （components）だけを返す。
//
// ■ 実データで見つかった「重複」の代表例（詳細はコミットメッセージ/
// 報告参照）
//  - repricingLag.scoreがBUY SCOREのunpriced(25%)とentryPriorityScoreの
//    untapped(25%)の両方に使われている（同じ値が2つの見出しスコアに
//    別々の顔で出る）。
//  - r.score（旧SCORE、月次+PR+進捗+セクター+テクニカルの合成）が
//    そのままBUY SCOREのexpectedReturn(30%)として再利用されているため、
//    旧SCOREに混ざっていたカタリスト(PR)・需給(セクター)・テクニカル
//    要素がBUY SCORE全体にも間接的に効いている。
//  - progressStreakが「旧SCOREのprogress軸」「entryPriorityScoreの
//    quality(業績の質)軸」「earningsSurpriseScoreのprogressMomentum軸」
//    の3か所で使われている。
//  - consensusTrap（会社予想とコンセンサスの差）は「業績予想の相対値」
//    でもあり「市場の期待とのギャップ＝カタリスト的な先行指標」でもある
//    ため、FUNDAMENTALS/CATALYSTのどちらに分類しても一部重複が残る
//    （このため下ではCATALYST側に分類しつつコメントで明記する）。
export function evaluationAxes(r) {
  const parts = buildScoreParts(r);
  const valuationRaw = valuationQualityScore({ per: r.per, sectorPer: r.sectorPer, pbr: r.pbr, sectorPbr: r.sectorPbr });
  return {
    // A. VALUATION（割安性・バリュエーション）
    valuation: {
      score: valuationRaw.checked ? Math.round((valuationRaw.score / 30) * 100) : null,
      components: {
        per: r.per ?? null, sectorPer: r.sectorPer ?? null,
        pbr: r.pbr ?? null, sectorPbr: r.sectorPbr ?? null,
        psr: r.psr ?? r.repricingLag?.psr ?? null,
        evEbitda: r.evEbitda?.checked ? r.evEbitda.ratio : null,
        dividendYield: r.dividendYield ?? null,
        netNet: r.netNet?.level ?? null,
        lowPbr: r.lowPbr?.level ?? null,
        pbrHistoricalLow: r.pbrHistoricalLow?.level ?? null,
        divFloor: r.divFloor?.level ?? null,
        dividendPeak: r.dividendPeak?.level ?? null,
        hiddenAsset: r.hiddenAsset?.level ?? null,
      },
    },
    // B. FUNDAMENTALS / EARNINGS（業績）
    fundamentals: {
      score: null, // 既存に単独compositeが無いため新規の重み付けはしない（上記コメント参照）
      components: {
        revenueGrowthPct: r.revenueGrowthPct ?? null,
        profitGrowthPct: r.profitGrowthPct ?? r.earningsTrend?.netIncomeGrowthPct ?? null,
        progressStreak: r.progressStreak?.level ?? null,
        growthAcceleration: r.growthAcceleration?.score ?? null,
        growthAnomalyCaution: r.growthAnomalyCaution?.level ?? null,
        deficitGrowth: r.deficitGrowth?.level ?? null,
        // 第6優先改修: 利益成長率とキャッシュフローの整合性（新規）。
        earningsCashFlowQuality: r.earningsCashFlowQuality?.level ?? null,
        // 第6優先改修■3（ユーザー報告）: 「売上30%・利益5%」と「売上5%・
        // 利益30%」を同じ「高成長」として扱わないよう、REVENUE_GROWTH/
        // PROFIT_GROWTHは上の2フィールドで既に分離済み。ここにさらに
        // MARGIN（利益率が改善しているか）を専用フィールドとして追加する
        // （marginImproving()の再利用。新規計算・新規重みは無い）。
        marginTrend: {
          grossMarginImproving: typeof r.grossMarginImproving === 'boolean' ? r.grossMarginImproving : null,
          opMarginImproving: typeof r.opMarginImproving === 'boolean' ? r.opMarginImproving : null,
        },
        roe: r.roe ?? null,
        receivablesAnomaly: r.receivablesAnomaly?.level ?? null,
        dividendPotential: r.dividendPotential?.level ?? null,
      },
    },
    // C. CATALYST（近い将来の再評価材料。適時開示・受注・政策・テーマ性等）
    catalyst: {
      score: Number.isFinite(r.catalystScore100) ? r.catalystScore100 : null,
      components: {
        catalystTier: r.catalystTier ?? null,
        hasCatalyst: typeof r.hasCatalyst === 'boolean' ? r.hasCatalyst : null,
        hasMonthly: typeof r.hasMonthly === 'boolean' ? r.hasMonthly : null,
        // 業績予想の相対値でもあり、市場の期待とのギャップという意味では
        // カタリスト的でもある重複指標（上記コメント参照）。
        consensusTrap: r.consensusTrap?.level ?? null,
        themeMatch: r.themeMatch?.level ?? null,
        policyCatalystScore: r.policyCatalystScore?.score ?? null,
      },
    },
    // D. PRICE / SUPPLY（テクニカル・需給。RSI・乖離率・出来高・信用・
    // 52週位置・株価モメンタム等）
    priceSupply: {
      score: null, // 既存に単独compositeが無いため新規の重み付けはしない（上記コメント参照）
      components: {
        kairi: r.kairi ?? null, rsi: r.rsi ?? null, volZ: r.volZ ?? null,
        loanRatio: r.loanRatio ?? null,
        creditFloat: r.creditFloat?.level ?? null,
        squeeze: r.squeeze?.level ?? null,
        // 第7優先改修: 「売りが少ない」（marginOverhang/squeeze）と「買いが
        // 強い」は別変数として保持する（buyingDemandSignal、新規）。
        buyingDemand: r.buyingDemand?.level ?? null,
        priceLevelPct: r.repricingLag?.priceLevelPct ?? null,
        return1m: r.repricingLag?.return1m ?? null,
        return3m: r.repricingLag?.return3m ?? null,
        marginOverhang: r.marginOverhang?.level ?? null,
        sectorLag: r.sectorLag?.level ?? null,
        sectorRotation: r.sectorRotation?.level ?? null,
        sectorChangePct: r.sectorChangePct ?? null,
        retailExpectation: r.retailExpectation?.level ?? null,
        institutionalShort: r.institutionalShort?.level ?? null,
        majorShareholder: r.majorShareholder?.level ?? null,
        climax: r.climax?.level ?? null,
      },
    },
    // TIMING（決算タイミング）
    timing: {
      score: Number.isFinite(parts.buy?.timing?.value) ? parts.buy.timing.value : null,
      components: {
        daysLeft: r.daysLeft ?? r.earningsDaysLeft ?? null,
        earningsWarning: r.earningsWarning?.level ?? null,
        bucket: r.bucket ?? null,
      },
    },
  };
}

// ==================================================================
// 財務品質のまとめ表示構造（第6優先改修■5、ユーザー報告）
//
// 売上・営業利益・営業CF・FCF・売掛金・在庫・利益率を同じまとまりで
// 確認できるようにする、読み取り専用の集計レイヤー（evaluationAxesと
// 同じ設計方針）。既存の各シグナルの判定・閾値は一切変更しない。
// UI表示への反映は今回のスコープ外（内部データ構造のみ追加）。
export function financialQualityBreakdown(r) {
  return {
    growth: {
      revenueGrowthPct: r.revenueGrowthPct ?? null,
      profitGrowthPct: r.profitGrowthPct ?? r.earningsTrend?.netIncomeGrowthPct ?? null,
      // 第6優先改修①: 前期特別損益の反動等、理由別の内訳。
      anomalyReasonCodes: r.growthAnomalyCaution?.reasonCodes ?? [],
    },
    margin: {
      grossMarginImproving: typeof r.grossMarginImproving === 'boolean' ? r.grossMarginImproving : null,
      opMarginImproving: typeof r.opMarginImproving === 'boolean' ? r.opMarginImproving : null,
    },
    cashFlow: {
      operatingCf: r.operatingCf ?? null,
      fcf: r.earningsCashFlowQuality?.fcf ?? null,
      // 第6優先改修■4: 利益成長とキャッシュフローの整合性（good/warn/null）。
      qualityLevel: r.earningsCashFlowQuality?.level ?? null,
    },
    workingCapital: {
      // 「利益成長がある」という事実と「キャッシュ化の確認が必要」という
      // 情報を同時に表示できる状態にする（既存の売掛金警戒ロジック自体は
      // 変更しない）。
      receivablesAnomaly: r.receivablesAnomaly?.level ?? null,
    },
    // 第6優先改修②: US株の税効果チェック（JP株はprofitGrowthPctが経常
    // 利益＝税引前ベースのため対象外。usTaxEffectCautionSignal参照）。
    taxEffect: {
      level: r.taxEffectCaution?.level ?? null,
      divergencePct: r.taxEffectCaution?.divergencePct ?? null,
    },
  };
}

// ==================================================================
// 信用需給の意味の分離（第7優先改修、ユーザー報告）
//
// 「信用買いが少ない」「信用倍率が低い」ことは、「株価が上昇しやすい」
// 「上昇余地が大きい」ことと同じではない。信用倍率が低いことは単に
// 買い需要そのものが弱いだけの可能性がある。既存の各信号（
// marginOverhangSignal/buyingDemandSignal/shortSqueezeSignal/
// institutionalShortSignal/creditFloatSignal）の判定・閾値は一切変更
// せず、意味の異なる4つの概念に分けて並べ直すだけの読み取り専用の
// 集計レイヤーを追加する（evaluationAxes/clusterConfirmationと同じ
// 設計方針。新しい閾値・重みは一切作らない）。
//
//  - SUPPLY_PRESSURE: 将来の売り圧力（信用買い残の重さ）。
//    marginOverhangSignalそのもの。「信用倍率が低い＝売り圧力が小さい」
//    という解釈だけをここに閉じ込め、「買い需要が強い」という別解釈
//    （BUYING_DEMAND）とは混同しない。
//  - BUYING_DEMAND: 買い需要そのものの強さ。buyingDemandSignalそのもの
//    （信用買い残の減少だけでなく、株価・出来高との組み合わせで判定）。
//  - SQUEEZE_POTENTIAL: 買い戻し余地（踏み上げ）。shortSqueezeSignal・
//    institutionalShortSignalそのもの。「上昇要因の1つ」であり、
//    独立した上昇期待そのものではないことをnoteに明記済み。
//  - LIQUIDITY_QUALITY: 出来高・浮動株比率の厚み、および推定浮動株の
//    データ品質。creditFloatSignalそのもの（lowPrecisionフラグ込み）。
export function creditSupplyBreakdown(r) {
  const empty = { level: null, label: null, note: null, checked: false };
  return {
    supplyPressure: r.marginOverhang ?? empty,
    buyingDemand: r.buyingDemand ?? empty,
    squeezePotential: {
      retail: r.squeeze ?? empty,
      institutional: r.institutionalShort ?? empty,
    },
    liquidityQuality: r.creditFloat ?? empty,
  };
}

// ==================================================================
// AMBUSHの時間軸とシグナルの分離（第8優先改修、ユーザー報告）
//
// 「決算まで7〜30日」というAMBUSHの時間軸区分は、現時点でバックテスト
// によって検証された事実ではなく仮説として扱う。この関数は、その
// 「区分そのもの」を変更・最適化するのではなく、時間軸（EARNINGS_
// DISTANCE）・決算日の確度（EARNINGS_DATE_CONFIDENCE）・カタリスト
// （CATALYST_SIGNAL）・株価反応（PRICE_REACTION）・未織り込み判定
// （PRICING_STATUS）を、それぞれ独立した情報として並べ直すだけの
// 読み取り専用の集計レイヤー（evaluationAxes/creditSupplyBreakdownと
// 同じ設計方針）。screener.mjsのWINDOW/bucket判定・ambushVerdictの
// 判定条件・閾値は一切変更しない。
//
// ■ earningsDateStatus（sbi.mjs）の意味
//  'confirmed' = 東証の適時開示に基づく確定日（sbi_exchange）
//  'estimated' = 前年同期の決算日をそのまま参考値として使った推定
//                （sbi_previous_year_reference）。日付がズレうる。
//  'unknown'   = 決算発表済みで次回日程が未収録、等で不明。
// 大文字のCONFIRMED/ESTIMATED/UNKNOWNは、この既存値をそのまま
// 大文字化するだけで新しい判定は加えない。
function mapEarningsDateConfidence(status) {
  if (status === 'confirmed') return 'CONFIRMED';
  if (status === 'estimated') return 'ESTIMATED';
  return 'UNKNOWN';
}

export function ambushTimingBreakdown(r) {
  return {
    // EARNINGS_DISTANCE: 決算まで何日か（生の事実）。bucketは既存の
    // screener.mjs側の分類（NOW/WATCH/NEAR等）をそのまま表示用に持たせる
    // だけで、ここでは再計算しない。isHypothesis:trueは「7/14/30/45/60
    // という区切り値がバックテストで検証済みの最適値ではない」ことを
    // 明示するための固定フラグ（今回、値そのものは変更していない）。
    earningsDistance: {
      days: Number.isFinite(r.daysLeft) ? r.daysLeft : null,
      // 第8優先改修 CASE H対応: screener.mjsのdaysUntil()は単純な
      // カレンダー日数差（86400000msで割るだけ）で、土日祝日を考慮した
      // 営業日ベースではない。「7日」が実質何営業日分の値動きを指すかは
      // 週末の位置によって変わりうるため、単位を明示する（計算方法自体は
      // 変更しない）。
      unit: 'calendar_days',
      bucket: r.bucket ?? null,
      isHypothesis: true,
    },
    // EARNINGS_DATE_CONFIDENCE: 決算日データの確度。CONFIRMEDと
    // ESTIMATEDを同じ確度で扱わない。
    earningsDateConfidence: {
      status: mapEarningsDateConfidence(r.earningsDateStatus),
      source: r.earningsDateSource ?? null,
    },
    // CATALYST_SIGNAL: 決算に向けた再評価材料があるか。時間軸とは
    // 独立に判定されている値をそのまま集約するだけ（daysLeftを参照しない）。
    catalystSignal: {
      hasCatalyst: typeof r.hasCatalyst === 'boolean' ? r.hasCatalyst : null,
      catalystScore100: Number.isFinite(r.catalystScore100) ? r.catalystScore100 : null,
      catalystTier: r.catalystTier ?? null,
    },
    // PRICE_REACTION: 決算発表までの間に株価が既にどう反応しているか
    // （生データ）。
    priceReaction: {
      kairi: Number.isFinite(r.kairi) ? r.kairi : null,
      return1m: Number.isFinite(r.repricingLag?.return1m) ? r.repricingLag.return1m : null,
      return3m: Number.isFinite(r.repricingLag?.return3m) ? r.repricingLag.return3m : null,
    },
    // PRICING_STATUS: 「未織り込み」判定そのもの。stage1の価格・出来高
    // ベース判定とrepricingLag.zoneという、どちらもdaysLeftを一切
    // 参照しない入力から算出された値をそのまま集約する（TIMINGとの
    // 混同防止）。
    pricingStatus: {
      stage1Pass: [r.kairi, r.rsi, r.volZ].every(Number.isFinite)
        ? stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass : null,
      repricingLagZone: r.repricingLag?.zone ?? null,
    },
  };
}

// ==================================================================
// クラスタ単位での重複カウント抑制（第5優先改修、ユーザー報告）
//
// ■ 問題
// RSI・乖離率・52週(60日)レンジ内の位置・1ヶ月/3ヶ月騰落率は、実質的に
// 「株価が売られている/出遅れている」という1つの現象を複数の数字で
// 表現していることが多い。PER・PBR・配当利回りも「割安」という1つの
// 現象を複数の切り口で示すことが多い。信用倍率・信用買い残トレンド・
// 信用買い占有率も「信用需給の緊張度」という1つの現象を指すことが多い。
// これらを独立した根拠として別々に加点すると、実質1つの現象を複数回
// 加点してしまう（第3優先改修で発見した重複の実例:
// repricingLag.scoreがBUY SCORE/仕込み優先度の両方に使われる、
// r.score(旧SCORE)がBUY SCOREのexpectedReturnに丸ごと再利用される等）。
//
// ■ 今回の方針（ユーザー指定の原則）
// - raw指標(kairi/rsi/per/pbr等)そのもの・各シグナル関数の意味・閾値は
//   一切変更しない。
// - composite()/weightedComposite()系の既存SCORE（旧SCORE・BUY SCORE・
//   仕込み優先度・smartEntryConviction等）の配点・重みは一切変更しない
//   （重み再設計は別工程。今回はバックテスト無しで「この重みが最適」と
//   決めない）。
// - 「クラスタ」（PRICE/SUPPLY_CREDIT/VALUATION/FUNDAMENTALS/CATALYST）を
//   導入し、クラスタ内で複数の指標が同時に同じ方向を示していても、
//   独立した根拠としては「そのクラスタ1件」としてしか数えない、新しい
//   並行の集計（clusterConfirmation）を追加する。既存のどのSCOREの
//   合計点も書き換えない（加算方式を変えるのではなく、別の診断指標として
//   並べて出す）。
// - 各指標の「個別に注目に値するか」の判定は、新しい閾値を1つも作らず、
//   既存のsignal関数・既存の定数（LOW_PBR.goodRatio/DIVIDEND_FLOOR.strong/
//   MARGIN_OVERHANG.heavy/CREDIT_FLOAT.light/REPRICING_LAG.
//   preMovePriceLevelMax、scraper.mjsのrsiTone(<40)と同じ閾値等）を
//   そのまま参照する。
// - 欠損（判定材料が無い）はhitに含めない（0扱いにもgood扱いにもしない
//   ＝第2優先改修のUNKNOWNの考え方と同じ）。
export function clusterConfirmation(r) {
  // PRICE: 株価そのものの位置・反応（RSI/乖離率/52週位置/1M・3M騰落率）。
  // 「売られすぎ・出遅れ」方向の個別ヒットをそのまま列挙する。
  const priceHits = [];
  if (Number.isFinite(r.kairi) && r.kairi < 0) priceHits.push('kairi');
  if (Number.isFinite(r.rsi) && r.rsi < 40) priceHits.push('rsi'); // scraper.mjs rsiToneと同じ閾値(<40)
  const priceLevelPct = r.repricingLag?.priceLevelPct;
  if (Number.isFinite(priceLevelPct) && priceLevelPct <= REPRICING_LAG.preMovePriceLevelMax) priceHits.push('priceLevelPct');
  const return1m = r.repricingLag?.return1m ?? r.return1m;
  if (Number.isFinite(return1m) && return1m < 0) priceHits.push('return1m');
  const return3m = r.repricingLag?.return3m ?? r.return3m;
  if (Number.isFinite(return3m) && return3m < 0) priceHits.push('return3m');

  // VALUATION: 割安性（PER/PBR業種比・配当利回り）。
  const valuationHits = [];
  if (Number.isFinite(r.per) && Number.isFinite(r.sectorPer) && r.sectorPer > 0 && r.per / r.sectorPer <= LOW_PBR.goodRatio) valuationHits.push('per'); // valuationQualityScoreと同じ閾値(0.7)
  if (r.lowPbr?.level === 'good') valuationHits.push('pbr');
  if (Number.isFinite(r.dividendYield) && r.dividendYield >= DIVIDEND_FLOOR.strong) valuationHits.push('dividendYield');
  if (r.pbrHistoricalLow?.level === 'good') valuationHits.push('pbrHistoricalLow');

  // SUPPLY_CREDIT: 信用需給の緊張度（信用倍率・信用買い残トレンド・
  // 信用買い占有率）。squeezeは既に「買い残減少×売り残増加」を合成
  // 判定済みのため、これ単体で1指標としてカウントする（内部で二重に
  // 分解しない）。
  const supplyCreditHits = [];
  if (Number.isFinite(r.loanRatio) && r.loanRatio < MARGIN_OVERHANG.heavy) supplyCreditHits.push('loanRatio');
  if (r.squeeze?.level === 'good') supplyCreditHits.push('creditTrend');
  if (r.creditFloat?.level === 'good' || (Number.isFinite(r.creditFloat?.occupancy) && r.creditFloat.occupancy <= CREDIT_FLOAT.light)) supplyCreditHits.push('creditFloatOccupancy');
  // 第9優先改修 Phase5（ユーザー提案）: 残高の絶対量だけでなく、
  // 残高×価格×出来高の変化（creditSupplyQualitySignal）もSUPPLY_CREDIT
  // クラスタの判定材料に加える。level:'good'のときだけ1件としてカウント
  // し（1クラスタ1回のルールは維持）、既存の3つのヒットは変更しない。
  if (r.creditSupplyQuality?.level === 'good') supplyCreditHits.push('creditSupplyQuality');

  // FUNDAMENTALS: 業績成長（売上/利益成長率・成長加速）。EPS成長率単体の
  // 指標は現状実装されていない（revenueGrowthPct/profitGrowthPctのみ）。
  const fundamentalsHits = [];
  if (Number.isFinite(r.revenueGrowthPct) && r.revenueGrowthPct > 0) fundamentalsHits.push('revenueGrowthPct');
  if (Number.isFinite(r.profitGrowthPct) && r.profitGrowthPct > 0) fundamentalsHits.push('profitGrowthPct');
  if (r.growthAcceleration?.level === 'good') fundamentalsHits.push('growthAcceleration');

  // CATALYST: 近い将来の再評価材料。
  const catalystHits = [];
  if (Number.isFinite(r.catalystScore100) && r.catalystScore100 > 0) catalystHits.push('catalystScore100');
  if (r.consensusTrap?.level === 'good') catalystHits.push('consensusTrap');

  const clusters = {
    PRICE: priceHits, VALUATION: valuationHits, SUPPLY_CREDIT: supplyCreditHits,
    FUNDAMENTALS: fundamentalsHits, CATALYST: catalystHits,
  };
  const rawHitCount = Object.values(clusters).reduce((a, hits) => a + hits.length, 0);
  // independentClusterCount: 「本当に独立した根拠の数」。同じクラスタ内で
  // 何指標ヒットしても1としてしか数えない（過剰加点の抑制）。
  const independentClusterCount = Object.values(clusters).filter((hits) => hits.length > 0).length;
  return { clusters, rawHitCount, independentClusterCount };
}

// ==================================================================
// 底打ち確認（＋α）— 「まだ下がるかも」という不安を裏付けデータで払拭する
// ための補助シグナル。いずれも除外条件ではなく、根拠を積み増す一言メモ。
// データが無い/判定できない場合は level:null（何も主張しない）を返す。
// ==================================================================

// ① セリングクライマックス（近似）
//
//  本来の歩み値（ティックデータ）による「機関投資家の大口約定」検出は、
//  kabutanが20分ディレイの日次データしか持たないため不可能。代わりに
//  「直近lookback営業日以内に、20日平均の何倍もの出来高を伴う大陰線
//  または長い下ヒゲが出たか」を株価の四本値から検出する近似値。
//  歩み値そのものではないことをnoteに明記する。
export const SELLING_CLIMAX = { lookback: 15, volRatioMin: 3, bigDownPct: 4, wickRatioMin: 0.4 };

export function sellingClimaxSignal({ opens, highs, lows, closes, volumes } = {}) {
  const n = closes?.length ?? 0;
  // kabutanのkabukaページは実測30営業日分しか返さないため、lookback(15)+21=36を
  // 要求すると常にnullになり判定不能になっていた（実データで確認済みのバグ）。
  // ループ側は既に「20日平均が組める日まで」で自然に打ち切るので、
  // ここでは最低ライン（直近1日分の判定に必要な21日）だけ要求すればよい。
  if (!opens || !highs || !lows || !volumes || n < 21) {
    return { level: null, label: null, note: null };
  }
  let best = null;
  for (let back = 0; back < SELLING_CLIMAX.lookback; back++) {
    const i = n - 1 - back;
    if (i < 20) break;
    const hist = volumes.slice(i - 20, i).filter(Number.isFinite);
    if (hist.length < 20 || !Number.isFinite(volumes[i])) continue;
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (avg === 0) continue;
    const volRatio = volumes[i] / avg;
    if (volRatio < SELLING_CLIMAX.volRatioMin) continue;

    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (![o, h, l, c].every(Number.isFinite) || o === 0) continue;
    const range = h - l;
    const bigDown = ((o - c) / o) * 100 >= SELLING_CLIMAX.bigDownPct;
    const lowerWick = range > 0 && (Math.min(o, c) - l) >= range * SELLING_CLIMAX.wickRatioMin;
    if (!bigDown && !lowerWick) continue;

    if (!best || volRatio > best.volRatio) best = { back, volRatio: round1(volRatio), bigDown, lowerWick };
  }
  if (!best) return { level: null, label: null, note: null };
  const shape = best.bigDown && best.lowerWick ? '大陰線+長い下ヒゲ' : best.bigDown ? '大陰線' : '長い下ヒゲ';
  return {
    level: 'good', label: '底打ち観測',
    note: `${best.back}営業日前に平均${best.volRatio}倍の出来高を伴う${shape}（セリングクライマックスの可能性。歩み値の大口約定ではなく四本値からの近似判定）`,
  };
}

// ② ネットネット判定（簡易・現金ベース）
//
//  本来は (現預金＋売掛金×0.75)－負債総額 と時価総額を比較するが、
//  kabutanの決算ページに売掛金の内訳が無いため、保守的に現金等残高の
//  みで判定する簡易版（本来の基準より厳しい＝ネットネットと出た銘柄は
//  より確度が高い）。
// receivables（売上債権＝売掛金＋受取手形）はkabutanに無いため、
// IR Bank（irbank.mjs）から取れたときだけ本来の式
// (現預金＋売掛金×0.75)－負債総額 を使う。取れなければ現金だけの
// 簡易版（より保守的＝厳しい基準）にフォールバックする。
export const NET_NET_RECEIVABLES_HAIRCUT = 0.75;

// EDINET由来の財務数値（cash/totalAssets/equity/receivables/
// retainedEarnings/investmentSecurities等）は単位が「円」だが、kabutan
// 由来のmarketCapは単位が「百万円」（kabutan.mjsのparseMain参照）。
// EDINETの値とmarketCapを比較する信号は必ずこの関数で単位を揃えてから
// 割ること。
//
// ■ 実測バグ（重大・このコメントを書くに至った経緯）
// netNetSignalがこの換算をせずにnetAssets(円) / marketCap(百万円)を
// 計算しており、比率が約100万倍に水増しされていた。ratio>=1の閾値判定
// 自体は（値が巨大に狂っていても閾値を超えることに変わりはないため）
// 結果的に多くの銘柄で「解散価値割れ」と表示され続けてしまっており、
// 単なる表示バグでは済まず、下値の裏付け・hiddenGemSignal・AMBUSHの
// 加点（AMBUSH_BONUS_FIELDS経由）に本物の影響が出ていた。EDINET統合を
// 行った当初からこの状態だったとみられる。
export function marketCapYen(marketCapMillionYen) {
  return Number.isFinite(marketCapMillionYen) ? marketCapMillionYen * 1_000_000 : null;
}

// v7.3改修（ユーザー指示書 項目10）: EV/EBITDA。単純なPER/PBRだけでは
// 割安・割高を判断しない、という方針への対応。marketCap/operatingProfit
// はkabutanの「百万円」単位、interestBearingDebt/cash/dAndAはEDINETの
// 生の円単位（実測確認済み。edinet.mjs参照）なので、marketCapYen()と
// 同じ考え方でoperatingProfitも生の円単位に揃えてから計算する。
// dAndA（減価償却費）が取れない銘柄はEBITDA≒営業利益として計算する
// （実態のEBITDAより小さめに出るだけで、過大評価には振れない安全側）。
// 赤字（EBITDA<=0）はEV/EBITDA自体が無意味な指標になるため比率は出さない。
export function evEbitda({ marketCap, interestBearingDebt, cash, operatingProfit, dAndA } = {}) {
  if (!Number.isFinite(marketCap) || marketCap <= 0 || !Number.isFinite(operatingProfit)) {
    return { ev: null, ebitda: null, ratio: null, checked: false };
  }
  const ev = marketCapYen(marketCap) + (Number.isFinite(interestBearingDebt) ? interestBearingDebt : 0) - (Number.isFinite(cash) ? cash : 0);
  const ebitda = marketCapYen(operatingProfit) + (Number.isFinite(dAndA) ? dAndA : 0);
  if (ebitda <= 0) return { ev, ebitda, ratio: null, checked: true };
  return { ev, ebitda, ratio: round1(ev / ebitda), checked: true };
}

export function netNetSignal({ cash, totalAssets, equity, marketCap, receivables } = {}) {
  // level:nullには「データ不足で判定できない」場合と「データは揃って
  // いて解散価値割れではないと確認できた」場合の2通りがある。呼び出し側
  // （buyRuleChecklistの「下値」行）がこれを混同すると、PBRデータが
  // 完全に揃っていて明確に「割安ではない」と分かる銘柄まで「？（未確認）」
  // と表示してしまう（実測: 350A等11銘柄でPBRデータが揃っているのに
  // 「解散価値・PBRいずれでも下値の裏付けは確認できず」と表示されていた）。
  // receivablesAnomalySignalと同じくchecked flagで明示的に区別する。
  if (![cash, totalAssets, equity, marketCap].every(Number.isFinite) || marketCap <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const liabilities = totalAssets - equity;
  const hasReceivables = Number.isFinite(receivables);
  const netAssets = hasReceivables
    ? cash + receivables * NET_NET_RECEIVABLES_HAIRCUT - liabilities
    : cash - liabilities;
  const ratio = netAssets / marketCapYen(marketCap);
  const basis = hasReceivables ? '現預金+売掛金×0.75-負債' : '現預金-負債(簡易版・売掛金データ無し)';
  if (ratio >= 1) {
    // 第4優先改修（ユーザー報告）: 「下値は極めて限定的」は解散価値
    // （現時点のBS）だけを根拠にした話法で、業績・キャッシュフローの
    // 悪化が続けば解散価値自体が目減りする可能性に触れていなかった。
    // 「現時点の資産で見ると」という条件付きに変更し、将来の悪化まで
    // 保証しない表現にする（valuationとdownside protectionを同義に
    // しないという方針。下のvaluation/repricingLagとは別データソース
    // で個別に算出しており重複はない）。
    return {
      level: 'good', label: '解散価値割れ', checked: true,
      note: `${basis}が時価総額の${round1(ratio * 100)}%・会社を今すぐ解散して資産を分けた方が株価より高い計算です。現時点の資産の裏付けは厚いといえますが、今後業績やキャッシュフローが悪化すれば解散価値自体が目減りする可能性はあります`,
    };
  }
  if (ratio >= 0.7) {
    return {
      level: 'warn', label: '解散価値に接近', checked: true,
      note: `${basis}が時価総額の${round1(ratio * 100)}%まで接近・株価がもう一段下がると解散価値割れの水準です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ②' 業種内での相対的な割安度（PBRが業種平均以下）
//
//  「1日30分の銘柄調査ルーティン」の下値チェックはネットネットだけでは
//  ほぼ発動しない（実測: AMBUSH候補21銘柄中0件）。ネットネットに次ぐ
//  下値の目安として、ユーザー提示の元の項目「PBRが業種平均以下」を
//  追加する。個別銘柄PBR(kabutan.mjsのparseMain)・業種平均PBR
//  (fetchSectorMomentumの同じページに実は入っていた列)はどちらも
//  既存の取得済みページから取れるため追加リクエストは無い。
export const LOW_PBR = { goodRatio: 0.7, warnRatio: 1 };

export function lowPbrSignal({ pbr, sectorPbr } = {}) {
  // netNetSignalと同じ理由でchecked flagを持たせる（PBRデータが揃って
  // いて「割安ではない」と確認できた場合と、データ不足で判定できない
  // 場合を区別する）。
  if (!Number.isFinite(pbr) || !Number.isFinite(sectorPbr) || sectorPbr <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const ratio = round1((pbr / sectorPbr) * 100);
  if (pbr / sectorPbr <= LOW_PBR.goodRatio) {
    return {
      level: 'good', label: '業種内で割安', checked: true,
      note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%。業種内で相対的に割安な水準です`,
    };
  }
  if (pbr / sectorPbr <= LOW_PBR.warnRatio) {
    return { level: 'warn', label: '業種平均並み', checked: true, note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%` };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ③ 配当利回りの下限サポート
export const DIVIDEND_FLOOR = { strong: 4, watch: 3 };

// 第4優先改修（ユーザー報告）: 旧ラベル「配当下限」「配当下限接近」・
// 旧ノート「下支えが期待できる水準」は、配当利回りの高さをそのまま
// 株価の下値支持（downside protection）であるかのように読める表現
// だった。配当利回りは現在株価・会社予想配当・減配リスク・利益/FCFとの
// 関係で変わるものであり、「高利回り＝下値が固い」を自動的に意味しない
// （ユーザー方針）。閾値・level判定ロジック自体は変更せず（今回は表現の
// 整理のみが目的）、ラベル・ノートだけを「相対的に高い利回り」という
// 事実の記述に変える。
export function dividendYieldFloorSignal(yieldPct) {
  if (!Number.isFinite(yieldPct)) return { level: null, label: null, note: null };
  if (yieldPct >= DIVIDEND_FLOOR.strong) {
    return { level: 'good', label: '高配当利回り', note: `配当利回り${yieldPct}%（${DIVIDEND_FLOOR.strong}%超は相対的に高水準です）。減配リスクや株価変動により変わりうる目安で、下値を保証するものではありません` };
  }
  if (yieldPct >= DIVIDEND_FLOOR.watch) {
    return { level: 'warn', label: '配当利回り上昇中', note: `配当利回り${yieldPct}%（${DIVIDEND_FLOOR.watch}%超）。株価下落や増配で今後さらに上がる可能性がある水準というだけで、下値を保証するものではありません` };
  }
  return { level: null, label: null, note: null };
}

// ③' 過去最高配当利回りへの接近度（IR Bank）
//
//  現在の配当利回りが単体で高いだけでなく、その銘柄自身の過去5年の
//  レンジの中でどの位置にあるかを見る。無配銘柄（過去最高が0%）は
//  接近率という概念が成立しないためnull（IR Bank側で既にガード済み）。
export const DIVIDEND_PEAK = { near: 90 };

// currentYieldはkabutanの最新値（他のシグナルの「現在利回り」と揃える）
// を渡す。IR Bank自身が持つ「現在値」を使うと、取得タイミングのズレで
// 同じカードの中に4.21%(kabutan)と4.29%(IR Bank)のような、利用者から
// 見て矛盾する2つの「現在利回り」が同居してしまう（実測: 7921で発生）。
// maxYield/maxPeriodだけIR Bankの過去5年データを使い、接近率はここで
// 一貫した基準で計算し直す。
export function dividendYieldPeakSignal({ currentYield, maxYield, maxPeriod } = {}) {
  if (!Number.isFinite(currentYield) || !Number.isFinite(maxYield) || maxYield <= 0) {
    return { level: null, label: null, note: null };
  }
  const approachPct = Math.round((currentYield / maxYield) * 1000) / 10;
  if (approachPct >= 100) {
    return {
      level: 'good', label: '配当利回り最高水準',
      note: `現在${currentYield}%は過去5年の最高（${maxPeriod}時点${maxYield}%）に並ぶか上回る水準です`,
    };
  }
  if (approachPct >= DIVIDEND_PEAK.near) {
    return {
      level: 'good', label: '配当利回り高水準',
      note: `現在${currentYield}%は過去5年の最高（${maxPeriod}・${maxYield}%）の${approachPct}%まで接近しています`,
    };
  }
  return { level: null, label: null, note: null };
}

// ③'' 過去最低PBRへの接近度（IR Bank）
//
//  コンセンサス（アナリスト予想）が無い銘柄は「未来の期待値」で判定
//  できないため、代わりに「過去の事実」として自分自身の過去のPBR推移の
//  中で今がどの位置にあるかを見る。current/maxYieldと同じ考え方だが
//  向きが逆（低いほど良い）なので、接近率は min/currentで計算する
//  （現在が最低値そのものなら100%、現在が最低値を更に下回れば100%超）。
//  netNet/lowPbrと同じ理由でchecked flagを持たせる（buyRuleChecklistの
//  「下値」行がnetNet/lowPbrと同じOR条件に組み込むため、「データ不足で
//  未確認」と「データは揃っていて下値の裏付けにならないと確認できた」を
//  混同してはならない）。
export const PBR_LOW = { near: 90 };

export function pbrHistoricalLowSignal({ currentPbr, minPbr, minPeriod } = {}) {
  if (!Number.isFinite(currentPbr) || !Number.isFinite(minPbr) || currentPbr <= 0 || minPbr <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const approachPct = Math.round((minPbr / currentPbr) * 1000) / 10;
  if (approachPct >= 100) {
    return {
      level: 'good', label: 'PBR歴史的最低水準', checked: true,
      note: `現在PBR${currentPbr}倍は過去最低（${minPeriod}時点${minPbr}倍）に並ぶか下回る水準です`,
    };
  }
  if (approachPct >= PBR_LOW.near) {
    return {
      level: 'good', label: 'PBR歴史的低水準', checked: true,
      note: `現在PBR${currentPbr}倍は過去最低（${minPeriod}・${minPbr}倍）の${approachPct}%まで接近しています`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑤ コンセンサス不在＝アナリスト非カバーという属性そのものをシグナル化する
//
//  時価総額が小さい銘柄はそもそも証券会社のリサーチ対象外（コンセンサス
//  自体が存在しない）だが、それは同時に「機関投資家がまだ見つけていない
//  可能性がある」という意味でもある。EDINET確認済みの財務健全性
//  （解散価値割れ or 業種内で割安なPBR）と増配トレンドが同時に揃う場合に
//  限り「お宝候補」として拾い上げる（コンセンサスが無いというだけでは
//  何の裏付けにもならないため、単独では発火させない）。
export const HIDDEN_GEM = { minStreakYears: 1 };

export function hiddenGemSignal({ consensusProfit, netNet, lowPbr, dividendStreakYears, dividendStreakDirection } = {}) {
  const hasConsensus = hasConsensusProfit(consensusProfit);
  if (hasConsensus) return { level: null, label: null, note: null };
  const soundFinance = netNet?.level === 'good' || lowPbr?.level === 'good';
  if (!soundFinance) return { level: null, label: null, note: null };
  if (dividendStreakDirection !== 'up' || !Number.isFinite(dividendStreakYears) || dividendStreakYears < HIDDEN_GEM.minStreakYears) {
    return { level: null, label: null, note: null };
  }
  const basis = netNet?.level === 'good' ? '解散価値割れ' : '業種内で割安なPBR';
  return {
    level: 'good', label: 'お宝候補',
    note: `アナリスト未カバー（コンセンサスN/A）ながら${basis}かつ${dividendStreakYears}期連続増配中。機関投資家にまだ見つかっていない可能性があり、注目された際の反応が大きくなりやすい銘柄です`,
  };
}

// 第7優先改修（ユーザー報告）: 「信用買いが少ない」「信用倍率が低い」
// ことを自動的に「買い需要が強い」「上昇余地が大きい」と解釈しない。
// 信用買い残の減少には複数の解釈がありうる（①信用整理が進んだ
// ②将来の戻り売り圧力が減った ③株価下落で投資家が撤退した ④そもそも
// 人気がなくなった）。株価変化・出来高と組み合わせて、「需給改善」の
// 可能性と「単なる低人気（LOW BUYING INTEREST）」の可能性を分離する。
// marginOverhangSignal/creditFloatSignalとは別の、「買い需要そのものの
// 強さ」を扱う独立した信号として新設する（既存の判定は変更しない）。
export function buyingDemandSignal({ creditTrendPct, changePct, volRatio } = {}) {
  if (!Number.isFinite(creditTrendPct)) return { level: null, label: null, note: null, checked: false };
  if (creditTrendPct >= 0) return { level: null, label: null, note: null, checked: true };
  const priceUp = Number.isFinite(changePct) ? changePct > 0 : null;
  const volumeThin = Number.isFinite(volRatio) ? volRatio < 1 : null;
  const volumeSurging = Number.isFinite(volRatio) ? volRatio >= FLOAT_SQUEEZE.minVolumeRatio : null;
  if (priceUp === true && volumeSurging === true) {
    return {
      level: 'good', label: '信用買い減少・株価上昇（需給改善の可能性）', checked: true,
      note: `信用買い残は減少傾向（${creditTrendPct}%）ですが、株価は上昇し出来高も20日平均の${volRatio}倍に増えています。単なる信用整理ではなく、新規の買い需要が入ってきている可能性があります`,
    };
  }
  if (priceUp !== true && volumeThin === true) {
    return {
      level: 'caution', label: '信用買い減少・出来高細り（低人気の可能性）', checked: true,
      note: `信用買い残は減少傾向（${creditTrendPct}%）ですが、株価は上昇しておらず出来高も少ない状態です。需給が改善しているとは限らず、単に市場参加者の関心が低い（LOW BUYING INTEREST）可能性があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ④ 踏み上げ狙い（信用残の解消）
//
//  信用買い残が減り（個人の投げ売りが進み）、逆に信用売り残（空売り）が
//  増えている＝将来「買い戻さざるを得ない」需要が積み上がっている状態。
// A指示 項目18「信用倍率の単純評価をやめる」: 踏み上げ判定は信用買い残/
// 売り残の方向（本関数の基本条件）だけでなく、機関投資家の空売り縮小
// （institutionalShortSignal。個人の信用取引とは投資主体が異なる別データ）
// ・出来高急増という裏付けが複数一致した場合により高い確度として扱う
// （指示書「これらが複数一致した場合のみ踏み上げポテンシャルを高評価」）。
// 空売り比率（TSE日次空売り集計）に相当する無料データソースは実測で
// 見つかっていないため対象外（推測で埋めない）。
export function shortSqueezeSignal(weekly, { institutionalShort, volRatio } = {}) {
  // level:nullが「週次信用残データが無い」場合と「データはあり踏み上げ
  // 狙いの条件（買い残減少かつ売り残増加）を満たさないと確認できた」
  // 場合の両方に使われるため、checked flagで区別する。これが無いと、
  // buyRuleChecklistの「需給」行のOR条件（信用過多でない、または踏み
  // 上げが積み上がっている）が壊れる：marginOverhangが確定的にbadで
  // squeezeが単に未取得なだけの場合でも「OR全体がfalseと確定」と
  // 誤認して✗を出してしまう（本来は「squeezeが分かれば結果が変わる
  // かもしれない」ので？が正しい）。
  const buyTrendPct = creditTrend(weekly);
  const sellTrendPct = shortTrend(weekly);
  if (buyTrendPct === null || sellTrendPct === null) return { level: null, label: null, note: null, checked: false };
  if (buyTrendPct < 0 && sellTrendPct > 0) {
    const institutionalConfirms = institutionalShort?.level === 'good';
    const volumeConfirms = Number.isFinite(volRatio) && volRatio >= PATTERN2.minVolRatio;
    const confirmCount = 2 + (institutionalConfirms ? 1 : 0) + (volumeConfirms ? 1 : 0);
    const extras = [
      institutionalConfirms ? '機関投資家の空売りも縮小中' : null,
      volumeConfirms ? `出来高が20日平均の${volRatio}倍に急増` : null,
    ].filter(Boolean).join('・');
    return {
      level: 'good', label: `踏み上げ狙い${confirmCount >= 3 ? '（複合確認）' : ''}`, checked: true, confirmCount,
      note: `信用買い残4週比${buyTrendPct}%・空売り(売り残)4週比+${sellTrendPct}%。個人の投げが進み空売りが積み上がっており、戻りで買い戻し需要が出やすい状態です${extras ? `。さらに${extras}しており、複数の需給指標が一致しています` : ''}（第7優先改修: 踏み上げの可能性は株価上昇を後押ししうる要因の1つであり、株価が上がることを保証するものではありません。通常の買い需要とは別軸として扱ってください）`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ④' 機関投資家の空売り縮小（karauri.net・大量保有報告に基づく法定開示）
//
//  shortSqueezeSignalは信用取引（主に個人投資家）の空売りトレンドだが、
//  こちらは残高割合0.5%超で法定開示義務のある機関投資家（ヘッジファンド等）
//  の空売りポジション推移。投資主体が異なる別データで、個人の踏み上げ
//  期待とは独立した「大口が撤退し始めている」根拠として使う。
export const INSTITUTIONAL_SHORT = { meaningfulPct: 0.5, coveringDrop: -0.2 };

export function institutionalShortSignal({ totalPct, changePct, checked } = {}) {
  if (!checked || totalPct === null) return { level: null, label: null, note: null, checked: false };
  if (totalPct >= INSTITUTIONAL_SHORT.meaningfulPct && changePct !== null && changePct <= INSTITUTIONAL_SHORT.coveringDrop) {
    return {
      level: 'good', label: '機関の空売り縮小', checked: true,
      note: `機関投資家の空売り残高${totalPct}%（直近90日で${changePct}pt減少）。大口の買い戻しが進んでおり、踏み上げ的な反発の余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ④'' 大株主の買い増し（IR Bank・大株主一覧の推移）
//
//  Ulletの「大株主構成・浮動株比率」提案を受けて、既に統合済みで信頼できる
//  IR Bankの同等データ（/holder）で代替する。筆頭株主の持株比率が高いほど
//  浮動株は薄く、上位3株主の合計持株比率が直近の開示で増えていれば
//  大株主が買い増している（＝経営陣や大口が自信を持っている）根拠とする。
//  上位3株主「合計」で見るのは、信託銀行名義などで筆頭株主自体が期に
//  よって入れ替わることがあり、単一株主の継続履歴を追えないケースが
//  あるため（実測: 7921で新規の名義が突然1位に現れ、それ以前の履歴が
//  無かった）。
export const MAJOR_SHAREHOLDER = { thinFloatPct: 20, accumulatingChange: 3 };

export function majorShareholderSignal({ top1Pct, top3PctChange, checked } = {}) {
  if (!checked || top1Pct === null) return { level: null, label: null, note: null, checked: false };
  if (top1Pct >= MAJOR_SHAREHOLDER.thinFloatPct && top3PctChange !== null && top3PctChange >= MAJOR_SHAREHOLDER.accumulatingChange) {
    return {
      level: 'good', label: '大株主が買い増し中', checked: true,
      note: `筆頭株主の持株比率${top1Pct}%・上位3株主合計が前回開示比+${top3PctChange}pt。浮動株が少なく、大株主の買い増しで需給が締まっている可能性があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑥ 信用過多（買い方の過密）警告
//
//  パターン②は信用倍率<3を条件の1つにしているが、それはあくまで
//  「トレンド転換パターンとして該当するか」の判定であって、他の
//  パターン(①③)で該当した銘柄の信用倍率が高くても警告されない。
//  信用倍率が非常に高い（買い方が積み上がっている）銘柄は、上昇時に
//  含み益確定売りが出やすく上値が重くなりがちなので、該当パターンに
//  関わらず一般的な注意喚起として出す（除外ではなく警告）。
export const MARGIN_OVERHANG = { heavy: 10 };

export function marginOverhangSignal(loanRatio) {
  // level:nullが「信用倍率データが無い」場合と「データはあり信用過多
  // ではないと確認できた」場合の両方に使われるため、checked flagで区別
  // する（実測: 石井表記等4銘柄はloanRatio自体が取得できていないのに、
  // buyRuleChecklistの「需給」行が「✓ 信用過多の兆候なし」＝確認済みと
  // 誤表示していた）。
  if (loanRatio === null || loanRatio === undefined) return { level: null, label: null, note: null, checked: false };
  if (loanRatio >= MARGIN_OVERHANG.heavy) {
    return {
      level: 'bad', label: '信用過多', checked: true,
      note: `信用倍率${loanRatio}倍・買い方の含み益が積み上がっており、上昇時に利益確定売りに押されて上値が重くなりやすい状態です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑦ 決算間近の警告（地雷回避）
//
//  SMART ENTRYは決算スケジュールを見ずに需給・乖離だけで選ぶ設計だが、
//  「決算発表の直前は新規エントリーを避ける」のは需給とは独立した
//  一般的なリスク管理ルールなので、該当パターンとは別枠で警告する。
//  除外はしない（AMBUSHと違い決算日が分からない銘柄も多いため）。
export const EARNINGS_WARNING_DAYS = 5;

export function earningsProximitySignal(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return { level: null, label: null, note: null };
  if (daysLeft >= 0 && daysLeft <= EARNINGS_WARNING_DAYS) {
    return {
      level: 'bad', label: '決算間近',
      note: `決算まであと${daysLeft}日。地雷回避の原則から、決算をまたぐ新規エントリーは避けるのが無難です`,
    };
  }
  return { level: null, label: null, note: null };
}

// ⑧ 売掛金（売上債権）の異常増加チェック
//
//  「1日30分の銘柄調査ルーティン」の財務チェック項目。売上債権の伸びが
//  売上高の伸びを大きく上回っている場合、回収遅延・在庫化・販売条件の
//  緩和（押し込み販売）などが疑われる。年度決算ベースの前期比成長率
//  同士を比較する（kabutan: revenueGrowth、IR Bank: receivablesGrowth）。
//  どちらか一方でも取得できなければnull（推測で判定しない）。
export const RECEIVABLES_ANOMALY = { ratioWarn: 1.5, ratioBad: 2 };

// v7.3改修（ユーザー指示書 項目9）: 売上高と売掛金だけの比較では判断しない、
// という要望に対応し、営業CFの方向を追加考慮する。ユーザー提示の例
// 「売上+5%・売掛金+12%・営業CF↓→高リスク」「同じ数字でも営業CF↑→
// 必ずしも悪材料ではない（季節性・M&A・大型案件等の可能性）」をそのまま
// ロジック化する: 売掛金急増でbad判定になったケースでも、営業CFが
// 前期から改善していれば1段階軽いwarnに緩和し、理由をnoteに明記する。
// operatingCfGrowthPctが無い（データ不足）場合は従来通りbadのまま
// （安全側に倒す＝softenしない）。
export function receivablesAnomalySignal({ revenueGrowthPct, receivablesGrowthPct, operatingCfGrowthPct, advancesReceivedGrowthPct, inventoryGrowthPct } = {}) {
  if (!Number.isFinite(revenueGrowthPct) || !Number.isFinite(receivablesGrowthPct)) {
    // データ不足で「判定できない」状態。level:nullの「異常なし」と
    // 呼び出し側が混同しないよう checked:false で明示的に区別する。
    return { level: null, label: null, note: null, checked: false };
  }
  const cfImproving = Number.isFinite(operatingCfGrowthPct) && operatingCfGrowthPct > 0;
  // v7.5改修（ユーザー提案「売掛金＋前受金＝最強、はそのまま採用しない。
  // 受注・CFまで揃ったら警告緩和にする」）: 前受金が増えているのは
  // 「先に代金を受け取れるほど需要がある」という裏付けになりうるが、
  // これ単体を「最強の好材料」として無条件に扱うのは危険（売上計上の
  // タイミング・契約条件次第で意味が変わりうる）。営業CF改善と同じ
  // 「警告を1段階弱めるだけ」の裏付け材料として扱う（悪材料を好材料に
  // 反転させない）。受注残（バックログ）はEDINETに該当タグが見つから
  // なかったため対象外。
  const advancesImproving = Number.isFinite(advancesReceivedGrowthPct) && advancesReceivedGrowthPct > 0;
  // A指示 項目20「売掛金急増の判定を高度化する」: 「売上・売掛金・営業CF・
  // 棚卸資産・前受金・契約負債・受注残・受注高を同時に見る」という指示の
  // うち、棚卸資産は既にedinet.mjsで取得済み（追加リクエスト無し）なのに
  // 未使用だった。棚卸資産まで売上に見合わないペースで積み上がっている
  // 場合は「需要拡大に伴う運転資本増加」ではなく「押し込み販売・在庫過多・
  // 需要鈍化」を疑う悪いパターン（指示書の実例: 売掛金急増＋受注減少＋
  // 営業CF悪化→強い警戒、の受注減少に相当する代替シグナルとして扱う。
  // 受注残・受注高・契約負債はEDINETに該当タグが見つからず対象外）。
  // 営業CF改善・前受金増加という裏付けがあっても、棚卸資産まで同時に
  // 積み上がっているなら警告を緩和しない。
  const isAnomalousBuildup = (growthPct) => {
    if (!Number.isFinite(growthPct)) return false;
    return revenueGrowthPct <= 0 ? growthPct > 5 : round1(growthPct / revenueGrowthPct) >= RECEIVABLES_ANOMALY.ratioWarn;
  };
  const inventoryAlsoBuilding = isAnomalousBuildup(inventoryGrowthPct);
  const softening = (cfImproving || advancesImproving) && !inventoryAlsoBuilding;
  const cfNote = cfImproving ? `一方で営業キャッシュ・フローは前期比+${operatingCfGrowthPct}%と改善しており、` : '';
  const advNote = advancesImproving ? `${cfImproving ? 'さらに' : '一方で'}前受金が前期比+${advancesReceivedGrowthPct}%と増加しており、` : '';
  const softenedNote = softening
    ? `${cfNote}${advNote}季節性・大型案件・M&A等による一時的な運転資本の増加や、需要の裏付けがある可能性があり、必ずしも粉飾等の悪材料とは限りません。`
    : '';
  const inventoryNote = inventoryAlsoBuilding
    ? `さらに棚卸資産も前期比+${inventoryGrowthPct}%と売上に見合わないペースで積み上がっており、需要鈍化・在庫過多の懸念が重なっています。`
    : '';
  const softenedLabelSuffix = cfImproving && advancesImproving ? '（営業CF・前受金改善）' : cfImproving ? '（営業CF改善）' : advancesImproving ? '（前受金増加）' : '';
  const blockedLabelSuffix = inventoryAlsoBuilding && (cfImproving || advancesImproving) ? '（棚卸資産も同時増加のため警告維持）' : '';
  const softened = (label, note) => softening
    ? { level: 'warn', label: `${label}${softenedLabelSuffix}`, checked: true, note: `${note}${softenedNote}` }
    : { level: 'bad', label: `${label}${blockedLabelSuffix}`, checked: true, note: `${note}${inventoryNote}` };
  // 売上が横ばい/減収なのに売掛金が増えているのは特に強い警戒サイン。
  if (revenueGrowthPct <= 0 && receivablesGrowthPct > 5) {
    return softened('売掛金急増', `売上高${revenueGrowthPct > 0 ? '+' : ''}${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%。売上が伸びていないのに売掛金だけ膨らんでおり、回収遅延の懸念があります。`);
  }
  if (revenueGrowthPct > 0) {
    const ratio = round1(receivablesGrowthPct / revenueGrowthPct);
    if (ratio >= RECEIVABLES_ANOMALY.ratioBad) {
      return softened('売掛金急増', `売上高+${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%（売上の${ratio}倍のペース）。回収サイクルの長期化や押し込み販売の懸念があります。`);
    }
    if (ratio >= RECEIVABLES_ANOMALY.ratioWarn) {
      return {
        level: 'warn', label: '売掛金やや増加', checked: true,
        note: `売上高+${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%（売上の${ratio}倍のペース）。決算での運転資本の動きは確認しておきたいところです`,
      };
    }
  }
  return { level: null, label: null, note: null, checked: true };
}

// A指示 項目10/11「赤字成長企業の特例枠」「赤字成長・高リスク」判定。
//
//  テンバガー探索では「赤字だから除外」を緩和する（項目9: 成熟企業と
//  成長企業を同じ基準で評価しない）。指示書は以下9条件を挙げ「複数
//  満たせばTier A候補に残す」としていた。
//    1. 売上成長率+40%以上　2. 売上成長率>販管費成長率　3. 粗利率改善
//    4. 営業利益率改善　5. 営業CF赤字幅縮小　6. FCF赤字幅縮小
//    7. キャッシュ残高が十分　8. 有利子負債が過大ではない
//    9. 株式希薄化が過大ではない
//  実測（G-アクセルスペースホールディングス/402A、有報S100YYV1）で
//  1〜8は標準EDINETタグから計算できることを確認したが、9（株式希薄化）
//  は候補となる`NumberOfSharesIssuedSharesVotingRights`タグが同一書類内
//  に前期末の比較値を持たず、伸び率を計算できなかった（推測で埋めない
//  方針のため対象外。他の希薄化関連タグの実測は今後の課題）。
//
//  逆パターン（項目11）: 売上成長が高くても販管費が売上以上に伸び、
//  営業赤字が拡大している場合は「高成長」であって「ユニットエコノミクス
//  改善」ではないため、「赤字成長・高リスク」の警告フラグを立てる。
export const DEFICIT_GROWTH = {
  minGrowthPct: 40, // テンバガー候補(Tier A)の成長率閾値(TENBAGGER.minGrowthPct)と揃える
  minGoodChecks: 3, // 売上成長率+40%以上に加え、残り7条件のうち何個必要か
  minRunwayYears: 2, // キャッシュ残高が「十分」とみなす、営業CF赤字での残存年数の目安
};

// deficitGrowthSignal（粗利率/営業利益率改善の判定）とgrowthAcceleration
// Signal（同じ2項目を加速度合いのボーナスに使う、A指示項目7）の両方から
// 使う共通部分。当期・前期それぞれの比率（分子/分母）を比較し、改善して
// いればtrue・悪化していればfalse・データ不足ならnullを返す。
export function marginImproving(numerator, denominator, numeratorPrior, denominatorPrior) {
  const current = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
  const prior = Number.isFinite(numeratorPrior) && Number.isFinite(denominatorPrior) && denominatorPrior > 0 ? numeratorPrior / denominatorPrior : null;
  return current !== null && prior !== null ? current > prior : null;
}

export function deficitGrowthSignal({
  revenueGrowthPct, sgaGrowthPct,
  grossProfit, grossProfitPrior, netSales, netSalesPrior,
  operatingIncome, operatingIncomePrior,
  operatingCf, operatingCfPrior, capex, capexPrior,
  cash, interestBearingDebt, equity,
} = {}) {
  // この特例/警告は「現在赤字の成長企業」にのみ意味を持つ。黒字企業や
  // データ不足の場合は判定不能（null）として区別する。
  if (!Number.isFinite(operatingIncome) || operatingIncome >= 0 || !Number.isFinite(revenueGrowthPct)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const highGrowth = revenueGrowthPct >= DEFICIT_GROWTH.minGrowthPct;

  // 個別条件（データが無ければnull＝カウント対象外。false確定はしない）
  const sgaDiscipline = Number.isFinite(sgaGrowthPct) ? revenueGrowthPct > sgaGrowthPct : null;
  const grossMarginImproving = marginImproving(grossProfit, netSales, grossProfitPrior, netSalesPrior);
  const opMarginImproving = marginImproving(operatingIncome, netSales, operatingIncomePrior, netSalesPrior);
  const cfDeficitNarrowing = Number.isFinite(operatingCf) && Number.isFinite(operatingCfPrior) && operatingCf < 0 && operatingCfPrior < 0
    ? operatingCf > operatingCfPrior : null;
  const fcf = Number.isFinite(operatingCf) && Number.isFinite(capex) ? operatingCf + capex : null;
  const fcfPrior = Number.isFinite(operatingCfPrior) && Number.isFinite(capexPrior) ? operatingCfPrior + capexPrior : null;
  const fcfDeficitNarrowing = fcf !== null && fcfPrior !== null && fcf < 0 && fcfPrior < 0 ? fcf > fcfPrior : null;
  const cashSufficient = Number.isFinite(cash) && Number.isFinite(operatingCf) && operatingCf < 0
    ? cash / Math.abs(operatingCf) >= DEFICIT_GROWTH.minRunwayYears : null;
  const debtNotExcessive = Number.isFinite(interestBearingDebt) && Number.isFinite(equity) && equity > 0
    ? interestBearingDebt <= equity : null;

  const otherChecks = [sgaDiscipline, grossMarginImproving, opMarginImproving, cfDeficitNarrowing, fcfDeficitNarrowing, cashSufficient, debtNotExcessive];
  const goodCount = otherChecks.filter((c) => c === true).length + (highGrowth ? 1 : 0);
  const checkedCount = otherChecks.filter((c) => c !== null).length;

  // 項目11「赤字成長・高リスク」: 「営業利益率改善」（項目4、粗利改善等の
  // 効果で相対的にマシになったかを見る比率ベース）とは別に、絶対額での
  // 「営業赤字拡大」を見る。実測（402A）: 売上高成長率+58.1%に対し
  // 販管費成長率+77.5%と売上以上に伸び、営業損益は-24.95億円→-38.23億円
  // と絶対額では赤字が拡大している一方、売上規模の拡大で営業利益率
  // 自体は-157.3%→-152.4%とわずかに改善していた（比率ベースのopMargin
  // Improvingでは検知できないケース）。ユーザー提示の実例「営業赤字拡大」
  // は絶対額の拡大を指すため、opMarginImprovingとは別に判定する。
  const opLossWidening = Number.isFinite(operatingIncome) && Number.isFinite(operatingIncomePrior)
    ? operatingIncome < operatingIncomePrior : null;
  if (highGrowth && sgaDiscipline === false && opLossWidening === true) {
    return {
      level: 'bad', label: '赤字成長・高リスク', checked: true,
      note: `売上高成長率+${revenueGrowthPct}%に対し販管費成長率+${sgaGrowthPct}%と売上以上に膨らみ、営業損益は${Math.round(operatingIncomePrior).toLocaleString()}円→${Math.round(operatingIncome).toLocaleString()}円と赤字が拡大しています。「高成長」ではありますが、ユニットエコノミクスの改善は確認できません`,
    };
  }
  // 項目10「赤字成長特例」: 売上成長率+40%以上を必須とし、残り7条件の
  // うちminGoodChecks件以上が揃えばTier A候補として残す根拠にする。
  if (checkedCount === 0) return { level: null, label: null, note: null, checked: false };
  if (highGrowth && (goodCount - 1) >= DEFICIT_GROWTH.minGoodChecks) {
    const metLabels = [
      sgaDiscipline ? '販管費抑制' : null, grossMarginImproving ? '粗利率改善' : null,
      opMarginImproving ? '営業赤字幅縮小' : null, cfDeficitNarrowing ? '営業CF赤字幅縮小' : null,
      fcfDeficitNarrowing ? 'FCF赤字幅縮小' : null, cashSufficient ? 'キャッシュ十分' : null,
      debtNotExcessive ? '有利子負債は過大でない' : null,
    ].filter(Boolean);
    return {
      level: 'good', label: '赤字成長特例', checked: true,
      note: `売上高成長率+${revenueGrowthPct}%に加え、${metLabels.join('・')}を確認できました（${goodCount}/8条件）。赤字ですが、成長を維持しながら財務体質が改善に向かっている可能性があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// A指示 項目8「『異常成長』はボーナスで扱うが、異常値だから自動的に
// 1位にはしない」。成長率のスコア自体は既にgrowthAccelerationSignal/
// buildScorePartsのgrowthAccelBonusで上限クランプ済み（異常な伸び率でも
// 通常の高成長と同じ上限までしか加点されない設計）。ここではその上で
// 「必ず確認」と指示されていた項目のうち実データで検証可能なもの
// （前年同期の利益水準＝低いベースからの反動、特別損益・減損）を
// チェックし、本物の成長かベース効果/一時要因かを見分ける材料を表示する。
// M&A・会計要因・通期見通しは定型タグでは判定できない（決算短信の
// 文章解析が必要）ため対象外（推測で埋めない）。
export const GROWTH_ANOMALY = {
  minRevenueGrowthPct: 40, // TENBAGGER.minGrowthPctと同じ「高成長」の目安
  minProfitGrowthPct: 100, // 項目8の実例（利益+463%）のような「特に急な利益成長」の目安
  lowBaseMarginPct: 1, // 前期営業利益率がこれ未満（ほぼゼロ）なら「低いベース」とみなす
  // 第6優先改修（ユーザー報告「構造改革費用の反動」）: 前期の特別損益
  // （特別損失・減損中心）の絶対額が「一定額以上」かつ、当期がその
  // priorOneTimeReversalMaxRatio倍以下（=大幅縮小/消失）まで減っていれば
  // 「前期の一時的な特別損失が今期は無くなったことによる反動増益」の
  // 疑いとして扱う。「一定額以上」の絶対基準は銘柄規模で意味が変わり
  // すぎるため額そのものでは決めず、当期との比率だけで判定する
  // （新しいスコアではなく、既存のhasOneTimeItemと同じ「有無の判定」を
  // 前期側にも対称に適用しただけ）。
  priorOneTimeReversalMaxRatio: 0.5,
};

// 第6優先改修（ユーザー報告CASE E）: 旧実装は「売上高成長率+40%以上
// 『かつ』利益成長率+100%以上」の両方を満たさないとベース効果チェック
// 自体が発動しない（checked:falseのまま）AND条件だった。しかし前期利益が
// 極端に小さい（ほぼゼロ）銘柄は、売上高成長率が緩やか（+5%等）でも
// 利益だけが数百%跳ねることが多い（利益率はわずかな絶対額の変化でも
// 比率としては大きく動くため）。売上高側の異常成長は据え置きつつ、
// 利益側は単独でも閾値を超えていればベース効果・一時要因のチェックを
// 発動するようOR条件に緩和する（各チェック自体の閾値・判定式は不変）。
export function growthAnomalyCautionSignal({
  revenueGrowthPct, profitGrowthPct,
  operatingIncomePrior, netSalesPrior,
  extraordinaryIncome, extraordinaryLoss, impairmentLoss,
  // 第6優先改修（ユーザー報告「構造改革費用の反動」）追加分。
  extraordinaryIncomePrior, extraordinaryLossPrior, impairmentLossPrior,
} = {}) {
  const profitAnomalous = Number.isFinite(profitGrowthPct) && profitGrowthPct >= GROWTH_ANOMALY.minProfitGrowthPct;
  const revenueAnomalous = Number.isFinite(revenueGrowthPct) && revenueGrowthPct >= GROWTH_ANOMALY.minRevenueGrowthPct;
  const isAnomalous = profitAnomalous || revenueAnomalous;
  if (!isAnomalous) return { level: null, label: null, note: null, checked: false, reasonCodes: [] };

  const priorOpMarginPct = Number.isFinite(operatingIncomePrior) && Number.isFinite(netSalesPrior) && netSalesPrior > 0
    ? round1((operatingIncomePrior / netSalesPrior) * 100) : null;
  const lowPriorBase = priorOpMarginPct !== null ? Math.abs(priorOpMarginPct) < GROWTH_ANOMALY.lowBaseMarginPct : null;
  const oneTimeAmount = [extraordinaryIncome, extraordinaryLoss, impairmentLoss]
    .filter(Number.isFinite).reduce((sum, v) => sum + Math.abs(v), 0);
  const hasOneTimeItem = oneTimeAmount > 0;
  // 「前期特別損失の剥落」判定: 前期の特別損益の絶対額(priorOneTimeAmount)
  // が確認でき、かつ0より大きい場合だけ評価する（前期データが無ければ
  // 「反動が無い」と決めつけずUNKNOWN寄りに倒す＝下のchecked:false分岐へ）。
  const hasPriorOneTimeData = [extraordinaryIncomePrior, extraordinaryLossPrior, impairmentLossPrior].some(Number.isFinite);
  const priorOneTimeAmount = [extraordinaryIncomePrior, extraordinaryLossPrior, impairmentLossPrior]
    .filter(Number.isFinite).reduce((sum, v) => sum + Math.abs(v), 0);
  const priorOneTimeReversal = hasPriorOneTimeData && priorOneTimeAmount > 0
    && oneTimeAmount <= priorOneTimeAmount * GROWTH_ANOMALY.priorOneTimeReversalMaxRatio;

  const reasons = [];
  const reasonCodes = [];
  if (lowPriorBase) {
    reasons.push(`前期の営業利益率が${priorOpMarginPct}%とほぼゼロ水準で、そこからの伸び率は低い比較対象からの反動（ベース効果）の可能性があります`);
    reasonCodes.push('LOW_BASE_EFFECT');
  }
  if (hasOneTimeItem) {
    reasons.push(`特別損益・減損等の一時的な項目（合計${Math.round(oneTimeAmount).toLocaleString()}円）が計上されており、本業の成長とは別の要因が業績に影響している可能性があります`);
    reasonCodes.push('ONE_TIME_ITEM_CURRENT');
  }
  if (priorOneTimeReversal) {
    reasons.push(`前期に特別損益・減損等の一時的な項目（合計${Math.round(priorOneTimeAmount).toLocaleString()}円）が計上されていましたが、今期は大幅に縮小・消失しています。前期の一時的な費用が無くなったことによる反動増益の可能性があります`);
    reasonCodes.push('PRIOR_ONE_TIME_ITEM_REVERSAL');
  }

  // revenueGrowthPct/profitGrowthPctのどちらか一方だけが閾値超えの場合
  // （OR条件化、上記コメント参照）、もう一方はundefined/nullのことが
  // あるため、確認できた方だけを文章に含める（"undefined%"を出さない）。
  const growthParts = [
    Number.isFinite(revenueGrowthPct) ? `売上高成長率+${revenueGrowthPct}%` : null,
    Number.isFinite(profitGrowthPct) ? `利益成長率+${profitGrowthPct}%` : null,
  ].filter(Boolean).join('・');

  if (reasons.length) {
    return {
      level: 'warn', label: '異常成長・要確認', checked: true, reasonCodes,
      note: `${growthParts}という高い伸びですが、${reasons.join('。')}。「異常値だから無条件で高評価」にはせず、決算内容の確認をおすすめします`,
    };
  }
  // ベース効果・一時要因（当期・前期とも）のいずれも確認できなかった
  // 判定材料が無い（全てデータ不足）場合は、good/badどちらとも言えない
  // ためchecked:falseで区別する（推測でnull=異常無しと断定しない）。
  if (priorOpMarginPct === null && !hasOneTimeItem && !hasPriorOneTimeData
    && !Number.isFinite(extraordinaryIncome) && !Number.isFinite(extraordinaryLoss) && !Number.isFinite(impairmentLoss)) {
    return { level: null, label: null, note: null, checked: false, reasonCodes: [] };
  }
  return {
    level: 'good', label: '本物の成長（ベース効果なし）', checked: true, reasonCodes: ['ORGANIC_GROWTH'],
    note: `${growthParts}という高い伸びですが、前期の水準・特別損益・減損のいずれにも異常は確認されず、本業の実力による成長とみられます`,
  };
}

// 第6優先改修（ユーザー報告）: 「利益成長率が高い」だけでは、その利益が
// 実際の現金を伴っているかまでは分からない。既存のdeficitGrowthSignal
// （赤字企業のみ対象、operatingIncome<0が前提）・receivablesAnomaly
// Signal（売掛金の伸びが売上以上に異常な場合の文脈でのみ営業CFを参照）の
// どちらにも当てはまらない、「黒字で利益は伸びているが、営業キャッシュ・
// フローが伴っていない」ケースを検出する信号が無かったため新設する。
//
// ■ 検証したCASE（ユーザー指定）
// CASE A: 利益+10%・営業CF+10% → 整合(good)
// CASE B: 利益+100%・営業CFマイナス → 利益成長率だけで最高評価にしない(warn)
// CASE C: 利益+50%・営業CF改善 → 整合的に評価できる(good)
// CASE F: 営業利益増加・営業CF減少 → 「利益成長」と「キャッシュ面の注意」を両方保持(warn)
//
// operatingCf/operatingCfPrior/operatingCfGrowthPctは既にEDINETから
// deficitGrowthSignal/receivablesAnomalySignal向けに取得済みのため、
// この信号のために新規のデータ取得は発生しない。
export function earningsCashFlowQualitySignal({
  profitGrowthPct, operatingCf, operatingCfPrior, operatingCfGrowthPct,
  // 第6優先改修■4（ユーザー報告）: 営業CF→FCFまで拡張する。ただしFCF
  // 単独では判定せず「補助情報」として保持する（大型設備投資企業を
  // 機械的に低評価しないため。level/labelの判定基準はOCFのみのまま
  // 変更しない）。
  capex, capexPrior,
} = {}) {
  // 利益が伸びていない（横ばい・減益）銘柄には、この注意喚起自体が
  // 意味を持たない（deficitGrowthSignalと同じ「対象外はchecked:false」方針）。
  if (!Number.isFinite(profitGrowthPct) || profitGrowthPct <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const cfGrowth = Number.isFinite(operatingCfGrowthPct)
    ? operatingCfGrowthPct
    : (Number.isFinite(operatingCf) && Number.isFinite(operatingCfPrior) && operatingCfPrior !== 0
      ? round1(((operatingCf - operatingCfPrior) / Math.abs(operatingCfPrior)) * 100)
      : null);
  const cfNegative = Number.isFinite(operatingCf) && operatingCf < 0;
  if (cfGrowth === null && !cfNegative) return { level: null, label: null, note: null, checked: false };

  // FCF = 営業CF + 設備投資（capexは既に負の値。deficitGrowthSignalと
  // 同じ符号規約）。「FCFがマイナス＝悪い」と機械的に断定せず、補助
  // 情報としてfcf/fcfPriorを常に返すだけにする（大型投資中の成長企業は
  // FCFがマイナスでも正常なケースが多いため）。
  const fcf = Number.isFinite(operatingCf) && Number.isFinite(capex) ? operatingCf + capex : null;
  const fcfPrior = Number.isFinite(operatingCfPrior) && Number.isFinite(capexPrior) ? operatingCfPrior + capexPrior : null;
  const fcfNote = fcf !== null && fcf < 0
    ? '（参考: 設備投資を差し引いたFCFはマイナスです。大型投資中の可能性もあり、これ単独で悪材料とは判定していません）'
    : '';

  if (cfNegative) {
    return {
      level: 'warn', label: '利益成長・営業CFマイナス', checked: true, fcf, fcfPrior,
      note: `利益成長率+${profitGrowthPct}%に対し、営業キャッシュ・フローはマイナスです。会計上の利益ほど実際の現金は増えていない可能性があり、利益成長率だけで評価しないようご注意ください`,
    };
  }
  if (cfGrowth !== null && cfGrowth < 0) {
    return {
      level: 'warn', label: '利益成長・営業CF減少', checked: true, fcf, fcfPrior,
      note: `利益成長率+${profitGrowthPct}%に対し、営業キャッシュ・フローは前期比${cfGrowth}%と減少しています。利益の伸びほどキャッシュは増えていない可能性があります`,
    };
  }
  return {
    level: 'good', label: '利益成長・営業CFも整合', checked: true, fcf, fcfPrior,
    note: `利益成長率+${profitGrowthPct}%に対し、営業キャッシュ・フローも前期比+${cfGrowth}%と伴っており、利益成長がキャッシュの増加にも裏付けられています${fcfNote}`,
  };
}

// 「業績屈折(INFLECTION／ターンアラウンド)」セクション向け（ユーザー提案
// 2026-09-12）: 「なぜ前四半期は悪かったか」を、EDINETから既に抽出済みの
// 財務内訳（grossProfit/sga/operatingIncome/extraordinaryLoss/
// impairmentLoss、v7.6のextractBalanceSheetSnapshot拡張で追加済み）から
// 機械的に分類する。TDnetのタイトルからは「原価高」「販管費増」といった
// 定性的な要因が一切読み取れない（実測: tdnet_cache.jsonのタイトルに
// この種の言い回しはほぼ出てこない）ため、決算短信の本文を読まなくても
// 分かる「数字の内訳」だけで組み立てる。M&A・為替差損益等、EDINETの
// 標準タグからは追えない要因は対象外（推測で埋めない）。
export const INFLECTION_CAUSE = {
  marginDeltaPts: 1, // 粗利率がこのポイント以上悪化していれば「原価高」とみなす
  sgaGrowthThresholdPct: 10, // 販管費の伸び率がこれ以上なら「固定費増」とみなす
};

export function inflectionCauseSignal({
  netSales, netSalesPrior, grossProfit, grossProfitPrior,
  sgaGrowthPct, operatingIncome, operatingIncomePrior,
  extraordinaryLoss, impairmentLoss,
} = {}) {
  // 「営業減益」のときにのみ意味を持つ分析（減益していない銘柄に
  // 「なぜ悪かったか」を聞いても意味がない）。
  if (!Number.isFinite(operatingIncome) || !Number.isFinite(operatingIncomePrior) || operatingIncome >= operatingIncomePrior) {
    return { level: null, label: null, note: null, checked: false, causes: [] };
  }

  const grossMarginNow = Number.isFinite(grossProfit) && Number.isFinite(netSales) && netSales > 0 ? (grossProfit / netSales) * 100 : null;
  const grossMarginPrior = Number.isFinite(grossProfitPrior) && Number.isFinite(netSalesPrior) && netSalesPrior > 0 ? (grossProfitPrior / netSalesPrior) * 100 : null;
  const grossMarginWorsened = grossMarginNow !== null && grossMarginPrior !== null
    ? grossMarginPrior - grossMarginNow >= INFLECTION_CAUSE.marginDeltaPts : null;

  const causes = [];
  if (grossMarginWorsened) {
    causes.push({
      key: 'costPressure', label: '原価/原材料コスト増',
      note: `粗利率が${round1(grossMarginPrior)}%→${round1(grossMarginNow)}%に悪化`,
    });
  }
  if (Number.isFinite(sgaGrowthPct) && sgaGrowthPct >= INFLECTION_CAUSE.sgaGrowthThresholdPct) {
    causes.push({ key: 'fixedCostIncrease', label: '販管費増加', note: `販管費が前期比+${sgaGrowthPct}%` });
  }
  // 実測バグ（ユーザー指摘、2026-09-13）: extraordinaryLoss/impairmentLoss
  // はEDINETのXBRLタグ値そのまま（円単位。growthAnomalyCautionSignalの
  // 既存コード（本ファイル内）と同じ前提）なのに、ここでは変換せず末尾に
  // 「百万円」を結合していたため桁が100万倍ズレていた（実測: バロック
  // 「278,000,000百万円」＝278兆円、タマホーム「3,274,000,000百万円」
  // ＝3,200兆円という明らかにあり得ない金額が表示されていた）。カード
  // 内の他の金額表示（ハードル比率の必要利益等）は百万円単位のため、
  // 表記を統一するためここで円→百万円に変換する。
  const oneTimeAmountYen = [extraordinaryLoss, impairmentLoss].filter(Number.isFinite).reduce((sum, v) => sum + Math.abs(v), 0);
  if (oneTimeAmountYen > 0) {
    const oneTimeAmountMillionYen = oneTimeAmountYen / 1_000_000;
    causes.push({ key: 'oneTimeLoss', label: '特別損失/減損', note: `特別損失・減損等 計${Math.round(oneTimeAmountMillionYen).toLocaleString()}百万円` });
  }

  if (!causes.length) {
    return {
      level: null, label: '要因不明', checked: true, causes: [],
      note: '粗利率悪化・販管費増加・特別損失/減損のいずれにも該当しませんでした（機械的に判定できる範囲外の要因、または開示データ不足の可能性があります）',
    };
  }
  return {
    level: 'info', label: causes.map((c) => c.label).join('・'), checked: true, causes,
    note: causes.map((c) => c.note).join('。'),
  };
}

// 「業績屈折(INFLECTION)」セクション向け（ユーザー提案 2026-09-12）:
// 「何の対策が打たれたか（価格改定・合理化等）」の検出。
//
// 実測で確認済みの限界: TDnetの適時開示はタイトルしか保有しておらず
// （tdnet.mjsは本文PDFを取得しない）、直近14営業日の実データ2,520件を
// 「価格改定」「値上げ」「合理化」「コスト削減」等、ユーザー要望に沿って
// 類義語まで広げた26語で検索しても、ヒットはわずか4件（0.16%）・価格
// 改定系は0件だった。決算短信のタイトルは定型文（「◯◯年３月期第１
// 四半期決算短信」等）で、対策の中身は本文にしか書かれていないため。
// この実測結果を踏まえ、「ヒットすれば表示・ヒットしなくても正直に
// 『本文までは確認していません』と示す」設計にする（本文解析は新規の
// PDF取得・パース基盤が必要で今回のスコープ外）。
const PRICE_REVISION_KEYWORDS = [
  '価格改定', '値上げ', '値下げ', '価格転嫁', '価格見直し', '料金改定', '運賃改定', '出荷価格',
];
const RATIONALIZATION_KEYWORDS = [
  '合理化', 'コスト削減', '経費削減', '固定費削減', '原価低減', '構造改革', '事業再編', '業務効率化',
  '希望退職', '早期退職', '人員削減', '拠点統合', '拠点再編', '工場閉鎖', '生産体制', '収益改善', '収益構造',
];

export function turnaroundCountermeasureSignal(disclosures = []) {
  if (!Array.isArray(disclosures) || disclosures.length === 0) {
    return { level: null, label: null, note: null, checked: false, hits: [] };
  }
  const hits = [];
  for (const d of disclosures) {
    if (!d?.title) continue;
    if (PRICE_REVISION_KEYWORDS.some((k) => d.title.includes(k))) {
      hits.push({ date: d.date, title: d.title, category: '価格改定' });
    } else if (RATIONALIZATION_KEYWORDS.some((k) => d.title.includes(k))) {
      hits.push({ date: d.date, title: d.title, category: '合理化・コスト削減' });
    }
  }
  if (!hits.length) {
    return {
      level: null, label: null, checked: true, hits: [],
      note: '直近の適時開示タイトルからは対策（価格改定・合理化等）を確認できませんでした。決算短信・決算説明資料の本文までは確認していないため、対策が無いとは限りません',
    };
  }
  const categories = [...new Set(hits.map((h) => h.category))];
  return {
    level: 'good', label: categories.join('・'), checked: true, hits,
    note: hits.map((h) => `${h.date} 「${h.title}」`).join('。'),
  };
}

// ==================================================================
// 「業績屈折(SECTION D)」新スペック（ユーザー提案2026-09-12）。
//
// 旧isInflectionEligible（quarterYoy<=-10%かつ回復ギャップ>=10pt、
// または黒字転換）はユーザーの詳細仕様（①割安・財務レンジ、③1Q売上-
// 経常益スプレッド、④1Q進捗サプライズ、⑤次チェックポイントの
// ハードル比率）に完全置換する（ユーザー承認済み）。
//
// 「1Q/2Q/3Q/4Q…時期ごとに臨機応変に」（ユーザー要望）への対応:
// kabutan.mjsのparseCheckpointTrendが直近の公式チェックポイント
// （Q1時点なら対上期進捗率、中間期・Q3時点なら対通期進捗率）を
// そのまま読み取るため、ここではその区別を前提にせず、渡された値を
// そのまま計算するだけにする（四半期の判定ロジック自体はkabutan.mjs
// 側の責務）。
// ==================================================================

// ①割安・財務レンジ。「コア・スクリーニング条件」のうち、既存データ
// （kabutan.mjsのfetchMain/fetchFinance、indicators.mjsのevEbitda）
// だけで判定できるもの。各条件は「確認できて条件を満たす」場合のみ
// 通過とし、データが無い項目は「未確認」として区別する（推測でクリア
// 扱いにしない）。
export const CORE_SCREEN = {
  perMin: 8, perMax: 16,
  pbrMin: 0.5, pbrMax: 1.5,
  minDividendYield: 2.5,
  minRoe: 8,
  minEquityRatio: 40,
  maxDebtEquityRatio: 1.0, // 有利子負債倍率（＝有利子負債自己資本比率）100%以下
  maxEvEbitda: 10,
};

export function coreScreeningSignal({ per, pbr, dividendYield, roeHistory, equityRatio, debtEquityRatio, evEbitda } = {}) {
  // ROE判定（ユーザー提案2026-09-13の改良版、A案）: 直近期のROE単体だと
  // 「まさに今探している一時的な悪化」自体がROEを押し下げ、本来は稼ぐ力
  // のある実力企業まで弾いてしまう（実測: NISSHA(7915)は直近ROE0.87%）。
  // 「過去実績の平均ROE」または「会社予想ベースの今期予想ROE」の
  // どちらか一方が基準を満たせば良いとするOR条件にする（実測: タマホーム
  // (1419)は直近ROE3.8%でも通期予想ベースでは13.48%まで戻る）。
  const avgHistoricalRoe = roeHistory?.actualRoes?.length
    ? roeHistory.actualRoes.reduce((a, b) => a + b, 0) / roeHistory.actualRoes.length
    : null;
  const forecastRoe = Number.isFinite(roeHistory?.forecastRoe) ? roeHistory.forecastRoe : null;
  const roeChecked = Number.isFinite(avgHistoricalRoe) || forecastRoe !== null;
  const roeOk = roeChecked
    ? (Number.isFinite(avgHistoricalRoe) && avgHistoricalRoe >= CORE_SCREEN.minRoe) || (forecastRoe !== null && forecastRoe >= CORE_SCREEN.minRoe)
    : null;

  const checks = [
    { key: 'per', label: 'PER', ok: Number.isFinite(per) ? (per >= CORE_SCREEN.perMin && per <= CORE_SCREEN.perMax) : null, note: `PER${CORE_SCREEN.perMin}〜${CORE_SCREEN.perMax}倍` },
    { key: 'pbr', label: 'PBR', ok: Number.isFinite(pbr) ? (pbr >= CORE_SCREEN.pbrMin && pbr <= CORE_SCREEN.pbrMax) : null, note: `PBR${CORE_SCREEN.pbrMin}〜${CORE_SCREEN.pbrMax}倍` },
    { key: 'dividendYield', label: '配当利回り', ok: Number.isFinite(dividendYield) ? dividendYield >= CORE_SCREEN.minDividendYield : null, note: `配当利回り${CORE_SCREEN.minDividendYield}%以上` },
    { key: 'roe', label: 'ROE', ok: roeOk, note: `過去実績平均ROEまたは今期予想ROEが${CORE_SCREEN.minRoe}%以上` },
    { key: 'equityRatio', label: '自己資本比率', ok: Number.isFinite(equityRatio) ? equityRatio >= CORE_SCREEN.minEquityRatio : null, note: `自己資本比率${CORE_SCREEN.minEquityRatio}%以上` },
    { key: 'debtEquityRatio', label: '有利子負債倍率', ok: Number.isFinite(debtEquityRatio) ? debtEquityRatio <= CORE_SCREEN.maxDebtEquityRatio : null, note: `有利子負債倍率${CORE_SCREEN.maxDebtEquityRatio}倍(100%)以下` },
    { key: 'evEbitda', label: 'EV/EBITDA', ok: Number.isFinite(evEbitda) ? evEbitda <= CORE_SCREEN.maxEvEbitda : null, note: `EV/EBITDA${CORE_SCREEN.maxEvEbitda}倍以下` },
  ];
  const failed = checks.filter((c) => c.ok === false);
  const unchecked = checks.filter((c) => c.ok === null);
  const passed = failed.length === 0 && unchecked.length === 0;
  return {
    passed, checked: true, checks,
    failedReasons: failed.map((c) => `${c.label}が条件外`),
    uncheckedFields: unchecked.map((c) => c.label),
  };
}

// ③「1Qの利益だけ一時的に悪い」を抽出する売上－利益スプレッド
// （キラー指標①）。ordinaryProfitYoyがstate:'numeric'（プラスの数値
// として計算可能）の場合のみ判定する。「黒転」等の特殊状態は別軸
// （turnsProfitableとして checkpointTrend/nextMilestone 側で扱う）
// であり、無理にこの数値レンジに当てはめない。
export const INFLECTION_SPREAD = {
  minRevenueYoyPct: 0,
  minProfitYoyPct: -20, maxProfitYoyPct: 0,
  minSpreadPt: 10,
};

export function inflectionSpreadSignal({ revenueYoyPct, revenueYoyState, ordinaryProfitYoyPct, ordinaryProfitYoyState } = {}) {
  if (revenueYoyState !== 'numeric' || ordinaryProfitYoyState !== 'numeric') {
    return { level: null, value: null, checked: false, note: null };
  }
  const spread = round1(revenueYoyPct - ordinaryProfitYoyPct);
  const revenueOk = revenueYoyPct >= INFLECTION_SPREAD.minRevenueYoyPct;
  const profitOk = ordinaryProfitYoyPct >= INFLECTION_SPREAD.minProfitYoyPct && ordinaryProfitYoyPct <= INFLECTION_SPREAD.maxProfitYoyPct;
  const spreadOk = spread >= INFLECTION_SPREAD.minSpreadPt;
  const passed = revenueOk && profitOk && spreadOk;
  return {
    level: passed ? 'good' : null, value: spread, checked: true, passed,
    note: `1Q売上高YoY${revenueYoyPct >= 0 ? '+' : ''}${revenueYoyPct}% − 1Q経常益YoY${ordinaryProfitYoyPct >= 0 ? '+' : ''}${ordinaryProfitYoyPct}% ＝ スプレッド${spread >= 0 ? '+' : ''}${spread}pt`,
  };
}

// ④「1Qが実は悪くない」進捗サプライズ（キラー指標②）＝ 直近チェック
// ポイントの進捗率 − 過去の同時期平均進捗率。プラスなら「例年より
// 進捗が良い」ことを意味し、直近利益の見た目の悪さと矛盾する
// （＝一時的な悪化の裏付け）。
export function inflectionProgressSurpriseSignal({ progressPct, priorProgressPcts } = {}) {
  if (!Number.isFinite(progressPct) || !Array.isArray(priorProgressPcts) || !priorProgressPcts.length) {
    return { level: null, value: null, checked: false, note: null };
  }
  const avgPrior = round1(priorProgressPcts.reduce((a, b) => a + b, 0) / priorProgressPcts.length);
  const surprise = round1(progressPct - avgPrior);
  const passed = surprise > 0;
  return {
    level: passed ? 'good' : null, value: surprise, checked: true, passed,
    note: `今期の進捗率${progressPct}% − 過去${priorProgressPcts.length}年平均${avgPrior}% ＝ 進捗サプライズ${surprise >= 0 ? '+' : ''}${surprise}pt`,
  };
}

// 「下方修正リスク（未達のワナ）」の除外条件（ユーザー指摘、2026-09-13）:
// 旧ロジック（回復ギャップ＝forecastYoy-quarterYoyが大きい順）は「1Qで
// 85%減益なのに通期予想は+321%」のような、会社側の強気な予想が単に
// 据え置かれているだけで実態は未達濃厚な銘柄（実測: バロックジャパン
// 3548）まで「本物の屈折候補」として最上位に拾ってしまっていた。
// 今期の進捗率が過去実績から大きく下振れている（＝通期予想達成に
// 必要なペースを大きく下回っている）銘柄は、その通期予想自体が
// 「絵に描いた餅」で下方修正濃厚とみなし、キラー指標の該当数に関わらず
// 除外する（ハードな地雷除去。killerHitsのようなスコアリングではなく
// 除外条件にするのは、1件でも該当したら他がどれだけ良くても致命的な
// リスクだから）。
export const INFLECTION_DOWNSIDE_RISK = {
  maxProgressRatio: 0.7, // 今期進捗率が過去平均のこの倍率を下回ったら除外
};

export function inflectionDownsideRiskSignal({ progressPct, priorProgressPcts } = {}) {
  if (!Number.isFinite(progressPct) || !Array.isArray(priorProgressPcts) || !priorProgressPcts.length) {
    return { level: null, checked: false, ratio: null, note: null };
  }
  const avgPrior = round1(priorProgressPcts.reduce((a, b) => a + b, 0) / priorProgressPcts.length);
  if (avgPrior <= 0) return { level: null, checked: false, ratio: null, note: null };
  const ratio = round1(progressPct / avgPrior);
  const isRisky = ratio < INFLECTION_DOWNSIDE_RISK.maxProgressRatio;
  return {
    level: isRisky ? 'bad' : null, checked: true, ratio,
    note: isRisky
      ? `今期の進捗率${progressPct}%は過去平均${avgPrior}%の${Math.round(ratio * 100)}%しかなく、通期予想の達成に必要なペースを大きく下回っています（下方修正リスク大）`
      : `今期の進捗率${progressPct}%は過去平均${avgPrior}%の${Math.round(ratio * 100)}%で、極端な下振れは確認されません`,
  };
}

// ⑤次の公式チェックポイント（Q1時点なら中間期、中間期/Q3時点なら
// 通期）のハードル比率（キラー指標③）＝
//   (次の公式予想 − 直近チェックポイント実績)
//   ÷ 過去の「次の公式実績 − 過去のチェックポイント実績」平均
// 分子（必要利益）が過去の同区間平均実績に対してどれだけ低いかを見る
// （1.0倍以下＝過去の平均的な実績を出すだけで予想に届く＝ハードルが
// 低い）。過去の年度はチェックポイント実績・次の公式実績とも「古→新」
// の同じ並び順である前提で末尾から揃える（kabutan.mjsのparseCheckpoint
// Trend/parseNextMilestoneForecastは同じ会社の同じテーブル群から
// 取得するため、年度の並びは自然に一致する）。
export function inflectionHurdleRatioSignal({
  checkpointOrdinaryProfitActual, nextMilestoneForecastOrdinaryProfit,
  priorCheckpointOrdinaryProfitActuals, priorMilestoneOrdinaryProfitActuals,
} = {}) {
  if (!Number.isFinite(checkpointOrdinaryProfitActual) || !Number.isFinite(nextMilestoneForecastOrdinaryProfit)) {
    return { level: null, value: null, checked: false, note: null };
  }
  const requiredProfit = nextMilestoneForecastOrdinaryProfit - checkpointOrdinaryProfitActual;
  if (!Array.isArray(priorCheckpointOrdinaryProfitActuals) || !Array.isArray(priorMilestoneOrdinaryProfitActuals)) {
    return { level: null, value: null, checked: false, note: null, requiredProfit };
  }
  const n = Math.min(priorCheckpointOrdinaryProfitActuals.length, priorMilestoneOrdinaryProfitActuals.length);
  const segmentProfits = [];
  for (let i = 1; i <= n; i++) {
    const cp = priorCheckpointOrdinaryProfitActuals.at(-i);
    const ms = priorMilestoneOrdinaryProfitActuals.at(-i);
    if (Number.isFinite(cp) && Number.isFinite(ms)) segmentProfits.push(ms - cp);
  }
  if (!segmentProfits.length) return { level: null, value: null, checked: false, note: null, requiredProfit };
  const avgSegmentProfit = segmentProfits.reduce((a, b) => a + b, 0) / segmentProfits.length;
  // 過去の該当区間が平均で赤字/ゼロ以下だと比率の符号が意味を持たない
  // （他のpct系関数と同じ「分母が正のときだけ計算する」ガード）。
  if (avgSegmentProfit <= 0) {
    return { level: null, value: null, checked: false, requiredProfit, avgSegmentProfit, note: '過去の該当区間の平均実績が赤字/ゼロ以下のため比率は算出しません' };
  }
  const ratio = round1(requiredProfit / avgSegmentProfit);
  const passed = ratio <= 1.0;
  return {
    level: passed ? 'good' : null, value: ratio, checked: true, passed, requiredProfit, avgSegmentProfit,
    note: `必要利益${Math.round(requiredProfit).toLocaleString()}百万円 ÷ 過去${segmentProfits.length}年平均${Math.round(avgSegmentProfit).toLocaleString()}百万円 ＝ ハードル比率${ratio}倍`,
  };
}

// 「業績屈折」の2パターン分類（ユーザー提案2026-09-13）。当初は
// 「1Q経常益YoYがマイナス」を必須条件にする案も検討したが、実データ
// 検証で唯一該当した未来工業(7931)は1Q経常益+32.6%と実際には増益
// していた銘柄だった。ハードすることで「1Qが強すぎるのに会社予想が
// 保守的すぎて上方修正が確実な神銘柄」まで弾いてしまうのは勿体ない
// （ユーザー判断）ため、除外はせず2つのストーリー型にラベル分けする。
//   V字回復型: 1Q経常益YoYが実際にマイナス（悪化→回復のシナリオ）。
//   上方修正本命型: 1Q経常益YoYはプラスだが、次の公式チェックポイント
//     に対するハードル比率が低い（会社予想が保守的すぎて上方修正
//     濃厚というシナリオ）。
export const INFLECTION_PATTERN = {
  guidanceConservativeMaxHurdleRatio: 0.8,
};

export function inflectionPatternType({ ordinaryProfitYoyState, ordinaryProfitYoyPct, hurdleRatioValue } = {}) {
  if (ordinaryProfitYoyState === 'turned_profitable') {
    return { type: 'v_turnaround', label: '🔄 V字回復型', note: '前期は赤字だったが、黒字に転換しました' };
  }
  if (ordinaryProfitYoyState === 'numeric' && ordinaryProfitYoyPct < 0) {
    return { type: 'v_turnaround', label: '🔄 V字回復型', note: `1Q経常益が前年比${ordinaryProfitYoyPct}%と悪化しましたが、回復シナリオが確認できています` };
  }
  const profitGrowing = (ordinaryProfitYoyState === 'numeric' && ordinaryProfitYoyPct >= 0)
    || ordinaryProfitYoyState === 'multiple';
  if (profitGrowing
    && Number.isFinite(hurdleRatioValue) && hurdleRatioValue <= INFLECTION_PATTERN.guidanceConservativeMaxHurdleRatio) {
    return {
      type: 'guidance_conservative', label: '🚀 上方修正本命型',
      note: `1Q経常益は前年比+${ordinaryProfitYoyPct}%と好調なのに、次の公式予想に対するハードル比率が${hurdleRatioValue}倍と低く、会社予想が保守的すぎる（上方修正の可能性がある）と考えられます`,
    };
  }
  return { type: null, label: null, note: null };
}

// ⑤ 出遅れ修正（セクターローテーション、複数日トレンド版）
//
//  既存の sectorMomentumSignal は「今日1日」の業種騰落率としか比べない。
//  こちらは sector_history.mjs に積み上がった業種の直近複数営業日の
//  累積騰落率を見て、「業種は既に反発トレンドに入っているのに、
//  この銘柄はまだ値動きに反映されていない」出遅れを判定する。
//  履歴が足りない（仕組みを入れてから日数が浅い）うちはnullを返す。
export const SECTOR_ROTATION = { trendDays: 5, sectorMinPct: 3 };

export function sectorRotationSignal({ sectorTrendPct, kairi, cross } = {}) {
  if (sectorTrendPct === null || sectorTrendPct === undefined) return { level: null, label: null, note: null };
  if (sectorTrendPct < SECTOR_ROTATION.sectorMinPct) return { level: null, label: null, note: null };
  const stockNotYetTurned = (kairi !== null && kairi !== undefined && kairi < 0) || (cross ? cross.crossed !== true : true);
  if (!stockNotYetTurned) return { level: null, label: null, note: null };
  return {
    level: 'good', label: '出遅れ修正待ち',
    note: `同業種は直近${SECTOR_ROTATION.trendDays}営業日で+${sectorTrendPct}%と既に反発トレンドに入っていますが、この銘柄はまだ値動きに反映されていません。業種全体に資金が向かえば遅れて買われる可能性があります`,
  };
}

// ⑥ 個人投資家による期待の織り込み（retailExpectationSignal）
//
//  「決算が良さそう」「先行材料が良い」（＝これから起こりうる好材料への
//  期待）と、「その期待が既に株価に反映されているか」は別の軸である。
//  好材料があっても、株価が既に個人投資家の期待で大きく買われていれば、
//  決算発表そのものが「材料出尽くし」の売り材料になりかねない。
//
//  信用買い残（kabutanの週次信用残）は個人投資家中心のデータであり、
//  機関投資家の売買とは投資主体が異なる（karauri.mjsの空売り・IR Bankの
//  大株主構成とは別の切り口）。「株価上昇」だけでは誰が買っているか
//  分からないが、「株価上昇 かつ 信用買い残の増加」が揃って初めて
//  「個人投資家の期待が株価に織り込まれつつある」と言える、というのが
//  この関数の核心の考え方。株価だけ急騰していて信用買い残が伴わない
//  場合（大口・機関投資家主導とみられる値動き）は、個人投資家による
//  織り込みとは別物として扱い、この信号では強く警戒しない。
//
//  ambushConviction/smartEntryConvictionでは「重要な減点要素」として
//  扱う（AMBUSH_PENALTY_FIELDS参照）。CHIP_SIGNAL_FIELDSにも含めるため、
//  level:'bad'は既存のworsen-onlyパターンにより自動的に「買い推奨」から
//  外れる（ambushVerdict/smartEntryVerdictの配線を新たに書く必要はない）。
export const RETAIL_EXPECTATION = {
  moderateReturn1m: 7, bigReturn1m: 15,
  moderateCreditTrend: 8, bigCreditTrend: 20,
  highLevelPct: 80,
  bigVolRatio: 2,
  nearEarningsDays: 10,
};

export function retailExpectationSignal({
  return1w, return1m, priceLevelPct, volRatio,
  creditTrendPct, creditWeek1Pct, daysToEarnings,
} = {}) {
  const c = RETAIL_EXPECTATION;
  // 株価・信用買い残のどちらも判定材料が無ければ判定不能（推測しない）。
  if (!Number.isFinite(return1m) && !Number.isFinite(creditTrendPct)) {
    return { level: null, label: null, note: null, checked: false };
  }

  const priceModerate = Number.isFinite(return1m) && return1m >= c.moderateReturn1m;
  const priceStrong = Number.isFinite(return1m) && return1m >= c.bigReturn1m;
  const creditModerate = Number.isFinite(creditTrendPct) && creditTrendPct >= c.moderateCreditTrend;
  const creditStrong = Number.isFinite(creditTrendPct) && creditTrendPct >= c.bigCreditTrend;
  const nearHigh = Number.isFinite(priceLevelPct) && priceLevelPct >= c.highLevelPct;
  const volumeUp = Number.isFinite(volRatio) && volRatio >= c.bigVolRatio;
  const earningsNear = Number.isFinite(daysToEarnings) && daysToEarnings >= 0 && daysToEarnings <= c.nearEarningsDays;

  const fmtPct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : 'N/A');
  const detail = `1ヶ月${fmtPct(return1m)}(1週間${fmtPct(return1w)}) / 信用買い残4週比${fmtPct(creditTrendPct)}(前週比${fmtPct(creditWeek1Pct)}) / `
    + `3ヶ月高値圏位置${Number.isFinite(priceLevelPct) ? `${priceLevelPct}%` : 'N/A'} / `
    + `決算まで${Number.isFinite(daysToEarnings) ? `${daysToEarnings}日` : 'N/A'}`;

  // 核心の組み合わせ：株価上昇 かつ 信用買い残増加が揃って初めて
  // 「個人投資家の期待が織り込まれつつある」と言える（どちらか一方
  // だけでは判断しない）。
  const combo = priceModerate && creditModerate;

  if (combo && priceStrong && creditStrong && (nearHigh || earningsNear || volumeUp)) {
    const why = earningsNear ? '決算直前の急騰' : nearHigh ? '高値圏での急騰' : '出来高急増を伴う急騰';
    return {
      level: 'bad', label: '期待先行・織り込み大', checked: true,
      note: `${detail}。株価急騰と信用買い残急増が重なった${why}で、決算で好材料が出ても「材料出尽くし」で下落するリスクが高い状態です`,
    };
  }
  if (combo) {
    return {
      level: 'warn', label: '期待織り込みあり', checked: true,
      note: `${detail}。株価上昇と信用買い残増加が同時に進んでおり、好材料への期待はある程度株価に反映されつつあります`,
    };
  }
  if (priceModerate || creditModerate) {
    // 株価と信用買い残のどちらか一方しか動いていない状態。特に「株価だけ
    // 急騰し信用買い残が伴わない」ケースは大口・機関投資家主導の値動きが
    // 疑われ、個人投資家の期待織り込みとは別物として扱う（強く警戒しない）。
    const why = priceModerate && !creditModerate
      ? '株価は上昇していますが信用買い残は伴っておらず、個人投資家主体の織り込みとは言い切れません（大口・機関投資家主導の値動きの可能性があります）'
      : '信用買い残は増加していますが株価は大きく動いておらず、様子見の域です';
    return { level: 'warn', label: '期待織り込みの兆し', checked: true, note: `${detail}。${why}` };
  }
  return {
    level: null, label: '未織り込み', checked: true,
    note: `${detail}。株価・信用買い残ともに大きな動きが無く、好材料への期待はまだ株価に織り込まれていません`,
  };
}

// ==================================================================
// カタリスト予兆 — 「材料が出てから買う」のではなく「材料が出るしか
// ない財務状況」を先回りして拾う（ユーザー提案）。いずれも公開データ
// （EDINET/kabutan）のみに基づく客観的な予兆で、内部情報は使わない。
// ==================================================================

// ⑦ 進捗率の連続上振れ（決算の「クセ」が良化している予兆）
//
//  kabutan決算ページの進捗率テーブルは、同じ相対四半期（例: 毎年2〜4月期）
//  の実績が年ごとに並ぶ構成（pickLatestActualと同じ表）。異なる四半期
//  どうしを比べると季節性が混ざるため、必ず「同じ時期どうし」を年で
//  比較する。直近2年以上にわたって進捗率が上昇し続けていれば、業績の
//  上振れ基調が続いていると考えられる（次の決算も上振れる保証はないが、
//  単発の好決算より再現性のある予兆）。
export const PROGRESS_STREAK = { minStreak: 2 };

// 「同じ時期（history.at(-1)）」と「その1年前（history.at(-2)）」の経常益
// （profit）を比べたYoY成長率。progressStreakSignal専用に埋め込んで
// いたロジックを、仕込み妙味スコア（repricingLagScore）のprofitGrowthPct
// 入力としても再利用できるよう独立関数として切り出した（連続上昇の
// streak条件とは無関係に、historyが2件以上あれば常に計算できる）。
// 営業赤字→黒字転換等、前年が0以下だと%が定義できないためnullを返す。
export function latestProfitYoyPct(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const latest = history.at(-1);
  const prev = history.at(-2);
  return Number.isFinite(latest?.profit) && Number.isFinite(prev?.profit) && prev.profit > 0
    ? round1(((latest.profit - prev.profit) / prev.profit) * 100)
    : null;
}

export function progressStreakSignal(history) {
  if (!Array.isArray(history) || history.length === 0) return { level: null, label: null, note: null, checked: false };
  if (history.length < 2) return { level: null, label: null, note: null, checked: true }; // 1件だけでは連続と言えない
  // points = 連続して上昇している区間に含まれるデータ点数。「N年連続で
  // 上昇」の“N”は上昇（増加）が起きた回数＝points-1であり、点数そのもの
  // ではない（3点(19.8→37.2→91.7)は上昇が2回＝「2年連続」が正しい）。
  let points = 1;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].progress > history[i - 1].progress) points++;
    else break;
  }
  const increases = points - 1;
  if (increases < PROGRESS_STREAK.minStreak) return { level: null, label: null, note: null, checked: true };
  const latest = history.at(-1);
  const trail = history.slice(-points).map((h) => `${h.period}:${h.progress}%`).join('→');
  const profitYoyPct = latestProfitYoyPct(history);
  // 実測（あさひ3333）: 進捗率は加速していても経常利益が前年同期比マイナス
  // というケースがある（今期の会社予想自体が前年実績より低く設定されて
  // いる可能性）。この場合は「業績の上振れ基調」と言い切れないため、
  // goodのまま前向きな結論を出さずwarnに格下げし、文言もその旨に変える。
  if (profitYoyPct !== null && profitYoyPct < 0) {
    return {
      level: 'warn', label: '進捗率は加速も利益は前年割れ', checked: true, profitYoyPct,
      note: `同じ時期（${latest.label}）の進捗率は${increases}年連続で上昇しています（${trail}）が、経常利益は前年同期比${profitYoyPct}%と減益です。今期の会社予想自体が前年実績より低く設定されている可能性があり、進捗率の見た目ほど強気の材料ではないかもしれません`,
    };
  }
  return {
    level: 'good', label: '進捗率が加速中', checked: true, profitYoyPct,
    note: `同じ時期（${latest.label}）の進捗率が${increases}年連続で上昇しています（${trail}）。業績の上振れ基調が続いており、次の決算でも好材料が出る可能性があります${profitYoyPct !== null ? `（経常利益は前年同期比+${profitYoyPct}%）` : ''}`,
  };
}

// ⑧ 株主還元ポテンシャル（初配・増配・自社株買いの予兆）
//
//  無配のまま利益剰余金（内部留保）が時価総額に対して大きく積み上がって
//  いる銘柄は、IPO後の投資フェーズが一巡すると株主還元（初配・自社株
//  買い）に転じる余地が大きい。配当利回りが0%であることを「無配」の
//  確認に使うため、dividendYieldが取得できていない場合と無配の場合を
//  区別する（未取得を無配と誤認しない）。
export const DIVIDEND_POTENTIAL = { retainedEarningsRatio: 0.2 };

export function dividendPotentialSignal({ retainedEarnings, marketCap, dividendYield } = {}) {
  if (![retainedEarnings, marketCap, dividendYield].every(Number.isFinite) || marketCap <= 0 || retainedEarnings <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const ratio = round1((retainedEarnings / marketCapYen(marketCap)) * 100);
  if (dividendYield === 0 && ratio >= DIVIDEND_POTENTIAL.retainedEarningsRatio * 100) {
    return {
      level: 'good', label: '初配・株主還元期待', checked: true,
      note: `無配のまま利益剰余金が時価総額の${ratio}%まで積み上がっています。投資フェーズが一巡すれば、初配や自社株買いに動く余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑨ 含み資産アラート（投資有価証券の売却益・特別利益の予兆）
//
//  投資有価証券（政策保有株・持ち合い株等）を時価総額に対して大きく
//  保有している銘柄は、東証のPBR改善要請もあり、売却して特別利益を
//  計上する余地がある。決算直前に利益を捻出する目的で売却されることも
//  ある「隠れ資産」。
export const HIDDEN_ASSET = { ratio: 0.3 };

export function hiddenAssetSignal({ investmentSecurities, marketCap } = {}) {
  if (![investmentSecurities, marketCap].every(Number.isFinite) || marketCap <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const mcYen = marketCapYen(marketCap);
  const ratio = round1((investmentSecurities / mcYen) * 100);
  if (investmentSecurities / mcYen >= HIDDEN_ASSET.ratio) {
    return {
      level: 'good', label: '含み資産あり', checked: true,
      note: `投資有価証券（政策保有株等）が時価総額の${ratio}%あります。東証のPBR改善要請もあり、売却して特別利益を計上する余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑩ 信用買い占有率（浮動株に対する信用買い残の重さ。ユーザー提案）
//
//  信用買い残の「絶対数」だけでは需給の軽重が分からない（同じ100万株
//  でも、浮動株1,000万株の銘柄と200万株の銘柄では意味が全く違う）。
//  IR Bank（irbank.mjs）の大株主上位3名の合計保有比率を使い、
//  「発行済株式数 × (1 - 上位3株主保有比率)」を浮動株数の概算として、
//  信用買い残との比率を見る。
//
//  ■ 近似であることの注意
//  本来の「浮動株比率」は東証が自己株式・役員持株・上位10大株主等を
//  除いて算出する公式指標だが、そのデータは無料では取得できない。
//  ここでは上位3株主（IR Bank大株主一覧）だけを控除する簡易な近似值
//  であり、実際の浮動株比率より甘め（大きめ）に出る傾向がある点に注意。
//  creditBuyBalance（信用買い残）とsharesOutstanding（発行済株式数）は
//  どちらもkabutan由来で単位「株」（marketCapのような単位換算は不要。
//  実データで確認済み: 6336は信用買い残475,100株・発行済株式数
//  8,176,452株で桁が整合している）。
//
//  ■ marginOverhangSignal（信用倍率）との矛盾チェック（実測で発覚）
//  occupancy（浮動株に対する信用買いの「絶対量」）が小さくても、既存の
//  信用買いの買い/売り比率（信用倍率）が極端に偏っていれば、その買い方は
//  一方向に積み上がっていて利益確定売りに押されやすい。実測でサムコ
//  (6387,信用倍率83.09倍)・神戸物産(3038,16.26倍)・Japan Eyewear
//  Holdings(5889,1872倍)がoccupancy的には「軽い」のに信用倍率は「過多」
//  という正反対の判定になっていた。loanRatioがMARGIN_OVERHANG.heavy以上
//  の場合は「軽い」と言い切らずwarnに格下げする。
export const CREDIT_FLOAT = { heavy: 20, light: 5 };

// 浮動株比率の近似計算（発行済株式数から上位3株主の保有分を控除する）。
// creditFloatSignal（信用買い残との組み合わせ）とfloatSqueezeSignal
// （出来高急増との組み合わせ、ユーザー提案）の両方から使う共通部分を
// 切り出したもの。
export function computeFloatRatio({ sharesOutstanding, top3PctNow } = {}) {
  if (![sharesOutstanding, top3PctNow].every(Number.isFinite) || sharesOutstanding <= 0) return null;
  const floatRatio = 1 - top3PctNow / 100;
  return floatRatio > 0 ? floatRatio : null; // 上位株主データが異常（発行済株式数を超過）
}

// 第7優先改修（ユーザー報告）: 推定浮動株数(computeFloatRatio)は
// 「発行済株式数×(1-上位3株主保有比率)」という近似値で、上位3株主の
// 保有比率が高い銘柄ほど分母（浮動株数）が小さくなり、信用買い残が
// 同じでも占有率(occupancy)の値が敏感に・不安定に動く（推定精度が
// 落ちる）。何%以上なら不正確、という新しい閾値をバックテスト無しで
// 作ることはしないが、「この占有率の推定精度は低い」という事実は
// 隠さずnoteに明記する（top3PctNowが高い＝残りの浮動株の絶対数が
// 少ないほど、推定誤差の影響が相対的に大きくなるため）。
const FLOAT_ESTIMATE_LOW_PRECISION_TOP3PCT = 70; // 上位3株主保有比率がこれ以上なら注記を添える（既存のMAJOR_SHAREHOLDER.thinFloatPct=20とは別の目的の値のため、新設だが新たな加点/除外条件ではなく注記専用）
export function creditFloatSignal({ creditBuyBalance, sharesOutstanding, top3PctNow, loanRatio } = {}) {
  if (!Number.isFinite(creditBuyBalance)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const floatRatio = computeFloatRatio({ sharesOutstanding, top3PctNow });
  if (floatRatio === null) return { level: null, label: null, note: null, checked: false };
  const floatingShares = sharesOutstanding * floatRatio;
  const occupancy = round1((creditBuyBalance / floatingShares) * 100);
  const lowPrecision = Number.isFinite(top3PctNow) && top3PctNow >= FLOAT_ESTIMATE_LOW_PRECISION_TOP3PCT;
  const precisionNote = lowPrecision
    ? `（上位3株主保有比率${top3PctNow}%と高く、推定浮動株数の分母が小さいため、この占有率の推定精度は低めです）`
    : '';
  const basis = `信用買い残${Math.round(creditBuyBalance).toLocaleString()}株 ÷ 推定浮動株数${Math.round(floatingShares).toLocaleString()}株（発行済株式数から上位3株主の保有分${top3PctNow}%を控除した近似値）${precisionNote}`;
  // occupancyはlevelがgood/badに達しない中間域でもワンポイント表示
  // （precursorCardの需給バッジ）に使うため、level問わず常に返す。
  if (occupancy >= CREDIT_FLOAT.heavy) {
    return {
      level: 'bad', label: '信用買い占有率が高い', checked: true, occupancy, lowPrecision,
      note: `${basis}＝${occupancy}%。浮動株に対して信用買いが積み上がっており、好材料が出ても上値が重く飛びにくい状態です`,
    };
  }
  if (occupancy <= CREDIT_FLOAT.light) {
    if (Number.isFinite(loanRatio) && loanRatio >= MARGIN_OVERHANG.heavy) {
      return {
        level: 'warn', label: '需給判断に注意', checked: true, occupancy, lowPrecision,
        note: `${basis}＝${occupancy}%と浮動株に対する信用買いの絶対量は少ないですが、信用倍率${loanRatio}倍と買い方に極端に偏っており、含み益確定売りの重さを考えると「需給が軽い」とは言い切れません`,
      };
    }
    return {
      level: 'good', label: '需給が軽い', checked: true, occupancy, lowPrecision,
      note: `${basis}＝${occupancy}%。浮動株に対して信用買いが少なく、好材料が出れば一気に動きやすい「軽い」需給です`,
    };
  }
  return { level: null, label: null, note: null, checked: true, occupancy, lowPrecision };
}

// 浮動株比率×出来高急増（ユーザー提案）。creditFloatSignalは信用買い残
// との組み合わせだが、こちらは「株主が固定されて市場に出回る株が少ない
// ところに買いが集まると値動きが跳ねやすい」という別の組み合わせ。
// テンバガー候補のランキング補正用の加点シグナル（除外条件ではない）。
export const FLOAT_SQUEEZE = { maxFloatRatioPct: 40, minVolumeRatio: 2 };

export function floatSqueezeSignal({ floatRatio, volumeRatio } = {}) {
  if (![floatRatio, volumeRatio].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const floatRatioPct = round1(floatRatio * 100);
  if (floatRatioPct <= FLOAT_SQUEEZE.maxFloatRatioPct && volumeRatio >= FLOAT_SQUEEZE.minVolumeRatio) {
    return {
      level: 'good', label: '浮動株が少なく出来高急増', checked: true,
      note: `推定浮動株比率${floatRatioPct}%と少ない中、出来高が20日平均の${volumeRatio}倍に急増しています。株主が固定されており市場に出回る株が少ないため、買いが集まった際の値動きが大きくなりやすい状態です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// 高値圏×出来高急増（順張りブレイクアウト、ユーザー提案）。既存の
// repricingLagScore（乖離度が大きい＝織り込み済みという逆張り寄りの
// 解釈）とは正反対の軸のため、両方を表示する場合はどちらの話か分かる
// ツールチップを必ず付ける（SCORE/妙味スコアの混同を防いだのと同じ
// 処方）。テンバガー候補のランキング補正用の加点シグナル。
export const BREAKOUT_VOLUME = { minPriceLevelPct: 90, minVolumeRatio: 2 };

export function breakoutVolumeSignal({ priceLevelPct, volumeRatio } = {}) {
  if (![priceLevelPct, volumeRatio].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (priceLevelPct >= BREAKOUT_VOLUME.minPriceLevelPct && volumeRatio >= BREAKOUT_VOLUME.minVolumeRatio) {
    return {
      level: 'good', label: '出来高急増のブレイクアウト', checked: true,
      note: `直近レンジ内の位置${priceLevelPct}%（高値圏）で、出来高が20日平均の${volumeRatio}倍に急増しています。順張り・高値更新型のシグナルです。上部の仕込みゾーン（妙味スコア）とは別軸の判定で、乖離度が大きいこと自体は妙味スコアでは減点材料になりますが、出来高を伴う高値更新は別の意味でポジティブなシグナルです`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ==================================================================
// 第9優先改修（ユーザー提案）: 既存のSUPPLY_CREDIT（信用倍率・信用買い
// 残の「残高の絶対量」中心の判定）を、「残高×価格×出来高の変化」を見る
// 判定へ拡張する。marginOverhangSignal/creditFloatSignal/shortSqueeze
// Signal等の既存の判定・閾値は一切変更しない（並行の観測レイヤーとして
// 追加する）。まず観測・表示・検証を完成させ、バックテストを見てから
// SCOREへの加点を検討する（ユーザー方針。今回はスコア変更を一切含まない）。
// ==================================================================

// Phase1 ①信用買残の「重さ」＝ 信用買残を、普段の出来高・売買代金で
// 何日かけて消化できるかを実数で示す。信用倍率という比率ではなく、
// 銘柄ごとの流動性差を直接反映する絶対量の指標。0.5日/1日/2日のような
// 固定閾値でのスコア化は行わない（銘柄ごとの流動性差が大きいため、
// 帯分けは表示側の裁量とする、というユーザー方針）。
export const CREDIT_BUY_PRESSURE = { avgDays: 20 };

export function creditBuyPressureDays({ creditBuyBalance, price, closes, volumes } = {}) {
  const n = CREDIT_BUY_PRESSURE.avgDays;
  if (!Number.isFinite(creditBuyBalance) || !closes || !volumes || closes.length < n || volumes.length < n) {
    return { days: null, valueDays: null, checked: false, note: null };
  }
  const recentCloses = closes.slice(-n), recentVols = volumes.slice(-n);
  const avgVolume = recentVols.reduce((a, b) => a + (b ?? 0), 0) / n;
  const avgValueYen = recentCloses.reduce((sum, c, i) => sum + c * (recentVols[i] ?? 0), 0) / n;
  if (avgVolume <= 0) return { days: null, valueDays: null, checked: false, note: null };
  const days = round2(creditBuyBalance / avgVolume);
  const valueDays = (avgValueYen > 0 && Number.isFinite(price)) ? round2((creditBuyBalance * price) / avgValueYen) : null;
  return {
    days, valueDays, checked: true,
    note: `信用買残${Math.round(creditBuyBalance).toLocaleString()}株 ÷ ${n}日平均出来高${Math.round(avgVolume).toLocaleString()}株 ＝ ${days}日分`,
  };
}

// Phase2 ②「株価×信用買残」4パターン（ユーザー提案）。直近の信用残
// 発表とその1回前を比較し、株価変化と信用買い残変化の組み合わせで
// 需給の状態を分類する。priceChangePctはreturn1w（既存、returnPct(closes,5)
// ＝5営業日≒週次の信用残発表間隔に対応、screener.mjs/smart_entry.mjsで
// 既に計算済み）、buyChangePctはcreditTrend(weekly,1)（既存）をそのまま
// 渡す想定で、新規のデータ取得は発生しない。0%以上を「上昇/増加」、
// 負を「下落/減少」として扱う（境界の曖昧さを残さないための決め）。
// この時点ではgood/bad等のlevelは付けない（4パターンのどれが望ましい
// かはSCORE/クラスタへの統合方針とセットで決める話のため、Phase2では
// 分類のみ行い、価値判断はPhase5に委ねる）。
export const CREDIT_PATTERN = {
  CLEANUP: { label: '買残整理', note: '株価が下落する中で信用買い残も減少しています。信用整理が進んでいる状態です' },
  OVERHANG_BUILDUP: { label: '買残積み上がり', note: '株価が下落しているのに信用買い残が増加しています。将来の戻り売り圧力（オーバーハング）が積み上がっている可能性があります' },
  SUPPLY_IMPROVING: { label: '需給改善', note: '株価が上昇する中で信用買い残が減少しています。信用整理と株価上昇が同時に進む、需給が改善しやすい状態です' },
  LEVERAGED_RISE: { label: '買残増加上昇', note: '株価上昇と同時に信用買い残も増加しています。信用買いに支えられた上昇のため、反落時に売り圧力に転じやすい点に注意が必要です' },
};

export function creditPatternSignal({ priceChangePct, buyChangePct } = {}) {
  if (!Number.isFinite(priceChangePct) || !Number.isFinite(buyChangePct)) {
    return { pattern: null, label: null, note: null, checked: false };
  }
  const priceUp = priceChangePct >= 0;
  const buyUp = buyChangePct >= 0;
  const pattern = priceUp
    ? (buyUp ? 'LEVERAGED_RISE' : 'SUPPLY_IMPROVING')
    : (buyUp ? 'OVERHANG_BUILDUP' : 'CLEANUP');
  const def = CREDIT_PATTERN[pattern];
  return {
    pattern, label: def.label, checked: true,
    note: `株価${priceChangePct >= 0 ? '+' : ''}${priceChangePct}% × 信用買い残${buyChangePct >= 0 ? '+' : ''}${buyChangePct}% ＝ ${def.label}。${def.note}`,
  };
}

// Phase3 ③「反発の質」（ユーザー提案）。単に株価が反発しただけでなく、
// 信用買い残が減っているか（＝新規の空買いではなく実需に近い反発か）を
// 出来高確認込みで判定する。creditPatternSignalのSUPPLY_IMPROVING/
// LEVERAGED_RISEと入力（priceChangePct/buyChangePct）は共通だが、こちらは
// 「株価上昇局面に限定した質の判定」という別の切り口（週次4象限の
// 分類そのものではなく、出来高という第3軸を加えた確認判定）のため、
// creditPatternの別名ではなく独立した信号として持つ。
// 出来高確認の閾値はfloatSqueezeSignalと同じFLOAT_SQUEEZE.minVolumeRatio
// を再構成する（新しい閾値を作らない）。
// PENDING（信用残データがまだ反映されていない未確定状態）はここでは
// 扱わない。creditAsOf/creditDataAgeDaysと合わせてPhase5で追加する
// （データ鮮度の判定はcreditSupplyQualitySignal側の責務にする）。
export function bounceQualitySignal({ priceChangePct, buyChangePct, volRatio } = {}) {
  if (!Number.isFinite(priceChangePct)) return { bounceQuality: null, checked: false, note: null };
  if (priceChangePct <= 0) return { bounceQuality: null, checked: true, note: null }; // 反発局面でなければ判定対象外
  if (!Number.isFinite(buyChangePct)) return { bounceQuality: null, checked: false, note: null };

  const creditUnwinding = buyChangePct < 0;
  const volumeConfirms = Number.isFinite(volRatio) && volRatio >= FLOAT_SQUEEZE.minVolumeRatio;
  const buyChangeText = `${buyChangePct >= 0 ? '+' : ''}${buyChangePct}%`;

  if (creditUnwinding && volumeConfirms) {
    return {
      bounceQuality: 'IMPROVING', checked: true,
      note: `株価+${priceChangePct}%の反発局面で、信用買い残${buyChangeText}・出来高は20日平均の${volRatio}倍。信用整理を伴う反発です`,
    };
  }
  return {
    bounceQuality: 'WEAK', checked: true,
    note: creditUnwinding
      ? `株価+${priceChangePct}%の反発局面で信用買い残は${buyChangeText}と減少していますが、出来高の増加が伴っていません（信用整理が本物か出来高で確認できていません）`
      : `株価+${priceChangePct}%の反発局面ですが、信用買い残は${buyChangeText}で減少しておらず、信用整理を伴わない反発です`,
  };
}

// Phase4 ④「安値更新×買残増加」（ユーザー提案。独立フラグとして持つ）。
// 直近の信用残観測期間中（≒直近observationDays営業日。Phase2/3の
// priceChangePctと同じ、週次発表間隔の近似）にlowWindowDays営業日安値を
// 更新し、かつその期間の信用買い残が増加していれば、「下がるたびに
// 信用買いが入っている」状態として検出する。「新安値」の判定窓は
// 20営業日（ユーザー確認済み。52週安値ではなく、信用残の観測頻度
// （週次）に近い直近のレンジ安値を見る）。0%以上を「増加」として扱う
// （creditPatternSignalと同じ境界の決め方）。
export const LOW_BREAK_BUY_BUILDUP = { lowWindowDays: 20, observationDays: 5 };

export function lowBreakBuyBuildupSignal({ closes, buyChangePct } = {}) {
  const { lowWindowDays: n, observationDays: obs } = LOW_BREAK_BUY_BUILDUP;
  if (!closes || closes.length < n || !Number.isFinite(buyChangePct)) {
    return { lowBreakBuyBuildUp: false, checked: false, note: null };
  }
  const windowCloses = closes.slice(-n).filter(Number.isFinite);
  const recentCloses = closes.slice(-obs).filter(Number.isFinite);
  if (!windowCloses.length || !recentCloses.length) return { lowBreakBuyBuildUp: false, checked: false, note: null };
  const windowLow = Math.min(...windowCloses);
  const recentLow = Math.min(...recentCloses);
  const madeNewLow = recentLow <= windowLow; // recentLowはwindowLowの部分集合の最小値なので理論上windowLow以上にしかならない
  if (!madeNewLow) return { lowBreakBuyBuildUp: false, checked: true, note: null };

  const buildUp = buyChangePct >= 0;
  const buyChangeText = `${buyChangePct >= 0 ? '+' : ''}${buyChangePct}%`;
  return {
    lowBreakBuyBuildUp: buildUp, checked: true,
    note: buildUp
      ? `直近${obs}営業日以内に${n}営業日安値（${Math.round(windowLow).toLocaleString()}円）を更新し、信用買い残も${buyChangeText}と増加しています。下がるたびに信用買いが入っている状態です`
      : `直近${obs}営業日以内に${n}営業日安値（${Math.round(windowLow).toLocaleString()}円）を更新しましたが、信用買い残は${buyChangeText}で増加していません`,
  };
}

// Phase5 統合（ユーザー提案）: Phase1〜4（creditBuyPressureDays/
// creditPatternSignal/bounceQualitySignal/lowBreakBuyBuildupSignal）を
// 1つのcreditSupplyQualitySignalにまとめる。既存のmarginOverhangSignal/
// creditFloatSignal/shortSqueezeSignal等は一切変更しない。SCOREへの
// 新規加点も行わない（clusterConfirmationのSUPPLY_CREDITクラスタへ
// level:'good'のときだけ1判定材料として追加する。1クラスタ1回の
// ルールは維持）。

// weekly[].dateはkabutan.mjs: parseWeeklyCreditの生テキスト（実測:
// "26/09/11"のようなYY/MM/DD形式。ページ上の<time datetime="2026-09-11">
// のISO属性はparseTablesのstripTagsで失われるため使えない）。2桁年は
// "20"を補完する（このプロジェクトの運用期間を考えれば十分安全な前提）。
function creditDateToIso(dateStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dateStr ?? '');
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

function daysBetweenIso(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

export function creditSupplyQualitySignal({ weekly, closes, volumes, price, loanRatio, today } = {}) {
  const buyBalance = weekly?.[0]?.buy ?? null;
  const buyBalancePrior = weekly?.[1]?.buy ?? null;
  const sellBalance = weekly?.[0]?.sell ?? null;
  const sellBalancePrior = weekly?.[1]?.sell ?? null;
  const buyChangePct = creditTrend(weekly ?? [], 1);
  const sellChangePct = shortTrend(weekly ?? [], 1);
  const priceChangePct = returnPct(closes, 5);
  const avgVolumeRatio = volumeRatio(volumes);

  const pressure = creditBuyPressureDays({ creditBuyBalance: buyBalance, price, closes, volumes });
  const patternResult = creditPatternSignal({ priceChangePct, buyChangePct });
  const lowBreakResult = lowBreakBuyBuildupSignal({ closes, buyChangePct });
  const bqResult = bounceQualitySignal({ priceChangePct, buyChangePct, volRatio: avgVolumeRatio });

  // データ鮮度: 固定の日数を決め打ちせず、その銘柄自身の過去の発表間隔
  // （weekly[0].date - weekly[1].date）を基準に、今その間隔を超えて次の
  // 発表がまだ来ていなければ「次回発表が既に来ていておかしくない古さ」
  // と判定する（ユーザー確認済み）。この状態で、かつ直近5営業日の株価・
  // 出来高が反発を示している場合は、bounceQualityが参照する信用データ
  // （直近の確定済み週次比較）がその反発を捉えきれていない可能性がある
  // ため、IMPROVING/WEAKではなくPENDINGとして扱う。
  const asOfIso = creditDateToIso(weekly?.[0]?.date);
  const priorIso = creditDateToIso(weekly?.[1]?.date);
  const typicalGapDays = daysBetweenIso(priorIso, asOfIso);
  const creditDataAgeDays = daysBetweenIso(asOfIso, today ?? null);
  const isStale = Number.isFinite(creditDataAgeDays) && Number.isFinite(typicalGapDays) && creditDataAgeDays > typicalGapDays;
  const priceVolumeBouncing = Number.isFinite(priceChangePct) && priceChangePct > 0
    && Number.isFinite(avgVolumeRatio) && avgVolumeRatio >= FLOAT_SQUEEZE.minVolumeRatio;
  const bounceQuality = (isStale && priceVolumeBouncing) ? 'PENDING' : bqResult.bounceQuality;

  const reasonCodes = [];
  if (patternResult.pattern) reasonCodes.push(`CREDIT_PATTERN_${patternResult.pattern}`);
  if (bounceQuality) reasonCodes.push(`BOUNCE_QUALITY_${bounceQuality}`);
  if (lowBreakResult.lowBreakBuyBuildUp) reasonCodes.push('LOW_BREAK_BUY_BUILDUP');

  const level = (patternResult.pattern === 'SUPPLY_IMPROVING' || bounceQuality === 'IMPROVING')
    ? 'good'
    : (patternResult.pattern === 'OVERHANG_BUILDUP' || lowBreakResult.lowBreakBuyBuildUp === true)
      ? 'warn'
      : null;

  return {
    level,
    pattern: patternResult.pattern,
    buyBalance, buyBalancePrior, buyChangePct,
    sellBalance, sellBalancePrior, sellChangePct,
    creditRatio: Number.isFinite(loanRatio) ? loanRatio : null,
    buyPressureDays: pressure.days,
    buyPressureValueDays: pressure.valueDays,
    priceChangePct, avgVolumeRatio,
    lowBreakBuyBuildUp: lowBreakResult.lowBreakBuyBuildUp,
    bounceQuality,
    creditAsOf: weekly?.[0]?.date ?? null,
    creditDataAgeDays,
    checked: patternResult.checked || pressure.checked || lowBreakResult.checked,
    reasonCodes,
  };
}

// 「攻めの赤字」（ユーザー提案: 研究開発費・広告宣伝費が売上を上回る
// 速度で増えている銘柄は、目先の利益より市場シェア獲得を優先している
// 成長投資フェーズと捉える）。JP側はedinet.mjs:extractBalanceSheetSnapshot
// のrndGrowthPct（実測タグ: jppfs_cor:ResearchAndDevelopmentExpensesSGA）、
// US側はus_edgar.mjs:extractQuarterlyTrendのrnd系列から計算した値を渡す。
// 研究開発費を開示している銘柄自体が少ない見込みのため、他の項目より
// checked:falseになる頻度が高い（推測で埋めない）。
export const AGGRESSIVE_INVESTMENT = { minOutpacePt: 10 };
export function aggressiveInvestmentSignal({ rndGrowthPct, revenueGrowthPct } = {}) {
  if (![rndGrowthPct, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (rndGrowthPct - revenueGrowthPct >= AGGRESSIVE_INVESTMENT.minOutpacePt) {
    return {
      level: 'good', label: '攻めの投資（研究開発費が売上を上回る伸び）', checked: true,
      note: `研究開発費が前年（同期）比+${rndGrowthPct}%と、売上高成長率+${revenueGrowthPct}%を上回るペースで増加しています。目先の利益より成長投資を優先しているフェーズと考えられます（研究開発費を開示している銘柄のみ判定できます）`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// テーマ性マッチング（ユーザー提案）。完全自動のNLP/キーワード検索は
// 存在しないため、tenbagger_research_log.mdの手動リサーチで実在確認
// 済みのkabutan.jpテーマページ一覧（THEME_WATCHLIST、smart_entry.mjs）
// を定期的に照合するだけの簡易版（自動発見ではない点に注意）。
// US側は対応する一元的なテーマページが無いため、us_tenbagger.mjsの
// ウォッチリストに手動で付けたthemeフィールドをそのまま根拠にする。
export function themeMatchSignal({ matchedThemes } = {}) {
  if (!Array.isArray(matchedThemes)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (matchedThemes.length > 0) {
    return {
      level: 'good', label: `テーマ性あり（${matchedThemes.join('・')}）`, checked: true,
      note: `手動で選定したテーマページ一覧（${matchedThemes.join('・')}）に掲載されている銘柄です。自動発見ではなく決め打ちのテーマ一覧との照合のため、このリストに無いテーマは拾えません`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// カタリスト予兆セクション（ユーザー提案）
//
//  「材料が出てから買う」のではなく「材料が出るしかない財務状況」を
//  先回りして拾う。screener.mjs(AMBUSH)は既に取得済みのEDINET貸借対照表・
//  kabutan決算ページのデータから計算するため追加のリクエストは発生しない
//  （＝AMBUSHのユニバース＝決算T+14〜45日の銘柄）。smart_entry.mjsの
//  東証グロース銘柄向けカタリスト予兆スキャン（ユーザー要望）でも同じ
//  基準を使い回すため、scraper.mjsからここに移設した（scraper.mjsに
//  置いたままだとsmart_entry.mjsからimportする際にscraper.mjs→
//  smart_entry.mjs→scraper.mjsの循環importになってしまうため）。
//  進捗率・利益剰余金・投資有価証券のいずれか1つでも該当すれば掲載する
//  （AND条件にしないのは、性質の異なる予兆を1つの基準で絞ると、他の
//  兆候が強くても掲載されなくなるため）。
//
//  好材料の先取り（🔮）だけでなく、粉飾・悪化のリスクを先取りする注意
//  予兆（⚠️、ユーザー提案「利益の質の逆行チェック」）もこのセクションに
//  含める。receivablesAnomalySignal（売上高成長率<売上債権成長率）は
//  「まだ発表されていない下方修正リスク」、progressStreakSignalのwarn枝
//  （進捗率は加速も経常利益は前年割れ）は「見た目ほど強気ではない」を
//  先取りする点でどちらも「決算前に読み取れる予兆」という同じ性質を持つ。
//
//  ■ creditFloatSignalをこのリストに含めない理由（実測で判明した誤り）
//  当初はcreditFloatのgood（需給が軽い）もPRECURSOR_GOOD_FIELDSに含めて
//  いたが、実測でAMBUSH候補15銘柄中11銘柄が「需給が軽いというだけ」で
//  このセクションに掲載され、「材料が出るしかない財務状況」という本来の
//  趣旨（＝将来の好材料そのものの予兆）とは無関係な「材料が出た場合に
//  伸びやすい体質」という別軸の情報で埋まってしまっていた。creditFloatは
//  precursorCard先頭のワンポイントバッジ（creditFloatBadge）としては
//  引き続き常時表示するが、このセクションへの掲載可否には使わない
//  （バッジ＝補助情報、GOOD/CAUTION_FIELDS＝掲載基準、と役割を分離する）。
// ------------------------------------------------------------------
export const PRECURSOR_GOOD_FIELDS = ['progressStreak', 'dividendPotential', 'hiddenAsset'];
export const PRECURSOR_CAUTION_FIELDS = ['receivablesAnomaly', 'progressStreak'];

export function hasPrecursor(r) {
  return PRECURSOR_GOOD_FIELDS.some((k) => r[k]?.level === 'good')
    || PRECURSOR_CAUTION_FIELDS.some((k) => r[k]?.level === 'warn' || r[k]?.level === 'bad');
}

// ------------------------------------------------------------------
// 米国株版「進捗率加速」— usEarningsTrendSignal
//
//  日本のprogressStreakSignalが使う「対通期/対上期進捗率」という開示
//  形式は米国の会計制度に存在しない（米国企業は日本のような公式な通期
//  進捗率を開示しない）ため直訳できない。代わりにSEC EDGARの四半期
//  売上高・純利益（us_edgar.mjsのextractQuarterlyTrend）を使い、
//  直近四半期の前年同期比成長率で判定する。
//
//  ■ 「約1年前」を実データに基づいてインデックスではなく日付で探す理由
//  US-GAAPの四半期開示には、年度末の第4四半期単独の値がXBRL上に
//  存在しない会社が多い（10-Kは年度累計のみ開示し、Q4単独値は開示側で
//  引き算しないと出てこないため。実データ検証で確認済み: Appleの
//  quarterlyTrendは2025-06-28の次が2025-12-27で、2025-09-27週の
//  単独Q3が欠けている）。そのため「4つ前のインデックス＝1年前」という
//  決め打ちはできず、日付ベースで「約1年前（330〜400日前）に最も近い
//  四半期」を探す。
//
//  ■ 古すぎるデータを「直近」と誤表示しない（実データで発見した重大な穴）
//  一部の会社（実測: BXMTのようなREIT）は、業種特有の収益認識のため
//  ある時点からXBRLの汎用的な売上高タグ（Revenues等）でのquarterly
//  duration開示をやめてしまい、配列の最後の要素が実は10年以上前の
//  データだった、という事例が実際に発生した（quarterlyTrend.at(-1)を
//  無条件に「直近四半期」として使うと「直近四半期(2014-12-31)」という
//  明らかにおかしい表示になっていた）。asOf（実行時点の日付、通常は
//  todayJST()）を渡し、最後の要素があまりに古ければ「データが古すぎて
//  信頼できない」としてchecked:falseにする。
const US_EARNINGS_TREND_MAX_STALE_DAYS = 200; // 四半期開示は通常90日毎なので、2四半期分以上開かなければ許容

// quarterlyTrend[fromIdx]から見て「約1年前（330〜400日前）に最も近い
// 四半期」を探す（usEarningsTrendSignal本体のYoY探索ロジックを、成長の
// 「加速」判定（growthAccelerationSignal、ユーザー提案）用に直近四半期
// 以外にも使えるよう切り出したもの）。
function findYoyQuarter(quarterlyTrend, fromIdx) {
  const fromEnd = new Date(quarterlyTrend[fromIdx].end);
  let yoy = null, yoyDiffDays = Infinity;
  for (let i = fromIdx - 1; i >= 0; i--) {
    const days = (fromEnd - new Date(quarterlyTrend[i].end)) / 86400000;
    if (days < 330) continue; // 1年未満は前年同期にならない
    if (days > 400) break; // これより古いものを見ても近づかない（古い→新しい順のため）
    const diff = Math.abs(days - 365);
    if (diff < yoyDiffDays) { yoy = quarterlyTrend[i]; yoyDiffDays = diff; }
  }
  return yoy;
}

export function usEarningsTrendSignal(quarterlyTrend, asOf = null) {
  if (!Array.isArray(quarterlyTrend) || quarterlyTrend.length === 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const latest = quarterlyTrend.at(-1);
  const latestEnd = new Date(latest.end);
  if (asOf) {
    const staleDays = (new Date(asOf) - latestEnd) / 86400000;
    if (staleDays > US_EARNINGS_TREND_MAX_STALE_DAYS) {
      return { level: null, label: null, note: null, checked: false };
    }
  }
  const yoy = findYoyQuarter(quarterlyTrend, quarterlyTrend.length - 1);
  if (!yoy || !Number.isFinite(latest.revenue) || !Number.isFinite(yoy.revenue) || yoy.revenue <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const revenueGrowthPct = round1(((latest.revenue - yoy.revenue) / yoy.revenue) * 100);
  const hasNetIncome = Number.isFinite(latest.netIncome) && Number.isFinite(yoy.netIncome) && yoy.netIncome > 0;
  const netIncomeGrowthPct = hasNetIncome ? round1(((latest.netIncome - yoy.netIncome) / yoy.netIncome) * 100) : null;
  const niText = netIncomeGrowthPct !== null ? `、純利益は${netIncomeGrowthPct > 0 ? '+' : ''}${netIncomeGrowthPct}%` : '';

  // 成長の「加速」判定（growthAccelerationSignal）用に、1つ前の四半期でも
  // 同様にYoYが計算できれば付随情報として返す（既存フィールドの意味は
  // 変えないので呼び出し側は無改修で動く）。
  let prevRevenueGrowthPct = null;
  if (quarterlyTrend.length >= 2) {
    const prevLatest = quarterlyTrend.at(-2);
    const prevYoy = findYoyQuarter(quarterlyTrend, quarterlyTrend.length - 2);
    if (prevYoy && Number.isFinite(prevLatest.revenue) && Number.isFinite(prevYoy.revenue) && prevYoy.revenue > 0) {
      prevRevenueGrowthPct = round1(((prevLatest.revenue - prevYoy.revenue) / prevYoy.revenue) * 100);
    }
  }

  // 攻めの赤字（aggressiveInvestmentSignal）用。latest/yoyは既に確定
  // 済みなので追加の探索無しで計算できる。R&D非開示企業も多いためnullの
  // ままになるケースを許容する（推測で埋めない）。
  const hasRnd = Number.isFinite(latest.rnd) && Number.isFinite(yoy.rnd) && yoy.rnd > 0;
  const rndGrowthPct = hasRnd ? round1(((latest.rnd - yoy.rnd) / yoy.rnd) * 100) : null;
  // 第6優先改修②（ユーザー報告「税効果」）: 税引前利益のYoY成長率。
  // netIncomeGrowthPct（税引後）との乖離を見れば、税効果（税率変動・
  // 繰延税金資産の評価性引当金取り崩し等）が純利益を押し上げているかを
  // usTaxEffectCautionSignal側で判定できる。取得できない企業も多いため
  // nullのままになるケースを許容する（推測で埋めない）。
  const hasPretaxIncome = Number.isFinite(latest.pretaxIncome) && Number.isFinite(yoy.pretaxIncome) && yoy.pretaxIncome > 0;
  const pretaxIncomeGrowthPct = hasPretaxIncome ? round1(((latest.pretaxIncome - yoy.pretaxIncome) / yoy.pretaxIncome) * 100) : null;

  if (revenueGrowthPct >= 15 && (netIncomeGrowthPct === null || netIncomeGrowthPct >= 15)) {
    return {
      level: 'good', label: '増収増益が加速', checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct, pretaxIncomeGrowthPct,
      note: `直近四半期(${latest.end})の売上高は前年同期比+${revenueGrowthPct}%${niText}`,
    };
  }
  if (revenueGrowthPct <= -10 || (netIncomeGrowthPct !== null && netIncomeGrowthPct <= -20)) {
    return {
      level: 'bad', label: '減収減益', checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct, pretaxIncomeGrowthPct,
      note: `直近四半期(${latest.end})の売上高は前年同期比${revenueGrowthPct}%${niText}`,
    };
  }
  return { level: null, label: null, note: null, checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct, pretaxIncomeGrowthPct };
}

// 第6優先改修②（ユーザー報告「税効果」）: US株のprofitGrowthPctは
// usEarningsTrendSignal().netIncomeGrowthPct（GAAP当期純利益、税引後・
// 特別項目込みの最終利益）で、税率変動・一時的な税効果（繰延税金資産の
// 評価性引当金取り崩し等）が混入していても検知する仕組みが無かった。
// 税引前利益（pretaxIncomeGrowthPct）と純利益（netIncomeGrowthPct）の
// 成長率の乖離を見ることで、「事業成績（税引前）は伸びていないのに
// 税金費用の減少で純利益だけ跳ねている」ようなケースに注意を促す。
// 新しいSCOREは作らず、growthAnomalyCautionSignalと同じ{level,label,
// note,checked}パターンの独立シグナルとして追加する。既存のprofitGrowthPct
// （＝netIncomeGrowthPct）自体は変更しない。
export const US_TAX_EFFECT = {
  // 税引前・税引後の成長率の差がこれ以上なら「税効果の影響の疑い」とする。
  // 実データでの閾値検証はしていないため、growthAnomalyCautionSignalの
  // 閾値と同様、初期値として妥当な水準を暫定的に採用した値（今後の
  // 実データ観測で調整する前提）。
  minDivergencePct: 20,
};

export function usTaxEffectCautionSignal({ netIncomeGrowthPct, pretaxIncomeGrowthPct } = {}) {
  if (!Number.isFinite(netIncomeGrowthPct) || !Number.isFinite(pretaxIncomeGrowthPct)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const divergencePct = round1(netIncomeGrowthPct - pretaxIncomeGrowthPct);
  if (Math.abs(divergencePct) >= US_TAX_EFFECT.minDivergencePct) {
    return {
      level: 'warn', label: '税効果の影響の疑い', checked: true, divergencePct,
      note: `税引前利益の成長率は+${pretaxIncomeGrowthPct}%ですが、純利益の成長率は+${netIncomeGrowthPct}%と${divergencePct > 0 ? '大きく上回って' : '下回って'}います（差${divergencePct > 0 ? '+' : ''}${divergencePct}pt）。税率変動や一時的な税効果（繰延税金資産の評価性引当金取り崩し等）が影響している可能性があり、純利益成長率だけで評価しないようご注意ください`,
    };
  }
  return { level: null, label: null, note: null, checked: true, divergencePct };
}

// 売上高成長の「加速」（ユーザー提案: 前々期+10%→前期+15%→今期+30%の
// ように、伸び率自体が伸びている銘柄を評価する）。テンバガー候補
// （tenbaggerSignal/midCapGrowthSignal）の判定基準は変えず、候補内の
// 並び順を補正する加点シグナルとして使う。growthPct/prevGrowthPctは
// JP側はkabutan.mjs:parseAnnualRevenueYoYの戻り値、US側は
// usEarningsTrendSignalの戻り値（revenueGrowthPct/prevRevenueGrowthPct）
// をそのまま渡せる（通貨非依存・%の比較のみ）。
// A指示 項目7「『成長加速』を独立スコア化する」。従来はgood/nullの
// 二値のみで「加速したかどうか」しか表現できなかった。指示書が挙げた
// 10の評価項目（売上/利益/EPS成長率の加速・営業利益率改善・粗利率
// 改善・受注/RPO/ARR/顧客数加速・通期ガイダンス上方修正）のうち、
// 営業利益率改善・粗利率改善はdeficitGrowthSignal用に追加したEDINET
// タグ（operatingIncome/grossProfit/netSales、当期・前期とも取得可能）
// で計算できるため、加速度合いを表す連続値のscore（0-100）に反映する。
// 受注/RPO/ARR/顧客数/ガイダンスは定型タグが無く対象外（推測で埋めない）。
// EPS成長率の加速は1株当たり利益の複数期系列を取得しておらず対象外。
// level/label/note/checkedの既存の二値判定ロジックは、既存の呼び出し元
// （diamondSignal・buildScoreParts等）との後方互換のため変更しない。
export function growthAccelerationSignal({ growthPct, prevGrowthPct, grossMarginImproving, opMarginImproving } = {}) {
  if (![growthPct, prevGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false, score: null };
  }
  const accelDelta = growthPct - prevGrowthPct;
  const base = growthPct > 0 ? Math.max(0, Math.min(100, Math.round(accelDelta * 2))) : 0;
  const marginBonus = (grossMarginImproving ? 15 : 0) + (opMarginImproving ? 15 : 0);
  const score = Math.max(0, Math.min(100, base + marginBonus));
  if (growthPct > 0 && growthPct > prevGrowthPct) {
    const marginNote = [grossMarginImproving ? '粗利率' : null, opMarginImproving ? '営業利益率' : null].filter(Boolean).join('・');
    return {
      level: 'good', label: '成長が加速', checked: true, score,
      note: `売上高成長率が前期の${prevGrowthPct >= 0 ? '+' : ''}${prevGrowthPct}%から今期は${growthPct >= 0 ? '+' : ''}${growthPct}%に加速しています${marginNote ? `。${marginNote}も改善しており、成長の質も伴っています` : ''}`,
    };
  }
  return { level: null, label: null, note: null, checked: true, score };
}

// ------------------------------------------------------------------
// テンバガー候補（ユーザー提案）— 小時価総額 × 高成長率の持続
//
//  日本株・米国株の両方から呼ぶ市場非依存の比率判定。marketCap/
//  maxMarketCapは呼び出し側で「その通貨の100万単位」に揃えて渡す規約に
//  する（日本は百万円、米国は百万USD。どちらも100万単位という同じ意味の
//  値なので、この関数自体は単位変換をしない＝marketCapYen()のような
//  変換は不要。呼び出し側の値がそもそも揃っていることが前提）。
//
//  ■ ユニバースの制約について（Phase 1の既知の割り切り）
//  日本はsmart_entry.mjsの東証グロース向け成長株予兆スキャン（決算日
//  非依存）、米国はus_tenbagger.mjsの手動キュレーションリスト（同じく
//  決算日非依存）が対象。以前は米国側がus_screener.mjs（AMBUSH、決算
//  T+14〜45日ユニバース）を流用しており、次回決算が窓の外にある銘柄
//  （実測: IONQ・Aurora Innovation/AUR）が機械的に除外される欠陥が
//  あったため、テンバガー探索とAMBUSHは完全に分離した。
//
//  ■ 閾値について
//  minGrowthPct・maxMarketCapとも実運用データが無い状態で決めた初期値。
//  実際にスキャンしてみて該当0件・該当過多になったら調整する前提。
export const TENBAGGER = { minGrowthPct: 25 };

// 実測バグ: noteの時価総額を単位無しの生の数字（例:「時価総額が20,300」）
// で埋め込んでおり、百万円なのか円なのか読者には分からなかった
// （footer chipの「時価総額 ¥20,300M」は単位付きだが、noteの文中数値は
// 独立した文字列で単位が抜けていた）。indicators.mjs自体はJP/US通貨を
// 区別しない設計のため、呼び出し側（smart_entry.mjs='百万円'、
// us_tenbagger.mjs='百万USD'）にunitLabelを渡してもらう。
// A指示 項目14「『10倍可能性』と『今買う妙味』を分離」・項目36「現在の
// 時価総額から10倍の現実性を計算」: 「今買う妙味」は既存のrepricingLag.
// score（0-100）で独立表示済みだが、「10倍実現可能性」に相当する数値
// スコアが無かった（tenbaggerSignal/midCapGrowthSignalはgood/nullの
// 二値のみ）。現在の時価総額が、そのTierの上限（ユーザー承認済みの
// 「テンバガーとして現実的な規模」の境界）にどれだけ近いかを0-100の
// 連続値にする。上限に近いほど10倍達成に必要な絶対額が大きくなり
// 非現実的になる（実測: AUR時価総額$118億→10倍$1,180億はUber・Intel級
// で非現実的、という指示書の指摘をそのまま数値化したもの）。
export function tenbaggerRealizabilityScore({ marketCap, maxMarketCap } = {}) {
  if (!Number.isFinite(marketCap) || !Number.isFinite(maxMarketCap) || maxMarketCap <= 0) return null;
  const ratio = Math.max(0, Math.min(1, marketCap / maxMarketCap));
  return Math.round((1 - ratio) * 100);
}

// A指示 項目15「10倍実現難易度を評価（低/中/高/極めて高）」: 従来は
// tenbaggerRealizabilityScoreの生の数値（0-100）しか表示しておらず、
// 指示書が明示した4段階ラベルが無かった。実現可能性スコアが高いほど
// 難易度は低い（realizability=100→難易度「低」）という逆向きの関係を
// そのままラベル化する。
export const TENBAGGER_DIFFICULTY_TIER = { low: 75, medium: 50, high: 25 };
export function tenbaggerDifficultyLabel(realizabilityScore) {
  if (!Number.isFinite(realizabilityScore)) return null;
  if (realizabilityScore >= TENBAGGER_DIFFICULTY_TIER.low) return '低';
  if (realizabilityScore >= TENBAGGER_DIFFICULTY_TIER.medium) return '中';
  if (realizabilityScore >= TENBAGGER_DIFFICULTY_TIER.high) return '高';
  return '極めて高';
}

// A指示 項目14「成長ポテンシャル」: buildScoreParts()のrevenueGrowth
// 評価（成長率×2＋成長加速ボーナス15、0-100にクランプ）と同じ物差しを
// テンバガー候補にも適用し、「10倍実現可能性」「今買う妙味」とは別の
// 3本目の軸として独立表示する。
export function growthPotentialScore({ revenueGrowthPct, growthAcceleration } = {}) {
  if (!Number.isFinite(revenueGrowthPct)) return null;
  const accelBonus = growthAcceleration?.level === 'good' ? 15 : 0;
  return Math.max(0, Math.min(100, Math.round(revenueGrowthPct * 2) + accelBonus));
}

// A指示 項目3「『業績改善率－株価反応率』の概念を導入する（Repricing
// Gap＝再評価ギャップ）」。既存のrepricingLagScore（未織り込み度25点+
// 業績改善25点+株価割安度15点+成長率15点+先行材料10点+イベント10点を
// 配点合成した複合スコア）とは別の、「業績と株価の差」単独指標。
//
// ■ v2再設計の経緯（ユーザー報告・実測バグ）
// 旧式は「業績成長率(YoY %) − 株価騰落率(%)」という異なる尺度の単純差分
// だった。実測（2026-09-22、米国株ONDS）で、売上高成長率+1235.4%（利益
// データ欠損のため売上単独採用）・株価3ヶ月-3.8%という組み合わせから
// Repricing Gap +908.3ptという、投資判断上ほぼ無意味な数値が発生した。
// 原因は2つ複合している。
//  (1) 売上高成長率が極小の前年ベースからの反発等で三桁%に達しても、
//      そのまま差分の一方に使うと外れ値が結果を支配する（winsorization
//      無し）。
//  (2) 業績側はYoY（1年前との比較）、株価側は直近1ヶ月/3ヶ月という
//      異なる期間の数字を、同じ「その場で使える方」を採用する形で
//      混ぜていた（return3mがあればreturn1mより優先、という実装）。
//
// ■ 新しい定義
// 「業績側（実績の改善度）」と「株価側（市場の反応度）」を、どちらも
// 同じ1ヶ月という時間軸・同じ%スケールに揃えたうえで差を取る。
//  - 業績側: 売上高成長率・経常利益成長率（どちらもYoY実績、%）を
//    ±REPRICING_GAP.growthCapPctでwinsorizeしてから平均する。
//  - 株価側: 直近1ヶ月騰落率(return1m)。同業種の直近1ヶ月累積騰落率
//    （sectorTrendPct、sector_history.mjsが日次で積み上げている実データ）
//    が取得できれば、そこからの超過リターンに変換する（「銘柄固有の
//    反応」と「セクター全体・市場全体の地合い」を分離するため）。
//    セクター側の履歴が足りない場合（運用開始直後・米国株など）は
//    単純なreturn1mにフォールバックする（推測で埋めない）。
// 両者を「差分」で比較する点は変えていないが、(1)(2)の問題はこの
// 前処理（winsorize・期間統一・セクター相対化）で解消している。
//
// ■ winsorization閾値の根拠（実データ確認済み・2026-09-22）
// 本番index.htmlの実測値を確認したところ、成長率は売上-27.7%〜+60.7%・
// 利益-24.6%〜+160.7%の範囲にほぼ収まっており、+1235.4%（ONDS、売上が
// 極小額からの反発）だけが明確な外れ値だった。growthCapPct=200は実測の
// 最大値（利益+160.7%）を割り引かずに残しつつ、この種の外れ値だけを
// 大きく圧縮する（1235.4→200、約84%圧縮）水準として選んだ。全銘柄の
// 分布を毎回集計してpercentile化する方式（案としては検討した）は、
// 現状すべて「1銘柄ずつ計算する純関数」であるこのファイルの設計を、
// スクリーニング全体を2パスにする構成へ変える必要があり、Repricing Gap
// 以外のランキング・表示コードへの影響範囲が広がりすぎるため見送った。
//
// ■ データ欠損の扱い
// - 売上高成長率・経常利益成長率のどちらも無ければ算出しない（null）。
// - 片方しか無い場合は、その1指標だけで満額評価にしない
//   （completeness=0.5を乗じる）。欠損銘柄が、両方揃っている銘柄より
//   有利にならないようにするため。
// - EPS予想（会社/コンセンサスの times series）は現状収集していない
//   （Phase 1の既知の限界。growthAcceleration等と同じ制約）。将来
//   収集できるようになるまでrepricingGapBreakdown().epsForecastChangeは
//   常にnullを返し、「N/A」として扱う。
//
// ■ 符号についての注意（業績も株価も悪化しているケース）
// rawGapは「業績側 − 株価側」の差分のため、業績も株価も悪化している
// 場合でも株価の下落幅の方が大きければ正の値になりうる（例: 業績-20%・
// 株価-30%→rawGap=+10）。これは「業績改善なのに株価が反応していない」
// という意味の未織り込みではなく、「株価が業績以上に売られている」別の
// 意味（オーバーシュート）なので、呼び出し側（scraper.mjs）は
// performanceRateの符号を見て「未織り込み」の文言を出し分ける。
export const REPRICING_GAP = { growthCapPct: 200 };

// repricingGapScore（算出）とscraper.mjs側の表示文言生成の両方から
// 呼ばれる共有ロジック。判定ロジックを2箇所に複製しないため独立関数に
// している（sample.pyがbuild_news()に委譲するのと同じ考え方）。
export function repricingGapBreakdown({ revenueGrowthPct, profitGrowthPct, return1m, sectorReturn1m } = {}) {
  const clamp = (v) => (Number.isFinite(v) ? Math.max(-REPRICING_GAP.growthCapPct, Math.min(REPRICING_GAP.growthCapPct, v)) : null);
  const revenueGrowthPctClamped = clamp(revenueGrowthPct);
  const profitGrowthPctClamped = clamp(profitGrowthPct);
  const rates = [revenueGrowthPctClamped, profitGrowthPctClamped].filter(Number.isFinite);
  const performanceRate = rates.length ? round1(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
  const completeness = rates.length ? rates.length / 2 : null; // 2指標中いくつ確認できたか（欠損を有利にしないため）
  const sectorAdjusted = Number.isFinite(return1m) && Number.isFinite(sectorReturn1m);
  const priceReaction = Number.isFinite(return1m)
    ? (sectorAdjusted ? round1(return1m - sectorReturn1m) : round1(return1m))
    : null;
  return {
    performanceRate, priceReaction, sectorAdjusted, completeness,
    revenueGrowthPctRaw: Number.isFinite(revenueGrowthPct) ? revenueGrowthPct : null,
    profitGrowthPctRaw: Number.isFinite(profitGrowthPct) ? profitGrowthPct : null,
    revenueGrowthPctClamped, profitGrowthPctClamped,
    epsForecastChange: null, // Phase 1の既知の限界: EPS予想の時系列は未収集のためN/A固定
  };
}

export function repricingGapScore({ revenueGrowthPct, profitGrowthPct, return1m, sectorReturn1m, priceLevelPct } = {}) {
  const b = repricingGapBreakdown({ revenueGrowthPct, profitGrowthPct, return1m, sectorReturn1m });
  if (b.performanceRate === null || b.priceReaction === null) return null;
  const rawGap = (b.performanceRate * b.completeness) - b.priceReaction;
  const tempering = Number.isFinite(priceLevelPct) ? Math.max(0, Math.min(1, 1 - priceLevelPct / 100)) : 1;
  return round1(rawGap * tempering);
}

export function tenbaggerSignal({ marketCap, maxMarketCap, revenueGrowthPct, unitLabel = '' } = {}) {
  if (![marketCap, maxMarketCap, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (marketCap <= maxMarketCap && revenueGrowthPct >= TENBAGGER.minGrowthPct) {
    return {
      level: 'good', label: 'テンバガー候補', checked: true,
      note: `時価総額が${Math.round(marketCap).toLocaleString()}${unitLabel}（上限${maxMarketCap.toLocaleString()}${unitLabel}以下）と小さく、売上高成長率が前年同期比+${revenueGrowthPct}%と高水準です。小型のうちに成長を捉えられれば大きなリターンが狙えますが、その分値動きも荒く、成長の失速リスクも大きい点に注意してください`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// 中型成長株候補（Tier B、設計変更版）— テンバガーは無理だが2〜3倍は
// 狙えるグロース中堅株
//
//  ■ 設計変更の経緯（実データで発覚した問題、旧「次世代テンバガー候補」
//  からの再設計）
//  旧版はTier Aの上限を超えた銘柄を上限なしで一律「次世代テンバガー
//  候補」としていたが、実データで運用したところ2つの問題が出た。
//  (1) AUR（時価総額約$118億）が10倍になるには$1,180億（Uber・Intel級）
//  が必要で、「テンバガー候補」と呼ぶには非現実的な目標だった。
//  (2) 402A（時価総額347億円、Tier Aの上限300億円をわずかに超えただけ）
//  とAUR（$118億）が同じ「Tier B」に同居し、時価総額で50倍近い差がある
//  銘柄が同格に扱われ、「時価総額がバラバラすぎる成長株リスト」になって
//  いた。この2点を踏まえ、Tier Bに上限を設け（日本1000億円/米国$10B）、
//  「テンバガー」ではなく「2〜3倍程度が狙えるグロース中堅株」という
//  現実的な期待値に定義し直した。IONQ（$158億）・AUR（$118億）は新しい
//  上限を超えるため候補から外れる（テンバガー候補としては非現実的な
//  規模と判断）。
//
//  ■ 実装しないこと（Phase 1の既知の限界）
//  TAM・受注/RPO/ARR成長率・市場シェア拡大は、無料で継続取得できる
//  データソースが無いため対象外。売上高成長率のみによる簡易判定。
export const MID_CAP_GROWTH = { minGrowthPct: 25 };

// A指示 項目13「米国テンバガーTierを3段階にする」: Tier B（$1B〜$10B・
// 2〜5倍候補）とTier C（$10B〜$20B程度・大型化後の超成長株、2〜3倍を
// 狙える）は、どちらも「10倍は非現実的だが規模なりの成長余地はある」
// という同じ考え方だが、想定倍率とラベルが異なる。呼び出し側から
// label/multipleLabelを渡せるようにし、デフォルト値は既存のJP Tier B
// （中型成長株候補・2〜3倍）呼び出し元との後方互換を保つ。
export function midCapGrowthSignal({
  marketCap, maxMarketCap, revenueGrowthPct, unitLabel = '',
  label = '中型成長株候補', multipleLabel = '2〜3倍',
} = {}) {
  if (![marketCap, maxMarketCap, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (marketCap <= maxMarketCap && revenueGrowthPct >= MID_CAP_GROWTH.minGrowthPct) {
    return {
      level: 'good', label, checked: true,
      note: `時価総額${Math.round(marketCap).toLocaleString()}${unitLabel}（上限${maxMarketCap.toLocaleString()}${unitLabel}以下）・売上高成長率は前年同期比+${revenueGrowthPct}%です。この規模からの10倍（テンバガー）達成は現実的ではありませんが、${multipleLabel}程度の成長余地は狙える水準です。Tier A（低時価総額のテンバガー候補）とは前提が異なる点にご注意ください`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// v7.5改修（ユーザー提案「テーマ性×小型×高成長×未織り込みが揃ったら
// DIAMONDにする」）。tenbaggerSignal/midCapGrowthSignalとは別の、より
// 希少な組み合わせを示す専用シグナル。市場（円/USD）に依存する
// marketCap/maxMarketCapは既存のtenbaggerSignal等と同じく呼び出し側から
// 渡してもらう（この関数自体は通貨単位を意識しない）。
//
// A指示 項目17「『テーマ性』だけではDIAMONDにしない」: テーマ・小型・
// 高成長・未織り込みの4条件に加え、成長加速（growthAcceleration、既存の
// growthAccelerationSignalの結果をそのまま流用）・財務健全（現金が
// 有利子負債を上回る＝tenbaggerFinancialBlockと同じ「実質無借金」の
// 考え方）・カタリスト（hasCatalyst、進捗率上振れ等の先行材料が既に
// 検出されている）の3条件を追加し、指示書が明記する7条件すべてを要求
// する。cash/interestBearingDebtが未取得の場合は「健全と確認できていない」
// として発火させない（データ不足を好材料扱いしない）。
export function diamondSignal({
  themeMatch, marketCap, maxMarketCap, revenueGrowthPct, repricingLagZone, unitLabel = '',
  growthAcceleration, cash, interestBearingDebt, hasCatalyst,
} = {}) {
  const financiallyHealthy = Number.isFinite(cash) && Number.isFinite(interestBearingDebt) && cash >= interestBearingDebt;
  const ready = themeMatch?.level === 'good'
    && Number.isFinite(marketCap) && Number.isFinite(maxMarketCap) && marketCap <= maxMarketCap
    && Number.isFinite(revenueGrowthPct) && revenueGrowthPct >= TENBAGGER.minGrowthPct
    && growthAcceleration?.level === 'good'
    && (repricingLagZone === 'pre_move' || repricingLagZone === 'early_move')
    && financiallyHealthy
    && hasCatalyst === true;
  if (!ready) return { level: null, label: null, note: null, checked: true };
  return {
    level: 'good', label: '💎 DIAMOND', checked: true,
    note: `テーマ性（${themeMatch.note ?? themeMatch.label}）・小型（時価総額${Math.round(marketCap).toLocaleString()}${unitLabel}・上限${maxMarketCap.toLocaleString()}${unitLabel}以下）・高成長（売上高成長率+${revenueGrowthPct}%）・成長加速中・未織り込み・財務健全（現金が有利子負債を上回る）・先行材料ありの7条件が揃った、特に希少な組み合わせです`,
  };
}

// ------------------------------------------------------------------
// 仕込み妙味スコア（Repricing Lag、ユーザー提案）
//
//  目的は「割安株」を探すことではなく、「業績・材料の改善に対して株価の
//  織り込みが遅れている銘柄」を検出すること。既存のretailExpectation
//  Signalは「既に織り込まれつつある」方向の警告のみで、逆方向（まだ
//  織り込まれていない）を積極的にスコア化する仕組みが無かったため新設。
//
//  ■ 100点満点の内訳（ユーザー指定の配点をそのまま採用）
//  未織り込み度25 + 業績改善25 + 株価割安度15 + 成長率15 + 先行材料10
//  + 今後のイベント10。各サブスコアの具体的な区切り値（tier）は
//  ユーザー指定の例には無かったため、この実装時点での初期値であり、
//  実データを見ながら調整する前提。
//
//  ■ 「割安」と「仕込みどき」を混同しない設計
//  株価割安度(15点)は他のサブスコアの1つに過ぎず、未織り込み度・業績
//  改善・成長率と独立して積み上げる。安いだけで成長していない銘柄は
//  improvement/growthが0点のままなので高スコアにはならない
//  （実測: ハンモック(173A)のような「PERは低いが成長が鈍化している」
//  銘柄を上位に出さないための構造）。
//
//  ■ オーバーライドルール
//  直近1ヶ月・3ヶ月の騰落率が大きければ、スコアの内訳に関係なく強制的に
//  zone:'priced_in'（🔴織り込み済み・新規仕込み対象から除外）にする。
//
//  ■ 日本株・米国株の非対称性について
//  - priceLevelPct: 日本株は直近60営業日（約3ヶ月）レンジでの位置、
//    米国株も同じ関数（priceLevelVsRange）で計算するため対称。
//  - per/sectorPer: 日本株は業種平均PERとの比較が可能（lowPbrSignalと
//    同じデータ源）。米国株はセクター平均PERを算出する仕組みが無い
//    （Phase 1の既知の限界）ため、psrによる代替評価にフォールバックする。
//  - hasCatalyst: 日本株はTDnetの先行材料開示を使えるが、米国株には
//    相当するデータ源が無いため常にfalse（Phase 1の既知の限界）。
export const REPRICING_LAG = {
  surgeReturn1mPct: 20, // 1ヶ月+20%以上は「既に織り込み済み」とみなす
  surgeReturn3mPct: 40, // 3ヶ月+40%以上も同様
  preMovePriceLevelMax: 30, // 60日レンジの下位30%以内なら「株価反応小」
  earlyMoveReturn1mMax: 10, // 1ヶ月+10%未満ならまだ「初動」段階
  // v7.4改修（ユーザーの実銘柄分析）: pre_moveの判定条件がreturn3mを
  // 一切見ておらず、フィットイージー（212A、売上+45.8%・利益+49.6%だが
  // 3ヶ月+26.5%まで既に株価が動いている）のような「業績改善に対して
  // 株価がかなり反応済み」の銘柄もpre_move（未織り込み）に分類され
  // うるバグがあった。surgeReturn3mPct(40%)は「確定的にpriced_inと
  // 言い切れる」ための強い閾値なので、それとは別に「まだpre_moveと
  // 呼ぶには動きすぎ」というゆるい閾値を設ける。
  moveStartReturn3mMax: 20,
  // A指示 項目6「『仕込みゾーン』を5段階に変更する」: 従来のre_rating
  // （🟡再評価進行→🟠と改称）は「株価が動き始めた（return1m>=
  // earlyMoveReturn1mMax）」の一段階しか無く、「高値圏＋短期上昇大」
  // という指示書の「過熱警戒」（新設・re_ratingより一段重い注意）を
  // 表現できなかった。priceLevelPct（60日レンジ内での位置）とreturn1m
  // の両方が高い場合だけoverheatedに分類し、株価位置だけ高くても短期
  // 上昇が小さい場合（業績改善無しで既に高値圏、というだけのケース）は
  // 従来通りre_ratingのままにする（実測: repricingLagScoreの既存テスト
  // でpriceLevelPct=80だがreturn1m=2%のケースはre_ratingが妥当と判断）。
  overheatPriceLevelMin: 70,
  overheatReturn1mMin: 15,
  // A指示 項目5-1「オーバーライドルールの例外」: 指示書の実例（売上
  // +100%・利益+150%・株価3M+25%→まだ完全織り込みとは限らない、
  // performanceRate-priceReaction=125-25=100）を踏まえ、極端なケース
  // だけに限定する保守的な閾値。
  exceptionMinGapPct: 60,
};

function growthTier(pct, tiers) {
  if (!Number.isFinite(pct)) return 0;
  for (const t of tiers) if (pct >= t.min) return t.pt;
  return 0;
}

export function repricingLagScore({
  return1m, return3m, priceLevelPct,
  revenueGrowthPct, profitGrowthPct,
  per, sectorPer, psr,
  hasCatalyst, daysToEarnings,
  // v7.4改修（ユーザーの実銘柄分析、7607進和のケース）: 進捗率の
  // 連続加速（progressStreakSignal、既にscreener.mjs/smart_entry.mjsで
  // 計算済み）を「未織り込み度」に一切反映していなかった。7607は
  // 対通期進捗率が93.3%まで2年連続で加速しているのに、revenueGrowthPct/
  // profitGrowthPctだけを見るimprovementでは反映しきれず妙味56/100に
  // 留まっていた。任意引数（呼び出し元が渡さなければ従来通りボーナス
  // 無しに縮退。us_screener.mjsには進捗率の概念が無いため渡さない）。
  progressStreak,
} = {}) {
  const untapped = Number.isFinite(priceLevelPct) ? round1(25 * (1 - priceLevelPct / 100)) : 0;

  const progressBonus = progressStreak?.level === 'good' ? 5 : 0;
  const improvement = round1(Math.min(25,
    growthTier(revenueGrowthPct, [{ min: 25, pt: 12.5 }, { min: 10, pt: 8 }, { min: 0, pt: 4 }])
    + growthTier(profitGrowthPct, [{ min: 25, pt: 12.5 }, { min: 10, pt: 8 }, { min: 0, pt: 4 }])
    + progressBonus
  ));
  const growth = round1(
    growthTier(revenueGrowthPct, [{ min: 30, pt: 7.5 }, { min: 15, pt: 5 }, { min: 5, pt: 2.5 }])
    + growthTier(profitGrowthPct, [{ min: 30, pt: 7.5 }, { min: 15, pt: 5 }, { min: 5, pt: 2.5 }])
  );

  // 株価割安度(15): 業種平均PERとの比較を優先（sectorPerが無ければPSRで代替）。
  let valuation = 0;
  if (Number.isFinite(per) && Number.isFinite(sectorPer) && sectorPer > 0) {
    const ratio = per / sectorPer;
    valuation = ratio <= 0.7 ? 15 : ratio <= 1.0 ? 10 : ratio <= 1.3 ? 5 : 0;
  } else if (Number.isFinite(psr)) {
    valuation = psr <= 1 ? 15 : psr <= 3 ? 10 : psr <= 6 ? 5 : 0;
  }

  const catalyst = hasCatalyst ? 10 : 0;

  let event = 0;
  if (Number.isFinite(daysToEarnings) && daysToEarnings >= 0) {
    event = daysToEarnings <= 14 ? 10 : daysToEarnings <= 30 ? 7 : daysToEarnings <= 60 ? 4 : 1;
  }

  // v7.4改修（ユーザーの実銘柄分析）: 「既に動いた銘柄」への減点。
  // alreadySurged（下のsurgeReturn1m/3mPct、20%/40%）は「確定的に
  // priced_inと言い切れる」強い閾値でzoneをpriced_inに強制するための
  // ものだが、そこまで動いていなくても「もうpre_moveとは呼べない」
  // 水準（1ヶ月+10%または3ヶ月+20%）で株価が反応し始めている銘柄の
  // 素点自体は従来まったく減点されていなかった（実測: ASTHが1ヶ月
  // +7.6%まで初動が始まっているのに妙味77.1のまま）。
  const alreadyMovedStrict = (Number.isFinite(return1m) && return1m >= REPRICING_LAG.earlyMoveReturn1mMax)
    || (Number.isFinite(return3m) && return3m >= REPRICING_LAG.moveStartReturn3mMax);

  // A指示 項目5-1「1M/3M騰落率のオーバーライドルールの例外」: 株価が
  // 大きく上昇していても、業績改善率が株価上昇率を大きく上回る場合は
  // 未織り込み判定を完全には消さない（指示書の実例: 売上+100%・利益
  // +150%・株価3M+25%はまだ完全織り込みとは限らない）。performanceRate
  // （売上・利益成長率の平均）とpriceReaction（3ヶ月優先・無ければ
  // 1ヶ月）の差がexceptionMinGapPct以上あるときだけ発動する、極端な
  // ケース限定の例外（成長データが無い呼び出し元では従来通り作動しない
  // ため、584A/581Aの実測バグ再発防止テストには影響しない）。
  const performanceRate = [revenueGrowthPct, profitGrowthPct].filter(Number.isFinite).length
    ? [revenueGrowthPct, profitGrowthPct].filter(Number.isFinite).reduce((a, b) => a + b, 0) / [revenueGrowthPct, profitGrowthPct].filter(Number.isFinite).length
    : null;
  const priceReactionForException = Number.isFinite(return3m) ? return3m : Number.isFinite(return1m) ? return1m : null;
  const exceptionApplies = performanceRate !== null && priceReactionForException !== null
    && (performanceRate - priceReactionForException) >= REPRICING_LAG.exceptionMinGapPct;

  let score = Math.max(0, Math.min(100, round1(untapped + improvement + valuation + growth + catalyst + event)));
  if (alreadyMovedStrict) score = Math.round(score * (exceptionApplies ? 0.8 : 0.5));

  const alreadySurged = ((Number.isFinite(return1m) && return1m >= REPRICING_LAG.surgeReturn1mPct)
    || (Number.isFinite(return3m) && return3m >= REPRICING_LAG.surgeReturn3mPct)) && !exceptionApplies;

  // 判定に最低限必要なデータ（株価の位置と業績改善の両方）が無ければ、
  // ゾーンを無理に決め打ちしない（他のchecked flagパターンと同じ思想）。
  const hasMinimumData = Number.isFinite(priceLevelPct) && (Number.isFinite(revenueGrowthPct) || Number.isFinite(profitGrowthPct));

  // 実測バグ: alreadySurged（直近1ヶ月/3ヶ月の騰落率だけで判定できる）は
  // priceLevelPct/成長率が無くても確定的に真偽が分かるのに、checkedを
  // hasMinimumDataだけで決めていたため、株価が既に急騰したことは分かって
  // いるのに「判定不可（灰色）」と表示され、🔴織り込み済みの警告が
  // scraper.mjs側（checked===trueをゲートにしている）で握りつぶされて
  // いた（実測: 584A・581Aがzone:'priced_in'なのにchecked:falseのため
  // 警告バッジが出ていなかった）。alreadySurgedはhasMinimumDataとは
  // 独立に「確定的に判定できた」ことを意味するので、OR条件にする。
  const checked = hasMinimumData || alreadySurged;

  let zone = null;
  if (alreadySurged) {
    zone = 'priced_in';
  } else if (hasMinimumData) {
    if (priceLevelPct <= REPRICING_LAG.preMovePriceLevelMax
        && (!Number.isFinite(return1m) || return1m < REPRICING_LAG.earlyMoveReturn1mMax)
        && (!Number.isFinite(return3m) || return3m < REPRICING_LAG.moveStartReturn3mMax)
        && improvement > 0) {
      zone = 'pre_move';
    } else if (Number.isFinite(return1m) && return1m >= REPRICING_LAG.earlyMoveReturn1mMax) {
      const overheated = priceLevelPct >= REPRICING_LAG.overheatPriceLevelMin && return1m >= REPRICING_LAG.overheatReturn1mMin;
      zone = overheated ? 'overheated' : 're_rating';
    } else if (priceLevelPct >= REPRICING_LAG.overheatPriceLevelMin) {
      // A指示 項目26「52週位置と騰落率の矛盾を説明する」実例（1M+4%
      // なのに52週位置95%）の再発防止: 直近1ヶ月の上昇が小さくても、
      // レンジ内の位置自体が既に高値圏（overheatPriceLevelMin以上）なら
      // 「初動」（まだ仕込める）とは呼べない。改善データの有無に関わらず
      // 「長期的には既に高値圏」の消極的なre_ratingとして扱う（実測バグ:
      // 従来はimprovement>0であればreturn1mの大小・priceLevelPctの高さを
      // 見ずにearly_moveへ分類していた）。
      zone = 're_rating';
    } else if (improvement > 0) {
      zone = 'early_move';
    } else {
      zone = 're_rating'; // 業績改善が無いのに株価だけ位置が高い、等の消極ケース
    }
  }

  return { score, zone, breakdown: { untapped, improvement, valuation, growth, catalyst, event }, checked, alreadyMovedStrict };
}

// v7.4改修（ユーザーの実銘柄分析）: SMART ENTRYの同点乱発対策。
// smartEntryConvictionは該当パターン数×100＋チップ加点/減点という粗い
// 整数バケット構成で、実データで検証したところ松屋(PER224・PBR4.3)を
// 含む7銘柄が全く同じconviction=145点で並んでいた。タイブレークが乖離率
// (kairi)だけなので、割安度がまるで違う銘柄が同格に扱われ、PER224倍の
// 銘柄がPER17.2倍の銘柄より上位に来る逆転が起きていた。repricingLagScore
// の`valuation`計算（業種平均PER/PBRとの比率）と同じ考え方を、独立した
// 関数として切り出して再利用する。
export function valuationQualityScore({ per, sectorPer, pbr, sectorPbr } = {}) {
  let score = 0;
  let checked = false;
  if (Number.isFinite(per) && Number.isFinite(sectorPer) && sectorPer > 0) {
    checked = true;
    const ratio = per / sectorPer;
    score += ratio <= 0.7 ? 15 : ratio <= 1.0 ? 10 : ratio <= 1.3 ? 5 : 0;
  }
  if (Number.isFinite(pbr) && Number.isFinite(sectorPbr) && sectorPbr > 0) {
    checked = true;
    const ratio = pbr / sectorPbr;
    score += ratio <= 0.7 ? 15 : ratio <= 1.0 ? 10 : ratio <= 1.3 ? 5 : 0;
  }
  return { score, checked };
}
