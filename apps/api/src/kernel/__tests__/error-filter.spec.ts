import { Logger, type ArgumentsHost } from '@nestjs/common';
import { errors, z } from '@sportspark/contracts';
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
});
