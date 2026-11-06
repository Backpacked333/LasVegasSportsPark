/**
 * SCR-C-07 Discover additions of the park UI redesign: free-text search (`GET /v1/offerings?q=`),
 * promotion badges from `PublicOffering.promotions` (automatic discounts only), and "Picked for
 * <child>" from `GET /v1/me/offering-suggestions` (age band only, never an eligibility decision).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import {
  familyRoutes,
  IDS,
  offering,
  page,
} from '../../../features/registration/testing/fixtures';
import { promotionText } from '../../../features/registration/promotions';
import { DiscoverScreen, searchProblem } from '../DiscoverScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const EARLY_BIRD = {
  discountDefinitionId: '0192f1a0-0000-7000-8000-0000000000e1',
  name: 'Early bird',
  description: null,
  basis: 'early_registration' as const,
  amountKind: 'percentage' as const,
  amountValue: 1000,
  currency: null,
  minLines: null,
  // 07:59 UTC on Nov 16 is still Nov 15 in Los Angeles: the facility's zone decides the date.
  availableUntil: '2026-11-16T07:59:00.000Z',
};
const SIBLINGS = {
  ...EARLY_BIRD,
  discountDefinitionId: '0192f1a0-0000-7000-8000-0000000000e2',
  name: 'Siblings',
  basis: 'multi_line' as const,
  amountKind: 'fixed' as const,
  amountValue: 2000,
  currency: 'USD',
  minLines: 2,
  availableUntil: null,
};

const CAMP = offering({
  id: IDS.offering2,
  name: 'Winter Break Soccer Camp',
  kind: 'camp',
  ageBand: { minAgeYears: 5, maxAgeYears: 13 },
  promotions: [EARLY_BIRD],
});

function suggestionsFor(personId: string) {
  return {
    participantPersonId: personId,
    basis: 'ok',
    items: [
      {
        offering: CAMP,
        reason: { kind: 'age_band', ageYears: 9, referenceDate: '2026-12-21' },
      },
    ],
  };
}

describe('SCR-C-07 Discover: search, promotions and suggestions', () => {
  it('searches the catalog on the server with q, and an unmatched search says what was searched', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': (req) =>
          fakeResponse(200, { items: req.query.q ? [] : [offering()], nextCursor: null }),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();

    fireEvent.changeText(screen.getByLabelText('Search activities'), 'zumba');
    fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByRole('header', { name: 'No activities match "zumba"' }),
    ).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query).toEqual({
      limit: '50',
      q: 'zumba',
    });

    fireEvent.press(screen.getByRole('button', { name: 'Show all activities' }));
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByLabelText('Search activities')).toHaveProp('value', '');
    await app.settle();
  });

  it('a one-letter search is a field message and nothing is sent', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const before = app.fake.requests.filter((r) => r.route === '/offerings').length;

    fireEvent.changeText(screen.getByLabelText('Search activities'), 'a');
    fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('✕ Type at least 2 characters.')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings')).toHaveLength(before);
    expect(searchProblem('  ab ')).toBeNull();
    await app.settle();
  });

  it('SPK-PAY-003: an automatic discount is a labelled pill on the row, dated in the facility zone', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([CAMP]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`offering-${IDS.offering2}`);
    expect(within(row).getByLabelText('Early bird: 10% off until Nov 15')).toBeOnTheScreen();
    // The row's one label reads the promotion after the status.
    expect(row.props.accessibilityLabel).toMatch(
      /Registration open, Early bird: 10% off until Nov 15$/,
    );
    expect(promotionText(SIBLINGS, 'America/Los_Angeles')).toBe(
      'Siblings: $20.00 off with 2 or more registrations',
    );
    await app.settle();
  });

  it('"Picked for <child>": suggestions by age for each family member who may be registered', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /offerings': page([offering()]),
        'GET /me/offering-suggestions': (req) =>
          fakeResponse(200, suggestionsFor(String(req.query.participantPersonId))),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });

    const card = await screen.findByTestId('picked-for');
    expect(within(card).getByRole('header', { name: 'Picked for Ada' })).toBeOnTheScreen();
    const suggestion = await within(card).findByTestId(`suggestion-${IDS.offering2}`);
    expect(suggestion.props.accessibilityLabel).toContain('Ada is 9 on Dec 21, 2026');
    expect(
      within(card).getByText(
        'Suggested by age only. Whether someone can take part is checked when you register.',
      ),
    ).toBeOnTheScreen();
    // A view-only family member is never offered (the account may not register them).
    expect(within(card).queryByRole('radio', { name: 'Cy' })).toBeNull();

    fireEvent.press(within(card).getByRole('radio', { name: 'Ben' }));
    expect(await within(card).findByRole('header', { name: 'Picked for Ben' })).toBeOnTheScreen();
    expect(
      app.fake.requests.filter((r) => r.route === '/me/offering-suggestions').at(-1)?.query,
    ).toEqual({ participantPersonId: IDS.childB, limit: '3' });

    fireEvent.press(await within(card).findByTestId(`suggestion-${IDS.offering2}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/offering/${IDS.offering2}`);
    await app.settle();
  });

  it('says so when no date of birth is recorded, and shows a failure with its code', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /offerings': page([offering()]),
        'GET /me/offering-suggestions': (req) =>
          req.query.participantPersonId === IDS.childA
            ? fakeResponse(200, {
                participantPersonId: IDS.childA,
                basis: 'date_of_birth_unknown',
                items: [],
              })
            : fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        'No date of birth is recorded for Ada, so nothing can be suggested by age. The front desk can add it.',
      ),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('radio', { name: 'Ben' }));
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('picked-for')).getByRole('button', { name: 'Try again' }),
    ).toBeOnTheScreen();
    await app.settle();
  });

  it('hides the suggestions while a filter is applied', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /offerings': page([offering()]),
        'GET /me/offering-suggestions': (req) =>
          fakeResponse(200, suggestionsFor(String(req.query.participantPersonId))),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('picked-for')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: 'Camp' }));
    expect(screen.queryByTestId('picked-for')).toBeNull();
    await app.settle();
  });
});
