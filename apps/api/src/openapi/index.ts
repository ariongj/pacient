import type { RequestHandler } from 'express';
import { openApiDocument } from './spec.js';

/** GET /api/v1/openapi.json – public API description (contains no data). */
export const openApiHandler: RequestHandler = (req, res) => {
  res.json(openApiDocument(`${req.protocol}://${req.get('host')}/api/v1`));
};
