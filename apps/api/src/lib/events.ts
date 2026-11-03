import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
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
  type:
    | 'notification'
    | 'channel.message'
    | 'message'
    /** Bed board / admissions changed at the facility. */
    | 'hospital.board'
    /** Emergency department board changed at the facility. */
    | 'ed.board'
    /** Radiology worklist changed at the facility. */
    | 'imaging.worklist';
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

/**
 * Router middleware for shared operational boards: after any successful write (non-GET, 2xx)
 * tells the facility's staff in the given roles to refresh. Only the event type travels – the
 * boards re-fetch through the normal, authorised API.
 */
export function publishBoardChanges(type: LiveEvent['type'], roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        const facilityId = req.auth?.facilityId;
        if (res.statusCode >= 300 || !facilityId) return;
        void (async () => {
          const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM users
            WHERE facility_id = ${facilityId} AND is_active AND role::text IN ${sql.raw(
              `(${roles.map((r) => `'${r.replace(/[^A-Z_]/g, '')}'`).join(',')})`,
            )}`);
          await publish(
            rows.rows.map((r) => r.id),
            { type },
          );
        })().catch((err: unknown) => logger.warn({ err }, 'Board update could not be published'));
      });
    }
    next();
  };
}
