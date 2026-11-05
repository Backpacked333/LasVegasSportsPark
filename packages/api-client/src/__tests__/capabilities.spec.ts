/**
 * Turned-off capabilities (§1.6, K-12, DEC-016, DEC-072 to DEC-082): an ACCESS_DENIED answer with
 * `details.code: 'CAPABILITY_DISABLED'` is presented as "turned off" by both apps (SPK-UX-008,
 * SPK-UX-010), never as a restriction of the principal or a failure.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PRESENTATION,
  isCapabilityDisabledError,
  isCapabilityId,
  turnedOffFor,
  turnedOffFromError,
  turnedOffLabel,
  turnedOffMessage,
} from '../capabilities';
import { ApiError, networkError } from '../errors';
import { presentationForError, recoveryActionFor } from '../screen-state';

function accessDenied(details?: unknown): ApiError {
  return new ApiError({
    kind: 'api',
    status: 403,
    code: 'ACCESS_DENIED',
    message: 'This organization has not enabled rentals.',
    nextAction: 'contact_support_or_request_access',
    correlationId: 'corr-1',
    details,
  });
}

describe('CAPABILITY_DISABLED presentation (K-12, DEC-016)', () => {
  it('maps ACCESS_DENIED with details.code CAPABILITY_DISABLED to "turned_off", not "unavailable"', () => {
    const error = accessDenied({
      code: 'CAPABILITY_DISABLED',
      capability: 'rentals',
      applicabilityReferences: ['DEC-016', 'DEC-076'],
    });
    expect(error.isCapabilityDisabled).toBe(true);
    expect(error.isPermissionRestriction).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.keepsIntent).toBe(false);
    expect(isCapabilityDisabledError(error)).toBe(true);
    expect(presentationForError(error)).toBe('turned_off');
    // Never offered as a retry: nothing the viewer repeats turns the switch on.
    expect(recoveryActionFor(error).retry).toBe(false);
  });

  it('keeps every other ACCESS_DENIED a permission restriction shown as "unavailable"', () => {
    for (const details of [undefined, null, {}, { code: 'OTHER' }, 'CAPABILITY_DISABLED']) {
      const error = accessDenied(details);
      expect(error.isCapabilityDisabled, JSON.stringify(details)).toBe(false);
      expect(error.isPermissionRestriction).toBe(true);
      expect(presentationForError(error)).toBe('unavailable');
    }
    // The same details on another code are not a capability answer.
    const notFound = new ApiError({
      kind: 'api',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      nextAction: 'verify_reference',
      correlationId: null,
      details: { code: 'CAPABILITY_DISABLED' },
    });
    expect(notFound.isCapabilityDisabled).toBe(false);
    expect(presentationForError(notFound)).toBe('unavailable');
    expect(isCapabilityDisabledError(networkError(new Error('x')))).toBe(false);
    expect(isCapabilityDisabledError(new Error('x'))).toBe(false);
  });

  it('names the capability and the decisions the API sent', () => {
    const turnedOff = turnedOffFromError(
      accessDenied({
        code: 'CAPABILITY_DISABLED',
        capability: 'point_of_sale',
        applicabilityReferences: ['DEC-016', 'DEC-079'],
      }),
    );
    expect(turnedOff).toEqual({
      capability: 'point_of_sale',
      label: 'Point of sale',
      decisions: ['DEC-016', 'DEC-079'],
      owner: 'Product owner',
    });
  });

  it('completes missing details from the catalogue, and never invents a capability', () => {
    expect(
      turnedOffFromError(accessDenied({ code: 'CAPABILITY_DISABLED', capability: 'parties' })),
    ).toMatchObject({ capability: 'parties', decisions: ['DEC-016', 'DEC-077'] });
    expect(
      turnedOffFromError(accessDenied({ code: 'CAPABILITY_DISABLED', capability: 'unknown_x' })),
    ).toEqual({
      capability: null,
      label: 'This capability',
      decisions: ['DEC-016'],
      owner: 'Product owner',
    });
    expect(turnedOffFromError(accessDenied())).toBeNull();
  });

  it('knows each capability with DEC-016 among the decisions that may turn it on', () => {
    for (const [id, presentation] of Object.entries(CAPABILITY_PRESENTATION)) {
      expect(isCapabilityId(id)).toBe(true);
      expect(presentation.decisions[0], id).toBe('DEC-016');
      expect(presentation.label.length).toBeGreaterThan(0);
    }
    expect(isCapabilityId('toString')).toBe(false);
    expect(isCapabilityId(7)).toBe(false);
    expect(turnedOffFor('access_hardware')).toEqual({
      capability: 'access_hardware',
      label: 'Access hardware',
      decisions: ['DEC-016', 'DEC-080'],
      owner: 'Product owner',
    });
  });

  it('words the turned-off state the same way in both apps, naming the decisions (SPK-UX-010)', () => {
    expect(turnedOffLabel('Rentals')).toBe('Rentals turned off');
    expect(turnedOffMessage(['DEC-016', 'DEC-076'])).toBe(
      'This is turned off for this organization. Whether it is used is decided by the product owner (DEC-016, DEC-076); a system administrator turns it on by naming one of these decisions. Everything else works without it.',
    );
    expect(turnedOffMessage(['DEC-016'])).toMatch(/\(DEC-016\); .* naming that decision\./);
  });
});
