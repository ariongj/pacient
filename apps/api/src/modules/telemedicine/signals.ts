/**
 * In-process WebRTC signalling store. Offers, answers and ICE candidates are tiny, short-lived
 * messages between the two participants of a video visit; they never touch the database.
 *
 * Delivery: a sender pushes a message for the other side and Pacient publishes a 'video.signal'
 * live event carrying only the session id (NOTIFY payloads must stay small). The receiver then
 * fetches its pending messages through the API and acknowledges them with `after`.
 *
 * Limitation: this store lives in one API process. Running several API instances behind a load
 * balancer requires sticky sessions for /api/v1/video or a shared store (e.g. Redis) – documented
 * in docs/ARCHITECTURE.md.
 */
export type SignalKind = 'ready' | 'offer' | 'answer' | 'candidate' | 'bye';
export type Side = 'doctor' | 'patient';

export interface SignalMessage {
  id: number;
  from: Side;
  kind: SignalKind;
  payload: unknown;
  at: number;
}

interface SessionState {
  queues: Record<Side, SignalMessage[]>;
  /** Users who joined on each side (the patient side may be the patient or a guardian). */
  users: Record<Side, Set<string>>;
  lastSeen: Record<Side, number>;
  left: Record<Side, boolean>;
  waitingNotified: boolean;
  joinAudited: Set<string>;
  touchedAt: number;
}

const MESSAGE_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 4 * 3_600_000;
/** A participant counts as present if they polled or signalled within this window. */
export const PRESENCE_WINDOW_MS = 30_000;
const MAX_QUEUE = 500;

const sessions = new Map<string, SessionState>();
let seq = 0;

function state(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      queues: { doctor: [], patient: [] },
      users: { doctor: new Set(), patient: new Set() },
      lastSeen: { doctor: 0, patient: 0 },
      left: { doctor: false, patient: false },
      waitingNotified: false,
      joinAudited: new Set(),
      touchedAt: Date.now(),
    };
    sessions.set(sessionId, s);
  }
  s.touchedAt = Date.now();
  return s;
}

function sweep(now = Date.now()) {
  for (const [id, s] of sessions) {
    if (now - s.touchedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      continue;
    }
    for (const side of ['doctor', 'patient'] as const) {
      s.queues[side] = s.queues[side].filter((m) => now - m.at < MESSAGE_TTL_MS);
    }
  }
}

export const other = (side: Side): Side => (side === 'doctor' ? 'patient' : 'doctor');

export function markPresent(sessionId: string, side: Side, userId: string) {
  const s = state(sessionId);
  s.users[side].add(userId);
  s.lastSeen[side] = Date.now();
  s.left[side] = false;
}

export function markLeft(sessionId: string, side: Side) {
  const s = state(sessionId);
  s.left[side] = true;
  s.lastSeen[side] = 0;
}

export function isPresent(sessionId: string, side: Side, now = Date.now()): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.left[side]) return false;
  return now - s.lastSeen[side] < PRESENCE_WINDOW_MS;
}

export function participants(sessionId: string, side: Side): string[] {
  return [...(sessions.get(sessionId)?.users[side] ?? [])];
}

/** Returns true only the first time it is called for this session (patient-waiting alert). */
export function firstWaitingNotice(sessionId: string): boolean {
  const s = state(sessionId);
  if (s.waitingNotified) return false;
  s.waitingNotified = true;
  return true;
}

/** True the first time a given user joins a session (audit once per user and session). */
export function firstJoin(sessionId: string, userId: string): boolean {
  const s = state(sessionId);
  if (s.joinAudited.has(userId)) return false;
  s.joinAudited.add(userId);
  return true;
}

export function pushSignal(
  sessionId: string,
  from: Side,
  kind: SignalKind,
  payload: unknown,
): SignalMessage {
  sweep();
  const s = state(sessionId);
  const msg: SignalMessage = { id: ++seq, from, kind, payload, at: Date.now() };
  const q = s.queues[other(from)];
  q.push(msg);
  if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
  return msg;
}

/**
 * Messages waiting for `side`. Messages up to and including `after` are acknowledged and dropped,
 * so a client that passes the last id it processed never receives a message twice.
 */
export function takeSignals(sessionId: string, side: Side, after = 0): SignalMessage[] {
  sweep();
  const s = state(sessionId);
  s.queues[side] = s.queues[side].filter((m) => m.id > after);
  return s.queues[side].slice();
}

export function clearSession(sessionId: string) {
  sessions.delete(sessionId);
}

/** Test helper. */
export function resetSignalsForTests() {
  sessions.clear();
}
