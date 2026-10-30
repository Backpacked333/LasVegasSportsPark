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
  scanPerson,
  sessionActivity,
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

  it('SPK-ENTRY-004: a check-in already held at scan time is read with its issues and can be checked again', async () => {
    const user = userEvent.setup();
    const scanWithHeld = householdScan();
    scanWithHeld.people[1] = scanPerson(CHILD_1, 'Alex', 'child', 'household_member', [
      {
        ...sessionActivity(SESSION_1, 'Junior skills'),
        checkin: { id: CHECKIN_1, status: 'held' },
      },
    ]);
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': { status: 200, body: scanWithHeld },
        'GET /session-checkins/{id}': {
          status: 200,
          body: checkin(
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
            ],
            5,
          ),
        },
        'POST /session-checkins/{id}/recheck': {
          status: 200,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted', [], 6),
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    expect(await screen.findByText(/participation waiver/)).toBeInTheDocument();
    expect(screen.getByText('Blocking')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Checked in to Junior skills')).toBeInTheDocument();
    const recheck = app.fake.requests.find((r) => r.route === '/session-checkins/{id}/recheck');
    expect(recheck?.body).toEqual({ expectedRevision: 5 });
  });

  it('SPK-ENTRY-001: a recorded arrival stays "Arrived" while a later arrival fails', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const app = createTestApp({
      routes: routes({
        'POST /visits': () => {
          posts += 1;
          return posts === 1
            ? fakeResponse(201, { visits: [visit(VISIT_1, CHILD_1)] })
            : fakeResponse(500, apiErrorBody('INTERNAL_ERROR'));
        },
      }),
    });
    render(app.at('/arrival'));
    const people = await scan(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Alex Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));
    const alex = within(people).getByRole('listitem', { name: 'Alex Rivera' });
    expect(await within(alex).findByText('Arrived')).toBeInTheDocument();
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Blake Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));
    await waitFor(() => expect(posts).toBe(2));
    expect(within(alex).getByText('Arrived')).toBeInTheDocument();
    const blake = within(people).getByRole('listitem', { name: 'Blake Rivera' });
    expect(within(blake).queryByText('Arrived')).toBeNull();
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

  it('§4.15 / SPK-AT-018: reconnecting on another area, or reopening online, synchronises the queue once', async () => {
    const user = userEvent.setup();
    const syncRoute = (req: FakeRequest) => {
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
    };
    // Queue offline, move to Today, reconnect there.
    const app = createTestApp({ routes: routes({ 'POST /offline-sync': syncRoute }) });
    const view = render(app.at('/arrival'));
    await scan(user);
    act(() => app.connectivity.set(false));
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Alex Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Queue selected arrivals' }));
    await screen.findByText('1 arrival queued on this device: not yet recorded');
    await user.click(screen.getByRole('link', { name: 'Today' }));
    act(() => app.connectivity.set(true));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/offline-sync')).toHaveLength(1),
    );
    view.unmount();

    // Items still queued on this device when the dashboard closed are sent once on reopening.
    window.localStorage.clear();
    const offline = createTestApp({ routes: routes({ 'POST /offline-sync': syncRoute }) });
    const first = render(offline.at('/arrival'));
    await scan(user);
    act(() => offline.connectivity.set(false));
    await user.click(
      screen.getByRole('checkbox', { name: 'Record arrival at the facility for Alex Rivera' }),
    );
    await user.click(screen.getByRole('button', { name: 'Queue selected arrivals' }));
    await screen.findByText('1 arrival queued on this device: not yet recorded');
    first.unmount();
    const reopened = createTestApp({ routes: routes({ 'POST /offline-sync': syncRoute }) });
    render(reopened.at('/today'));
    await waitFor(() =>
      expect(reopened.fake.requests.filter((r) => r.route === '/offline-sync')).toHaveLength(1),
    );
  });

  it('SPK-IAM-002 / SPK-ENTRY-001: looks a person up without a pass and records arrival and check-in separately', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people': {
          status: 200,
          body: {
            items: [
              {
                id: CHILD_1,
                givenName: 'Alex',
                familyName: 'Rivera',
                kind: 'child',
                status: 'active',
                matchedOn: 'name',
              },
            ],
            nextCursor: null,
          },
        },
        'GET /sessions': {
          status: 200,
          body: {
            items: [
              {
                sessionId: SESSION_1,
                offeringId: OFFERING,
                offeringName: 'Junior skills',
                sequence: 2,
                title: null,
                scheduledStart: '2026-10-24T16:00:00.000Z',
                scheduledEnd: '2026-10-24T17:00:00.000Z',
                status: 'scheduled',
                facilityId: FACILITY_A,
                timezone: 'America/Los_Angeles',
              },
            ],
            nextCursor: null,
          },
        },
        'POST /visits': {
          status: 201,
          body: { visits: [{ ...visit(VISIT_1, CHILD_1), passId: null }] },
        },
        'POST /session-checkins': {
          status: 201,
          body: checkin(
            CHECKIN_1,
            CHILD_1,
            SESSION_1,
            'held',
            [
              {
                code: 'no_participation',
                severity: 'blocking',
                message: 'Alex has no enrollment or booking for this session.',
                nextAction: 'register_or_book',
                reference: null,
              },
            ],
            3,
          ),
        },
        // The booking was made at the desk meanwhile: checking again admits (SPK-ENTRY-004).
        'POST /session-checkins/{id}/recheck': {
          status: 200,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted', [], 4),
        },
      }),
    });
    render(app.at('/arrival'));
    const search = await screen.findByRole('search', { name: 'Find a person' });
    // The API's minimum is two characters: nothing is sent before.
    await user.type(within(search).getByLabelText('Find a person'), 'A');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Type at least 2 characters.')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/people')).toHaveLength(0);
    await user.type(within(search).getByLabelText('Find a person'), 'le');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Select Alex Rivera' }));
    expect(app.fake.requests.find((r) => r.route === '/people')?.query.query).toBe('Ale');

    // Finding someone records nothing; the arrival needs a chosen category.
    const panel = screen.getByRole('region', { name: 'Arrival for Alex Rivera' });
    expect(app.fake.requests.filter((r) => r.route === '/visits')).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Record arrival' }));
    expect(within(panel).getByText('Choose a visitor category.')).toBeInTheDocument();
    await user.selectOptions(
      within(panel).getByLabelText('Visitor category for Alex Rivera'),
      'participant',
    );
    await user.click(within(panel).getByRole('button', { name: 'Record arrival' }));
    expect(await within(panel).findByText('Arrived')).toBeInTheDocument();
    const visits = app.fake.requests.filter((r) => r.route === '/visits');
    expect(visits[0]?.body).toEqual({
      facilityId: FACILITY_A,
      arrivals: [{ personId: CHILD_1, visitorCategory: 'participant' }],
    });

    // The check-in is its own record; the API's issue is shown as it states it (SPK-ENTRY-004).
    await waitFor(() =>
      expect(
        within(panel).getByRole('option', { name: /Junior skills, session 2/ }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(panel).getByLabelText('Session to check Alex Rivera in to'),
      SESSION_1,
    );
    await user.click(within(panel).getByRole('button', { name: 'Check in' }));
    expect(
      await within(panel).findByText('Check-in held: Junior skills, session 2'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Blocking')).toBeInTheDocument();
    const checkins = app.fake.requests.filter((r) => r.route === '/session-checkins');
    expect(checkins[0]?.body).toEqual({
      personId: CHILD_1,
      activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
      visitId: VISIT_1,
    });
    expect(checkins[0]?.headers['idempotency-key']).not.toEqual(
      visits[0]?.headers['idempotency-key'],
    );

    // A held check-in is actionable in place: "Check again" with its revision, its own intent.
    await user.click(within(panel).getByRole('button', { name: 'Check again' }));
    expect(
      await within(panel).findByText('Checked in to Junior skills, session 2'),
    ).toBeInTheDocument();
    const recheck = app.fake.requests.find((r) => r.route === '/session-checkins/{id}/recheck');
    expect(recheck?.params).toEqual({ id: CHECKIN_1 });
    expect(recheck?.body).toEqual({ expectedRevision: 3 });
    expect(recheck?.headers['idempotency-key']).not.toEqual(
      checkins[0]?.headers['idempotency-key'],
    );
    expect(within(panel).queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('SPK-ENTRY-004: a looked-up check-in recheck refused as stale shows its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people': {
          status: 200,
          body: {
            items: [
              {
                id: CHILD_1,
                givenName: 'Alex',
                familyName: 'Rivera',
                kind: 'child',
                status: 'active',
                matchedOn: 'name',
              },
            ],
            nextCursor: null,
          },
        },
        'GET /sessions': {
          status: 200,
          body: {
            items: [
              {
                sessionId: SESSION_1,
                offeringId: OFFERING,
                offeringName: 'Junior skills',
                sequence: 2,
                title: null,
                scheduledStart: '2026-10-24T16:00:00.000Z',
                scheduledEnd: '2026-10-24T17:00:00.000Z',
                status: 'scheduled',
                facilityId: FACILITY_A,
                timezone: 'America/Los_Angeles',
              },
            ],
            nextCursor: null,
          },
        },
        'POST /session-checkins': {
          status: 201,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'held', [], 3),
        },
        'POST /session-checkins/{id}/recheck': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/arrival'));
    const search = await screen.findByRole('search', { name: 'Find a person' });
    await user.type(within(search).getByLabelText('Find a person'), 'Alex');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Select Alex Rivera' }));
    const panel = screen.getByRole('region', { name: 'Arrival for Alex Rivera' });
    await waitFor(() =>
      expect(
        within(panel).getByRole('option', { name: /Junior skills, session 2/ }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(panel).getByLabelText('Session to check Alex Rivera in to'),
      SESSION_1,
    );
    await user.click(within(panel).getByRole('button', { name: 'Check in' }));
    await user.click(await within(panel).findByRole('button', { name: 'Check again' }));
    expect(await within(panel).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    // The held evaluation stays on screen; nothing is shown as checked in.
    expect(within(panel).getByText('Check-in held: Junior skills, session 2')).toBeInTheDocument();
  });

  it('shows the person search as not available when the role may not search', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You need identity.lookup_person.' }),
          ),
      }),
    });
    render(app.at('/arrival'));
    const search = await screen.findByRole('search', { name: 'Find a person' });
    await user.type(within(search).getByLabelText('Find a person'), 'Alex');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    const unavailable = await screen.findByTestId('person-search-unavailable');
    expect(unavailable).toHaveTextContent('Person search not available');
    expect(unavailable).toHaveTextContent('Error code: ACCESS_DENIED');
    expect(
      screen.getByRole('navigation', { name: 'Arrival and attendance screens' }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('occupancy')).toHaveTextContent('Not verified occupancy.');
  });

  it('says when nobody matches the search', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /people': { status: 200, body: { items: [], nextCursor: null } } }),
    });
    render(app.at('/arrival'));
    const search = await screen.findByRole('search', { name: 'Find a person' });
    await user.type(within(search).getByLabelText('Find a person'), 'Zed');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Nobody found')).toBeInTheDocument();
  });

  it('asks for a facility when the viewer works across several', async () => {
    const app = createTestApp();
    render(app.at('/arrival'));
    expect(await screen.findByText('Choose a facility')).toBeInTheDocument();
  });
});
