import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTransaction } from '../banking/provider.js';

// Shapes copied from real Nessie v2 sandbox responses.
const MAYA = 'acct_maya';
const SAM = 'acct_sam';
const merchants = new Map([['mrc_cafe', 'Campus Café']]);
const base = { status: 'pending', created_at: '2026-11-14T06:54:24.027090311Z', settle_at: '2026-11-14T06:54:34Z' };

test('a purchase is a debit with its merchant name', () => {
  const t = normalizeTransaction(
    { ...base, id: 'txn_1', kind: 'purchase', amount_cents: 450, payer_id: MAYA, merchant_id: 'mrc_cafe', description: '' },
    MAYA,
    merchants,
  );
  assert.deepEqual(t, {
    providerTransactionId: 'txn_1',
    occurredAt: '2026-11-14T06:54:24.027Z',
    kind: 'purchase',
    direction: 'debit',
    amountCents: 450,
    status: 'pending',
    description: 'Campus Café',
    merchantName: 'Campus Café',
    counterpartyAccountId: null,
  });
});

test('a deposit is a credit even though Nessie lists the account as payer', () => {
  const t = normalizeTransaction({ ...base, id: 'txn_2', kind: 'deposit', amount_cents: 12000, payer_id: MAYA, description: 'Campus job' }, MAYA);
  assert.equal(t.direction, 'credit');
  assert.equal(t.description, 'Campus job');
});

test('a transfer is a debit for the payer and a credit for the payee', () => {
  const raw = { ...base, id: 'txn_3', kind: 'transfer', amount_cents: 500, payer_id: SAM, payee_id: MAYA, description: 'Coffee money' };
  assert.deepEqual(
    [normalizeTransaction(raw, SAM).direction, normalizeTransaction(raw, SAM).counterpartyAccountId],
    ['debit', MAYA],
  );
  assert.deepEqual(
    [normalizeTransaction(raw, MAYA).direction, normalizeTransaction(raw, MAYA).counterpartyAccountId],
    ['credit', SAM],
  );
  assert.equal(normalizeTransaction(raw, 'acct_other'), null);
});

test('malformed or foreign rows are skipped, not thrown', () => {
  const ok = { ...base, id: 'txn_4', kind: 'purchase', amount_cents: 100, payer_id: MAYA };
  assert.ok(normalizeTransaction(ok, MAYA));
  for (const bad of [
    { ...ok, amount_cents: 0 },
    { ...ok, amount_cents: 1.5 },
    { ...ok, amount_cents: '100' },
    { ...ok, kind: 'mystery' },
    { ...ok, status: 'weird' },
    { ...ok, created_at: 'not a date' },
    { ...ok, id: '' },
    { ...ok, payer_id: SAM },
    null,
  ]) {
    assert.equal(normalizeTransaction(bad, MAYA), null, JSON.stringify(bad));
  }
});
