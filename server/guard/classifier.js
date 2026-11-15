export { GUARD_REASONS as REASONS } from '../../shared/guard-reasons.js';

export function normalize(text) {
  return text.slice(0, 1000).normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gu, ' <email> ')
    .replace(/https?:\/\/\S+|www\.\S+/gu, ' <url> ').replace(/\d+/gu, ' <number> ').replace(/\s+/gu, ' ').trim();
}
export function tokens(text) {
  const words = normalize(text).match(/<[a-z]+>|[a-z]{2,}/gu) || [];
  return [...new Set([...words.map((word) => `w:${word}`), ...words.slice(1).map((word, i) => `b:${words[i]} ${word}`)])].slice(0, 160);
}
const negated = (text, index) => /\b(?:don't|do not|never|avoid)\s+(?:\w+\s+){0,2}$/u.test(text.slice(Math.max(0, index - 45), index));
export function ruleReasons(text) {
  const value = normalize(text);
  const rules = [
    ['PROMPT_OVERRIDE', /\b(?:ignore|disregard)\b.{0,35}\b(?:previous|prior|earlier|system)\b.{0,25}\b(?:instructions?|rules?|prompt)\b|\b(?:system override|bypass confirmation|skip approval|disable.{0,10}approval)\b/gu],
    ['OUTSIDE_PAYMENT', /\b(?:pay|transfer)\b.{0,100}(?:<email>|\b(?:venmo|cash app|cashapp|zelle|paypal|bitcoin|crypto|gift card|outside split)\b)|\bsend\b.{0,30}\b(?:money|dollars?|cash|funds)\b.{0,70}\b(?:venmo|cash app|cashapp|zelle|paypal|bitcoin|crypto|wallet)\b/gu],
    ['CREDENTIAL_REQUEST', /\b(?:send|share|enter|give|reveal|tell)\b.{0,50}\b(?:password|pin|one[ -]time code|verification code|otp)\b/gu],
  ];
  return rules.filter(([, regex]) => [...value.matchAll(regex)].some((match) => !negated(value, match.index))).map(([reason]) => reason);
}

const rounded = (value) => Math.round(value * 1_000_000) / 1_000_000;

export function modelResult(text, probability, model) {
  const flagged = probability >= model.threshold;
  const reasons = flagged ? ruleReasons(text) : [];
  if (flagged && !reasons.length) reasons.push('SPAM_PATTERN');
  return { flagged, score: rounded(probability), reasons, modelVersion: model.revision };
}

export function rulesOnlyResult(text) {
  const reasons = ruleReasons(text);
  return {
    flagged: reasons.length > 0,
    score: reasons.length ? 1 : 0,
    reasons,
    modelVersion: 'split-guard-rules-v1',
  };
}
