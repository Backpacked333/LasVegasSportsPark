/**
 * SCR-W-04 Session attendance (coach), SCR-W-05 Match report (cards from the match sheet,
 * CMP-06), SCR-W-06 Permitted communication, SCR-W-08 Hours and fee records, SCR-W-09 Supervised
 * release (coach; collector check first, ENT-02) (SPK-UX-007, SPK-ENTRY-001, SPK-ENTRY-005,
 * SPK-ENTRY-007, SPK-STAFF-005, SPK-STAFF-006, SPK-RESULT-001, SPK-DISC-001, §1.7, DEC-012,
 * DEC-065). SCR-W-07 is tested in assessments/__tests__.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_1,
  CHILD_1,
  FIXTURE_1,
  OFFERING,
  SESSION_1,
  assignmentRecord,
  feeSubmission,
  myAssignments,
  nameEntry,
  oneFacilityMe,
  personNames,
  workspaceItem,
} from '../../../features/operations/testing';
import { createTestApp } from '../../../testing/test-app';

const BASE = `/workspace/assignments/${ASSIGNMENT_1}`;
const SESSION_ASSIGNMENT = assignmentRecord({
  kind: 'coach',
  targetType: 'session',
  targetId: SESSION_1,
  offeringId: OFFERING,
  schedulingEventId: null,
  targetTitle: 'Junior skills',
  role: 'head_coach',
  status: 'accepted',
});
const FIXTURE_ASSIGNMENT = assignmentRecord({ status: 'accepted' });

function routes(
  items: unknown[],
  extra: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /me/assignments': myAssignments(items),
    'GET /person-names': personNames([nameEntry(CHILD_1, 'Alex', 'Rivera')]),
    ...extra,
  };
}

describe('SCR-W-04 WorkspaceAttendanceScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('records attendance for the coach’s assigned session', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                effectiveState: null,
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
        'GET /enrollments': {
          status: 403,
          body: { code: 'ACCESS_DENIED', message: 'x', nextAction: 'contact_support' },
        },
        'GET /session-bookings': {
          status: 403,
          body: { code: 'ACCESS_DENIED', message: 'x', nextAction: 'contact_support' },
        },
        'POST /attendance-observations': {
          status: 201,
          body: { observation: {}, duplicate: false, conflict: null },
        },
      }),
    });
    render(app.at(`${BASE}/attendance`));
    const alex = await screen.findByRole('listitem', { name: 'Alex Rivera' });
    expect(
      screen.getByText(/expected participant list is not available to you/),
    ).toBeInTheDocument();
    await user.click(within(alex).getByRole('button', { name: 'Present: Alex Rivera' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/attendance-observations')?.body).toEqual({
        personId: CHILD_1,
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
        observedState: 'present',
      }),
    );
    expect(app.fake.requests.find((r) => r.route === '/attendance')?.query).toEqual({
      activityType: 'session',
      activityId: SESSION_1,
      offeringId: OFFERING,
    });
  });
});

describe('SCR-W-04 a fast second tap (SPK-ENTRY-005)', () => {
  beforeEach(() => window.localStorage.clear());

  it('corrects the observation just recorded instead of sending a second first observation', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        // The refetch has not caught up: the person still shows no current observation.
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                effectiveState: null,
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
        'POST /attendance-observations': {
          status: 201,
          body: {
            observation: { id: '0192f1a0-0000-7000-8000-0000000006b1', observedState: 'present' },
            duplicate: false,
            conflict: null,
          },
        },
      }),
    });
    render(app.at(`${BASE}/attendance`));
    const alex = await screen.findByRole('listitem', { name: 'Alex Rivera' });
    await user.click(within(alex).getByRole('button', { name: 'Present: Alex Rivera' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/attendance-observations')).toHaveLength(
        1,
      ),
    );
    await user.click(within(alex).getByRole('button', { name: 'Late: Alex Rivera' }));
    expect(
      await screen.findByRole('form', { name: 'Correct attendance for Alex Rivera' }),
    ).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/attendance-observations')).toHaveLength(1);
  });
});

describe('SCR-W-05 MatchReportScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-STAFF-005: submits scores and an incident as a provisional result revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
        'POST /fixtures/{id}/results': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-0000000005a1',
            fixtureId: FIXTURE_1,
            revisionNo: 1,
            status: 'submitted',
            classification: 'completed',
            homeScore: 2,
            awayScore: 1,
            submittedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Referee' },
            submittedAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(within(form).getByText('Choose how the match ended.')).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'Completed' }));
    await user.type(within(form).getByLabelText('Red score'), '2');
    await user.type(within(form).getByLabelText('Blue score'), '1');
    await user.click(within(form).getByRole('button', { name: 'Add an incident' }));
    await user.selectOptions(within(form).getByLabelText('Incident 1 kind'), 'misconduct');
    await user.selectOptions(within(form).getByLabelText('Incident 1 severity'), 'medium');
    await user.type(within(form).getByLabelText('Incident 1 summary'), 'Dissent at half time');
    await user.type(
      within(form).getByLabelText('Incident 1 narrative (restricted)'),
      'Captain argued with the assistant.',
    );
    // No match sheet for this viewer: cards are not offered.
    expect(within(form).getByText('Cards are not available')).toBeInTheDocument();
    expect(within(form).getByText(/DEC-065/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(await within(form).findByTestId('command-success')).toHaveTextContent(
      'Submitted (provisional)',
    );
    const post = app.fake.requests.find(
      (r) => r.route === '/fixtures/{id}/results' && r.method === 'POST',
    );
    expect(post?.params).toEqual({ id: FIXTURE_1 });
    expect(post?.body).toEqual({
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      cards: [],
      incidents: [
        {
          kind: 'misconduct',
          severity: 'medium',
          summary: 'Dissent at half time',
          narrative: 'Captain argued with the assistant.',
        },
      ],
    });
  });

  it('keeps the report offline and disables submitting', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(within(form).getByRole('radio', { name: 'Forfeit' }));
    act(() => app.connectivity.set(false));
    expect(within(form).getByRole('button', { name: 'Submit report' })).toBeDisabled();
    expect(within(form).getByRole('radio', { name: 'Forfeit' })).toBeChecked();
    expect(within(form).getByText(/queued submission is pending DEC-032/)).toBeInTheDocument();
  });
});

describe('SCR-W-05 MatchReportScreen (SubmitResultBody rules)', () => {
  beforeEach(() => window.localStorage.clear());

  it('a forfeit report sends both scores and the forfeiting team', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
        'POST /fixtures/{id}/results': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-0000000005a2',
            fixtureId: FIXTURE_1,
            revisionNo: 1,
            status: 'submitted',
            classification: 'forfeit',
            homeScore: 3,
            awayScore: 0,
            submittedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Referee' },
            submittedAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(within(form).getByRole('radio', { name: 'Forfeit' }));
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Enter both scores');
    await user.type(within(form).getByLabelText('Red score'), '3');
    await user.type(within(form).getByLabelText('Blue score'), '0');
    const team = within(form).getByLabelText('Team that forfeited');
    await user.selectOptions(team, within(team).getAllByRole('option')[2] as HTMLOptionElement);
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    await within(form).findByTestId('command-success');
    const post = app.fake.requests.find(
      (r) => r.route === '/fixtures/{id}/results' && r.method === 'POST',
    );
    expect(post?.body).toMatchObject({ classification: 'forfeit', homeScore: 3, awayScore: 0 });
    expect((post?.body as { forfeitingEntryId?: string }).forfeitingEntryId).toBeTruthy();
  });

  it('refuses an abandonment minute over 200 with an announced message', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(within(form).getByRole('radio', { name: 'Abandoned' }));
    await user.type(within(form).getByLabelText('Minute the match stopped'), '250');
    await user.type(within(form).getByLabelText('Reason for abandonment'), 'Lightning');
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('(0 to 200)');
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('SCR-W-04 / SCR-W-09 for a coach who may not read child records', () => {
  beforeEach(() => window.localStorage.clear());

  const coachMe = () => {
    const me = oneFacilityMe();
    me.body.principal.staffRoles = ['coach'];
    return me;
  };
  const presentAttendance = {
    status: 200,
    body: {
      activity: {
        type: 'session',
        id: SESSION_1,
        offeringId: OFFERING,
        sessionId: SESSION_1,
        eventId: null,
      },
      people: [
        {
          personId: CHILD_1,
          effectiveState: 'present',
          status: 'recorded',
          currentObservationIds: [],
          history: [],
        },
      ],
    },
  };

  it('SCR-W-09: a present child stays offered for release with a reference when the name is not readable', async () => {
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        'GET /me': coachMe(),
        // The names read leaves out a child the coach may not view.
        'GET /person-names': personNames([]),
        'GET /attendance': presentAttendance,
      }),
    });
    render(app.at(`${BASE}/release`));
    expect(
      await screen.findByRole('radio', {
        name: `Participant, name not available (ref ${CHILD_1.slice(0, 8)})`,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No child is recorded present or late/)).toBeNull();
  });
});

describe('SCR-W-06 not offered by the API', () => {
  beforeEach(() => window.localStorage.clear());

  it('SCR-W-06: messaging from the workspace is shown as not available with the pending decision', async () => {
    const app = createTestApp({ routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])]) });
    render(app.at(`${BASE}/message`));
    expect(await screen.findByText('Messaging is not available here yet')).toBeInTheDocument();
    expect(screen.getByText(/DEC-012, DEC-062/)).toBeInTheDocument();
  });
});

describe('SCR-W-08 MyFeesScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-STAFF-006: submits an hourly fee for a completed assignment and never says "Paid"', async () => {
    const user = userEvent.setup();
    const completed = assignmentRecord({ status: 'completed' });
    const other = assignmentRecord({
      id: '0192f1a0-0000-7000-8000-0000000005b9',
      status: 'completed',
      targetTitle: 'U10 Gold v Green',
    });
    const app = createTestApp({
      routes: routes(
        [
          workspaceItem(completed, ['submit_fee']),
          workspaceItem(
            other,
            [],
            feeSubmission({
              status: 'exported',
              approvedAmountMinor: 3000,
              exportBatchId: '0192f1a0-0000-7000-8000-0000000005c1',
              exportedAt: '2026-10-24T08:00:00.000Z',
            }),
          ),
        ],
        { 'POST /fee-submissions': { status: 201, body: feeSubmission() } },
      ),
    });
    render(app.at('/workspace/fees'));
    const exported = await screen.findByRole('listitem', { name: 'U10 Gold v Green' });
    expect(within(exported).getByText('Exported')).toBeInTheDocument();
    expect(screen.queryByText(/\bPaid\b/)).toBeNull();
    const form = screen.getByRole('form', { name: 'Submit hours or a fee for U12 Red v Blue' });
    await user.click(within(form).getByRole('button', { name: 'Submit' }));
    expect(
      within(form).getByText('Enter the three-letter currency code, for example USD.'),
    ).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Currency'), 'usd');
    await user.selectOptions(within(form).getByLabelText('Rate basis'), 'hourly');
    await user.type(within(form).getByLabelText('Rate per hour'), '20.00');
    await user.type(within(form).getByLabelText('Minutes worked'), '90');
    await user.type(within(form).getByLabelText('Amount submitted'), '30.00');
    await user.click(within(form).getByRole('button', { name: 'Submit' }));
    expect(await screen.findByTestId('command-success')).toHaveTextContent('Submitted');
    expect(app.fake.requests.find((r) => r.route === '/fee-submissions')?.body).toEqual({
      assignmentId: ASSIGNMENT_1,
      rateBasis: { kind: 'hourly', rateMinor: 2000, minutes: 90 },
      submittedAmountMinor: 3000,
      currency: 'USD',
    });
  });
});

describe('SCR-W-09 WorkspaceReleaseScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('lists the children present in the coach’s session for release', async () => {
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                effectiveState: 'present',
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
      }),
    });
    render(app.at(`${BASE}/release`));
    expect(await screen.findByRole('radio', { name: 'Alex Rivera' })).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/visits')).toBe(false);
  });
});

describe('SCR-W-05 cards from the match sheet (CMP-06)', () => {
  beforeEach(() => window.localStorage.clear());

  const PLAYER = '0192f1a0-0000-7000-8000-0000000007a1';
  const sheet = {
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
            personId: PLAYER,
            displayName: 'Jo Park',
            jerseyNumber: 7,
            playingStatus: 'active',
            roles: ['captain'],
          },
        ],
      },
      { entryId: '0192f1a0-0000-7000-8000-0000000004a2', teamName: 'Blue', players: [] },
    ],
  };

  it('SPK-DISC-001: records a card against a player of the match sheet', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
        'GET /fixtures/{id}/match-sheet': { status: 200, body: sheet },
        'POST /fixtures/{id}/results': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-0000000005a3',
            fixtureId: FIXTURE_1,
            revisionNo: 1,
            status: 'submitted',
            classification: 'completed',
            homeScore: 1,
            awayScore: 0,
            submittedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Referee' },
            submittedAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(await within(form).findByRole('button', { name: 'Add a card' }));
    await user.click(within(form).getByRole('radio', { name: 'Completed' }));
    await user.type(within(form).getByLabelText('Red score'), '1');
    await user.type(within(form).getByLabelText('Blue score'), '0');
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(
      within(form).getByText('Each card needs a team, a player and a kind.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    await user.selectOptions(within(form).getByLabelText('Card 1 team'), sheet.sides[0]!.entryId);
    await user.selectOptions(within(form).getByLabelText('Card 1 player'), PLAYER);
    await user.selectOptions(within(form).getByLabelText('Card 1 kind'), 'yellow');
    await user.type(within(form).getByLabelText('Card 1 minute (optional)'), '34');
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    await within(form).findByTestId('command-success');
    const post = app.fake.requests.find(
      (r) => r.route === '/fixtures/{id}/results' && r.method === 'POST',
    );
    expect((post?.body as { cards: unknown[] }).cards).toEqual([
      {
        teamEntryId: sheet.sides[0]!.entryId,
        personId: PLAYER,
        kind: 'yellow',
        minute: 34,
      },
    ]);
  });

  it('offers no card on a captain’s view without person ids', async () => {
    const app = createTestApp({
      routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])], {
        'GET /fixtures/{id}/results': { status: 200, body: [] },
        'GET /fixtures/{id}/match-sheet': {
          status: 200,
          body: {
            ...sheet,
            view: 'captain',
            sides: sheet.sides.map((side) => ({
              ...side,
              players: side.players.map((p) => ({
                ...p,
                personId: null,
                playingStatus: null,
                roles: [],
              })),
            })),
          },
        },
      }),
    });
    render(app.at(`${BASE}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    expect(await within(form).findByText('Cards are not available')).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Add a card' })).toBeNull();
  });
});

describe('SCR-W-09 collector check (ENT-02)', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-AT-016: the coach checks the collector by pass before recording; a pass without authority names nobody', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                givenName: 'Alex',
                familyName: 'Rivera',
                displayName: 'Alex Rivera',
                effectiveState: 'present',
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
        'POST /releases/collector-checks': {
          status: 200,
          body: {
            mayCollect: false,
            collector: null,
            checkedAt: '2026-10-24T12:00:00.000Z',
            restrictions: [],
          },
        },
      }),
    });
    render(app.at(`${BASE}/release`));
    await user.click(await screen.findByRole('radio', { name: 'Alex Rivera' }));
    await user.type(
      screen.getByLabelText("Collecting person's pass reference"),
      'spp_0123456789abcdef',
    );
    await user.click(screen.getByRole('button', { name: 'Check the collector' }));
    expect(await screen.findByText('Not confirmed to collect Alex Rivera')).toBeInTheDocument();
    const check = app.fake.requests.find((r) => r.route === '/releases/collector-checks');
    expect(check?.body).toMatchObject({
      activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
      participantPersonId: CHILD_1,
    });
    // The desk-only pass scan is never used from the workspace.
    expect(app.fake.requests.some((r) => r.route === '/passes/scan')).toBe(false);
  });

  it('shows a refused check (not the assigned coach) as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes([workspaceItem(SESSION_ASSIGNMENT, [])], {
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                givenName: 'Alex',
                familyName: 'Rivera',
                displayName: 'Alex Rivera',
                effectiveState: 'late',
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
        'POST /releases/collector-checks': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(app.at(`${BASE}/release`));
    await user.click(await screen.findByRole('radio', { name: 'Alex Rivera' }));
    await user.type(
      screen.getByLabelText("Collecting person's pass reference"),
      'spp_0123456789abcdef',
    );
    await user.click(screen.getByRole('button', { name: 'Check the collector' }));
    const unavailable = await screen.findByTestId('command-unavailable');
    expect(unavailable).toHaveTextContent('This check is not available');
    expect(unavailable).toHaveTextContent('Error code: NOT_FOUND');
  });
});
