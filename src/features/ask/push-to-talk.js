const failureMessages = {
  'not-allowed': 'Microphone permission was denied. You can still type.',
  'service-not-allowed': 'Speech recognition is unavailable. You can still type.',
  'audio-capture': 'No microphone was available. You can still type.',
  'no-speech': 'No speech was heard. Try again or type a message.',
  network: 'Speech recognition could not connect. Try again or type a message.',
};

export function createPushToTalk({ Recognition, onState, onTranscript, onError }) {
  let current;

  function finish(session, { transcript, error } = {}) {
    if (current !== session) return;
    clearTimeout(session.timer);
    current = undefined;
    onState('idle');
    if (error) onError(error);
    else if (transcript) onTranscript(transcript);
  }

  function release() {
    const session = current;
    if (!session || session.released) return;
    session.released = true;
    clearTimeout(session.timer);
    onState('processing');
    // Some recognizers never send an end event after a service failure.
    session.timer = setTimeout(() => {
      finish(session, { error: 'Speech recognition timed out. Try again or type a message.' });
      try { session.recognizer.abort(); } catch { /* It may have already stopped. */ }
    }, 8000);
    if (session.ended) {
      finish(session, { transcript: session.transcript, error: session.transcript ? undefined : failureMessages['no-speech'] });
      return;
    }
    if (!session.started) return;
    stop(session);
  }

  function stop(session) {
    try { session.recognizer.stop(); }
    catch { finish(session, { error: 'Couldn’t finish listening. Try again or type a message.' }); }
  }

  return {
    supported: typeof Recognition === 'function',
    start() {
      if (current || typeof Recognition !== 'function') return false;
      let recognizer;
      try { recognizer = new Recognition(); }
      catch {
        onError('Couldn’t start the microphone. You can still type.');
        return false;
      }
      const session = { recognizer, started: false, released: false, transcript: '' };
      current = session;
      recognizer.lang = 'en-US';
      recognizer.continuous = false;
      recognizer.interimResults = false;
      recognizer.onstart = () => {
        if (current !== session) return;
        session.started = true;
        if (session.released) stop(session);
      };
      recognizer.onresult = ({ results, resultIndex }) => {
        if (current !== session) return;
        const words = Array.from(results).slice(resultIndex)
          .filter((result) => result.isFinal).map((result) => result[0].transcript.trim()).filter(Boolean);
        session.transcript = [session.transcript, ...words].filter(Boolean).join(' ');
      };
      recognizer.onerror = ({ error }) => finish(session, { error: failureMessages[error] ||
        'Speech recognition stopped. Try again or type a message.' });
      recognizer.onend = () => {
        session.ended = true;
        if (session.released || !session.transcript) finish(session, { transcript: session.transcript,
          error: session.transcript ? undefined : failureMessages['no-speech'] });
      };
      session.timer = setTimeout(release, 30000);
      onState('listening');
      try { recognizer.start(); }
      catch {
        finish(session, { error: 'Couldn’t start the microphone. You can still type.' });
        return false;
      }
      return true;
    },
    release,
    cancel() {
      const session = current;
      if (!session) return;
      finish(session);
      try { session.recognizer.abort(); } catch { /* It may have already stopped. */ }
    },
  };
}
