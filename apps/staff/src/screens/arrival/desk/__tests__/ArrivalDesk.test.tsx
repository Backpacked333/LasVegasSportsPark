/**
 * Staff S 2a / S 3c / S 3d, the arrival desk: SPK-ENTRY-004 (one verdict per person from the
 * scan's arrival checks), SPK-ENTRY-001 / SPK-AT-015 (separate arrival, check-in and attendance
 * records for the people actually checked in), SPK-REG-011 (the parent signs on the tablet, staff
 * never sign) and §4.15 / SPK-AT-018 (offline check-ins queue on the device, show on the rail
 * badge and replay in order once the connection is back).
 */
import { apiErrorBody, type FakeRequest } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADULT,
  CHECKIN_1,
  CHILD_1,
  CHILD_2,
  OFFERING,
  PASS,
  SESSION_1,
  SESSION_2,
  VISIT_1,
  checkin,
  oneFacilityMe,
  scanPerson,
  sessionActivity,
  syncBatch,
  visit,
} from '../../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../../testing/test-app';

const REFERENCE = 'spp_0123456789abcdef0123';
const POLICY_VERSION = '0192f1a0-0000-7000-8000-0000000000b9';

const waiverIssue = {
  code: 'waiver_missing',
  severity: 'blocking',
  message: '"Liability waiver" has not been accepted for this participant.',
  nextAction: 'accept_waiver',
  reference: { type: 'policy_version', id: POLICY_VERSION },
};
const notOnSite = {
  code: 'not_on_site',
  severity: 'warning',
  message: 'No facility arrival is recorded for this person.',
  nextAction: 'record_arrival',
  reference: null,
};

/** Sam (adult, no session), Alex (cleared, 9:00) and Blake (not cleared: waiver, 9:00). */
function deskScan(options: { blakeBlocked?: boolean } = {}) {
  const blocked = options.blakeBlocked ?? true;
  return {
    pass: { id: PASS, holderKind: 'household' },
    facilityId: FACILITY_A,
    scannedAt: '2026-10-24T12:00:00.000Z',
    window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
    people: [
      { ...scanPerson(ADULT, 'Sam', 'adult', 'household_member'), careNotes: [] },
      {
        ...scanPerson(CHILD_1, 'Alex', 'child', 'household_member', [
          { ...sessionActivity(SESSION_1, 'Junior skills'), issues: [notOnSite] },
        ]),
        careNotes: [
          { id: '0192f1a0-0000-7000-8000-0000000000c9', kind: 'allergy', body: 'Peanuts' },
        ],
      },
      {
        ...scanPerson(CHILD_2, 'Blake', 'child', 'household_member', [
          {
            ...sessionActivity(SESSION_2, 'Mini kickers'),
            issues: blocked ? [waiverIssue, notOnSite] : [notOnSite],
          },
        ]),
        careNotes: [],
      },
    ],
    recorded: 'nothing',
    nextAction: 'select_arriving_people_and_sessions',
  };
}

function person(id: string, givenName: string, kind: 'adult' | 'child', dateOfBirth: string) {
  return {
    status: 200,
    body: {
      id,
      kind,
      givenName,
      familyName: 'Rivera',
      dateOfBirth,
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      contactPoints: [],
    },
  };
}

/** Sam may complete forms for both children. */
function authorityOf(subject: string) {
  return {
    status: 200,
    body: {
      personId: subject,
      relationships: [],
      grants: [
        {
          grantId: `${subject.slice(0, -4)}g001`,
          relationshipId: '0192f1a0-0000-7000-8000-0000000000e9',
          relationshipKind: 'guardian',
          actorPersonId: ADULT,
          actorDisplayName: 'Sam Rivera',
          subjectPersonId: subject,
          subjectDisplayName: null,
          permission: 'complete_forms',
          source: 'staff',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
          revokedAt: null,
          status: 'effective',
          underReview: false,
          revision: 1,
        },
      ],
      households: [{ id: '0192f1a0-0000-7000-8000-0000000000f9', name: 'Rivera', memberCount: 3 }],
      pendingInvitations: [],
      accountLinked: false,
      claims: [],
    },
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /me': oneFacilityMe(),
    'POST /passes/scan': { status: 200, body: deskScan() },
    'GET /sessions': { status: 200, body: { items: [], nextCursor: null } },
    'GET /people/{id}': (request: { params: Record<string, string> }) => {
      const id = request.params['id'];
      const found =
        id === ADULT
          ? person(ADULT, 'Sam', 'adult', '1990-01-01')
          : id === CHILD_1
            ? person(CHILD_1, 'Alex', 'child', '2018-03-01')
            : person(CHILD_2, 'Blake', 'child', '2021-05-01');
      return new Response(JSON.stringify(found.body), { status: 200 });
    },
    'GET /people/{id}/authority': (request: { params: Record<string, string> }) =>
      new Response(JSON.stringify(authorityOf(request.params['id'] as string).body), {
        status: 200,
      }),
    ...extra,
  } as NonNullable<Parameters<typeof createTestApp>[0]>['routes'];
}

async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Name, phone or pass reference'), REFERENCE);
  await user.keyboard('{Enter}');
  return screen.findByRole('region', { name: /Rivera household/ });
}

const alexCard = () => screen.getByRole('article', { name: /^Alex Rivera/ });
const blakeCard = () => screen.getByRole('article', { name: /^Blake Rivera/ });

describe('S 2a arrival desk', () => {
  beforeEach(() => window.localStorage.clear());

  it('S 2a SPK-ENTRY-004: a scan answers one verdict per person with its session, and the blocking check in desk words', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival'));
    const household = await scan(user);

    expect(within(household).getByText(/Scanned Sam's pass · 3 people/)).toBeInTheDocument();
    expect(alexCard()).toHaveAccessibleName('Alex Rivera: Cleared');
    expect(within(alexCard()).getByText('✓ Cleared')).toBeInTheDocument();
    expect(within(alexCard()).getByText('9:00')).toBeInTheDocument();
    expect(blakeCard()).toHaveAccessibleName('Blake Rivera: Not cleared');
    expect(within(blakeCard()).getByText('Liability waiver not signed')).toBeInTheDocument();
    expect(
      await within(blakeCard()).findByRole('button', { name: 'Sam signs on this tablet' }),
    ).toBeInTheDocument();
    // An adult without a session is listed, never checked in.
    expect(within(household).getByText('No activity')).toBeInTheDocument();
    // The primary button names exactly who it checks in: only the cleared.
    expect(screen.getByRole('button', { name: 'Check in Alex' })).toBeEnabled();
    expect(
      screen.getByText(
        'Blake can be checked in once the waiver is signed. It refreshes by itself.',
      ),
    ).toBeInTheDocument();
    // SPK-ENTRY-003: opening the family recorded nothing.
    expect(
      app.fake.requests.filter((r) => r.method === 'POST' && r.route !== '/passes/scan'),
    ).toEqual([]);
  });

  it('S 2a: an unknown pass says "Pass not recognised. Search by name instead." with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': { status: 404, body: apiErrorBody('NOT_FOUND') },
      }),
    });
    render(app.at('/arrival'));
    await user.type(await screen.findByLabelText('Name, phone or pass reference'), REFERENCE);
    await user.keyboard('{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Pass not recognised. Search by name instead.');
    expect(alert).toHaveTextContent('Code NOT_FOUND');
  });

  it('S 2a: a name is searched (GET /people) and picking the person opens their household (POST /arrival-lookups)', async () => {
    const user = userEvent.setup();
    const { pass: _pass, ...lookup } = deskScan();
    const app = createTestApp({
      routes: routes({
        'GET /people': {
          status: 200,
          body: {
            items: [
              {
                id: ADULT,
                givenName: 'Sam',
                familyName: 'Rivera',
                kind: 'adult',
                status: 'active',
                matchedOn: 'name',
              },
            ],
            nextCursor: null,
          },
        },
        'POST /arrival-lookups': {
          status: 200,
          body: {
            ...lookup,
            holder: { kind: 'household', householdId: '0192f1a0-0000-7000-8000-0000000000f9' },
          },
        },
      }),
    });
    render(app.at('/arrival'));
    await user.type(await screen.findByLabelText('Name, phone or pass reference'), 'Rivera');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Open Sam Rivera' }));
    const household = await screen.findByRole('region', { name: /Rivera household/ });
    expect(within(household).getByText(/Found by name/)).toBeInTheDocument();
    const lookups = app.fake.requests.filter((r) => r.route === '/arrival-lookups');
    expect(lookups[0]?.body).toEqual({
      facilityId: FACILITY_A,
      holder: { kind: 'household', householdId: '0192f1a0-0000-7000-8000-0000000000f9' },
    });
    // The search term goes to the API only, never into a route.
    expect(app.fake.requests.find((r) => r.route === '/people')?.query['query']).toBe('Rivera');
  });

  it('S 2a SPK-ENTRY-001 / SPK-AT-015: "Check in" records the arrival, the check-in and the attendance of the cleared only, then one big green answer', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /visits': { status: 201, body: { visits: [visit(VISIT_1, CHILD_1)] } },
        'POST /session-checkins': {
          status: 201,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted'),
        },
        'POST /attendance-observations': { status: 201, body: {} },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(screen.getByRole('button', { name: 'Check in Alex' }));

    expect(await screen.findByRole('heading', { name: 'Checked in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checked in: Alex.');
    const visits = app.fake.requests.filter((r) => r.route === '/visits');
    expect(visits.map((r) => r.body)).toEqual([
      {
        facilityId: FACILITY_A,
        passId: PASS,
        arrivals: [{ personId: CHILD_1, visitorCategory: 'participant' }],
      },
    ]);
    const checkins = app.fake.requests.filter((r) => r.route === '/session-checkins');
    expect(checkins.map((r) => r.body)).toEqual([
      {
        personId: CHILD_1,
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
        visitId: VISIT_1,
      },
    ]);
    const observed = app.fake.requests.filter((r) => r.route === '/attendance-observations');
    expect(observed.map((r) => r.body)).toEqual([
      {
        personId: CHILD_1,
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
        observedState: 'present',
      },
    ]);
    // Separate records, separate intents (§4.9).
    const keys = [visits[0], checkins[0], observed[0]].map((r) => r?.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(3);

    // A tap holds the answer; "Next family" clears the desk.
    await user.click(screen.getByRole('heading', { name: 'Checked in' }));
    await user.click(screen.getByRole('button', { name: 'Next family' }));
    expect(screen.queryByRole('heading', { name: 'Checked in' })).toBeNull();
    expect(screen.getByLabelText('Name, phone or pass reference')).toBeInTheDocument();
  });

  it('SPK-AT-015: a cleared child left out with "Not today" is not checked in', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(screen.getByRole('button', { name: 'Not today for Alex' }));
    expect(screen.getByRole('button', { name: 'Nobody to check in' })).toBeDisabled();
    expect(alexCard()).toHaveAccessibleName('Alex Rivera: Not today');
  });

  it('S 2a §4.14: tapping the care-note pill reads the note again (an audited read)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people/{id}/care-notes': {
          status: 200,
          body: {
            personId: CHILD_1,
            notes: [
              {
                id: '0192f1a0-0000-7000-8000-0000000000c9',
                personId: CHILD_1,
                kind: 'allergy',
                body: 'Peanuts. Carries an adrenaline pen.',
                status: 'active',
                recordedAt: '2026-01-01T00:00:00.000Z',
                retiredAt: null,
                revision: 1,
              },
            ],
          },
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(within(alexCard()).getByRole('button', { name: '✕ Allergy: Peanuts' }));
    const note = await screen.findByRole('dialog', { name: 'Care notes for Alex Rivera' });
    expect(await within(note).findByText(/Carries an adrenaline pen/)).toBeInTheDocument();
    expect(within(note).getByText(/recorded in the audit log/)).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/people/{id}/care-notes')).toHaveLength(1);
  });
});

describe('S 3c the tablet handed to the parent', () => {
  beforeEach(() => window.localStorage.clear());

  const policy = {
    status: 200,
    body: {
      id: POLICY_VERSION,
      kind: 'waiver',
      key: 'liability',
      version: 1,
      title: 'Liability waiver',
      content: {
        text: '1. Assumption of risk. Sport has risks.\n\n2. Medical treatment. Staff give first aid.',
        renewal: { reacceptOnNewVersion: false, renewEveryMonths: 12 },
        enforcement: 'block',
        overrideRoles: [],
      },
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      approvalStatus: 'approved',
      approvedAt: '2026-01-01T00:00:00.000Z',
      retiredAt: null,
      retiredReason: null,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  it('SPK-REG-011: the parent signs full screen (staff tools hidden, keys kept from the shortcuts); staff take the tablet back and the verdict re-checks by itself', async () => {
    const user = userEvent.setup();
    let scans = 0;
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': () => {
          scans += 1;
          return new Response(JSON.stringify(deskScan({ blakeBlocked: scans === 1 })), {
            status: 200,
          });
        },
        'GET /policy-versions/{id}': policy,
        'GET /people/{id}/waivers': {
          status: 200,
          body: { personId: CHILD_1, evaluated: true, waivers: [] },
        },
        'POST /waiver-acceptances': { status: 201, body: {} },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(await screen.findByRole('button', { name: 'Sam signs on this tablet' }));

    const sheet = await screen.findByRole('dialog', { name: 'Liability waiver' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByText('Staff tools are hidden while you sign')).toBeInTheDocument();
    expect(
      within(sheet).getByText(/For Blake Rivera · needed before Mini kickers at 9:00/),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText('Assumption of risk · Medical treatment. Valid for 12 months.'),
    ).toBeInTheDocument();
    // Nothing is signed until the parent signs: the button says so.
    expect(within(sheet).getByRole('button', { name: 'Sign above to continue' })).toBeDisabled();
    // The accessible way to sign: type the name.
    await user.click(within(sheet).getByRole('button', { name: 'Type your name instead' }));
    await user.type(within(sheet).getByLabelText('Type your full name to sign'), 'Sam Rivera');
    await user.click(within(sheet).getByRole('button', { name: 'Sign for Blake' }));

    expect(
      await screen.findByRole('heading', { name: 'Thanks, Sam. Please hand the tablet back.' }),
    ).toBeInTheDocument();
    const accepted = app.fake.requests.filter((r) => r.route === '/waiver-acceptances');
    expect(accepted.map((r) => r.body)).toEqual([
      {
        subjectPersonId: CHILD_2,
        policyKey: 'liability',
        policyVersionId: POLICY_VERSION,
        method: 'digital',
        signedByPersonId: ADULT,
        evidence: {
          method: 'desk_tablet',
          signerPresent: true,
          signature: { kind: 'typed', name: 'Sam Rivera' },
        },
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Staff: back to the desk' }));
    // The family is opened again: Blake is cleared now and both are checked in together.
    await waitFor(() => expect(scans).toBe(2));
    expect(await screen.findByRole('button', { name: 'Check in Alex and Blake' })).toBeEnabled();
  });

  it('SPK-REG-011: handing back without signing returns with the verdict unchanged and records nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /policy-versions/{id}': policy,
        'GET /people/{id}/waivers': {
          status: 200,
          body: { personId: CHILD_1, evaluated: true, waivers: [] },
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    await user.click(await screen.findByRole('button', { name: 'Sam signs on this tablet' }));
    await user.click(await screen.findByRole('button', { name: 'Hand back without signing' }));
    expect(screen.queryByRole('dialog', { name: 'Liability waiver' })).toBeNull();
    expect(blakeCard()).toHaveAccessibleName('Blake Rivera: Not cleared');
    expect(app.fake.requests.filter((r) => r.route === '/waiver-acceptances')).toHaveLength(0);
  });
});

describe('S 3d checked in with the Wi-Fi down (§4.15, SPK-AT-018)', () => {
  beforeEach(() => window.localStorage.clear());

  it('S 3d acceptance: with the network cut two check-ins queue, show on the rail badge, and replay in order once it is back', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /passes/scan': { status: 200, body: deskScan({ blakeBlocked: false }) },
        'POST /offline-sync': (request: FakeRequest) => {
          const items = (request.body as { items: { clientObservationId: string; kind: string }[] })
            .items;
          return new Response(
            JSON.stringify(
              syncBatch(
                items.map((i) => ({
                  clientObservationId: i.clientObservationId,
                  kind: i.kind,
                  outcome: 'accepted',
                })),
              ),
            ),
            { status: 201 },
          );
        },
      }),
    });
    render(app.at('/arrival'));
    await scan(user);
    act(() => app.connectivity.set(false));

    expect(await screen.findByText(/Check-ins are saved on this tablet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check in Alex and Blake' }));

    // The answer says the check-ins wait on this tablet: nothing went to the API.
    expect(
      await screen.findByRole('heading', { name: 'Checked in · waiting to sync' }),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.filter((r) =>
        ['/visits', '/session-checkins', '/attendance-observations', '/offline-sync'].includes(
          r.route ?? '',
        ),
      ),
    ).toEqual([]);
    // Two check-ins on the rail badge (the navigation's Arrival area) and in the list.
    expect(await screen.findByTestId('nav-device-count')).toHaveTextContent('2');
    expect(
      screen.getByText('Arrival and attendance: 2 waiting to sync on this device'),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', {
      name: 'Check-ins waiting to sync, in the order they are sent',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Alex Rivera · check-in'),
      expect.stringContaining('Blake Rivera · check-in'),
    ]);
    expect(screen.getByText('2 waiting')).toBeInTheDocument();

    // Back online: one synchronisation, the items in the order they were queued.
    act(() => app.connectivity.set(true));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/offline-sync')).toHaveLength(1),
    );
    const sync = app.fake.requests.find((r) => r.route === '/offline-sync');
    const body = sync?.body as {
      facilityId: string;
      snapshot: { takenAt: string };
      items: Record<string, unknown>[];
    };
    expect(body.facilityId).toBe(FACILITY_A);
    expect(body.snapshot.takenAt).toBe('2026-10-24T12:00:00.000Z');
    expect(body.items.map((i) => [i['kind'], i['personId']])).toEqual([
      ['arrival', CHILD_1],
      ['attendance', CHILD_1],
      ['arrival', CHILD_2],
      ['attendance', CHILD_2],
    ]);
    expect(body.items[1]).toEqual(
      expect.objectContaining({
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
        observedState: 'present',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('nav-device-count')).toBeNull());
  });
});
