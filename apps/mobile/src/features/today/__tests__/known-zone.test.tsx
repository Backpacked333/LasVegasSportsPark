/**
 * SPK-SCHED-008: records without a facility (a price's expiry, held spots, an amount due, a
 * receipt, a notice, the pass) show their times on the facility's clock when the app already knows
 * it from another answer, else on the device's; the zone is always named, never hard-coded.
 */
import { QueryClient } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react-native';
import { basket, familyRoutes, IDS, inMinutes, quote } from '../../registration/testing/fixtures';
import { createRegistrationTestApp } from '../../registration/testing/registration-test-app';
import { CheckoutScreen } from '../../../screens/registration/CheckoutScreen';
import { createTestApp } from '../../../testing/test-app';
import { knownFacilityZone, statedZones, useKnownFacilityZone } from '../known-zone';

jest.mock('../device-time-zone', () => ({ deviceTimeZone: () => 'America/Los_Angeles' }));
jest.mock('../../registration/dev', () => ({ DevPaymentMethodPicker: null }));

const NEW_YORK = 'America/New_York';

describe('the facility zone the app knows (SPK-SCHED-008)', () => {
  it('finds every stated zone in an answer, nested in records and lists', () => {
    const answer = {
      data: {
        items: [
          { timezone: NEW_YORK, offering: { facility: { timezone: NEW_YORK } } },
          { venue: { timezone: 'America/Chicago' } },
        ],
      },
    };
    expect([...statedZones(answer)]).toEqual([NEW_YORK, 'America/Chicago']);
    expect([...statedZones(null)]).toEqual([]);
    expect([...statedZones('timezone')]).toEqual([]);
  });

  it('uses a zone only when every cached answer agrees on it', () => {
    // No garbage-collection timer, so the test leaves nothing running.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    expect(knownFacilityZone(client)).toBe('');
    client.setQueryData(['offering', 1], { data: { facility: { timezone: NEW_YORK } } });
    client.setQueryData(['calendar'], { data: { items: [{ timezone: NEW_YORK }] } });
    expect(knownFacilityZone(client)).toBe(NEW_YORK);
    client.setQueryData(['offering', 2], { data: { facility: { timezone: 'Europe/London' } } });
    expect(knownFacilityZone(client)).toBe('');
    client.clear();
  });

  it("the record's own zone wins; without any, the device's zone is used and said to be", () => {
    const app = createTestApp();
    const { result, rerender } = renderHook(
      ({ stated }: { stated?: string | null }) => useKnownFacilityZone(stated),
      { wrapper: app.wrapper, initialProps: {} },
    );
    expect(result.current).toEqual({ zone: 'America/Los_Angeles', facility: false });
    rerender({ stated: 'America/Denver' });
    expect(result.current).toEqual({ zone: 'America/Denver', facility: true });
  });

  it('SPK-SCHED-008: Pay shows "Price valid until" and "Place held until" on the facility clock', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ expiresAt: '2026-10-24T12:30:00.000Z' }),
        },
        'GET /baskets/{id}': {
          status: 200,
          body: basket({ status: 'held', holdExpiresAt: inMinutes(9) }),
        },
      },
    });
    // An earlier screen read the activity, which states its facility's zone.
    app.queryClient.setQueryData(['an-offering'], { data: { facility: { timezone: NEW_YORK } } });
    render(<CheckoutScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
    // 12:30 UTC is 8:30 AM in New York (EDT on 2026-10-24), not 5:30 AM on the device's clock.
    expect(
      await screen.findByLabelText('Price valid until Sat, Oct 24, 8:30 AM EDT'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Place held until Sat, Oct 24, 8:09 AM EDT')).toBeOnTheScreen();
    expect(screen.queryByText(/UTC/)).toBeNull();
    await app.settle();
  });

  it('SPK-SCHED-008: without a known facility zone, Pay names the device zone (never a fixed UTC)', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ expiresAt: '2026-10-24T12:30:00.000Z' }),
        },
        'GET /baskets/{id}': { status: 200, body: basket() },
      },
    });
    render(<CheckoutScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Price valid until Sat, Oct 24, 5:30 AM PDT'),
    ).toBeOnTheScreen();
    await app.settle();
  });
});
