/**
 * SCR-S-01 Today, redesign handoff S 1a / S 3a / S 3b (SPK-UX-006, SPK-READY-001, SPK-STAFF-003,
 * SPK-UX-008, SPK-UX-009): KPI tiles with their second line, the next-hour strip built from the
 * per-check reads, the field board, "Needs action" resolved in place (Assign optimistic with Undo
 * and revert, Ask, Snooze rules, Acknowledge with the expected revision), the session drawer and
 * the weather cancellation with its 2-minute undo window.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FACILITY_A,
  TEST_NOW,
  createTestApp,
  facilityDirectoryOf,
  mePermissions,
  staffMe,
  todayFeed,
} from '../../../testing/test-app';
import { flush, pendingBatches, resetPendingCancellations } from '../pending-cancellations';
import { EXCEPTION_ID, exceptionItem, scheduledEvent } from './fixtures';

const FIXTURE = '0192f1a0-0000-7000-8000-0000000000f1';
const GAME = '0192f1a0-0000-7000-8000-0000000000b1';
const PARTY = '0192f1a0-0000-7000-8000-0000000000b2';
const DECLINED = '0192f1a0-0000-7000-8000-0000000000d1';
const PATEL = '0192f1a0-0000-7000-8000-0000000000d2';
const NGUYEN = '0192f1a0-0000-7000-8000-0000000000d3';
const OSEI = '0192f1a0-0000-7000-8000-0000000000d4';
const OFFER = '0192f1a0-0000-7000-8000-0000000000d5';
const UNCOVERED = '0192f1a0-0000-7000-8000-0000000000e2';

/** TEST_NOW is 12:00 UTC (5:00 AM in Los Angeles); the facility day starts at local midnight. */
function feed(items: unknown[] = [], visible = true) {
  const f = todayFeed(items, [FACILITY_A]);
  f.body.facilities = [
    {
      facilityId: FACILITY_A,
      name: 'North Complex',
      timezone: 'America/Los_Angeles',
      localDate: '2026-10-24',
      window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
      activities: { total: 2, published: 2, canceled: 0, visible },
    },
  ];
  return f;
}

function game(sport: string | null = null) {
  return {
    ...scheduledEvent(GAME, '2026-10-24T12:15:00.000Z', '2026-10-24T13:15:00.000Z'),
    title: 'Desert Foxes vs Lions',
    format: 'U9',
    sport,
    sourceType: 'fixture',
    sourceId: FIXTURE,
    resourceIds: ['res-2'],
  };
}

function party() {
  return {
    ...scheduledEvent(PARTY, '2026-10-24T12:45:00.000Z', '2026-10-24T14:45:00.000Z'),
    kind: 'party',
    title: "Sofia's 9th birthday",
    resourceIds: ['res-3'],
  };
}

const RESOURCE = (id: string, name: string, kind: string, restrictions: unknown[] = []) => ({
  resourceId: id,
  name,
  kind,
  parentResourceId: null,
  inventoryStatus: restrictions.length > 0 ? 'restricted' : 'active',
  conflictUnitIds: [],
  status: restrictions.length > 0 ? 'restricted' : 'in_service',
  restrictions,
});

const OPERATING_STATUS = {
  status: 200,
  body: {
    facilityId: FACILITY_A,
    at: TEST_NOW.toISOString(),
    resources: [
      RESOURCE('res-1', 'Field 1', 'pitch'),
      RESOURCE('res-2', 'Field 2', 'pitch'),
      RESOURCE('res-3', 'Party A', 'room'),
      RESOURCE('res-4', 'Field 4', 'pitch', [
        {
          restrictionId: 'x-1',
          kind: 'closed',
          reason: 'irrigation repair',
          interval: { start: '2026-10-24T08:00:00.000Z', end: '2026-10-24T20:00:00.000Z' },
          taskId: null,
          resourceId: 'res-4',
          affectedConflictUnitIds: [],
        },
      ]),
    ],
  },
};

const READINESS = {
  status: 200,
  body: {
    fixtureId: FIXTURE,
    fixtureStatus: 'scheduled',
    status: 'blocked',
    evaluatedAt: TEST_NOW.toISOString(),
    scheduledStart: '2026-10-24T12:15:00.000Z',
    checks: [
      { name: 'field', status: 'ready', issueCount: 0 },
      { name: 'workforce.required_officials', status: 'blocked', issueCount: 1 },
      { name: 'rosters', status: 'ready', issueCount: 0 },
      { name: 'forms', status: 'ready', issueCount: 0 },
    ],
    issues: [],
    sides: [
      {
        teamEntryId: 'e1',
        teamName: 'Desert Foxes',
        entryStatus: 'approved',
        rosterSize: 12,
        eligiblePlayers: 12,
        unknownPlayers: 0,
        minimumPlayers: 7,
      },
      {
        teamEntryId: 'e2',
        teamName: 'Lions',
        entryStatus: 'approved',
        rosterSize: 11,
        eligiblePlayers: 11,
        unknownPlayers: 0,
        minimumPlayers: 7,
      },
    ],
  },
};

const DETAIL = (eventId: string) => ({
  status: 200,
  body: {
    event: eventId === GAME ? game() : party(),
    teams: [],
    staff: { identified: true, assignments: [] },
    committedPeople: [],
    attendees: { total: 23, byVia: { commitment: 0, enrollment: 0, booking: 0, roster: 23 } },
    fixtureId: eventId === GAME ? FIXTURE : null,
    messageAudience: { teamEntryIds: [], subjectPersonIds: [] },
  },
});

function uncoveredItem() {
  return {
    ...exceptionItem({
      id: `exception:${UNCOVERED}`,
      group: 'staffing',
      category: 'workforce.uncovered_assignment',
      title: 'Uncovered referee (slot 1) for Desert Foxes vs Lions',
      severity: 'high',
      affected: { type: 'fixture', id: FIXTURE },
      ownerQueue: 'league_manager',
      overdue: false,
      ageMinutes: 2,
      nextActions: [],
      details: {
        exceptionId: UNCOVERED,
        role: 'referee',
        slot: 1,
        cause: 'declined',
        startsAt: '2026-10-24T12:15:00.000Z',
        assignmentId: DECLINED,
        revision: 1,
      },
    }),
  };
}

const CANDIDATE = (personId: string, displayName: string, available: boolean) => ({
  personId,
  displayName,
  eligible: true,
  grade: null,
  safeguarding: null,
  reasons: [
    available
      ? {
          code: 'declared_available',
          severity: 'positive',
          message: 'Available',
          sourceType: null,
          sourceIds: [],
        }
      : {
          code: 'availability_not_declared',
          severity: 'info',
          message: 'Not declared',
          sourceType: null,
          sourceIds: [],
        },
    {
      code: 'no_conflicts',
      severity: 'positive',
      message: 'No clash',
      sourceType: null,
      sourceIds: [],
    },
  ],
});

function assignment(
  id: string,
  personId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    facilityId: FACILITY_A,
    personId,
    kind: 'official',
    targetType: 'fixture',
    targetId: FIXTURE,
    offeringId: null,
    schedulingEventId: GAME,
    targetTitle: 'Desert Foxes vs Lions',
    role: 'referee',
    slot: 1,
    engagement: 'regular',
    status,
    scheduledStart: '2026-10-24T12:15:00.000Z',
    scheduledEnd: '2026-10-24T13:15:00.000Z',
    turnaroundMinutes: 0,
    committedUntil: '2026-10-24T13:15:00.000Z',
    replacesAssignmentId: null,
    offeredAt: null,
    respondedAt: null,
    acceptedAt: null,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    withdrawnReason: null,
    completedAt: null,
    access: 'full',
    revision: 2,
    createdAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
    availableActions: [],
    ...extra,
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /me': staffMe([FACILITY_A]),
    'GET /facilities': facilityDirectoryOf([FACILITY_A]),
    'GET /today': feed([uncoveredItem(), exceptionItem()]),
    'GET /events': { status: 200, body: { items: [game(), party()], nextCursor: null } },
    'GET /facilities/{id}/operating-status': OPERATING_STATUS,
    'GET /sessions': { status: 200, body: { items: [], nextCursor: null } },
    'GET /fixtures/{id}/readiness': READINESS,
    'GET /events/{id}/detail': (req: { params: { id: string } }) =>
      fakeResponse(200, DETAIL(req.params.id).body),
    'GET /assignments/{id}/replacements': {
      status: 200,
      body: {
        assignmentId: DECLINED,
        targetType: 'fixture',
        targetId: FIXTURE,
        role: 'referee',
        slot: 1,
        scheduledStart: '2026-10-24T12:15:00.000Z',
        scheduledEnd: '2026-10-24T13:15:00.000Z',
        requiredQualifications: [],
        evaluatedAt: TEST_NOW.toISOString(),
        candidates: [CANDIDATE(NGUYEN, 'Taylor Nguyen', true), CANDIDATE(OSEI, 'Kofi Osei', false)],
      },
    },
    'GET /assignments': {
      status: 200,
      body: {
        items: [
          assignment(DECLINED, PATEL, 'declined', { declinedAt: '2026-10-24T11:58:00.000Z' }),
        ],
        nextCursor: null,
      },
    },
    'GET /people/{id}': {
      status: 200,
      body: { id: PATEL, givenName: 'Riya', familyName: 'Patel', kind: 'adult' },
    },
    'GET /facilities/{id}/occupancy': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
        evaluatedAt: TEST_NOW.toISOString(),
        arrivals: { people: 142, visits: 90 },
        departures: { people: 0, visits: 0 },
        recordedOnSite: 142,
        openFromEarlierDays: 0,
        occupancy: {
          status: 'unverified',
          verifiedOccupancy: null,
          reconciledAt: null,
          statement: '',
        },
        lastSnapshot: null,
      },
    },
    'GET /reports/expected-arrivals': {
      status: 200,
      body: {
        values: [
          {
            metric: 'MET-004',
            label: 'Expected arrivals',
            value: 310,
            unit: 'count',
            currency: null,
            dimensions: {},
            unavailableReason: null,
          },
        ],
        rows: [],
        columns: [],
      },
    },
    'GET /exceptions': { status: 200, body: { items: [], nextCursor: null } },
    ...extra,
  };
}

afterEach(() => resetPendingCancellations());

async function needsAction() {
  return within(await screen.findByRole('list', { name: 'Needs action' }));
}

describe('S 1a Today: KPI tiles, strip and field board', () => {
  it('SPK-UX-006: KPI tiles carry the "is that bad?" line', async () => {
    render(createTestApp({ routes: routes() as never }).at('/today'));
    const kpis = within(await screen.findByRole('group', { name: 'Today at a glance' }));
    expect(await kpis.findByText('142')).toBeInTheDocument();
    expect(kpis.getByText('of 310 expected today')).toBeInTheDocument();
    expect(await kpis.findByText(/of 4 · 1 closed/)).toBeInTheDocument();
    expect(kpis.getByText(/blocks a 5:15 start/)).toBeInTheDocument();
  });

  it('SPK-READY-001: every start in the next hour shows its checks; a failed check marks the card and opens its fix', async () => {
    render(createTestApp({ routes: routes() as never }).at('/today'));
    const strip = within(await screen.findByRole('list', { name: 'Starts in the next hour' }));
    const card = strip.getByTestId(`start-${GAME}`);
    expect(await within(card).findByText(/No referee/)).toBeInTheDocument();
    expect(within(card).getByText(/Rosters 12 \/ 11/)).toBeInTheDocument();
    expect(within(card).getByText(/Field ready/)).toBeInTheDocument();
    expect(card).toHaveAttribute('data-blocked', 'true');
    // ✓ checks are text; the failed one is a button.
    expect(within(card).getByRole('button', { name: 'No referee: fix' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Field ready/ })).toBeNull();
    expect(screen.getByText(/2 starts · 1 ready/)).toBeInTheDocument();
  });

  it('migration 0304: basketball league play keeps its own kind colour on the strip', async () => {
    render(
      createTestApp({
        routes: routes({
          'GET /events': { status: 200, body: { items: [game('basketball')], nextCursor: null } },
        }) as never,
      }).at('/today'),
    );
    const card = await screen.findByTestId(`start-${GAME}`);
    expect(card.querySelector('.start-kind')).toHaveAttribute('data-kind', 'basketball');
  });

  it('the field board writes each status out: restricted with its reason, the slot needing a person', async () => {
    render(createTestApp({ routes: routes() as never }).at('/today'));
    const board = within(await screen.findByRole('list', { name: 'Field board' }));
    expect(await board.findByText(/Closed: irrigation repair/)).toBeInTheDocument();
    expect(within(board.getByTestId('board-res-4')).getByText('Restricted')).toBeInTheDocument();
    expect(within(board.getByTestId('board-res-2')).getByText('Ref needed')).toBeInTheDocument();
    expect(
      within(board.getByTestId('board-res-2')).getByText(/Free until 5:15/),
    ).toBeInTheDocument();
  });

  it('§4.10: a facility schedule the viewer may not read is said, without asking for it', async () => {
    const app = createTestApp({ routes: routes({ 'GET /today': feed([], false) }) as never });
    render(app.at('/today'));
    expect(
      await screen.findByText(/schedule of this facility is not available to you/),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/events')).toBe(false);
  });

  it('shows a failed Today read with its code and a retry', async () => {
    render(
      createTestApp({
        routes: routes({
          'GET /today': () => fakeResponse(503, apiErrorBody('SERVICE_UNAVAILABLE')),
        }) as never,
      }).at('/today'),
    );
    expect((await screen.findAllByText(/SERVICE_UNAVAILABLE/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('S 1a Needs action, resolved in place', () => {
  it('SPK-STAFF-003: a missing referee shows who declined and the ranked candidates', async () => {
    render(createTestApp({ routes: routes() as never }).at('/today'));
    const list = await needsAction();
    expect(await list.findByText('No referee for Desert Foxes vs Lions')).toBeInTheDocument();
    expect(await list.findByText(/R\. Patel declined at 4:58 AM/)).toBeInTheDocument();
    expect(list.getByText('Blocks start')).toBeInTheDocument();
    expect(await list.findByRole('button', { name: 'Assign Taylor Nguyen' })).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Ask Kofi Osei' })).toBeInTheDocument();
    // Ordered by start: the blocking referee issue comes before the money issue.
    const titles = list
      .getAllByText(/No referee for|Payment outcome unknown/)
      .map((n) => n.textContent);
    expect(titles[0]).toMatch(/No referee/);
  });

  it('Assign is optimistic: ✓ at once, the offer is sent, the issue leaves after 2 s and Undo withdraws it', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const app = createTestApp({
      routes: routes({
        'POST /assignments': () =>
          new Promise((resolve) => {
            release = () =>
              resolve(
                fakeResponse(201, {
                  assignment: assignment(OFFER, NGUYEN, 'offered'),
                  operationId: null,
                  uncovered: null,
                }),
              );
          }),
        'POST /assignments/{id}/withdraw': {
          status: 200,
          body: {
            assignment: assignment(OFFER, NGUYEN, 'withdrawn'),
            operationId: null,
            uncovered: null,
          },
        },
      }) as never,
    });
    render(app.at('/today'));
    const list = await needsAction();
    await user.click(await list.findByRole('button', { name: 'Assign Taylor Nguyen' }));
    // Optimistic: the row says Assigned before the API answered.
    expect(list.getByText('Assigned')).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST');
    expect(sent?.body).toMatchObject({
      personId: NGUYEN,
      kind: 'official',
      role: 'referee',
      targetType: 'fixture',
      targetId: FIXTURE,
      offer: true,
    });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
    act(() => release());
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Assigned T. Nguyen to Desert Foxes vs Lions');
    await waitFor(
      () => expect(screen.queryByText('No referee for Desert Foxes vs Lions')).toBeNull(),
      {
        timeout: 3000,
      },
    );
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assignments/{id}/withdraw')).toBe(true),
    );
    const withdraw = app.fake.requests.find((r) => r.route === '/assignments/{id}/withdraw');
    expect(withdraw?.params.id).toBe(OFFER);
    expect(withdraw?.body).toMatchObject({ expectedRevision: 2 });
    expect(await screen.findByText('No referee for Desert Foxes vs Lions')).toBeInTheDocument();
  });

  it('a refused Assign reverts the row and says what did not save, with Try again', async () => {
    const user = userEvent.setup();
    render(
      createTestApp({
        routes: routes({
          'POST /assignments': () =>
            fakeResponse(
              409,
              apiErrorBody('ASSIGNMENT_CONFLICT', {
                message: 'T. Nguyen is refereeing on Field 1 at 5:15.',
              }),
            ),
        }) as never,
      }).at('/today'),
    );
    const list = await needsAction();
    await user.click(await list.findByRole('button', { name: 'Assign Taylor Nguyen' }));
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent(
      /T\. Nguyen was not assigned: T\. Nguyen is refereeing on Field 1 at 5:15\. \(ASSIGNMENT_CONFLICT\)/,
    );
    expect(within(toast).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(await list.findByRole('button', { name: 'Assign Taylor Nguyen' })).toBeInTheDocument();
  });

  it('Ask sends the offer and keeps the row as "Asked"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /assignments': {
          status: 201,
          body: {
            assignment: assignment(OFFER, OSEI, 'offered'),
            operationId: null,
            uncovered: null,
          },
        },
      }) as never,
    });
    render(app.at('/today'));
    const list = await needsAction();
    await user.click(await list.findByRole('button', { name: 'Ask Kofi Osei' }));
    expect(await list.findByText(/Asked/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST')?.body,
    ).toMatchObject({
      personId: OSEI,
      offer: true,
    });
    expect(screen.getByText('No referee for Desert Foxes vs Lions')).toBeInTheDocument();
  });

  it('INTERACTIONS 1a row 6: an offer unanswered for 15 minutes moves the issue to the top, in red', async () => {
    render(
      createTestApp({
        routes: routes({
          'GET /today': feed([exceptionItem({ severity: 'critical' }), uncoveredItem()]),
          'GET /assignments': {
            status: 200,
            body: {
              items: [
                assignment(OFFER, OSEI, 'offered', { offeredAt: '2026-10-24T11:40:00.000Z' }),
              ],
              nextCursor: null,
            },
          },
        }) as never,
      }).at('/today'),
    );
    const list = await needsAction();
    expect(await list.findByText('No answer')).toBeInTheDocument();
    const cards = list.getAllByRole('listitem').filter((li) => li.classList.contains('issue-card'));
    expect(cards[0]).toHaveTextContent('No referee for Desert Foxes vs Lions');
    expect(cards[0]).toHaveAttribute('data-edge', 'danger');
  });

  it('INTERACTIONS 1a row 7: a blocking issue cannot be snoozed in the last 15 minutes; another hides for 30 minutes with Undo', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() as never });
    render(app.at('/today'));
    const list = await needsAction();
    const referee = await list.findByTestId(`issue-exception:${UNCOVERED}`);
    expect(within(referee).getByText(/can't be snoozed/)).toBeInTheDocument();
    const money = list.getByTestId(`issue-exception:${EXCEPTION_ID}`);
    await user.click(within(money).getByRole('button', { name: 'Snooze 30 min' }));
    expect(screen.queryByText('Payment outcome unknown for checkout')).toBeNull();
    expect(app.services.preferences?.get('sportspark.today.snoozed')).toContain(
      `exception:${EXCEPTION_ID}`,
    );
    await user.click(
      within(await screen.findByTestId('toast')).getByRole('button', { name: 'Undo' }),
    );
    expect(await screen.findByText('Payment outcome unknown for checkout')).toBeInTheDocument();
  });

  it('§4.9: Acknowledge is offered where the API lists it, with the expected revision and a key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /exceptions/{id}/acknowledge': { status: 200, body: {} },
      }) as never,
    });
    render(app.at('/today'));
    await user.click(
      await screen.findByRole('button', {
        name: 'Acknowledge: Payment outcome unknown for checkout',
      }),
    );
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/exceptions/{id}/acknowledge')).toBe(true),
    );
    const sent = app.fake.requests.find((r) => r.route === '/exceptions/{id}/acknowledge');
    expect(sent?.params.id).toBe(EXCEPTION_ID);
    expect(sent?.body).toEqual({ expectedRevision: 4 });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('§4.10: names the sources not included, by facility', async () => {
    const f = feed([]);
    f.body.sources = [
      {
        source: 'readiness',
        facilityId: FACILITY_A,
        status: 'not_permitted',
        count: 0,
        truncated: false,
        omitted: null,
      },
    ] as never;
    render(createTestApp({ routes: routes({ 'GET /today': f }) as never }).at('/today'));
    expect(
      await screen.findByText(/Not included: readiness \(North Complex: not available to you\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing needs action right now/)).toBeInTheDocument();
  });

  it('every control is labelled (SPK-UX-009)', async () => {
    render(createTestApp({ routes: routes() as never }).at('/today'));
    await screen.findByRole('button', { name: 'Assign Taylor Nguyen' });
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });
});

describe('S 3a session drawer and S 3b weather cancellation', () => {
  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    const card = await screen.findByTestId(`start-${GAME}`);
    const opener = within(card).getAllByRole('button', { name: 'Desert Foxes vs Lions' })[0]!;
    await user.click(opener);
    return { opener, drawer: await screen.findByRole('dialog', { name: 'Desert Foxes vs Lions' }) };
  }

  it('a next-hour card opens the drawer: checks, the fix inline; Escape closes and focus returns', async () => {
    const user = userEvent.setup();
    render(createTestApp({ routes: routes() as never }).at('/today'));
    const { opener, drawer } = await openDrawer(user);
    expect(within(drawer).getByText('Starts in 15 min')).toBeInTheDocument();
    expect(
      await within(drawer).findByText(/No referee assigned\. Best matches:/),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Open check-in' })).toHaveAttribute(
      'href',
      `/arrival?type=event&eventId=${GAME}`,
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Desert Foxes vs Lions' })).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('S 3b offers outdoor games ticked and indoor ones unticked; Undo within 2 minutes sends nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() as never });
    render(app.at('/today'));
    const { drawer } = await openDrawer(user);
    await user.click(within(drawer).getByRole('button', { name: 'Cancel game' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel games' });
    expect(within(dialog).getByRole('checkbox', { name: /Desert Foxes v Lions/ })).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: /Sofia's 9th birthday.*indoor/ }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByText(
        /Lightning in the area\. No make-up date yet\. You don't need to come\./,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel 1 game and notify' }));
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('1 game cancelled');
    expect(within(toast).getByRole('button', { name: /Undo \(2:00\)/ })).toBeInTheDocument();
    expect(pendingBatches()).toHaveLength(1);
    await user.click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(pendingBatches()).toHaveLength(0);
    expect(app.fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('S 3b: when the window closes, a game is cancelled through competition with its revision and the reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /fixtures/{id}': { status: 200, body: { id: FIXTURE, revision: 7, notes: null } },
        'PATCH /fixtures/{id}': {
          status: 200,
          body: { fixture: { id: FIXTURE }, operationId: 'op', operationStatus: 'succeeded' },
        },
      }) as never,
    });
    render(app.at('/today'));
    const { drawer } = await openDrawer(user);
    await user.click(within(drawer).getByRole('button', { name: 'Cancel game' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel games' });
    await user.type(within(dialog).getByRole('textbox'), 'Fields reopen at 1 PM.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel 1 game and notify' }));
    const batch = pendingBatches()[0]!;
    await act(() => flush(batch.id));
    const patch = app.fake.requests.find(
      (r) => r.method === 'PATCH' && r.route === '/fixtures/{id}',
    );
    expect(patch?.params.id).toBe(FIXTURE);
    expect(patch?.body).toEqual({
      action: 'cancel',
      expectedRevision: 7,
      reason: 'Lightning in the area. No make-up date yet. Fields reopen at 1 PM.',
    });
    expect(
      await screen.findByText(/1 game cancelled\. Families are being told\./),
    ).toBeInTheDocument();
  });

  it('the Today permissions call is the shell one: Today makes no extra permissions read', async () => {
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': mePermissions() } as never,
    });
    render(app.at('/today'));
    await screen.findByRole('list', { name: 'Needs action' });
    expect(app.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(1);
  });
});

describe('Phase 8: the field crew’s preparation drives the Field check and a red issue', () => {
  const preparations = (items: string[], status = 'in_progress') => ({
    status: 200,
    body: {
      facilityId: FACILITY_A,
      date: '2026-10-24',
      timezone: 'America/Los_Angeles',
      checklist: ['lines', 'goals_anchored', 'nets', 'corner_flags'],
      items: [
        {
          id: 'fp-2',
          facilityId: FACILITY_A,
          resourceId: 'res-2',
          date: '2026-10-24',
          checkedItems: items,
          status,
          readyAt: null,
          readyBy: null,
          updatedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Crew' },
          revision: 2,
          updatedAt: TEST_NOW.toISOString(),
        },
      ],
    },
  });

  it('SPK-READY-001: a pitch not ready 15 minutes before its first use is a red Needs action issue and a failed Field check', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /field-preparations': preparations(['lines', 'nets']) }) as never,
    });
    render(app.at('/today'));
    const issue = await screen.findByTestId(/^issue-field-not-ready:res-2:/);
    expect(
      within(issue).getByText('Field 2 not ready for Desert Foxes vs Lions'),
    ).toBeInTheDocument();
    expect(within(issue).getByText(/2 of 4 checks done/)).toBeInTheDocument();
    expect(within(issue).getByRole('link', { name: 'Open fields' })).toHaveAttribute(
      'href',
      '/workspace/fields',
    );
    const strip = within(await screen.findByRole('list', { name: 'Starts in the next hour' }));
    expect(await strip.findByText(/Field not ready/)).toBeInTheDocument();
  });

  it('SPK-READY-001: once the crew marks it ready, the issue is gone', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /field-preparations': preparations(
          ['lines', 'goals_anchored', 'nets', 'corner_flags'],
          'ready',
        ),
      }) as never,
    });
    render(app.at('/today'));
    await screen.findByRole('list', { name: 'Needs action' });
    expect(screen.queryByTestId(/^issue-field-not-ready/)).not.toBeInTheDocument();
  });
});
