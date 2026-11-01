import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Recreate the test schema from migrations once per run, so tests exercise real migrations. */
export default async function setup() {
  const url =
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://pacient:pacient@localhost:5432/pacient_test';
  if (!/test/.test(url)) throw new Error(`Refusing to reset a non-test database: ${url}`);
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;');
  await pool.query('CREATE SCHEMA public');
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
  await migrate(drizzle(pool), { migrationsFolder });
  await pool.end();
}
