import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDbAuthStore } from './auth/store.js';
import { provisionBankAccount } from './banking/provision.js';
import { loadConfig } from './config.js';
import { getPool, withTransaction } from './db/pool.js';
import { handlers } from './handlers.js';
import { createStaticFiles } from './static.js';

try {
  const config = loadConfig();
  const serveStatic = await createStaticFiles(fileURLToPath(new URL('../dist/', import.meta.url)));
  const authStore = createDbAuthStore({ query: (...args) => getPool().query(...args) });
  // B9: every new account gets its own Nessie sandbox checking account. Log
  // only a status code; provider errors can contain identifiers.
  const onSignup = (actor) => provisionBankAccount({ withTransaction }, actor.userId)
    .catch((error) => console.error(JSON.stringify({ event: 'BANK_PROVISION_FAILED', status: error.status ?? null })));
  const server = createApp({ config, handlers, serveStatic, authStore, onSignup, onError: (event) => console.error(JSON.stringify(event)) });
  server.on('error', (error) => {
    console.error(`API could not start (${error.code}). Check the configured host and port.`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log(`Split AI listening at ${config.origin}`));
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Frontend build missing. Run npm run build at the repository root.' : error.message);
  process.exitCode = 1;
}
