/**
 * Public pages and the lobby display (SPK-SCHED-010, proposed amendment PA-06): routes outside
 * the session guard that show a facility's day schedule and a public competition's fixtures,
 * results, standings and bracket, plus the staff controls that enable them.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ID, competition, fail, ok } from '../../../features/competition/__tests__/fixtures';
import { FACILITY_A, createTestApp, mePermissions } from '../../../testing/test-app';

const ORG = 'desert-park';
const CODE = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const SEASON_CODE = 'b1b2c3d4e5f6a7b8c9d0e1f2';
const TZ = 'America/Los_Angeles';

const entry = (hour: number, overrides: Record<string, unknown> = {}) => ({
  startsAt: `2026-11-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
  endsAt: `2026-11-21T${String(hour + 1).padStart(2, '0')}:00:00.000Z`,
  fields: ['Field 1'],
  kind: 'game',
  title: 'League game',
  score: null,
  ...overrides,
});

const schedule = (
  entries: unknown[] = [
    entry(17, { kind: 'reserved', title: 'Reserved', fields: ['Field 2'] }),
    entry(18, { kind: 'class', title: 'Class' }),
    entry(19, { title: 'Comets vs Rockets', score: { home: 5, away: 3 } }),
    entry(20),
  ],
) => ({
  organizationName: 'Desert Park',
  facilityName: 'Main complex',
  timezone: TZ,
  date: '2026-11-21',
  fields: ['Field 1', 'Field 2'],
  entries,
  computedAt: '2026-11-21T16:30:00.000Z',
  cacheSeconds: 30,
});

const fixture = (overrides: Record<string, unknown> = {}) => ({
  round: 1,
  startsAt: '2026-11-17T03:00:00.000Z',
  endsAt: '2026-11-17T04:00:00.000Z',
  timezone: TZ,
  fields: ['Field 1'],
  status: 'scheduled',
  home: 'Comets',
  away: 'Rockets',
  score: null,
  ...overrides,
});

const standing = (position: number, team: string, points: number) => ({
  position,
  team,
  played: 1,
  won: points === 3 ? 1 : 0,
  drawn: 0,
  lost: points === 3 ? 0 : 1,
  goalsFor: points === 3 ? 5 : 3,
  goalsAgainst: points === 3 ? 3 : 5,
  goalDifference: points === 3 ? 2 : -2,
  points,
});

const season = (overrides: Record<string, unknown> = {}) => ({
  organizationName: 'Desert Park',
  competitionName: 'Monday Men Open',
  competitionKind: 'league',
  sportFormat: 'indoor_boarded',
  seasonName: 'Winter 2026',
  startsOn: '2026-11-16',
  endsOn: '2027-01-25',
  divisions: [
    {
      name: 'Open',
      fixtures: [
        fixture({ status: 'played', score: { home: 5, away: 3 } }),
        fixture({
          round: 2,
          home: 'Rockets',
          away: 'Comets',
          startsAt: '2026-11-24T03:00:00.000Z',
        }),
      ],
      standings: [standing(1, 'Comets', 3), standing(2, 'Rockets', 0)],
    },
  ],
  otherFixtures: [],
  bracket: null,
  computedAt: '2026-11-21T16:30:00.000Z',
  cacheSeconds: 30,
  ...overrides,
});

const SCHEDULE_ROUTE = 'GET /public/{organization}/schedule/{code}';
const SEASON_ROUTE = 'GET /public/{organization}/seasons/{code}';
const notAvailable = fail(404, 'NOT_FOUND', 'verify_reference', {
  message: 'This view is not available.',
  details: { code: 'PUBLIC_VIEW_NOT_AVAILABLE' },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SPK-SCHED-010 public pages (no sign-in)', () => {
  it('SPK-SCHED-010: the day schedule is shown by field and time to a visitor who is not signed in, with the time it was last updated', async () => {
    const app = createTestApp({ session: null, routes: { [SCHEDULE_ROUTE]: ok(schedule()) } });
    render(app.at(`/public/${ORG}/schedule/${CODE}`));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Main complex schedule' }),
    ).toBeInTheDocument();
    // Not the sign-in page.
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.getByText('Desert Park')).toBeInTheDocument();
    expect(screen.getByText('Saturday, November 21, 2026')).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('9:00 AM to 10:00 AM')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Field 2')).toBeInTheDocument();
    // A private booking is occupied time without a name.
    expect(within(rows[0]!).getByText('Reserved')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Class')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Comets vs Rockets')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('5 : 3')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('League game')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^Last updated Sat, Nov 21, 8:30 AM$/);
    // The request names the slug and the code, and carries no credentials.
    const request = app.fake.requests.find(
      (r) => r.route === '/public/{organization}/schedule/{code}',
    );
    expect(request?.params).toMatchObject({ organization: ORG, code: CODE });
    expect(request?.headers['authorization']).toBeUndefined();
    // Another day is a link, not a record id.
    expect(screen.getByRole('link', { name: 'Next day' })).toHaveAttribute(
      'href',
      `/public/${ORG}/schedule/${CODE}?date=2026-11-22`,
    );
  });

  it('SPK-SCHED-010: a view that is not public, unknown or turned off reads "Not available" and nothing else', async () => {
    const app = createTestApp({ session: null, routes: { [SCHEDULE_ROUTE]: notAvailable } });
    render(app.at(`/public/${ORG}/schedule/${CODE}`));
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('SPK-SCHED-010: fixtures, results, standings and the bracket of a public season each have a page', async () => {
    const app = createTestApp({ session: null, routes: { [SEASON_ROUTE]: ok(season()) } });
    const { unmount } = render(app.at(`/public/${ORG}/seasons/${SEASON_CODE}/fixtures`));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Monday Men Open: fixtures' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Winter 2026')).toBeInTheDocument();
    // Fixtures: the game still to come, with its field; the played one is a result.
    let table = screen.getByRole('table');
    expect(within(table).getByText('Rockets vs Comets')).toBeInTheDocument();
    expect(within(table).queryByText('Comets vs Rockets')).toBeNull();
    expect(within(table).getByText('Field 1')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Season pages' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Fixtures', 'Results', 'Standings']);
    unmount();

    const results = render(app.at(`/public/${ORG}/seasons/${SEASON_CODE}/results`));
    table = await screen.findByRole('table');
    expect(within(table).getByText('Comets vs Rockets')).toBeInTheDocument();
    expect(within(table).getByText('5 : 3')).toBeInTheDocument();
    results.unmount();

    const standings = render(app.at(`/public/${ORG}/seasons/${SEASON_CODE}/standings`));
    table = await screen.findByRole('table', { name: 'Standings of Open' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('rowheader', { name: 'Comets' })).toBeInTheDocument();
    expect(
      within(rows[0]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1', '1', '1', '0', '0', '5 : 3', '3']);
    standings.unmount();

    const cup = createTestApp({
      session: null,
      routes: {
        [SEASON_ROUTE]: ok(
          season({
            competitionKind: 'tournament',
            bracket: [
              {
                round: 1,
                slot: 1,
                division: 'Open',
                home: 'Lions',
                away: 'Tigers',
                score: { home: 2, away: 1 },
                winner: 'home',
                startsAt: null,
              },
              {
                round: 2,
                slot: 1,
                division: 'Open',
                home: 'Lions',
                away: null,
                score: null,
                winner: null,
                startsAt: null,
              },
            ],
          }),
        ),
      },
    });
    render(cup.at(`/public/${ORG}/seasons/${SEASON_CODE}/bracket`));
    const first = await screen.findByRole('region', { name: 'Round 1' });
    expect(within(first).getByText('Lions')).toBeInTheDocument();
    expect(within(first).getByText('Tigers')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Round 2' })).getByText('To be decided'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Season pages' })).getByRole('link', {
        name: 'Bracket',
      }),
    ).toBeInTheDocument();
  });

  it('SPK-SCHED-010: a public competition lists its seasons by public code', async () => {
    const app = createTestApp({
      session: null,
      routes: {
        'GET /public/{organization}/competitions/{code}': ok({
          organizationName: 'Desert Park',
          name: 'Monday Men Open',
          kind: 'league',
          sportFormat: 'indoor_boarded',
          seasons: [
            {
              code: SEASON_CODE,
              name: 'Winter 2026',
              startsOn: '2026-11-16',
              endsOn: '2027-01-25',
            },
          ],
          computedAt: '2026-11-21T16:30:00.000Z',
          cacheSeconds: 30,
        }),
      },
    });
    render(app.at(`/public/${ORG}/competitions/${CODE}`));
    expect(await screen.findByRole('link', { name: 'Standings of Winter 2026' })).toHaveAttribute(
      'href',
      `/public/${ORG}/seasons/${SEASON_CODE}/standings`,
    );
    expect(screen.queryByRole('link', { name: /Bracket/ })).toBeNull();
  });
});

describe('SPK-SCHED-010 lobby display', () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    entry(17 + index, { title: `Game ${index + 1}` }),
  );

  it("SPK-SCHED-010: the lobby advances by itself through the pages of today's schedule and shows when it was last updated", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = createTestApp({
      session: null,
      // Before the first entry ends, so every entry is still to come.
      now: () => new Date('2026-11-21T16:30:00.000Z'),
      routes: {
        [SCHEDULE_ROUTE]: ok(schedule(many)),
        [SEASON_ROUTE]: ok(season()),
      },
    });
    render(app.at(`/lobby/${ORG}/${CODE}?rows=3&seconds=5&seasons=${SEASON_CODE}`));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Main complex' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Last updated Sat, Nov 21, 8:30 AM');
    expect(await screen.findByRole('region', { name: 'Today, page 1 of 2' })).toBeInTheDocument();
    expect(screen.getByText('Game 1')).toBeInTheDocument();
    expect(screen.getByText('Game 3')).toBeInTheDocument();
    expect(screen.queryByText('Game 4')).toBeNull();
    await waitFor(() => expect(screen.getByText('Screen 1 of 3')).toBeInTheDocument());
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('region', { name: 'Today, page 2 of 2' })).toBeInTheDocument();
    expect(screen.getByText('Game 5')).toBeInTheDocument();
    // The standings of the public season named in the link follow the schedule.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const standings = screen.getByRole('region', { name: 'Monday Men Open: Open standings' });
    expect(within(standings).getByRole('rowheader', { name: 'Comets' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('region', { name: 'Today, page 1 of 2' })).toBeInTheDocument();
  });

  it('SPK-SCHED-010: the lobby keeps showing the last schedule it received while its connection is down, and says so', async () => {
    const online = createTestApp({ session: null, routes: { [SCHEDULE_ROUTE]: ok(schedule()) } });
    const first = render(online.at(`/lobby/${ORG}/${CODE}`));
    expect(await screen.findByText('Comets vs Rockets')).toBeInTheDocument();
    // The answer was kept in this browser.
    const key = `public-view:lobby:${ORG}:${CODE}`;
    await waitFor(() =>
      expect(online.services.preferences?.get(key)).toContain('Comets vs Rockets'),
    );
    const kept = online.services.preferences?.get(key) as string;
    first.unmount();

    // The display restarts with no connection: nothing can be read, the kept schedule is shown.
    const offline = createTestApp({
      session: null,
      online: false,
      preferences: { [key]: kept },
      routes: {},
    });
    render(offline.at(`/lobby/${ORG}/${CODE}`));
    expect(await screen.findByText('Comets vs Rockets')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Last updated Sat, Nov 21, 8:30 AM. No connection: showing the last schedule received.',
    );
  });

  it('SPK-SCHED-010: a schedule the operator took down is not kept on the display', async () => {
    const key = `public-view:lobby:${ORG}:${CODE}`;
    const app = createTestApp({
      session: null,
      preferences: { [key]: JSON.stringify(schedule()) },
      routes: { [SCHEDULE_ROUTE]: notAvailable },
    });
    render(app.at(`/lobby/${ORG}/${CODE}`));
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(screen.queryByText('Comets vs Rockets')).toBeNull();
    await waitFor(() => expect(app.services.preferences?.get(key)).toBeNull());
  });
});

describe('SPK-SCHED-010 staff controls', () => {
  const publication = (overrides: Record<string, unknown> = {}) => ({
    competitionId: ID.competition,
    visibility: 'private',
    organizationSlug: ORG,
    publicCode: null,
    changedAt: null,
    seasons: [{ seasonId: ID.season, name: 'Winter 2026', publicCode: null, hasDivisions: true }],
    blockers: [],
    minorDivisions: [],
    revision: 4,
    ...overrides,
  });
  const competitionRoutes = {
    'GET /me/permissions': mePermissions({ enabled: ['public_schedule'] }),
    'GET /competitions/{id}': ok(competition()),
    'GET /seasons': ok([]),
    'GET /rule-sets': ok([]),
  };

  it('SPK-SCHED-010: league staff make a competition public and get its links; a competition whose divisions are not all known to be adult divisions cannot be public, and the panel says what to set', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...competitionRoutes,
        'GET /competitions/{id}/publication': ok(publication()),
        'POST /competitions/{id}/publish': ok(
          publication({
            visibility: 'public',
            publicCode: CODE,
            seasons: [
              {
                seasonId: ID.season,
                name: 'Winter 2026',
                publicCode: SEASON_CODE,
                hasDivisions: true,
              },
            ],
            revision: 5,
          }),
        ),
      },
    });
    const first = render(app.at(`/leagues/competitions/${ID.competition}`));
    const panel = await screen.findByRole('region', { name: 'Public pages' });
    expect(await within(panel).findByText('Private')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Make public' }));
    expect(await within(panel).findByText('Competition is public')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.route).toBe('/competitions/{id}/publish');
    expect(post?.body).toEqual({ expectedRevision: 4 });
    first.unmount();

    const publicApp = createTestApp({
      routes: {
        ...competitionRoutes,
        'GET /competitions/{id}/publication': ok(
          publication({
            visibility: 'public',
            publicCode: CODE,
            seasons: [
              {
                seasonId: ID.season,
                name: 'Winter 2026',
                publicCode: SEASON_CODE,
                hasDivisions: true,
              },
            ],
          }),
        ),
      },
    });
    const second = render(publicApp.at(`/leagues/competitions/${ID.competition}`));
    const links = await screen.findByRole('list', { name: 'Public links' });
    expect(
      within(links).getByRole('link', { name: new RegExp(`/public/${ORG}/competitions/${CODE}$`) }),
    ).toBeInTheDocument();
    expect(
      within(links).getByRole('link', {
        name: new RegExp(`/public/${ORG}/seasons/${SEASON_CODE}/standings$`),
      }),
    ).toBeInTheDocument();
    // The links carry codes, never the competition's or the season's id.
    expect(links.innerHTML).not.toContain(ID.competition);
    expect(links.innerHTML).not.toContain(ID.season);
    expect(screen.getByRole('button', { name: 'Make private' })).toBeInTheDocument();
    second.unmount();

    const youth = createTestApp({
      routes: {
        ...competitionRoutes,
        'GET /competitions/{id}/publication': ok(
          publication({
            blockers: [
              {
                scope: 'division',
                reason: 'under_18',
                seasonName: 'Winter 2026',
                divisionName: 'Under 12',
                message:
                  'Division "Under 12" (Winter 2026) admits players under 18: its age band starts below 18.',
              },
              {
                scope: 'division',
                reason: 'age_not_stated',
                seasonName: 'Winter 2026',
                divisionName: 'Gold',
                message:
                  'Division "Gold" (Winter 2026) does not say its players are adults. Set its age band with a minimum age of 18 or more.',
              },
            ],
            minorDivisions: [
              { seasonName: 'Winter 2026', divisionName: 'Under 12' },
              { seasonName: 'Winter 2026', divisionName: 'Gold' },
            ],
          }),
        ),
      },
    });
    const third = render(youth.at(`/leagues/competitions/${ID.competition}`));
    const blocked = await screen.findByRole('region', { name: 'Public pages' });
    expect(await within(blocked).findByText('Cannot be public')).toBeInTheDocument();
    expect(
      within(blocked).getByText(/Proposed\s+rule, pending decision DEC-100/),
    ).toBeInTheDocument();
    const reasons = within(blocked).getByRole('list', { name: 'Why it cannot be public' });
    expect(
      within(reasons).getByText(/Division "Under 12" \(Winter 2026\) admits/),
    ).toBeInTheDocument();
    // a division that says nothing about age is a reason too, with what to set
    expect(
      within(reasons).getByText(/Set its age band with a minimum age of 18 or more\./),
    ).toBeInTheDocument();
    expect(within(blocked).getByRole('button', { name: 'Make public' })).toBeDisabled();
    third.unmount();

    // Already public when a division changed: recorded as public, not served, and the panel says so.
    const hidden = createTestApp({
      routes: {
        ...competitionRoutes,
        'GET /competitions/{id}/publication': ok(
          publication({
            visibility: 'public',
            publicCode: CODE,
            seasons: [
              {
                seasonId: ID.season,
                name: 'Winter 2026',
                publicCode: SEASON_CODE,
                hasDivisions: true,
              },
            ],
            blockers: [
              {
                scope: 'division',
                reason: 'age_not_stated',
                seasonName: 'Winter 2026',
                divisionName: 'Gold',
                message:
                  'Division "Gold" (Winter 2026) does not say its players are adults. Set its age band with a minimum age of 18 or more.',
              },
            ],
            minorDivisions: [{ seasonName: 'Winter 2026', divisionName: 'Gold' }],
          }),
        ),
      },
    });
    render(hidden.at(`/leagues/competitions/${ID.competition}`));
    const notShown = await screen.findByRole('region', { name: 'Public pages' });
    expect(await within(notShown).findByText(/Made public, but not shown/)).toBeInTheDocument();
    expect(within(notShown).getByText('Cannot be public')).toBeInTheDocument();
    expect(within(notShown).getByRole('button', { name: 'Make private' })).toBeInTheDocument();
  });

  it('SPK-SCHED-010 capability off: the competition screen reads no publication and offers no public page', async () => {
    const app = createTestApp({
      routes: {
        'GET /competitions/{id}': ok(competition()),
        'GET /seasons': ok([]),
        'GET /rule-sets': ok([]),
      },
    });
    render(app.at(`/leagues/competitions/${ID.competition}`));
    const panel = await screen.findByRole('region', { name: 'Public pages' });
    await waitFor(() => expect(within(panel).getByTestId('state-turned-off')).toBeInTheDocument());
    expect(within(panel).queryByRole('button', { name: 'Make public' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/competitions/{id}/publication')).toBe(false);
  });

  it('SPK-SCHED-010: the scheduler enables the public schedule of a facility and gets the public page and lobby links', async () => {
    const user = userEvent.setup();
    const view = (overrides: Record<string, unknown> = {}) => ({
      facilityId: FACILITY_A,
      enabled: false,
      organizationSlug: ORG,
      publicCode: null,
      enabledAt: null,
      disabledAt: null,
      revision: 0,
      ...overrides,
    });
    let enabled = false;
    const app = createTestApp({
      // The facility worked in is already chosen in this browser.
      preferences: { 'sportspark.facility': FACILITY_A },
      routes: {
        'GET /me/permissions': mePermissions({ enabled: ['public_schedule'] }),
        'GET /facilities/{id}/public-schedule-view': () =>
          fakeResponse(
            200,
            enabled ? view({ enabled: true, publicCode: CODE, revision: 1 }) : view(),
          ),
        'POST /facilities/{id}/public-schedule-view/enable': () => {
          enabled = true;
          return fakeResponse(200, view({ enabled: true, publicCode: CODE, revision: 1 }));
        },
      },
    });
    render(app.at('/schedule/public'));
    expect(await screen.findByText('Public schedule not enabled')).toBeInTheDocument();
    // The rules a visitor's page follows are stated, with the pending decision.
    expect(screen.getByText(/reads "Reserved", without the renter's name/)).toBeInTheDocument();
    expect(screen.getByText(/pending decision DEC-100/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable the public schedule' }));
    expect(await screen.findByTestId('command-success')).toHaveTextContent(
      'Public schedule enabled',
    );
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({});
    const links = await screen.findByRole('list', { name: 'Public schedule links' });
    expect(
      within(links).getByRole('link', { name: new RegExp(`/public/${ORG}/schedule/${CODE}$`) }),
    ).toBeInTheDocument();
    expect(
      within(links).getByRole('link', { name: new RegExp(`/lobby/${ORG}/${CODE}$`) }),
    ).toBeInTheDocument();
  });
});
