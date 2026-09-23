// ==================================================================
// kabutan.mjs — kabutan.jp 取得・パース（依存ゼロ）
//
//  v7.0 で scraper.mjs に直書きしていたものを、AMBUSHスクリーナと
//  共用するために切り出したもの。ロジックは変更していない。
// ==================================================================

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
export const REQ_GAP = 600; // kabutanへの最小リクエスト間隔(ms)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// リクエストのタイムアウト（実測: 長時間バッチ実行中にMacがスリープすると
// fetchが永久に応答を待ち続け、プロセス全体が数十分〜無期限にハングする
// 事象が発生した。AbortControllerで打ち切ることで、スリープ復帰後に
// タイムアウト→retriesの通常のリトライ経路に乗せ、ハングを防ぐ）。
const FETCH_TIMEOUT_MS = 30_000;

export async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (res.ok) return await res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------------
// 軽量HTMLテーブルパーサ
// ------------------------------------------------------------------
export const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export const toNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function parseTables(html) {
  const tables = [];
  for (const t of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const r of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => stripTags(c[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// th/td一対の行（見出し+値の2セル行）からキーワード一致する行の値を拾う。
// pickByHeader が前提とする「見出し行→複数の本体行」という表形式ではなく、
// 「時価総額」「発行済株式数」のように1行=1項目で載っている箇所に使う。
export function pickRowValue(tables, keyword) {
  for (const rows of tables) {
    for (const r of rows) {
      if (r[0]?.includes(keyword)) {
        const v = toNum(r[1]);
        if (v !== null) return v;
      }
    }
  }
  return null;
}

// ヘッダ語をすべて含むテーブルを返す（複数該当時は行数が最大のもの）
export function findTable(tables, keywords) {
  let best = null;
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => keywords.every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    if (!best || rows.length > best.rows.length) best = { rows, hIdx };
  }
  return best;
}

// 列ヘッダ表から、その列に数値が入っている最後の行の値を取る
// （「前年同期比」などの非数値行を自動的に読み飛ばす）。
//
// ※ 決算期（年度/四半期）ごとの実績・予想が並ぶテーブルには使わないこと。
// 「予」始まりの会社予想行を除外するガードが無いため、そのまま使うと
// 会社予想を実績と誤認する（実測: 進捗率・自己資本比率をこの関数で
// 拾っていた時期があったが、営業益・ROEと同じ決算期テーブル形式である
// 以上は同じ再発リスクがあるため、pickLatestActual()に統一した）。
// このためparseMain()の単一行の現在値（PER/PBR/利回り/信用倍率）専用。
export function pickByHeader(tables, keyword) {
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => r.some((c) => c.includes(keyword)));
    if (hIdx === -1) continue;
    const col = rows[hIdx].findIndex((c) => c.includes(keyword));
    const header = rows[hIdx][col];
    const body = rows.slice(hIdx + 1).filter((r) => r.length === rows[hIdx].length);
    for (let i = body.length - 1; i >= 0; i--) {
      const v = toNum(body[i][col]);
      if (v !== null) return { value: v, header };
    }
  }
  return { value: null, header: null };
}

// ------------------------------------------------------------------
// kabuka ページ … 現在値・30日分の終値/出来高・マクロが1枚に載っている
// ------------------------------------------------------------------
export function parseKabuka(html) {
  const tables = parseTables(html);

  const today = findTable(tables, ['本日', '終値']);
  const hist = findTable(tables, ['日付', '終値']);
  if (!hist) throw new Error('時系列テーブルが見つかりません');

  const col = (t, name) => t.rows[t.hIdx].findIndex((c) => c.includes(name));

  const hOpen = col(hist, '始値');
  const hHigh = col(hist, '高値');
  const hLow = col(hist, '安値');
  const hClose = col(hist, '終値');
  const hVol = col(hist, '売買高');
  const series = hist.rows
    .slice(hist.hIdx + 1)
    .filter((r) => r.length === hist.rows[hist.hIdx].length && toNum(r[hClose]) !== null)
    .map((r) => ({
      open: toNum(r[hOpen]), high: toNum(r[hHigh]), low: toNum(r[hLow]),
      close: toNum(r[hClose]), vol: toNum(r[hVol]),
    }))
    .reverse(); // 古い → 新しい

  let price = null, changePct = null, vol = null;
  if (today) {
    const row = today.rows[today.hIdx + 1];
    if (row) {
      price = toNum(row[col(today, '終値')]);
      changePct = toNum(row[col(today, '前日比％')]);
      vol = toNum(row[col(today, '売買高')]);
      series.push({
        open: toNum(row[col(today, '始値')]), high: toNum(row[col(today, '高値')]),
        low: toNum(row[col(today, '安値')]), close: price, vol,
      });
    }
  }
  if (price === null && series.length) {
    price = series.at(-1).close;
    vol = series.at(-1).vol;
  }

  let macro = { nikkei: null, usdjpy: null };
  const mt = findTable(tables, ['日経平均', '米ドル円']);
  if (mt) {
    const row = mt.rows[mt.hIdx + 1];
    if (row) macro = { nikkei: toNum(row[0]), usdjpy: toNum(row[2]) };
  }

  // 市場区分（東証Ｐ/Ｓ/Ｇ）はkabukaページのヘッダに既に載っている。
  // 別ページを叩かなくて済むので、全銘柄フィルターをここに乗せられる。
  const mkt = html.match(/<span class="market">([^<]*)</);
  const market = mkt ? stripTags(mkt[1]) : null;

  return {
    price,
    changePct,
    vol,
    opens: series.map((s) => s.open),
    highs: series.map((s) => s.high),
    lows: series.map((s) => s.low),
    closes: series.map((s) => s.close),
    volumes: series.map((s) => s.vol),
    macro,
    market,
  };
}

export async function fetchIntraday(code) {
  return parseKabuka(await getText(`https://kabutan.jp/stock/kabuka?code=${code}`));
}

// kabukaページの&page=Nで過去分に遡れる（実測: 1ページ=約30営業日、
// page2は page1 の最古日の前日から更に約30営業日）。セリングクライマックス
// 判定は直近15営業日+20日平均の基準が要るため35日以上欲しいが、
// 通常の1ページ(30日)だけでは足りない。候補銘柄だけに絞って呼ぶ用途
// （全銘柄には使わない＝コストが見合わないため）。
export async function fetchIntradayExtended(code, pages = 2) {
  const base = await fetchIntraday(code);
  let opens = base.opens, highs = base.highs, lows = base.lows, closes = base.closes, volumes = base.volumes;
  for (let p = 2; p <= pages; p++) {
    await sleep(REQ_GAP);
    let tables;
    try {
      tables = parseTables(await getText(`https://kabutan.jp/stock/kabuka?code=${code}&page=${p}`));
    } catch {
      break; // これ以上遡れない/取得失敗。ここまでの日数で判定する
    }
    const hist = findTable(tables, ['日付', '終値']);
    if (!hist) break;
    const header = hist.rows[hist.hIdx];
    const col = (name) => header.findIndex((c) => c.includes(name));
    const hOpen = col('始値'), hHigh = col('高値'), hLow = col('安値'), hClose = col('終値'), hVol = col('売買高');
    const older = hist.rows
      .slice(hist.hIdx + 1)
      .filter((r) => r.length === header.length && toNum(r[hClose]) !== null)
      .map((r) => ({
        open: toNum(r[hOpen]), high: toNum(r[hHigh]), low: toNum(r[hLow]),
        close: toNum(r[hClose]), vol: toNum(r[hVol]),
      }))
      .reverse(); // ページ内は新→古なので古→新に揃える
    if (!older.length) break;
    opens = [...older.map((o) => o.open), ...opens];
    highs = [...older.map((o) => o.high), ...highs];
    lows = [...older.map((o) => o.low), ...lows];
    closes = [...older.map((o) => o.close), ...closes];
    volumes = [...older.map((o) => o.vol), ...volumes];
  }
  return { ...base, opens, highs, lows, closes, volumes };
}

// ------------------------------------------------------------------
// 個別ページ … 信用倍率・PER・業種
// ------------------------------------------------------------------
export function parseMain(html) {
  const tables = parseTables(html);
  const loan = pickByHeader(tables, '信用倍率');
  const per = pickByHeader(tables, 'PER');
  const pbr = pickByHeader(tables, 'PBR');
  const dividendYield = pickByHeader(tables, '利回り');
  // 「時価総額」「発行済株式数」は見出し+値の1行完結セルなのでpickRowValueで拾う。
  // 時価総額は億円単位（実測: "1,819億円"）なので百万円に揃える（×100）。
  const marketCapOku = pickRowValue(tables, '時価総額');
  // 業種は "/themes/?industry=16&market=1">電気機器" の形で入っている
  const sec = html.match(/href="\/themes\/\?industry=(\d+)[^"]*"[^>]*>([^<]+)</);
  const mkt = html.match(/<span class="market">([^<]*)</);
  return {
    loanRatio: loan.value,
    per: per.value,
    pbr: pbr.value,
    dividendYield: dividendYield.value,
    marketCap: marketCapOku !== null ? marketCapOku * 100 : null, // 百万円
    sharesOutstanding: pickRowValue(tables, '発行済株式数'),
    sectorId: sec ? sec[1] : null,
    sectorName: sec ? stripTags(sec[2]) : null,
    market: mkt ? stripTags(mkt[1]) : null,
  };
}

export async function fetchMain(code) {
  return parseMain(await getText(`https://kabutan.jp/stock/?code=${code}`));
}

// ------------------------------------------------------------------
// 東証【業種別】騰落ランキング … 33業種が3ページ（15+15+3）に載っている
//
//  Yahoo/stooq が使えないため、セクターモメンタムはここから取る。
//  1日の騰落率しか載っていないので、複数日のモメンタムは
//  日次で指数値を貯めて後から算出する（screener側で履歴を保持）。
// ------------------------------------------------------------------
export async function fetchSectorMomentum() {
  const out = {};
  for (let p = 1; p <= 3; p++) {
    if (p > 1) await sleep(REQ_GAP);
    const html = await getText(`https://kabutan.jp/warning/?mode=9_1&page=${p}`);
    for (const rows of parseTables(html)) {
      if (!rows[0]?.includes('銘柄数')) continue;
      for (const r of rows.slice(1)) {
        // [コード, 業種名, 銘柄数, '', 指数, '', 前日比, 前日比%, PER, PBR, 利回り]
        const name = r[1];
        const idx = toNum(r[4]);
        const pct = toNum(r[7]);
        if (name && idx !== null) {
          // 業種平均PER/PBR/利回り。個別銘柄と比べて「業種内でどの位置に
          // あるか」を見る用（このページは既に取得済みなので追加リクエスト
          // は無し）。
          out[name] = {
            sectorCode: r[0], index: idx, changePct: pct, count: toNum(r[2]),
            per: toNum(r[8]), pbr: toNum(r[9]), dividendYield: toNum(r[10]),
          };
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------
// 週次信用残ページ … 買い残/売り残/信用倍率の週次推移（約30週分）
//
//  「スマート・エントリー」3パターンの信用残トレンド判定に使う。
//  kabuka ページのヘッダにある「週次信用残」リンク先（実測: &ashi=shin）。
//  配列は新しい週が先頭（ページ表示順のまま）。
// ------------------------------------------------------------------
// 終値（実測: 同じテーブルに「日付/終値/前週比率/売買単価/売買高(株)/
// 売り残(株)/買い残(株)/信用倍率」の順で列がある）は、第9優先改修
// Phase6の需給タイムライン（indicators.mjs: creditSupplyTimeline）が
// 「信用残の観測日と完全に同じ日付の株価」を得るために追加した。日次
// closes配列と日付を突き合わせる（＝日付を持たない配列との近似マッチ）
// 必要が無くなる。
export function parseWeeklyCredit(html) {
  const tables = parseTables(html);
  const t = findTable(tables, ['買い残', '信用倍率']);
  if (!t) throw new Error('週次信用残テーブルが見つかりません');
  const header = t.rows[t.hIdx];
  const col = (name) => header.findIndex((c) => c.includes(name));
  const cDate = col('日付'), cBuy = col('買い残'), cSell = col('売り残'), cRatio = col('信用倍率'), cClose = col('終値');
  return t.rows
    .slice(t.hIdx + 1)
    .filter((r) => r.length === header.length)
    .map((r) => ({ date: r[cDate], buy: toNum(r[cBuy]), sell: toNum(r[cSell]), loanRatio: toNum(r[cRatio]), close: cClose === -1 ? null : toNum(r[cClose]) }))
    .filter((r) => r.buy !== null);
}

export async function fetchWeeklyCredit(code) {
  return parseWeeklyCredit(await getText(`https://kabutan.jp/stock/kabuka?code=${code}&ashi=shin`));
}

// 決算ページ … 進捗率（SBIの達成率が取れない銘柄の予備）
//
//  見出しは「対通期進捗率」と「対上期進捗率」の2種類がある（実測）。
//  同じ「進捗率」でも分母が通期予想か上期予想かで意味が変わるので、
//  見出しをそのまま返して折返し基準の計算は screener 側に任せる。
//  ここで基準を決め打ちしてはいけない（次回決算期の情報が無いため）。
// 決算実績（決算期,営業益,発表日を持つテーブル全て）から、発表日が最も新しい
// 行の営業益を拾う。年度・中間・四半期のテーブルが複数あり同じ列名を
// 共有しているため、テーブル単位ではなく「発表日」という実日付で最新を
// 判定する（決算期の表記=年度は"2026.03"、中間は"25.04-09"、四半期は
// "24.07-09"とバラバラで期間長の異なる値は直接比較できないが、発表日は
// 全テーブル共通で "23/10/31" 形式の実日付なので文字列比較で安全に最新が
// 取れる）。
// 決算期テーブルから「直近の実績値」を1つ拾う共通ヘルパー。
//
// ■ 再発防止の経緯
// この関数ができる前は、営業益・自己資本・ROEをそれぞれ別々のコードで
// 個別に抽出しており、「決算期セルの『予』始まり行＝会社予想（まだ実現
// していない数値）を除外する」というガードを、なぜかROEの抽出コードにだけ
// 入れ忘れていた（実測: 7921で会社予想ROE 10.79 を実績 10.78 の代わりに
// 表示してしまっていたバグ）。同じ抽出パターンを3箇所に手書きで複製する
// 限り、この種の「1箇所だけガードを書き忘れる」再発を防げないため、
// 抽出ロジックそのものを1つの関数に統合した。
//
// 発表日列がある表（営業益・財務系）は発表日の実日付で最新行を比較する
// （決算期の表記は年度/半期/四半期でバラバラな期間長のため直接比較できない
// が、発表日は全テーブル共通で"23/10/31"形式なので文字列比較で安全）。
// 発表日列が無い表（ROEなど収益性テーブル）は、テーブル内の掲載順（古→新）
// をそのまま信頼し、予想行を除いた最後の行を採用する。
export function pickLatestActual(tables, { findKeywords, valueKeyword, exactValueMatch = false }) {
  const t = findTable(tables, findKeywords);
  if (!t) return null;
  const header = t.rows[t.hIdx];
  const cPeriod = 0;
  // '自己資本'は'自己資本比率'の部分文字列でもあるため、まず完全一致を
  // 優先する（includes()だけだと比率(%)の列を誤って掴む）。
  const exact = exactValueMatch ? header.findIndex((c) => c === valueKeyword) : -1;
  const cVal = exact !== -1 ? exact : header.findIndex((c) => c.includes(valueKeyword));
  const cDate = header.findIndex((c) => c.includes('発表日'));
  let latest = null;
  for (const r of t.rows.slice(t.hIdx + 1)) {
    if (r.length !== header.length) continue;
    // 「決算期」列に「予」が付く行は会社予想（まだ実現していない数値）。
    // 実測: 同じ発表日に実績行と予想行が同居する（例: 6981の26/07/31は
    // 実績 26.04-06=98,454 と、同時発表の通期予想 2027.03=430,000 が
    // 同日付で並ぶ）。日付だけで最新を決めると予想を実績と誤認するため、
    // 予想行はここで必ず弾く。
    if (r[cPeriod]?.includes('予')) continue;
    const v = toNum(r[cVal]);
    if (v === null) continue;
    if (cDate !== -1) {
      const date = r[cDate];
      if (!/^\d{2}\/\d{2}\/\d{2}$/.test(date)) continue;
      if (!latest || date > latest.date) latest = { date, value: v, label: header[cVal] };
    } else {
      latest = { date: null, value: v, label: header[cVal] }; // 発表日列が無い表は掲載順(古→新)を信頼する
    }
  }
  return latest;
}

function parseLatestOperatingProfit(tables) {
  const r = pickLatestActual(tables, { findKeywords: ['決算期', '営業益', '発表日'], valueKeyword: '営業益' });
  return r ? { date: r.date, opProfit: r.value } : null;
}

// 「業績屈折(INFLECTION)」セクション向け: 直近四半期の営業益・前年同期比。
//
// 実測で発覚: latestProfitYoyPct(progressHistory)（既存、parseProgress
// Historyが返す「対上期進捗率」列ベース）は、新規上場銘柄（250Aシマダヤ、
// 2024年10月上場）や直近四半期の進捗率がまだ未公表（「－」表記）の場合に
// データが1点しか残らず計算不能になっていた（実測: 250Aは26.04-06行の
// 対上期進捗率が「－」のため除外され、24.04-06行も何らかの理由で除外
// され、progressHistoryが25.04-06の1点だけになっていた）。
//
// 同じ決算期テーブルの末尾に「前年同期比」という行が必ず存在し、各列
// （売上高・営業益・経常益・最終益・修正1株益）の前年同期比%が直接
// 書かれている（実測: 250Aで営業益-21.1%、ユーザーが引用した「▲21%」と
// 一致）。この既に計算済みの値を使う方が、進捗率列の欠落に影響されず
// 確実。「2.6倍」のような倍率表記（急変時にkabutanが%の代わりに使う）は
// 符号を含む単純な変化率とは意味が違う別形式のため、null（推測しない）
// にする。
export function parseLatestQuarterlyOperatingProfitYoY(tables) {
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '営業益', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cProfit = header.findIndex((c) => c.includes('営業益'));
    const body = rows.slice(hIdx + 1).filter((r) => r.length === header.length);
    const yoyRow = body.find((r) => (r[cPeriod] ?? '').trim() === '前年同期比');
    if (!yoyRow) continue;
    const cell = (yoyRow[cProfit] ?? '').trim();
    if (cell.includes('倍')) continue; // 倍率表記は対象外（推測しない）
    const opProfitYoyPct = toNum(cell.replace(/^\+/, ''));
    if (opProfitYoyPct === null) continue;
    // 前年同期比行の直前（最新の実績行）の決算期を、この YoY が指す期間として返す。
    const latestRow = [...body].reverse().find((r) => (r[cPeriod] ?? '').trim() !== '前年同期比');
    return { period: latestRow?.[cPeriod] ?? null, opProfitYoyPct };
  }
  return null;
}

// ==================================================================
// 「業績屈折(SECTION D)」新スペック（ユーザー提案2026-09-12）向けの
// 拡張抽出。①割安財務レンジ・③1Q売上－経常益スプレッド・④1Q進捗
// サプライズ・⑤次の公式チェックポイント（中間期or通期）ハードル比率、
// を計算するための生データを提供する。ユーザー要望「1Q/2Q/3Q/4Q…
// 時期ごとに臨機応変に」に対応するため、「直近四半期＝Q1」を前提に
// せず、kabutanの決算期テーブルが今どの公式チェックポイント（対上期
// 進捗率＝Q1時点／対通期進捗率＝中間期・Q3時点）を示しているかを
// そのまま読み取って処理を分岐する。
// ==================================================================

// kabutanのYoY表記は単純な±X.X%だけでなく、符号跨ぎ・極端な変化のときに
// 定性的な特殊表記を使う（実測: 250A/8185/6058/5246の実データで確認）。
//   "N倍"  … N倍（プラス同士で急拡大。例:"2.6倍""19倍""6.9倍"）
//   "黒転" … 赤字→黒字転換（このセクションが最も見たい状態）
//   "赤縮" … 赤字幅縮小（赤字のまま改善）
//   "－"/空… データ無し
// これらをtoNum()にそのまま渡すとnullになり、ただの「データ無し」と
// 区別が付かなくなる（「黒転」を見逃す＝最重要のシグナルを取りこぼす）
// ため、専用のパーサーで状態を区別する。
export function parseYoyCell(cell) {
  const s = (cell ?? '').trim();
  if (!s || s === '－') return { pct: null, state: 'none' };
  if (s.endsWith('倍')) {
    const n = toNum(s.slice(0, -1));
    return n === null ? { pct: null, state: 'unknown' } : { pct: Math.round((n - 1) * 1000) / 10, state: 'multiple' };
  }
  if (s === '黒転') return { pct: null, state: 'turned_profitable' };
  if (s === '赤字転落' || s === '黒字転落') return { pct: null, state: 'turned_loss' };
  if (s === '赤縮') return { pct: null, state: 'loss_narrowing' };
  if (s === '赤拡') return { pct: null, state: 'loss_widening' };
  const n = toNum(s.replace(/^\+/, ''));
  return n === null ? { pct: null, state: 'unknown' } : { pct: n, state: 'numeric' };
}

// 決算期の月範囲（末尾"MM-MM"）から期間の長さ（月数）を判定する。
// 年度表記("YYYY.MM"、ダッシュ無し)はnull（＝通期）を返す。年をまたぐ
// 範囲（例:"12-05"）にも対応する。
export function periodSpanMonths(period) {
  const m = (period ?? '').match(/(\d{2})-(\d{2})$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return b >= a ? b - a + 1 : 12 - a + b + 1;
}

// 「チェックポイント」テーブル＝進捗率列（対上期進捗率／対通期進捗率）
// を持つ決算期テーブル。Q1時点なら3ヶ月区切りで「対上期進捗率」、
// 中間期(H1)やQ3時点ならそれより長い区切りで「対通期進捗率」という
// ように、直近の公式チェックポイントに応じて自動的に切り替わる
// （実測: 250A/8185は対上期進捗率＝Q1、5246は対通期進捗率＝中間期）。
export function parseCheckpointTrend(tables) {
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) =>
      ['決算期', '売上高', '営業益', '経常益'].every((k) => r.some((c) => c.includes(k)))
      && r.some((c) => c === '対上期進捗率' || c === '対通期進捗率'));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cRevenue = header.findIndex((c) => c.includes('売上高'));
    const cOp = header.findIndex((c) => c.includes('営業益'));
    const cOrdinary = header.findIndex((c) => c.includes('経常益'));
    const cProgress = header.findIndex((c) => c === '対上期進捗率' || c === '対通期進捗率');
    const body = rows.slice(hIdx + 1).filter((r) => r.length === header.length);
    const actualRows = body.filter((r) => (r[cPeriod] ?? '').trim() !== '前年同期比');
    if (!actualRows.length) continue;
    const yoyRow = body.find((r) => (r[cPeriod] ?? '').trim() === '前年同期比');
    const latest = actualRows.at(-1);
    const priorRows = actualRows.slice(0, -1);
    const priorProgressPcts = priorRows.map((r) => toNum(r[cProgress])).filter((v) => v !== null);
    // ⑤ハードル比率（indicators.mjs）用: 過去年度の同じチェックポイント
    // 時点の経常益実績（進捗率%ではなく実額）。nextMilestoneの
    // priorOrdinaryProfitActualsと同じ並び順（古→新）で対応させる。
    const priorOrdinaryProfitActuals = priorRows.map((r) => toNum(r[cOrdinary])).filter((v) => v !== null);
    const emptyYoy = { pct: null, state: null };
    return {
      period: (latest[cPeriod] ?? '').replace(/\*$/, ''),
      periodMonths: periodSpanMonths(latest[cPeriod]),
      progressLabel: header[cProgress],
      progressPct: toNum(latest[cProgress]),
      priorProgressPcts,
      priorOrdinaryProfitActuals,
      revenue: { actual: toNum(latest[cRevenue]), ...(yoyRow ? parseYoyCell(yoyRow[cRevenue]) : emptyYoy) },
      opProfit: { actual: toNum(latest[cOp]), ...(yoyRow ? parseYoyCell(yoyRow[cOp]) : emptyYoy) },
      ordinaryProfit: { actual: toNum(latest[cOrdinary]), ...(yoyRow ? parseYoyCell(yoyRow[cOrdinary]) : emptyYoy) },
    };
  }
  return null;
}

// 直近チェックポイントの次に来る公式指標（対上期進捗率ならH1(中間期)
// 予想、対通期進捗率なら通期予想）の経常益予想と、過去の同じ区切りの
// 実績を返す。「ハードル比率」＝(次の公式予想－直近チェックポイント
// 実績)÷(過去の「次の公式実績－過去のチェックポイント実績」平均)の
// 計算に使う（呼び出し側で組み立てる。ここではデータの提供のみ）。
//
// 実測(250Aシマダヤ)で確認した重要な制約: 中間期(H1)決算予想を開示
// しない方針の会社では、H1予想欄が全て「－」になる（実測: 250Aは
// 中間期予想を一度も開示していない）。この場合forecastOrdinaryProfit
// はnullを返す（進捗率から逆算するような推測はしない）。
export function parseNextMilestoneForecast(tables, progressLabel) {
  const targetSpan = progressLabel === '対上期進捗率' ? 6 : null; // null=年度(YYYY.MM)通期テーブル
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) =>
      ['決算期', '売上高', '営業益', '経常益', '発表日'].every((k) => r.some((c) => c.includes(k)))
      && !r.some((c) => c === '対上期進捗率' || c === '対通期進捗率'));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cOrdinary = header.findIndex((c) => c.includes('経常益'));
    const body = rows.slice(hIdx + 1).filter((r) => r.length === header.length);
    const forecastRow = body.find((r) => (r[cPeriod] ?? '').includes('予'));
    if (!forecastRow) continue;
    const forecastPeriod = (forecastRow[cPeriod] ?? '').replace(/^予\s*/, '');
    if (periodSpanMonths(forecastPeriod) !== targetSpan) continue;
    // 実測バグ: 末尾の「前年同期比」「前期比」行（YoY%であって実額では
    // ない）を「予」を含まないという理由だけで実績行に混入させていた
    // （8185で経常益列の値が[1070,1829,1494]のはずが、末尾行の
    // 「+13.8」(YoY%)まで実額として拾われ[1070,1829,1494,13.8]に
    // なっていた）。期間列が「前年同期比」「前期比」の行は明示的に除外する。
    const actualRows = body.filter((r) => {
      const p = (r[cPeriod] ?? '').trim();
      return !p.includes('予') && p !== '前年同期比' && p !== '前期比';
    });
    return {
      forecastOrdinaryProfit: toNum(forecastRow[cOrdinary]),
      priorOrdinaryProfitActuals: actualRows.map((r) => toNum(r[cOrdinary])).filter((v) => v !== null),
    };
  }
  return null;
}

// ①割安・財務レンジ向け。自己資本比率と同じ表（１株純資産／自己資本
// 比率／総資産／自己資本／剰余金／有利子負債倍率／発表日）から「有利子
// 負債倍率」（＝有利子負債÷自己資本。実測値0.01〜2.69で確認済み、
// 「有利子負債自己資本比率」に相当）を取得する。
export function parseLatestDebtEquityRatio(tables) {
  const r = pickLatestActual(tables, { findKeywords: ['自己資本比率', '有利子負債倍率', '発表日'], valueKeyword: '有利子負債倍率' });
  return r ? r.value : null;
}

// ①コア・スクリーニング条件のROE判定向け（ユーザー提案2026-09-13の
// 改良版）: 直近期のROE単体（旧実装）だと「まさに今探している一時的な
// 悪化」自体がROEを押し下げてしまい、本来は稼ぐ力のある実力企業まで
// 弾いてしまう（実測: NISSHA(7915)は直近ROE0.87%だが、過去実績も
// 通期予想も低ROEな体質と判明。逆にタマホーム(1419)は直近ROE3.8%でも
// 通期予想ベースでは13.48%まで戻る）。「過去実績の平均ROE」と「会社
// 予想ベースの今期予想ROE」の両方を返し、indicators.mjsのcoreScreening
// Signal側でOR条件（どちらか一方が基準を満たせば良い）として使う。
export function parseRoeHistory(tables) {
  const t = findTable(tables, ['ＲＯＥ', '売上営業利益率']);
  if (!t) return null;
  const header = t.rows[t.hIdx];
  const cPeriod = 0;
  const cRoe = header.findIndex((c) => c.includes('ＲＯＥ'));
  const body = t.rows.slice(t.hIdx + 1).filter((r) => r.length === header.length);
  const actualRows = body.filter((r) => !(r[cPeriod] ?? '').includes('予'));
  const forecastRow = body.find((r) => (r[cPeriod] ?? '').includes('予'));
  const actualRoes = actualRows.map((r) => toNum(r[cRoe])).filter((v) => v !== null);
  const forecastRoe = forecastRow ? toNum(forecastRow[cRoe]) : null;
  if (!actualRoes.length && forecastRoe === null) return null;
  return { actualRoes, forecastRoe };
}

// 通期決算（決算期が"YYYY.MM"の年度表記のみ、四半期/中間は対象外）の
// 売上高を新しい順に2期ぶん拾い、直近の前期比成長率(%)を返す。
// 売上債権(IR Bank)の伸びと比較して「回収サイクルが伸びていないか」の
// 判定に使う。粒度をkabutan/IR Bank双方とも年度決算に揃えることで、
// 四半期と年度を誤って比較しない（実測: 決算期の書式で見分けられる）。
export function parseAnnualRevenueYoY(tables) {
  const rowsAll = [];
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '売上高', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cSales = header.findIndex((c) => c.includes('売上高'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      if (r[cPeriod]?.includes('予')) continue; // 会社予想はまだ実現していない数値
      // 決算期表記には先頭に会計基準の注記「I 」（IFRS等、実測:6981）や
      // 末尾に「*」（実測:456A）が付くことがある。年度判定そのものには
      // 影響しないので除去してから判定する。
      const period = (r[cPeriod] ?? '').replace(/^I\s+/, '').replace(/\*$/, '');
      if (!/^\d{4}\.\d{2}$/.test(period)) continue; // 年度決算のみ（四半期/中間を除く）
      const sales = toNum(r[cSales]);
      if (sales === null) continue;
      // このテーブルは古い年度の発表日を「－」としか出さない実測がある
      // （456A: 2023〜2025年度は発表日なし、2026年度のみ実日付）ため、
      // 発表日の有無では絞らず、テーブル内の掲載順（古→新の実測）を使う。
      rowsAll.push({ period, sales });
    }
  }
  const uniq = [...new Map(rowsAll.map((r) => [r.period, r])).values()].sort((a, b) => a.period.localeCompare(b.period));
  if (uniq.length < 2) return null;
  const [prev, latest] = uniq.slice(-2);
  if (prev.sales === 0) return null;
  // 成長の「加速」判定（ユーザー提案）用に、直近期だけでなく1つ前の期の
  // YoY成長率も分かれば返す。3期分未満、またはp2の売上高が0の場合は
  // prevGrowthPct:null（既存のgrowthPct/latestSalesの意味は変えない）。
  let prevGrowthPct = null;
  if (uniq.length >= 3) {
    const p2 = uniq.at(-3);
    if (p2.sales !== 0) {
      prevGrowthPct = Math.round(((prev.sales - p2.sales) / p2.sales) * 1000) / 10;
    }
  }
  return {
    growthPct: Math.round(((latest.sales - prev.sales) / prev.sales) * 1000) / 10,
    prevGrowthPct,
    latestPeriod: latest.period, prevPeriod: prev.period,
    // 仕込み妙味スコア（PSR算出）用。売上高は百万円単位（kabutanの決算期
    // テーブルの一般的な単位。marketCapと同じ「百万円」なので単位変換は
    // 不要）。
    latestSales: latest.sales,
  };
}

// 通期の営業利益「予想」を含めたYoY（ユーザー提案「業績屈折(INFLECTION)」
// セクション向け）。既存のparseAnnualRevenueYoYは「予」始まりの会社予想
// 行を意図的に除外しているが（まだ実現していない数値のため実績同士の
// 比較にしか使いたくない）、ここでは逆に直近の会社予想を主役として
// 使いたい（「今期の四半期は減益でも、通期予想は底堅い」を検出したい）。
// 実データ(250A シマダヤ)で確認済み: 2026.03実績営業益3,768百万円→
// 2027.03予想3,700百万円（表記上のブレはあるが会社側は▲2%弱の据え置き
// 水準で見ている、というように「実績→予想」の変化率を機械的に出せる）。
export function parseAnnualOperatingProfitForecastYoY(tables) {
  const rowsAll = [];
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '営業益', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cProfit = header.findIndex((c) => c.includes('営業益'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      const rawPeriod = r[cPeriod] ?? '';
      const isForecast = rawPeriod.includes('予');
      // 「I 」（IFRS等）・「連 」（連結）・末尾「*」等の注記を除去してから
      // 判定する（parseAnnualRevenueYoYと同じ理由）。
      const period = rawPeriod.replace(/^[I連\s]+/, '').replace(/\*$/, '').replace(/^予\s*/, '');
      if (!/^\d{4}\.\d{2}$/.test(period)) continue;
      const opProfit = toNum(r[cProfit]);
      if (opProfit === null) continue;
      rowsAll.push({ period, opProfit, isForecast });
    }
  }
  const actuals = [...new Map(rowsAll.filter((r) => !r.isForecast).map((r) => [r.period, r])).values()]
    .sort((a, b) => a.period.localeCompare(b.period));
  const forecasts = rowsAll.filter((r) => r.isForecast).sort((a, b) => a.period.localeCompare(b.period));
  const latestActual = actuals.at(-1);
  const latestForecast = forecasts.at(-1);
  if (!latestActual || !latestForecast) return null;
  // pct系の既存関数（operatingCfGrowthPct等）と同じ理由: 前期(actual)が
  // マイナス（赤字）だと変化率の符号が反転して意味不明になる（実測:
  // 5246は実績-215→予想+350で「黒字転換」という最良のケースなのに、
  // 単純な変化率だと-262.8%という悪化に見えてしまっていた）。前期が
  // 黒字(>0)の場合だけyoyPctを出し、赤字→黒字転換はturnsProfitableという
  // 別のフラグで検出できるようにする。
  const turnsProfitable = latestActual.opProfit <= 0 && latestForecast.opProfit > 0;
  return {
    actualPeriod: latestActual.period, actualOpProfit: latestActual.opProfit,
    forecastPeriod: latestForecast.period, forecastOpProfit: latestForecast.opProfit,
    yoyPct: latestActual.opProfit > 0
      ? Math.round(((latestForecast.opProfit - latestActual.opProfit) / latestActual.opProfit) * 1000) / 10
      : null,
    turnsProfitable,
  };
}

// テーマ株一覧ページの銘柄コード抽出（ネットワーク非依存の純粋関数。
// テストで直接検証できるよう分離）。
export function extractThemeStockCodes(tables) {
  const t = tables.find((rows) => rows[0]?.includes('コード') && rows[0]?.includes('銘柄名'));
  if (!t) return [];
  const cCode = t[0].indexOf('コード');
  return t.slice(1).map((r) => r[cCode]).filter(Boolean);
}

// テーマ株一覧ページ（テーマ性マッチング、ユーザー提案）。
// tenbagger_research_log.mdの手動リサーチと同じURL・パース手法を
// コードに落とし込んだもの。テーマ名は表記揺れで404になりやすい
// （実測: "AI"・"自動運転"・"防衛関連"は404、"AI関連"・"量子コンピュータ"
// も404。一方"半導体"・"データセンター"・"防衛"・"自動運転車"等は
// 実在確認済み）ため、呼び出し側で404を許容してスキップする前提。
export async function fetchThemeStocks(themeName) {
  const html = await getText(`https://kabutan.jp/themes/?theme=${encodeURIComponent(themeName)}`);
  return extractThemeStockCodes(parseTables(html));
}

// v7.5改修（再発防止策）: THEME_WATCHLISTへのテーマ名追加は、これまで
// ユーザー提案の単語をそのまま/自分の思いつく表記で試して404を繰り返す
// 「推測ゲーム」になっていた（実測: "AI"・"量子"・"核融合"・"バイオ"・
// "再エネ"・"ヒューマノイド"は直接の表記では全て404だった）。
// kabutan.jpの検索窓（オートコンプリート）が使っているサジェストAPI
// （search.kabutan.jp/api/v1/suggest）は、type:"jp_theme"の候補として
// kabutan側の"正しい表記"をそのまま返してくれる（実測: word=量子 →
// "量子コンピューター"「量子暗号通信」を発見）。今後テーマを追加する
// 際は、このAPIで種語（"AI"「ロボット」等の断片でよい）を検索し、
// 返ってきたjp_theme候補をfetchThemeStocks()で実件数確認してから
// THEME_WATCHLISTに追記すること（推測でテーマ名を決め打ちしない）。
export async function fetchThemeSuggestions(word) {
  const text = await getText(`https://search.kabutan.jp/api/v1/suggest?word=${encodeURIComponent(word)}`);
  const json = JSON.parse(text);
  return (json.suggest ?? []).filter((s) => s.type === 'jp_theme').map((s) => s.value);
}

// 決算のクセ（季節性）— 次回がQ1（当期最初の四半期）の銘柄は進捗率の
// 分母が定義できず常にN/Aになるが（reportedQuarters('1Q')=0）、過去の
// 同じ四半期(Q1)が年間実績に占めていた比率が分かれば「1Q発表を待たずに
// どの程度を期待してよいか」の目安になる。kabutanの四半期実績テーブル
// （純粋な単四半期。中間/累計/年度ではない行、書式"YY.MM-MM"で判別）を
// 決算期の新しい順に並べ、直近行から4行おきに遡ってQ1を特定する
// （「次回1Q」＝直前の開示がQ4という定義そのものを使い、テーブル末尾を
// Q4と仮定する。他の四半期(2Q/3Q)が次回のケースへの一般化はしていない）。
export function parseQ1Seasonality(tables) {
  const rowsAll = [];
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '営業益', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cOp = header.findIndex((c) => c.includes('営業益'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      // "YY.MM-MM"という書式は単四半期(3ヶ月, 例:06-08)にも中間累計
      // (6ヶ月, 例:06-11)にも使われ、文字列パターンだけでは区別できない
      // （実測: 7921で両方が混在し、中間累計を単四半期と誤認していた）。
      // 開始月・終了月の差から実際の月数を計算し、3ヶ月の行だけを残す。
      const m = r[0]?.match(/^\d{2}\.(\d{2})-(\d{2})$/);
      if (!m) continue;
      const span = ((Number(m[2]) - Number(m[1]) + 12) % 12) + 1;
      if (span !== 3) continue;
      const op = toNum(r[cOp]);
      if (op === null) continue;
      rowsAll.push({ period: r[0], op });
    }
  }
  const uniq = [...new Map(rowsAll.map((r) => [r.period, r])).values()].sort((a, b) => a.period.localeCompare(b.period));
  const n = uniq.length;
  if (n < 4) return null; // 四半期実績が1年分も無い

  const years = [];
  for (let idx = n - 4; idx >= 0; idx -= 4) {
    const q1 = uniq[idx];
    const annual = q1.op + uniq[idx + 1].op + uniq[idx + 2].op + uniq[idx + 3].op;
    if (annual === 0) continue;
    years.push({ period: q1.period, q1Profit: q1.op, annualProfit: annual, sharePct: Math.round((q1.op / annual) * 1000) / 10 });
  }
  if (!years.length) return null;
  const avgSharePct = Math.round((years.reduce((s, y) => s + y.sharePct, 0) / years.length) * 10) / 10;
  return { years, avgSharePct };
}

// 「カタリスト予兆」セクション向け: 進捗率（対通期/対上期）の複数年
// ぶんの推移を返す。この表は「決算期」が同じ相対四半期の年ごとの
// 実績（例: 24.02-04, 25.02-04, 26.02-04＝毎年2〜4月期の実績）が
// 並ぶ実測構成（pickLatestActualが最新1件だけ拾うのと同じ表）。
// 同じ時期どうしを年で比較するため、決算期がずれる四半期間の比較
// （季節性の混入）を避けられる。予想行(「予」始まり)は除外する。
// 発表日の新しい順ではなく表の掲載順（古→新の実測）をそのまま返す。
export function parseProgressHistory(tables) {
  const t = findTable(tables, ['進捗率', '発表日']);
  if (!t) return [];
  const header = t.rows[t.hIdx];
  const cPeriod = 0;
  const cProgress = header.findIndex((h) => h.includes('進捗率'));
  const cDate = header.findIndex((h) => h.includes('発表日'));
  // 経常益列（ユーザー提案: 進捗率の横に前年同期比の利益成長率を添える）。
  // 実測: このテーブルは決算期・売上高・営業益・経常益・最終益・修正1株益・
  // 進捗率・発表日の順で並ぶため、進捗率と同じ行から経常益も同時に拾える
  // （追加リクエスト無し）。'営業益'も'益'を含むが'経常益'は固有の文字列
  // なので誤爆しない。
  const cProfit = header.findIndex((h) => h.includes('経常益'));
  const out = [];
  for (const r of t.rows.slice(t.hIdx + 1)) {
    if (r.length !== header.length) continue;
    if (r[cPeriod]?.includes('予')) continue; // 会社予想はまだ実現していない数値
    const date = r[cDate];
    if (!/^\d{2}\/\d{2}\/\d{2}$/.test(date)) continue;
    const progress = toNum(r[cProgress]);
    if (progress === null) continue;
    const profit = cProfit !== -1 ? toNum(r[cProfit]) : null;
    out.push({ period: r[cPeriod], progress, date, label: header[cProgress], profit });
  }
  return out;
}

export async function fetchFinance(code) {
  const tables = parseTables(await getText(`https://kabutan.jp/stock/finance?code=${code}`));
  // 進捗率・自己資本比率は以前pickByHeader()（予想行を除外しない汎用の
  // 「最後に数値が入っている行」抽出）を使っていた。「対上期/対通期進捗率」
  // 「自己資本比率」の実測テーブルは今のところ予想行を含まない構成
  // だったが、営業益・ROEで実際に予想行混入バグが起きた（7921）のと
  // 同じ形の決算期テーブルである以上、同じガードを持つpickLatestActual
  // に統一しておく方が安全（決算のタイミング次第で将来どちらかの
  // テーブルに予想行が混ざっても、この関数なら自動的に弾かれる）。
  const prog = pickLatestActual(tables, { findKeywords: ['進捗率', '発表日'], valueKeyword: '進捗率' });
  const equity = pickLatestActual(tables, { findKeywords: ['自己資本比率', '発表日'], valueKeyword: '自己資本比率' });
  const opProfit = parseLatestOperatingProfit(tables);
  const checkpointTrend = parseCheckpointTrend(tables);
  return {
    progress: prog?.value ?? null,
    progressLabel: prog?.label ?? null,
    // 赤字/債務超過フィルター用。opProfitDateは「いつ時点の実績か」の表示に使う。
    latestOpProfit: opProfit?.opProfit ?? null,
    latestOpProfitDate: opProfit?.date ?? null,
    equityRatio: equity?.value ?? null,
    // 売上債権の伸びとの比較用（年度決算ベースの前期比成長率）。
    revenueGrowth: parseAnnualRevenueYoY(tables),
    // 「業績屈折(INFLECTION)」セクション向け: 通期の会社予想を含む営業益YoY。
    forecastOpProfit: parseAnnualOperatingProfitForecastYoY(tables),
    // 同セクション向け: 直近四半期の営業益・前年同期比（progressHistory
    // 経由のlatestProfitYoyPctが欠落するケースの補完。上のコメント参照）。
    latestQuarterlyYoY: parseLatestQuarterlyOperatingProfitYoY(tables),
    // SECTION D新スペック向け（ユーザー提案2026-09-12、経常益ベースの
    // キラー指標）。checkpointTrendが直近の公式チェックポイント
    // （Q1=対上期進捗率／中間期・Q3=対通期進捗率）を四半期非依存で
    // 判定し、nextMilestoneはその次に来る公式予想（同じくQ1なら中間期、
    // 中間期/Q3なら通期）を返す。
    checkpointTrend,
    nextMilestone: checkpointTrend ? parseNextMilestoneForecast(tables, checkpointTrend.progressLabel) : null,
    debtEquityRatio: parseLatestDebtEquityRatio(tables),
    // 次回がQ1で進捗率がN/Aになる銘柄向けの「決算のクセ」参考値。
    q1Seasonality: parseQ1Seasonality(tables),
    // 「カタリスト予兆」セクション向け: 同時期の進捗率の複数年推移。
    progressHistory: parseProgressHistory(tables),
    // 同業他社比較用のROE（最新期）。業種平均ROEはkabutan側に該当する
    // ページが見当たらず非対応（個別銘柄の値のみ表示する）。
    // 予想行の除外はpickLatestActual側で共通処理する（後述のコメント参照）。
    latestRoe: pickLatestActual(tables, { findKeywords: ['ＲＯＥ', '売上営業利益率'], valueKeyword: 'ＲＯＥ' })?.value ?? null,
    // ①コア・スクリーニング条件向け（ユーザー提案2026-09-13改良版）:
    // 過去実績平均ROE・会社予想ベースの今期予想ROEのOR判定用。
    roeHistory: parseRoeHistory(tables),
  };
}
