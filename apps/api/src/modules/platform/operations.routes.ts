import { Router } from 'express';

/**
 * Operations for the operator of the service: e-mail deliverability, alerts and the heartbeat of
 * jobs that run outside the API. Round 2, builder S2. (Worker status is part of the existing
 * GET /monitoring/health.)
 *
 * `operationsAdminRouter` is mounted on /admin/platform (authenticated, ADMIN only):
 *   POST /admin/platform/test-email – one message to the caller's own address, 1 per minute,
 *        audited platform.test_email_sent.
 *   GET  /admin/platform/email-failures – the last 50 failed or retrying outbox rows: masked
 *        recipient (a***@domain), template, attempts, last error, dates; never subject or body.
 *   GET  /admin/platform/alerts – open operator alerts (AdminHome).
 *
 * `opsRouter` is mounted on /ops without user authentication:
 *   POST /ops/heartbeat/backup – with the OPS_HEARTBEAT_TOKEN from the environment (constant-time
 *        comparison), called by deploy/backup.sh after a successful backup.
 */
export const operationsAdminRouter = Router();
export const opsRouter = Router();
