/**
 * SCR-C-37 Youth feedback and development record (SPK-YOUTH-005, SPK-YOUTH-006, SPK-COMMS-002,
 * ENR-14): what `GET /v1/me/youth-feedback` serves (published, family-visible assessments and
 * shared recommendations of the participants the account may view), shown as it comes; the
 * capability `youth_progression` turned off; error, not available, empty and offline states.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  CHILD,
  fail,
  GUARDIAN_OF_CHILD,
  me,
  names,
  offering,
  OFFERING,
  OFFERING_TWO,
  ok,
  SELF,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { formatDateOnly, scaleText, YouthFeedbackScreen } from '../YouthFeedbackScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const ASSESSMENT = {
  id: '0192f1a0-0000-7000-8000-00000000ab01',
  participantPersonId: CHILD,
  offeringId: OFFERING,
  offeringName: 'Junior Skills',
  skillArea: { key: 'dribbling', label: 'Dribbling' },
  observedOn: '2026-10-20',
  scaleValue: 3,
  scaleLabel: 'Confident',
  scaleLevels: 5,
  comments: 'Keeps the ball close under pressure.',
  publishedAt: '2026-10-22T17:00:00.000Z',
};

const RECOMMENDATION = {
  id: '0192f1a0-0000-7000-8000-00000000ac01',
  participantPersonId: CHILD,
  fromOfferingId: OFFERING,
  recommendedOfferingId: OFFERING_TWO,
  recommendedProgramId: null,
  suitability: 'Ready for the next age group: passes and positions well.',
  sharedAt: '2026-10-23T17:00:00.000Z',
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /me/permissions': mePermissions({ enabled: ['youth_progression'] }),
    'GET /me/youth-feedback': ok({ assessments: [ASSESSMENT], recommendations: [RECOMMENDATION] }),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /offerings/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === OFFERING_TWO
          ? offering(OFFERING_TWO, 'Junior Skills Next', null)
          : offering(),
      ),
    ...overrides,
  };
}

function renderScreen(overrides: Record<string, FakeHandler> = {}, reachable?: boolean) {
  const app = createTestApp({ routes: routes(overrides), reachable });
  render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
  return app;
}

beforeEach(() => mockPush.mockClear());

describe('SCR-C-37 YouthFeedbackScreen', () => {
  it('SPK-YOUTH-005: shows the shared assessment with skill area, date, scale and comments, by child', async () => {
    const app = renderScreen();
    const sam = await screen.findByTestId(`feedback-person-${CHILD}`);
    expect(await within(sam).findByRole('header', { name: 'Sam' })).toBeOnTheScreen();
    expect(within(sam).getByTestId(`assessment-${ASSESSMENT.id}`)).toHaveProp(
      'accessibilityLabel',
      'Dribbling. Observed Oct 20, 2026. Level 3 of 5: Confident. In Junior Skills. Comments: Keeps the ball close under pressure. Shared Thu, Oct 22, 10:00 AM PDT',
    );
    expect(within(sam).getByLabelText('Level 3 of 5: Confident')).toBeOnTheScreen();
    expect(screen.getByText(/Private coaching notes never\s+appear here/)).toBeOnTheScreen();
    // Names only, never the full person record; the child is not in any request path.
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
    expect(app.fake.requests.some((r) => r.path.includes(CHILD))).toBe(false);
  });

  it('SPK-YOUTH-006: a recommendation is an offer, opens the recommended activity and charges nothing', async () => {
    renderScreen();
    const card = await screen.findByTestId(`recommendation-${RECOMMENDATION.id}`);
    expect(within(card).getByLabelText('Recommendation: an offer to consider')).toBeOnTheScreen();
    expect(await within(card).findByText('Junior Skills Next')).toBeOnTheScreen();
    expect(within(card).getByText(RECOMMENDATION.suitability)).toBeOnTheScreen();
    expect(within(card).getByText(/never registers or charges anyone/)).toBeOnTheScreen();
    fireEvent.press(within(card).getByRole('button', { name: 'View the recommended activity' }));
    expect(mockPush).toHaveBeenCalledWith(`/registration/offering/${OFFERING_TWO}`);
  });

  it('shows the empty state when nothing has been shared yet', async () => {
    renderScreen({ 'GET /me/youth-feedback': ok({ assessments: [], recommendations: [] }) });
    expect(await screen.findByRole('header', { name: 'No feedback yet' })).toBeOnTheScreen();
  });

  it('shows the API error code with "Try again", and NOT_FOUND as not available', async () => {
    const app = renderScreen({
      'GET /me/youth-feedback': fail(503, 'INTEGRATION_UNAVAILABLE', 'Records are unavailable.'),
    });
    expect(await screen.findByText('Records are unavailable.')).toBeOnTheScreen();
    expect(
      screen.getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-1/),
    ).toBeOnTheScreen();
    const before = app.fake.requests.filter((r) => r.route === '/me/youth-feedback').length;
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/youth-feedback').length).toBe(
        before + 1,
      ),
    );

    screen.unmount();
    renderScreen({ 'GET /me/youth-feedback': fail(404, 'NOT_FOUND') });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('DEC-016: with youth progression turned off, says so and keeps what was shared readable', async () => {
    renderScreen({ 'GET /me/permissions': mePermissions() });
    expect(
      await screen.findByLabelText('Youth assessments and progression turned off'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Feedback and recommendations already shared with you stay here.'),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`assessment-${ASSESSMENT.id}`)).toBeOnTheScreen();
  });

  it('§4.15: offline, keeps the record with its age', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId(`assessment-${ASSESSMENT.id}`)).toBeOnTheScreen();
    now = new Date('2026-10-24T12:10:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getAllByText(/Showing information from 10 minutes ago\./).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByTestId(`assessment-${ASSESSMENT.id}`)).toBeOnTheScreen();
  });

  it('an adult\'s own record is "You"; the pending decisions are named, not invented', async () => {
    renderScreen({
      'GET /me': ok(me()),
      'GET /me/youth-feedback': ok({
        assessments: [{ ...ASSESSMENT, participantPersonId: SELF, comments: null }],
        recommendations: [],
      }),
    });
    expect(await screen.findByRole('header', { name: 'You' })).toBeOnTheScreen();
    expect(screen.getByText(/\(DEC-054, DEC-055, Program manager\)/)).toBeOnTheScreen();
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('formats date-only values and scales without guessing', () => {
    expect(formatDateOnly('2026-10-20')).toBe('Oct 20, 2026');
    expect(scaleText({ scaleValue: 2, scaleLabel: null, scaleLevels: null })).toBe('Level 2');
    expect(scaleText({ scaleValue: 4, scaleLabel: 'Strong', scaleLevels: 5 })).toBe(
      'Level 4 of 5: Strong',
    );
  });
});
