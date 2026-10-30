/**
 * SCR-S-33 Assignment management and replacement: SPK-STAFF-002 (proposed and offered never
 * cover), SPK-STAFF-003 (overlap and turnaround refusals shown with the API's code), SPK-AT-012
 * (replacement after a decline; the uncovered slot is escalated), §4.9 expected revision and
 * STALE_REVISION reload, protected NOT_FOUND as not available; the person is chosen from the
 * staff directory (ID-05) and transitions are the API's `availableActions` (WRK-01).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_1,
  FIXTURE_1,
  OFFICIAL,
  assignmentRecord,
  nameEntry,
  oneFacilityMe,
  personNames,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const REPLACEMENT = '0192f1a0-0000-7000-8000-0000000001a2';
const CANDIDATE = '0192f1a0-0000-7000-8000-000000000002';

function report(rows: Record<string, unknown>[]) {
  return {
    status: 200,
    body: {
      report: {
        key: 'uncovered_assignments',
        title: 'Uncovered assignments',
        requirementIds: [],
        accessAction: 'x',
        exportAction: 'y',
      },
      runId: null,
      asOf: '2026-10-24T12:00:00.000Z',
      producedAt: '2026-10-24T12:00:00.000Z',
      scope: {
        facilityId: FACILITY_A,
        timezone: 'America/Los_Angeles',
        from: '2026-10-24',
        to: '2026-10-31',
      },
      parameters: {},
      freshness: { class: 'live', pointInTime: 'partial', note: '' },
      metrics: [],
      disclosures: [],
      values: [],
      columns: [],
      rows,
    },
  };
}

const UNCOVERED_ROW = {
  targetType: 'fixture',
  targetId: FIXTURE_1,
  title: 'U12 Red v Blue',
  start: '2026-10-24T18:00:00.000Z',
  requirementId: '0192f1a0-0000-7000-8000-0000000001c1',
  kind: 'official',
  role: 'referee',
  required: 1,
  accepted: 0,
  offered: 1,
  proposed: 0,
  uncovered: 1,
};

/** `GET /v1/assignments` items carry the events the viewer may perform now (WRK-01). */
function staffList(items: Record<string, unknown>[], availableActions: string[]) {
  return {
    status: 200,
    body: { items: items.map((a) => ({ ...a, availableActions })), nextCursor: null },
  };
}

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /reports/uncovered-assignments': report([UNCOVERED_ROW]),
    'GET /assignments': staffList(
      [assignmentRecord({ status: 'proposed' })],
      ['offer', 'withdraw'],
    ),
    'GET /person-names': personNames([
      nameEntry(OFFICIAL, 'Jordan', 'Lee', 'adult'),
      nameEntry(CANDIDATE, 'Casey', 'Lee', 'adult'),
    ]),
    'GET /staff-directory': {
      status: 200,
      body: {
        items: [
          {
            personId: OFFICIAL,
            displayName: 'Jordan Lee',
            roles: ['official'],
            facilityIds: [],
            scopes: [{ role: 'official', facilityIds: [] }],
          },
        ],
        nextCursor: null,
      },
    },
    ...extra,
  };
}

describe('SCR-S-33 AssignmentsScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-STAFF-002: lists uncovered slots and says that offered and proposed do not cover', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/staff'));
    const slots = await screen.findByRole('list', { name: 'Uncovered slots' });
    expect(within(slots).getByText('1 uncovered')).toBeInTheDocument();
    expect(within(slots).getByText(/offered 1 and proposed 0 do not cover/)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Assignments' });
    expect(within(list).getByText('Proposed (not covering)')).toBeInTheDocument();
    expect(await within(list).findByText(/Jordan Lee/)).toBeInTheDocument();
    const reportRequest = app.fake.requests.find(
      (r) => r.route === '/reports/uncovered-assignments',
    );
    expect(reportRequest?.query).toMatchObject({
      facilityId: FACILITY_A,
      from: '2026-10-24',
      to: '2026-10-31',
    });
  });

  it('SPK-STAFF-003: proposes from an uncovered slot and shows an overlap refusal with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /assignments': {
          status: 409,
          body: apiErrorBody('RESOURCE_CONFLICT', {
            message:
              'Jordan Lee is committed to another assignment until 19:30 including turnaround.',
            nextAction: 'resolve_conflict',
          }),
        },
      }),
    });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Propose someone for U12 Red v Blue, Referee' }),
    );
    expect(screen.getByLabelText('Role')).toHaveValue('referee');
    expect(screen.getByLabelText('Fixture, event or session (record id)')).toHaveValue(FIXTURE_1);
    await user.click(screen.getByRole('button', { name: 'Propose and offer' }));
    expect(screen.getByText('Choose the person from the staff directory.')).toBeInTheDocument();
    // ID-05: officials only for an official slot, at the selected facility.
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    const directory = app.fake.requests.find((r) => r.route === '/staff-directory');
    expect(directory?.query).toMatchObject({ role: 'official', facilityId: FACILITY_A });
    await user.selectOptions(picker, OFFICIAL);
    await user.click(screen.getByRole('button', { name: 'Propose and offer' }));
    expect(await screen.findByText(/committed to another assignment/)).toBeInTheDocument();
    expect(screen.getByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST');
    expect(post?.body).toEqual({
      personId: OFFICIAL,
      kind: 'official',
      targetType: 'fixture',
      targetId: FIXTURE_1,
      role: 'referee',
      engagement: 'regular',
      offer: true,
    });
  });

  it('withdraws with a required reason and the expected revision; STALE_REVISION reloads', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': { status: 200, body: assignmentRecord() },
        'GET /assignments': staffList([assignmentRecord()], ['withdraw']),
        'POST /assignments/{id}/withdraw': {
          status: 409,
          body: apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }),
        },
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    expect(await screen.findByText('Offered (not covering)')).toBeInTheDocument();
    // Accept and decline belong to the assignee; staff may withdraw an offer.
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const list = app.fake.requests.find((r) => r.route === '/assignments');
    expect(list?.query).toMatchObject({ targetType: 'fixture', targetId: FIXTURE_1 });
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(screen.getByText('A reason is required.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason for withdrawing'), 'Fixture moved');
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    const withdraw = app.fake.requests.find((r) => r.route === '/assignments/{id}/withdraw');
    expect(withdraw?.body).toEqual({ expectedRevision: 4, reason: 'Fixture moved' });
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/assignments/{id}')).toHaveLength(2),
    );
  });

  it('SPK-AT-012: offers the slot of a declined referee to an eligible replacement and shows the escalation', async () => {
    const user = userEvent.setup();
    const declined = assignmentRecord({
      status: 'declined',
      declinedAt: '2026-10-24T11:00:00.000Z',
      declineReason: 'Unwell',
    });
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': { status: 200, body: declined },
        'GET /assignments/{id}/replacements': {
          status: 200,
          body: {
            assignmentId: ASSIGNMENT_1,
            targetType: 'fixture',
            targetId: FIXTURE_1,
            role: 'referee',
            slot: 1,
            scheduledStart: '2026-10-24T18:00:00.000Z',
            scheduledEnd: '2026-10-24T19:00:00.000Z',
            requiredQualifications: ['referee_grade_8'],
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            candidates: [
              {
                personId: CANDIDATE,
                displayName: 'Casey Lee',
                eligible: true,
                reasons: [
                  {
                    code: 'qualified',
                    severity: 'positive',
                    message: 'Holds referee_grade_8',
                    sourceType: null,
                    sourceIds: [],
                  },
                ],
              },
              {
                personId: OFFICIAL,
                displayName: 'Morgan Diaz',
                eligible: false,
                reasons: [
                  {
                    code: 'overlap',
                    severity: 'blocking',
                    message: 'Assigned to another fixture at 18:00',
                    sourceType: 'assignment',
                    sourceIds: [],
                  },
                ],
              },
            ],
          },
        },
        'POST /assignments/{id}/replacements': {
          status: 201,
          body: {
            original: declined,
            replacement: assignmentRecord({
              id: REPLACEMENT,
              personId: CANDIDATE,
              status: 'offered',
              engagement: 'substitute',
              replacesAssignmentId: ASSIGNMENT_1,
            }),
            operationId: '0192f1a0-0000-7000-8000-0000000001d1',
            uncovered: {
              exceptionId: '0192f1a0-0000-7000-8000-0000000001e9',
              role: 'referee',
              slot: 1,
              startsAt: '2026-10-24T18:00:00.000Z',
            },
          },
        },
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    expect(await screen.findByText(/Declined .*: Unwell/)).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Morgan Diaz/ })).toBeDisabled();
    expect(screen.getByText('Assigned to another fixture at 18:00')).toBeInTheDocument();
    expect(screen.getByText('Blocking')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Casey Lee/ }));
    await user.type(
      screen.getByLabelText('Reason for the replacement'),
      'Original declined on the day',
    );
    await user.click(screen.getByRole('button', { name: 'Offer the slot' }));
    expect(await screen.findByText('Replacement offered (not covering)')).toBeInTheDocument();
    expect(screen.getByText('Slot uncovered: escalated')).toBeInTheDocument();
    const post = app.fake.requests.find(
      (r) => r.route === '/assignments/{id}/replacements' && r.method === 'POST',
    );
    expect(post?.body).toEqual({
      personId: CANDIDATE,
      engagement: 'substitute',
      offer: true,
      withdrawOriginal: false,
      reason: 'Original declined on the day',
      expectedRevision: 4,
    });
  });

  it('shows an assignment the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /assignments/{id}': { status: 404, body: apiErrorBody('NOT_FOUND') } }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });

  it('WRK-01: offers only the transitions the API lists for the viewer', async () => {
    const accepted = assignmentRecord({ status: 'accepted' });
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': { status: 200, body: accepted },
        // The state allows complete and withdraw, but the viewer's roles perform neither here.
        'GET /assignments': staffList([accepted], []),
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assignments')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Mark completed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows the actions read’s failure with its code and Try again', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': { status: 200, body: assignmentRecord() },
        'GET /assignments': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    const section = (await screen.findByRole('heading', { name: 'Change this assignment' }))
      .parentElement as HTMLElement;
    expect(await within(section).findByTestId('state-error')).toHaveTextContent(
      'INTEGRATION_UNAVAILABLE',
    );
    expect(within(section).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
