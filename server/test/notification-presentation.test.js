import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationMessage, relativeTime } from '../../src/features/notifications/presentation.js';

test('notification messages preserve exact cents, names and payment direction', () => {
  assert.equal(notificationMessage({ kind: 'expense_added', actorName: 'Ben', merchant: 'Groceries', totalCents: 3000, yourShareCents: 1500 }), 'Ben added Groceries $30.00 · your share $15.00');
  assert.equal(notificationMessage({ kind: 'settlement_posted', actorName: 'Ava', settlementCents: 33900, isPayer: false }), "Ava's $339.00 payment to you posted");
  assert.equal(notificationMessage({ kind: 'settlement_sent', settlementCents: 1500, isPayer: true, payeeName: 'Ben' }), 'Your $15.00 payment to Ben was submitted');
  assert.equal(notificationMessage({ kind: 'guard_blocked' }), 'Guard blocked a request');
  assert.equal(notificationMessage({ kind: 'guard_flagged', actorName: 'Sam' }), 'Guard flagged a suspicious comment from Sam');
  assert.equal(relativeTime('2026-11-14T12:00:00Z', Date.parse('2026-11-14T12:03:00Z')), '3 minutes ago');
  assert.equal(relativeTime('2026-11-14T12:00:00Z', Date.parse('2026-11-14T11:59:00Z')), 'Just now');
});
