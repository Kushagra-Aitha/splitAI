import { apiRequest, getSession } from '../api/session.js';

let current;

function basicVoiceAvailable() {
  return typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function' &&
    typeof window.speechSynthesis?.speak === 'function';
}

export function canReadAloud() {
  return typeof window !== 'undefined' && (typeof window.Audio === 'function' || basicVoiceAvailable());
}

export function stopReading(owner) {
  if (!current || (owner && current.owner !== owner)) return;
  const active = current;
  current = undefined;
  active.controller.abort();
  active.audio?.pause();
  if (active.url) URL.revokeObjectURL(active.url);
  if (active.utterance) window.speechSynthesis.cancel();
}

export function readAloud(text, { owner, onError, onBasic } = {}) {
  if (typeof text !== 'string' || !text.trim() || !canReadAloud()) return false;
  stopReading();
  const active = { owner, controller: new AbortController() };
  current = active;
  const done = () => { if (current === active) stopReading(owner); };
  const useBasicVoice = () => {
    if (current !== active) return;
    if (active.url) {
      active.audio.onerror = null;
      active.audio.pause();
      URL.revokeObjectURL(active.url);
      active.url = null;
    }
    onBasic?.();
    if (!basicVoiceAvailable()) { done(); onError?.(); return; }
    try {
      active.utterance = new window.SpeechSynthesisUtterance(text.trim());
      active.utterance.onend = done;
      active.utterance.onerror = () => { if (current === active) { done(); onError?.(); } };
      window.speechSynthesis.speak(active.utterance);
    } catch { done(); onError?.(); }
  };

  if (!getSession() || typeof window.Audio !== 'function') useBasicVoice();
  else {
    void apiRequest('/api/voice/speak', {
      method: 'POST', body: { text: text.trim().slice(0, 600) }, audio: true, signal: active.controller.signal,
    }).then(async (blob) => {
      if (current !== active) return;
      if (!(blob instanceof Blob) || !blob.size) { useBasicVoice(); return; }
      active.url = URL.createObjectURL(blob);
      active.audio = new window.Audio(active.url);
      active.audio.onended = done;
      active.audio.onerror = useBasicVoice;
      await active.audio.play();
    }).catch(useBasicVoice);
  }
  return true;
}
