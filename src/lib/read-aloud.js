let current;

export function canReadAloud() {
  return typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function' &&
    typeof window.speechSynthesis?.speak === 'function';
}

export function stopReading(owner) {
  if (!current || (owner && current.owner !== owner)) return;
  current = undefined;
  window.speechSynthesis.cancel();
}

export function readAloud(text, { owner, onError } = {}) {
  if (typeof text !== 'string' || !text.trim() || !canReadAloud()) return false;
  stopReading();
  const utterance = new window.SpeechSynthesisUtterance(text.trim());
  const active = { owner, utterance };
  const done = (event) => {
    if (current !== active) return;
    current = undefined;
    if (event.type === 'error') onError?.();
  };
  utterance.onend = done;
  utterance.onerror = done;
  current = active;
  try {
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    current = undefined;
    return false;
  }
}
