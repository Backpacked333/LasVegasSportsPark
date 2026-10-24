/**
 * SCR-W-04 Session attendance (coach), SCR-W-05 Match report, SCR-W-06 Permitted communication,
 * SCR-W-07 Assessments, SCR-W-08 Hours and fee records, SCR-W-09 Supervised release (coach)
 * (SPK-UX-007, SPK-ENTRY-001, SPK-ENTRY-005, SPK-ENTRY-007, SPK-STAFF-005, SPK-STAFF-006,
 * SPK-RESULT-001, §1.7, DEC-012, DEC-054, DEC-065).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
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
  oneFacilityMe,
  person,
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
    'GET /people/{id}': (req) =>
      fakeResponse(200, person(req.params.id ?? '', 'Alex', 'Rivera').body),
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
    expect(within(form).getByText('Cards are not available here yet')).toBeInTheDocument();
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

describe('SCR-W-06 / SCR-W-07 not offered by the API', () => {
  beforeEach(() => window.localStorage.clear());

  it('SCR-W-06: messaging from the workspace is shown as not available with the pending decision', async () => {
    const app = createTestApp({ routes: routes([workspaceItem(FIXTURE_ASSIGNMENT, [])]) });
    render(app.at(`${BASE}/message`));
    expect(await screen.findByText('Messaging is not available here yet')).toBeInTheDocument();
    expect(screen.getByText(/DEC-012, DEC-062/)).toBeInTheDocument();
  });

  it('SCR-W-07: assessments are a pending decision', async () => {
    const app = createTestApp({ routes: routes([]) });
    render(app.at('/workspace/assessments'));
    expect(await screen.findByText(/DEC-054/)).toBeInTheDocument();
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
