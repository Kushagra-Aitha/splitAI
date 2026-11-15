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
  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port,
    origin,
    secureCookies: new URL(origin).protocol === 'https:',
  });
}
