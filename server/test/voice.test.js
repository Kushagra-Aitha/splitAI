import assert from 'node:assert/strict';
import test from 'node:test';
import { createElevenLabs } from '../assistant/elevenlabs.js';
import { createVoiceLimit } from '../assistant/voice-limit.js';
import { createVoiceTranscription } from '../assistant/voice-transcription.js';

test('ElevenLabs sends Scribe WAV and requests MP3 using a server credential', async () => {
  const calls = [];
  const voice = createElevenLabs({
    apiKey: 'test-key', voiceId: 'test-voice',
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      return url.endsWith('/speech-to-text') ? Response.json({ text: 'Split pizza with Ben.' }) :
        new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  assert.equal(await voice.transcribe(Buffer.from('test WAV')), 'Split pizza with Ben.');
  assert.deepEqual(await voice.speak('Review your split.'), Buffer.from([1, 2, 3]));
  assert.equal(calls[0].headers['xi-api-key'], 'test-key');
  assert.equal(calls[0].body.get('model_id'), 'scribe_v2');
  assert.equal(calls[0].body.get('file').type, 'audio/wav');
  assert.match(calls[1].url, /text-to-speech\/test-voice\?output_format=/);
  assert.equal(JSON.parse(calls[1].body).text, 'Review your split.');
});

test('missing configuration skips ElevenLabs and outage falls back to Gemini after validation', async () => {
  const disabled = createElevenLabs({ fetchImpl: () => assert.fail('Provider should not be called') });
  assert.equal(await disabled.transcribe(Buffer.alloc(46)), null);
  assert.equal(await disabled.speak('Hello'), null);

  const wav = Buffer.alloc(46);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  const audio = wav.toString('base64');
  let attempts = 0;
  const handler = createVoiceTranscription(async (request) => {
    assert.equal(request.inlineAudio.data, audio);
    return { transcript: '  Split pizza with Ben.  ' };
  }, { transcribe: async () => { attempts++; throw Error('Provider unavailable'); } });
  await assert.rejects(handler({ body: { audio: 'nope' } }), { code: 'INVALID_VOICE_CLIP' });
  assert.equal(attempts, 0);
  assert.deepEqual(await handler({ body: { audio } }), { transcript: 'Split pizza with Ben.', basic: true });
  assert.equal(attempts, 1);
});

test('voice rate limit isolates users and resets each minute', () => {
  let time = 0;
  const limit = createVoiceLimit({ limit: 1, now: () => time });
  limit('maya');
  assert.throws(() => limit('maya'), { status: 429 });
  limit('ben');
  time = 60_000;
  limit('maya');
});
