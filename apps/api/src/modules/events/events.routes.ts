import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { subscribe } from '../../lib/events.js';
import { parse, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * Server-Sent Events. Browsers cannot attach an Authorization header to EventSource, so the client
 * first exchanges its access token for a single-use ticket (valid 30 s) and opens the stream with
 * it. Tickets never appear in logs (request logging records the path only).
 */
const tickets = new Map<string, { userId: string; expires: number }>();
const openStreams = new Set<import('express').Response>();

/** Ends every open stream (used during graceful shutdown). */
export function closeAllStreams() {
  for (const res of openStreams) res.end();
  openStreams.clear();
}
const TICKET_TTL_MS = 30_000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}

export const eventsRouter = Router();

eventsRouter.post('/ticket', authenticate, (req, res) => {
  const ctx = requireAuth(req);
  sweep();
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { userId: ctx.userId, expires: Date.now() + TICKET_TTL_MS });
  res.json({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
});

eventsRouter.get('/', async (req, res) => {
  const { ticket } = parse(z.object({ ticket: z.string().min(20).max(100) }), req.query);
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expires < Date.now()) throw unauthorized('Invalid or expired event ticket');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx) so events are delivered immediately.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  const unsubscribe = await subscribe(entry.userId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  openStreams.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    openStreams.delete(res);
  });
});
