/**
 * SCR-S-09 Fixture generation (SPK-FIX-001 specification, SPK-FIX-002 completeness and remaining
 * obligations, SPK-FIX-003 hard constraints distinct from preferences, SPK-FIX-004 honest solver
 * outcomes, SPK-FIX-005 drafts only, SPK-AT-010, SPK-AT-011 no false optimality or feasibility).
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';
import {
  ID,
  TEAM_ROUTES,
  created,
  division,
  fail,
  ok,
  ruleSet,
  season,
  solverRun,
  specification,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

const entries = [
  teamEntry({ status: 'approved', divisionId: ID.division }),
  teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue, status: 'approved', divisionId: ID.division }),
];

const specRoutes = {
  ...TEAM_ROUTES,
  'GET /fixture-specifications/{id}': ok(specification()),
  'GET /team-entries': ok(entries),
};

describe('SCR-S-09 FixtureGenerationScreen (SPK-FIX-001, SPK-FIX-003)', () => {
  const routes = {
    ...TEAM_ROUTES,
    'GET /divisions/{id}': ok(division({ facilityId: FACILITY_A })),
    'GET /seasons/{id}': ok(season()),
    'GET /team-entries': ok(entries),
    'GET /resources': ok([
      { id: ID.resource, facilityId: FACILITY_A, kind: 'field', name: 'Field 1', status: 'active' },
    ]),
  };

  it('keeps hard constraints visibly apart from weighted preferences and lists the teams', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    expect(
      await screen.findByRole('heading', { name: 'Fixture generation: Division A' }),
    ).toBeInTheDocument();
    const teams = await screen.findByRole('list', { name: 'Teams in this specification' });
    expect(await within(teams).findByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Hard constraints')).toBeInTheDocument();
    expect(screen.getByText('Fairness preferences')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-049/)).toBeInTheDocument();
    // Season dates prefill the specification; nothing else is preset.
    expect(screen.getByLabelText(/^First day/)).toHaveValue('2026-11-01');
    expect(screen.getByLabelText(/^Games per team/)).toHaveValue('');
    expect(screen.getByLabelText(/^Byes allowed/)).toHaveValue('');
  });

  it('refuses an incomplete specification before sending, naming each missing input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    await user.click(await screen.findByRole('button', { name: 'Save specification' }));
    expect(screen.getByText('Enter the games each team plays.')).toBeInTheDocument();
    expect(screen.getByText('Say whether byes are allowed.')).toBeInTheDocument();
    expect(
      screen.getByText('Add at least one complete weekday and start time.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Choose at least one resource.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('requires an approval reference for a convenience preference (DEC-049)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    await user.click(await screen.findByRole('button', { name: 'Add a preference' }));
    const pref = screen.getByRole('group', { name: 'Preference 1' });
    await user.selectOptions(within(pref).getByLabelText('Preference'), 'approved_convenience');
    await user.selectOptions(within(pref).getByLabelText('Treat as'), 'preference');
    await user.click(screen.getByRole('button', { name: 'Save specification' }));
    expect(
      within(pref).getByText('A convenience preference needs the approval it rests on.'),
    ).toBeInTheDocument();
  });

  it('saves a complete specification and opens it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /divisions/{id}/fixture-specifications': created(specification()),
        'GET /fixture-specifications/{id}': ok(specification()),
      },
    });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    await user.type(await screen.findByLabelText(/^Name/), 'Division A round robin');
    await user.type(screen.getByLabelText(/^Games per team/), '1');
    await user.type(screen.getByLabelText(/^Times each pair/), '1');
    await user.selectOptions(screen.getByLabelText(/^Byes allowed/), 'yes');
    await user.type(screen.getByLabelText(/^Minimum rest/), '1440');
    await user.click(screen.getByRole('button', { name: 'Add a start time' }));
    await user.selectOptions(screen.getByLabelText('Weekday 1'), '6');
    await user.type(screen.getByLabelText(/^Start time 1/), '10:00');
    await user.click(await screen.findByLabelText('Field 1'));
    await user.click(screen.getByRole('button', { name: 'Add a preference' }));
    const pref = screen.getByRole('group', { name: 'Preference 1' });
    await user.selectOptions(within(pref).getByLabelText('Preference'), 'no_consecutive_games');
    await user.selectOptions(within(pref).getByLabelText('Treat as'), 'hard');
    await user.click(screen.getByRole('button', { name: 'Save specification' }));
    expect(
      await screen.findByRole('heading', { name: 'Division A round robin' }),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params).toEqual({ id: ID.division });
    expect(post?.body).toEqual({
      name: 'Division A round robin',
      facilityId: FACILITY_A,
      gamesPerTeam: 1,
      opponentFrequency: 1,
      startsOn: '2026-11-01',
      endsOn: '2026-12-20',
      blackouts: [],
      byesAllowed: true,
      minimumRestMinutes: 1440,
      allowedStartTimes: [{ weekday: 6, time: '10:00' }],
      requiredResourceIds: [ID.resource],
      fairnessPreferences: [{ kind: 'no_consecutive_games', hard: true, weight: 1 }],
    });
  });

  it('shows a division the API will not show as not available', async () => {
    const app = createTestApp({
      routes: { 'GET /divisions/{id}': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
});

describe('SCR-S-09 FixtureSpecificationScreen and solver outcomes (SPK-FIX-004, SPK-AT-011)', () => {
  async function generate(run: unknown, dryRun = true) {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...specRoutes, 'POST /fixture-specifications/{id}/generate': created(run) },
    });
    render(app.at(`/leagues/fixture-specifications/${ID.spec}`));
    await screen.findByRole('heading', { name: 'Division A round robin' });
    if (!dryRun) await user.click(screen.getByLabelText(/^Check only/));
    await user.click(
      screen.getByRole('button', {
        name: dryRun ? 'Run a check' : 'Generate fixtures and a draft',
      }),
    );
    await screen.findByText('Run recorded.', { exact: false });
    return app;
  }

  it('summarizes the specification with hard constraints apart from weighted preferences', async () => {
    const app = createTestApp({ routes: specRoutes });
    render(app.at(`/leagues/fixture-specifications/${ID.spec}`));
    const hard = await screen.findByLabelText('Hard constraints');
    expect(within(hard).getByText('Saturday 10:00')).toBeInTheDocument();
    expect(within(hard).getByText('No consecutive games')).toBeInTheDocument();
    expect(screen.getByText('Preferences (weighted)')).toBeInTheDocument();
    expect(screen.getByText('Home and away balance, weight 2')).toBeInTheDocument();
  });

  it('labels a feasible proposal without claiming optimality', async () => {
    await generate(solverRun());
    expect(screen.getByText('Feasible proposal')).toBeInTheDocument();
    expect(screen.getByText(/not proven optimal/)).toBeInTheDocument();
    expect(screen.queryByText('Proven optimal proposal')).toBeNull();
    expect(screen.getByText('the candidate limit was reached')).toBeInTheDocument();
  });

  it('never labels a search that hit its limit as impossible', async () => {
    await generate(
      solverRun({
        outcome: 'no_proposal_within_limit',
        proposal: null,
        explanation: {
          ...solverRun().explanation,
          stoppedBy: 'time_limit',
          summary: 'No proposal met every hard constraint before the time limit.',
        },
      }),
    );
    expect(
      screen.getByText('No feasible proposal found within the search limit'),
    ).toBeInTheDocument();
    expect(screen.getByText(/This is not proof that a schedule is impossible/)).toBeInTheDocument();
    expect(screen.queryByText('Proven infeasible')).toBeNull();
    expect(screen.getByText('the time limit was reached')).toBeInTheDocument();
    expect(screen.getByText('No proposal: nothing was created.')).toBeInTheDocument();
  });

  it('shows proven infeasibility with the hard constraint that cannot be met', async () => {
    await generate(
      solverRun({
        outcome: 'proven_infeasible',
        proposal: null,
        explanation: {
          ...solverRun().explanation,
          stoppedBy: 'proof',
          hardViolations: [
            {
              constraint: 'allowed_start_times',
              hard: true,
              message: 'Two start times cannot hold six games per round.',
              gameKeys: [],
            },
          ],
        },
      }),
    );
    expect(screen.getByText('Proven infeasible')).toBeInTheDocument();
    expect(
      screen.getByText('Two start times cannot hold six games per round.'),
    ).toBeInTheDocument();
  });

  it('records an odd-team season’s byes and remaining obligations with owner and deadline (SPK-AT-010)', async () => {
    await generate(
      solverRun({
        completenessReport: {
          complete: false,
          expectedGames: 3,
          proposedGames: 3,
          scheduledGames: 2,
          byes: [{ teamEntryId: ID.entryRed, count: 1 }],
          issues: [
            {
              code: 'unscheduled_game',
              message: 'One game has no slot.',
              teamEntryIds: [],
              gameKeys: ['g3'],
            },
          ],
          remainingObligations: [
            {
              code: 'unscheduled_game',
              message: 'Schedule game g3.',
              owner: 'league_manager',
              deadline: '2026-10-31T12:00:00.000Z',
              gameKeys: ['g3'],
            },
          ],
        },
      }),
      false,
    );
    expect(screen.getByText('Incomplete season')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled game')).toBeInTheDocument();
    const obligations = screen.getByRole('group', { name: 'Remaining obligations' });
    expect(within(obligations).getByText('Schedule game g3.')).toBeInTheDocument();
    expect(within(obligations).getByText(/Owner: League manager/)).toBeInTheDocument();
    expect(await screen.findByText(/: 1 bye/)).toBeInTheDocument();
  });

  it('opens a generated proposal as an unpublished draft', async () => {
    const app = await generate(
      solverRun({ dryRun: false, scheduleDraftId: ID.draft, fixtureIds: [ID.fixture] }),
      false,
    );
    expect(screen.getByText('Draft, not published')).toBeInTheDocument();
    const run = screen.getByRole('region', { name: /^Solver run/ });
    expect(within(run).getByRole('link', { name: 'Schedule' })).toHaveAttribute(
      'href',
      '/schedule',
    );
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({ dryRun: false });
  });

  it('asks for all three search settings or none, and shows the limit while running', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...specRoutes,
        'POST /fixture-specifications/{id}/generate': () => new Promise<Response>(() => undefined),
      },
    });
    render(app.at(`/leagues/fixture-specifications/${ID.spec}`));
    await user.type(await screen.findByLabelText('Candidate limit'), '100');
    await user.click(screen.getByRole('button', { name: 'Run a check' }));
    expect(
      screen.getByText('Give all three search settings, or leave all three empty for the default.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Time limit (seconds)'), '5');
    await user.type(screen.getByLabelText('Seed'), '7');
    await user.click(screen.getByRole('button', { name: 'Run a check' }));
    expect(
      await screen.findByText('Searching for a proposal: up to 100 candidates or 5 seconds.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
        dryRun: true,
        searchSettings: { maxCandidates: 100, timeLimitMs: 5000, seed: 7 },
      }),
    );
  });

  it('shows the API’s specification error with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...specRoutes,
        'POST /fixture-specifications/{id}/generate': fail(
          400,
          'VALIDATION_FAILED',
          'correct_input',
          {
            message: 'Games per team must equal (teams - 1) x frequency.',
          },
        ),
      },
    });
    render(app.at(`/leagues/fixture-specifications/${ID.spec}`));
    await user.click(await screen.findByRole('button', { name: 'Run a check' }));
    expect(
      await screen.findByText('Games per team must equal (teams - 1) x frequency.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
  });

  it('disables generation offline and says it needs a connection (offline state)', async () => {
    const app = createTestApp({ routes: specRoutes });
    render(app.at(`/leagues/fixture-specifications/${ID.spec}`));
    const run = await screen.findByRole('button', { name: 'Run a check' });
    expect(run).toBeEnabled();
    act(() => app.connectivity.set(false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run a check' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Run a check' })).toHaveAccessibleDescription(
      'Needs a connection.',
    );
  });

  it('shows a recorded solver run on its own page', async () => {
    const app = createTestApp({
      routes: {
        ...specRoutes,
        'GET /solver-runs/{id}': ok(solverRun({ outcome: 'proven_optimal' })),
        'GET /rule-sets/{id}': ok(ruleSet()),
      },
    });
    render(app.at(`/leagues/solver-runs/${ID.run}`));
    expect(await screen.findByText('Proven optimal proposal')).toBeInTheDocument();
    // The run keeps the rule-set version it ran under (SPK-FIX-004 input snapshot).
    expect(await screen.findByText('Indoor 6v6, version 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the specification' })).toBeInTheDocument();
  });
});
