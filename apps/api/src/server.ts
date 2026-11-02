import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { stopListening } from './lib/events.js';
import { closeAllStreams } from './modules/events/events.routes.js';
import { startEmailWorker, stopEmailWorker } from './modules/email/outbox.js';
import { startSmsWorker, stopSmsWorker } from './modules/sms/outbox.js';
import { startEscalationWorker, stopEscalationWorker } from './modules/cover/escalation.js';
import { logger } from './lib/logger.js';

const app = createApp();
startEmailWorker();
startSmsWorker();
startEscalationWorker();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Pacient API listening');
});

/** Graceful shutdown: stop accepting connections, finish in-flight requests, close the pool. */
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  // Long-lived event streams would otherwise keep the server open; clients reconnect elsewhere.
  closeAllStreams();
  stopEmailWorker();
  stopSmsWorker();
  stopEscalationWorker();
  server.close(() => {
    stopListening()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled promise rejection');
  process.exit(1);
});
