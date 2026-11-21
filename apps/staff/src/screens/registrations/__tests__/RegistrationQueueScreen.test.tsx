/**
 * Registrations triage (handoff S 1c, S 3f, S 2c; INTERACTIONS 1c rows 1 to 5, 2c rows 1 to 5;
 * SPK-REG-002, SPK-REG-003, SPK-REG-007, SPK-REG-008, §4.9): reasons in plain words, the bulk bar
 * for one shared reason, optimistic approval with Undo sent after the window (override, then
 * accept, each with its revision), revert on failure, the keyboard, decline with a reason and the
 * named alternative, over capacity, roles that may not decide, and the waitlist offers tab.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ADULT_ID,
  OFFERING_ID,
  OFFERING_B_ID,
  application,
  offering,
  person,
} from '../../../features/registration-finance/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';

const KIDS = {
  noah: '0192f1a0-0000-7000-8000-00000000c001',
  ava: '0192f1a0-0000-7000-8000-00000000c002',
  leo: '0192f1a0-0000-7000-8000-00000000c003',
  ivy: '0192f1a0-0000-7000-8000-00000000c004',
};
const child = (id: string, givenName: string, familyName: string, dateOfBirth: string | null) => ({
  ...person(id, givenName, familyName),
  kind: 'child',
  dateOfBirth,
});
const PEOPLE: Record<string, ReturnType<typeof child>> = {
  [KIDS.noah]: child(KIDS.noah, 'Noah', 'Birch', '2021-12-04'),
  [KIDS.ava]: child(KIDS.ava, 'Ava', 'Cedar', '2022-01-20'),
  [KIDS.leo]: child(KIDS.leo, 'Leo', 'Dune', '2022-02-02'),
  [KIDS.ivy]: child(KIDS.ivy, 'Ivy', 'Fern', '2017-03-01'),
  [ADULT_ID]: {
    ...person(ADULT_ID, 'Sam', 'Rivera'),
    contactPoints: [
      {
        id: 'cp-1',
        personId: ADULT_ID,
        kind: 'phone',
        value: '+1 702 555 0101',
        isPrimary: true,
        verifiedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  } as unknown as ReturnType<typeof child>,
};

const tooYoung = (id: string, participant: string, revision = 3) =>
  application({
    id,
    participantPersonId: participant,
    revision,
    eligibility: {
      eligible: false,
      policyVersionId: null,
      referenceDate: '2026-11-02',
      evaluatedAt: '2026-10-24T09:00:00.000Z',
      reasons: [
        {
          code: 'below_minimum_age',
          severity: 'blocking',
          message:
            'The participant is 4 on 2026-11-02; this offering requires at least 5 and at most 12.',
          source: { type: 'offering', id: OFFERING_ID },
          requiredAction: 'choose_age_appropriate_offering',
        },
      ],
      alternatives: [
        { kind: 'other_offering', message: 'Try the younger group.', offeringId: OFFERING_B_ID },
      ],
      overridden: false,
    },
  });
const NOAH = tooYoung('0192f1a0-0000-7000-8000-00000000a001', KIDS.noah);
const AVA = tooYoung('0192f1a0-0000-7000-8000-00000000a002', KIDS.ava);
const LEO = tooYoung('0192f1a0-0000-7000-8000-00000000a003', KIDS.leo);
const IVY = application({
  id: '0192f1a0-0000-7000-8000-00000000a004',
  participantPersonId: KIDS.ivy,
  status: 'awaiting_review',
  eligibility: {
    eligible: true,
    policyVersionId: null,
    referenceDate: '2026-11-02',
    evaluatedAt: '2026-10-24T09:00:00.000Z',
    reasons: [],
    alternatives: [],
    overridden: false,
  },
});

const DECIDE = mePermissions({
  actions: ['enrollment.review_application', 'enrollment.override_eligibility'],
});

function queue(awaiting: unknown[], submitted: unknown[]): FakeHandler {
  return (request) =>
    fakeResponse(200, {
      items:
        request.query.status === 'awaiting_review'
          ? awaiting
          : request.query.status === 'submitted'
            ? submitted
            : [...submitted, ...awaiting],
      nextCursor: null,
    });
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me/permissions': DECIDE,
    'GET /applications': queue([IVY], [NOAH, AVA, LEO]),
    'GET /people/{id}': (request) => {
      const found = PEOPLE[request.params.id ?? ''];
      return found
        ? fakeResponse(200, found)
        : fakeResponse(404, {
            code: 'NOT_FOUND',
            message: 'Not found',
            correlationId: 'c',
            nextAction: 'verify_reference',
          });
    },
    'GET /offerings/{id}': (request) =>
      fakeResponse(
        200,
        request.params.id === OFFERING_B_ID
          ? offering({ id: OFFERING_B_ID, name: 'U5 Development' })
          : offering(),
      ),
    'GET /offering-availability': {
      status: 200,
      body: {
        items: [
          { offeringId: OFFERING_ID, status: 'available', unit: null, capacity: 16, remaining: 2 },
          {
            offeringId: OFFERING_B_ID,
            status: 'available',
            unit: null,
            capacity: 12,
            remaining: 5,
          },
        ],
        unavailableOfferingIds: [],
      },
    },
    'GET /capacity-pools': { status: 200, body: [] },
    'GET /waitlist-entries': { status: 200, body: [] },
    'GET /offerings/{id}/required-waivers': {
      status: 200,
      body: { offeringId: OFFERING_ID, waivers: [] },
    },
    'GET /people/{id}/waivers': {
      status: 200,
      body: { personId: KIDS.noah, evaluated: true, waivers: [] },
    },
    'GET /waitlist-queue': {
      status: 200,
      body: { items: [], nextCursor: null, counts: { waiting: 0, offered: 0 } },
    },
    'POST /applications/{id}/override-eligibility': (request) =>
      fakeResponse(200, { ...NOAH, id: request.params.id, revision: 4 }),
    'POST /applications/{id}/accept': (request) =>
      fakeResponse(200, { ...NOAH, id: request.params.id, status: 'accepted', revision: 5 }),
    'POST /applications/{id}/decline': (request) =>
      fakeResponse(200, { ...NOAH, id: request.params.id, status: 'declined' }),
    ...overrides,
  };
}

async function open(overrides: Record<string, FakeHandler> = {}, path = '/registrations') {
  const user = userEvent.setup();
  const app = createTestApp({ routes: routes(overrides) });
  render(app.at(path));
  if (!path.includes('tab=')) await screen.findByRole('button', { name: /^Noah Birch/ });
  return { user, app };
}

const posts = (app: ReturnType<typeof createTestApp>, route: string) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === route);

describe('S 1c registrations triage', () => {
  it('SPK-REG-002: the tabs count, and each reason is a plain sentence with its glyph badge', async () => {
    await open();
    expect(screen.getByRole('tab', { name: /Needs a decision\s*4/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const table = screen.getByRole('table');
    expect(
      within(table).getByRole('button', { name: /^Noah Birch\s*4 y 10 m/ }),
    ).toBeInTheDocument();
    expect(table).toHaveTextContent('▲ Turns 5 on Dec 4');
    expect(table).toHaveTextContent('◷ Needs approval');
    const rail = screen.getByRole('complementary', { name: 'Decision for Noah Birch' });
    expect(rail).toHaveTextContent('Below the age band');
    expect(rail).toHaveTextContent(
      'Spring academy U10 is for ages 5 to 12 on Nov 2. Noah turns 5 on Dec 4, so is 32 days short.',
    );
    expect(within(rail).getByRole('button', { name: /Approve as an exception/ })).toBeEnabled();
    expect(within(rail).getByRole('button', { name: 'Offer U5 Development' })).toBeEnabled();
  });

  it('INTERACTIONS 1c row 2: rows with one shared reason get the bulk bar; mixed reasons do not approve together', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('checkbox', { name: 'Select Noah Birch' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Ava Cedar' }));
    // X selects the focused row (Noah is focused first; J moves to Ava, then Leo).
    await user.keyboard('jj');
    await user.keyboard('x');
    const bar = screen.getByRole('region', { name: 'Selected applications' });
    expect(bar).toHaveTextContent('3 selected');
    expect(bar).toHaveTextContent('same reason: below the age band');
    expect(within(bar).getByRole('button', { name: 'Approve 3' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Ivy Fern' }));
    expect(bar).toHaveTextContent('different reasons');
    expect(within(bar).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('INTERACTIONS 1c row 4: Approve is optimistic; Undo within the window sends nothing', async () => {
    const { user, app } = await open();
    await user.click(screen.getByRole('button', { name: /Approve as an exception/ }));
    expect(screen.queryByRole('button', { name: /^Noah Birch/ })).toBeNull();
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Approved Noah Birch. The family is told after 5 s.');
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: /^Noah Birch/ })).toBeInTheDocument();
    expect(posts(app, '/applications/{id}/accept')).toHaveLength(0);
    expect(posts(app, '/applications/{id}/override-eligibility')).toHaveLength(0);
  });

  it('SPK-REG-007: after the window an exception is the override with its reason, then the acceptance with the new revision', async () => {
    const { user, app } = await open();
    await user.click(screen.getByRole('button', { name: /Approve as an exception/ }));
    const toast = await screen.findByTestId('toast');
    // Closing the toast ends the undo window (as its 5 s would).
    await user.click(within(toast).getByRole('button', { name: 'Dismiss message' }));
    await waitFor(() => expect(posts(app, '/applications/{id}/accept')).toHaveLength(1));
    const [override] = posts(app, '/applications/{id}/override-eligibility');
    expect(override?.params).toEqual({ id: NOAH.id });
    expect(override?.body).toMatchObject({
      expectedRevision: 3,
      reason: 'Approved as an exception: below the age band (Turns 5 on Dec 4).',
    });
    expect(override?.headers['idempotency-key']).toBeTruthy();
    expect(posts(app, '/applications/{id}/accept')[0]?.body).toMatchObject({ expectedRevision: 4 });
  });

  it('a refused approval brings the row back and says what did not save', async () => {
    const { user } = await open({
      'POST /applications/{id}/override-eligibility': {
        status: 409,
        body: {
          code: 'STALE_REVISION',
          message: 'The application changed.',
          correlationId: 'c',
          nextAction: 'reload',
        },
      },
    });
    await user.click(screen.getByRole('button', { name: /Approve as an exception/ }));
    await user.click(
      within(await screen.findByTestId('toast')).getByRole('button', { name: 'Dismiss message' }),
    );
    expect(
      await screen.findByText(/Noah Birch was not approved: The application changed/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Noah Birch/ })).toBeInTheDocument();
  });

  it('keyboard: J and K move the rail, A approves, D asks for a reason', async () => {
    const { user } = await open();
    await user.keyboard('j');
    expect(
      screen.getByRole('complementary', { name: 'Decision for Ava Cedar' }),
    ).toBeInTheDocument();
    await user.keyboard('k');
    expect(
      screen.getByRole('complementary', { name: 'Decision for Noah Birch' }),
    ).toBeInTheDocument();
    await user.keyboard('d');
    expect(await screen.findByRole('dialog', { name: 'Decline Noah Birch?' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('a');
    expect(await screen.findByTestId('toast')).toHaveTextContent('Approved Noah Birch');
  });

  it('S 3f: the reason and its message go to the family; the named alternative is offered by default', async () => {
    const { user, app } = await open();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline Noah Birch?' });
    expect(within(dialog).getByRole('radio', { name: 'Outside the age range' })).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', {
        name: /Offer U5 Development instead \(5 places left\)/,
      }),
    ).toBeChecked();
    const message = within(dialog).getByRole('textbox', { name: 'Message to the family' });
    expect(message).toHaveValue(
      'Noah is outside the age range for this activity. We recommend U5 Development this season, which fits their age.',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Decline and offer U5 Dev' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /Offer U5 Development/ }));
    expect(within(dialog).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    await user.clear(message);
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Write the message the family will read.',
    );
    await user.type(message, 'Noah can try again next season.');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await user.click(
      within(await screen.findByTestId('toast')).getByRole('button', { name: 'Dismiss message' }),
    );
    await waitFor(() =>
      expect(posts(app, '/applications/{id}/decline')[0]?.body).toMatchObject({
        expectedRevision: 3,
        reason: 'Noah can try again next season.',
      }),
    );
  });

  it('over capacity: "Approve and over-fill by 1" raises the capacity, then accepts', async () => {
    const { user, app } = await open({
      'GET /offering-availability': {
        status: 200,
        body: {
          items: [
            { offeringId: OFFERING_ID, status: 'full', unit: null, capacity: 16, remaining: 0 },
          ],
          unavailableOfferingIds: [],
        },
      },
      'GET /capacity-pools': {
        status: 200,
        body: [
          {
            id: 'pool-1',
            offeringId: OFFERING_ID,
            scopeType: 'offering',
            capacity: 16,
            committed: 16,
            held: 0,
            available: 0,
            revision: 7,
          },
        ],
      },
      'POST /capacity-pools/{id}/adjust': { status: 200, body: { id: 'pool-1', capacity: 17 } },
    });
    await user.click(screen.getByRole('button', { name: /Approve as an exception/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Spring academy U10 is full' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve and over-fill by 1' }));
    await user.click(
      within(await screen.findByTestId('toast')).getByRole('button', { name: 'Dismiss message' }),
    );
    await waitFor(() => expect(posts(app, '/applications/{id}/accept')).toHaveLength(1));
    expect(posts(app, '/capacity-pools/{id}/adjust')[0]?.body).toMatchObject({
      capacity: 17,
      expectedRevision: 7,
      reason: 'Over-filled by 1 to approve Noah Birch.',
    });
  });

  it('a role that may not decide sees the facts, with the decision disabled and why', async () => {
    await open({ 'GET /me/permissions': mePermissions({ actions: [] }) });
    const rail = screen.getByRole('complementary', { name: 'Decision for Noah Birch' });
    await waitFor(() =>
      expect(within(rail).getByRole('button', { name: /Approve as an exception/ })).toBeDisabled(),
    );
    expect(rail).toHaveTextContent('Deciding needs a program, league or general manager');
  });
});

describe('S 2c waitlist offers', () => {
  const NOW = Date.parse('2026-10-24T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const offer = (over: Record<string, unknown>) => ({
    id: 'offer-1',
    waitlistEntryId: 'w-1',
    poolId: 'pool-1',
    holdId: 'hold-1',
    quantity: 1,
    offeredAt: iso(NOW - 23 * 3_600_000),
    expiresAt: iso(NOW + 60 * 60_000),
    status: 'offered',
    acceptedAt: null,
    acceptedBasketId: null,
    acceptedEnrollmentId: null,
    acceptedSessionBookingId: null,
    declinedAt: null,
    expiredAt: null,
    revision: 1,
    ...over,
  });
  const entry = (over: Record<string, unknown>) => ({
    id: 'w-1',
    offeringId: OFFERING_ID,
    poolId: 'pool-1',
    sessionId: null,
    participantPersonId: KIDS.noah,
    intent: 'youth',
    priorityBasis: 'joined_at',
    priorityRank: 0,
    joinedAt: iso(NOW - 5 * 86_400_000),
    queuedAt: iso(NOW - 5 * 86_400_000),
    preferences: {},
    payerPersonId: ADULT_ID,
    status: 'offered',
    position: null,
    offerCount: 1,
    offers: [offer({})],
    acceptedEnrollmentId: null,
    withdrawnAt: null,
    removedAt: null,
    priceTierId: null,
    selectedSessionIds: null,
    addons: [],
    uniform: null,
    revision: 2,
    createdAt: iso(NOW - 5 * 86_400_000),
    offering: {
      id: OFFERING_ID,
      name: 'Winter Break Camp · Wk 3',
      kind: 'camp',
      facilityId: 'f',
      startsOn: '2027-01-05',
    },
    openOffer: null,
    ...over,
  });
  const PASSED = entry({
    id: 'w-2',
    participantPersonId: KIDS.ivy,
    status: 'waiting',
    position: 1,
    offers: [offer({ id: 'offer-2', status: 'declined', declinedAt: iso(NOW - 3_600_000) })],
  });
  const NEXT = entry({
    id: 'w-3',
    participantPersonId: KIDS.ava,
    status: 'waiting',
    position: 2,
    offers: [],
    revision: 5,
  });
  function offersQueue(): FakeHandler {
    return (request) =>
      fakeResponse(200, {
        items:
          request.query.status === 'offered'
            ? [entry({})]
            : request.query.status === 'waiting'
              ? [PASSED, NEXT]
              : [],
        nextCursor: null,
        counts: { waiting: 2, offered: 1 },
      });
  }

  it('INTERACTIONS 2c: an offer running out turns amber and suggests a call; the call is noted on the row', async () => {
    const { user } = await open(
      { 'GET /waitlist-queue': offersQueue() },
      '/registrations?tab=offers',
    );
    await screen.findByText(/Running out/);
    const row = screen.getAllByRole('row').find((r) => r.textContent?.includes('Running out'))!;
    expect(row).toHaveAttribute('data-late', 'true');
    expect(row).toHaveTextContent('▲ Running out');
    expect(row).toHaveTextContent('1 h 0 m');
    await user.click(within(row).getByRole('button', { name: 'Call family' }));
    const dialog = await screen.findByRole('dialog', { name: /Call about Noah Birch/ });
    expect(await within(dialog).findByRole('link', { name: '+1 702 555 0101' })).toHaveAttribute(
      'href',
      'tel:+1 702 555 0101',
    );
    expect(dialog).toHaveTextContent('Proposed: the call note is kept on this device only');
    await user.click(within(dialog).getByRole('button', { name: 'Log the call' }));
    expect(row).toHaveTextContent(/Called/);
  });

  it('Extend waits on DEC-006; a passed offer goes to the next family with Offer to next', async () => {
    const { user, app } = await open(
      {
        'GET /waitlist-queue': offersQueue(),
        'POST /waitlist-entries/{id}/offer': { status: 200, body: NEXT },
      },
      '/registrations?tab=offers',
    );
    const live = (await screen.findAllByRole('row')).find((r) =>
      r.textContent?.includes('Running out'),
    )!;
    await user.click(within(live).getByRole('button', { name: 'Extend' }));
    const menu = within(live).getByRole('menu', { name: 'Extend the offer' });
    expect(within(menu).getByRole('menuitem', { name: '+12 h' })).toBeDisabled();
    expect(menu).toHaveTextContent('Pending decision DEC-006');
    const passed = screen.getAllByRole('row').find((r) => r.textContent?.includes('Passed'))!;
    expect(passed).toHaveTextContent('Ava Cedar');
    await user.click(within(passed).getByRole('button', { name: 'Offer to next' }));
    await waitFor(() =>
      expect(posts(app, '/waitlist-entries/{id}/offer')[0]?.params).toEqual({ id: 'w-3' }),
    );
    expect(posts(app, '/waitlist-entries/{id}/offer')[0]?.body).toMatchObject({
      expectedRevision: 5,
    });
    // The auto-offer setting is proposed and read-only (pending decision 4).
    expect(screen.getByRole('switch', { name: 'Offer the next family by itself' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Withdraw asks first, then ends the offer through the staff removal with a reason', async () => {
    const far = entry({ offers: [offer({ expiresAt: iso(NOW + 20 * 3_600_000) })] });
    const { user, app } = await open(
      {
        'GET /waitlist-queue': (request) =>
          fakeResponse(200, {
            items: request.query.status === 'offered' ? [far] : [],
            nextCursor: null,
            counts: { waiting: 0, offered: 1 },
          }),
        'POST /waitlist-entries/{id}/remove': { status: 200, body: far },
      },
      '/registrations?tab=offers',
    );
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw this offer?' });
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw offer' }));
    await waitFor(() =>
      expect(posts(app, '/waitlist-entries/{id}/remove')[0]?.body).toMatchObject({
        expectedRevision: 2,
        reason: 'Offer withdrawn by staff; the place returns to the queue.',
      }),
    );
  });

  it('the front desk is told the offers are managed by managers (enrollment.manage_waitlist)', async () => {
    await open(
      {
        'GET /waitlist-queue': {
          status: 403,
          body: {
            code: 'ACCESS_DENIED',
            message: 'Not allowed',
            correlationId: 'c',
            nextAction: 'request_access',
          },
        },
      },
      '/registrations?tab=offers',
    );
    expect(
      await screen.findByText(/Program, league and general managers manage offers/),
    ).toBeInTheDocument();
  });
});
