import { HttpError } from '../http.js';

const invalid = () => new HttpError(422, 'INVALID_VOICE_CLIP', 'Record up to 15 seconds, then try again.');

export function createVoiceTranscription({ transcribe, limit = () => {} } = {}) {
  return async ({ actor, body }) => {
    const { audio } = body ?? {};
    if (typeof audio !== 'string' || !audio.length || audio.length > 640060 || audio.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw invalid();
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length <= 44 || bytes.length > 480044 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
    limit(actor?.userId);
    let transcript;
    try { transcript = await transcribe(bytes); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'VOICE_TRANSCRIPTION_FAILED', 'Couldn’t transcribe the recording. You can still type.');
    }
    if (typeof transcript !== 'string') {
      throw new HttpError(502, 'VOICE_TRANSCRIPTION_FAILED', 'Couldn’t transcribe the recording. You can still type.');
    }
    return { transcript: transcript.trim().slice(0, 501), basic: false };
  };
}
