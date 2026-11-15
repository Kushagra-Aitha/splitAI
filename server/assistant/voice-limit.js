import { HttpError } from '../http.js';

export function createVoiceLimit({ limit = 20, now = Date.now } = {}) {
  const users = new Map();
  return (userId) => {
    const time = now();
    if (users.size >= 1000) {
      for (const [id, bucket] of users) if (bucket.until <= time) users.delete(id);
    }
    let bucket = users.get(userId);
    if (!bucket || bucket.until <= time) {
      if (!bucket && users.size >= 1000) throw new HttpError(429, 'VOICE_RATE_LIMITED', 'Voice is busy. Try again in a minute.');
      bucket = { until: time + 60_000, count: 0 };
      users.set(userId, bucket);
    }
    if (bucket.count >= limit) throw new HttpError(429, 'VOICE_RATE_LIMITED', 'Voice limit reached. Try again in a minute.');
    bucket.count++;
  };
}
