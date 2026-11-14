// B9 · Pure helpers for Nessie provisioning.
import assert from 'node:assert/strict';
import test from 'node:test';
import { accountNickname, nessieName } from '../banking/provision.js';

test('Nessie customer names come from the account name with safe fallbacks', () => {
  assert.deepEqual(nessieName('Maya Chen'), { first_name: 'Maya', last_name: 'Chen' });
  assert.deepEqual(nessieName('  Ana  de la Cruz '), { first_name: 'Ana', last_name: 'de la Cruz' });
  assert.deepEqual(nessieName('Priya'), { first_name: 'Priya', last_name: 'Member' });
  assert.deepEqual(nessieName(''), { first_name: 'Split', last_name: 'Member' });
  assert.equal(nessieName('x'.repeat(90)).first_name.length, 40);
});

test('the account nickname ties a Nessie account to one Split user', () => {
  assert.equal(accountNickname('1234abcd-0000-4000-8000-000000000000'), 'Split · 1234abcd');
});
