/**
 * SCR-S-29 Session attendance and corrections: SPK-ENTRY-005 (corrections are new observations
 * with actor, time and a required reason), SPK-ENTRY-008 (counts are not verified occupancy),
 * conflicts kept for review, protected NOT_FOUND shown as not available, §4.15 offline queueing.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHILD_1,
  CHILD_2,
  OFFERING,
  SESSION_1,
  actor,
  oneFacilityMe,
  person,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

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
    'GET /people/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === CHILD_1
          ? person(CHILD_1, 'Alex', 'Rivera').body
          : person(CHILD_2, 'Blake', 'Rivera').body,
      ),
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
});
