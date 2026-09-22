// ==================================================================
// logic_fingerprint.mjs — 「キャッシュは当日分だが判定ロジックは変わって
// いた」実測バグの再発防止(2026-09-22発見)
//
// 実測バグ: indicators.mjs（配当利回りシグナルのラベル・文言等）を
// 修正してコミット・プッシュした直後にscraper.mjsを手動実行したところ、
// screener.mjs/smart_entry.mjs/us_screener.mjs/us_tenbagger.mjsの
// キャッシュ有効判定が`cache.date === today`（日付が同じなら中身を
// 一切見ずに再利用する）だけだったため、その日の朝（ロジック修正前）に
// 生成された古いキャッシュがそのまま使われ続け、修正後のコードが本番の
// index.htmlに一切反映されなかった。
//
// 対策: 判定ロジックの主要ファイルの内容ハッシュ（フィンガープリント）を
// 計算し、キャッシュに保存されたフィンガープリントと比較する。日付が
// 同じでも、これらのファイルの中身が1バイトでも変わっていればキャッシュ
// を無効とみなして再計算する（「手動でバージョン番号を上げ忘れる」ことが
// 起きない、自動検知の方式にしてある）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// キャッシュされる判定結果（銘柄ごとのSCORE/verdict/各種シグナル）に
// 影響しうる主要ファイル。表示専用のscraper.mjsや、このファイル自体は
// 含めない（無限ループ・過剰な無効化を避けるため）。新しい判定ロジックの
// ファイルを追加したら、ここにも1行足すこと。
export const LOGIC_FINGERPRINT_FILES = [
  'indicators.mjs', 'screener.mjs', 'smart_entry.mjs',
  'us_screener.mjs', 'us_tenbagger.mjs', 'edinet.mjs', 'us_edgar.mjs',
];

export function computeLogicFingerprint(baseDir = __dirname) {
  const hash = crypto.createHash('sha256');
  for (const f of [...LOGIC_FINGERPRINT_FILES].sort()) {
    try {
      hash.update(fs.readFileSync(path.join(baseDir, f)));
    } catch {
      // ファイルが無い(将来ファイル名を変更した場合の後方互換)場合は
      // ハッシュに含めない。存在しないことを理由にクラッシュさせない。
    }
  }
  // 可読性優先で短縮する（衝突耐性より、ログで目視確認しやすいことを
  // 優先。このハッシュは暗号用途ではなくキャッシュの世代識別用）。
  return hash.digest('hex').slice(0, 16);
}

// キャッシュが「日付も一致し、判定ロジックのフィンガープリントも一致」
// している場合だけ有効とみなす。fingerprintが無い古い形式のキャッシュ
// （このリポジトリ側の対応前に書かれたもの）は、無条件で無効扱いにする
// （「ロジックが変わっていないと確認できない」場合は安全側＝再計算に倒す）。
export function isCacheFresh(cache, today, currentFingerprint) {
  return Boolean(cache?.date === today && cache?.results && cache?.logicFingerprint === currentFingerprint);
}
