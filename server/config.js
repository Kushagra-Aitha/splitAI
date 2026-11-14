const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (env.NODE_ENV && !['development', 'test', 'production'].includes(env.NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  let origin;
  try {
    const url = new URL(env.APP_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== env.APP_ORIGIN) {
      throw new Error();
    }
    if (production && url.protocol !== 'https:') throw new Error();
    if (!production && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error();
    }
    origin = url.origin;
  } catch {
    throw new Error('APP_ORIGIN must be an exact origin; HTTPS is required outside local development.');
  }
  if (!UUID.test(env.DEMO_ACTOR_ID || '')) {
    throw new Error('DEMO_ACTOR_ID must be the configured sandbox actor UUID.');
  }
  if (!env.DEMO_ACCESS_CODE || Buffer.byteLength(env.DEMO_ACCESS_CODE) < 32 || Buffer.byteLength(env.DEMO_ACCESS_CODE) > 256) {
    throw new Error('DEMO_ACCESS_CODE must contain 32–256 bytes.');
  }
  const displayName = env.DEMO_ACTOR_NAME?.trim() || 'Maya Chen';
  if (displayName.length > 80) throw new Error('DEMO_ACTOR_NAME must contain at most 80 characters.');
  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port,
    origin,
    secureCookies: new URL(origin).protocol === 'https:',
    actor: Object.freeze({ userId: env.DEMO_ACTOR_ID, displayName }),
    accessCode: env.DEMO_ACCESS_CODE,
  });
}
