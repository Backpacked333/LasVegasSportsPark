/**
 * SCR-S-10 Fixtures and match readiness (SPK-READY-001 explainable assessment, SPK-READY-002
 * blocking / warning / informational / unknown, SPK-READY-003 reason, source, role, action, last
 * evaluation, deadline, SPK-READY-004 no editable ready flag, SPK-CAP-003 RSVP is not
 * eligibility). Unknown evidence is never shown as ready.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TEST_NOW, createTestApp } from '../../../testing/test-app';
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import {
  ID,
  TEAM_ROUTES,
  division,
  facilities,
  fail,
  fixture,
  fixtureDetail,
  matchSheet,
  ok,
  page,
  readiness,
  readinessIssue,
  seasonReadiness,
  teamEntry,
  venue,
} from '../../../features/competition/__tests__/fixtures';
import {
  effectiveCounts,
  effectiveReadiness,
  orderIssues,
} from '../../../features/competition/readiness';

const listRoutes = {
  ...TEAM_ROUTES,
  'GET /divisions': ok([division()]),
  'GET /team-entries': ok([
    teamEntry({ status: 'approved' }),
    teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue, status: 'approved' }),
  ]),
};

describe('SCR-S-10 readiness presentation (SPK-READY-002)', () => {
  const ctx = { now: TEST_NOW, staleThresholdMs: null, offline: false, refreshFailed: false };

  it('shows ready only when every check and issue is known', () => {
    expect(effectiveReadiness(readiness() as never, ctx).status).toBe('ready');
    expect(
      effectiveReadiness(
        readiness({ checks: [{ name: 'forms', status: 'unknown', issueCount: 1 }] }) as never,
        ctx,
      ).status,
    ).toBe('unknown');
  });

  it('treats an old, offline or unrefreshed evaluation as unknown, never ready', () => {
    expect(effectiveReadiness(readiness() as never, { ...ctx, offline: true }).status).toBe(
      'unknown',
    );
    expect(effectiveReadiness(readiness() as never, { ...ctx, refreshFailed: true }).status).toBe(
      'unknown',
    );
    expect(
      effectiveReadiness(readiness() as never, { ...ctx, staleThresholdMs: 60_000 }).status,
    ).toBe('unknown');
  });

  it('applies the same rules to the season summary counts (CMP-01)', () => {
    const summary = { ...ctx, evaluatedAt: '2026-10-24T11:58:00.000Z' };
    const ready = { status: 'ready' as const, blockingCount: 0, unknownCount: 0 };
    expect(effectiveCounts(ready, summary).status).toBe('ready');
    expect(effectiveCounts({ ...ready, unknownCount: 1 }, summary).status).toBe('unknown');
    expect(effectiveCounts(ready, { ...summary, offline: true }).status).toBe('unknown');
    expect(effectiveCounts(ready, { ...summary, refreshFailed: true }).status).toBe('unknown');
    expect(effectiveCounts(ready, { ...summary, staleThresholdMs: 60_000 }).status).toBe('unknown');
    expect(
      effectiveCounts(
        { status: 'blocked', blockingCount: 1, unknownCount: 0 },
        {
          ...summary,
          offline: true,
        },
      ).status,
    ).toBe('blocked');
  });

  it('never softens a blocking answer', () => {
    expect(
      effectiveReadiness(readiness({ status: 'blocked' }) as never, { ...ctx, offline: true })
        .status,
    ).toBe('blocked');
  });

  it('orders blocking issues first, then unknown evidence, warnings and information', () => {
    const ordered = orderIssues([
      { severity: 'info' as const },
      { severity: 'warning' as const },
      { severity: 'unknown' as const },
      { severity: 'blocking' as const },
    ]);
    expect(ordered.map((i) => i.severity)).toEqual(['blocking', 'unknown', 'warning', 'info']);
  });
});

describe('SCR-S-10 FixturesScreen (SPK-READY-001, SPK-READY-004)', () => {
  it('lists fixtures with their machine state and readiness kept apart, from one season summary read (CMP-01)', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(
          page([
            fixture(),
            fixture({
              id: ID.fixture2,
              awayEntryId: null,
              status: 'unscheduled',
              scheduledStart: null,
            }),
          ]),
        ),
        'GET /seasons/{id}/readiness': ok(
          seasonReadiness([{ fixtureId: ID.fixture, status: 'blocked', blockingCount: 2 }]),
        ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    const table = await screen.findByRole('table', { name: 'Fixtures' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('scheduled')).toBeInTheDocument();
    expect(await within(rows[1] as HTMLElement).findByText('Blocked')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/2 blocking/)).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('unscheduled')).toBeInTheDocument();
    expect(
      within(rows[2] as HTMLElement).getByText('Bye: no match to prepare'),
    ).toBeInTheDocument();
    // Team names come with the fixture rows; no team or per-fixture readiness reads.
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'Red v Blue' })).toBeVisible();
    expect(app.fake.requests.filter((r) => r.route === '/fixtures/{id}/readiness')).toHaveLength(0);
    expect(app.fake.requests.filter((r) => r.route === '/teams/{id}')).toHaveLength(0);
    expect(app.fake.requests.filter((r) => r.route === '/seasons/{id}/readiness')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /mark.*ready/i })).toBeNull();
  });

  it('never shows ready while any evidence is unknown, and re-evaluates on request', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': ok(
          seasonReadiness([{ fixtureId: ID.fixture, status: 'ready', unknownCount: 1 }]),
        ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Unknown or stale evidence')).toBeInTheDocument();
    expect(screen.getByText(/1 unknown/)).toBeInTheDocument();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.getByText('Readiness evaluated 2 minutes ago')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-evaluate readiness' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/seasons/{id}/readiness')).toHaveLength(
        2,
      ),
    );
  });

  it('shows ready only for known evidence, and unknown once offline', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': ok(
          seasonReadiness([{ fixtureId: ID.fixture, status: 'ready' }]),
        ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    act(() => app.connectivity.set(false));
    await waitFor(() => expect(screen.getByText('Unknown or stale evidence')).toBeInTheDocument());
    expect(screen.getByText(/readiness cannot be confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-evaluate readiness' })).toBeDisabled();
  });

  it('says unknown, not ready, when readiness cannot be evaluated, with the error code', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': fail(503, 'INTEGRATION_UNAVAILABLE', 'retry_later'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Unknown: could not evaluate')).toBeInTheDocument();
    expect(screen.getByText(/could not be evaluated \(INTEGRATION_UNAVAILABLE\)/)).toBeVisible();
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('shows readiness as not available when the summary is refused (ACCESS_DENIED)', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': fail(
          403,
          'ACCESS_DENIED',
          'contact_support_or_request_access',
        ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Readiness not available')).toBeInTheDocument();
  });

  it('reads a large season for the window of the page shown (TOO_MANY_FIXTURES)', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': (req) =>
          req.query.from
            ? fakeResponse(200, seasonReadiness([{ fixtureId: ID.fixture, status: 'warning' }]))
            : fakeResponse(
                400,
                apiErrorBody('VALIDATION_FAILED', {
                  nextAction: 'correct_input',
                  details: { code: 'TOO_MANY_FIXTURES', limit: 100 },
                }),
              ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Warning')).toBeInTheDocument();
    const windowed = app.fake.requests.find(
      (r) => r.route === '/seasons/{id}/readiness' && r.query.from,
    );
    expect(windowed?.query.from).toBe('2026-11-07T18:00:00.000Z');
    expect(windowed?.query.to).toBe('2026-11-07T18:00:00.001Z');
    expect(screen.getByText(/for the fixtures on this page/)).toBeInTheDocument();
  });

  it('shows start times in the division facility’s time zone (SPK-SCHED-008)', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /divisions': ok([division({ facilityId: ID.facility })]),
        'GET /facilities': ok(facilities()),
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /seasons/{id}/readiness': ok(seasonReadiness([])),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    // 18:00 UTC is 10:00 in Los Angeles (PST, after the clocks change on 1 November).
    expect(await screen.findByText(/10:00.*PST/)).toBeInTheDocument();
  });

  it('filters by division and pages with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': (req) =>
          new Response(
            JSON.stringify(
              req.query.cursor ? page([fixture({ id: ID.fixture2 })]) : page([fixture()], 'next-1'),
            ),
            { status: 200 },
          ),
        'GET /seasons/{id}/readiness': ok(seasonReadiness([])),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    await user.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.query.cursor === 'next-1')).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText('Division'), ID.division);
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) =>
            r.route === '/seasons/{id}/fixtures' &&
            r.query.divisionId === ID.division &&
            !r.query.cursor,
        ),
      ).toBe(true),
    );
  });

  it('shows the empty state when the season has no fixtures', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([])),
        'GET /seasons/{id}/readiness': ok(seasonReadiness([])),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByRole('heading', { name: 'No fixtures' })).toBeInTheDocument();
  });
});

describe('SCR-S-10 FixtureScreen (SPK-READY-003, SPK-CAP-003)', () => {
  it('explains every issue with reason, source, role, action, last evaluation and deadline', async () => {
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/readiness': ok(
          readiness({
            status: 'blocked',
            issues: [
              readinessIssue({ severity: 'info', code: 'note', message: 'Kit colours confirmed.' }),
              readinessIssue(),
              readinessIssue({
                severity: 'unknown',
                code: 'forms',
                message: 'Forms evidence unknown.',
              }),
            ],
          }),
        ),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    expect(await screen.findByRole('heading', { name: 'Red v Blue' })).toBeInTheDocument();
    const issues = await screen.findByRole('list', { name: 'Readiness issues' });
    const items = within(issues).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('Blocking')).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText('No referee has accepted this fixture.'),
    ).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Scheduler')).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText('Assign and confirm a referee.'),
    ).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Assignment')).toBeInTheDocument();
    expect(
      within(items[1] as HTMLElement).getByText('Unknown or stale evidence'),
    ).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText('Informational')).toBeInTheDocument();
    expect(screen.getByText('Evaluated 2 minutes ago')).toBeInTheDocument();
    // RSVP is shown as RSVP, never as attendance or eligibility.
    expect(screen.getByText(/RSVP is neither attendance nor eligibility/)).toBeInTheDocument();
    expect(screen.getAllByText(/RSVP: 6 available/)).toHaveLength(2);
  });

  it('re-evaluates on request and shows ready as unknown once offline', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/readiness': ok(readiness()),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    const panel = await screen.findByRole('region', { name: 'Match readiness' });
    expect(
      within(within(panel).getByTestId('readiness-overall')).getByText('Ready'),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Re-evaluate' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/fixtures/{id}/readiness')).toHaveLength(
        2,
      ),
    );
    act(() => app.connectivity.set(false));
    await waitFor(() =>
      expect(within(panel).getByTestId('readiness-overall')).toHaveTextContent(
        'Unknown or stale evidence',
      ),
    );
    expect(within(panel).getByText(/readiness cannot be confirmed/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Re-evaluate' })).toBeDisabled();
  });

  it('shows a fixture the viewer may not see as not available, without detail', async () => {
    const app = createTestApp({
      routes: { 'GET /fixtures/{id}': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Match readiness' })).toBeNull();
  });
});

describe('SCR-S-10 match sheet (CMP-06, SPK-UX-007, SPK-STAFF-002, §4.14)', () => {
  it('shows the field-limited sheet with numbers, status and roles, and the venue time', async () => {
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail({ venue: venue() })),
        'GET /fixtures/{id}/readiness': ok(readiness()),
        'GET /fixtures/{id}/match-sheet': ok(matchSheet()),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    const red = await screen.findByRole('table', { name: 'Match sheet: Red' });
    expect(within(red).getByRole('rowheader', { name: 'Sam Player' })).toBeInTheDocument();
    expect(within(red).getByText('7')).toBeInTheDocument();
    expect(within(red).getByText('active')).toBeInTheDocument();
    expect(within(red).getByText('Captain')).toBeInTheDocument();
    const blue = screen.getByRole('table', { name: 'Match sheet: Blue' });
    expect(within(blue).getByText('guest')).toBeInTheDocument();
    expect(screen.getByText('North Park, Pitch 1')).toBeInTheDocument();
    // The venue's zone (SPK-SCHED-008): 18:00 UTC is 10:00 PST in Los Angeles.
    expect(screen.getByText(/10:00.*PST/)).toBeInTheDocument();
    // Never a date of birth or contact on the sheet.
    expect(document.body.textContent).not.toMatch(/2016-05-04|@example/);
  });

  it('shows the captain view with names and numbers only', async () => {
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/readiness': ok(readiness()),
        'GET /fixtures/{id}/match-sheet': ok(
          matchSheet({
            view: 'captain',
            sides: [
              {
                entryId: ID.entryRed,
                teamName: 'Red',
                players: [
                  {
                    personId: null,
                    displayName: 'Sam Player',
                    jerseyNumber: 7,
                    playingStatus: null,
                    roles: [],
                  },
                ],
              },
            ],
          }),
        ),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    const red = await screen.findByRole('table', { name: 'Match sheet: Red' });
    expect(within(red).queryByRole('columnheader', { name: 'Playing status' })).toBeNull();
    expect(screen.getByText('Captain view: names and numbers only.')).toBeInTheDocument();
  });

  it('shows a sheet the viewer may not read as not available, without detail', async () => {
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/readiness': ok(readiness()),
        'GET /fixtures/{id}/match-sheet': fail(404, 'NOT_FOUND', 'verify_reference'),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    const panel = await screen.findByRole('region', { name: 'Match sheet' });
    expect(await within(panel).findByText('Not available')).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).toBeNull();
  });

  it('shows the API error code and "Try again" when the sheet fails to load', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/readiness': ok(readiness()),
        'GET /fixtures/{id}/match-sheet': fail(500, 'INTERNAL_ERROR', 'retry_later'),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}`));
    const panel = await screen.findByRole('region', { name: 'Match sheet' });
    expect((await within(panel).findAllByText(/INTERNAL_ERROR/)).length).toBeGreaterThan(0);
    app.fake.set('GET /fixtures/{id}/match-sheet', ok(matchSheet()));
    await user.click(within(panel).getByRole('button', { name: /try again/i }));
    expect(await within(panel).findByRole('table', { name: 'Match sheet: Red' })).toBeVisible();
  });
});
