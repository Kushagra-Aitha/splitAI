import assert from 'node:assert/strict';
import test from 'node:test';
import { usdToCents, centsToUsdText, formatUsdCents } from '../../src/lib/money.js';

test('manual expense amounts round-trip exactly without floating-point transcription', () => {
  for (const [text, cents] of [['0.01', 1], ['1.1', 110], ['42.00', 4200], ['90071992547409.91', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(usdToCents(text), cents);
    assert.equal(usdToCents(centsToUsdText(cents)), cents);
  }
  assert.equal(formatUsdCents(Number.MAX_SAFE_INTEGER), '$90,071,992,547,409.91');
  for (const text of ['1.005', '-1', '0', '1e3', 'NaN', 'Infinity', '90071992547409.92']) assert.throws(() => usdToCents(text));
});
