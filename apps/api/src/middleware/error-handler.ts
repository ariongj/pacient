import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

/** Postgres error codes we translate to client errors instead of leaking a 500. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Body-parser errors (malformed JSON / payload too large).
  const status = (err as { status?: number })?.status;
  if (status === 400 || status === 413) {
    res.status(status).json({
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: status === 413 ? 'Request body too large' : 'Malformed request body',
      },
    });
    return;
  }

  switch (pgCode(err)) {
    case PG_UNIQUE_VIOLATION:
      res.status(409).json({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
      return;
    case PG_FOREIGN_KEY_VIOLATION:
      res
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'Referenced resource does not exist' } });
      return;
    case PG_CHECK_VIOLATION:
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Value out of range' } });
      return;
  }

  logger.error({ err, requestId: req.requestId }, 'Unhandled error');
  // Never leak stack traces or internals to clients.
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.requestId },
  });
};
