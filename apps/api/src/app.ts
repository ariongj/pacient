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
import { consentRouter } from './modules/consent/consent.routes.js';
import { edRouter } from './modules/ed/ed.routes.js';
import { identityRouter } from './modules/identity/identity.routes.js';
import { imagingRouter } from './modules/imaging/imaging.routes.js';
import { inpatientRouter } from './modules/inpatient/inpatient.routes.js';
import { openApiHandler } from './openapi/index.js';
import { safetyRouter } from './modules/safety/safety.routes.js';
import { bloodBankRouter } from './modules/bloodbank/bloodbank.routes.js';
import { nutritionRouter } from './modules/nutrition/nutrition.routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { newsRouter } from './modules/news/news.routes.js';
import { surveillanceRouter } from './modules/surveillance/surveillance.routes.js';
import { telemedicineRouter } from './modules/telemedicine/telemedicine.routes.js';
import { downtimeRouter } from './modules/downtime/downtime.routes.js';
import { metricsHandler, monitoringRouter } from './modules/monitoring/monitoring.routes.js';
import { httpMetrics } from './lib/metrics.js';
import { privacyRouter } from './modules/privacy/privacy.routes.js';
import { schedulingRouter } from './modules/scheduling/scheduling.routes.js';
import { securityRouter } from './modules/security/security.routes.js';
import { vaccinationRouter } from './modules/vaccination/vaccination.routes.js';
import { stockRouter } from './modules/stock/stock.routes.js';
import { theatreRouter } from './modules/theatre/theatre.routes.js';
import { partnerRouter } from './modules/partner/partner.routes.js';
import { mergeRouter } from './modules/merge/merge.routes.js';
import { coverRouter } from './modules/cover/cover.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
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
import { phoneRouter } from './modules/sms/phone.routes.js';
import { integrationsAdminRouter } from './modules/integrations/admin.routes.js';
import { labApiRouter } from './modules/integrations/lab-api.routes.js';
import { labCatalogRouter, labOrdersRouter } from './modules/lab/orders.routes.js';
import { deathsRouter } from './modules/deaths/deaths.routes.js';
import { certificatesRouter } from './modules/certificates/certificates.routes.js';
import { waitingListRouter } from './modules/waiting/waiting.routes.js';
import { registersRouter } from './modules/registers/registers.routes.js';
import { incidentsRouter } from './modules/incidents/incidents.routes.js';
import { certificateVerifyRouter } from './modules/certificates/verify.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(httpMetrics);
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

  // Prometheus scrape endpoint (outside /api/v1; token or same-host only).
  app.get('/metrics', metricsHandler);

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
  api.use('/auth/me/phone', phoneRouter);
  api.use('/auth/security', securityRouter);
  api.use('/auth', authRouter);
  api.use('/facilities', facilitiesRouter);
  api.use('/staff', staffRouter);
  api.use('/patients/:id/guardians', guardiansRouter);
  api.use('/identity', identityRouter);
  api.use('/hospital', inpatientRouter);
  api.use('/ed', edRouter);
  api.use('/imaging', imagingRouter);
  api.use('/theatre', theatreRouter);
  api.use('/scheduling', schedulingRouter);
  api.use('/vaccination', vaccinationRouter);
  api.use('/downtime', downtimeRouter);
  api.use('/privacy', privacyRouter);
  api.use('/monitoring', monitoringRouter);
  api.use('/safety', safetyRouter);
  api.use('/blood-bank', bloodBankRouter);
  api.use('/nutrition', nutritionRouter);
  api.use('/billing', billingRouter);
  api.use('/early-warning', newsRouter);
  api.use('/surveillance', surveillanceRouter);
  api.use('/video', telemedicineRouter);
  api.use('/stock', stockRouter);
  api.use('/partner', partnerRouter);
  api.use('/deaths', deathsRouter);
  api.use('/certificates', certificatesRouter);
  api.use('/waiting-lists', waitingListRouter);
  api.use('/registers', registersRouter);
  api.use('/incidents', incidentsRouter);
  api.use('/verify/certificates', certificateVerifyRouter);
  api.get('/openapi.json', openApiHandler);
  api.use('/patients/:patientId/lab-orders', labOrdersRouter);
  api.use('/patients/:patientId/documents', documentsRouter);
  api.use('/patients/:patientId/consents', consentRouter);
  api.use('/patients/:patientId', clinicalRouter);
  api.use('/patients', patientsRouter);
  api.use('/appointments', appointmentsRouter);
  api.use('/portal', portalRouter);
  api.use('/stats', statsRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/worklist', worklistRouter);
  api.use('/cover', coverRouter);
  api.use('/patient-merges', mergeRouter);
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
  api.use('/lab-catalog', labCatalogRouter);
  // Machine-to-machine API for laboratory systems (API-key authenticated). Mounted before the staff
  // router so laboratory requests never reach staff authentication.
  api.use('/integrations/lab', labApiRouter);
  api.use('/integrations', integrationsAdminRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
