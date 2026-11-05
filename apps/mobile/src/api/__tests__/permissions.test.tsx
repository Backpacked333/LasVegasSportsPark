/**
 * usePermissions in the customer app (K-05; K-12, DEC-016): one cached read per session shared by
 * every consumer, re-read when the app returns to the foreground (SPK-UX-001), unknown until it
 * answers, and no read without a session.
 */
import { fakePermissions, fakeResponse } from '@sportspark/api-client/testing';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { createTestApp, mePermissions } from '../../testing/test-app';
import { usePermissions } from '../permissions';

const reads = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/me/permissions').length;

describe('usePermissions (K-05, DEC-016)', () => {
  it('answers conditional actions and capability switches from the API, unknown until then', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({
          enabled: ['memberships'],
          conditionalActions: [{ id: 'enrollment.create_booking', self: true }],
        }),
      },
    });
    const { result } = renderHook(() => usePermissions(), { wrapper: app.wrapper });
    expect(result.current.isCapabilityEnabled('memberships')).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isCapabilityEnabled('memberships')).toBe(true);
    expect(result.current.isCapabilityEnabled('rentals')).toBe(false);
    expect(result.current.actionPermission('enrollment.create_booking')).toEqual({
      kind: 'conditional',
      self: true,
      subjectPermission: null,
      teamRole: null,
    });
    expect(result.current.actionPermission('finance.approve_refund')).toBeNull();
  });

  it('reads once for every consumer, and again when the app returns to the foreground', async () => {
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
    act(() => {
      app.sources.setForeground(false);
      app.sources.setForeground(true);
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
