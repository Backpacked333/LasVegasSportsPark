/**
 * Handoff M 2f You, M 3e Child profile, M 5c Care notes and M 3h Add a child (INTERACTIONS 2f;
 * SPK-IAM-001, SPK-IAM-003, SPK-REG-011, SPK-DISC-005, §4.10, §4.14).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { obligation } from '../../../features/money/testing/fixtures';
import { CHILD, CHILD_TWO, me, ok, SELF } from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { pickDate } from '../../../testing/ui';
import { YouHub } from '../../account/YouHub';
import { AddChildScreen, addLabel } from '../AddChildScreen';
import { CareNotesEditorScreen } from '../CareNotesEditorScreen';
import { careChanges, careSummary, draftOf, whoSees } from '../care-notes-model';
import { ageOn, ChildProfileScreen, formToShow } from '../ChildProfileScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: mockBack,
    canGoBack: () => true,
  }),
}));

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
  mockReplace.mockClear();
});

const ALL = ['view', 'register', 'pay', 'complete_forms', 'collect'];
const FAMILY = [
  { subjectPersonId: CHILD, permissions: ALL },
  { subjectPersonId: CHILD_TWO, permissions: ALL },
];
const HOUSEHOLD = '0192f1a0-0000-7000-8000-00000000a0f1';
const AT = '2026-10-20T10:00:00.000Z';

const familyNames: FakeHandler = (req) => {
  const known: Record<string, string> = { [CHILD]: 'Maya', [CHILD_TWO]: 'Leo' };
  const ids = req.queryAll?.ids ?? (req.query.ids ?? '').split(',');
  return fakeResponse(200, {
    items: ids.flatMap((id) =>
      known[id]
        ? [
            {
              personId: id,
              canonicalPersonId: id,
              givenName: known[id],
              familyName: 'Ortiz',
              displayName: `${known[id]} Ortiz`,
              kind: 'child',
            },
          ]
        : [],
    ),
  });
};

const version = {
  policyVersionId: '0192f1a0-0000-7000-8000-00000000e501',
  version: 4,
  title: 'Liability waiver',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
};
function waiver(overrides: Record<string, unknown> = {}) {
  return {
    policyKey: 'liability',
    title: 'Liability waiver',
    status: 'missing',
    reason: 'never_accepted',
    currentVersion: version,
    acceptance: null,
    validUntil: null,
    lapsedAt: null,
    rule: null,
    evaluatedAt: AT,
    history: [],
    overrides: [],
    ...overrides,
  };
}

const fee = obligation({
  id: '0192f1a0-0000-7000-8000-00000000b0b1',
  description: 'Spring Rec League',
  debtor: { kind: 'person', personId: CHILD, teamEntryId: null },
  totals: {
    amountMinor: 12000,
    receivedMinor: 0,
    allocatedMinor: 0,
    remainingMinor: 12000,
    excessMinor: 0,
    currency: 'USD',
  },
  liveAttempt: null,
});

function note(id: string, kind: 'allergy' | 'care_instruction', body: string, at: string) {
  return {
    id,
    personId: CHILD,
    kind,
    body,
    status: 'active',
    recordedAt: at,
    retiredAt: null,
    revision: 2,
  };
}
const NOTES = {
  personId: CHILD,
  notes: [
    note('0192f1a0-0000-7000-8000-00000000c101', 'allergy', 'Peanuts · severe', AT),
    note(
      '0192f1a0-0000-7000-8000-00000000c102',
      'care_instruction',
      'EpiPen in the front pocket of her bag. Use it, then call 911 and me.',
      '2026-10-21T10:00:00.000Z',
    ),
  ],
  visibleToRoles: ['front_desk', 'coach'],
  readAudited: true,
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok({
      ...me(FAMILY),
      person: { ...me(FAMILY).person, givenName: 'Dana', familyName: 'Ortiz' },
    }),
    'GET /person-names': familyNames,
    'GET /me/households': ok({
      items: [
        {
          id: HOUSEHOLD,
          name: 'Ortiz household',
          members: [SELF, CHILD, CHILD_TWO].map((personId) => ({
            personId,
            displayName: 'x',
            kind: personId === SELF ? 'adult' : 'child',
            label: null,
            isSelf: personId === SELF,
          })),
          otherMemberCount: 0,
          revision: 1,
          createdAt: AT,
        },
      ],
    }),
    'GET /obligations': (req) =>
      fakeResponse(200, {
        items: req.query.debtorPersonId === CHILD ? [fee] : [],
        nextCursor: null,
      }),
    'GET /people/{id}/waivers': (req) =>
      fakeResponse(200, {
        personId: req.params.id,
        evaluated: true,
        waivers: req.params.id === CHILD_TWO ? [waiver()] : [],
      }),
    'GET /me/team-invitations': ok({ items: [], nextCursor: null }),
    'GET /people/{id}/money-summary': ok({
      personId: SELF,
      accountBalance: [],
      openObligations: 1,
      pastDueObligations: 0,
      creditsAvailable: [{ amountMinor: 2500, currency: 'USD' }],
      creditsPendingApproval: [],
      paidThisYear: [],
      refundedThisYear: [],
      paidSince: AT,
      yearTimeZone: 'America/Los_Angeles',
      asOf: AT,
    }),
    'GET /enrollments': ok({ items: [], nextCursor: null }),
    'GET /people/{id}/care-notes': ok(NOTES),
    ...overrides,
  };
}

describe('handoff M 2f You', () => {
  async function renderYou(overrides: Record<string, FakeHandler> = {}) {
    const app = createTestApp({ routes: routes(overrides), toasts: true });
    render(
      <YouHub
        me={
          {
            ...me(FAMILY),
            person: { ...me(FAMILY).person, givenName: 'Dana', familyName: 'Ortiz' },
          } as never
        }
        linked
      />,
      { wrapper: app.wrapper },
    );
    await screen.findByTestId('you-family');
    return app;
  }

  it('the family comes first, with a flag on whoever needs something; a child opens their profile', async () => {
    await renderYou();
    expect(await screen.findByText('Ortiz household · 3 people')).toBeOnTheScreen();
    // Maya has a fee to pay and Leo a form to sign: both are flagged, in words for screen readers.
    expect(await screen.findByRole('button', { name: 'Maya, needs something' })).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: 'Leo, needs something' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Maya, needs something' }));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/people/[id]', params: { id: CHILD } });
    fireEvent.press(screen.getByRole('button', { name: 'Add a child' }));
    expect(mockPush).toHaveBeenLastCalledWith('/people/new');
  });

  it('money is two tiles: one fee due opens the Pay sheet; credits from the money summary', async () => {
    await renderYou();
    const due = await screen.findByRole('button', { name: 'Due now, $120. Pay' });
    expect(await screen.findByLabelText('Credits, $25')).toBeOnTheScreen();
    fireEvent.press(due);
    expect(await screen.findByTestId('pay-sheet')).toBeOnTheScreen();
  });

  it('nothing due reads "✓ All paid"; one form to sign opens its sign sheet directly', async () => {
    await renderYou({ 'GET /obligations': ok({ items: [], nextCursor: null }) });
    expect(await screen.findByLabelText('Due now, nothing. All paid')).toBeOnTheScreen();
    const forms = await screen.findByRole('button', { name: 'Forms, 1 to sign' });
    fireEvent.press(forms);
    expect(await screen.findByText('Liability waiver')).toBeOnTheScreen();
  });

  it('Help & contact the desk opens a sheet; without a configured contact it says what to do (DEC-015)', async () => {
    await renderYou();
    fireEvent.press(screen.getByRole('button', { name: 'Help & contact the desk' }));
    expect(await screen.findByTestId('you-help')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Write to the desk' }));
    expect(mockPush).toHaveBeenLastCalledWith('/support');
  });

  it('Legends mode switches at once from You and is kept on this device', async () => {
    const app = await renderYou();
    const toggle = screen.getByRole('switch', { name: 'Legends mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.press(toggle);
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    expect(app.themeStore.read()).toBe('legends');
  });

  it('Notifications opens the notification settings; several children make care notes ask whose', async () => {
    await renderYou();
    fireEvent.press(screen.getByRole('button', { name: 'Notifications' }));
    expect(mockPush).toHaveBeenLastCalledWith('/notifications');
    await screen.findByRole('button', { name: /^Leo/ });
    fireEvent.press(screen.getByRole('button', { name: 'Care & allergy notes' }));
    fireEvent.press(await screen.findByRole('button', { name: "Leo's care notes" }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/people/[id]/care-notes',
      params: { id: CHILD_TWO },
    });
  });
});

describe('handoff M 3e Child profile', () => {
  const maya = {
    id: CHILD,
    kind: 'child',
    givenName: 'Maya',
    familyName: 'Ortiz',
    dateOfBirth: '2018-03-14',
    status: 'active',
    mergedIntoPersonId: null,
    revision: 3,
    createdAt: AT,
    updatedAt: AT,
    contactPoints: [],
  };

  it('shows the name, age and colour in words, the care notes summary and who can pick up', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /people/{id}': ok(maya),
        'GET /me/waitlist-entries': ok({ items: [], nextCursor: null }),
        'GET /people/{id}/authority': ok({
          personId: CHILD,
          relationships: [],
          grants: [
            {
              grantId: '0192f1a0-0000-7000-8000-00000000d001',
              actorPersonId: SELF,
              actorDisplayName: 'Dana Ortiz',
              permission: 'collect',
              status: 'effective',
            },
          ],
          households: [],
          pendingInvitations: [],
          accountLinked: false,
          claims: [],
        }),
      }),
    });
    render(<ChildProfileScreen personId={CHILD} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Maya Ortiz' })).toBeOnTheScreen();
    expect(await screen.findByText(/8 years · born Mar 14, 2018/)).toBeOnTheScreen();
    expect(screen.getByText('pink', { exact: false })).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'Care notes. Peanuts allergy · EpiPen in the front pocket of her bag',
      ),
    ).toBeOnTheScreen();
    expect(await screen.findByLabelText('Who can pick up: Dana')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Add a photo' }));
    expect(await screen.findByTestId('child-photo-proposed')).toBeOnTheScreen();
  });

  it('pure parts: age on a day, the form to show', () => {
    expect(ageOn('2018-03-14', new Date('2026-03-13T12:00:00Z'))).toBe(7);
    expect(ageOn('2018-03-14', new Date('2026-03-14T12:00:00Z'))).toBe(8);
    const current = waiver({ status: 'current', validUntil: '2027-01-01T00:00:00Z' });
    const missing = waiver({ policyKey: 'photo', title: 'Photo consent' });
    expect(formToShow([current, missing] as never)?.title).toBe('Photo consent');
    expect(formToShow([current] as never)?.status).toBe('current');
  });
});

describe('handoff M 5c Care notes', () => {
  it('the model: chips with severity, two instructions, and saving as retire then record', () => {
    const draft = draftOf(NOTES.notes as never);
    expect(draft.allergies.map((a) => [a.name, a.severity])).toEqual([['Peanuts', 'severe']]);
    expect(draft.ifItHappens).toMatch(/^EpiPen/);
    const changed = {
      ...draft,
      allergies: [],
      other: 'Asthma when it is very hot.',
    };
    expect(careChanges(NOTES.notes as never, changed).map((c) => c.kind)).toEqual([
      'retire',
      'record',
    ]);
    expect(careSummary(NOTES.notes as never)).toBe(
      'Peanuts allergy · EpiPen in the front pocket of her bag',
    );
    expect(whoSees('Maya', ['front_desk', 'coach'])).toBe("the desk and Maya's coaches");
  });

  it('saving retires a removed allergy with its revision and records new text; who sees it is said', async () => {
    const app = createTestApp({
      routes: routes({
        'POST /care-notes/{id}/retire': ok({ ...NOTES.notes[0], status: 'retired' }),
        'POST /people/{id}/care-notes': (req) =>
          fakeResponse(
            201,
            note(
              '0192f1a0-0000-7000-8000-00000000c199',
              'care_instruction',
              String((req.body as { body: string }).body),
              AT,
            ),
          ),
      }),
      toasts: true,
    });
    render(<CareNotesEditorScreen personId={CHILD} />, { wrapper: app.wrapper });
    expect(await screen.findByText('✕ Peanuts · severe')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('care-who-sees')).getByText(/the desk and Maya's coaches/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Remove Peanuts' }));
    fireEvent.changeText(screen.getByLabelText('Other notes for coaches'), 'Inhaler in the bag.');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    const retire = app.fake.requests.find((r) => r.route === '/care-notes/{id}/retire');
    expect(retire?.body).toEqual({
      expectedRevision: 2,
      reason: 'Changed by the family in the app',
    });
    const record = app.fake.requests.find(
      (r) => r.route === '/people/{id}/care-notes' && r.method === 'POST',
    );
    expect(record?.body).toEqual({ kind: 'care_instruction', body: 'Inhaler in the bag.' });
  });

  it('closing with unsaved changes asks "Save changes?" first; Discard leaves without saving', async () => {
    const app = createTestApp({ routes: routes() });
    render(<CareNotesEditorScreen personId={CHILD} />, { wrapper: app.wrapper });
    await screen.findByText('✕ Peanuts · severe');
    // Nothing changed: Close leaves at once.
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    fireEvent.changeText(screen.getByLabelText('If it happens'), 'Call 911.');
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Save changes?')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
    expect(mockBack).toHaveBeenCalledTimes(2);
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('handoff M 3h Add a child', () => {
  it('the button stays grey until first name and birth date, and names the child', async () => {
    const created = {
      id: '0192f1a0-0000-7000-8000-00000000b003',
      kind: 'child',
      givenName: 'Sofia',
      familyName: 'Ortiz',
      dateOfBirth: '2019-05-02',
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
      contactPoints: [],
    };
    const app = createTestApp({
      routes: routes({
        'POST /people': { status: 201, body: created },
        'POST /households/{id}/members': { status: 201, body: {} },
      }),
      toasts: true,
    });
    render(<AddChildScreen />, { wrapper: app.wrapper });
    const submit = await screen.findByTestId('add-child-submit');
    expect(submit).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText('First name'), 'Sofia');
    expect(screen.getByRole('button', { name: 'Add Sofia' })).toBeDisabled();
    pickDate(screen, 'Birth date', '2019-05-02');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Sofia' })).toBeEnabled());
    // Their colour is the next one; the ones used by Maya and Leo are faded.
    expect(
      await screen.findByText('Faded colours are already used by Maya and Leo.'),
    ).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add Sofia' }));
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    const create = app.fake.requests.find((r) => r.route === '/people' && r.method === 'POST');
    expect(create?.body).toEqual({
      kind: 'child',
      givenName: 'Sofia',
      familyName: 'Ortiz',
      dateOfBirth: '2019-05-02',
    });
    const join = app.fake.requests.find((r) => r.route === '/households/{id}/members');
    expect(join?.params.id).toBe(HOUSEHOLD);
    expect(join?.body).toEqual({ personId: created.id });
    // The account is read again, so the new chip appears everywhere.
    expect(app.fake.requests.filter((r) => r.route === '/me').length).toBeGreaterThan(1);
  });

  it('labels the button with the typed name', () => {
    expect(addLabel('')).toBe('Add');
    expect(addLabel('  Sofia ')).toBe('Add Sofia');
  });
});
