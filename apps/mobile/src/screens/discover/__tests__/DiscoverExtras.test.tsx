/**
 * SCR-C-07 Discover additions of the park UI redesign: free-text search (`GET /v1/offerings?q=`),
 * promotion badges from `PublicOffering.promotions` (automatic discounts only), and "Picked for
 * <child>" from `GET /v1/me/offering-suggestions` (age band only, never an eligibility decision).
 * Explore v2 (ADR-008): the search box searches on the keyboard's search key or after a pause,
 * promotions are tags on the picture card, suggestions are picture tiles with person chips.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { groupForExplore } from '../../../features/register/fit';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import {
  familyRoutes,
  IDS,
  offering,
  offeringSession,
  page,
} from '../../../features/registration/testing/fixtures';
import {
  DiscoverScreen,
  exploreQuery,
  forPerson,
  searchProblem,
  whenRange,
} from '../DiscoverScreen';

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

const CAMP = offering({
  id: IDS.offering2,
  name: 'Winter Break Soccer Camp',
  kind: 'camp',
  ageBand: { minAgeYears: 5, maxAgeYears: 13 },
  promotions: [EARLY_BIRD],
});

describe('SCR-C-07 Discover: search, promotions and suggestions', () => {
  it('a one-letter search is a field message and nothing is sent', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const before = app.fake.requests.filter((r) => r.route === '/offerings').length;

    fireEvent.changeText(screen.getByLabelText('Search activities'), 'a');
    fireEvent(screen.getByLabelText('Search activities'), 'submitEditing');
    expect(screen.getByText('✕ Type at least 2 characters.')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings')).toHaveLength(before);
    expect(searchProblem('  ab ')).toBeNull();
    await app.settle();
  });
});

/** Ada is 9 on the test day, Ben 5 (dates of birth from `GET /people/{id}`). */
function person(id: string, givenName: string, dateOfBirth: string | null) {
  return {
    id,
    kind: 'child',
    givenName,
    familyName: 'Example',
    dateOfBirth,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FUTSAL = offering({
  id: '0192f1a0-0000-7000-8000-0000000000c1',
  name: 'Futsal Skills Clinic',
  ageBand: { minAgeYears: 7, maxAgeYears: 11 },
  price: {
    ...(offering().price as NonNullable<ReturnType<typeof offering>['price']>),
    basePriceMinor: 9500,
  },
});
const HOOPS = offering({
  id: '0192f1a0-0000-7000-8000-0000000000c2',
  name: 'Junior Hoops',
  ageBand: { minAgeYears: 6, maxAgeYears: 10 },
});
const KEEPERS = offering({
  id: '0192f1a0-0000-7000-8000-0000000000c3',
  name: 'Goalkeeper Basics',
  ageBand: { minAgeYears: 7, maxAgeYears: 12 },
});
const TOTS = offering({
  id: '0192f1a0-0000-7000-8000-0000000000c4',
  name: 'Tiny Tots',
  ageBand: { minAgeYears: 3, maxAgeYears: 5 },
});

function exploreRoutes(overrides: Record<string, unknown> = {}) {
  return {
    ...familyRoutes(),
    'GET /offerings': page([FUTSAL, HOOPS, KEEPERS, TOTS, CAMP]),
    'GET /people/{id}': (req: FakeRequest) =>
      fakeResponse(
        200,
        req.params.id === IDS.childA
          ? person(IDS.childA, 'Ada', '2017-03-01')
          : req.params.id === IDS.childB
            ? person(IDS.childB, 'Ben', '2021-03-01')
            : person(req.params.id as string, 'Cy', null),
      ),
    'GET /offerings/{id}/sessions': (req: FakeRequest) =>
      fakeResponse(
        200,
        req.params.id === FUTSAL.id
          ? [
              offeringSession({
                id: `${FUTSAL.id.slice(0, -2)}d1`,
                offeringId: FUTSAL.id,
                scheduledStart: '2026-10-29T00:00:00.000Z',
                scheduledEnd: '2026-10-29T01:00:00.000Z',
              }),
              offeringSession({
                id: `${FUTSAL.id.slice(0, -2)}d2`,
                offeringId: FUTSAL.id,
                sequence: 2,
                scheduledStart: '2026-11-05T01:00:00.000Z',
                scheduledEnd: '2026-11-05T02:00:00.000Z',
              }),
            ]
          : req.params.id === HOOPS.id
            ? [
                offeringSession({
                  offeringId: HOOPS.id,
                  scheduledStart: '2026-10-31T16:00:00.000Z',
                  scheduledEnd: '2026-10-31T17:00:00.000Z',
                }),
              ]
            : [],
      ),
    'GET /me/family-calendar': {
      status: 200,
      body: { from: '', to: '', participantPersonIds: [], items: [], overlaps: [] },
    },
    'GET /me/team-entries': {
      status: 200,
      body: [
        {
          teamEntry: { id: IDS.season },
          teamName: 'Desert Foxes U9',
          seasonId: IDS.season,
          seasonName: 'Fall',
          divisionName: 'U9',
          members: [{ personId: IDS.childA, roles: ['player'], rosterStatus: 'active' }],
          nextFixture: null,
        },
      ],
    },
    'GET /me/fixtures': {
      status: 200,
      body: [
        {
          id: IDS.operation,
          status: 'scheduled',
          scheduledStart: '2026-10-31T16:00:00.000Z',
          scheduledEnd: '2026-10-31T17:00:00.000Z',
          home: {
            entryId: IDS.season,
            teamId: IDS.season,
            teamName: 'Desert Foxes U9',
            availability: {},
          },
          away: null,
          venue: { timezone: 'America/Los_Angeles' },
          responses: [],
          myResponse: null,
          rosterStatus: null,
        },
      ],
    },
    'GET /offering-availability': {
      status: 200,
      body: {
        items: [
          { offeringId: FUTSAL.id, status: 'available', unit: 'seats', capacity: 12, remaining: 4 },
          { offeringId: KEEPERS.id, status: 'full', unit: 'seats', capacity: 6, remaining: 0 },
        ],
        unavailableOfferingIds: [],
      },
    },
    'GET /me/offering-suggestions': {
      status: 200,
      body: { participantPersonId: IDS.childA, basis: 'ok', items: [] },
    },
    ...overrides,
  };
}

describe('M 1d Explore: shop for one child', () => {
  it('1d row 2: "Looking for" sets the age: with Ada chosen only what fits age 9 is listed, and the hint says so; tapping her again shows everyone', async () => {
    const app = createRegistrationTestApp({ routes: exploreRoutes() });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada, 9' }));
    expect(
      screen.getByText(
        "Only showing activities for ages 9. Times that clash with Ada's calendar are flagged.",
      ),
    ).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByText('Tiny Tots')).toBeNull());
    expect(screen.getByRole('header', { name: 'All for Ada' })).toBeOnTheScreen();
    // The choice is the shared who-filter (Home and Calendar read it too).
    expect(app.services.personFilterStore?.read()).toBe(IDS.childA);
    fireEvent.press(screen.getByRole('radio', { name: 'Ada, 9' }));
    expect(await screen.findByText('Tiny Tots')).toBeOnTheScreen();
  });

  it('1d rows 3 and 4: one fit answer per card from Ada\'s calendar (fits, clashes with her team, full · waitlist) and "4 left" at five or fewer places', async () => {
    const app = createRegistrationTestApp({ routes: exploreRoutes(), personFilter: IDS.childA });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const futsal = await screen.findByTestId(`offering-${FUTSAL.id}`);
    await waitFor(() => expect(within(futsal).getByLabelText("Fits Ada's week")).toBeOnTheScreen());
    expect(within(futsal).getByLabelText('4 left')).toBeOnTheScreen();
    expect(within(futsal).getByText('$95')).toBeOnTheScreen();
    expect(within(futsal).getByText(/^Wednesdays 5:00 PM · 2 weeks$/)).toBeOnTheScreen();
    const hoops = screen.getByTestId(`offering-${HOOPS.id}`);
    expect(within(hoops).getByLabelText('Clashes with Desert Foxes')).toBeOnTheScreen();
    const keepers = screen.getByTestId(`offering-${KEEPERS.id}`);
    expect(within(keepers).getByLabelText('Full · waitlist')).toBeOnTheScreen();
  });

  it('1d row 4: when the places read fails, no places badge is shown (never guessed)', async () => {
    const app = createRegistrationTestApp({
      routes: exploreRoutes({
        'GET /offering-availability': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE')),
      }),
      personFilter: IDS.childA,
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const futsal = await screen.findByTestId(`offering-${FUTSAL.id}`);
    await waitFor(() => expect(within(futsal).getByLabelText("Fits Ada's week")).toBeOnTheScreen());
    expect(within(futsal).queryByLabelText(/left$/)).toBeNull();
    expect(screen.queryByLabelText('Full · waitlist')).toBeNull();
  });

  it('1d: a promotion is a floodlight tag on the picture of a "Picked for Ada" tile', async () => {
    const app = createRegistrationTestApp({
      routes: exploreRoutes({
        'GET /me/offering-suggestions': {
          status: 200,
          body: {
            participantPersonId: IDS.childA,
            basis: 'ok',
            items: [
              {
                offering: CAMP,
                reason: { kind: 'age_band', ageYears: 9, referenceDate: '2026-10-24' },
              },
            ],
          },
        },
      }),
      personFilter: IDS.childA,
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Picked for Ada' })).toBeOnTheScreen();
    const tile = screen.getByTestId(`picked-${CAMP.id}`);
    expect(within(tile).getByText('Early bird')).toBeOnTheScreen();
    expect(within(tile).getByText('$120 / week')).toBeOnTheScreen();
  });

  it('1d row 1: the search is sent as q after a 250 ms pause; nothing matching reads "Nothing matches. Try a sport or a day." with sport chips', async () => {
    jest.useFakeTimers();
    try {
      const app = createRegistrationTestApp({
        routes: exploreRoutes({
          'GET /offerings': (req: FakeRequest) =>
            fakeResponse(200, { items: req.query.q ? [] : [FUTSAL], nextCursor: null }),
        }),
      });
      render(<DiscoverScreen />, { wrapper: app.wrapper });
      await screen.findByText('Futsal Skills Clinic');
      fireEvent.changeText(screen.getByLabelText('Search activities'), 'zumba');
      act(() => jest.advanceTimersByTime(249));
      expect(app.fake.requests.some((r) => r.query.q === 'zumba')).toBe(false);
      act(() => jest.advanceTimersByTime(1));
      expect(await screen.findByText('Nothing matches. Try a sport or a day.')).toBeOnTheScreen();
      expect(app.fake.requests.some((r) => r.route === '/offerings' && r.query.q === 'zumba')).toBe(
        true,
      );
      fireEvent.press(within(screen.getByTestId('discover-sports')).getByText('Futsal'));
      await waitFor(() =>
        expect(
          app.fake.requests.some((r) => r.route === '/offerings' && r.query.q === 'futsal'),
        ).toBe(true),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('1d: the category chips send their kind; the filters sheet sends dates and format (only parameters the API takes)', async () => {
    const app = createRegistrationTestApp({ routes: exploreRoutes() });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Camps' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/offerings' && r.query.kind === 'camp'),
      ).toBe(true),
    );
    expect(whenRange('week', '2026-10-21')).toEqual({ from: '2026-10-21', to: '2026-10-25' });
    expect(whenRange('month', '2026-10-21')).toEqual({ from: '2026-10-21', to: '2026-10-31' });
    expect(
      exploreQuery(
        { kind: 'camp', search: ' foxes ', filter: { format: '7v7', from: '2026-11-01', to: '' } },
        { signedIn: true, organizationSlug: 'dev' },
      ),
    ).toEqual({ limit: 50, kind: 'camp', format: '7v7', from: '2026-11-01', q: 'foxes' });
  });

  it('1d: the weeks of one camp are one card; a person without an age narrows nothing', () => {
    const week2 = {
      ...CAMP,
      id: IDS.offering,
      name: 'Winter Break Soccer Camp · Week 2',
      startsOn: '2026-12-28',
      endsOn: '2027-01-01',
    };
    const week1 = { ...CAMP, name: 'Winter Break Soccer Camp · Week 1' };
    const grouped = groupForExplore([week1, FUTSAL, week2]);
    expect(grouped.map((g) => g.name)).toEqual([
      'Winter Break Soccer Camp',
      'Futsal Skills Clinic',
    ]);
    expect(grouped[0]?.members.map((m) => m.id)).toEqual([week1.id, week2.id]);
    expect(forPerson([FUTSAL, TOTS], { age: null })).toHaveLength(2);
    expect(forPerson([FUTSAL, TOTS], { age: 4 }).map((o) => o.name)).toEqual(['Tiny Tots']);
  });
});
