import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_MONTH_TOTALS, demoHistory, demoId, splitCents } from '../db/demo-history.js';

const rows = demoHistory();

test('each demo month adds up exactly to the Profile design totals', () => {
  for (const { month, earned, spent } of DEMO_MONTH_TOTALS) {
    const inMonth = rows.filter((r) => r.providerKey.startsWith(`demo:${month}:`));
    const credits = inMonth.filter((r) => r.direction === 'credit').reduce((a, r) => a + r.amountCents, 0);
    const debits = inMonth.filter((r) => r.direction === 'debit').reduce((a, r) => a + r.amountCents, 0);
    assert.equal(credits, earned, `${month} earned`);
    assert.equal(debits, spent, `${month} spent`);
  }
});

test('November history stops at Nov 13 so real Nessie activity follows it', () => {
  const last = rows.filter((r) => r.providerKey.startsWith('demo:2026-11:')).map((r) => r.occurredAt).sort().at(-1);
  assert.ok(last < '2026-11-14T00:00:00Z', last);
  for (const r of rows) assert.equal(r.providerKey.slice(5, 12), r.occurredAt.slice(0, 7), r.providerKey);
});

test('rows are positive integer cents with unique, stable keys and IDs', () => {
  assert.ok(rows.every((r) => Number.isSafeInteger(r.amountCents) && r.amountCents > 0));
  assert.equal(new Set(rows.map((r) => r.providerKey)).size, rows.length);
  assert.deepEqual(demoHistory(), rows);
  const id = demoId('acct:demo:2026-11:rent:0');
  assert.equal(id, demoId('acct:demo:2026-11:rent:0'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('transfers are never seeded, so they cannot inflate spending', () => {
  assert.ok(rows.every((r) => r.kind === 'purchase' || r.kind === 'deposit'));
});

test('splitCents always sums exactly', () => {
  assert.deepEqual(splitCents(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitCents(4200, 3), [1400, 1400, 1400]);
});
