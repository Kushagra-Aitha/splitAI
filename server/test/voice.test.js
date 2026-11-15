import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiVoice } from '../assistant/gemini-voice.js';
import { createVoiceLimit } from '../assistant/voice-limit.js';
import { createVoiceTranscription } from '../assistant/voice-transcription.js';

test('Gemini transcribes audio and returns 3.8 Flash TTS audio using the server credential', async () => {
  const calls = [];
  const ttsWav = Buffer.alloc(48);
  ttsWav.write('RIFF');
  ttsWav.write('WAVE', 8);
  const voice = createGeminiVoice({
    apiKey: 'test-key',
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      return calls.length === 1
        ? Response.json({ candidates: [{ content: { parts: [{ text: 'Split pizza with Ben.' }] } }] })
        : Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: ttsWav.toString('base64') }] }] });
    },
  });
  assert.equal(await voice.transcribe(Buffer.from('test WAV')), 'Split pizza with Ben.');
  assert.deepEqual(await voice.speak('Review your split.'), ttsWav);
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-key');
  assert.match(calls[0].url, /gemini-3\.5-transcribe:generateContent$/);
  assert.equal(JSON.parse(calls[0].body).contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.match(calls[1].url, /v1beta\/interactions$/);
  const request = JSON.parse(calls[1].body);
  assert.equal(request.model, 'gemini-3.8-flash-tts');
  assert.equal(request.store, false);
  assert.equal(request.input[0].content[0].text, 'Review your split.');
  assert.deepEqual(request.response_format, { type: 'audio', mime_type: 'audio/wav' });
});

test('missing Gemini configuration fails closed and transcription validates the WAV before provider use', async () => {
  const disabled = createGeminiVoice({ fetchImpl: () => assert.fail('Provider should not be called') });
  await assert.rejects(disabled.transcribe(Buffer.alloc(46)), { status: 503 });
  await assert.rejects(disabled.speak('Hello'), { status: 503 });

  const wav = Buffer.alloc(46);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  const audio = wav.toString('base64');
  let attempts = 0;
  const handler = createVoiceTranscription({ transcribe: async (bytes) => {
    attempts++;
    assert.deepEqual(bytes, wav);
    return '  Split pizza with Ben.  ';
  } });
  await assert.rejects(handler({ body: { audio: 'nope' } }), { code: 'INVALID_VOICE_CLIP' });
  assert.equal(attempts, 0);
  assert.deepEqual(await handler({ body: { audio } }), { transcript: 'Split pizza with Ben.', basic: false });
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
