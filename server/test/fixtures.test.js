import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ACCOUNTS, GROUPS, USERS } from '../db/demo-ids.js';

const dir = new URL('../../fixtures/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const users = new Set(Object.values(USERS));
const accounts = new Set(Object.values(ACCOUNTS));
const groups = new Set(Object.values(GROUPS));

test('every fixture file is valid JSON', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    assert.doesNotThrow(() => load(f), f);
  }
});

test('fixtures only reference seeded users, accounts and groups', () => {
  const walk = (value, key, file) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key, file));
    if (value && typeof value === 'object') {
      return Object.entries(value).forEach(([k, v]) => walk(v, k, file));
    }
    if (typeof value !== 'string' || !key) return;
    if (/^(userId|payerUserId|payeeUserId|paidBy)$/.test(key) || key === 'participantIds') {
      assert.ok(users.has(value), `${file}: ${key} ${value} is not a seeded user`);
    }
    if (key === 'groupId') assert.ok(groups.has(value), `${file}: groupId ${value} is not seeded`);
    if (key === 'accountId') assert.ok(accounts.has(value), `${file}: accountId ${value} is not seeded`);
  };
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) walk(load(f), null, f);
});

test('expense draft shares are integer cents that sum to the total', () => {
  const drafts = load('expense-drafts.json');
  for (const name of ['create', 'createUnevenRemainder']) {
    const { draft } = drafts[name].response;
    assert.ok(draft.shares.every((s) => Number.isInteger(s.cents) && s.cents >= 0));
    assert.equal(sum(draft.shares.map((s) => s.cents)), draft.totalCents, name);
    assert.equal(draft.totalCents, drafts[name].request.body.cents, name);
  }
  assert.deepEqual(drafts.create.response.draft.shares.map((s) => s.cents), [1400, 1400, 1400]);
  assert.equal(drafts.confirm.response.expense.id, drafts.create.response.draft.id, 'expense keeps its draft ID');
});

test('group debts add up to their totals', () => {
  const { debts } = load('groups.json').detail.response;
  assert.equal(sum(debts.youOwe.map((d) => d.cents)), debts.youOweCents);
  assert.equal(sum(debts.owedToYou.map((d) => d.cents)), debts.owedToYouCents);
});

test('overview buckets are zero-filled days that add up to the totals', () => {
  const { response } = load('overview.json');
  assert.equal(response.buckets.length, 13);
  assert.equal(sum(response.buckets.map((b) => b.earnedCents)), response.totals.earnedCents);
  assert.equal(sum(response.buckets.map((b) => b.spentCents)), response.totals.spentCents);
});

test('spendable funds = balance − goal holds − settlement holds', () => {
  const r = load('funds.json').getSpendableFunds.result;
  assert.equal(r.spendableCents, r.balanceCents - r.goalHoldsCents - r.settlementHoldsCents);
  assert.equal(load('funds.json').reserveFundsInsufficient.httpResponse.status, 409);
});
