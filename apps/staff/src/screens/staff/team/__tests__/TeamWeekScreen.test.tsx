/**
 * Staff S 5b "Staff shifts · week, with a swap request" (SPK-STAFF-001 to SPK-STAFF-004,
 * SPK-AT-012, §4.8): shifts composed from assignments and coloured by role, the open shift's
 * free and qualified candidates with Ask, and a swap checked by the API before approval.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nameEntry, personNames } from '../../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../../testing/test-app';
import { hourRange, hoursOf, swapsOf, toneOf } from '../TeamWeekScreen';

const MANAGER = '0192f1a0-0000-7000-8000-0000000e0001';
const ANA = '0192f1a0-0000-7000-8000-0000000e0002';
const ALEX = '0192f1a0-0000-7000-8000-0000000e0003';

function a(
  id: string,
  personId: string,
  kind: string,
  start: string,
  end: string,
  status = 'accepted',
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    facilityId: FACILITY_A,
    personId,
    kind,
    targetType: 'session',
    targetId: `t-${id}`,
    offeringId: 'off-1',
    schedulingEventId: null,
    targetTitle: 'Goalkeeper Basics (session 1)',
    role: kind,
    slot: 1,
    engagement: 'regular',
    status,
    scheduledStart: start,
    scheduledEnd: end,
    turnaroundMinutes: 0,
    committedUntil: end,
    replacesAssignmentId: null,
    offeredAt: null,
    respondedAt: null,
    acceptedAt: null,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    withdrawnReason: null,
    completedAt: null,
    access: {
      status: 'not_applicable',
      staffMembershipId: null,
      from: null,
      until: null,
      active: false,
    },
    revision: 1,
    createdAt: start,
    updatedAt: start,
    availableActions: [],
    ...extra,
  };
}

// Week of Mon 19 to Sun 25 October 2026 (TEST_NOW is Sat 24, Los Angeles).
const ITEMS = [
  a('m1', MANAGER, 'supervisor', '2026-10-24T15:00:00.000Z', '2026-10-24T23:00:00.000Z'),
  a('c1', ANA, 'coach', '2026-10-22T23:00:00.000Z', '2026-10-23T03:00:00.000Z'),
  a('d1', ANA, 'coach', '2026-10-25T16:00:00.000Z', '2026-10-25T19:00:00.000Z', 'declined', {
    declineReason: 'Family thing Sunday — Alex said he can cover.',
  }),
  a('r1', ALEX, 'coach', '2026-10-25T16:00:00.000Z', '2026-10-25T19:00:00.000Z', 'proposed', {
    replacesAssignmentId: 'd1',
    revision: 4,
  }),
];

function routes(extra = {}) {
  return {
    'GET /assignments': { status: 200, body: { items: ITEMS, nextCursor: null } },
    'GET /person-names': personNames([
      nameEntry(MANAGER, 'Jordan', 'Reyes', 'adult'),
      nameEntry(ANA, 'Ana', 'Ruiz', 'adult'),
      nameEntry(ALEX, 'Alex', 'Park', 'adult'),
    ]),
    'GET /reports/uncovered-assignments': {
      status: 200,
      body: {
        values: [],
        columns: [],
        rows: [
          {
            targetType: 'session',
            targetId: 't-x',
            title: 'Goalkeeper Basics',
            start: '2026-10-25T16:00:00.000Z',
            requirementId: 'req-1',
            kind: 'official',
            role: 'referee',
            required: 1,
            accepted: 0,
            offered: 0,
            proposed: 0,
            uncovered: 1,
          },
        ],
      },
    },
    'GET /assignment-requirements/{id}/candidates': {
      status: 200,
      body: {
        requirementId: 'req-1',
        kind: 'official',
        targetType: 'session',
        targetId: 't-x',
        offeringId: 'off-1',
        role: 'referee',
        requiredCount: 1,
        covered: 0,
        scheduledStart: '2026-10-25T16:00:00.000Z',
        scheduledEnd: '2026-10-25T19:00:00.000Z',
        requiredQualifications: [],
        evaluatedAt: '2026-10-24T12:00:00.000Z',
        candidates: [
          {
            personId: 'ref-1',
            displayName: 'T. Nguyen',
            eligible: true,
            reasons: [],
            grade: null,
            safeguarding: null,
          },
          {
            personId: 'ref-2',
            displayName: 'Sam Lee',
            eligible: false,
            reasons: [
              {
                code: 'unavailable',
                severity: 'blocking',
                message: 'Declared unavailable',
                sourceType: null,
                sourceIds: [],
              },
            ],
            grade: null,
            safeguarding: null,
          },
        ],
      },
    },
    'GET /assignments/{id}/replacements': {
      status: 200,
      body: {
        assignmentId: 'd1',
        targetType: 'session',
        targetId: 't-d1',
        role: 'coach',
        slot: 1,
        scheduledStart: '2026-10-25T16:00:00.000Z',
        scheduledEnd: '2026-10-25T19:00:00.000Z',
        requiredQualifications: [],
        evaluatedAt: '2026-10-24T12:00:00.000Z',
        candidates: [
          {
            personId: ALEX,
            displayName: 'Alex Park',
            eligible: false,
            reasons: [
              {
                code: 'already_on_slot',
                severity: 'blocking',
                message: 'Already proposed for this slot.',
                sourceType: null,
                sourceIds: [],
              },
              {
                code: 'no_conflicts',
                severity: 'positive',
                message: 'No conflicting commitments',
                sourceType: null,
                sourceIds: [],
              },
            ],
            grade: null,
            safeguarding: null,
          },
        ],
      },
    },
    ...extra,
  };
}

/** Opens the page and picks the facility (the gate asks with more than one facility). */
async function open(app: ReturnType<typeof createTestApp>) {
  render(app.at('/staff/week'));
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Use North Park 1' }));
}

describe('S 5b staff shifts week', () => {
  it('composition: role tones, hour ranges in the facility zone, swaps and weekly hours', () => {
    expect(toneOf('supervisor')).toBe('manager');
    expect(toneOf('coach')).toBe('coach');
    expect(toneOf('official')).toBe('referee');
    expect(
      hourRange('2026-10-24T15:00:00.000Z', '2026-10-24T23:00:00.000Z', 'America/Los_Angeles'),
    ).toBe('8–4');
    expect(swapsOf(ITEMS as never).map((s) => s.replacement.id)).toEqual(['r1']);
    expect(hoursOf(ITEMS as never, ANA)).toBe(4);
  });

  it('SPK-STAFF-001: one row per person, shifts coloured and written by role, the swap marked on its day', async () => {
    const app = createTestApp({ routes: routes() });
    await open(app);
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(await screen.findByText(/1 open shift · 1 swap to approve/)).toBeInTheDocument();
    const table = await screen.findByRole('table');
    const jordan = await within(table).findByRole('row', { name: /Jordan Reyes/ });
    expect(within(jordan).getByText('Manager', { exact: false })).toBeInTheDocument();
    const ana = within(table).getByRole('row', { name: /Ana Ruiz/ });
    expect(within(ana).getByText(/Coach/)).toBeInTheDocument();
    expect(within(ana).getByText(/swap/)).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Sat · today' })).toBeInTheDocument();
  });

  it('SPK-AT-012: clicking the open shift lists who is free and qualified; Ask offers it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /assignments': { status: 201, body: { assignment: { id: 'new' } } } }),
    });
    await open(app);
    await user.click(await screen.findByRole('button', { name: /Open shift: Goalkeeper Basics/ }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('T. Nguyen')).toBeInTheDocument();
    expect(within(drawer).getByText(/Declared unavailable/)).toBeInTheDocument();
    const asks = within(drawer).getAllByRole('button', { name: 'Ask' });
    expect(asks[1]).toBeDisabled();
    await user.click(asks[0]!);
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assignments' && r.method === 'POST')).toBe(
        true,
      ),
    );
    expect(
      app.fake.requests.find((r) => r.route === '/assignments' && r.method === 'POST')?.body,
    ).toMatchObject({
      personId: 'ref-1',
      kind: 'official',
      role: 'referee',
      targetType: 'session',
      offer: true,
    });
  });

  it('SPK-STAFF-003: the swap is checked (free, qualified, hours) and Approve offers the replacement with its revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /assignments/{id}/offer': { status: 200, body: { assignment: { id: 'r1' } } },
      }),
    });
    await open(app);
    const card = await screen.findByRole('region', { name: 'Swap request' });
    expect(await within(card).findByText('Ana → Alex')).toBeInTheDocument();
    expect(within(card).getByText(/Family thing Sunday/)).toBeInTheDocument();
    expect(await within(card).findByText(/Alex is free and qualified/)).toBeInTheDocument();
    expect(within(card).getByText(/Under 40 h this week/)).toBeInTheDocument();
    expect(within(card).getByText(/Families are not told/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assignments/{id}/offer')).toBe(true),
    );
    const offer = app.fake.requests.find((r) => r.route === '/assignments/{id}/offer');
    expect(offer?.params).toEqual({ id: 'r1' });
    expect(offer?.body).toEqual({ expectedRevision: 4 });
    expect(await screen.findByText(/Offered to Alex/)).toBeInTheDocument();
  });
});
