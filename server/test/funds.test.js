import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidAmountError, reserveFunds, spendableFrom } from '../banking/funds.js';

test('spendable = provider available − goal holds − settlement holds', () => {
  assert.equal(spendableFrom({ balanceCents: 124800, availableCents: 119850, goalHoldsCents: 20000, settlementHoldsCents: 1800 }), 98050);
});

test('falls back to the balance when Nessie gave no available amount', () => {
  assert.equal(spendableFrom({ balanceCents: 5000, availableCents: null, goalHoldsCents: 0, settlementHoldsCents: 0 }), 5000);
});

test('holds larger than the balance give a negative spendable, never a hidden 0', () => {
  assert.equal(spendableFrom({ balanceCents: 1000, availableCents: 1000, goalHoldsCents: 1500, settlementHoldsCents: 0 }), -500);
});

test('reserveFunds rejects bad amounts before touching the database', async () => {
  const db = { query: () => assert.fail('must not query') };
  for (const cents of [0, -1, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(reserveFunds(db, 'acct', cents), InvalidAmountError, String(cents));
  }
});
