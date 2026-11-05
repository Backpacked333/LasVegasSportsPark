/**
 * usePermissions over GET /v1/me/permissions (K-05, SPK-UX-005; K-12, DEC-016): one cached read
 * per session shared by every consumer, re-read on window focus, unknown (undefined) until it
 * answers, and no read without a session.
 */
import { fakePermissions, fakeResponse } from '@sportspark/api-client/testing';
import { focusManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FACILITY_A, FACILITY_B, createTestApp, mePermissions } from '../../testing/test-app';
import { usePermissions } from '../permissions';

const reads = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/me/permissions').length;

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('usePermissions (SPK-UX-005, DEC-016)', () => {
  it('answers outright, facility-scoped and conditional actions, areas and switches from the API', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({
          areas: ['today', 'finance'],
          enabled: ['point_of_sale'],
          actions: [
            'finance.read_payment',
            { id: 'scheduling.publish_draft', facilityIds: [FACILITY_A] },
          ],
          conditionalActions: [{ id: 'enrollment.create_booking', self: true }],
        }),
      },
    });
    const { result } = renderHook(() => usePermissions(), { wrapper: app.wrapper });
    // Unknown, never a guess, until the read answers.
    expect(result.current.isCapabilityEnabled('point_of_sale')).toBeUndefined();
    expect(result.current.isAreaVisible('finance')).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.visibleAreas).toEqual(['today', 'finance']);
    expect(result.current.isAreaVisible('schedule')).toBe(false);
    expect(result.current.isCapabilityEnabled('point_of_sale')).toBe(true);
    expect(result.current.isCapabilityEnabled('rentals')).toBe(false);
    expect(result.current.isPermitted('finance.read_payment')).toBe(true);
    expect(result.current.isPermitted('scheduling.publish_draft', FACILITY_A)).toBe(true);
    expect(result.current.isPermitted('scheduling.publish_draft', FACILITY_B)).toBe(false);
    expect(result.current.actionPermission('enrollment.create_booking')).toEqual({
      kind: 'conditional',
      self: true,
      subjectPermission: null,
      teamRole: null,
    });
    expect(result.current.actionPermission('finance.approve_refund')).toBeNull();
  });

  it('reads once per session for every consumer, and again when the window regains focus', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          calls += 1;
          return fakeResponse(200, fakePermissions({ enabled: calls > 1 ? ['rentals'] : [] }));
        },
      },
    });
    const { result } = renderHook(() => [usePermissions(), usePermissions()] as const, {
      wrapper: app.wrapper,
    });
    await waitFor(() => expect(result.current[0].data).toBeDefined());
    expect(reads(app)).toBe(1);
    expect(result.current[1].isCapabilityEnabled('rentals')).toBe(false);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(result.current[1].isCapabilityEnabled('rentals')).toBe(true));
    expect(reads(app)).toBe(2);
  });

  it('does not read without a session', async () => {
    const app = createTestApp({ session: null });
    const { result } = renderHook(() => usePermissions(), { wrapper: app.wrapper });
    await waitFor(() => expect(result.current.query.fetchStatus).toBe('idle'));
    expect(result.current.data).toBeUndefined();
    expect(reads(app)).toBe(0);
  });
});
