import { createApp } from './app.mjs';
import path from 'node:path';
import { createLogger, errorDetails } from './diagnostics.mjs';

const dataDir = process.env.DATA_DIR || path.resolve('var');
const log = createLogger(dataDir);
process.on('uncaughtExceptionMonitor', error => log('fatal_exception', errorDetails(error)));
process.on('unhandledRejection', error => { log('fatal_rejection', errorDetails(error)); process.exit(1); });
if ((process.env.APP_MODE || 'demo') === 'live' && !process.env.GATEWAY_SECRET) throw new Error('GATEWAY_SECRET is required in live mode');
const app = await createApp({ dataDir, logger: log });
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
app.server.listen(port, host, () => log('service_started', { host, port }));
let pollErrors = 0;
const workerTimer = setInterval(() => {
  Promise.resolve().then(() => app.processNext()).then(() => { pollErrors = 0; }).catch(error => {
    log('worker_poll_failed', errorDetails(error));
    if (++pollErrors >= 3) process.exit(1);
  });
}, 250);
let cleaning = false;
const maintenanceTimer = setInterval(async () => {
  if (cleaning) return;
  cleaning = true;
  try { const removed = await app.maintenance(); if (removed) log('unused_photos_cleaned', { removed }); }
  catch (error) { log('maintenance_failed', errorDetails(error)); }
  finally { cleaning = false; }
}, 600_000);
const metricsTimer = setInterval(() => log('resource_sample', { rssBytes: process.memoryUsage().rss, activeJobs: app.worker.running.size, stalled: app.worker.isStalled() }), 60_000);
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log('service_stopping', { signal });
  clearInterval(workerTimer); clearInterval(maintenanceTimer); clearInterval(metricsTimer);
  const deadline = setTimeout(() => { log('shutdown_timeout'); process.exit(1); }, 20_000);
  deadline.unref();
  await app.close();
  log('service_stopped');
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
