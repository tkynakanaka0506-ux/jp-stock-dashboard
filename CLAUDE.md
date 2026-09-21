# STEALTH v7.3 (AMBUSH + SMART ENTRY) 株ダッシュボード

日本株・米国株のシグナルを自動収集し、`index.html`（デスクトップ表＋モバイル専用UI）を
生成する。GitHub Pagesではなく、自宅Mac上の`server.mjs`（LAN配信）と launchd の
定期ジョブで完結する、常駐型のダッシュボード。

## 体制: 完全無人の自動push（ユーザー承認済み・2026-09-20）

`sync_and_push.sh` が5分おきに launchd (`com.takuya.stock-dashboard`) から起動され、
以下の順でチェックしてから**人の確認無しで直接 `git push`** する。

1. `node --check` で対象.mjs全部の構文チェック（数百ms、失敗したら即スキップ）
2. `node --test test/*.test.mjs`（回帰テスト、失敗したら即スキップ）
3. `node scraper.mjs` 本体実行
4. 差分があれば `git commit && git pull --ff-only && git push`

**このリポジトリでは、上記の自動テストゲートだけが「壊れたコードを本番に出さない」
唯一の防波堤。** そのため：

- **バグを直したら、そのたびに必ず `test/*.test.mjs` へ回帰テストを追加すること。**
  ユーザーから「再発防止して」と毎回言われなくても、これはデフォルトの作業手順にする。
  テストを足さない修正は、次に同じバグが再発しても誰も気づけない（pushが自動で
  進んでしまうため）。
- 新しい実測バグを直すときは、既存テストと同じ「実測バグ（症状）→再発防止テスト」の
  コメント形式を踏襲する（`test/scraper_checklist.test.mjs` 参照）。
- モバイルUI（`buildMobileApp`とその周辺JS、`scraper.mjs`内 `#mobile-app`〜`</script>`）
  のように、生成HTML文字列の中に埋め込まれたクライアントJSは、DOM環境が無い
  `node --test` では実際には実行されない。この手のコードの回帰テストは、
  `readFileSync`でscraper.mjs自身のソーステキストを読み、期待するパターンが
  含まれる/含まれないことを正規表現で確認する形になる（jsdom等の新規依存は
  入れない方針のため）。

### 取得スケジュール(launchd)

| ジョブ(Label) | 頻度 | 内容 |
| --- | --- | --- |
| `com.takuya.stock-server` | 常駐(KeepAlive) | `server.mjs`でLAN配信するだけ。スクレイピングはしない |
| `com.takuya.stock-dashboard` | 5分おき | `sync_and_push.sh --no-open --market-hours`。場中(9:00〜15:50 JST、土日祝スキップ)以外は即終了 |
| `com.takuya.stock-daily` | 平日7:00 JSTに1回 | `sync_and_push.sh --no-open`(場外判定なしのフルスキャン) |

**実測バグ(2026-09-21発見、ユーザー報告「更新が止まっている気がする」の調査):**
`kabutan.mjs`の`getText()`は1リクエストあたり30秒タイムアウト+2リトライで
個々のハングは防げていたが、スキャンループ全体には上限が無かった。ネットワークが
広範囲に不調な時間帯には「多くの銘柄がそれぞれ最悪ケース(30秒×3回)を踏む」が
積み重なり、実際に2.5時間以上ブロックした事例を`/tmp/stealth_sync_and_push.lock`
のログ(`~/Library/Logs/stealth-dashboard.log`)から確認した。`sync_and_push.sh`の
PIDロックは「生きているプロセスは奪わない」が正しい設計(Macスリープ対応、
`scraper.mjs`内コメント参照)なので、ロック側で強制解除するのではなく、
**プロセス自身が長時間かかりすぎたら自発的に諦めて終了する**watchdogを
`scraper.mjs`に追加した。**ただし場中ジョブ(`--market-hours`)にだけ適用する
(`WATCHDOG_MS`=20分)。** 導入直後は日次フルスキャンにも2時間のwatchdogを
入れていたが、実測ログ集計で正常完了が最大149分かかることが判明し、経過時間
ベースのwatchdogはMacスリープ中の経過時間も数えてしまう(既存の
`lockOwnerAlive()`が経過時間で判断しない設計にしている理由と同じ制約)ため、
日次ジョブはwatchdogを入れず既存の生存確認ロックだけに委ねる形に訂正した
(2026-09-21)。回帰テストは`test/scraper_checklist.test.mjs`の`watchdog`関連
テスト参照。

## コマンド

```bash
node scraper.mjs          # 本体実行(キャッシュが当日分ならv17秒程度、無ければ40〜90分のフルスキャン)
npm test                  # node --test test/*.test.mjs
node --check scraper.mjs  # 構文チェックのみ
bash sync_and_push.sh --no-open --market-hours  # 本番と同じ経路で手動実行
node monitor.mjs          # 稼働監視レポート(実行時間・watchdog強制終了/ロックスキップ回数、読み取り専用)
```

## モバイルUIの設計方針

- `#mobile-app` と `#desktop-view` は同じDOMに両方存在し、`@media(max-width:520px)`で
  出し分ける。判定ロジック・スコア計算は一切新規実装せず、`main()`が組み立てた
  配列をそのまま参照する（PC版とスマホ版で判定結果が食い違わないようにするため）。
- 銘柄の「詳細を見る」は、PC版側の `<article id="card-<code>">` を
  `cloneNode(true)`してからidを除去し、ボトムシート(`#m-card-modal`)へその場で
  差し込む。**PC版へ画面ごと切り替える実装（`mobileShowDesktop()`呼び出しや
  `scrollIntoView`）に戻さないこと** — 2026-09-20にユーザーから「影響が出る株が
  PCのサイトに飛ぶ」と報告された実測バグで、モバイル画面から離脱してしまい
  不評だった。回帰テストが `test/scraper_checklist.test.mjs` にある。
- クローンにPC版と同じidを残すと、同じ銘柄を2回目に開いたときに
  `document.getElementById`が（DOM順で先に出てくる）前回のクローンを拾って
  しまい、以後内容が更新されなくなる。cloneNode後は必ず`removeAttribute('id')`する。

## 配信経路

- ローカル: `node server.mjs`（launchd: `com.takuya.stock-server`）が0.0.0.0:8765で
  `Cache-Control: no-store`付きでLAN配信。スマホは同じWi-Fi内から
  `http://<Macのローカルip>:8765/`で開く。
- iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/AMBUSH/AMBUSH.html`)
  にも配信するが、これはFilesアプリでの確認用の副経路（Safariの通常タブとしては
  開けないためPWA機能が働かない）。実運用の入口はLAN URLの方。
- GitHub (`origin/main`) へのpushは記録・バックアップ目的。GitHub Pagesは使っていない。
