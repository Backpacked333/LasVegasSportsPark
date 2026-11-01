/**
 * SCR-S-33 Assignment management and replacement: SPK-STAFF-002 (proposed and offered never
 * cover), SPK-STAFF-003 (overlap and turnaround refusals shown with the API's code), SPK-AT-012
 * (replacement after a decline; the uncovered slot is escalated), §4.9 expected revision and
 * STALE_REVISION reload, protected NOT_FOUND as not available; the person is chosen from the
 * staff directory (ID-05) and transitions are the API's `availableActions` (WRK-01); offline the
 * screens are read-only and nothing is queued (§4.15).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_1,
  FIXTURE_1,
  OFFERING,
  OFFICIAL,
  SESSION_1,
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
    // The slot's activity is shown by its title and facility time, never as a record id.
    expect(screen.getByTestId('proposal-target')).toHaveTextContent(
      /U12 Red v Blue · .*11:00 (PDT|GMT-7) \(from the uncovered slot\)/,
    );
    expect(screen.queryByLabelText(/record id/)).toBeNull();
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

  it('SPK-STAFF-002: chooses a session from GET /v1/sessions, whose row carries the offering', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
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
                scheduledStart: '2026-10-25T16:00:00.000Z',
                scheduledEnd: '2026-10-25T17:00:00.000Z',
                status: 'scheduled',
                facilityId: FACILITY_A,
                timezone: 'America/Los_Angeles',
              },
            ],
            nextCursor: null,
          },
        },
        'GET /staff-directory': {
          status: 200,
          body: {
            items: [
              {
                personId: CANDIDATE,
                displayName: 'Casey Lee',
                roles: ['coach'],
                facilityIds: [],
                scopes: [{ role: 'coach', facilityIds: [] }],
              },
            ],
            nextCursor: null,
          },
        },
        'POST /assignments': {
          status: 201,
          body: {
            assignment: assignmentRecord({
              personId: CANDIDATE,
              kind: 'coach',
              targetType: 'session',
              targetId: SESSION_1,
              offeringId: OFFERING,
              status: 'offered',
            }),
            uncovered: null,
          },
        },
      }),
    });
    render(app.at('/staff'));
    await user.click(await screen.findByRole('button', { name: 'Propose an assignment' }));
    await user.selectOptions(screen.getByLabelText('Kind'), 'coach');
    await user.selectOptions(screen.getByLabelText('For'), 'session');
    const session = await screen.findByLabelText('Session');
    await waitFor(() =>
      expect(
        within(session).getByRole('option', {
          name: /Junior skills, session 3, .*09:00 (PDT|GMT-7) to 10:00/,
        }),
      ).toBeInTheDocument(),
    );
    const read = app.fake.requests.find((r) => r.route === '/sessions');
    expect(read?.query).toMatchObject({ facilityId: FACILITY_A, status: 'scheduled' });
    // No offering id is asked for: the session row names it.
    expect(screen.queryByLabelText(/Offering/)).toBeNull();
    await user.selectOptions(session, SESSION_1);
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: 'Casey Lee (coach)' })).toBeInTheDocument(),
    );
    await user.selectOptions(picker, CANDIDATE);
    await user.type(screen.getByLabelText('Role'), 'head_coach');
    await user.click(screen.getByRole('button', { name: 'Propose and offer' }));
    const proposal = screen.getByRole('heading', { name: 'Propose an assignment' })
      .parentElement as HTMLElement;
    expect(await within(proposal).findByText('Offered (not covering)')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST');
    expect(post?.body).toEqual({
      personId: CANDIDATE,
      kind: 'coach',
      targetType: 'session',
      targetId: SESSION_1,
      offeringId: OFFERING,
      role: 'head_coach',
      engagement: 'regular',
      offer: true,
    });
  });

  it('chooses a fixture from the facility’s scheduled events (sourceType fixture) and sends the fixture id', async () => {
    const user = userEvent.setup();
    const EVENT = '0192f1a0-0000-7000-8000-0000000001b9';
    const app = createTestApp({
      routes: routes({
        'GET /events': {
          status: 200,
          body: {
            items: [
              {
                id: EVENT,
                facilityId: FACILITY_A,
                kind: 'game',
                title: 'U12 Red v Blue',
                format: null,
                seriesId: null,
                occurrenceIndex: null,
                scheduledStart: '2026-10-24T18:00:00.000Z',
                scheduledEnd: '2026-10-24T19:00:00.000Z',
                timezone: 'America/Los_Angeles',
                setupMinutes: 0,
                cleanupMinutes: 0,
                dstResolution: 'exact',
                status: 'published',
                publishedRevision: 1,
                revision: 1,
                sourceType: 'fixture',
                sourceId: FIXTURE_1,
                resourceIds: [],
                commitments: [],
                canceledAt: null,
                cancelReason: null,
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            ],
            nextCursor: null,
          },
        },
        'POST /assignments': {
          status: 409,
          body: apiErrorBody('RESOURCE_CONFLICT', { message: 'Overlaps another assignment.' }),
        },
      }),
    });
    render(app.at('/staff'));
    await user.click(await screen.findByRole('button', { name: 'Propose an assignment' }));
    await user.selectOptions(screen.getByLabelText('Kind'), 'official');
    await user.selectOptions(screen.getByLabelText('For'), 'fixture');
    const fixture = await screen.findByLabelText('Fixture');
    await waitFor(() =>
      expect(
        within(fixture).getByRole('option', { name: /U12 Red v Blue, .*11:00 (PDT|GMT-7)/ }),
      ).toBeInTheDocument(),
    );
    expect(app.fake.requests.find((r) => r.route === '/events')?.query).toMatchObject({
      facilityId: FACILITY_A,
      sourceType: 'fixture',
    });
    await user.selectOptions(fixture, FIXTURE_1);
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(picker, OFFICIAL);
    await user.type(screen.getByLabelText('Role'), 'referee');
    await user.click(screen.getByRole('button', { name: 'Propose and offer' }));
    expect(await screen.findByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST');
    expect(post?.body).toMatchObject({ targetType: 'fixture', targetId: FIXTURE_1 });
  });

  it('shows a refused sessions list as not available and keeps the record id as a fallback', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /sessions': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      }),
    });
    render(app.at('/staff'));
    await user.click(await screen.findByRole('button', { name: 'Propose an assignment' }));
    await user.selectOptions(screen.getByLabelText('For'), 'session');
    expect(await screen.findByText('The list of sessions is not available')).toBeInTheDocument();
    expect(screen.getByText(/Error code: ACCESS_DENIED/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enter a record id instead' }));
    expect(screen.getByLabelText('Session record id')).toBeInTheDocument();
    expect(screen.getByLabelText('Offering record id')).toBeInTheDocument();
  });

  it('SCR-S-33: never proposes for a person the picker no longer shows; Enter in the name search does not submit', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': (req) =>
          fakeResponse(200, {
            items: req.query.query
              ? []
              : [
                  {
                    personId: OFFICIAL,
                    displayName: 'Jordan Lee',
                    roles: ['official'],
                    facilityIds: [],
                    scopes: [{ role: 'official', facilityIds: [] }],
                  },
                ],
            nextCursor: null,
          }),
      }),
    });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Propose someone for U12 Red v Blue, Referee' }),
    );
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(picker, OFFICIAL);
    await user.type(screen.getByLabelText('Find person by name'), 'Morg{enter}');
    expect(app.fake.requests.some((r) => r.route === '/assignments' && r.method === 'POST')).toBe(
      false,
    );
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/staff-directory' && r.query.query === 'Morg'),
      ).toBe(true),
    );
    // Nobody matches the new search: the chosen person stays shown as chosen, not hidden.
    expect(picker).toHaveValue(OFFICIAL);
    expect(
      within(picker).getByRole('option', { name: 'Jordan Lee (official), chosen' }),
    ).toBeInTheDocument();
  });

  it('SPK-SCHED-008: lists assignment times in the assignment’s facility zone', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/staff'));
    const list = await screen.findByRole('list', { name: 'Assignments' });
    // assignmentRecord starts 18:00Z at FACILITY_A (America/Los_Angeles in the facility directory).
    expect(await within(list).findByText(/11:00 (PDT|GMT-7) to 12:00/)).toBeInTheDocument();
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

  it('SCR-S-33 offline (read-only): every command control is disabled and nothing is sent after reconnecting (§4.15)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': { status: 200, body: assignmentRecord() },
        'GET /assignments': staffList([assignmentRecord()], ['offer', 'complete', 'withdraw']),
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
            requiredQualifications: [],
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            candidates: [
              { personId: CANDIDATE, displayName: 'Casey Lee', eligible: true, reasons: [] },
            ],
          },
        },
        'POST /assignments/{id}/offer': { status: 200, body: {} },
        'POST /assignments/{id}/complete': { status: 200, body: {} },
        'POST /assignments/{id}/withdraw': { status: 200, body: {} },
        'POST /assignments/{id}/replacements': { status: 201, body: {} },
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    await screen.findByRole('button', { name: 'Offer to the person' });
    await user.click(screen.getByRole('radio', { name: /Casey Lee/ }));
    await user.type(screen.getByLabelText('Reason for the replacement'), 'Absent');
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await user.type(screen.getByLabelText('Reason for withdrawing'), 'Fixture moved');
    act(() => app.connectivity.set(false));
    const commands = [
      'Offer to the person',
      'Mark completed',
      'Confirm withdrawal',
      'Offer the slot',
    ];
    for (const name of commands) {
      const button = screen.getByRole('button', { name });
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAccessibleDescription('Needs a connection.');
      await user.click(button);
    }
    // Enter in a reason field does not submit either.
    await user.type(screen.getByLabelText('Reason for withdrawing'), '{Enter}');
    act(() => app.connectivity.set(true));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Offer to the person' })).toBeEnabled(),
    );
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(app.queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('SCR-S-33 offline: "Propose" is disabled and no assignment is created after reconnecting (§4.15)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /assignments': { status: 201, body: {} } }),
    });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Propose someone for U12 Red v Blue, Referee' }),
    );
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(picker, OFFICIAL);
    const propose = screen.getByRole('button', { name: 'Propose and offer' });
    act(() => app.connectivity.set(false));
    await waitFor(() => expect(propose).toBeDisabled());
    expect(propose).toHaveAccessibleDescription('Needs a connection.');
    await user.click(propose);
    await user.type(screen.getByLabelText('Role'), '{Enter}');
    act(() => app.connectivity.set(true));
    await waitFor(() => expect(propose).toBeEnabled());
    expect(app.fake.requests.some((r) => r.route === '/assignments' && r.method === 'POST')).toBe(
      false,
    );
  });

  it('§4.9 SCR-S-33: after an unknown replacement outcome, "Try again" is disabled offline and online resends the request that was sent with the same key', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const accepted = assignmentRecord({ status: 'accepted' });
    // The replacement committed and withdrew the original (revision 4 to 5), but its answer was
    // lost: the assignment read again after the unknown outcome shows it withdrawn.
    const withdrawn = assignmentRecord({
      status: 'withdrawn',
      withdrawnAt: '2026-10-24T12:00:00.000Z',
      withdrawnReason: 'Absent',
      revision: 5,
    });
    const app = createTestApp({
      routes: routes({
        'GET /assignments/{id}': () => fakeResponse(200, posts === 0 ? accepted : withdrawn),
        'GET /assignments': staffList([accepted], ['withdraw']),
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
            requiredQualifications: [],
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            candidates: [
              { personId: CANDIDATE, displayName: 'Casey Lee', eligible: true, reasons: [] },
            ],
          },
        },
        'POST /assignments/{id}/replacements': () => {
          posts += 1;
          // The second attempt carries the first one's key: the API answers the stored outcome.
          return posts === 1
            ? fakeResponse(503, apiErrorBody('INTERNAL_ERROR'))
            : fakeResponse(201, {
                original: withdrawn,
                replacement: assignmentRecord({
                  id: REPLACEMENT,
                  personId: CANDIDATE,
                  status: 'offered',
                  engagement: 'substitute',
                  replacesAssignmentId: ASSIGNMENT_1,
                }),
                operationId: '0192f1a0-0000-7000-8000-0000000001d1',
                uncovered: null,
              });
        },
      }),
    });
    render(app.at(`/staff/assignments/${ASSIGNMENT_1}`));
    await user.click(await screen.findByRole('radio', { name: /Casey Lee/ }));
    await user.type(screen.getByLabelText('Reason for the replacement'), 'Absent');
    await user.click(screen.getByRole('button', { name: 'Offer the slot' }));
    const unknown = await screen.findByTestId('state-outcome-unknown');
    // The re-read shows the original withdrawn: it can no longer be withdrawn from this form.
    await waitFor(() =>
      expect(
        screen.queryByLabelText('Withdraw the original assignment (absent official)'),
      ).toBeNull(),
    );
    act(() => app.connectivity.set(false));
    const retry = within(unknown).getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(retry).toBeDisabled());
    expect(retry).toHaveAccessibleDescription('Needs a connection.');
    await user.click(retry);
    expect(posts).toBe(1);
    act(() => app.connectivity.set(true));
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(await screen.findByText('Replacement offered (not covering)')).toBeInTheDocument();
    const sent = app.fake.requests.filter(
      (r) => r.route === '/assignments/{id}/replacements' && r.method === 'POST',
    );
    const first = {
      personId: CANDIDATE,
      engagement: 'substitute',
      offer: true,
      withdrawOriginal: true,
      reason: 'Absent',
      expectedRevision: 4,
    };
    // Exactly the request that was sent, never one rebuilt from the re-read (revision 5, the
    // original no longer withdrawable), which would be a new intent with a new key.
    expect(sent.map((r) => r.body)).toEqual([first, first]);
    expect(new Set(sent.map((r) => r.headers['idempotency-key'])).size).toBe(1);
  });

  it('§4.9 SCR-S-33: an unknown proposal outcome is retried with the same request and key; offline "Try again" needs a connection', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const app = createTestApp({
      routes: routes({
        'POST /assignments': () => {
          posts += 1;
          return posts === 1
            ? fakeResponse(503, apiErrorBody('INTERNAL_ERROR'))
            : fakeResponse(201, {
                assignment: assignmentRecord({ status: 'offered' }),
                operationId: null,
                uncovered: null,
              });
        },
      }),
    });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Propose someone for U12 Red v Blue, Referee' }),
    );
    const picker = screen.getByLabelText('Person');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(picker, OFFICIAL);
    await user.click(screen.getByRole('button', { name: 'Propose and offer' }));
    const unknown = await screen.findByTestId('state-outcome-unknown');
    act(() => app.connectivity.set(false));
    const retry = within(unknown).getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(retry).toBeDisabled());
    expect(retry).toHaveAccessibleDescription('Needs a connection.');
    act(() => app.connectivity.set(true));
    await waitFor(() => expect(retry).toBeEnabled());
    // A field changed after the unknown outcome does not change what "Try again" resends.
    await user.click(screen.getByLabelText('Offer it to the person now'));
    await user.click(retry);
    await waitFor(() => expect(posts).toBe(2));
    const sent = app.fake.requests.filter((r) => r.route === '/assignments' && r.method === 'POST');
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[1]?.body).toMatchObject({ offer: true });
    expect(new Set(sent.map((r) => r.headers['idempotency-key'])).size).toBe(1);
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
