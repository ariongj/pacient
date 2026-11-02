import { and, eq, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { integrationMessages, labOrders, labResults, patients } from '../../db/schema.js';
import {
  buildAck,
  field,
  Hl7Error,
  parseHl7,
  parseHl7Date,
  type Hl7Message,
  type Hl7Segment,
} from '../../lib/hl7.js';
import { seal } from '../../lib/secret-box.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * ORU^R01 result ingestion (blueprint §4 "Diagnostics and critical results", §6 integration).
 *
 * Safety rules:
 *  - Results are filed automatically only when the placer order number (OBR-2) matches an order at
 *    this laboratory's facility AND the patient identity in PID (national ID + date of birth)
 *    matches that order's patient. Anything else waits in a review queue – never guessed.
 *  - Messages are idempotent by MSH-10: a resend is acknowledged without filing twice.
 *  - Corrected results (OBX-11 = C) never overwrite: the original is kept and linked to its
 *    replacement, and the new version must be acknowledged (and released) again.
 *  - Critical results alert the ordering doctor immediately (in-app, email and SMS by preference).
 */
export interface IngestClient {
  id: string;
  name: string;
  facilityId: string;
}

export interface IngestOutcome {
  ack: string;
  status: 'ACCEPTED' | 'REJECTED' | 'NEEDS_REVIEW' | 'DUPLICATE';
  messageId?: string;
  resultCount: number;
}

const FLAG: Record<string, 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL'> = {
  N: 'NORMAL',
  '': 'NORMAL',
  L: 'LOW',
  H: 'HIGH',
  LL: 'CRITICAL',
  HH: 'CRITICAL',
  AA: 'CRITICAL',
  A: 'HIGH',
  '<': 'LOW',
  '>': 'HIGH',
};
const STATUS: Record<string, 'PRELIMINARY' | 'FINAL' | 'CORRECTED'> = {
  P: 'PRELIMINARY',
  R: 'PRELIMINARY',
  S: 'PRELIMINARY',
  I: 'PRELIMINARY',
  F: 'FINAL',
  C: 'CORRECTED',
};

/** The message cannot be filed automatically and needs a person to decide. */
export class ReviewNeeded extends Error {}

interface ParsedObservation {
  code: string;
  name: string;
  value: string;
  unit: string | null;
  referenceRange: string | null;
  flag: 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL';
  status: 'PRELIMINARY' | 'FINAL' | 'CORRECTED';
  observedAt: Date;
}

function parseObservations(msg: Hl7Message, obr: Hl7Segment): ParsedObservation[] {
  const collected = parseHl7Date(field(obr, 7)) ?? new Date();
  return msg
    .all('OBX')
    .filter((obx) => field(obx, 11) !== 'X' && field(obx, 11) !== 'D') // cannot be obtained / deleted
    .map((obx) => {
      const code = field(obx, 3, 1);
      const value = field(obx, 5);
      if (!code || !value) throw new Hl7Error('OBX without a test code or value');
      return {
        code,
        name: field(obx, 3, 2) || code,
        value: value.slice(0, 100),
        unit: field(obx, 6, 1) || null,
        referenceRange: field(obx, 7) || null,
        flag: FLAG[field(obx, 8).toUpperCase()] ?? 'HIGH',
        status: STATUS[field(obx, 11).toUpperCase()] ?? 'FINAL',
        observedAt: parseHl7Date(field(obx, 14)) ?? collected,
      };
    });
}

/** Files observations for a matched order. Returns the number filed and whether any is critical. */
async function fileResults(
  tx: Executor,
  order: typeof labOrders.$inferSelect,
  observations: ParsedObservation[],
) {
  let critical = false;
  let corrected = false;
  for (const o of observations) {
    const [current] = await tx
      .select()
      .from(labResults)
      .where(
        and(
          eq(labResults.orderId, order.id),
          eq(labResults.testCode, o.code),
          isNull(labResults.supersededById),
        ),
      );
    const [created] = await tx
      .insert(labResults)
      .values({
        patientId: order.patientId,
        encounterId: order.encounterId,
        orderedById: order.orderedById,
        orderId: order.id,
        testCode: o.code,
        testName: o.name,
        value: o.value,
        unit: o.unit,
        referenceRange: o.referenceRange,
        flag: o.flag,
        status:
          current && o.status === 'FINAL' && current.status !== 'PRELIMINARY'
            ? 'CORRECTED'
            : o.status,
        collectedAt: o.observedAt,
        source: 'LIS',
      })
      .returning({ id: labResults.id });
    if (current) {
      // A newer version (final after preliminary, or a correction) replaces the current one.
      await tx
        .update(labResults)
        .set({ supersededById: created!.id, supersededAt: new Date() })
        .where(eq(labResults.id, current.id));
      if (o.status === 'CORRECTED' || current.status !== 'PRELIMINARY') corrected = true;
    }
    if (o.flag === 'CRITICAL') critical = true;
  }
  const anyPreliminary = observations.some((o) => o.status === 'PRELIMINARY');
  await tx
    .update(labOrders)
    .set({
      status: anyPreliminary ? 'IN_PROGRESS' : 'RESULTED',
      resultedAt: anyPreliminary ? null : new Date(),
      receivedAt: order.receivedAt ?? new Date(),
    })
    .where(eq(labOrders.id, order.id));
  return { critical, corrected };
}

async function alertDoctor(
  tx: Executor,
  order: typeof labOrders.$inferSelect,
  critical: boolean,
  corrected: boolean,
) {
  const link = `/doctor/patients/${order.patientId}`;
  if (critical) {
    await notifyUsers(
      [order.orderedById],
      { type: 'result', title: 'CRITICAL laboratory result – review now', link, important: true },
      tx,
    );
  } else if (corrected) {
    await notifyUsers(
      [order.orderedById],
      {
        type: 'result',
        title: 'A laboratory result was corrected – review again',
        link,
        important: true,
      },
      tx,
    );
  } else {
    await notifyUsers(
      [order.orderedById],
      { type: 'result', title: 'New laboratory results to review', link },
      tx,
    );
  }
}

/** Matches PID to the order's patient. Throws ReviewNeeded on any doubt. */
async function matchOrder(
  tx: Executor,
  client: IngestClient,
  msg: Hl7Message,
  obr: Hl7Segment,
  forcedPatientId?: string,
) {
  const placer = field(obr, 2, 1) || field(msg.get('ORC'), 2, 1);
  if (!placer) throw new ReviewNeeded('No placer order number (OBR-2): unsolicited result');
  const [order] = await tx
    .select()
    .from(labOrders)
    .where(
      and(eq(labOrders.placerOrderNumber, placer), eq(labOrders.facilityId, client.facilityId)),
    );
  if (!order) throw new ReviewNeeded(`Unknown order ${placer} for this laboratory`);
  if (order.status === 'CANCELLED') throw new ReviewNeeded(`Order ${placer} was cancelled`);
  const [patient] = await tx.select().from(patients).where(eq(patients.id, order.patientId));
  if (forcedPatientId) {
    if (forcedPatientId !== order.patientId)
      throw new ReviewNeeded('The selected patient does not own this order');
    return { order, patient: patient! };
  }
  const pid = msg.get('PID');
  const ids = (pid?.fields[3] ?? '').split('~').map((rep) => rep.split('^')[0]?.trim());
  const dob = field(pid, 7).slice(0, 8);
  if (!ids.includes(patient!.nationalId))
    throw new ReviewNeeded('Patient identifier in PID-3 does not match the order');
  if (dob !== patient!.dateOfBirth.replace(/-/g, ''))
    throw new ReviewNeeded('Date of birth in PID-7 does not match the order');
  return { order, patient: patient! };
}

export async function ingestOru(client: IngestClient, raw: string): Promise<IngestOutcome> {
  const ackId = `ACK${Date.now()}`;
  let msg: Hl7Message;
  try {
    msg = parseHl7(raw);
  } catch (err) {
    return {
      ack: buildAck(null, 'AR', (err as Error).message, ackId),
      status: 'REJECTED',
      resultCount: 0,
    };
  }
  const controlId = field(msg.get('MSH'), 10);
  const type = `${field(msg.get('MSH'), 9, 1)}^${field(msg.get('MSH'), 9, 2)}`;
  if (!controlId)
    return {
      ack: buildAck(msg, 'AR', 'MSH-10 control id is required', ackId),
      status: 'REJECTED',
      resultCount: 0,
    };

  const [previous] = await db
    .select()
    .from(integrationMessages)
    .where(
      and(
        eq(integrationMessages.clientId, client.id),
        eq(integrationMessages.direction, 'INBOUND'),
        eq(integrationMessages.controlId, controlId),
      ),
    );
  if (previous) {
    return {
      ack: buildAck(
        msg,
        previous.status === 'REJECTED' ? 'AR' : 'AA',
        'Duplicate message – already processed',
        ackId,
      ),
      status: 'DUPLICATE',
      messageId: previous.id,
      resultCount: 0,
    };
  }

  const record = async (
    status: 'ACCEPTED' | 'REJECTED' | 'NEEDS_REVIEW',
    extra: Partial<typeof integrationMessages.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(integrationMessages)
      .values({
        clientId: client.id,
        direction: 'INBOUND',
        messageType: type.slice(0, 20),
        controlId,
        status,
        rawSealed: seal(raw),
        ...extra,
      })
      .onConflictDoNothing()
      .returning({ id: integrationMessages.id });
    return row?.id;
  };

  if (type !== 'ORU^R01') {
    const id = await record('REJECTED', { error: `Unsupported message type ${type}` });
    return {
      ack: buildAck(msg, 'AR', `Unsupported message type ${type}`, ackId),
      status: 'REJECTED',
      messageId: id,
      resultCount: 0,
    };
  }
  const obr = msg.get('OBR');
  if (!obr) {
    const id = await record('REJECTED', { error: 'OBR segment missing' });
    return {
      ack: buildAck(msg, 'AR', 'OBR segment missing', ackId),
      status: 'REJECTED',
      messageId: id,
      resultCount: 0,
    };
  }

  let observations: ParsedObservation[];
  try {
    observations = parseObservations(msg, obr);
    if (!observations.length) throw new Hl7Error('No observations (OBX) to file');
  } catch (err) {
    const id = await record('REJECTED', { error: (err as Error).message });
    return {
      ack: buildAck(msg, 'AE', (err as Error).message, ackId),
      status: 'REJECTED',
      messageId: id,
      resultCount: 0,
    };
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      const { order } = await matchOrder(tx, client, msg, obr);
      const { critical, corrected } = await fileResults(tx, order, observations);
      const [row] = await tx
        .insert(integrationMessages)
        .values({
          clientId: client.id,
          direction: 'INBOUND',
          messageType: type,
          controlId,
          status: 'ACCEPTED',
          rawSealed: seal(raw),
          patientId: order.patientId,
          orderId: order.id,
          resultCount: observations.length,
        })
        .returning({ id: integrationMessages.id });
      await audit(
        {
          action: AuditAction.LAB_RESULTS_RECEIVED,
          actor: null,
          resourceType: 'lab_order',
          resourceId: order.id,
          patientId: order.patientId,
          metadata: {
            laboratory: client.name,
            results: observations.length,
            critical,
            corrected,
            controlId,
          },
        },
        tx,
      );
      await alertDoctor(tx, order, critical, corrected);
      return row!.id;
    });
    return {
      ack: buildAck(msg, 'AA', `Filed ${observations.length} result(s)`, ackId),
      status: 'ACCEPTED',
      messageId: outcome,
      resultCount: observations.length,
    };
  } catch (err) {
    if (err instanceof ReviewNeeded) {
      const id = await record('NEEDS_REVIEW', { error: err.message });
      // Accepted for manual review: the laboratory must not resend.
      return {
        ack: buildAck(msg, 'AA', 'Held for manual review', ackId),
        status: 'NEEDS_REVIEW',
        messageId: id,
        resultCount: 0,
      };
    }
    throw err;
  }
}

/**
 * Files a message from the review queue after a person has confirmed the match. The patient
 * selected by the reviewer must own the order named in the message.
 */
export async function fileReviewedMessage(
  client: IngestClient,
  raw: string,
  messageId: string,
  patientId: string,
) {
  const msg = parseHl7(raw);
  const obr = msg.get('OBR');
  if (!obr) throw new Hl7Error('OBR segment missing');
  const observations = parseObservations(msg, obr);
  return db.transaction(async (tx) => {
    const { order } = await matchOrder(tx, client, msg, obr, patientId);
    const { critical, corrected } = await fileResults(tx, order, observations);
    await tx
      .update(integrationMessages)
      .set({ patientId: order.patientId, orderId: order.id, resultCount: observations.length })
      .where(eq(integrationMessages.id, messageId));
    await alertDoctor(tx, order, critical, corrected);
    return { order, resultCount: observations.length };
  });
}
