import { Logger, type ArgumentsHost } from '@nestjs/common';
import { DomainError, errors, z } from '@sportspark/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainExceptionFilter, toErrorResponse } from '../http/domain-exception.filter';

function internalZodError() {
  const result = z.object({ internalField: z.uuid() }).safeParse({ internalField: 'x' });
  if (result.success) throw new Error('expected a parse failure');
  return result.error;
}

function hostFor(response: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ correlationId: 'corr-filter-1' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('error contract for internal failures (§4.10)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('§4.10: a ZodError raised by server code is an internal error with no schema details, and it is logged', () => {
    const { status, body } = toErrorResponse(internalZodError(), 'corr-filter-1');
    expect(status).toBe(500);
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      correlationId: 'corr-filter-1',
      nextAction: 'retry_or_contact_support',
    });
    expect(JSON.stringify(body)).not.toContain('internalField');

    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    new DomainExceptionFilter().catch(internalZodError(), hostFor(response));
    expect(response.status).toHaveBeenCalledWith(500);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('corr-filter-1');
    expect(String(logged.mock.calls[0]?.[0])).toContain('internalField');
  });

  it('§4.10: request validation keeps answering VALIDATION_FAILED with the offending paths', () => {
    const { status, body } = toErrorResponse(
      errors.validation('Request validation failed.', [{ path: 'id', message: 'bad', code: 'x' }]),
      'corr-filter-2',
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED', nextAction: 'correct_input' });
  });

  it('R3-SECURITY-05 / §4.10: a raised INTERNAL_ERROR answers the generic message without its internal text, keeping only the operation reference; the operator log keeps the original', () => {
    const internal = errors.internal(
      'journal does not balance (debits 1500, credits 1400) for facility 0198f6c2-0000-7000-8000-000000000001',
    );
    const { status, body } = toErrorResponse(internal, 'corr-filter-3');
    expect(status).toBe(500);
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      correlationId: 'corr-filter-3',
      nextAction: 'retry_or_contact_support',
    });
    expect(JSON.stringify(body)).not.toContain('1500');

    const withOperation = new DomainError('INTERNAL_ERROR', 'handler tool finance.x is missing', {
      details: { operationId: '0198f6c2-0000-7000-8000-0000000000aa', handler: 'finance.x' },
    });
    expect(toErrorResponse(withOperation, 'corr-filter-4').body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      correlationId: 'corr-filter-4',
      nextAction: 'retry_or_contact_support',
      details: { operationId: '0198f6c2-0000-7000-8000-0000000000aa' },
    });

    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    new DomainExceptionFilter().catch(internal, hostFor(response));
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'An unexpected error occurred.' }),
    );
    expect(String(logged.mock.calls[0]?.[0])).toContain('debits 1500, credits 1400');
  });

  it('R3-SECURITY-03 / §4.10: body-parser refusals (413, 415, aborted) answer 400 VALIDATION_FAILED correct_input, logged at warn, not as unhandled 500s', () => {
    const httpError = (status: number, type: string, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error(type), { status, statusCode: status, expose: true, type, ...extra });
    const cases: Array<[Error, string]> = [
      [
        httpError(413, 'entity.too.large', { limit: 2_097_152, length: 3_000_000 }),
        'body_too_large',
      ],
      [httpError(415, 'charset.unsupported', { charset: 'latin1' }), 'unsupported_charset'],
      [httpError(415, 'encoding.unsupported'), 'unsupported_content_encoding'],
      [httpError(400, 'request.aborted'), 'body_incomplete'],
    ];
    for (const [error, code] of cases) {
      const { status, body } = toErrorResponse(error, 'corr-body');
      expect(status).toBe(400);
      expect(body).toMatchObject({
        code: 'VALIDATION_FAILED',
        nextAction: 'correct_input',
        details: { code },
      });
    }
    expect(toErrorResponse(cases[0]![0], 'corr-body').body.details).toEqual({
      code: 'body_too_large',
      limitBytes: 2_097_152,
    });
    // A 5xx stream fault, or an error that is not exposed, is still a server fault.
    expect(toErrorResponse(httpError(500, 'stream.not.readable'), 'c').body.code).toBe(
      'INTERNAL_ERROR',
    );
    expect(
      toErrorResponse(Object.assign(new Error('x'), { status: 413, type: 'entity.too.large' }), 'c')
        .body.code,
    ).toBe('INTERNAL_ERROR');

    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failed = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    new DomainExceptionFilter().catch(cases[0]![0], hostFor(response));
    expect(response.status).toHaveBeenCalledWith(400);
    expect(failed).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
