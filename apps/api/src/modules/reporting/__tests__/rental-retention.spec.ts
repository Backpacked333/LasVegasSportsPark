import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { BOOKING_QUERY_PORT, type BookingOfPeriod, type BookingQueryPort } from '../../enrollment';
import { createPersonFixture } from '../../identity';
import { get, reportingTestApp, staff, valueOf, type Actor } from './support';

type FakeBooking = BookingOfPeriod & { facilityId: string };

/**
 * A deterministic stand-in for the enrollment module's booking reads (BOOKING_QUERY_PORT, IF-36),
 * put in place of the port whether or not ENR-13 has registered its implementation. It answers
 * exactly the port's contract (first occurrence in [from, to), facility, kinds) and records each
 * call with its transaction.
 */
class FakeBookingQuery implements BookingQueryPort {
  bookings: FakeBooking[] = [];
  calls: Array<{ from: string; to: string; trx: Trx | undefined }> = [];
  /** Runs once, inside the first call (the report's snapshot is already open). */
  onFirstCall: (() => Promise<void>) | null = null;

  async bookingsOfPeriod(
    _organizationId: string,
    query: { facilityId?: string; from: string; to: string; kinds?: ReadonlyArray<string> },
    trx?: Trx,
  ): Promise<BookingOfPeriod[]> {
    this.calls.push({ from: query.from, to: query.to, trx });
    const hook = this.onFirstCall;
    this.onFirstCall = null;
    if (hook) await hook();
    const from = new Date(query.from).getTime();
    const to = new Date(query.to).getTime();
    return this.bookings
      .filter((b) => !query.facilityId || b.facilityId === query.facilityId)
      .filter((b) => !query.kinds || query.kinds.includes(b.kind))
      .filter((b) => {
        const at = new Date(b.firstStart).getTime();
        return at >= from && at < to;
      })
      .map(({ facilityId: _facilityId, ...b }) => b);
  }
}

const PERIODS = {
  anchorFrom: '2027-01-01',
  anchorTo: '2027-01-31',
  comparisonFrom: '2027-04-01',
  comparisonTo: '2027-04-30',
};

describe('rental customer retention (SPK-REPORT-005, REP-02; IF-36)', () => {
  let t: TestApp;
  let manager: Actor;
  const fake = new FakeBookingQuery();
  let seq = 0;
  const booking = (
    bookerPersonId: string,
    kind: BookingOfPeriod['kind'],
    status: BookingOfPeriod['status'],
    firstStart: string,
  ): FakeBooking => {
    seq += 1;
    return {
      bookingId: `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
      kind,
      bookerPersonId,
      status,
      firstStart,
      offeringId: '018f0000-0000-7000-8000-00000000ffff',
      facilityId: t.facilityId,
    };
  };
  const report = (query: Record<string, string>) =>
    get(t, '/v1/reports/retention', manager, { cohort: 'rental_customers', ...query });

  beforeAll(async () => {
    t = await reportingTestApp({
      configure: (builder) => builder.overrideProvider(BOOKING_QUERY_PORT).useValue(fake),
    });
    manager = await staff(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-005: a booker who rebooks in the comparison period counts as retained', async () => {
    const [a, b, c, d1, d2, e, f] = await Promise.all(
      Array.from({ length: 7 }, () => createPersonFixture(t, { kind: 'adult' })),
    );
    // d1 is a duplicate merged into d2 (G7): one customer.
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: d2! })
      .where('id', '=', d1!)
      .execute();
    fake.bookings = [
      // a rents in January and comes back for a party in April: retained.
      booking(a!, 'rental', 'confirmed', '2027-01-15T18:00:00.000Z'),
      booking(a!, 'party', 'completed', '2027-04-10T18:00:00.000Z'),
      // b rents at 23:30 local on 31 January (1 February in UTC): an anchor booking by the
      // facility's local day (SPK-SCHED-008); b's April request was never confirmed: not retained.
      booking(b!, 'rental', 'completed', '2027-02-01T07:30:00.000Z'),
      booking(b!, 'rental', 'requested', '2027-04-12T18:00:00.000Z'),
      // c canceled: not a rental customer.
      booking(c!, 'rental', 'canceled', '2027-01-20T18:00:00.000Z'),
      // The duplicate booked in January, the survivor in April: the customer returned.
      booking(d1!, 'rental', 'confirmed', '2027-01-22T18:00:00.000Z'),
      booking(d2!, 'rental', 'confirmed', '2027-04-05T18:00:00.000Z'),
      // e's booking is on 1 February local time: outside the anchor period.
      booking(e!, 'rental', 'confirmed', '2027-02-01T09:00:00.000Z'),
      // f is new in April.
      booking(f!, 'party', 'confirmed', '2027-04-20T18:00:00.000Z'),
    ];
    fake.calls = [];

    const res = await report(PERIODS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows[0]).toMatchObject({
      cohort: 'rental_customers',
      cohortSize: 3,
      returned: 2,
      returnRate: 0.6667,
      newInComparison: 1,
      notOffered: 0,
    });
    expect(valueOf(res.body, 'MET-083', 'Rental customer return rate')).toBe(0.6667);
    // The port was asked for the facility's local days (Los Angeles, PST: UTC-8), inside the
    // report's snapshot transaction (REP-03).
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([
      ['2027-01-01T08:00:00.000Z', '2027-02-01T08:00:00.000Z'],
      ['2027-04-01T07:00:00.000Z', '2027-05-01T07:00:00.000Z'],
    ]);
    expect(fake.calls.every((c) => c.trx !== undefined)).toBe(true);
    const disclosures = (res.body.disclosures as string[]).join(' ');
    expect(disclosures).toContain('bookers of rental and party bookings confirmed or completed');
    expect(disclosures).toContain('Not offered is not computed for rental customers');
    expect(res.body.settings).toEqual([
      expect.objectContaining({ setting: 'REPORTING_OPERATING_DAY_START', configured: false }),
    ]);
    expect(res.body.freshness.consistency).toBe('snapshot');
    // Reads are never gated: the rentals and parties capabilities are off in this organization.
    const capabilities = await t.db
      .selectFrom('organization_capabilities')
      .select(['capability', 'enabled'])
      .where('organization_id', '=', t.organizationId)
      .where('capability', 'in', ['rentals', 'parties'])
      .execute();
    expect(capabilities.every((c) => !c.enabled)).toBe(true);
  });

  it('REP-03: a report computed while another transaction commits reflects one snapshot', async () => {
    const [x1, x2] = await Promise.all([
      createPersonFixture(t, { kind: 'adult' }),
      createPersonFixture(t, { kind: 'adult' }),
    ]);
    fake.bookings = [
      booking(x1!, 'rental', 'confirmed', '2027-06-10T18:00:00.000Z'),
      booking(x2!, 'rental', 'confirmed', '2027-09-10T18:00:00.000Z'),
    ];
    const periods = {
      anchorFrom: '2027-06-01',
      anchorTo: '2027-06-30',
      comparisonFrom: '2027-09-01',
      comparisonTo: '2027-09-30',
    };
    // While the report runs (its snapshot is open: the port is called inside it), another
    // transaction merges x1 into x2 and commits. On PostgreSQL the merge commits before the report
    // reads the persons; under PGlite (one connection) it waits for the report to finish.
    let merge: Promise<unknown> | null = null;
    fake.onFirstCall = async () => {
      merge = t.db
        .updateTable('persons')
        .set({ status: 'merged', merged_into_person_id: x2! })
        .where('id', '=', x1!)
        .execute();
      if (t.database.concurrent) await merge;
    };
    const during = await report(periods);
    await merge;
    expect(during.status, JSON.stringify(during.body)).toBe(200);
    // One snapshot: the merge committed mid-report is not seen, so x1 and x2 stay two people.
    expect(during.body.rows[0]).toMatchObject({ cohortSize: 1, returned: 0, newInComparison: 1 });

    const after = await report(periods);
    expect(after.body.rows[0]).toMatchObject({ cohortSize: 1, returned: 1, newInComparison: 0 });
  });

  it('SPK-REPORT-005: without bookings in the anchor period the cohort reports zero with a note', async () => {
    fake.bookings = [];
    const res = await report(PERIODS);
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ cohortSize: 0, returned: 0, returnRate: null });
    expect(valueOf(res.body, 'MET-083', 'Cohort size')).toBe(0);
    expect((res.body.disclosures as string[]).join(' ')).toContain(
      'No rental or party booking was confirmed or completed in the anchor period',
    );
  });
});
