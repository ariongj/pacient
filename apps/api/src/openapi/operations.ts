import { int, obj, op, type ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: test e-mail, e-mail failures, operator alerts and heartbeats of outside jobs (/admin/platform, /ops).
 * Round 2, builder S2: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const OPERATIONS_TAGS = [
  {
    name: 'Operations',
    description:
      'E-mail deliverability, operator alerts and heartbeats of jobs that run outside the API (backups). No message contents and no patient data.',
  },
];

const T = 'Operations';
const ADMIN = 'ADMIN (platform administrator); never clinical data';

export const OPERATIONS_OPERATIONS: ModuleOperation[] = [
  op('post', '/admin/platform/test-email', T, 'Send a test e-mail to my own address', {
    access: ADMIN,
    description:
      'Queues one message to the address of the signed-in administrator (never to another address), audited as platform.test_email_sent. At most one per administrator per minute (429). `deliveryConfigured` is false when the server has no SMTP_URL and keeps e-mail in its outbox.',
    responses: { '202': 'Queued', '429': 'A test e-mail was queued less than a minute ago' },
  }),
  op('get', '/admin/platform/email-failures', T, 'Recent e-mail delivery failures', {
    access: ADMIN,
    description:
      'The last 50 outbox messages that were given up or are being retried after a failure: masked recipient (a***@domain), template, attempts, the mail server’s error (addresses in it masked) and dates, with the number given up in the last 24 hours. Never the subject or the body.',
  }),
  op('get', '/admin/platform/alerts', T, 'Open operator alerts', {
    access: ADMIN,
    description:
      'Conditions raised by the watchdog and the subscription worker (a stalled background job, failing or late e-mail and SMS, no recent backup, incomplete billing settings), critical first. Condition keys, counts and times only.',
  }),
  op('post', '/ops/heartbeat/backup', T, 'Report a successful backup', {
    auth: 'none',
    access: 'Bearer OPS_HEARTBEAT_TOKEN (deploy/backup.sh); 404 while the token is not configured',
    description:
      'Records the time of the last successful backup, with its size and duration only, and resolves the "no recent backup" alert. The token is compared in constant time.',
    body: obj({
      sizeBytes: int({ minimum: 0 }),
      durationSeconds: { type: 'number', minimum: 0, maximum: 604800 },
    }),
    responses: { '401': 'Wrong token', '404': 'Heartbeats are switched off' },
  }),
];
