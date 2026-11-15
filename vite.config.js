import { defineConfig } from 'vite';

const apiPort = Number(process.env.SPLIT_API_PORT || 3001);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error('SPLIT_API_PORT must be an integer between 1 and 65535.');
}
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Browser requests remain same-origin. Origin is forwarded unchanged so
    // the API can validate it against APP_ORIGIN, including during development.
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
    },
  },
});
