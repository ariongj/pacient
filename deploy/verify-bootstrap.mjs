import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const database = new URL(process.env.DATABASE_URL);
assert.equal(database.pathname, '/pacient_test', 'Only the isolated test database is allowed');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'isolated-bootstrap-test-secret-at-least-32-characters';
process.env.WEB_APP_URL = 'https://pacienti.example.test';
const { bootstrapAdmin } = await import('../apps/api/dist/ops/bootstrap-admin.js');
const { runMigrations } = await import('../apps/api/dist/db/migrate.js');
const { pool } = await import('../apps/api/dist/db/client.js');
const { hashToken } = await import('../apps/api/dist/lib/tokens.js');
try {
  await runMigrations();
  const directory = await mkdtemp(path.join(tmpdir(), 'pacienti-bootstrap-'));
  const output = path.join(directory, 'activation');
  await bootstrapAdmin('administrator@example.test', output);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const url = new URL((await readFile(output, 'utf8')).trim());
  assert.equal(url.origin, process.env.WEB_APP_URL);
  assert.equal(url.pathname, '/activate');
  const account = (await pool.query('SELECT role, password_hash, email FROM users')).rows;
  assert.equal(account.length, 1);
  assert.equal(account[0].role, 'MINISTRY');
  assert.equal(account[0].password_hash, null);
  assert.equal(account[0].email, 'administrator@example.test');
  const tokens = (await pool.query('SELECT token_hash, used_at FROM one_time_tokens')).rows;
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].token_hash, hashToken(url.searchParams.get('token')));
  assert.equal(tokens[0].used_at, null);
  await assert.rejects(() => bootstrapAdmin('second@example.test', path.join(directory, 'second')));
  await assert.rejects(() => bootstrapAdmin('third@example.test', output));
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n, '1');
  assert.equal(
    (await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action='user.invited'")).rows[0]
      .n,
    '1',
  );
  console.log(
    'First-admin bootstrap verified: private invitation, no default password, audited, repeat-safe.',
  );
} finally {
  await pool.end();
}
