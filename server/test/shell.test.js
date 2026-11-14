// B10 · Frontend shell helpers: hash routes and avatars.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hashFor, parseHash } from '../../src/lib/routes.js';
import { avatarHtml, avatarStackHtml, initialsFor, toneFor } from '../../src/lib/avatar.js';

const GROUP = '30000000-0000-4000-8000-000000000001';

test('hash routes map to pages and back', () => {
  for (const [hash, state] of [
    ['#/overview', { page: 'home', group: null }],
    ['#/transactions', { page: 'transactions', group: null }],
    ['#/groups', { page: 'groups', group: null }],
    [`#/groups/${GROUP}`, { page: 'groups', group: GROUP }],
    ['#/goals', { page: 'goals', group: null }],
    ['#/insights', { page: 'profile', group: null }],
    ['#/guard', { page: 'guard', group: null }],
    ['#/ask', { page: 'chat', group: null }],
  ]) {
    assert.deepEqual(parseHash(hash), state, hash);
    assert.equal(hashFor(state), hash);
  }
});

test('unknown, malformed or empty hashes fall back safely', () => {
  for (const hash of ['', '#', '#/', '#/nope', '#/overview/extra', '#/goals/123', '#/groups/a/b', 'garbage']) {
    assert.deepEqual(parseHash(hash), { page: 'home', group: null }, hash);
  }
  assert.deepEqual(parseHash('#/groups/not-a-uuid'), { page: 'groups', group: null });
  assert.deepEqual(parseHash(`#/GROUPS/${GROUP.toUpperCase()}`), { page: 'groups', group: GROUP });
  assert.equal(hashFor({ page: 'groups', group: 'x"><script>' }), '#/groups');
  assert.equal(hashFor({ page: 'nope' }), '#/overview');
  assert.equal(hashFor({ page: 'home', group: GROUP }), '#/overview');
});

test('avatars are stable per person and escape names', () => {
  assert.equal(initialsFor('Maya Chen'), 'MC');
  assert.equal(initialsFor('  priya '), 'P');
  assert.equal(initialsFor(''), '?');
  assert.equal(toneFor('10000000-0000-4000-8000-000000000001'), toneFor('10000000-0000-4000-8000-000000000001'));
  const tones = new Set(Array.from({ length: 40 }, (_, i) => toneFor(`user-${i}`)));
  assert.ok(tones.size >= 4, 'IDs spread across tones');
  const html = avatarHtml({ userId: 'u1', displayName: '<b>Eve</b> "X"' });
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /aria-label="&lt;b&gt;Eve&lt;\/b&gt; &quot;X&quot;"/);
  assert.match(avatarStackHtml([1, 2, 3, 4, 5, 6].map((n) => ({ userId: `u${n}`, displayName: `P ${n}` })), { max: 4 }), /\+2<\/span>/);
});
