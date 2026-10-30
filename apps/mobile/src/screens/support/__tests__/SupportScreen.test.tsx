/**
 * SCR-C-38 Support request and case history (SPK-SUPPORT-001..003, SPK-CAP-001; SUP-01): a
 * customer opens a request with `POST /v1/me/support-requests` (about themselves, a child they
 * view, or a team they captain, optionally naming registrations or a linked record), sees their
 * requests from `GET /v1/me/cases` and one request from `GET /v1/me/cases/{id}`; the facility
 * contact stays configuration or the pending DEC-015.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { readSupportContact } from '../../../config/app-config';
import {
  CHILD,
  enrollment,
  ENROLLMENT,
  fail,
  GUARDIAN_OF_CHILD,
  HOME_ENTRY,
  me,
  myTeamEntry,
  names,
  ok,
  SELF,
  SELF_CAPTAIN,
  teamWorkspace,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { SupportCaseScreen } from '../SupportCaseScreen';
import { SupportScreen } from '../SupportScreen';
import { draftErrors, EMPTY_DRAFT, relatedFromParams, requestBody } from '../support-model';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const CASE_ID = '0192f1a0-0000-7000-8000-00000000ca01';
const PAYMENT = '0192f1a0-0000-7000-8000-00000000cb01';

function customerCase(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    category: 'schedule',
    title: 'Practice time for Sam',
    status: 'open',
    createdAt: '2026-10-24T11:00:00.000Z',
    updatedAt: '2026-10-24T11:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /me/team-entries': ok([]),
    'GET /me/cases': ok({ items: [], nextCursor: null }),
    'POST /me/support-requests': { status: 201, body: customerCase() },
    ...overrides,
  };
}

function renderSupport(
  overrides: Record<string, FakeHandler> = {},
  options: { linked?: { type: 'payment_attempt'; id: string }; reachable?: boolean } = {},
) {
  const app = createTestApp({ routes: routes(overrides), reachable: options.reachable });
  render(<SupportScreen linked={options.linked ?? null} />, { wrapper: app.wrapper });
  return app;
}

async function fillDraft(category = 'Schedule') {
  const form = await screen.findByTestId('support-request');
  fireEvent.press(await within(form).findByRole('radio', { name: 'Sam' }));
  fireEvent.press(within(form).getByRole('radio', { name: categoryLabel(category) }));
  fireEvent.changeText(within(form).getByLabelText('Title'), 'Practice time for Sam');
  fireEvent.changeText(
    within(form).getByLabelText('What do you need?'),
    'The Saturday session moved; can Sam stay at 10?',
  );
  return form;
}

function categoryLabel(name: string): string {
  return (
    {
      Schedule: 'A schedule or activity',
      Registration: 'A registration',
      Payment: 'A payment or balance',
    } as Record<string, string>
  )[name] as string;
}

const sent = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/me/support-requests');

beforeEach(() => mockPush.mockClear());

describe('SCR-C-38 SupportScreen: opening a request (POST /v1/me/support-requests)', () => {
  it('SPK-SUPPORT-002: sends a request about a child the account views, with one key, and shows it as sent', async () => {
    const app = renderSupport();
    const form = await fillDraft();
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    expect(await screen.findByLabelText('Request sent')).toBeOnTheScreen();
    expect(sent(app)).toHaveLength(1);
    expect(sent(app)[0]?.body).toEqual({
      category: 'schedule',
      title: 'Practice time for Sam',
      description: 'The Saturday session moved; can Sam stay at 10?',
      subjectPersonId: CHILD,
      relatedRecords: [],
    });
    expect(sent(app)[0]?.headers['idempotency-key']).toMatch(/^key-/);
    // The draft is cleared for the next request; the list is read again.
    expect(within(form).getByLabelText('Title')).toHaveProp('value', '');
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/cases').length).toBeGreaterThan(1),
    );
    fireEvent.press(screen.getByRole('button', { name: 'View this request' }));
    expect(mockPush).toHaveBeenCalledWith(`/support/${CASE_ID}`);
  });

  it('a request about oneself sends no subject (the API defaults to the caller)', async () => {
    const app = renderSupport();
    const form = await screen.findByTestId('support-request');
    fireEvent.press(await within(form).findByRole('radio', { name: 'You' }));
    fireEvent.press(within(form).getByRole('radio', { name: 'My account or access' }));
    fireEvent.changeText(within(form).getByLabelText('Title'), 'Sign-in trouble');
    fireEvent.changeText(within(form).getByLabelText('What do you need?'), 'Codes do not arrive.');
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual({
      category: 'access',
      title: 'Sign-in trouble',
      description: 'Codes do not arrive.',
      relatedRecords: [],
    });
  });

  it('validation: says what is missing next to each field and sends nothing', async () => {
    const app = renderSupport();
    const form = await screen.findByTestId('support-request');
    fireEvent.press(await within(form).findByRole('button', { name: 'Send request' }));
    expect(within(form).getByText(/Choose what your request is about\./)).toBeOnTheScreen();
    expect(within(form).getByText(/Give your request a short title\./)).toBeOnTheScreen();
    expect(within(form).getByText(/Describe what you need\./)).toBeOnTheScreen();
    expect(sent(app)).toHaveLength(0);
  });

  it('§4.9: a retry after INTEGRATION_UNAVAILABLE resends the same request with the same key; the draft stays', async () => {
    let calls = 0;
    const app = renderSupport({
      'POST /me/support-requests': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', {
                nextAction: 'retry_later',
                correlationId: 'corr-sup',
              }),
            )
          : fakeResponse(201, customerCase());
      },
    });
    const form = await fillDraft();
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-sup/),
    ).toBeOnTheScreen();
    expect(within(form).getByLabelText('Title')).toHaveProp('value', 'Practice time for Sam');
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Request sent')).toBeOnTheScreen();
    expect(sent(app)).toHaveLength(2);
    expect(sent(app)[0]?.headers['idempotency-key']).toBe(sent(app)[1]?.headers['idempotency-key']);
  });

  it('§4.10: a person or record the API does not let this account name is "not available", without the code; the draft stays', async () => {
    renderSupport({ 'POST /me/support-requests': fail(404, 'NOT_FOUND') });
    const form = await fillDraft();
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(/Something this request names is not available to you/),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(within(form).getByLabelText('Title')).toHaveProp('value', 'Practice time for Sam');

    screen.unmount();
    renderSupport({ 'POST /me/support-requests': fail(403, 'ACCESS_DENIED') });
    const again = await fillDraft();
    fireEvent.press(within(again).getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(/You cannot open a request about this person or team/),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it("links one of the child's registrations, read from the API, to a registration request", async () => {
    const app = renderSupport({
      'GET /enrollments': (req) =>
        fakeResponse(200, {
          items: req.query.participantPersonId === CHILD ? [enrollment()] : [],
          nextCursor: null,
        }),
    });
    const form = await fillDraft('Registration');
    fireEvent.press(await within(form).findByRole('radio', { name: 'Junior Skills, Confirmed' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual(
      expect.objectContaining({
        category: 'registration',
        subjectPersonId: CHILD,
        relatedRecords: [{ type: 'enrollment', id: ENROLLMENT }],
      }),
    );
    expect(
      app.fake.requests.find((r) => r.route === '/enrollments')?.query.participantPersonId,
    ).toBe(CHILD);
  });

  it('a record a link pointed at is named and sent, and can be left out', async () => {
    const app = renderSupport({}, { linked: { type: 'payment_attempt', id: PAYMENT } });
    expect(
      await screen.findByText('About this payment (from the link you followed).'),
    ).toBeOnTheScreen();
    const form = await fillDraft('Payment');
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual(
      expect.objectContaining({ relatedRecords: [{ type: 'payment_attempt', id: PAYMENT }] }),
    );

    screen.unmount();
    renderSupport({}, { linked: { type: 'payment_attempt', id: PAYMENT } });
    fireEvent.press(await screen.findByRole('button', { name: 'Do not link it' }));
    expect(screen.queryByTestId('support-about')).toBeNull();
  });

  it('SPK-CAP-001: a captain opens a request for their team; the API still decides', async () => {
    const app = renderSupport({
      'GET /me/team-entries': ok([
        {
          ...myTeamEntry(),
          members: [
            { personId: me().principal.personId, roles: ['captain'], rosterStatus: 'active' },
          ],
        },
      ]),
      'GET /team-entries/{id}': ok(teamWorkspace('Lions', SELF_CAPTAIN)),
    });
    const form = await screen.findByTestId('support-request');
    fireEvent.press(await within(form).findByRole('radio', { name: 'Your team Lions, Fall 2026' }));
    expect(within(form).getByRole('radio', { name: 'A team' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: true }),
    );
    fireEvent.changeText(within(form).getByLabelText('Title'), 'Referee missing');
    fireEvent.changeText(within(form).getByLabelText('What do you need?'), 'No official came.');
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual({
      category: 'team',
      title: 'Referee missing',
      description: 'No official came.',
      teamEntryId: HOME_ENTRY,
      relatedRecords: [],
    });
  });

  it("SPK-CAP-001: a co-captain is offered the team only when the API says they act as captain (the rule set's choice)", async () => {
    const coCaptain = {
      ...myTeamEntry(),
      members: [{ personId: SELF, roles: ['co_captain'], rosterStatus: 'active' }],
    };
    const workspace = (actingAsCaptain: boolean) => {
      const base = teamWorkspace('Lions');
      return { ...base, viewer: { roles: ['co_captain'], actingAsCaptain, availableActions: [] } };
    };
    const app = renderSupport({
      'GET /me/team-entries': ok([coCaptain]),
      'GET /team-entries/{id}': ok(workspace(false)),
    });
    const form = await screen.findByTestId('support-request');
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/team-entries/{id}')?.params.id).toBe(
        HOME_ENTRY,
      ),
    );
    expect(await within(form).findByRole('radio', { name: 'Sam' })).toBeOnTheScreen();
    expect(within(form).queryByRole('radio', { name: /^Your team Lions/ })).toBeNull();

    screen.unmount();
    renderSupport({
      'GET /me/team-entries': ok([coCaptain]),
      'GET /team-entries/{id}': ok(workspace(true)),
    });
    expect(
      await screen.findByRole('radio', { name: 'Your team Lions, Fall 2026' }),
    ).toBeOnTheScreen();

    screen.unmount();
    // A workspace the API does not serve offers nothing, without the code.
    renderSupport({
      'GET /me/team-entries': ok([coCaptain]),
      'GET /team-entries/{id}': fail(404, 'NOT_FOUND'),
    });
    expect(await screen.findByRole('radio', { name: 'Sam' })).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: /^Your team Lions/ })).toBeNull();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('a registration chosen and then left by changing what the request is about is not sent', async () => {
    const app = renderSupport({
      'GET /enrollments': (req) =>
        fakeResponse(200, {
          items: req.query.participantPersonId === CHILD ? [enrollment()] : [],
          nextCursor: null,
        }),
    });
    const form = await fillDraft('Registration');
    fireEvent.press(await within(form).findByRole('radio', { name: 'Junior Skills, Confirmed' }));
    fireEvent.press(within(form).getByRole('radio', { name: 'A schedule or activity' }));
    // Nothing linked stays hidden: no registration list and no linked record is left on screen.
    expect(within(form).queryByRole('radio', { name: 'Junior Skills, Confirmed' })).toBeNull();
    expect(within(form).queryByTestId('support-about')).toBeNull();
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual(
      expect.objectContaining({ category: 'schedule', relatedRecords: [] }),
    );
  });

  it('a registration chosen and then left by naming a team instead is not sent', async () => {
    const app = renderSupport({
      'GET /enrollments': (req) =>
        fakeResponse(200, {
          items: req.query.participantPersonId === CHILD ? [enrollment()] : [],
          nextCursor: null,
        }),
      'GET /me/team-entries': ok([
        {
          ...myTeamEntry(),
          members: [{ personId: SELF, roles: ['captain'], rosterStatus: 'active' }],
        },
      ]),
      'GET /team-entries/{id}': ok(teamWorkspace('Lions', SELF_CAPTAIN)),
    });
    const form = await fillDraft('Registration');
    fireEvent.press(await within(form).findByRole('radio', { name: 'Junior Skills, Confirmed' }));
    fireEvent.press(await within(form).findByRole('radio', { name: 'Your team Lions, Fall 2026' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual(
      expect.objectContaining({ category: 'team', teamEntryId: HOME_ENTRY, relatedRecords: [] }),
    );
  });

  it('a registration a link named stays on screen with "Do not link it" whatever the request is about', async () => {
    const app = createTestApp({ routes: routes() });
    render(<SupportScreen linked={{ type: 'enrollment', id: ENROLLMENT }} />, {
      wrapper: app.wrapper,
    });
    const form = await screen.findByTestId('support-request');
    fireEvent.press(await within(form).findByRole('radio', { name: 'A schedule or activity' }));
    expect(
      within(form).getByText('About this registration (from the link you followed).'),
    ).toBeOnTheScreen();
    fireEvent.press(within(form).getByRole('button', { name: 'Do not link it' }));
    expect(within(form).queryByTestId('support-about')).toBeNull();
    fireEvent.changeText(within(form).getByLabelText('Title'), 'Moved session');
    fireEvent.changeText(within(form).getByLabelText('What do you need?'), 'Which pitch?');
    fireEvent.press(within(form).getByRole('button', { name: 'Send request' }));
    await screen.findByLabelText('Request sent');
    expect(sent(app)[0]?.body).toEqual(expect.objectContaining({ relatedRecords: [] }));
  });

  it('§4.15: offline, sending is disabled and the draft stays', async () => {
    const app = renderSupport();
    const form = await fillDraft();
    act(() => app.sources.setReachable(false));
    expect(within(form).getByRole('button', { name: 'Send request' })).toBeDisabled();
    expect(
      within(form).getByText('Sending needs a connection. Your draft stays on this screen.'),
    ).toBeOnTheScreen();
    expect(within(form).getByLabelText('Title')).toHaveProp('value', 'Practice time for Sam');
    expect(sent(app)).toHaveLength(0);
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});

describe('SCR-C-38 SupportScreen: case history (GET /v1/me/cases)', () => {
  it("lists the person's requests with their status in words and opens one", async () => {
    renderSupport({
      'GET /me/cases': ok({
        items: [
          customerCase(),
          customerCase({
            id: '0192f1a0-0000-7000-8000-00000000ca02',
            title: 'Refund question',
            category: 'payment',
            status: 'waiting_customer',
          }),
        ],
        nextCursor: null,
      }),
    });
    const history = await screen.findByTestId('support-history');
    expect(
      await within(history).findByRole('button', {
        name: 'Practice time for Sam, A schedule or activity. Sent Sat, Oct 24, 4:00 AM PDT, Open',
      }),
    ).toBeOnTheScreen();
    expect(
      within(history).getByRole('button', { name: /^Refund question, .*Waiting for you$/ }),
    ).toBeOnTheScreen();
    fireEvent.press(within(history).getByRole('button', { name: /^Practice time for Sam/ }));
    expect(mockPush).toHaveBeenCalledWith(`/support/${CASE_ID}`);
  });

  it('shows the empty state, and later pages with "Load more requests"', async () => {
    renderSupport();
    expect(await screen.findByRole('header', { name: 'No requests yet' })).toBeOnTheScreen();

    screen.unmount();
    const app = renderSupport({
      'GET /me/cases': (req) =>
        fakeResponse(
          200,
          req.query.cursor === 'c2'
            ? {
                items: [
                  customerCase({ id: '0192f1a0-0000-7000-8000-00000000ca03', title: 'Older one' }),
                ],
                nextCursor: null,
              }
            : { items: [customerCase()], nextCursor: 'c2' },
        ),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Load more requests' }));
    expect(await screen.findByText('Older one')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/me/cases').at(-1)?.query).toEqual({
      limit: '20',
      cursor: 'c2',
    });
  });

  it('shows a failed list with its code and "Try again"; not available without the code', async () => {
    renderSupport({ 'GET /me/cases': fail(500, 'INTERNAL_ERROR') });
    const history = await screen.findByTestId('support-history');
    expect(await within(history).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(history).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();

    screen.unmount();
    renderSupport({ 'GET /me/cases': fail(404, 'NOT_FOUND') });
    const hidden = await screen.findByTestId('support-history');
    expect(await within(hidden).findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });
});

describe('SCR-C-38 SupportScreen: contact and changes', () => {
  it('DEC-015: with no configured contact, shows the pending decision and invents no number or hours', async () => {
    renderSupport();
    expect(await screen.findByText('Ask at the front desk.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /The facility’s support phone, email and hours is not available yet: it depends on DEC-015/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Call the facility' })).toBeNull();
  });

  it('shows the configured contact with labelled call and email buttons', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const app = createTestApp({
      routes: routes(),
      config: {
        supportContact: {
          phone: '+1 (555) 010-0000',
          email: 'desk@example.test',
          hours: 'Daily 8 to 8',
        },
      },
    });
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Phone: +1 (555) 010-0000')).toBeOnTheScreen();
    expect(screen.getByLabelText('Hours: Daily 8 to 8')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Call the facility' }));
    expect(openURL).toHaveBeenCalledWith('tel:+15550100000');
    fireEvent.press(screen.getByRole('button', { name: 'Email the facility' }));
    expect(openURL).toHaveBeenCalledWith('mailto:desk@example.test');
    openURL.mockRestore();
  });

  it('SPK-SUPPORT-003: says support never replaces the change and links to where changes are made', async () => {
    renderSupport();
    expect(
      await screen.findByText(/A conversation with support never replaces the change itself/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open enrollments' }));
    expect(mockPush).toHaveBeenCalledWith('/enrollments');
    fireEvent.press(screen.getByRole('button', { name: 'Open payments' }));
    expect(mockPush).toHaveBeenCalledWith('/payments');
  });

  it('reads the support contact only when the operator configured a phone or email', () => {
    expect(readSupportContact(undefined)).toBeNull();
    expect(readSupportContact({ phone: null, email: '  ', hours: 'Daily' })).toBeNull();
    expect(readSupportContact({ phone: ' 555 ', email: null, hours: null })).toEqual({
      phone: '555',
      email: null,
      hours: null,
    });
  });
});

describe('SCR-C-38 SupportCaseScreen (GET /v1/me/cases/{id})', () => {
  it("shows the request's status in words with when it was sent, updated and resolved", async () => {
    const app = createTestApp({
      routes: {
        'GET /me/cases/{id}': ok(
          customerCase({
            status: 'resolved',
            updatedAt: '2026-10-24T11:30:00.000Z',
            resolvedAt: '2026-10-24T11:30:00.000Z',
          }),
        ),
      },
    });
    render(<SupportCaseScreen caseId={CASE_ID} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('support-case-status')).toHaveProp(
      'accessibilityLabel',
      'Resolved',
    );
    expect(screen.getByRole('header', { name: 'Practice time for Sam' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Resolved: Sat, Oct 24, 4:30 AM PDT')).toBeOnTheScreen();
    expect(screen.getByLabelText('About: A schedule or activity')).toBeOnTheScreen();
    expect(
      screen.getByText(/Notes and internal details stay with the facility team/),
    ).toBeOnTheScreen();
  });

  it('"Waiting for you" says what it means', async () => {
    const app = createTestApp({
      routes: { 'GET /me/cases/{id}': ok(customerCase({ status: 'waiting_customer' })) },
    });
    render(<SupportCaseScreen caseId={CASE_ID} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Waiting for you')).toBeOnTheScreen();
    expect(screen.getByText(/needs something from you and will contact you/)).toBeOnTheScreen();
  });

  it('§4.10: someone else\'s request is "not available"; a malformed link sends no request', async () => {
    const app = createTestApp({ routes: { 'GET /me/cases/{id}': fail(404, 'NOT_FOUND') } });
    render(<SupportCaseScreen caseId={CASE_ID} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();

    screen.unmount();
    const bad = createTestApp({ routes: {} });
    render(<SupportCaseScreen caseId={null} />, { wrapper: bad.wrapper });
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(bad.fake.requests.some((r) => r.path.startsWith('/me/cases'))).toBe(false);
  });

  it('shows a failed read with its code and "Try again"', async () => {
    const app = createTestApp({
      routes: { 'GET /me/cases/{id}': fail(503, 'INTEGRATION_UNAVAILABLE') },
    });
    render(<SupportCaseScreen caseId={CASE_ID} />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});

describe('support-model', () => {
  it('accepts only a known record type and a UUID from a link', () => {
    expect(relatedFromParams({ aboutType: 'enrollment', aboutId: ENROLLMENT })).toEqual({
      type: 'enrollment',
      id: ENROLLMENT,
    });
    expect(relatedFromParams({ aboutType: 'person', aboutId: ENROLLMENT })).toBeNull();
    expect(relatedFromParams({ aboutType: 'enrollment', aboutId: 'Sam' })).toBeNull();
    expect(relatedFromParams({})).toBeNull();
  });

  it('checks the draft as the API does and builds only the accepted fields', () => {
    expect(Object.keys(draftErrors(EMPTY_DRAFT)).sort()).toEqual([
      'category',
      'description',
      'title',
    ]);
    expect(
      draftErrors({ ...EMPTY_DRAFT, category: 'other', title: 'x'.repeat(201), description: 'y' })
        .title,
    ).toBe('Keep the title to 200 characters.');
    expect(
      requestBody(
        {
          ...EMPTY_DRAFT,
          category: 'other',
          title: ' Hi ',
          description: ' There ',
          subjectPersonId: 'self',
        },
        'self',
      ),
    ).toEqual({ category: 'other', title: 'Hi', description: 'There', relatedRecords: [] });
  });
});
