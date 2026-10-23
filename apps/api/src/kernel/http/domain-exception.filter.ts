import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError, newId, type ErrorCode, type ErrorResponseBody } from '@sportspark/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';
import type { RequestWithContext } from './request-context';

function mapHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'AUTHENTICATION_REQUIRED';
    case 403:
      return 'ACCESS_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'RESOURCE_CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'INTEGRATION_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * Maps every error to the stable error contract (§4.10). Unexpected errors are logged with the
 * correlation id and returned without internal details.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();
    const correlationId = request.correlationId ?? newId();

    let status: number;
    let body: ErrorResponseBody;

    if (DomainError.is(exception)) {
      status = exception.httpStatus;
      body = exception.toResponseBody(correlationId);
      if (status >= 500) {
        this.logger.error(
          `[${correlationId}] ${exception.code}: ${exception.message}`,
          exception.stack,
        );
      }
    } else if (exception instanceof ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        correlationId,
        nextAction: 'correct_input',
        details: exception.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = mapHttpStatus(status);
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : typeof raw === 'object' && raw !== null && 'message' in raw
            ? String((raw as { message: unknown }).message)
            : exception.message;
      body = { code, message, correlationId, nextAction: 'see_code' };
      if (status >= 500) this.logger.error(`[${correlationId}] ${message}`, exception.stack);
    } else {
      status = 500;
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${correlationId}] unhandled: ${err.message}`, err.stack);
      body = {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        correlationId,
        nextAction: 'retry_or_contact_support',
      };
    }

    response.status(status).json(body);
  }
}
