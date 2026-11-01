import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema, casing: 'snake_case' });

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle or the root db – services accept either so they compose in transactions. */
export type Executor = Parameters<Parameters<Database['transaction']>[0]>[0] | Database;
