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
import {
  ID,
  TEAM_ROUTES,
  division,
  fail,
  fixture,
  fixtureDetail,
  ok,
  page,
  readiness,
  readinessIssue,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';
import { effectiveReadiness, orderIssues } from '../../../features/competition/readiness';

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
  it('lists fixtures with their machine state and readiness kept apart', async () => {
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
        'GET /fixtures/{id}/readiness': (req) =>
          new Response(
            JSON.stringify(
              readiness({
                fixtureId: req.params.id,
                status: 'blocked',
                issues: [readinessIssue()],
              }),
            ),
            { status: 200 },
          ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    const table = await screen.findByRole('table', { name: 'Fixtures' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('scheduled')).toBeInTheDocument();
    expect(await within(rows[1] as HTMLElement).findByText('Blocked')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('unscheduled')).toBeInTheDocument();
    expect(
      within(rows[2] as HTMLElement).getByText('Bye: no match to prepare'),
    ).toBeInTheDocument();
    expect(await within(rows[1] as HTMLElement).findByText('Red')).toBeInTheDocument();
    // Readiness is asked per fixture; a bye is not evaluated.
    expect(app.fake.requests.filter((r) => r.route === '/fixtures/{id}/readiness')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /ready/i })).toBeNull();
  });

  it('says unknown, not ready, when readiness cannot be evaluated', async () => {
    const app = createTestApp({
      routes: {
        ...listRoutes,
        'GET /seasons/{id}/fixtures': ok(page([fixture()])),
        'GET /fixtures/{id}/readiness': fail(503, 'INTEGRATION_UNAVAILABLE', 'retry_later'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/fixtures`));
    expect(await screen.findByText('Unknown: could not evaluate')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).toBeNull();
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
        'GET /fixtures/{id}/readiness': ok(readiness()),
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
      routes: { ...listRoutes, 'GET /seasons/{id}/fixtures': ok(page([])) },
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
