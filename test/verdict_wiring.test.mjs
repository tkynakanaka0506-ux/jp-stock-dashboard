// verdict配線の構造的な網羅性テスト。
//
// このセッションで実際に起きたバグは「カードに赤チップとして表示している
// のに、verdict（買い推奨/様子見/見送り）側にその判定を追加し忘れる」
// パターンだった（growthSurgeSignal・上場廃止のスクイーズアウト）。
// 個別のバグを1つずつ回帰テストにするだけでは、次に別の新しいシグナルで
// 同じ配線忘れが起きても検出できない。
//
// このテストはCHIP_SIGNAL_FIELDS（bottomChipsが表示する全シグナルの
// 一覧）を列挙し、その1つ1つを機械的に「bad」状態にした入力を作って、
// ambushVerdict/smartEntryVerdictが必ず「買い推奨」から離脱することを
// 確認する。CHIP_SIGNAL_FIELDSに新しいシグナルを追加すれば、この
// テストが自動的にそのシグナルの配線も検証してくれる（何もしなくて
// いい＝これが「構造的な再発防止」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambushVerdict, smartEntryVerdict, CHIP_SIGNAL_FIELDS, badChipSignals, VERDICT_SEVERITY } from '../indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('CHIP_SIGNAL_FIELDSの各シグナルは badChipSignals() で拾える', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { [key]: { level: 'bad', note: `${key} bad` } };
    const found = badChipSignals(r);
    assert.equal(found.length, 1, `${key} が badChipSignals() で拾えていません`);
  }
});

test('CHIP_SIGNAL_FIELDSの各シグナルは、単独でbadになるとambushVerdictを買い推奨から離脱させる', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { rank: 'S', evidence: true, catalysts: [{ label: 'テスト好材料' }], [key]: { level: 'bad', note: `${key} bad` } };
    const v = ambushVerdict(r);
    assert.notEqual(v.level, 'buy', `${key}がbadなのにambushVerdictが買い推奨のままです（チップ表示とverdict計算の配線忘れの疑い）`);
  }
});

test('CHIP_SIGNAL_FIELDSの各シグナルは、単独でbadになるとsmartEntryVerdictを買い推奨から離脱させる', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { sig1: { level: 'good', note: 'テスト該当' }, [key]: { level: 'bad', note: `${key} bad` } };
    const v = smartEntryVerdict(r, { level: null }, { level: null });
    assert.notEqual(v.level, 'buy', `${key}がbadなのにsmartEntryVerdictが買い推奨のままです（チップ表示とverdict計算の配線忘れの疑い）`);
  }
});

test('overheat・growthSurge・上場廃止（CHIP_SIGNAL_FIELDS外の特殊ケース）も個別に配線されている', () => {
  // これらはr.kairi/r.market/r.closes/r.warningsから計算するためリストに
  // 含めていない。リストに乗らない分、書き忘れのリスクが高いので個別に
  // 固定しておく。
  assert.equal(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], kairi: 20 }).level, 'avoid',
    'overheat(kairi>+15%)がambushVerdictで見送りに落ちていません'
  );
  assert.notEqual(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], market: '東証Ｇ', closes: [100, ...Array(20).fill(160)] }).level, 'buy',
    'growthSurgeがambushVerdictで買い推奨のままです'
  );
  assert.equal(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], warnings: [{ label: '上場廃止（スクイーズアウト）' }] }).level, 'avoid',
    '上場廃止がambushVerdictで見送りに落ちていません'
  );
});

test('repricingLag.zone===priced_inもambushVerdictを織り込み警戒まで落とす（実測バグ: 米国株ALOYがSCORE70・rank Aで1位表示なのに、repricingLagBlockの説明文は「見送り推奨」と矛盾していた。ambushVerdictにrepricingLagが一切配線されていなかったのが原因。v7.3で5段階化した際、見送りより一段軽い「織り込み警戒」に再マップした）', () => {
  assert.equal(
    ambushVerdict({ rank: 'A', evidence: true, catalysts: [], repricingLag: { checked: true, zone: 'priced_in' } }).level, 'priced_in_caution',
    'repricingLag.zone===priced_inがambushVerdictで織り込み警戒に落ちていません'
  );
  // checked:falseの場合は「確定的に判定できていない」ので悪化させない
  // （他のchecked flagパターンと同じ思想）。
  assert.equal(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], repricingLag: { checked: false, zone: 'priced_in' } }).level, 'buy',
    'checked:falseなのに見送りに落ちてしまっています（確定していない判定で悪化させるべきではありません）'
  );
  // repricingLagが無いオブジェクト（SMART ENTRY等）でもクラッシュしない。
  assert.doesNotThrow(() => ambushVerdict({ rank: 'S', evidence: true, catalysts: [] }));
});

test('ambushVerdict: 決算まで14日未満（sweetMinの外側）は織り込み警戒に落とす（v7.3改修 項目4: 決算直前は買い時ではなく織り込み警戒を強める）', () => {
  const r = ambushVerdict({ rank: 'S', evidence: true, catalysts: [], daysLeft: 10 });
  assert.equal(r.level, 'priced_in_caution');
});

test('ambushVerdict: 決算まで14日以上ならこの理由では悪化させない', () => {
  const r = ambushVerdict({ rank: 'S', evidence: true, catalysts: [], daysLeft: 14 });
  assert.equal(r.level, 'buy');
});

test('ambushVerdict: daysLeftが無い呼び出し元（SMART ENTRY等）では例外にならず何もしない', () => {
  assert.doesNotThrow(() => ambushVerdict({ rank: 'S', evidence: true, catalysts: [] }));
});

test('VERDICT_SEVERITY: 5段階の重大度順序が正しい（v7.3改修 項目12: 買い推奨/様子見/見送りの3段階から5段階に拡張）', () => {
  assert.ok(VERDICT_SEVERITY.strong_buy < VERDICT_SEVERITY.buy);
  assert.ok(VERDICT_SEVERITY.buy < VERDICT_SEVERITY.hold);
  assert.ok(VERDICT_SEVERITY.hold < VERDICT_SEVERITY.priced_in_caution);
  assert.ok(VERDICT_SEVERITY.priced_in_caution < VERDICT_SEVERITY.avoid);
});

test('indicators.mjsのexport function ...Signal は全てscreener.mjs/smart_entry.mjs/scraper.mjs/us_screener.mjs/us_tenbagger.mjsのいずれかから呼び出されている（デッドコード化の再発防止）', () => {
  // 実測バグ: consensusTrapSignal（期待値のワナ）がWATCHLIST時代の
  // エントリー健康診断カードで使われていたが、SMART ENTRY化（旧コミット
  // dec2509）で呼び出し側だけ削除され、関数定義だけが長期間デッドコード
  // 化していた（テストも0件で誰も気付けなかった）。valueSignal・
  // creditSignalも同じ経緯で同時に取り残されていた（削除済み）。
  // 「シグナルを定義したのに呼び出す側の配線を忘れる／消してしまう」を
  // 機械的に検出できるよう、indicators.mjsのソースから
  // `export function ...Signal(` を全て抽出し、screener.mjs・
  // smart_entry.mjs・scraper.mjs（overheat/growthSurgeはカード描画時に
  // scraper.mjs側で直接呼ばれるためこれも含める）のいずれかで
  // `関数名(`の形で呼ばれているか確認する。
  const indicatorsSrc = fs.readFileSync(path.join(root, 'indicators.mjs'), 'utf-8');
  // 第9優先改修 Phase5（ユーザー提案）: creditSupplyQualitySignalのように
  // 複数のSignal関数を内部で呼び出して1つにまとめる「合成シグナル」が
  // 新たに登場したため、indicators.mjs自身の中での呼び出しも「呼ばれて
  // いる」に含める。ただし`export function X(`という宣言行自体は
  // 「Xが呼ばれている」と誤検出されてしまうため、比較対象からは除去する
  // （宣言行を消してもindicators.mjs内の他の呼び出し箇所は残るため、
  // 本当にどこからも呼ばれていない関数を見逃すことはない）。
  const indicatorsInternalCallSites = indicatorsSrc.replace(/^export function [a-zA-Z0-9]+\(/gm, '');
  const callSites = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'smart_entry.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'us_screener.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'us_tenbagger.mjs'), 'utf-8')
    + indicatorsInternalCallSites;

  const names = [...indicatorsSrc.matchAll(/^export function ([a-zA-Z0-9]+Signal)\(/gm)].map((m) => m[1]);
  assert.ok(names.length > 20, `抽出できたSignal関数が${names.length}件しかありません（正規表現が壊れている疑い）`);

  const orphaned = names.filter((name) => !callSites.includes(`${name}(`));
  assert.deepEqual(
    orphaned, [],
    `screener.mjs/smart_entry.mjs/scraper.mjs/us_screener.mjs/us_tenbagger.mjsのどれからも呼ばれていないSignal関数があります（デッドコード化の疑い）: ${orphaned.join(', ')}`
  );
});

// ユーザー指摘（「言葉の定義を定めたい」）を受けた再監査で発覚した実測
// バグ: screener.mjsの`elapsedQuarters`/`reportedBasis`が「決算発表済み
// の銘柄（SECTION Bのウォッチリスト）」向けとコメントされていたが、
// SECTION B（SMART ENTRY）は実際には決算スケジュールを一切見ない設計
// （smart_entry.mjs冒頭のコメント参照）で、この2関数はどこからも
// 呼ばれていない完全なデッドコードだった（`SBI_ACHIEVED_LABEL`も同様）。
// 「実現しなかった昔の設計のコメント」がそのまま残り、ユーザーが実際の
// UIカテゴリとの対応関係を誤解する原因になっていた（該当コードは削除
// 済み）。indicators.mjsの*Signal関数と同じ構造的デッドコード検出を
// screener.mjs自身のexportにも広げ、再発を防ぐ。
test('screener.mjsのexport function/constは全て、screener.mjs自身・smart_entry.mjs・scraper.mjs・testsのいずれかで参照されている（デッドコード化の再発防止）', () => {
  const screenerSrc = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8');
  const haystack = screenerSrc
    + fs.readFileSync(path.join(root, 'smart_entry.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8')
    + fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.mjs'))
      .map((f) => fs.readFileSync(path.join(root, 'test', f), 'utf-8')).join('\n');

  const names = [...screenerSrc.matchAll(/^export (?:function|const) ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);
  assert.ok(names.length > 15, `抽出できたexportが${names.length}件しかありません（正規表現が壊れている疑い）`);

  // 自分自身の宣言1回だけしかヒットしなければ、他のどこからも参照されて
  // いない（=デッドコード）とみなす。
  const orphaned = names.filter((name) => {
    const count = (haystack.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
    return count <= 1;
  });
  assert.deepEqual(
    orphaned, [],
    `screener.mjs/smart_entry.mjs/scraper.mjs/testsのどこからも参照されていないexportがあります（デッドコード化の疑い）: ${orphaned.join(', ')}`
  );
});

// 実測バグ: repricingGapScore（indicators.mjsでexport済み）をsmart_entry.mjs
// のimport { ... } from './indicators.mjs'に追加し忘れたまま、関数呼び出し
// だけ2箇所（growthPrecursorsスキャン・SMART ENTRY本編Stage2）に追加して
// しまい、`ReferenceError: repricingGapScore is not defined`で毎日07:00の
// 本番scraper実行が3日間連続クラッシュしていた（sync_and_push.shはscraper
// が異常終了するとpushをスキップする設計のため、index.html/smart_entry_
// cache.json/us_*_cache.jsonが3日間更新されず「銘柄が変わっていない」と
// ユーザーに気付かれるまで誰も検知できなかった）。上のテスト群は「exportし
// たのに呼ばれていない（デッドコード）」は検出できるが、逆方向の
// 「呼んでいるのにimportし忘れている（未定義参照）」は一切検出できて
// いなかった。この抜けを塞ぐため、indicators.mjsの全exportについて、
// 各利用側ファイルで「関数名(」の形で呼ばれているならimport文にもその
// 名前が含まれていることを機械的に確認する。
test('indicators.mjsのexportを呼び出しているファイルは、必ずimport文にもその名前を含んでいる（未importの参照忘れ＝ReferenceErrorの再発防止）', () => {
  const indicatorsSrc = fs.readFileSync(path.join(root, 'indicators.mjs'), 'utf-8');
  const exportNames = [...indicatorsSrc.matchAll(/^export (?:function|const) ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);
  assert.ok(exportNames.length > 100, `抽出できたindicators.mjsのexportが${exportNames.length}件しかありません（正規表現が壊れている疑い）`);

  const consumerFiles = ['screener.mjs', 'smart_entry.mjs', 'scraper.mjs', 'us_screener.mjs', 'us_tenbagger.mjs'];
  const missing = [];
  for (const file of consumerFiles) {
    const src = fs.readFileSync(path.join(root, file), 'utf-8');
    const importBlockMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/indicators\.mjs['"]/);
    const importedNames = importBlockMatch
      ? importBlockMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [];
    for (const name of exportNames) {
      if (importedNames.includes(name)) continue;
      // import文以降の本文でだけ呼び出しを探す（自分自身がindicators.mjs
      // ではないのでexport宣言との自己マッチは発生しない）。
      const calledAsFunction = new RegExp(`[^A-Za-z0-9_.]${name}\\(`).test(src);
      if (calledAsFunction) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(
    missing, [],
    `indicators.mjsのexportを呼んでいるのにimport文に無い（未定義参照の疑い）: ${missing.join(', ')}`
  );
});
