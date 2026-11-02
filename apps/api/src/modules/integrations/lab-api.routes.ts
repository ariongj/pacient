import { randomUUID } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  facilities,
  integrationClients,
  integrationMessages,
  labOrders,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { buildOrm } from '../../lib/hl7.js';
import { parse } from '../../lib/http.js';
import { hashToken } from '../../lib/tokens.js';
import { ingestOru, type IngestClient } from '../lab/ingest.js';

/**
 * API for laboratory information systems (LIS), authenticated with a per-system API key
 * (`Authorization: Bearer pk_…`). Pull model: the LIS fetches new orders, so no inbound
 * connectivity into the laboratory network is needed, and posts results as HL7 v2 ORU^R01.
 */
declare module 'express-serve-static-core' {
  interface Request {
    integrationClient?: IngestClient;
  }
}

const authenticateClient: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer pk_')) throw unauthorized('Integration API key required');
  const [client] = await db
    .select({
      id: integrationClients.id,
      name: integrationClients.name,
      facilityId: integrationClients.facilityId,
    })
    .from(integrationClients)
    .where(
      and(
        eq(integrationClients.apiKeyHash, hashToken(header.slice(7).trim())),
        eq(integrationClients.isActive, true),
      ),
    );
  if (!client) throw unauthorized('Invalid or revoked API key');
  await db
    .update(integrationClients)
    .set({ lastSeenAt: new Date() })
    .where(eq(integrationClients.id, client.id));
  req.integrationClient = client;
  next();
};

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => req.get('authorization')?.slice(0, 20) ?? req.ip ?? 'anon',
});

const hl7Body = express.text({
  type: ['application/hl7-v2', 'x-application/hl7-v2+er7', 'text/plain'],
  limit: '1mb',
});

export const labApiRouter = Router();
labApiRouter.use(limiter, authenticateClient);

/** New orders for this laboratory's facility, oldest first. ?format=hl7 returns ORM^O01 messages. */
labApiRouter.get('/orders', async (req, res) => {
  const client = req.integrationClient!;
  const { format } = parse(
    z.object({ format: z.enum(['json', 'hl7']).default('json') }),
    req.query,
  );
  const rows = await db
    .select({
      id: labOrders.id,
      placerOrderNumber: labOrders.placerOrderNumber,
      testCode: labOrders.testCode,
      testName: labOrders.testName,
      specimen: labOrders.specimen,
      priority: labOrders.priority,
      clinicalNotes: labOrders.clinicalNotes,
      createdAt: labOrders.createdAt,
      nationalId: patients.nationalId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      doctorId: users.id,
      doctorName: users.fullName,
      doctorLicense: users.licenseNumber,
      facilityCode: facilities.code,
    })
    .from(labOrders)
    .innerJoin(patients, eq(patients.id, labOrders.patientId))
    .innerJoin(users, eq(users.id, labOrders.orderedById))
    .innerJoin(facilities, eq(facilities.id, labOrders.facilityId))
    .where(
      and(
        eq(labOrders.facilityId, client.facilityId),
        eq(labOrders.status, 'ORDERED'),
        isNull(labOrders.labClientId),
      ),
    )
    .orderBy(asc(labOrders.createdAt))
    .limit(100);
  if (format === 'hl7') {
    const messages = rows.map((r) =>
      buildOrm(
        {
          placerOrderNumber: r.placerOrderNumber,
          testCode: r.testCode,
          testName: r.testName,
          priority: r.priority,
          specimen: r.specimen,
          clinicalNotes: r.clinicalNotes,
          createdAt: r.createdAt,
          orderingDoctor: { id: r.doctorId, name: r.doctorName, licenseNumber: r.doctorLicense },
          patient: {
            nationalId: r.nationalId,
            firstName: r.firstName,
            lastName: r.lastName,
            dateOfBirth: r.dateOfBirth,
            sex: r.sex,
          },
          facilityCode: r.facilityCode,
        },
        `ORM${randomUUID().slice(0, 8)}`,
      ),
    );
    res.type('application/hl7-v2').send(messages.join('\r\r'));
    return;
  }
  res.json({
    items: rows.map((r) => ({
      placerOrderNumber: r.placerOrderNumber,
      test: { code: r.testCode, name: r.testName, system: 'http://loinc.org' },
      specimen: r.specimen,
      priority: r.priority,
      clinicalNotes: r.clinicalNotes,
      orderedAt: r.createdAt,
      orderingDoctor: { name: r.doctorName, licenseNumber: r.doctorLicense },
      patient: {
        nationalId: r.nationalId,
        firstName: r.firstName,
        lastName: r.lastName,
        dateOfBirth: r.dateOfBirth,
        sex: r.sex,
      },
    })),
  });
});

/** The laboratory confirms it has taken the order (and may give its own filler order number). */
labApiRouter.post('/orders/:placer/receive', async (req, res) => {
  const client = req.integrationClient!;
  const { placer } = parse(z.object({ placer: z.string().min(3).max(30) }), req.params);
  const { fillerOrderNumber } = parse(
    z.object({ fillerOrderNumber: z.string().trim().max(60).optional() }),
    req.body ?? {},
  );
  const [order] = await db
    .select()
    .from(labOrders)
    .where(
      and(eq(labOrders.placerOrderNumber, placer), eq(labOrders.facilityId, client.facilityId)),
    );
  if (!order) throw notFound('Order not found');
  if (order.status === 'CANCELLED') throw conflict('Order was cancelled');
  if (order.labClientId && order.labClientId !== client.id)
    throw conflict('Order taken by another laboratory');
  const [updated] = await db
    .update(labOrders)
    .set({
      status: order.status === 'ORDERED' ? 'RECEIVED' : order.status,
      labClientId: client.id,
      receivedAt: order.receivedAt ?? new Date(),
      fillerOrderNumber: fillerOrderNumber ?? order.fillerOrderNumber,
    })
    .where(eq(labOrders.id, order.id))
    .returning({ placerOrderNumber: labOrders.placerOrderNumber, status: labOrders.status });
  res.json(updated);
});

/** HL7 v2 ORU^R01 results. Always answers with an HL7 ACK (AA / AE / AR). */
labApiRouter.post('/results', hl7Body, async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    throw badRequest('Send the HL7 message as the request body (Content-Type: application/hl7-v2)');
  }
  const outcome = await ingestOru(req.integrationClient!, req.body);
  res
    .status(outcome.status === 'REJECTED' ? 422 : 200)
    .type('application/hl7-v2')
    .set('X-Pacient-Status', outcome.status)
    .send(outcome.ack);
});

/** Lightweight connectivity check for the laboratory's interface engine. */
labApiRouter.get('/ping', async (req, res) => {
  const [{ pending } = { pending: 0 }] = await db
    .select({
      pending: db.$count(
        integrationMessages,
        eq(integrationMessages.clientId, req.integrationClient!.id),
      ),
    })
    .from(integrationClients)
    .where(eq(integrationClients.id, req.integrationClient!.id));
  res.json({ ok: true, laboratory: req.integrationClient!.name, messages: pending });
});
