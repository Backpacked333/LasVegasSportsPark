/**
 * SCR-S-29 Session attendance and corrections: SPK-ENTRY-005 (corrections are new observations
 * with actor, time and a required reason), SPK-ENTRY-008 (counts are not verified occupancy),
 * conflicts kept for review, protected NOT_FOUND shown as not available, §4.15 offline queueing.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_QUEUE_STORAGE_KEY,
  type OfflineQueueState,
} from '../../../features/operations/offline/queue';
import {
  CHILD_1,
  CHILD_2,
  OFFERING,
  SESSION_1,
  actor,
  nameEntry,
  oneFacilityMe,
  personNames,
  syncBatch,
} from '../../../features/operations/testing';
import { FACILITY_A, TEST_NOW, createTestApp } from '../../../testing/test-app';

const OBS_1 = '0192f1a0-0000-7000-8000-0000000000a1';
const OBS_2 = '0192f1a0-0000-7000-8000-0000000000a2';
const SESSION_URL = `/arrival/attendance?type=session&offeringId=${OFFERING}&sessionId=${SESSION_1}`;

function observation(
  id: string,
  personId: string,
  state: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    facilityId: FACILITY_A,
    personId,
    activity: {
      type: 'session',
      id: SESSION_1,
      offeringId: OFFERING,
      sessionId: SESSION_1,
      eventId: null,
    },
    observedState: state,
    observedAt: '2026-10-24T11:00:00.000Z',
    receivedAt: '2026-10-24T11:00:00.000Z',
    source: 'online',
    deviceId: null,
    clientObservationId: null,
    syncBatchId: null,
    snapshotReference: null,
    snapshotTakenAt: null,
    flags: [],
    correctsObservationId: null,
    correctionReason: null,
    recordedBy: actor(),
    correctedByObservationId: null,
    ...extra,
  };
}

function attendance(people: unknown[]) {
  return {
    status: 200,
    body: {
      activity: {
        type: 'session',
        id: SESSION_1,
        offeringId: OFFERING,
        sessionId: SESSION_1,
        eventId: null,
      },
      people,
    },
  };
}

const ALEX_PRESENT = {
  personId: CHILD_1,
  // ENT-01: the attendance read names its people.
  givenName: 'Alex',
  familyName: 'Rivera',
  displayName: 'Alex Rivera',
  effectiveState: 'present',
  status: 'recorded',
  currentObservationIds: [OBS_1],
  history: [observation(OBS_1, CHILD_1, 'present')],
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /attendance': attendance([ALEX_PRESENT]),
    'GET /enrollments': {
      status: 200,
      body: { items: [{ participantPersonId: CHILD_1 }], nextCursor: null },
    },
    'GET /session-bookings': { status: 200, body: [{ participantPersonId: CHILD_2 }] },
    'GET /offerings/{id}/sessions': {
      status: 200,
      body: [
        {
          id: SESSION_1,
          offeringId: OFFERING,
          title: 'Junior skills',
          scheduledStart: '2026-10-24T16:00:00.000Z',
          scheduledEnd: '2026-10-24T17:00:00.000Z',
        },
      ],
    },
    // Blake is expected (a session booking) without an attendance record: named by the names read.
    'GET /person-names': personNames([nameEntry(CHILD_2, 'Blake', 'Rivera')]),
    'GET /sessions': { status: 200, body: { items: [], nextCursor: null } },
    ...extra,
  };
}

describe('SCR-S-29 SessionAttendanceScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('lists expected participants with their state and records a first observation', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /attendance-observations': {
          status: 201,
          body: {
            observation: observation(OBS_2, CHILD_2, 'present'),
            duplicate: false,
            conflict: null,
          },
        },
      }),
    });
    render(app.at(SESSION_URL));
    const list = await screen.findByRole('list', { name: 'Participants' });
    const alex = await within(list).findByRole('listitem', { name: 'Alex Rivera' });
    expect(within(alex).getByRole('button', { name: 'Present: Alex Rivera' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const blake = await within(list).findByRole('listitem', { name: 'Blake Rivera' });
    expect(within(blake).getByText('Not recorded')).toBeInTheDocument();
    expect(screen.getByTestId('attendance-counts')).toHaveTextContent(
      'Present 1, late 0, left early 0, absent 0, not recorded 1. Observed attendance, not verified occupancy.',
    );
    expect(screen.getByRole('heading', { name: 'Attendance: Junior skills' })).toBeInTheDocument();

    await user.click(within(blake).getByRole('button', { name: 'Present: Blake Rivera' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(true),
    );
    const post = app.fake.requests.find((r) => r.route === '/attendance-observations');
    expect(post?.body).toEqual({
      personId: CHILD_2,
      activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
      observedState: 'present',
    });
    expect(post?.headers['idempotency-key']).toBeTruthy();
    // The list refreshes rather than overwriting (concurrent observations stay visible).
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/attendance')).toHaveLength(2),
    );
  });

  it('SPK-ENTRY-005: a change of state is a correction with a required reason, never an overwrite', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /attendance-observations/{id}/corrections': {
          status: 201,
          body: {
            observation: observation(OBS_2, CHILD_1, 'absent', { correctsObservationId: OBS_1 }),
            duplicate: false,
            conflict: null,
          },
        },
      }),
    });
    render(app.at(SESSION_URL));
    const alex = await screen.findByRole('listitem', { name: 'Alex Rivera' });
    await user.click(within(alex).getByRole('button', { name: 'Absent: Alex Rivera' }));
    const form = await screen.findByRole('form', { name: 'Correct attendance for Alex Rivera' });
    expect(within(form).getByRole('radio', { name: 'Absent' })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(within(form).getByText('A reason is required for a correction.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route?.includes('corrections'))).toBe(false);

    await user.type(within(form).getByLabelText('Reason for the correction'), 'Marked by mistake');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/attendance-observations/{id}/corrections'),
      ).toBe(true),
    );
    const correction = app.fake.requests.find(
      (r) => r.route === '/attendance-observations/{id}/corrections',
    );
    expect(correction?.params).toEqual({ id: OBS_1 });
    expect(correction?.body).toEqual({ observedState: 'absent', reason: 'Marked by mistake' });
    // No plain observation was written over the original.
    expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(false);
  });

  it('shows conflicting observations for review and offers to correct each one', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /attendance': attendance([
          {
            personId: CHILD_1,
            givenName: 'Alex',
            familyName: 'Rivera',
            displayName: 'Alex Rivera',
            effectiveState: null,
            status: 'conflict',
            currentObservationIds: [OBS_1, OBS_2],
            history: [
              observation(OBS_1, CHILD_1, 'present', { recordedBy: actor('Coach Kim') }),
              observation(OBS_2, CHILD_1, 'absent', {
                source: 'offline_sync',
                flags: ['conflict'],
              }),
            ],
          },
        ]),
      }),
    });
    render(app.at(SESSION_URL));
    const alex = await screen.findByRole('listitem', { name: 'Alex Rivera' });
    expect(within(alex).getByText('Conflicting observations: kept for review')).toBeInTheDocument();
    expect(
      within(alex).getByRole('button', { name: 'Correct the present observation of Alex Rivera' }),
    ).toBeInTheDocument();
    expect(
      within(alex).getByRole('button', { name: 'Correct the absent observation of Alex Rivera' }),
    ).toBeInTheDocument();
    expect(within(alex).getByText(/synchronised from an offline device/)).toBeInTheDocument();
  });

  it('shows a protected activity (NOT_FOUND) as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /attendance': {
          status: 404,
          body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
        },
      }),
    });
    render(app.at(SESSION_URL));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Participants' })).toBeNull();
  });

  it('§4.15: queues a first observation offline against the cached roster; corrections need a connection', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(SESSION_URL));
    const blake = await screen.findByRole('listitem', { name: 'Blake Rivera' });
    const alex = screen.getByRole('listitem', { name: 'Alex Rivera' });
    act(() => app.connectivity.set(false));
    expect(within(alex).getByRole('button', { name: 'Absent: Alex Rivera' })).toBeDisabled();
    expect(within(alex).getByText('Corrections need a connection.')).toBeInTheDocument();
    await user.click(within(blake).getByRole('button', { name: 'Late: Blake Rivera' }));
    expect(
      await within(blake).findByText('Queued on this device: Late (not yet recorded)'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(false);
    expect(screen.getAllByText('Showing information from just now.').length).toBeGreaterThan(0);
  });

  it('§4.15: the roster snapshot of a queued observation is dated by the service’s clock (Date header), not a device clock that runs ahead', async () => {
    const user = userEvent.setup();
    // The device clock reads 12:00; the service answered at 11:53 (the device runs 7 minutes fast).
    const app = createTestApp({
      routes: routes({
        'GET /attendance': () =>
          fakeResponse(200, attendance([ALEX_PRESENT]).body, {
            Date: 'Sat, 24 Oct 2026 11:53:00 GMT',
          }),
      }),
    });
    render(app.at(SESSION_URL));
    const blake = await screen.findByRole('listitem', { name: 'Blake Rivera' });
    act(() => app.connectivity.set(false));
    await user.click(within(blake).getByRole('button', { name: 'Late: Blake Rivera' }));
    await within(blake).findByText('Queued on this device: Late (not yet recorded)');
    const stored = JSON.parse(
      window.localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY) ?? '{}',
    ) as OfflineQueueState;
    expect(stored.pending[0]?.snapshot.takenAt).toBe('2026-10-24T11:53:00.000Z');
    // The observation is on the same clock: the device's 12:00 is the service's 11:53.
    expect(stored.pending[0]?.item.observedAt).toBe('2026-10-24T11:53:00.000Z');
  });

  /**
   * The API's own clock checks of a batch (apps/api entry offline-sync.service, tolerance 5
   * minutes): a snapshot after its receipt is refused; an item after its receipt or before the
   * snapshot is rejected.
   */
  function clockCheckingSync(serviceNow: () => Date, outcomes: string[]) {
    const tolerance = 5 * 60_000;
    return (request: FakeRequest) => {
      const body = request.body as {
        snapshot: { takenAt: string };
        items: { clientObservationId: string; kind: string; observedAt: string }[];
      };
      const received = serviceNow().getTime();
      const snapshotAt = Date.parse(body.snapshot.takenAt);
      if (snapshotAt > received + tolerance) {
        outcomes.push('refused: snapshot_in_future');
        return fakeResponse(
          400,
          apiErrorBody('VALIDATION_FAILED', { details: { code: 'snapshot_in_future' } }),
        );
      }
      const items = body.items.map((i) => {
        const at = Date.parse(i.observedAt);
        const reason =
          at > received + tolerance
            ? 'observed_in_future'
            : at < snapshotAt - tolerance
              ? 'observed_before_snapshot'
              : null;
        outcomes.push(reason ?? 'accepted');
        return {
          clientObservationId: i.clientObservationId,
          kind: i.kind,
          outcome: reason ? 'rejected' : 'accepted',
          reason,
        };
      });
      return fakeResponse(201, syncBatch(items));
    };
  }

  it.each([
    ['10 minutes slow', 10],
    ['10 minutes fast', -10],
  ])(
    '§4.15 / SPK-AT-018: with a device clock %s, an observation queued offline is accepted by the service’s clock checks',
    async (_label, serviceAheadMinutes) => {
      const user = userEvent.setup();
      let device = TEST_NOW;
      const serviceNow = () => new Date(device.getTime() + serviceAheadMinutes * 60_000);
      const outcomes: string[] = [];
      const app = createTestApp({
        now: () => device,
        routes: routes({
          'GET /attendance': () =>
            fakeResponse(200, attendance([ALEX_PRESENT]).body, {
              Date: serviceNow().toUTCString(),
            }),
          'POST /offline-sync': clockCheckingSync(serviceNow, outcomes),
        }),
      });
      render(app.at(SESSION_URL));
      const blake = await screen.findByRole('listitem', { name: 'Blake Rivera' });
      act(() => app.connectivity.set(false));
      device = new Date(TEST_NOW.getTime() + 2 * 60_000);
      await user.click(within(blake).getByRole('button', { name: 'Late: Blake Rivera' }));
      await within(blake).findByText('Queued on this device: Late (not yet recorded)');
      device = new Date(TEST_NOW.getTime() + 5 * 60_000);
      act(() => app.connectivity.set(true));
      await waitFor(() => expect(outcomes).toHaveLength(1));
      expect(outcomes).toEqual(['accepted']);
      const sent = app.fake.requests.find((r) => r.route === '/offline-sync')?.body as {
        snapshot: { takenAt: string };
        items: { observedAt: string }[];
      };
      // Both times are the service's: the roster read and the tap two minutes later.
      const serviceAtLoad = TEST_NOW.getTime() + serviceAheadMinutes * 60_000;
      expect(sent.snapshot.takenAt).toBe(new Date(serviceAtLoad).toISOString());
      expect(sent.items[0]?.observedAt).toBe(new Date(serviceAtLoad + 2 * 60_000).toISOString());
    },
  );

  it('lists today’s events to choose from when no activity is given', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /events': {
          status: 200,
          body: {
            items: [
              {
                id: '0192f1a0-0000-7000-8000-0000000000ee',
                facilityId: FACILITY_A,
                kind: 'game',
                title: 'U12 Red v Blue',
                scheduledStart: '2026-10-24T18:00:00.000Z',
                scheduledEnd: '2026-10-24T19:00:00.000Z',
                timezone: 'America/Los_Angeles',
                status: 'published',
              },
            ],
            nextCursor: null,
          },
        },
      }),
    });
    render(app.at('/arrival/attendance'));
    const link = await screen.findByRole('link', { name: 'U12 Red v Blue' });
    expect(link).toHaveAttribute(
      'href',
      '/arrival/attendance?type=event&eventId=0192f1a0-0000-7000-8000-0000000000ee',
    );
    const events = app.fake.requests.find((r) => r.route === '/events');
    expect(events?.query.facilityId).toBe(FACILITY_A);
    expect(events?.query.start).toBe('2026-10-24T12:00:00.000Z');
  });

  it('CAT-01 / SPK-SCHED-008: lists today’s program sessions in the facility time zone to open', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /events': { status: 200, body: { items: [], nextCursor: null } },
        'GET /sessions': {
          status: 200,
          body: {
            items: [
              {
                sessionId: SESSION_1,
                offeringId: OFFERING,
                offeringName: 'Junior skills',
                sequence: 3,
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
      }),
    });
    render(app.at('/arrival/attendance'));
    const sessions = await screen.findByRole('list', { name: 'Sessions today' });
    const link = within(sessions).getByRole('link', { name: 'Junior skills, session 3' });
    expect(link).toHaveAttribute(
      'href',
      `/arrival/attendance?type=session&offeringId=${OFFERING}&sessionId=${SESSION_1}`,
    );
    // Shown in the facility zone (PDT), not the device zone.
    expect(within(sessions).getByText(/09:00 GMT-7|09:00 PDT/)).toBeInTheDocument();
    const read = app.fake.requests.find((r) => r.route === '/sessions');
    expect(read?.query).toMatchObject({ facilityId: FACILITY_A, status: 'scheduled' });
  });

  it('shows today’s sessions as not available when the session list is refused', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /events': { status: 200, body: { items: [], nextCursor: null } },
        'GET /sessions': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      }),
    });
    render(app.at('/arrival/attendance'));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
    expect(await screen.findByText('No activity in progress')).toBeInTheDocument();
  });
});
