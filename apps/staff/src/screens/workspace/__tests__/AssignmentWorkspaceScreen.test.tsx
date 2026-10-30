/**
 * SCR-W-02 Assignment offer and response, SCR-W-03 Activity detail, SCR-W-10 connectivity state
 * (SPK-UX-007, SPK-STAFF-002, SPK-STAFF-003, SPK-AT-012, SPK-READY-001, SPK-COMMS-005, §4.15):
 * only the viewer's assignments; actions only where the API lists them, with the expected
 * revision; an overlap refusal with its code; readiness counts without player details; the
 * field-limited match sheet for an accepted official (CMP-06); times in the facility zone (WRK-01).
 */
import { apiErrorBody, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { OFFLINE_QUEUE_STORAGE_KEY } from '../../../features/operations/offline/queue';
import {
  ASSIGNMENT_1,
  FIXTURE_1,
  OFFERING,
  SESSION_1,
  assignmentRecord,
  myAssignments,
  oneFacilityMe,
  workspaceItem,
} from '../../../features/operations/testing';
import { FACILITY_A, TEST_SESSION, createTestApp } from '../../../testing/test-app';

const OFFERED = workspaceItem(assignmentRecord({ status: 'offered', revision: 5 }), [
  'accept',
  'decline',
]);
const PATH = `/workspace/assignments/${ASSIGNMENT_1}`;

const READINESS = {
  status: 200,
  body: {
    fixtureId: FIXTURE_1,
    fixtureStatus: 'scheduled',
    status: 'warning',
    evaluatedAt: '2026-10-24T11:55:00.000Z',
    scheduledStart: '2026-10-24T18:00:00.000Z',
    checks: [
      { name: 'officials', status: 'warning', issueCount: 1 },
      { name: 'rosters', status: 'ready', issueCount: 0 },
    ],
    issues: [
      {
        code: 'official_not_accepted',
        severity: 'warning',
        message: 'The referee has not accepted yet.',
        source: { type: 'assignment', id: ASSIGNMENT_1 },
        responsibleRole: 'league_manager',
        requiredAction: 'confirm_official',
        lastEvaluatedAt: '2026-10-24T11:55:00.000Z',
        deadline: null,
      },
    ],
    sides: [
      {
        teamEntryId: '0192f1a0-0000-7000-8000-0000000004a1',
        teamName: 'Red',
        entryStatus: 'approved',
        rosterSize: 12,
        eligiblePlayers: 11,
        unknownPlayers: 1,
        minimumPlayers: 7,
      },
    ],
  },
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /me/assignments': myAssignments([OFFERED]),
    'GET /fixtures/{id}/readiness': READINESS,
    'GET /me/inbox': {
      status: 200,
      body: {
        items: [
          {
            attemptId: '0192f1a0-0000-7000-8000-0000000004b1',
            notificationId: '0192f1a0-0000-7000-8000-0000000004b2',
            kind: 'schedule_changed',
            category: 'operational',
            title: 'Kickoff moved',
            body: 'New time.',
            facilityId: FACILITY_A,
            subject: { type: 'fixture', id: FIXTURE_1 },
            detailsBefore: { summary: '17:00 on pitch 2' },
            detailsAfter: { summary: '18:00 on pitch 1' },
            status: 'delivered',
            deliveredAt: null,
            readAt: null,
            acknowledgedAt: null,
            supersededByNotificationId: null,
            createdAt: '2026-10-24T09:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    },
    ...extra,
  };
}

describe('SCR-W-02 / SCR-W-03 AssignmentWorkspaceScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('opens from My assignments and shows readiness and changes without player details', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/workspace'));
    await user.click(await screen.findByRole('link', { name: 'U12 Red v Blue' }));
    expect(
      await screen.findByRole('heading', { name: 'U12 Red v Blue', level: 2 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Readiness: Warning')).toBeInTheDocument();
    expect(screen.getByText(/The referee has not accepted yet/)).toBeInTheDocument();
    expect(
      screen.getByText(/Red: 11 eligible of 12 on the roster, 1 not yet known/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Kickoff moved: was 17:00 on pitch 2, now 18:00 on pitch 1/),
    ).toBeInTheDocument();
    expect(screen.getByText('Red (home) v Blue (away)')).toBeInTheDocument();
  });

  it('accepts only where the API lists it, with the expected revision; an overlap is refused with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /assignments/{id}/accept': {
          status: 409,
          body: apiErrorBody('RESOURCE_CONFLICT', {
            message: 'You already accepted an assignment that overlaps this one.',
            nextAction: 'resolve_conflict',
          }),
        },
      }),
    });
    render(app.at(PATH));
    expect(await screen.findByText('Offered: response needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(
      await screen.findByText('You already accepted an assignment that overlaps this one.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
    const accept = app.fake.requests.find((r) => r.route === '/assignments/{id}/accept');
    expect(accept?.body).toEqual({ expectedRevision: 5 });
  });

  it('SPK-AT-012: declines with an optional reason and shows "Declined"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /assignments/{id}/decline': {
          status: 200,
          body: {
            assignment: assignmentRecord({ status: 'declined' }),
            operationId: null,
            uncovered: null,
          },
        },
      }),
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Unwell');
    await user.click(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByTestId('command-success')).toHaveTextContent('Declined');
    expect(app.fake.requests.find((r) => r.route === '/assignments/{id}/decline')?.body).toEqual({
      expectedRevision: 5,
      reason: 'Unwell',
    });
  });

  it('requires a reason to withdraw after accepting', async () => {
    const user = userEvent.setup();
    const accepted = workspaceItem(assignmentRecord({ status: 'accepted', revision: 6 }), [
      'withdraw',
    ]);
    const app = createTestApp({
      routes: routes({
        'GET /me/assignments': myAssignments([accepted]),
        'POST /assignments/{id}/withdraw': {
          status: 200,
          body: {
            assignment: assignmentRecord({ status: 'withdrawn' }),
            operationId: null,
            uncovered: null,
          },
        },
      }),
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(screen.getByText('A reason is required.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason for withdrawing'), 'Family emergency');
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/assignments/{id}/withdraw')?.body).toEqual(
        {
          expectedRevision: 6,
          reason: 'Family emergency',
        },
      ),
    );
    // Accepted work links to attendance and the match report.
    expect(screen.getByRole('link', { name: 'Match report' })).toHaveAttribute(
      'href',
      `${PATH}/report`,
    );
  });

  it('keeps the offer visible offline and disables responding', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    await screen.findByText('Offered: response needed');
    act(() => app.connectivity.set(false));
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(
      screen.getByText('Responding needs a connection. The offer stays here.'),
    ).toBeInTheDocument();
  });

  it('shows an assignment that is not the viewer’s as not available', async () => {
    const app = createTestApp({ routes: routes({ 'GET /me/assignments': myAssignments([]) }) });
    render(app.at(PATH));
    expect(await screen.findByText(/This assignment is not available/)).toBeInTheDocument();
  });

  it('SCR-W-10: shows queued observations on the workspace and links to their review', async () => {
    const session = assignmentRecord({
      kind: 'coach',
      targetType: 'session',
      targetId: SESSION_1,
      offeringId: OFFERING,
      status: 'accepted',
    });
    window.localStorage.setItem(
      OFFLINE_QUEUE_STORAGE_KEY,
      JSON.stringify({
        deviceId: 'staff-web-device-1',
        pending: [
          {
            item: {
              kind: 'attendance',
              clientObservationId: '0192f1a0-0000-7000-8000-0000000004c1',
              observedAt: '2026-10-24T11:45:00.000Z',
              personId: '0192f1a0-0000-7000-8000-0000000004c2',
              activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
              observedState: 'present',
            },
            facilityId: FACILITY_A,
            snapshot: { reference: 'roster-1', takenAt: '2026-10-24T11:30:00.000Z' },
            queuedBy: TEST_SESSION.accountId,
            queuedAt: '2026-10-24T11:45:00.000Z',
            context: 'Record attendance',
            batchId: null,
          },
        ],
        review: [],
        lastSync: null,
      }),
    );
    const app = createTestApp({
      routes: routes({ 'GET /me/assignments': myAssignments([workspaceItem(session, [])]) }),
    });
    render(app.at('/workspace'));
    const status = await screen.findByTestId('offline-queue-status');
    expect(
      within(status).getByText('1 observation queued on this device (not yet recorded)'),
    ).toBeInTheDocument();
    expect(within(status).getByRole('button', { name: 'Synchronise now' })).toBeInTheDocument();
  });

  it('CMP-06 / SPK-UX-007: an accepted official sees the field-limited player list', async () => {
    const accepted = workspaceItem(assignmentRecord({ status: 'accepted', revision: 6 }), [
      'withdraw',
    ]);
    const app = createTestApp({
      routes: routes({
        'GET /me/assignments': myAssignments([accepted]),
        'GET /fixtures/{id}/match-sheet': {
          status: 200,
          body: {
            fixtureId: FIXTURE_1,
            scheduledStart: '2026-10-24T18:00:00.000Z',
            status: 'scheduled',
            venue: null,
            view: 'full',
            sides: [
              {
                entryId: '0192f1a0-0000-7000-8000-0000000004a1',
                teamName: 'Red',
                players: [
                  {
                    personId: '0192f1a0-0000-7000-8000-0000000007a1',
                    displayName: 'Jo Park',
                    jerseyNumber: 7,
                    playingStatus: 'guest',
                    roles: ['captain', 'member'],
                  },
                ],
              },
              { entryId: '0192f1a0-0000-7000-8000-0000000004a2', teamName: 'Blue', players: [] },
            ],
          },
        },
      }),
    });
    render(app.at(PATH));
    const players = await screen.findByRole('list', { name: 'Players: Red' });
    expect(within(players).getByText('#7 Jo Park (Captain, Guest)')).toBeInTheDocument();
    expect(screen.getByText('No player listed.')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/fixtures/{id}/match-sheet')?.params).toEqual(
      { id: FIXTURE_1 },
    );
    // WRK-01 / SPK-SCHED-008: the activity's time in its facility's zone.
    expect(screen.getByText(/11:00 (GMT-7|PDT)/)).toBeInTheDocument();
  });

  it('reads no player list before the official has accepted, and shows a refused one as not available', async () => {
    const { unmount } = render(createTestApp({ routes: routes() }).at(PATH));
    expect(await screen.findByText('Readiness: Warning')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Players' })).toBeNull();
    unmount();
    const accepted = workspaceItem(assignmentRecord({ status: 'accepted' }), []);
    const app = createTestApp({
      routes: routes({
        'GET /me/assignments': myAssignments([accepted]),
        'GET /fixtures/{id}/match-sheet': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
        },
      }),
    });
    render(app.at(PATH));
    const heading = await screen.findByRole('heading', { name: 'Players' });
    expect(
      await within(heading.parentElement as HTMLElement).findByTestId('state-unavailable'),
    ).toBeInTheDocument();
  });
});
