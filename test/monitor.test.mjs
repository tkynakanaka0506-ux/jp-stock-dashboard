// monitor.mjs: 稼働監視レポート(2026-09-21ユーザー要望「機能追加より
// 長期的な安定稼働の監視・再発防止を優先」)の回帰テスト。判定ロジック
// (AMBUSH/SMART ENTRY等)には一切関与しない、読み取り専用のロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDurations, stats, parseTimestamp, countEventsByWindow, classifyStatus } from '../monitor.mjs';

test('extractDurations: 「完了 / ... / 17.9秒」のような行から秒数だけ抜く', () => {
  const lines = [
    '✅ 完了 / SMART ENTRY 24件 · AMBUSH NOW 0件 · WATCH 10件 / 17.9秒',
    '⏸  場外のためスキップ (2026/9/21 3:14:05)',
    '✅ 完了 / SMART ENTRY 22件 · AMBUSH NOW 0件 · WATCH 10件 / 4502.1秒',
  ];
  assert.deepEqual(extractDurations(lines), [17.9, 4502.1]);
});

test('stats: 件数・最小・最大・中央値を返す。空配列はnull', () => {
  assert.equal(stats([]), null);
  const s = stats([10, 30, 20]);
  assert.equal(s.count, 3);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.median, 20);
});

test('parseTimestamp: sync_and_push.shの「YYYY-MM-DD HH:MM:SS」形式を読める', () => {
  const ts = parseTimestamp('2026-09-21 10:08:10 ⏰ 最終更新から200分経過...');
  assert.ok(ts instanceof Date);
  assert.equal(ts.getFullYear(), 2026);
  assert.equal(ts.getMonth(), 8); // 0-indexed = 9月
  assert.equal(ts.getDate(), 21);
});

test('parseTimestamp: scraper.mjsのtoLocaleString(ja-JP)形式「2026/9/21 3:14:05」を読める', () => {
  const ts = parseTimestamp('⏸  場外のためスキップ (2026/9/21 3:14:05)');
  assert.ok(ts instanceof Date);
  assert.equal(ts.getFullYear(), 2026);
  assert.equal(ts.getMonth(), 8);
  assert.equal(ts.getDate(), 21);
  assert.equal(ts.getHours(), 3);
});

test('parseTimestamp: タイムスタンプが無い行はnull(実測: scraper.mjsの大半のログ行に該当。集計対象外として扱う)', () => {
  assert.equal(parseTimestamp('🚀 STEALTH v7.3 "AMBUSH + SMART ENTRY" 起動'), null);
});

test('countEventsByWindow: タイムスタンプの有無で直近24h/7dの集計対象を分ける(実測バグ再発防止: 過去ログにタイムスタンプが無く期間集計ができなかった問題への対応)', () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 60 * 60 * 1000); // 1時間前
  const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10日前
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const lines = [
    `${fmt(recent)} ❌ 20分を超えたため強制終了します(...)`,
    `${fmt(old)} ❌ 20分を超えたため強制終了します(...)`,
    '❌ 20分を超えたため強制終了します(タイムスタンプ無し)',
  ];
  const result = countEventsByWindow(lines, /強制終了します/);
  assert.equal(result.total, 3);
  assert.equal(result.last24h, 1, '10日前のイベントは24hカウントに含めてはいけない');
  assert.equal(result.last7d, 1, '10日前のイベントは7dカウントに含めてはいけない');
  assert.equal(result.undated, 1);
});

test('classifyStatus: ログが存在しなければ🔴(launchdジョブが一度も実行されていない可能性)', () => {
  const [emoji] = classifyStatus({ logExists: false, ageMinutes: null, expectedFreshMinutes: 5, forcedKills24h: 0, lockSkips24h: 0 });
  assert.equal(emoji, '🔴');
});

test('classifyStatus: 直近24hにwatchdog強制終了があれば🟠(ネットワーク不調の兆候)', () => {
  const [emoji] = classifyStatus({ logExists: true, ageMinutes: 2, expectedFreshMinutes: 5, forcedKills24h: 1, lockSkips24h: 0 });
  assert.equal(emoji, '🟠');
});

test('classifyStatus: 想定間隔の4倍以上ログが更新されていなければ🔴', () => {
  const [emoji] = classifyStatus({ logExists: true, ageMinutes: 30, expectedFreshMinutes: 5, forcedKills24h: 0, lockSkips24h: 0 });
  assert.equal(emoji, '🔴');
});

test('classifyStatus: 全て正常なら🟢', () => {
  const [emoji] = classifyStatus({ logExists: true, ageMinutes: 2, expectedFreshMinutes: 5, forcedKills24h: 0, lockSkips24h: 0 });
  assert.equal(emoji, '🟢');
});
