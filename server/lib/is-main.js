import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when the module at metaUrl is the script Node was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
