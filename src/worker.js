// Worker service entry point. Runs the pipeline workers, Telegram connections, scheduler and task runner.
import './config.js';
import { config } from './config.js';
import { bootstrap, shutdownCommon, isTransient } from './boot.js';
import { Supervisor } from './workers/supervisor.js';
import { processorModule, keywordModule, aiModule, notificationModule, analyticsModule, telegramModule, cleanupModule, schedulerModule } from './workers/modules.js';
import { logger } from './lib/logger.js';

const log = logger('worker');

export function buildModules() {
  return [telegramModule(), processorModule(), keywordModule(), aiModule(), notificationModule(), analyticsModule(), cleanupModule(), schedulerModule()];
}
export async function startWorkers({ boot = true, only } = {}) {
  if (boot) await bootstrap('worker');
  const sup = new Supervisor(buildModules());
  await sup.start(only ?? (config.WORKER_ONLY ? config.WORKER_ONLY.split(',').map((s) => s.trim()).filter(Boolean) : undefined));
  return sup;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sup = await startWorkers();
  let closing = false;
  const down = async (sig) => {
    if (closing) return; closing = true; log.info(`received ${sig}, shutting down workers`);
    const t = setTimeout(() => process.exit(1), 20000); t.unref();
    await sup.stop(); await shutdownCommon(); process.exit(0);
  };
  process.on('SIGINT', () => void down('SIGINT')); process.on('SIGTERM', () => void down('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: e, transient: isTransient(e) }));
  process.on('uncaughtException', (e) => { if (isTransient(e)) return log.error('transient infrastructure error (service keeps running)', { err: e }); log.critical('uncaught exception', { err: e }); void down('uncaughtException'); });
}
