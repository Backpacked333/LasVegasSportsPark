/**
 * SCR-S-28 Arrival scanner and selection: SPK-AT-015 (only the actual child and session are
 * recorded), SPK-ENTRY-003 (the scan records nobody), SPK-ENTRY-001 (arrival and check-in are
 * separate commands with separate idempotency keys), SPK-ENTRY-004 (issues shown as the API
 * states them), §4.15 / SPK-AT-018 (offline arrivals queued and synchronised once).
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKIN_1,
  CHILD_1,
  OFFERING,
  PASS,
  SESSION_1,
  VISIT_1,
  checkin,
  householdScan,
  oneFacilityMe,
  syncBatch,
  visit,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const REFERENCE = 'spp_0123456789abcdef0123';

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /me': oneFacilityMe(),
    'POST /passes/scan': { status: 200, body: householdScan() },
    'GET /facilities/{id}/occupancy': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
        evaluatedAt: '2026-10-24T12:00:00.000Z',
        arrivals: { people: 4, visits: 4 },
        departures: { people: 1, visits: 1 },
        recordedOnSite: 3,
        openFromEarlierDays: 0,
        occupancy: {
          status: 'unverified',
          verifiedOccupancy: null,
          reconciledAt: null,
          statement: 'Arrivals minus departures is a records figure, not verified occupancy.',
        },
        lastSnapshot: null,
      },
    },
    ...extra,
  } as NonNullable<Parameters<typeof createTestApp>[0]>['routes'];
}

async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Pass reference'), REFERENCE);
  await user.click(screen.getByRole('button', { name: 'Open selection' }));
  return screen.findByRole('list', { name: 'People on this pass' });
}

describe('SCR-S-28 ArrivalScannerScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-AT-015: records only the child and the session staff select, never the whole household', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /visits': { status: 201, body: { visits: [visit(VISIT_1, CHILD_1)] } },
        'POST /session-checkins': {
          status: 201,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted'),
        },
      }),
    });
    render(app.at('/arrival'));
    const people = await scan(user);

    // SPK-ENTRY-003: the scan records nobody and nothing is preselected.
    expect(app.fake.requests.filter((r) => r.route === '/visits')).toHaveLength(0);
    for (const box of within(people).getAllByRole('checkbox')) expect(box).not.toBeChecked();

    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Alex Rivera' }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Check Alex Rivera in to Junior skills' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));

    expect(await screen.findByText('Checked in to Junior skills')).toBeInTheDocument();
    const alex = within(people).getByRole('listitem', { name: 'Alex Rivera' });
    expect(within(alex).getByText('Arrived')).toBeInTheDocument();

    const visits = app.fake.requests.filter((r) => r.route === '/visits' && r.method === 'POST');
    expect(visits).toHaveLength(1);
    expect(visits[0]?.body).toEqual({
      facilityId: FACILITY_A,
      passId: PASS,
      arrivals: [{ personId: CHILD_1, visitorCategory: 'participant' }],
    });
    const checkins = app.fake.requests.filter((r) => r.route === '/session-checkins');
    expect(checkins).toHaveLength(1);
    expect(checkins[0]?.body).toEqual({
      personId: CHILD_1,
      activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
      visitId: VISIT_1,
    });
    // Separate records, separate intents (§4.9).
    expect(visits[0]?.headers['idempotency-key']).not.toEqual(
      checkins[0]?.headers['idempotency-key'],
    );
    // Blake and Sam were not recorded.
    const blake = within(people).getByRole('listitem', { name: 'Blake Rivera' });
    expect(within(blake).queryByText('Arrived')).toBeNull();
  });

  it('asks for a visitor category for an adult without a session before recording the arrival', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Sam Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));
    expect(await screen.findByText('Choose a visitor category.')).toBeInTheDocument();
    expect(screen.getByLabelText('Visitor category for Sam Rivera')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(app.fake.requests.filter((r) => r.route === '/visits')).toHaveLength(0);
  });

  it('shows an unknown pass as not recognised with the API error code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': {
          status: 404,
          body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
        },
      }),
    });
    render(app.at('/arrival'));
    await user.type(await screen.findByLabelText('Pass reference'), REFERENCE);
    await user.click(screen.getByRole('button', { name: 'Open selection' }));
    expect(
      await screen.findByText('Pass not recognised. Check the reference or scan it again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Error code: NOT_FOUND')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'People on this pass' })).toBeNull();
  });

  it('shows a facility outside the viewer’s scope as not available (ACCESS_DENIED)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', {
            message: 'You need entry.scan_pass in this facility.',
            nextAction: 'contact_support_or_request_access',
          }),
        },
      }),
    });
    render(app.at('/arrival'));
    await user.type(await screen.findByLabelText('Pass reference'), REFERENCE);
    await user.click(screen.getByRole('button', { name: 'Open selection' }));
    const unavailable = await screen.findByTestId('command-unavailable');
    expect(within(unavailable).getByText('Not available')).toBeInTheDocument();
    expect(within(unavailable).getByText(/entry\.scan_pass/)).toBeInTheDocument();
  });

  it('SPK-ENTRY-004: shows a held check-in with its issues and re-checks with the expected revision', async () => {
    const user = userEvent.setup();
    const held = checkin(
      CHECKIN_1,
      CHILD_1,
      SESSION_1,
      'held',
      [
        {
          code: 'missing_acknowledgment',
          severity: 'blocking',
          message: 'The participation waiver has not been acknowledged.',
          nextAction: 'complete_acknowledgment',
          reference: null,
        },
        {
          code: 'balance_unknown',
          severity: 'info',
          message: 'The balance could not be confirmed; it does not block participation.',
          nextAction: 'none',
          reference: null,
        },
      ],
      2,
    );
    const app = createTestApp({
      routes: routes({
        'POST /session-checkins': { status: 201, body: held },
        'POST /session-checkins/{id}/recheck': {
          status: 200,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted', [], 3),
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Check Alex Rivera in to Junior skills' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));
    expect(await screen.findByText('Check-in held: Junior skills')).toBeInTheDocument();
    expect(screen.getByText('Blocking')).toBeInTheDocument();
    expect(screen.getByText(/participation waiver/)).toBeInTheDocument();
    expect(screen.getByText('Information')).toBeInTheDocument();
    // No arrival was ticked, so no visit was recorded (SPK-ENTRY-001).
    expect(app.fake.requests.filter((r) => r.route === '/visits')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Checked in to Junior skills')).toBeInTheDocument();
    const recheck = app.fake.requests.find((r) => r.route === '/session-checkins/{id}/recheck');
    expect(recheck?.params).toEqual({ id: CHECKIN_1 });
    expect(recheck?.body).toEqual({ expectedRevision: 2 });
  });

  it('§4.15 / SPK-AT-018: queues arrivals offline against the scan and synchronises them once on reconnection', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /offline-sync': (req: FakeRequest) => {
          const body = req.body as { items: { clientObservationId: string }[] };
          return fakeResponse(
            201,
            syncBatch(
              body.items.map((i) => ({
                clientObservationId: i.clientObservationId,
                kind: 'arrival',
                outcome: 'accepted',
              })),
            ),
          );
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    act(() => app.connectivity.set(false));

    // Check-in needs a connection; the arrival can be queued.
    expect(
      screen.getByRole('checkbox', { name: 'Check Alex Rivera in to Junior skills' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Alex Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Queue selected arrivals' }));
    expect(
      await screen.findByText('1 arrival queued on this device: not yet recorded'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('1 observation queued on this device (not yet recorded)'),
    ).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/visits')).toHaveLength(0);

    act(() => app.connectivity.set(true));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/offline-sync')).toHaveLength(1),
    );
    const sync = app.fake.requests.find((r) => r.route === '/offline-sync');
    const body = sync?.body as {
      deviceId: string;
      clientBatchId: string;
      facilityId: string;
      snapshot: { reference: string; takenAt: string };
      items: Record<string, unknown>[];
    };
    expect(body.facilityId).toBe(FACILITY_A);
    expect(body.deviceId).toMatch(/^staff-web-/);
    expect(body.snapshot.takenAt).toBe('2026-10-24T12:00:00.000Z');
    expect(body.snapshot.reference).toMatch(/^roster-/);
    expect(body.items).toEqual([
      expect.objectContaining({
        kind: 'arrival',
        personId: CHILD_1,
        visitorCategory: 'participant',
      }),
    ]);
    expect(sync?.headers['idempotency-key']).toBeTruthy();
    expect(await screen.findByTestId('last-sync')).toHaveTextContent('1 synchronised');
    // Synchronised once: nothing is left to send.
    expect(screen.queryByRole('button', { name: 'Synchronise now' })).toBeNull();
  });

  it('marks person lookup without a pass as not available (no person search in the API)', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival'));
    expect(await screen.findByText('Find a person without a pass')).toBeInTheDocument();
    expect(screen.getByText(/does not offer a person search/)).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Arrival and attendance screens' }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('occupancy')).toHaveTextContent('Not verified occupancy.');
  });

  it('asks for a facility when the viewer works across several', async () => {
    const app = createTestApp();
    render(app.at('/arrival'));
    expect(await screen.findByText('Choose a facility')).toBeInTheDocument();
  });
});
