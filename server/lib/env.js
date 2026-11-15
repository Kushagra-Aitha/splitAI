import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Loads server/.env when present. Real environment variables win, so a
// deployment can set values without a file.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Fill it in server/.env (see server/.env.example).`);
  }
  return value;
}

export function optionalEnv(name) {
  return process.env[name]?.trim() || null;
}
