import { HttpError } from '../http.js';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TIME = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalid = () => new HttpError(422, 'INVALID_CURSOR', 'Choose a valid page cursor.');

export const packCursor = (parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');
export function unpackCursor(value, kinds) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[\w-]{1,256}$/.test(value)) throw invalid();
  let parts;
  try { parts = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(parts) || parts.length !== (kinds ? 3 : 2) || !TIME.test(parts[0]) ||
      typeof parts[1] !== 'string' || !UUID.test(parts[1]) || (kinds && !kinds.includes(parts[2]))) throw invalid();
  const parsed = new Date(parts[0]);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== parts[0].slice(0, 19)) throw invalid();
  return { time: parts[0], id: parts[1], kind: parts[2] };
}
export function pageLimit(value, fallback = 20) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !/^[0-9]{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 50) {
    throw new HttpError(422, 'INVALID_LIMIT', 'Choose a page size from 1 to 50.');
  }
  return Number(value);
}
