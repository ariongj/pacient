import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { workerRuns } from '../src/db/schema.js';
import {
  recordRun,
  registeredWorkers,
  registerWorker,
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
