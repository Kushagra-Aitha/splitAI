import { apiRequest } from '../../api/session.js';

const sampleRate = 16000;
const maxSeconds = 15;

// Normalize browser-specific recording containers to mono PCM WAV.
async function toWav(blob, context) {
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const frames = Math.min(sampleRate * maxSeconds, Math.ceil(decoded.duration * sampleRate));
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  const binary = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < binary.length; i += 8192) text += String.fromCharCode(...binary.subarray(i, i + 8192));
  return btoa(text);
}

export function createRecordedTalk({ onState, onTranscript, onError }) {
  const supported = !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder === 'function' && typeof AudioContext === 'function' && typeof OfflineAudioContext === 'function';
  let current;

  function finish(session) {
    if (current !== session) return false;
    current = undefined;
    clearTimeout(session.timer);
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.context) void session.context.close().catch(() => {});
    onState('idle');
    return true;
  }

  async function transcribe(session) {
    session.stream.getTracks().forEach((track) => track.stop());
    if (current !== session) return;
    try {
      const blob = new Blob(session.parts, { type: session.recorder.mimeType });
      if (!blob.size) throw new Error('No audio was recorded. Hold the mic while speaking.');
      const audio = await toWav(blob, session.context);
      if (current !== session) return;
      const { transcript, basic } = await apiRequest('/api/voice/transcribe', {
        method: 'POST', body: { audio }, timeoutMs: 35_000, signal: session.controller.signal,
      });
      if (finish(session)) {
        if (transcript) onTranscript(transcript, { basic });
        else onError('No speech was heard. Try again or type a message.');
      }
    } catch (error) {
      if (finish(session)) onError(error.message || 'Couldn’t transcribe the recording. You can still type.');
    }
  }

  function release() {
    const session = current;
    if (!session || session.released) return;
    session.released = true;
    clearTimeout(session.timer);
    if (session.recorder?.state === 'recording') {
      onState('processing');
      session.recorder.stop();
    } else if (finish(session)) {
      onError('If prompted, allow the microphone, then hold it again to start recording.');
    }
  }

  async function record(session) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (current !== session) { stream.getTracks().forEach((track) => track.stop()); return; }
      session.stream = stream;
      session.recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
      session.recorder.ondataavailable = ({ data }) => session.parts.push(data);
      session.recorder.onstop = () => void transcribe(session);
      session.recorder.onerror = () => {
        if (finish(session)) onError('Couldn’t record audio. You can still type.');
      };
      session.recorder.start();
      onState('listening');
      session.timer = setTimeout(release, maxSeconds * 1000);
    } catch (error) {
      if (finish(session)) onError(error.name === 'NotAllowedError' ? 'Microphone access was denied. You can still type.' :
        'Couldn’t access the microphone. You can still type.');
    }
  }

  return {
    supported,
    start() {
      if (!supported || current) return false;
      const session = { parts: [], controller: new AbortController() };
      try { session.context = new AudioContext(); }
      catch { onError('Couldn’t open the microphone. You can still type.'); return false; }
      current = session;
      onState('permission');
      void record(session);
      return true;
    },
    release,
    cancel() {
      const session = current;
      if (session && finish(session)) session.controller.abort();
    },
  };
}
