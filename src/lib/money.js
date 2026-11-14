// Decimal transcription without binary floating-point arithmetic. The server
// still validates the amount and computes the authoritative shares.
export function usdToCents(text, { allowZero = false } = {}) {
  if (typeof text !== 'string' || text.length > 20 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) throw new Error('Enter an amount with at most two decimal places.');
  const [dollars, fraction = ''] = text.split('.');
  const cents = BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < (allowZero ? 0n : 1n) || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Enter a ${allowZero ? 'nonnegative' : 'positive'} amount within the supported range.`);
  return Number(cents);
}

export function centsToUsdText(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid cents.');
  const exact = BigInt(cents);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, '0')}`;
}

export function formatUsdCents(cents) {
  const [dollars, fraction] = centsToUsdText(cents).split('.');
  return `$${BigInt(dollars).toLocaleString('en-US')}.${fraction}`;
}
