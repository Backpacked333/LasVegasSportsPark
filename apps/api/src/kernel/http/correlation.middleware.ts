import { CORRELATION_ID_HEADER, newId } from '@sportspark/contracts';
import type { NextFunction, Request, Response } from 'express';
import type { RequestWithContext } from './request-context';

const SAFE_CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

/** Attaches a correlation id to every request and echoes it on the response (§4.10). */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const correlationId = candidate && SAFE_CORRELATION.test(candidate) ? candidate : newId();
  (req as RequestWithContext).correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}
