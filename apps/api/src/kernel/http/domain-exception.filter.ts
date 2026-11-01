import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type ErrorCode,
  type ErrorResponseBody,
} from '@sportspark/contracts';
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

/** The answer to every unexpected error: no internal detail reaches the client (§4.10). */
export const UNEXPECTED_ERROR_MESSAGE = 'An unexpected error occurred.';

/**
 * The client-side fault the HTTP body parser raised before any route ran, or null
 * (R3-SECURITY-02, R3-SECURITY-03, §4.10). Body-parser errors are `http-errors` with a 4xx
 * `status`, `expose: true` and a `type` (`entity.too.large`, `charset.unsupported`,
 * `encoding.unsupported`, `request.aborted`, ...). They are neither DomainError nor HttpException,
 * so without this they answered 500 INTERNAL_ERROR / retry_or_contact_support: a client was told to
 * retry a body that can never succeed (the staff offline queue then kept such a batch forever) and
 * every refusal was logged as an unhandled fault. A malformed JSON body is a `SyntaxError` the
 * framework already turns into a 400.
 */
export function requestBodyFault(exception: unknown): DomainError | null {
  if (DomainError.is(exception) || exception instanceof HttpException) return null;
  if (typeof exception !== 'object' || exception === null) return null;
  const fault = exception as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    type?: unknown;
    limit?: unknown;
  };
  const status = typeof fault.status === 'number' ? fault.status : fault.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499) return null;
  if (fault.expose !== true || typeof fault.type !== 'string') return null;
  switch (fault.type) {
    case 'entity.too.large':
    case 'parameters.too.many':
      return errors.validation('The request body is larger than this service accepts.', {
        code: 'body_too_large',
        ...(typeof fault.limit === 'number' ? { limitBytes: fault.limit } : {}),
      });
    case 'charset.unsupported':
      return errors.validation('The request body must be JSON encoded as UTF-8.', {
        code: 'unsupported_charset',
      });
    case 'encoding.unsupported':
      return errors.validation(
        'The request body uses a content encoding this service does not accept.',
        {
          code: 'unsupported_content_encoding',
        },
      );
    case 'request.aborted':
    case 'request.size.invalid':
      return errors.validation('The request body was not received completely.', {
        code: 'body_incomplete',
      });
    default:
      return errors.validation('The request body could not be read.', { code: 'body_unreadable' });
  }
}

/**
 * The status and body the stable error contract (§4.10) gives `exception`. Unexpected errors carry
 * no internal details. Shared by the filter and by the idempotency interceptor, which stores the
 * same body for replay.
 *
 * Request input is validated by `ZodValidationPipe`, which raises a `VALIDATION_FAILED` DomainError.
 * A raw `ZodError` reaching this point therefore comes from server code (an outbox payload, stored
 * data parsed back): it is a server fault, answered as INTERNAL_ERROR without the internal schema
 * paths, never as input the client should correct.
 *
 * R3-SECURITY-05: a raised INTERNAL_ERROR (`errors.internal(...)`) is a broken invariant whose
 * message is written for the operator (ids, ledger sums, work items): the client gets the generic
 * message, and of its details only the operation reference (`details.operationId`, §4.9) that tells
 * it where the real outcome is recorded. The filter logs the original message.
 */
export function toErrorResponse(
  exception: unknown,
  correlationId: string,
): { status: number; body: ErrorResponseBody } {
  if (DomainError.is(exception)) {
    if (exception.code === 'INTERNAL_ERROR') {
      const operationId = operationIdOf(exception.details);
      const body: ErrorResponseBody = {
        code: 'INTERNAL_ERROR',
        message: UNEXPECTED_ERROR_MESSAGE,
        correlationId,
        nextAction: exception.nextAction,
      };
      if (operationId) body.details = { operationId };
      return { status: exception.httpStatus, body };
    }
    return { status: exception.httpStatus, body: exception.toResponseBody(correlationId) };
  }
  const bodyFault = requestBodyFault(exception);
  if (bodyFault) {
    return { status: bodyFault.httpStatus, body: bodyFault.toResponseBody(correlationId) };
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
      message: UNEXPECTED_ERROR_MESSAGE,
      correlationId,
      nextAction: 'retry_or_contact_support',
    },
  };
}

/** The operation reference an INTERNAL_ERROR may carry (`details.operationId`), or null. */
function operationIdOf(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const operationId = (details as { operationId?: unknown }).operationId;
  return typeof operationId === 'string' ? operationId : null;
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
        // K-10: a raised 5xx outcome (INTEGRATION_UNAVAILABLE: a provider or recovery pause) is an
        // expected domain answer, logged at warn; an INTERNAL_ERROR is a fault, logged at error.
        if (exception.code === 'INTERNAL_ERROR') {
          this.logger.error(
            `[${correlationId}] ${exception.code}: ${exception.message}`,
            exception.stack,
          );
        } else {
          this.logger.warn(`[${correlationId}] ${exception.code}: ${exception.message}`);
        }
      }
    } else if (requestBodyFault(exception)) {
      // R3-SECURITY-03: a client fault refused before any route ran (anonymous callers can send
      // these), noted at warn without a stack, never an unhandled error.
      const fault = exception as { type?: unknown; status?: unknown };
      this.logger.warn(
        `[${correlationId}] request body refused: ${String(fault.type)} (${String(fault.status)})`,
      );
    } else if (exception instanceof HttpException) {
      if (status >= 500) this.logger.error(`[${correlationId}] ${body.message}`, exception.stack);
    } else if (exception instanceof ZodError) {
      // §4.10: an internal parse failure is logged with its issues for the operator, never returned.
      this.logger.error(
        `[${correlationId}] unhandled validation failure in server code: ${JSON.stringify(exception.issues)}`,
        exception.stack,
      );
    } else {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${correlationId}] unhandled: ${err.message}`, err.stack);
    }

    response.status(status).json(body);
  }
}
