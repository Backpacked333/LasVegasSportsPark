/**
 * SPK-SCHED-008: records without a facility (a price's expiry, held spots, an amount due, a
 * receipt, a notice, the pass) show their times on the facility's clock when the app already knows
 * it from another answer, else on the device's; the zone is always named, never hard-coded.
 */
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import { createTestApp } from '../../../testing/test-app';
import { knownFacilityZone, statedZones, useKnownFacilityZone } from '../known-zone';

jest.mock('../device-time-zone', () => ({ deviceTimeZone: () => 'America/Los_Angeles' }));

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
});
