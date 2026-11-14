import { readFileSync } from 'node:fs';
import { HttpError } from '../http.js';
import { notify } from '../notifications/notify.js';
import { REASONS, score } from './classifier.js';

let model;
try {
  model = JSON.parse(readFileSync(new URL('./model.json', import.meta.url), 'utf8'));
  if (model.version !== 'split-guard-nb-v1' || !Array.isArray(model.priors) || model.priors.length !== 2 ||
      model.priors.some((value) => !Number.isFinite(value)) || !Number.isFinite(model.threshold) || model.threshold <= 0 || model.threshold > 1 ||
      !model.weights || Object.keys(model.weights).length > 6000 || Object.values(model.weights).some((weights) =>
        !Array.isArray(weights) || weights.length !== 2 || weights.some((value) => !Number.isFinite(value)))) model = null;
} catch { model = null; }

export function classifyComment(text) {
  if (!model) throw new HttpError(503, 'COMMENT_GUARD_UNAVAILABLE', 'Comment checks are temporarily unavailable. Please try again.');
  return score(text, model);
}

export async function recordCommentFlags(db, comment, classification) {
  if (!classification.flagged) return;
  const reason = classification.reasons.map((code) => REASONS[code]).join(' ');
  await db.query(`INSERT INTO guard_events
    (actor_user_id, group_id, expense_id, comment_id, decision, reason_code, reason, source)
    SELECT m.user_id, c.group_id, c.expense_id, c.id, 'flagged', 'SUSPICIOUS_COMMENT', $2, 'comment'
    FROM group_comments c JOIN group_members m ON m.group_id = c.group_id AND m.left_at IS NULL
    LEFT JOIN guard_settings prefs ON prefs.user_id = m.user_id
    WHERE c.id = $1 AND m.user_id <> c.author_user_id AND coalesce(prefs.comment_alerts_enabled, true)
    ON CONFLICT (comment_id, actor_user_id) WHERE comment_id IS NOT NULL DO NOTHING`, [comment.id, reason]);
  await notify(db, { kind: 'guard_flagged', sourceId: comment.id });
}
