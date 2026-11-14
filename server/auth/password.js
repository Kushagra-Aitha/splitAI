// B8 · Password hashing with Node's built-in scrypt (no new dependency).
// Stored format: scrypt$N$r$p$<salt base64>$<key base64>, so parameters can be
// raised later without breaking existing hashes.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 256;

// Unicode-equivalent spellings of the same password hash identically.
const normalize = (password) => password.normalize('NFC');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(normalize(password), salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * True only when `password` matches `stored`. A missing or malformed hash
 * (unknown email, user without a password) still costs one full scrypt run,
 * so response time does not reveal whether an account exists.
 */
export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  const [kind, n, r, p, salt, hash] = parts;
  if (parts.length !== 6 || kind !== 'scrypt' || Number(n) !== N || Number(r) !== R || Number(p) !== P) {
    await hashPassword(password);
    return false;
  }
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(normalize(password), Buffer.from(salt, 'base64'), expected.length || KEY_BYTES,
    { N, r: R, p: P, maxmem: MAX_MEMORY });
  return expected.length === KEY_BYTES && timingSafeEqual(key, expected);
}
