import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { env } from '../config/env.js';
import { db, type Executor } from '../db/client.js';
import { logger } from './logger.js';

/**
 * Real-time events (notifications, channel messages) delivered over Server-Sent Events.
 *
 * Events are published with PostgreSQL NOTIFY: when published inside a transaction they are only
 * delivered after it commits, and every API instance listening on the channel receives them, so
 * horizontal scaling needs no extra infrastructure. Payloads carry identifiers only – clients
 * re-fetch the data through the normal, authorised API.
 */
export interface LiveEvent {
  type: 'notification' | 'channel.message' | 'message';
  /** Optional resource id, e.g. the channel that received a message. */
  ref?: string;
}

const CHANNEL = 'pacient_events';
const bus = new EventEmitter();
bus.setMaxListeners(0);

export async function publish(userIds: string[], event: LiveEvent, executor: Executor = db) {
  const ids = [...new Set(userIds)];
  // NOTIFY payloads are limited to 8000 bytes; chunk large audiences.
  for (let i = 0; i < ids.length; i += 150) {
    const payload = JSON.stringify({ u: ids.slice(i, i + 150), e: event });
    await executor.execute(sql`SELECT pg_notify(${CHANNEL}, ${payload})`);
  }
}

let listener: pg.Client | null = null;
let starting: Promise<void> | null = null;

/** Starts the single LISTEN connection for this process on first use. */
async function ensureListening() {
  if (listener) return;
  starting ??= (async () => {
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    client.on('notification', (msg) => {
      try {
        const { u, e } = JSON.parse(msg.payload ?? '{}') as { u: string[]; e: LiveEvent };
        for (const userId of u) bus.emit(userId, e);
      } catch (err) {
        logger.warn({ err }, 'Malformed live event');
      }
    });
    client.on('error', (err) => {
      logger.error({ err }, 'Live event listener failed; will reconnect on next subscription');
      listener = null;
      starting = null;
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function subscribe(userId: string, handler: (e: LiveEvent) => void) {
  await ensureListening();
  bus.on(userId, handler);
  return () => bus.off(userId, handler);
}

export async function stopListening() {
  await listener?.end().catch(() => undefined);
  listener = null;
}
