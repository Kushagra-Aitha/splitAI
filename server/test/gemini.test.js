import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGemini } from '../assistant/gemini-smoke.js';

const options = { apiKey: 'test-only-secret', model: 'test-model' };

test('Gemini smoke uses a fixed prompt and header credential, with no user data or tools', async () => {
  const result = await checkGemini({ ...options, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    assert.equal(url.includes(options.apiKey), false);
    assert.equal(init.headers['x-goog-api-key'], options.apiKey);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Reply with exactly SPLIT_AI_OK and no other text.' }] }]);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'SPLIT_AI_OK' }] } }] });
  } });
  assert.deepEqual(result, { status: 'ok', model: 'test-model' });
});

test('missing credentials and invalid models do not send a request', async () => {
  const fetchImpl = async () => assert.fail('must not run');
  await assert.rejects(checkGemini({ ...options, apiKey: '', fetchImpl }), /GEMINI_API_KEY/);
  await assert.rejects(checkGemini({ ...options, model: '../other?key=secret', fetchImpl }), /GEMINI_MODEL/);
});

test('provider failures never disclose the raw provider response or network error', async () => {
  await assert.rejects(checkGemini({ ...options, fetchImpl: async () => new Response('private provider detail', { status: 403 }) }),
    (error) => error.message === 'Gemini smoke check failed (HTTP 403).');
  await assert.rejects(checkGemini({ ...options, fetchImpl: async () => { throw new Error('private request data'); } }),
    (error) => !error.message.includes('private') && /network/.test(error.message));
  await assert.rejects(checkGemini({ ...options, fetchImpl: async () => { throw new DOMException('private', 'TimeoutError'); } }), /timed out/);
});

test('malformed, blocked, truncated, unexpected, and oversized model responses fail the check', async () => {
  for (const response of [
    new Response('{'), Response.json({ promptFeedback: { blockReason: 'SAFETY' } }),
    Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'SPLIT_AI_OK' }] } }] }),
    Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'wrong' }] } }] }),
    new Response('a'.repeat(65 * 1024)),
  ]) {
    await assert.rejects(checkGemini({ ...options, fetchImpl: async () => response }));
  }
});
