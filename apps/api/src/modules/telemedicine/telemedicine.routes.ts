import { Router } from 'express';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { appointments, patients, users, videoSessions } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { iceServersFor } from './ice.js';
import {
  firstJoin,
  firstWaitingNotice,
  isPresent,
  markLeft,
  markPresent,
  other,
  participants,
  pushSignal,
  takeSignals,
  type Side,
} from './signals.js';

/**
 * Video visits: a secure 1:1 WebRTC call between the doctor and the patient (or a guardian acting
 * for a child). Media flows directly between the two devices (or through a TURN relay); Pacient
 * only relays the small signalling messages and records who joined and when. Calls are never
 * recorded.
 */
export const JOIN_OPENS_BEFORE_MS = 15 * 60_000;
export const JOIN_CLOSES_AFTER_MS = 2 * 3_600_000;
const MAX_PAYLOAD_CHARS = 20_000;

const IdParam = z.object({ id: z.string().uuid() });
const SignalSchema = z.object({
  kind: z.enum(['ready', 'offer', 'answer', 'candidate', 'bye']),
  payload: z.unknown().optional(),
});
const SignalsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

type Appointment = typeof appointments.$inferSelect;

/** Which side of the call the caller is on, or null if they are not a participant. */
function sideOf(ctx: AuthContext, appt: Appointment): Side | null {
  if (ctx.role === 'DOCTOR' && appt.doctorId === ctx.userId) return 'doctor';
  // Patients – and guardians acting for a child (X-Acting-For sets ctx.patientId).
  if (ctx.role === 'PATIENT' && ctx.patientId === appt.patientId) return 'patient';
  return null;
}

async function loadAppointment(ctx: AuthContext, appointmentId: string) {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt) throw notFound('Appointment not found');
  const side = sideOf(ctx, appt);
  if (!side) throw forbidden('Only the doctor and the patient of this appointment can join');
  return { appt, side };
}

async function loadSession(ctx: AuthContext, sessionId: string) {
  const [row] = await db
    .select({ session: videoSessions, appt: appointments })
    .from(videoSessions)
    .innerJoin(appointments, eq(appointments.id, videoSessions.appointmentId))
    .where(eq(videoSessions.id, sessionId));
  if (!row) throw notFound('Video visit not found');
  const side = sideOf(ctx, row.appt);
  if (!side) throw forbidden('Only the doctor and the patient of this appointment can join');
  return { ...row, side };
}

export function joinWindow(appt: Pick<Appointment, 'scheduledAt'>) {
  const opensAt = new Date(appt.scheduledAt.getTime() - JOIN_OPENS_BEFORE_MS);
  const closesAt = new Date(appt.scheduledAt.getTime() + JOIN_CLOSES_AFTER_MS);
  const now = Date.now();
  return { opensAt, closesAt, open: now >= opensAt.getTime() && now <= closesAt.getTime() };
}

/** Users to wake up on the other side of the call. */
function recipients(appt: Appointment, sessionId: string, toSide: Side): string[] {
  return toSide === 'doctor' ? [appt.doctorId] : participants(sessionId, 'patient');
}

export const telemedicineRouter = Router();
telemedicineRouter.use(authenticate, requireRole('DOCTOR', 'PATIENT'));

/** What the video page needs before joining: who, when, whether the room is open. */
telemedicineRouter.get('/appointments/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { appt, side } = await loadAppointment(ctx, id);
  const [names] = await db
    .select({
      doctorName: users.fullName,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
    })
    .from(appointments)
    .innerJoin(users, eq(users.id, appointments.doctorId))
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(eq(appointments.id, id));
  const [session] = await db
    .select({ id: videoSessions.id, status: videoSessions.status })
    .from(videoSessions)
    .where(eq(videoSessions.appointmentId, id));
  const window = joinWindow(appt);
  res.json({
    appointment: {
      id: appt.id,
      scheduledAt: appt.scheduledAt,
      durationMinutes: appt.durationMinutes,
      mode: appt.mode,
      status: appt.status,
      doctorName: names?.doctorName ?? '',
      patientName: names?.patientName ?? '',
      patientId: side === 'doctor' ? appt.patientId : undefined,
    },
    side,
    window,
    session: session ?? null,
  });
});

telemedicineRouter.post('/appointments/:id/join', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { appt, side } = await loadAppointment(ctx, id);
  if (appt.mode !== 'VIDEO') throw badRequest('This appointment is not a video visit');
  if (appt.status !== 'CONFIRMED' && appt.status !== 'CHECKED_IN') {
    throw conflict('Only confirmed appointments can be joined');
  }
  const window = joinWindow(appt);
  if (!window.open) {
    throw new HttpError(
      409,
      Date.now() < window.opensAt.getTime() ? 'TOO_EARLY' : 'TOO_LATE',
      Date.now() < window.opensAt.getTime()
        ? 'The video visit opens 15 minutes before the appointment'
        : 'The time for this video visit has passed',
      { opensAt: window.opensAt, closesAt: window.closesAt },
    );
  }

  const now = new Date();
  const session = await db.transaction(async (tx) => {
    await tx.insert(videoSessions).values({ appointmentId: id }).onConflictDoNothing();
    const [s] = await tx
      .select()
      .from(videoSessions)
      .where(eq(videoSessions.appointmentId, id))
      .for('update');
    if (s!.status === 'ENDED') throw conflict('This video visit has ended');
    const doctorJoinedAt = s!.doctorJoinedAt ?? (side === 'doctor' ? now : null);
    const patientJoinedAt = s!.patientJoinedAt ?? (side === 'patient' ? now : null);
    const bothJoined = Boolean(doctorJoinedAt && patientJoinedAt);
    const [updated] = await tx
      .update(videoSessions)
      .set({
        doctorJoinedAt,
        patientJoinedAt,
        status: bothJoined ? 'ACTIVE' : s!.status,
        startedAt: s!.startedAt ?? (bothJoined ? now : null),
      })
      .where(eq(videoSessions.id, s!.id))
      .returning();
    if (firstJoin(s!.id, ctx.userId)) {
      await audit(
        {
          action: AuditAction.VIDEO_VISIT_JOINED,
          actor: ctx,
          resourceType: 'video_session',
          resourceId: s!.id,
          patientId: appt.patientId,
          meta: requestMeta(req),
          metadata: {
            appointmentId: id,
            side,
            ...(ctx.proxy ? { guardianshipId: ctx.proxy.guardianshipId } : {}),
          },
        },
        tx,
      );
    }
    return updated!;
  });

  const peerSide = other(side);
  const peerPresent = isPresent(session.id, peerSide);
  markPresent(session.id, side, ctx.userId);
  await publish(recipients(appt, session.id, peerSide), { type: 'video.signal', ref: session.id });
  if (side === 'patient' && !peerPresent && firstWaitingNotice(session.id)) {
    // Generic: no reason or other health information.
    await notifyUsers([appt.doctorId], {
      type: 'appointment',
      title: 'A patient is waiting for the video visit at {time}',
      vars: { time: appt.scheduledAt },
      link: `/video/${appt.id}`,
    });
  }
  res.json({
    sessionId: session.id,
    role: side,
    status: session.status,
    peerPresent,
    iceServers: iceServersFor(ctx.userId),
  });
});

telemedicineRouter.post('/sessions/:id/signal', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(SignalSchema, req.body);
  if (input.payload !== undefined && JSON.stringify(input.payload).length > MAX_PAYLOAD_CHARS) {
    throw badRequest('Signalling message too large');
  }
  const { session, appt, side } = await loadSession(ctx, id);
  if (session.status === 'ENDED') throw conflict('This video visit has ended');
  markPresent(id, side, ctx.userId);
  const msg = pushSignal(id, side, input.kind, input.payload ?? null);
  await publish(recipients(appt, id, other(side)), { type: 'video.signal', ref: id });
  res.status(202).json({ id: msg.id });
});

telemedicineRouter.get('/sessions/:id/signals', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { after } = parse(SignalsQuery, req.query);
  const { session, side } = await loadSession(ctx, id);
  if (session.status !== 'ENDED') markPresent(id, side, ctx.userId);
  res.json({
    items: takeSignals(id, side, after),
    status: session.status,
    peerPresent: isPresent(id, other(side)),
  });
});

telemedicineRouter.post('/sessions/:id/end', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { session, appt, side } = await loadSession(ctx, id);
  if (session.status !== 'ENDED') {
    await db.transaction(async (tx) => {
      await tx
        .update(videoSessions)
        .set({ status: 'ENDED', endedAt: new Date() })
        .where(eq(videoSessions.id, id));
      await audit(
        {
          action: AuditAction.VIDEO_VISIT_ENDED,
          actor: ctx,
          resourceType: 'video_session',
          resourceId: id,
          patientId: appt.patientId,
          meta: requestMeta(req),
          metadata: { appointmentId: appt.id, side },
        },
        tx,
      );
    });
    pushSignal(id, side, 'bye', null);
    await publish(recipients(appt, id, other(side)), { type: 'video.signal', ref: id });
  }
  markLeft(id, side);
  res.json({
    status: 'ENDED',
    // The doctor goes on to document the visit in the chart.
    chartPath: side === 'doctor' ? `/doctor/patients/${appt.patientId}?tab=visits` : undefined,
  });
});

/** Doctor: today's video visits where the patient is in the waiting room. */
telemedicineRouter.get('/waiting', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const now = Date.now();
  const rows = await db
    .select({
      sessionId: videoSessions.id,
      appointmentId: appointments.id,
      scheduledAt: appointments.scheduledAt,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      patientJoinedAt: videoSessions.patientJoinedAt,
      status: videoSessions.status,
    })
    .from(videoSessions)
    .innerJoin(appointments, eq(appointments.id, videoSessions.appointmentId))
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(
        eq(appointments.doctorId, ctx.userId),
        isNotNull(videoSessions.patientJoinedAt),
        gte(appointments.scheduledAt, new Date(now - JOIN_CLOSES_AFTER_MS)),
        lte(appointments.scheduledAt, new Date(now + JOIN_OPENS_BEFORE_MS)),
      ),
    );
  res.json({
    items: rows
      .filter((r) => r.status !== 'ENDED' && isPresent(r.sessionId, 'patient', now))
      .map((r) => ({ ...r, doctorPresent: isPresent(r.sessionId, 'doctor', now) })),
  });
});
