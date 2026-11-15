import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notify } from '../notifications/notify.js';
import { modelResult, REASONS, rulesOnlyResult } from './classifier.js';

let manifest;
try {
  manifest = JSON.parse(readFileSync(new URL('./model-manifest.json', import.meta.url), 'utf8'));
  if (manifest.version !== 'split-guard-deberta-v1' ||
      manifest.baseModel !== 'microsoft/deberta-v3-xsmall' ||
      !Number.isFinite(manifest.threshold) || manifest.threshold <= 0 || manifest.threshold > 1 ||
      !Number.isInteger(manifest.maxLength) || manifest.maxLength < 16 || manifest.maxLength > 256 ||
      typeof manifest.revision !== 'string' || typeof manifest.artifact !== 'string') manifest = null;
} catch { manifest = null; }

const defaultModelPath = fileURLToPath(new URL('./.cache/deberta-xsmall-onnx/', import.meta.url));
let pipelinePromise;
let fallbackLogged = false;

async function loadPipeline() {
  if (!manifest) throw new Error('Invalid Guard model manifest.');
  const { env, pipeline } = await import('@huggingface/transformers');
  const localModel = process.env.GUARD_MODEL_PATH?.trim();
  const remoteModel = process.env.GUARD_MODEL_ID?.trim();
  const useRemote = !localModel && Boolean(remoteModel);
  env.allowRemoteModels = useRemote;
  env.allowLocalModels = true;
  const modelPath = localModel || remoteModel || defaultModelPath;
  return pipeline('text-classification', modelPath, {
    dtype: 'q8',
    local_files_only: !useRemote,
  });
}

function guardPipeline() {
  pipelinePromise ??= loadPipeline();
  return pipelinePromise;
}

function logFallback() {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.error(JSON.stringify({ event: 'GUARD_MODEL_FALLBACK', model: manifest?.baseModel ?? null }));
}

async function modelProbability(text) {
  const classify = await guardPipeline();
  const output = await classify(text.slice(0, 500), { top_k: null, truncation: true });
  const rows = Array.isArray(output?.[0]) ? output[0] : output;
  const spam = rows?.find((row) => /^(spam|label_1)$/iu.test(row.label));
  if (!spam || !Number.isFinite(spam.score)) throw new Error('Invalid Guard model output.');
  return spam.score;
}

export async function classifyGuardText(text) {
  try {
    return modelResult(text, await modelProbability(text), manifest);
  } catch {
    logFallback();
    return rulesOnlyResult(text);
  }
}

export const classifyComment = classifyGuardText;

export async function warmGuard() {
  try {
    await modelProbability('Thanks, I will settle through Split.');
    return true;
  } catch {
    logFallback();
    return false;
  }
}

// B16: every member of the chat gets a Guard entry for a flagged message,
// including its author ("your message was flagged"); only the others are
// notified.
export async function recordCommentFlags(db, comment, classification) {
  if (!classification.flagged) return;
  const reason = classification.reasons.map((code) => REASONS[code]).join(' ');
  await db.query(`INSERT INTO guard_events
    (actor_user_id, group_id, expense_id, comment_id, decision, reason_code, reason, source)
    SELECT m.user_id, c.group_id, c.expense_id, c.id, 'flagged', 'SUSPICIOUS_COMMENT', $2, 'comment'
    FROM group_comments c JOIN group_members m ON m.group_id = c.group_id AND m.left_at IS NULL
    LEFT JOIN guard_settings prefs ON prefs.user_id = m.user_id
    WHERE c.id = $1 AND coalesce(prefs.comment_alerts_enabled, true)
    ON CONFLICT (comment_id, actor_user_id) WHERE comment_id IS NOT NULL DO NOTHING`, [comment.id, reason]);
  await notify(db, { kind: 'guard_flagged', sourceId: comment.id });
}
