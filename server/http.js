export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  res.end(bytes);
}

export async function readJson(req, limit = 16 * 1024) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'JSON_REQUIRED', 'Send an application/json request body.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'ENCODING_UNSUPPORTED', 'Compressed request bodies are not supported.');
  }
  if (Number(req.headers['content-length']) > limit) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'The request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request body is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(422, 'INVALID_JSON', 'Send a valid JSON object.');
  }
}

export function requireSameOrigin(req, origin) {
  if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'This request must come from the app origin.');
  }
}
