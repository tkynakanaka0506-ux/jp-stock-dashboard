// kabutan.mjsの「決算期テーブルから直近実績値を1つ拾う」共通ヘルパーの
// 回帰テスト。
//
// 対象バグ（再発防止）: 決算期セルが「予 2027.05」のように「予」始まりに
// なる会社予想の行を、最新期の"実績"として拾ってしまっていた（実測:
// 7921でROE 10.79(予想)を10.78(実績)の代わりに返していた）。営業益・
// 自己資本比率の抽出では既にガードされていたのに、ROEの抽出コードにだけ
// 同じガードが入っておらず、3箇所に分かれていた抽出ロジックを
// pickLatestActual()に統合してこの種の「1箇所だけ書き忘れる」再発を防いだ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTables, pickLatestActual, extractThemeStockCodes, parseWeeklyCredit } from '../kabutan.mjs';

// 実際のkabutan決算期テーブルを模した最小HTML（決算期/売上高/営業益/
// 売上営業利益率/ROE/ROA/総資産回転率/修正1株益、発表日列なし）。
const ROE_TABLE_HTML = `
<table><thead><tr>
<th>決算期</th><th>売上高</th><th>営業益</th><th>売上営業利益率</th>
<th>ＲＯＥ</th><th>ＲＯＡ</th><th>総資産回転率</th><th>修正1株益</th>
</tr></thead><tbody>
<tr><td>2025.05</td><td>29,678</td><td>4,048</td><td>13.64</td><td>14.06</td><td>10.67</td><td>0.78</td><td>314.0</td></tr>
<tr><td>2026.05</td><td>31,154</td><td>4,420</td><td>14.19</td><td>10.78</td><td>8.18</td><td>0.75</td><td>261.9</td></tr>
<tr><td>予 2027.05</td><td>34,200</td><td>4,900</td><td>14.33</td><td>10.79</td><td>8.23</td><td>0.80</td><td>271.2</td></tr>
</tbody></table>`;

// 発表日列がある営業益テーブル（予想行と実績行が同日付で同居するケース）。
const OP_PROFIT_TABLE_HTML = `
<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
<tr><td>26.04-06</td><td>98,454</td><td>26/07/31</td></tr>
<tr><td>予 2027.03</td><td>430,000</td><td>26/07/31</td></tr>
</tbody></table>`;

test('発表日列が無い表: 予想行(「予」始まり)を飛ばして直近実績を返す', () => {
  const tables = parseTables(ROE_TABLE_HTML);
  const r = pickLatestActual(tables, { findKeywords: ['ＲＯＥ', '売上営業利益率'], valueKeyword: 'ＲＯＥ' });
  assert.equal(r.value, 10.78); // 10.79(予想)ではなく10.78(実績)
});

test('発表日が同一でも予想行は実績と誤認しない', () => {
  const tables = parseTables(OP_PROFIT_TABLE_HTML);
  const r = pickLatestActual(tables, { findKeywords: ['決算期', '営業益', '発表日'], valueKeyword: '営業益' });
  assert.equal(r.value, 98454); // 430,000(予想)ではなく98,454(実績)
});

test('該当テーブルが無ければnull', () => {
  const tables = parseTables('<table><thead><tr><th>foo</th></tr></thead></table>');
  const r = pickLatestActual(tables, { findKeywords: ['ＲＯＥ', '売上営業利益率'], valueKeyword: 'ＲＯＥ' });
  assert.equal(r, null);
});

test('進捗率・自己資本比率も同じ関数を使っている以上、予想行があれば同様に除外される', () => {
  // 実測での進捗率・自己資本比率テーブルには予想行が確認できなかったが、
  // 営業益・ROEと同じ「決算期テーブルから最新行を拾う」形である以上、
  // 別々のコード（pickByHeader）を使っているとその2つだけガードが
  // 抜ける再発リスクがある。fetchFinance()側もpickLatestActual()に
  // 統一したので、その共通ヘルパー自体がここで検証されていれば十分。
  const html = `<table><thead><tr><th>決算期</th><th>対通期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>26.03-05</td><td>56.7</td><td>26/06/29</td></tr>
    <tr><td>予 27.03-05</td><td>999.9</td><td>26/06/29</td></tr>
  </tbody></table>`;
  const tables = parseTables(html);
  const r = pickLatestActual(tables, { findKeywords: ['進捗率', '発表日'], valueKeyword: '進捗率' });
  assert.equal(r.value, 56.7); // 999.9(予想)を実績と誤認しない
  assert.equal(r.label, '対通期進捗率');
});

test('extractThemeStockCodes: テーマ株一覧ページから銘柄コードを抽出する（テーマ性マッチング、ユーザー提案。実データ確認済み: kabutan.jp/themes/?theme=脱炭素の実際のテーブル構造）', () => {
  const html = `<table><thead><tr>
    <th>コード</th><th>銘柄名</th><th>市場</th><th></th><th>株価</th><th></th><th>前日比</th><th>ニュース</th><th>ＰＥＲ</th><th>ＰＢＲ</th><th>利回り</th>
  </tr></thead><tbody>
    <tr><td>1433</td><td>ベステラ</td><td>東Ｐ</td><td></td><td></td><td>1,269</td><td></td><td>-29</td><td>-2.23%</td><td></td><td>16.1</td></tr>
    <tr><td>1436</td><td>グリーンエナ</td><td>東Ｇ</td><td></td><td></td><td>1,637</td><td></td><td>+4</td><td>+0.24%</td><td></td><td>25.3</td></tr>
  </tbody></table>`;
  const codes = extractThemeStockCodes(parseTables(html));
  assert.deepEqual(codes, ['1433', '1436']);
});

test('extractThemeStockCodes: 該当テーブルが見つからなければ空配列（404ページ等）', () => {
  assert.deepEqual(extractThemeStockCodes(parseTables('<table><thead><tr><th>foo</th></tr></thead></table>')), []);
});

// 第9優先改修 Phase6（需給タイムライン）向け: parseWeeklyCreditの終値
// 抽出。実測（トヨタ7203、https://kabutan.jp/stock/kabuka?code=7203&ashi=shin）
// のテーブル構造をそのまま模す（日付/終値/前週比率/売買単価/売買高(株)/
// 売り残(株)/買い残(株)/信用倍率）。
const WEEKLY_CREDIT_HTML = `
<table class="stock_kabuka_dwm">
<thead><tr>
<th class="w90">日付</th><th class="w70">終値</th><th class="w80">前週比率</th>
<th class="w70">売買単価</th><th class="w100">売買高(株)</th><th class="w100">売り残(株)</th>
<th class="w120">買い残(株)</th><th class="w80">信用倍率</th>
</tr></thead>
<tbody>
<tr><th scope="row"><time datetime="2026-09-11">26/09/11</time></th><td>3,031.0</td><td><span class="down">-1.62</span></td><td>3,001</td><td>114,275,600</td><td>2,625,400</td><td>17,239,000</td><td>6.57</td></tr>
<tr><th scope="row"><time datetime="2026-09-04">26/09/04</time></th><td>3,081.0</td><td><span class="down">-1.12</span></td><td>3,159</td><td>133,114,700</td><td>2,491,000</td><td>16,378,100</td><td>6.57</td></tr>
<tr><th scope="row"><time datetime="2026-08-28">26/08/28</time></th><td>-</td><td><span class="down">-0.51</span></td><td>3,099</td><td>99,584,500</td><td>2,343,700</td><td>16,853,200</td><td>7.19</td></tr>
</tbody>
</table>`;

test('parseWeeklyCredit: 終値(close)を実データの表構造から抽出する（信用残の観測日と完全に同じ日付の株価を得るため）', () => {
  const rows = parseWeeklyCredit(WEEKLY_CREDIT_HTML);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '26/09/11');
  assert.equal(rows[0].close, 3031.0);
  assert.equal(rows[0].buy, 17_239_000);
  assert.equal(rows[0].sell, 2_625_400);
  assert.equal(rows[0].loanRatio, 6.57);
});

test('parseWeeklyCredit: 終値セルが「-」等で数値化できない週はclose:null（前後の値で埋めない）', () => {
  const rows = parseWeeklyCredit(WEEKLY_CREDIT_HTML);
  assert.equal(rows[2].close, null);
  assert.equal(rows[2].buy, 16_853_200); // 終値が無くても他の列は取れる
});

test('parseWeeklyCredit: 終値列が無い旧形式のテーブルでもclose:nullで例外にならない（後方互換）', () => {
  const html = `<table><thead><tr>
    <th>日付</th><th>売り残</th><th>買い残</th><th>信用倍率</th>
  </tr></thead><tbody>
    <tr><td>26/09/11</td><td>2,625,400</td><td>17,239,000</td><td>6.57</td></tr>
  </tbody></table>`;
  const rows = parseWeeklyCredit(html);
  assert.equal(rows[0].close, null);
  assert.equal(rows[0].buy, 17_239_000);
});
