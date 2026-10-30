/**
 * SCR-C-28 tournament pool table (CMP-15; SPK-RESULT-001, SPK-RESULT-003; §3.16, DEC-016,
 * DEC-078): the pool's teams and seeds, its official table with tiebreaks and the games still
 * without an official result, the turned-off notice above what stays readable, and the empty,
 * error and not-available states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { IDS, baseRoutes, pool, poolStandings } from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { mePermissions } from '../../../testing/test-app';
import { PoolStandingsScreen, poolProgressText } from '../PoolStandingsScreen';

function routes(overrides: Record<string, FakeHandler> = {}) {
  return baseRoutes({
    'GET /me/permissions': mePermissions({ enabled: ['tournaments'] }),
    'GET /pools/{id}': { status: 200, body: pool() },
    'GET /pools/{id}/standings': { status: 200, body: poolStandings() },
    ...overrides,
  });
}

function renderPool(overrides: Record<string, FakeHandler> = {}, poolId: string | null = IDS.pool) {
  const app = createTeamsTestApp({ routes: routes(overrides) });
  render(<PoolStandingsScreen entryId={IDS.entry} poolId={poolId} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-28 PoolStandingsScreen', () => {
  it('CMP-15: the pool’s teams, seeds and official table, with games still to play counted', async () => {
    const app = renderPool();
    expect(await screen.findByRole('header', { name: 'Pool A: Fall 2026' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Desert Foxes (your team), Seed 1')).toBeOnTheScreen();
    expect(screen.getByLabelText('Canyon Hawks, Seed 2')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        '2nd: Desert Foxes (your team), 9 points, played 4, won 3, drawn 0, lost 1, goals 8 for and 5 against, difference 3',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Pool games still to play')).toBeOnTheScreen();
    expect(
      screen.getByText(
        '1 game between the pool teams has no official result yet, so the table can still change.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(/with rule set version 3\. Provisional results are never counted\./),
    ).toBeOnTheScreen();
    // SPK-RESULT-003: the tie on points is explained.
    expect(screen.getByRole('header', { name: 'How ties were decided' })).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/pools/{id}')[0]?.params).toEqual({ id: IDS.pool });
    await app.settle();
  });

  it('a complete pool says every game has an official result', () => {
    expect(poolProgressText(poolStandings({ pendingFixtureIds: [] }))).toBe(
      'Every game between the pool teams has an official result.',
    );
  });

  it('SPK-RESULT-001: no official results yet is an empty state, never a provisional table', async () => {
    renderPool({
      'GET /pools/{id}/standings': {
        status: 200,
        body: poolStandings({ sourceResultIds: [] }),
      },
    });
    expect(
      await screen.findByRole('header', { name: 'No official results yet' }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId(`standings-row-${IDS.entry}`)).toBeNull();
  });

  it('DEC-016: with tournaments off the turned-off notice sits above what stays readable', async () => {
    renderPool({ 'GET /me/permissions': mePermissions() });
    expect(await screen.findByText(/Tournaments/)).toBeOnTheScreen();
    expect(screen.getByText(/DEC-078/)).toBeOnTheScreen();
    expect(screen.getByText('Pool tables already published stay readable here.')).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'Pool A: Fall 2026' })).toBeOnTheScreen();
  });

  it('a failed permissions read never hides the published pool table', async () => {
    // Reading a pool is never gated: only an answer that tournaments are off adds the notice.
    const app = renderPool({
      'GET /me/permissions': () =>
        fakeResponse(
          500,
          apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
        ),
    });
    expect(await screen.findByRole('header', { name: 'Pool A: Fall 2026' })).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(/^2nd: Desert Foxes \(your team\), 9 points/),
    ).toBeOnTheScreen();
    await waitFor(() => expect(app.requestsTo('GET', '/me/permissions').length).toBeGreaterThan(0));
    await app.settle();
    expect(screen.queryByText(/INTERNAL_ERROR/)).toBeNull();
    expect(screen.queryByText(/DEC-078/)).toBeNull();
    expect(screen.queryByText('Pool tables already published stay readable here.')).toBeNull();
  });

  it('with tournaments on no turned-off notice is shown', async () => {
    const app = renderPool();
    expect(await screen.findByRole('header', { name: 'Pool A: Fall 2026' })).toBeOnTheScreen();
    await app.settle();
    expect(screen.queryByText(/DEC-078/)).toBeNull();
  });

  it('§4.10: a pool the person may not see is "not available"', async () => {
    renderPool({
      'GET /pools/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/Pool A|NOT_FOUND/)).toBeNull();
  });

  it('shows the standings error code with "Try again"', async () => {
    let attempt = 0;
    const app = renderPool({
      'GET /pools/{id}/standings': () => {
        attempt += 1;
        return attempt === 1
          ? fakeResponse(
              500,
              apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
            )
          : fakeResponse(200, poolStandings());
      },
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByLabelText(/^2nd: Desert Foxes \(your team\), 9 points/),
    ).toBeOnTheScreen();
    await app.settle();
  });

  it('a malformed pool id is "not available" and sends no request', async () => {
    const app = renderPool({}, null);
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/pools/{id}')).toHaveLength(0);
  });
});
