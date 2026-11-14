import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createStaticFiles } from './static.js';

try {
  const config = loadConfig();
  const serveStatic = await createStaticFiles(fileURLToPath(new URL('../dist/', import.meta.url)));
  const server = createApp({ config, serveStatic, onError: (event) => console.error(JSON.stringify(event)) });
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
