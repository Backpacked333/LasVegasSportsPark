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
 * The status and body the stable error contract (§4.10) gives `exception`. Unexpected errors carry
 * no internal details. Shared by the filter and by the idempotency interceptor, which stores the
 * same body for replay.
 */
export function toErrorResponse(
  exception: unknown,
  correlationId: string,
): { status: number; body: ErrorResponseBody } {
  if (DomainError.is(exception)) {
    return { status: exception.httpStatus, body: exception.toResponseBody(correlationId) };
  }
  if (exception instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        correlationId,
        nextAction: 'correct_input',
        details: exception.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const message =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null && 'message' in raw
          ? String((raw as { message: unknown }).message)
          : exception.message;
    return {
      status,
      body: { code: mapHttpStatus(status), message, correlationId, nextAction: 'see_code' },
    };
  }
  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      correlationId,
      nextAction: 'retry_or_contact_support',
    },
  };
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

    const { status, body } = toErrorResponse(exception, correlationId);
    if (DomainError.is(exception)) {
      if (status >= 500) {
        this.logger.error(
          `[${correlationId}] ${exception.code}: ${exception.message}`,
          exception.stack,
        );
      }
    } else if (exception instanceof HttpException) {
      if (status >= 500) this.logger.error(`[${correlationId}] ${body.message}`, exception.stack);
    } else if (!(exception instanceof ZodError)) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${correlationId}] unhandled: ${err.message}`, err.stack);
    }

    response.status(status).json(body);
  }
}
