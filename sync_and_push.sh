#!/bin/bash
# scraper.mjsを実行し、成功時のみ差分をGitHubへpushする。
# launchd の両ジョブ(stealth-daily / stealth-dashboard)から呼ばれる。
set -uo pipefail

cd "$(dirname "$0")"

# launchd(stealth-dashboard)は5分おきにこのスクリプトを無条件に起動する。
# 実測バグ（2026-09-13）: キャッシュが前日分のまま丸1日以上更新されない
# 障害が発生し調査したところ、フルスキャン（キャッシュが当日分でない時。
# 新しい日の最初の1回や--force時）は40〜90分かかるのに、5分おきの起動
# 側には多重起動を防ぐ仕組みが無かった。このため新しい日の最初のtickが
# フルスキャンを開始した直後に次のtick（5分後）が同じフルスキャンを
# 別プロセスとして起動し、両者が同じ*_cache.jsonファイルを取り合って
# 双方とも完走できずに終わる、という状態が延々と繰り返されていた
# （このセッションで何度も観測した「原因不明のkilled」の正体と推定）。
# ロックファイルで多重起動を防ぐ。
LOCK_FILE="/tmp/stealth_sync_and_push.lock"
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE" 2>/dev/null)" 2>/dev/null; then
  echo "⏭️  別のsync_and_push.sh実行中(PID $(cat "$LOCK_FILE")) — 今回のtickはスキップ"
  exit 0
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# 構文チェック(軽量・数百ms)。node --testでも大抵の構文エラーは
# import時に落ちて検知できるが、テンプレートリテラル内の${...}を
# 使った動的HTML生成(buildMobileApp等)は、そのブロックを実際に呼び出す
# テストが無い限りimportだけでは踏まれない。誤字1つで本番pushが止まる
# 側に倒す方が、動かないダッシュボードを配信し続けるより無難なため、
# 対象ファイルは明示的に--checkを通してからテストに進む。
for f in scraper.mjs *.mjs; do
  [ -f "$f" ] || continue
  /usr/local/bin/node --check "$f" || { echo "⚠️ 構文エラー: $f — scraper実行・pushをスキップ"; exit 1; }
done

# 評価ロジック・パーサーの回帰テストを毎回の実行前に走らせる。ここで
# 落ちるということはコード自体が壊れているということなので、壊れた
# ロジックで生成したページを誤って公開しないよう、scraper実行・push
# ごと止める（このセッション中に見つかった評価バグの再発防止策）。
# 体制(2026-09-20、ユーザー要望「自動的に修正と再発防止実行できる体制」):
# ここでの合否がpush可否を完全無人で決めるゲートそのものなので、
# バグを見つけて直すたびに必ずこのtest/*.test.mjsへ回帰テストを足すこと。
# テストを足さない修正は、次に同じバグが再発しても誰にも気づかれない。
/usr/local/bin/node --test test/*.test.mjs >/tmp/stealth_test.log 2>&1
TEST_EXIT=$?
if [ "$TEST_EXIT" -ne 0 ]; then
  echo "⚠️ 単体テスト失敗 (exit $TEST_EXIT) — scraper実行・pushをスキップ"
  tail -40 /tmp/stealth_test.log
  exit "$TEST_EXIT"
fi

/usr/local/bin/node scraper.mjs "$@"
SCRAPER_EXIT=$?

if [ "$SCRAPER_EXIT" -ne 0 ]; then
  echo "⚠️ scraper.mjs が異常終了 (exit $SCRAPER_EXIT) — pushはスキップ"
  exit "$SCRAPER_EXIT"
fi

# キャッシュファイルを列挙ではなく命名規則(*_cache.json)で拾う。
# 以前はファイル名を1つずつ書き出していたため、新しいキャッシュファイル
# （sector_history.json、当時は命名規則に沿っていなかった）を追加した
# 際にここへの追記を忘れ、そのファイルだけ自動push対象から漏れて
# ローカルの更新がgitに反映されない状態が続いていた。今後は「*_cache.json
# という名前で保存する」という規約さえ守れば、この一覧を変更する必要が
# 無いようにする。
git add index.html *_cache.json

if git diff --staged --quiet; then
  exit 0
fi

git commit -m "auto-update dashboard $(date '+%Y-%m-%d %H:%M:%S %Z')" >/dev/null
git pull --ff-only >/dev/null 2>&1
if ! git push 2>&1; then
  echo "⚠️ git push 失敗"
  exit 1
fi
