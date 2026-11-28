import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/client.js';
import { workerRuns } from '../src/db/schema.js';
import { logger } from '../src/lib/logger.js';
import {
  errorClassOf,
  errorText,
  recordRun,
  registeredWorkers,
  registerWorker,
  storedErrorText,
  WORKER_NAMES,
  type WorkerName,
} from '../src/lib/worker-runs.js';

const DAY = 86_400_000;

async function lastRun(worker: WorkerName, since: Date) {
  const [row] = await db
    .select()
    .from(workerRuns)
    .where(and(eq(workerRuns.worker, worker), gte(workerRuns.startedAt, since)))
    .orderBy(desc(workerRuns.id))
    .limit(1);
  return row!;
}

describe('recordRun', () => {
  // First in this file on purpose: the first recorded run of a process prunes old runs.
  it('prunes runs older than 30 days, at most once a day', async () => {
    const [old, recent] = await db
      .insert(workerRuns)
      .values([
        { worker: 'registers', startedAt: new Date(Date.now() - 31 * DAY), ok: true },
        { worker: 'registers', startedAt: new Date(Date.now() - 29 * DAY), ok: true },
      ])
      .returning({ id: workerRuns.id });
    await recordRun('registers', async () => 0);
    const left = await db
      .select({ id: workerRuns.id })
      .from(workerRuns)
      .where(inArray(workerRuns.id, [old!.id, recent!.id]));
    expect(left.map((r) => r.id)).toEqual([recent!.id]);

    // The next run the same day does not prune again.
    const [another] = await db
      .insert(workerRuns)
      .values({ worker: 'registers', startedAt: new Date(Date.now() - 40 * DAY), ok: true })
      .returning({ id: workerRuns.id });
    await recordRun('registers', async () => 0);
    expect(await db.select().from(workerRuns).where(eq(workerRuns.id, another!.id))).toHaveLength(
      1,
    );
    await db.delete(workerRuns).where(eq(workerRuns.id, another!.id));
  });

  it('records a successful run with its counts only, and returns what the run returned', async () => {
    const since = new Date();
    const result = { sent: 3, skipped: 1, note: 'Dr. Example', ids: ['a', 'b'] };
    expect(await recordRun('licences', async () => result)).toBe(result);
    const row = await lastRun('licences', since);
    expect(row.ok).toBe(true);
    expect(row.summary).toEqual({ sent: 3, skipped: 1 });
    expect(row.error).toBeNull();
    expect(row.finishedAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());

    await recordRun('dialysis', async () => 7);
    expect((await lastRun('dialysis', since)).summary).toEqual({ count: 7 });
    await recordRun('downtime-packs', async () => ['x', 'y']);
    expect((await lastRun('downtime-packs', since)).summary).toEqual({ count: 2 });
    await recordRun('early-warning', async () => undefined);
    expect((await lastRun('early-warning', since)).summary).toBeNull();
  });

  it('never throws: a failed run is recorded with a short error without identifiers', async () => {
    const since = new Date();
    const failing = async (): Promise<number> => {
      throw new Error(`Could not send to someone@example.org about 1234567890 ${'x'.repeat(1000)}`);
    };
    await expect(recordRun('maternity', failing)).resolves.toBeUndefined();
    const row = await lastRun('maternity', since);
    expect(row.ok).toBe(false);
    expect(row.summary).toBeNull();
    expect(row.error!.length).toBeLessThanOrEqual(500);
    expect(row.error).toContain('Could not send to');
    expect(row.error).not.toContain('someone@example.org');
    expect(row.error).not.toContain('1234567890');

    await expect(
      recordRun('equipment', () => Promise.reject('plain text reason')),
    ).resolves.toBeUndefined();
    expect((await lastRun('equipment', since)).error).toBe('plain text reason');
  });

  it('records why a query failed, never its SQL or the values it was given (ops-1)', async () => {
    const since = new Date();
    const name = 'Arbenita Krasniqi';
    const logged = vi.spyOn(logger, 'error');
    try {
      // A patient's name as a parameter: PostgreSQL refuses it as a number and echoes it back.
      await recordRun('registers', () => db.execute(sql`SELECT ${name}::int AS n`));
      expect((await lastRun('registers', since)).error).toBe(
        'DatabaseError 22P02: invalid input syntax for type integer: "…"',
      );

      // A long statement: the cause is kept, not the first 500 characters of the SQL.
      const columns = Array.from({ length: 40 }, (_, i) => `'x' AS column_number_${i}`).join(', ');
      await recordRun('registers', () =>
        db.execute(sql`SELECT ${sql.raw(columns)}, 1 / 0 AS n WHERE ${name} <> ''`),
      );
      expect((await lastRun('registers', since)).error).toBe(
        'DatabaseError 22012: division by zero',
      );

      // A constraint names what failed; pg's detail ("Key (name)=(Arbenita Krasniqi) already
      // exists.") is left out.
      await recordRun('registers', () =>
        db.execute(
          sql`INSERT INTO ops_heartbeats (name, last_ok_at) VALUES (${name}, now()), (${name}, now())`,
        ),
      );
      const duplicate = (await lastRun('registers', since)).error!;
      expect(duplicate).toBe(
        'DatabaseError 23505: duplicate key value violates unique constraint "…" ' +
          '(constraint ops_heartbeats_pkey, table ops_heartbeats)',
      );
      expect(errorClassOf(duplicate)).toBe('DatabaseError 23505');

      // A missing value names its column; the row it was refused in is left out.
      await recordRun('registers', () =>
        db.execute(
          sql`INSERT INTO ops_heartbeats (name, last_ok_at) VALUES (${name}, now()), (NULL, now())`,
        ),
      );
      expect((await lastRun('registers', since)).error).toBe(
        'DatabaseError 23502: null value in column "…" of relation "…" violates not-null ' +
          'constraint (table ops_heartbeats, column name)',
      );

      // Neither the trail nor the API log has the name or the SQL.
      const runs = await db
        .select({ error: workerRuns.error })
        .from(workerRuns)
        .where(and(eq(workerRuns.worker, 'registers'), gte(workerRuns.startedAt, since)));
      const everything = JSON.stringify([runs, logged.mock.calls]);
      expect(logged).toHaveBeenCalledTimes(4);
      expect(everything).not.toContain('Arbenita');
      expect(everything).not.toMatch(/SELECT|INSERT INTO|params/);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps an error’s class and message, without quoted values or identifiers', () => {
    const id = '2b1c0a6e-3f0d-4c55-9a51-0d4f1c2e7b9a';
    expect(errorText(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(
      "TypeError: Cannot read properties of undefined (reading '…')",
    );
    expect(errorText(new Error(`Can't remind "Arben Krasniqi" about row ${id} (1234567890)`))).toBe(
      `Error: Can't remind "…" about row … (…)`,
    );
    expect(errorClassOf('TypeError: x')).toBe('TypeError');
    expect(errorClassOf('plain text reason')).toBeNull();

    // A system error keeps Node's code, which says what went wrong.
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(errorText(refused)).toBe('Error ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:5432');
    expect(errorClassOf(errorText(refused))).toBe('Error ECONNREFUSED');

    // A worker that wraps a failed query in its own error repeats the SQL and its values.
    expect(
      errorText(
        new Error(
          `Could not plan the sessions: Failed query: select $1::int\nparams: Arben Krasniqi,${id}`,
        ),
      ),
    ).toBe('Error: Could not plan the sessions: a database query failed');

    // Runs recorded before failed queries were unwrapped show only that a query failed.
    expect(storedErrorText(`Failed query: select $1::int AS n\nparams: Arben Krasniqi,${id}`)).toBe(
      'DrizzleQueryError: a database query failed (its cause was not recorded)',
    );
  });

  it('registers the workers started in this process with their interval', () => {
    expect(WORKER_NAMES).toContain('watchdog');
    expect(new Set(WORKER_NAMES).size).toBe(WORKER_NAMES.length);
    registerWorker('email', 5_000);
    registerWorker('retention', DAY);
    expect(registeredWorkers()).toEqual(
      expect.arrayContaining([
        { name: 'email', intervalMs: 5_000 },
        { name: 'retention', intervalMs: DAY },
      ]),
    );
  });
});
