// ==================================================================
// 第9優先改修（ユーザー提案）: Production Health Check。
//
// 「次回スキャンを見に行く」のではなく、スキャン自身に自己検査させる。
// 対象はAMBUSH結果（信用需給関連フィールドを持つのはscreener.mjs側の
// みのため）。読み取り専用・判定ロジックには一切関与しない（新しい
// スコア・新しい信用需給判定は一切作らない。既に出力された結果が
// 「壊れていないか」だけを検査する）。
//
// 3段階（ユーザー方針）:
//   ERROR   — 絶対におかしいもの（SCORE不変条件の破壊・日付不整合・
//             未知のtag・未来日付・NaN/Infinity・0件化等のschema崩壊）。
//             呼び出し側（scraper.mjs）はこれを見てpushを止める。
//   WARNING — データ品質が低下している可能性（件数の緩やかな減少等）。
//             固定の閾値は決め打ちしない（「減った」という事実だけを
//             記録する）。スキャン自体は成功扱い。
//   INFO    — 単なる状態（ロジック変更後の初回スキャン、PENDING件数等）。
// ==================================================================
import { CREDIT_SUPPLY_TAGS, creditSupplyTags } from './indicators.mjs';

export const HEALTH_STATUS = { PASS: 'PASS', WARNING: 'WARNING', ERROR: 'ERROR' };

// weekly[].dateと同じ"26/09/18"形式をISOへ正規化する（indicators.mjsの
// creditDateToIsoと同じ変換だが、health_check.mjsは判定ロジックを
// 増やさない読み取り専用モジュールという位置づけのため、日付フォーマット
// 変換という表示非依存の純粋処理だけここに複製する）。
function creditDateToIso(dateStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dateStr ?? '');
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

function isFutureIso(iso, todayIso) {
  if (!iso || !todayIso) return false;
  return iso > todayIso; // "YYYY-MM-DD"同士は文字列比較で日付比較になる
}

function pushIssue(list, code, message, affectedCode) {
  const existing = list.find((i) => i.code === code);
  if (existing) { if (affectedCode && !existing.affected.includes(affectedCode)) existing.affected.push(affectedCode); return; }
  list.push({ code, message, affected: affectedCode ? [affectedCode] : [] });
}

// creditAsOfのような生の日付文字列が「非空だが正規化に失敗した」ケースを
// 「未来日付」とは別の異常として検出する（棚卸しで発覚した抜け: future_date
// チェックはisFutureIsoがnullを渡されると静かにfalseを返すため、壊れた
// 日付形式そのものを見逃していた）。
function checkDateFormat(errors, rawDate, code, message) {
  if (rawDate === null || rawDate === undefined || rawDate === '') return; // 未取得はそもそも対象外（推測しない）
  if (creditDateToIso(rawDate) === null) pushIssue(errors, 'invalid_date', message, code);
}

// creditSupplyQuality: 日付形式・未来日付・NaN/Infinity・PENDINGとisStaleの矛盾を検査。
function checkCreditSupplyIntegrity(results, todayIso) {
  const errors = [];
  for (const r of results) {
    const cs = r.creditSupplyQuality;
    if (!cs || !cs.checked) continue;
    checkDateFormat(errors, cs.creditAsOf, r.code, 'creditSupplyQuality.creditAsOfの日付形式が不正です');
    const asOfIso = creditDateToIso(cs.creditAsOf);
    if (isFutureIso(asOfIso, todayIso)) pushIssue(errors, 'future_date', '信用残の最終発表日が未来日付になっています', r.code);
    const numericFields = ['buyBalance', 'sellBalance', 'creditRatio', 'buyPressureDays', 'buyPressureValueDays', 'priceChangePct', 'avgVolumeRatio', 'creditDataAgeDays'];
    for (const k of numericFields) {
      const v = cs[k];
      if (v !== null && v !== undefined && (Number.isNaN(v) || !Number.isFinite(v))) {
        pushIssue(errors, 'nan_or_infinity', `creditSupplyQuality.${k}がNaN/Infinityです`, r.code);
      }
    }
    if (cs.bounceQuality === 'PENDING' && cs.isStale !== true) {
      pushIssue(errors, 'pending_isstale_mismatch', 'bounceQuality:PENDINGなのにisStale:trueと一致していません', r.code);
    }
  }
  return errors;
}

// creditSupplyTimeline: 点数上限・日付形式/順序/重複・未来日付・
// NaN/Infinity・sourceDatesとの突き合わせ（棚卸しで発覚した抜け:
// 「timeline pointsとweeklyの日付が完全一致するか」を検証する材料が
// 無かったため、creditSupplyTimeline()側にsourceDates（weekly全体の
// 日付一覧、indicators.mjs参照）を追加公開し、ここで突き合わせる）。
function checkTimelineIntegrity(results, todayIso) {
  const errors = [];
  for (const r of results) {
    const tl = r.creditSupplyTimeline;
    if (!tl || !tl.checked) continue;
    if (tl.points.length > 6) pushIssue(errors, 'timeline_too_many_points', 'creditSupplyTimeline.pointsが6件を超えています', r.code);
    if (tl.points.some((p) => p.date === null)) pushIssue(errors, 'invalid_date', 'creditSupplyTimeline.pointsに日付形式が不正な観測点があります', r.code);
    const dates = tl.points.map((p) => p.date).filter(Boolean);
    if (new Set(dates).size !== dates.length) pushIssue(errors, 'timeline_duplicate_dates', 'creditSupplyTimeline.pointsに同じ日付が重複しています', r.code);
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] <= dates[i - 1]) pushIssue(errors, 'timeline_date_order', 'creditSupplyTimeline.pointsが古い→新しいの順になっていません', r.code);
    }
    for (const d of dates) {
      if (isFutureIso(d, todayIso)) pushIssue(errors, 'future_date', 'creditSupplyTimelineの観測点が未来日付になっています', r.code);
    }
    if (Array.isArray(tl.sourceDates)) {
      const sourceSet = new Set(tl.sourceDates);
      if (dates.some((d) => !sourceSet.has(d))) {
        pushIssue(errors, 'timeline_source_mismatch', 'creditSupplyTimeline.pointsの日付が元のweekly（sourceDates）に存在しません', r.code);
      }
    }
    for (const p of tl.points) {
      for (const k of ['close', 'buyBalance', 'buyChangePct', 'sellBalance', 'sellChangePct', 'creditRatio']) {
        const v = p[k];
        if (v !== null && v !== undefined && (Number.isNaN(v) || !Number.isFinite(v))) {
          pushIssue(errors, 'nan_or_infinity', `creditSupplyTimeline.points[].${k}がNaN/Infinityです`, r.code);
        }
      }
    }
  }
  return errors;
}

// UI: 生成後のHTML文字列に埋め込まれたcredit-supply/credit-timelineブロック
// のSVGタグが壊れていないか（開始/終了タグの数が一致するか）を検査する
// （棚卸しで発覚した抜け: 項目1「UI」チェックが原文の途中欠落で未実装
// のままだった）。html文字列を直接読むだけの構造チェックで、レンダリング
// 関数を呼び直さない（scraper.mjsとの循環importを避けるため。既存の
// auditGeneratedHtml（scraper.mjs）と同じ「生成済みHTML文字列を正規表現で
// 監査する」方式を踏襲する）。
function checkHtmlIntegrity(html) {
  const errors = [];
  if (typeof html !== 'string' || !html) return errors;
  // 需給タイムライン/信用需給ブロック専用のクラス（ctl-svg）だけを対象に、
  // 開始/終了タグの数が一致するかを見る（ページ全体の<svg>は他機能
  // （スパークライン等）にも使われているため対象を絞る）。
  const ctlSvgOpens = (html.match(/<svg class="ctl-svg"/g) ?? []).length;
  const ctlSvgCloses = ctlSvgOpens > 0 ? (html.match(/<svg class="ctl-svg"[^>]*>[\s\S]*?<\/svg>/g) ?? []).length : 0;
  if (ctlSvgOpens !== ctlSvgCloses) {
    pushIssue(errors, 'broken_svg', `需給タイムラインのSVGタグが壊れています（開始${ctlSvgOpens}件・正しく閉じているのは${ctlSvgCloses}件）`);
  }
  const timelineHead = (html.match(/需給タイムライン/g) ?? []).length;
  const timelineFoot = (html.match(/class="ctl-foot"/g) ?? []).length + (html.match(/class="ctl-empty"/g) ?? []).length;
  if (timelineHead > 0 && timelineHead !== timelineFoot) {
    pushIssue(errors, 'broken_svg', `需給タイムラインのブロックが完全に閉じていない可能性があります（見出し${timelineHead}件・フッター/空表示${timelineFoot}件）`);
  }
  return errors;
}

// タグ整合性: creditSupplyTags(既存関数)で再計算した結果とcreditSupplyTimeline.tagsが
// 一致するか（signalとタグの内容が矛盾していないか）。未知のタグが無いか。
function checkTagConsistency(results) {
  const errors = [];
  const known = new Set(CREDIT_SUPPLY_TAGS);
  for (const r of results) {
    const tl = r.creditSupplyTimeline;
    if (!tl || !tl.checked) continue;
    for (const t of tl.tags) {
      if (!known.has(t)) pushIssue(errors, 'unknown_tag', `未定義のタグ「${t}」が出力されています`, r.code);
    }
    if (r.creditSupplyQuality) {
      const recomputed = creditSupplyTags({ creditSupplyQuality: r.creditSupplyQuality });
      const same = recomputed.length === tl.tags.length && recomputed.every((t) => tl.tags.includes(t));
      if (!same) pushIssue(errors, 'tag_mismatch', 'creditSupplyTimeline.tagsが既存creditSupplyTags(r)の再計算結果と一致しません', r.code);
    }
  }
  return errors;
}

// SCORE不変条件: screener.mjs側で既に計算済みのr.scoreInvariantOk（同じ
// スキャン内でcreditSupplyQuality/creditSupplyTimeline等を取り除いた
// 複製でbuyScoreを再計算し、一致したかを記録したもの）を集計するだけ。
// ここでスコアを再計算しない（health_check.mjsは判定ロジックを持たない）。
function checkScoreInvariant(results) {
  const errors = [];
  for (const r of results) {
    if (r.scoreInvariantOk === false) pushIssue(errors, 'score_invariant_failed', 'creditSupplyQuality/creditSupplyTimeline関連のフィールドがSCORE計算に混入しています', r.code);
  }
  return errors;
}

function countTags(results) {
  const counts = {};
  for (const t of CREDIT_SUPPLY_TAGS) counts[t] = 0;
  for (const r of results) {
    for (const t of r.creditSupplyTimeline?.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

// データカバレッジ: 今回の集計値。過去スキャン(previousHealth)との比較は
// 呼び出し元のcompareWithPrevious()が別途行う（固定閾値を決め打ちしない
// ため、ここでは「今回の値」を出すだけに留める）。
function computeCoverage(results) {
  const creditQualityChecked = results.filter((r) => r.creditSupplyQuality?.checked).length;
  const timelineChecked = results.filter((r) => r.creditSupplyTimeline?.checked).length;
  const timelineMissing = results.length - timelineChecked;
  const pendingCount = results.filter((r) => r.creditSupplyQuality?.bounceQuality === 'PENDING').length;
  const closeMissingCount = results.reduce((sum, r) => sum + (r.creditSupplyTimeline?.points ?? []).filter((p) => p.close === null).length, 0);
  return {
    stocksChecked: results.length,
    creditQualityChecked,
    timelineChecked,
    timelineMissing,
    pendingCount,
    closeMissingCount,
    tagCounts: countTags(results),
  };
}

// 過去スキャン比較（ユーザー方針: 新しい固定閾値を作らない。0件化・
// NULL化などの明白な異常だけERROR、件数の減少はWARNINGに留める）。
function compareWithPrevious(coverage, previousHealth) {
  const errors = [];
  const warnings = [];
  const info = [];
  const prev = previousHealth?.coverage;
  if (!prev) return { errors, warnings, info };

  if (prev.creditQualityChecked > 0 && coverage.creditQualityChecked === 0) {
    pushIssue(errors, 'credit_quality_checked_zero', 'creditSupplyQuality.checkedの件数が前回から0件になりました（データ取得経路が死んでいる可能性）');
  } else if (coverage.creditQualityChecked < prev.creditQualityChecked) {
    pushIssue(warnings, 'credit_quality_checked_decreased', `creditSupplyQuality.checkedの件数が前回(${prev.creditQualityChecked})から今回(${coverage.creditQualityChecked})へ減少しました`);
  }

  if (prev.timelineChecked > 0 && coverage.timelineChecked === 0) {
    pushIssue(errors, 'timeline_checked_zero', 'creditSupplyTimeline.checkedの件数が前回から0件になりました（データ取得経路が死んでいる可能性）');
  } else if (coverage.timelineChecked < prev.timelineChecked) {
    pushIssue(warnings, 'timeline_checked_decreased', `creditSupplyTimeline.checkedの件数が前回(${prev.timelineChecked})から今回(${coverage.timelineChecked})へ減少しました`);
  }

  if (coverage.closeMissingCount > prev.closeMissingCount) {
    pushIssue(warnings, 'close_missing_increased', `終値が欠損している観測点が前回(${prev.closeMissingCount})から今回(${coverage.closeMissingCount})へ増加しました`);
  }
  if (coverage.pendingCount > prev.pendingCount) {
    pushIssue(warnings, 'pending_increased', `PENDING件数が前回(${prev.pendingCount})から今回(${coverage.pendingCount})へ増加しました`);
  }
  return { errors, warnings, info };
}

// results: AMBUSH結果配列（amb.results）。previousHealth: 直前の
// health_history_cache.jsonエントリ（無ければ比較をスキップ）。html:
// 生成済みのindex.html文字列（省略可。渡さなければUIチェックはスキップ
// する。渡す場合はauditGeneratedHtmlと同じ「文字列を正規表現で監査する」
// 方式で、レンダリング関数を呼び直さない＝scraper.mjsとの循環import
// にならない）。
export function computeHealthCheck({ results, previousHealth, logicFingerprint, gitSha, generatedAt, todayIso, html } = {}) {
  const list = results ?? [];
  const errors = [];
  const warnings = [];
  const info = [];

  for (const e of checkCreditSupplyIntegrity(list, todayIso)) errors.push(e);
  for (const e of checkTimelineIntegrity(list, todayIso)) errors.push(e);
  for (const e of checkTagConsistency(list)) errors.push(e);
  for (const e of checkScoreInvariant(list)) errors.push(e);
  for (const e of checkHtmlIntegrity(html)) errors.push(e);

  const coverage = computeCoverage(list);
  const cmp = compareWithPrevious(coverage, previousHealth);
  errors.push(...cmp.errors);
  warnings.push(...cmp.warnings);
  info.push(...cmp.info);

  if (previousHealth?.logicFingerprint && previousHealth.logicFingerprint !== logicFingerprint) {
    info.push({ code: 'logic_changed', message: '判定ロジック変更後の初回スキャンです（logicFingerprintが前回から変化）', affected: [] });
  }

  const status = errors.length ? HEALTH_STATUS.ERROR : (warnings.length ? HEALTH_STATUS.WARNING : HEALTH_STATUS.PASS);
  const invalidDateCount = errors.filter((e) => e.code === 'invalid_date').reduce((n, e) => n + e.affected.length, 0);

  return {
    status,
    generatedAt: generatedAt ?? null,
    gitSha: gitSha ?? null,
    logicFingerprint: logicFingerprint ?? null,
    // ユーザー提示例（項目3）に合わせ、件数系フィールドはトップレベルに
    // フラットに置く（tagCountsのみ性質上オブジェクトのまま）。
    stocksChecked: coverage.stocksChecked,
    creditQualityChecked: coverage.creditQualityChecked,
    timelineChecked: coverage.timelineChecked,
    timelineMissing: coverage.timelineMissing,
    pendingCount: coverage.pendingCount,
    closeMissingCount: coverage.closeMissingCount,
    invalidDateCount,
    tagCounts: coverage.tagCounts,
    coverage, // 前回比較(compareWithPrevious)がそのまま読める形も維持する
    scoreInvariantFailures: errors.filter((e) => e.code === 'score_invariant_failed').reduce((n, e) => n + e.affected.length, 0),
    tagConsistencyFailures: errors.filter((e) => e.code === 'tag_mismatch' || e.code === 'unknown_tag').reduce((n, e) => n + e.affected.length, 0),
    errors, warnings, info,
  };
}
