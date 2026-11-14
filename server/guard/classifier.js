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

export function score(text, model) {
  const features = tokens(text); let ham = model.priors[0], spam = model.priors[1];
  for (const feature of features) {
    if (!Object.hasOwn(model.weights, feature)) continue;
    ham += model.weights[feature][0]; spam += model.weights[feature][1];
  }
  const difference = spam - ham;
  const probability = difference >= 0 ? 1 / (1 + Math.exp(-difference)) : Math.exp(difference) / (1 + Math.exp(difference));
  const reasons = ruleReasons(text);
  if (!reasons.length && probability >= model.threshold) reasons.push('SPAM_PATTERN');
  return { flagged: !!reasons.length, score: Math.round(probability * 1_000_000) / 1_000_000, reasons, modelVersion: model.revision || model.version };
}
