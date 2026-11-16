/**
 * The readers of an API error's `details` (src/api/error-details.ts), moved out of the teams kit
 * (ADR-008): the eligibility reasons of ELIGIBILITY_FAILED (SPK-READY-003), the field issues of
 * VALIDATION_FAILED and a refusal's rule code (CMP-13). They keep only what is well formed, so a
 * failure view never breaks on an unexpected body (SPK-UX-008).
 */
import { ApiError } from '@sportspark/api-client';
import { detailCodeOf, eligibilityReasonsOf, fieldIssuesOf } from '../error-details';

function refusal(code: string, details: unknown): ApiError {
  return new ApiError({
    kind: 'api',
    status: 422,
    code,
    message: 'Refused.',
    nextAction: 'review_and_correct',
    correlationId: null,
    details,
  });
}

describe('API error details (src/api/error-details.ts)', () => {
  it('SPK-READY-003: eligibility reasons are read with their severity, responsible role and action', () => {
    const error = refusal('ELIGIBILITY_FAILED', {
      reasons: [
        {
          code: 'age_band',
          severity: 'blocking',
          message: 'Too old for this division.',
          responsibleRole: 'captain',
          requiredAction: 'Choose another division.',
        },
        { code: 'approval_required', severity: 'loud', message: 'Needs league approval.' },
        { code: 42, message: 'Not a reason.' },
        'not an object',
        null,
      ],
    });
    expect(eligibilityReasonsOf(error)).toEqual([
      {
        code: 'age_band',
        severity: 'blocking',
        message: 'Too old for this division.',
        responsibleRole: 'captain',
        requiredAction: 'Choose another division.',
      },
      {
        code: 'approval_required',
        severity: 'unknown',
        message: 'Needs league approval.',
        responsibleRole: 'league_manager',
        requiredAction: '',
      },
    ]);
  });

  it('no reasons when the API sent none, or sent them in another shape', () => {
    expect(eligibilityReasonsOf(refusal('ELIGIBILITY_FAILED', undefined))).toEqual([]);
    expect(eligibilityReasonsOf(refusal('ELIGIBILITY_FAILED', { reasons: 'none' }))).toEqual([]);
    expect(eligibilityReasonsOf(refusal('ELIGIBILITY_FAILED', [{ code: 'x' }]))).toEqual([]);
  });

  it('VALIDATION_FAILED field issues read "path: message", or the message alone without a path', () => {
    const error = refusal('VALIDATION_FAILED', [
      { path: 'recipientContact.value', message: 'Not deliverable' },
      { path: '', message: 'Check the form.' },
      { path: 'x' },
      'text',
    ]);
    expect(fieldIssuesOf(error)).toEqual([
      'recipientContact.value: Not deliverable',
      'Check the form.',
    ]);
    expect(fieldIssuesOf(refusal('VALIDATION_FAILED', { code: 'ROLE_NOT_HELD' }))).toEqual([]);
  });

  it('CMP-13: the rule code of a refusal is read from details.code when it is an identifier', () => {
    expect(detailCodeOf(refusal('VALIDATION_FAILED', { code: 'CAPTAIN_MUST_BE_ADULT' }))).toBe(
      'CAPTAIN_MUST_BE_ADULT',
    );
    expect(detailCodeOf(refusal('VALIDATION_FAILED', { code: 'not a code!' }))).toBeNull();
    expect(detailCodeOf(refusal('VALIDATION_FAILED', { code: 'A'.repeat(65) }))).toBeNull();
    expect(detailCodeOf(refusal('VALIDATION_FAILED', [{ code: 'ROLE_NOT_HELD' }]))).toBeNull();
    expect(detailCodeOf(refusal('VALIDATION_FAILED', undefined))).toBeNull();
  });
});
