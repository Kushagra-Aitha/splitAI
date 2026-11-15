const origin = 'https://api.elevenlabs.io/v1';
const audioLimit = 1024 * 1024;

export function createElevenLabs({ apiKey, voiceId, fetchImpl = fetch }) {
  const key = apiKey?.trim();
  const voice = voiceId?.trim();

  async function post(path, body, headers = {}) {
    const response = await fetchImpl(origin + path, {
      method: 'POST',
      headers: { 'xi-api-key': key, ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Voice provider unavailable');
    }
    return response;
  }

  return {
    async transcribe(bytes) {
      if (!key) return null;
      const form = new FormData();
      form.set('model_id', 'scribe_v2');
      form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'ask.wav');
      const response = await post('/speech-to-text', form);
      const { text } = await response.json();
      return typeof text === 'string' ? text : null;
    },

    async speak(text) {
      if (!key || !voice) return null;
      const response = await post(`/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
        JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
        { 'Content-Type': 'application/json', Accept: 'audio/mpeg' });
      if (response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') {
        await response.body?.cancel();
        return null;
      }
      const buffers = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > audioLimit) return null;
        buffers.push(chunk);
      }
      return size ? Buffer.concat(buffers) : null;
    },
  };
}
