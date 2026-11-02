#!/usr/bin/env node
/**
 * One-time local setup for development: `npm run setup`, then `npm run dev`.
 *
 *  1. creates apps/api/.env with random secrets (if it does not exist)
 *  2. makes sure PostgreSQL is reachable – starts it with Docker (docker-compose.dev.yml) if not
 *  3. creates the test database, applies migrations and loads the synthetic demo data
 *
 * Safe to run again: existing .env and data are kept.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'apps', 'api');
const envFile = path.join(apiDir, '.env');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const step = (msg) => console.log(`\n\u001b[1m▸ ${msg}\u001b[0m`);

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Node.js 22 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}

if (!existsSync(path.join(root, 'node_modules'))) {
  step('Installing dependencies (npm install)');
  run('npm install');
}

step('Configuration (apps/api/.env)');
if (existsSync(envFile)) {
  console.log('Keeping the existing apps/api/.env');
} else {
  copyFileSync(path.join(apiDir, '.env.example'), envFile);
  const secret = () => randomBytes(48).toString('base64url');
  let env = readFileSync(envFile, 'utf8');
  env = env
    .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${secret()}`)
    .replace(/^MFA_ENCRYPTION_KEY=.*$/m, `MFA_ENCRYPTION_KEY=${secret()}`);
  writeFileSync(envFile, env);
  console.log('Created apps/api/.env with new random secrets');
}

const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    }),
);
const databaseUrl = env.DATABASE_URL;

const require = createRequire(path.join(apiDir, 'package.json'));
const pg = require('pg');

async function canConnect(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

step(`Database (${databaseUrl.replace(/:[^:@/]+@/, ':•••@')})`);
if (!(await canConnect(databaseUrl))) {
  let docker = false;
  try {
    execSync('docker info', { stdio: 'ignore' });
    docker = true;
  } catch {
    /* no docker */
  }
  if (!docker) {
    console.error(`
PostgreSQL is not reachable and Docker is not running.
Either start Docker Desktop and run \`npm run setup\` again, or install PostgreSQL 16 and run:
  createuser -P pacient          (password: pacient)
  createdb -O pacient pacient
  createdb -O pacient pacient_test`);
    process.exit(1);
  }
  console.log('Starting PostgreSQL and Mailpit with Docker (docker-compose.dev.yml)…');
  run('docker compose -f docker-compose.dev.yml up -d');
  const deadline = Date.now() + 90_000;
  while (!(await canConnect(databaseUrl))) {
    if (Date.now() > deadline) {
      console.error('PostgreSQL did not become ready in time.');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!env.SMTP_URL) {
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(/^SMTP_URL=.*$/m, 'SMTP_URL=smtp://localhost:1025'),
    );
    console.log('Emails go to Mailpit: http://localhost:8025');
  }
}
console.log('PostgreSQL is reachable');

// Test database for `npm test` (ignored if it exists or the role may not create databases).
try {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const { rowCount } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = 'pacient_test'",
  );
  if (!rowCount) await admin.query('CREATE DATABASE pacient_test');
  await admin.end();
} catch {
  console.log('(Could not create the pacient_test database – only needed for `npm test`.)');
}

step('Migrations');
run('npm run db:migrate');
step('Demo data');
run('npm run db:seed');

console.log(`
\u001b[1mReady.\u001b[0m Start the app with:

  npm run dev

then open http://localhost:5173 and sign in with one of the demo accounts
(password: Pacient-Demo-2026): patient@, doctor@, nurse@, pharmacist@, reception@,
director@ or minister@pacient.local.
`);
