export const GUARD_REASONS = Object.freeze({
  PROMPT_OVERRIDE: 'Tries to override instructions or payment approval checks.',
  OUTSIDE_PAYMENT: 'Asks for payment through an outside account or service.',
  CREDENTIAL_REQUEST: 'Asks for a password, PIN or verification code.',
  SPAM_PATTERN: 'Matches language patterns associated with spam.',
});
