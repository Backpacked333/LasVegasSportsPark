import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { RequestWithContext } from './request-context';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * One access line per answered request (§5.11 observability): method, path with identifiers
 * replaced by `:id` and no query string (which can carry search terms about people, §4.14),
 * status, duration and correlation id. Bodies and headers are never logged.
 */
export function requestLogMiddleware(logger: Pick<Logger, 'log'> = new Logger('HttpAccess')) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const path = (req.originalUrl ?? req.url).split('?')[0]?.replace(UUID, ':id') ?? '';
      logger.log({
        message: 'request',
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        correlationId: (req as RequestWithContext).correlationId,
      });
    });
    next();
  };
}
