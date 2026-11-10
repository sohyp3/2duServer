import { createApp } from './app';
import { loadConfig } from './config';
import { MAX_BODY } from './security';

process.umask(0o077);
const config = loadConfig();
const app = createApp(config.databasePath, config);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: MAX_BODY,
  idleTimeout: 120,
  fetch: (request, server) =>
    app.fetch(request, server.requestIP(request)?.address ?? 'unknown'),
  error: () => Response.json({ error: 'Server error' }, { status: 500 }),
});
console.log(`2duServer listening on ${server.url}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  await server.stop();
  app.db.close();
  clearTimeout(timeout);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
