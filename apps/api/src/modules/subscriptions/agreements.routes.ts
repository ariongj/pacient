import { Router } from 'express';

/**
 * The service agreement and the data processing agreement, accepted once per facility by a
 * director (organization_acceptances). Nothing is ever blocked by a missing acceptance. Round 2,
 * builder G.
 *
 * `agreementsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET  /subscription/agreements
 *   POST /subscription/agreements/:documentId/accept – signer name and title as typed; audited
 *        legal.organization_accepted in the same transaction.
 *
 * `agreementsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET /admin/organizations/:facilityId/agreements – acceptances of one facility.
 *   GET /admin/agreements/missing – facilities without the current agreements (AdminHome).
 */
export const agreementsDirectorRouter = Router();
export const agreementsAdminRouter = Router();
