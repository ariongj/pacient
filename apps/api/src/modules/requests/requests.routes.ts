import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';

/**
 * Requests to the operator of the service (operator_requests and their messages): billing,
 * accounts, technical problems, data protection, security incidents. Never about a patient:
 * subjects and messages that contain a 10-digit number are refused. Round 2, builder G (owns the
 * whole modules/requests folder).
 *
 * `operatorRequestsRouter` is mounted on /operator-requests for the directors and IT support of a
 * facility (their own facility's requests only):
 *   GET /operator-requests, POST /operator-requests, GET /operator-requests/:id,
 *   POST /operator-requests/:id/messages
 *
 * `adminRequestsRouter` is mounted on /admin/requests (authenticated, ADMIN only): the inbox with
 * filters (status, category, facility) and counts, answers and status changes.
 */
export const operatorRequestsRouter = Router();
operatorRequestsRouter.use(authenticate, requireRole('DIRECTOR', 'IT_SUPPORT'));

export const adminRequestsRouter = Router();
