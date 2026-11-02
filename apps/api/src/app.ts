import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { logger } from './lib/logger.js';
import { forbidden } from './lib/errors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { clinicalRouter } from './modules/clinical/clinical.routes.js';
import { facilitiesRouter } from './modules/facilities/facilities.routes.js';
import { patientsRouter } from './modules/patients/patients.routes.js';
import { portalRouter } from './modules/portal/portal.routes.js';
import { staffRouter } from './modules/staff/staff.routes.js';
import { statsRouter } from './modules/stats/stats.routes.js';
import { worklistRouter } from './modules/worklist/worklist.routes.js';
import { announcementsRouter } from './modules/announcements/announcements.routes.js';
import { emergencyRouter } from './modules/emergency/emergency.routes.js';
import { messagingRouter } from './modules/messaging/messaging.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { referralsRouter } from './modules/referrals/referrals.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { careTasksRouter } from './modules/care-tasks/care-tasks.routes.js';
import { pharmacyRouter } from './modules/pharmacy/pharmacy.routes.js';
import { channelsRouter } from './modules/channels/channels.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { fhirRouter } from './modules/fhir/fhir.routes.js';
import { directoryRouter } from './modules/directory/directory.routes.js';
import { guardiansRouter } from './modules/guardians/guardians.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? '',
      // Log the route, never query strings (they can contain search terms such as names).
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    // SameSite cookies protect against other sites, not sibling subdomains.
    // Reject unapproved browser origins before any state-changing handler runs.
    (req, _res, next) => {
      const origin = req.headers.origin;
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        origin !== undefined &&
        !env.CORS_ORIGINS.includes(origin)
      ) {
        next(forbidden('Request origin is not allowed'));
        return;
      }
      next();
    },
  );
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Acting-For'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // Health records must never be stored by browsers or intermediary caches.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', authRouter);
  api.use('/facilities', facilitiesRouter);
  api.use('/staff', staffRouter);
  api.use('/patients/:id/guardians', guardiansRouter);
  api.use('/patients/:patientId', clinicalRouter);
  api.use('/patients', patientsRouter);
  api.use('/appointments', appointmentsRouter);
  api.use('/portal', portalRouter);
  api.use('/stats', statsRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/worklist', worklistRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/messages', messagingRouter);
  api.use('/referrals', referralsRouter);
  api.use('/emergency-access', emergencyRouter);
  api.use('/announcements', announcementsRouter);
  api.use('/reports', reportsRouter);
  api.use('/pharmacy', pharmacyRouter);
  api.use('/care-tasks', careTasksRouter);
  api.use('/channels', channelsRouter);
  api.use('/events', eventsRouter);
  api.use('/fhir', fhirRouter);
  api.use('/directory', directoryRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
