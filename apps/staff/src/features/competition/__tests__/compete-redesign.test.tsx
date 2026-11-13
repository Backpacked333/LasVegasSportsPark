/**
 * The Compete redesign's derived values and season home (SPK-UX-010): recent form only from
 * official results (SPK-RESULT-001), season progress only from the season's own dates, roster
 * checks against the rule-set limits (SPK-PLACE-003), readiness on the season home never shown as
 * ready on unknown evidence (SPK-READY-002), and the placement board's keyboard alternative to
 * drag (SPK-UX-009).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { rosterCheck } from '../../../screens/teams/PlacementBoardScreen';
import { deriveForm } from '../form';
import { seasonProgress } from '../page';
import {
  ID,
  TEAM_ROUTES,
  division,
  fixture,
  dividedStandings,
  ok,
  page,
  personNames,
  resultRevision,
  ruleSet,
  season,
  standings,
  teamEntry,
} from './fixtures';

function revision(fixtureId: string, home: number | null, away: number | null, extra = {}) {
  return {
    id: `${fixtureId.slice(0, -4)}7${fixtureId.slice(-3)}`,
    fixtureId,
    status: 'official',
    homeScore: home,
    awayScore: away,
    forfeitingEntryId: null,
    publishedAt: '2026-10-20T12:00:00.000Z',
    createdAt: '2026-10-20T12:00:00.000Z',
    ...extra,
  };
}

describe('Compete redesign: derived values', () => {
  it('SPK-RESULT-001: form comes only from official results, oldest first, a forfeit loses', () => {
    const f1 = fixture({ id: ID.fixture, scheduledStart: '2026-10-01T18:00:00.000Z' });
    const f2 = fixture({ id: ID.fixture2, scheduledStart: '2026-10-08T18:00:00.000Z' });
    const form = deriveForm(
      [
        revision(ID.fixture2, null, null, { forfeitingEntryId: ID.entryBlue }),
        revision(ID.fixture, 2, 2),
        // A submitted (not yet official) result never counts.
        revision(ID.fixture, 5, 0, { status: 'submitted', id: ID.result2 }),
      ] as never,
      [f1, f2] as never,
    );
    expect(form.get(ID.entryRed)).toEqual(['D', 'W']);
    expect(form.get(ID.entryBlue)).toEqual(['D', 'L']);
  });

  it('derives season progress from the season dates only', () => {
    const s = { startsOn: '2026-11-01', endsOn: '2026-12-20' };
    expect(seasonProgress(s, '2026-10-30')?.label).toBe('Starts in 2 days');
    expect(seasonProgress(s, '2026-11-15')?.label).toBe('Week 3 of 8');
    expect(seasonProgress(s, '2026-12-21')).toEqual({ pct: 100, label: 'Finished' });
    expect(seasonProgress({ startsOn: 'x', endsOn: '2026-12-20' }, '2026-11-15')).toBeNull();
  });

  it('SPK-PLACE-003: names roster size against the rule-set minimum and maximum in words', () => {
    expect(rosterCheck({ rosterCount: 5, rosterMin: 8, rosterMax: 14 })).toEqual({
      tone: 'warning',
      label: '5 players of 8 minimum',
    });
    expect(rosterCheck({ rosterCount: 10, rosterMin: 8, rosterMax: 14 }).tone).toBe('success');
    expect(rosterCheck({ rosterCount: 15, rosterMin: 8, rosterMax: 14 }).label).toBe(
      '15 players, over the 14 maximum',
    );
  });
});

describe('Season home (SCR-S-08, SCR-S-10, SCR-S-13)', () => {
  const routes = {
    'GET /seasons/{id}': ok(season({ status: 'active' })),
    'GET /divisions': ok([division()]),
    'GET /rule-sets/{id}': ok(ruleSet()),
    'GET /seasons/{id}/standings': dividedStandings(() => standings()),
    'GET /seasons/{id}/fixtures': ok(page([fixture({ scheduledStart: '2026-10-24T18:00:00Z' })])),
    'GET /fixtures/{id}/readiness': ok({
      fixtureId: ID.fixture,
      fixtureStatus: 'scheduled',
      status: 'ready',
      evaluatedAt: '2026-10-24T11:59:00.000Z',
      scheduledStart: '2026-10-24T18:00:00.000Z',
      checks: [
        { name: 'roster', status: 'ready', issueCount: 0 },
        { name: 'officials', status: 'unknown', issueCount: 1 },
      ],
      issues: [],
      sides: [],
    }),
    'GET /seasons/{id}/result-revisions': ok(page([])),
    'GET /seasons/{id}/results-awaiting': ok({
      seasonId: ID.season,
      evaluatedAt: '2026-10-24T11:59:00.000Z',
      items: [],
      truncated: false,
    }),
    'GET /exceptions': ok(page([])),
  };

  it('shows the standings scoreboard with the rule set’s tie order and the next games’ readiness', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const table = await screen.findByRole('table', { name: 'Season standings' });
    expect(within(table).getByRole('rowheader', { name: 'Red' })).toBeInTheDocument();
    expect(
      await screen.findByText(/Ties on points: head-to-head, goal difference/),
    ).toBeInTheDocument();
    const games = await screen.findByRole('list', { name: 'Games in the next 24 hours' });
    // SPK-READY-002: an unknown check means the game is not shown as ready.
    expect(await within(games).findByText('Unknown or stale evidence')).toBeInTheDocument();
    expect(within(games).queryByText('Ready')).toBeNull();
    expect(within(games).getByText('Officials · 1')).toBeInTheDocument();
    expect(screen.getByText('Nothing waiting')).toBeInTheDocument();
  });

  it('CMP-12: the standings card reads the first division of a divided season, never the season as a whole', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await screen.findByRole('table', { name: 'Season standings' });
    const reads = app.fake.requests.filter((r) => r.route === '/seasons/{id}/standings');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.query.divisionId === ID.division)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Whole season' })).toBeNull();
  });

  it('SPK-READY-001: reads every game’s per-check readiness from one season read, never one per game', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /seasons/{id}/readiness': ok({
          seasonId: ID.season,
          evaluatedAt: '2026-10-24T11:59:00.000Z',
          items: [
            {
              fixtureId: ID.fixture,
              status: 'blocked',
              blockingCount: 1,
              unknownCount: 0,
              warningCount: 0,
              checks: [
                { name: 'roster', status: 'blocked', issueCount: 1 },
                { name: 'officials', status: 'ready', issueCount: 0 },
              ],
            },
          ],
        }),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const games = await screen.findByRole('list', { name: 'Games in the next 24 hours' });
    expect(await within(games).findByText('Roster · 1')).toBeInTheDocument();
    expect(within(games).getByText('Officials')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/fixtures/{id}/readiness')).toHaveLength(0);
    const summary = app.fake.requests.find((r) => r.route === '/seasons/{id}/readiness');
    expect(summary?.query).toHaveProperty('from');
    expect(summary?.query).toHaveProperty('to');
  });
});

describe('Needs your call: inline result decisions (SPK-RESULT-001, SPK-RESULT-002, SPK-UX-006)', () => {
  const T0 = '2026-10-24T11:59:00.000Z';
  const base = {
    'GET /seasons/{id}': ok(season({ status: 'active' })),
    'GET /divisions': ok([division()]),
    'GET /rule-sets/{id}': ok(ruleSet()),
    'GET /seasons/{id}/standings': dividedStandings(() => standings()),
    'GET /seasons/{id}/fixtures': ok(page([])),
    'GET /seasons/{id}/readiness': ok({ seasonId: ID.season, evaluatedAt: T0, items: [] }),
    'GET /seasons/{id}/result-revisions': ok(page([])),
    'GET /exceptions': ok(page([])),
  };
  const awaiting = (suggested: boolean) => ({
    seasonId: ID.season,
    evaluatedAt: T0,
    truncated: false,
    items: [
      {
        fixtureId: ID.fixture,
        scheduledStart: '2026-10-22T18:00:00.000Z',
        scheduledEnd: '2026-10-22T19:00:00.000Z',
        divisionId: null,
        sides: [
          { teamEntryId: ID.entryRed, teamName: 'Red', present: 6 },
          { teamEntryId: ID.entryBlue, teamName: 'Blue', present: suggested ? 4 : null },
        ],
        minimumPlayersToStart: 5,
        suggestedForfeit: suggested
          ? {
              forfeitingEntryId: ID.entryBlue,
              homeScore: 3,
              awayScore: 0,
              reason: 'Blue had 4 players marked present (minimum 5).',
            }
          : null,
        reminderCount: 0,
        lastReminderAt: null,
      },
    ],
  });

  it('records the suggested forfeit by submitting it and then publishing it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/results-awaiting': ok(awaiting(true)),
        'POST /fixtures/{id}/results': {
          status: 201,
          body: resultRevision({ classification: 'forfeit', homeScore: 3, awayScore: 0 }),
        },
        'POST /results/{id}/publish': ok({
          revision: resultRevision({ status: 'official' }),
          published: true,
          supersededRevisionId: null,
          reviewExceptionId: null,
          standings: null,
          proposedSuspensionIds: [],
          bracketNodeIds: [],
        }),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const calls = await screen.findByRole('list', { name: 'Decisions waiting' });
    expect(
      await within(calls).findByText('Blue had 4 players marked present (minimum 5).'),
    ).toBeInTheDocument();
    await user.click(
      within(calls).getByRole('button', { name: /Record the 3–0 forfeit: Blue forfeits/ }),
    );
    expect(await within(calls).findByText('Forfeit published')).toBeInTheDocument();
    const posts = app.fake.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.route)).toEqual(['/fixtures/{id}/results', '/results/{id}/publish']);
    expect(posts[0]?.body).toEqual({
      classification: 'forfeit',
      homeScore: 3,
      awayScore: 0,
      forfeitingEntryId: ID.entryBlue,
    });
    expect(posts[1]?.body).toEqual({ expectedRevision: 2 });
  });

  it('nudges the captains of a game without a result', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/results-awaiting': ok(awaiting(false)),
        'POST /fixtures/{id}/result-reminders': {
          status: 201,
          body: {
            id: ID.result2,
            fixtureId: ID.fixture,
            requestedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Lee' },
            message: null,
            requestedAt: T0,
            recipientCount: 2,
          },
        },
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const calls = await screen.findByRole('list', { name: 'Decisions waiting' });
    expect(await within(calls).findByText('Missing result')).toBeInTheDocument();
    expect(within(calls).getByText(/Blue not checked in/)).toBeInTheDocument();
    await user.click(within(calls).getByRole('button', { name: 'Nudge captains: Red v Blue' }));
    expect(await within(calls).findByText('Reminder recorded for 2 captains')).toBeInTheDocument();
    expect(within(calls).getByRole('link', { name: 'Enter result' })).toBeInTheDocument();
  });

  it('accepts a submitted referee report inline with its revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/results-awaiting': ok({ ...awaiting(false), items: [] }),
        'GET /seasons/{id}/result-revisions': ok(page([resultRevision()])),
        'POST /results/{id}/publish': ok({
          revision: resultRevision({ status: 'official' }),
          published: false,
          supersededRevisionId: null,
          reviewExceptionId: ID.result2,
          standings: null,
          proposedSuspensionIds: [],
          bracketNodeIds: [],
        }),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const calls = await screen.findByRole('list', { name: 'Decisions waiting' });
    await user.click(await within(calls).findByRole('button', { name: /Accept the report/ }));
    expect(
      await within(calls).findByText('Needs management review: nothing was published'),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: 2,
    });
  });
});

describe('Placement board keyboard placement (SPK-UX-009)', () => {
  it('selects an entrant with a button and offers placement on candidate team columns only', async () => {
    const user = userEvent.setup();
    const request = {
      id: ID.placement,
      participantPersonId: ID.person,
      applicationId: null,
      enrollmentId: null,
      offeringId: null,
      seasonId: ID.season,
      status: 'unassigned',
      availability: [],
      preferredCompetitionId: null,
      preferredDivisionId: null,
      declaredLevel: null,
      positionPreferences: [],
      requestedTeammatePersonIds: [],
      notes: null,
      proposedTeamEntryId: null,
      proposedAt: null,
      proposalReasons: [],
      assignedTeamEntryId: null,
      assignedAt: null,
      decidedByPersonId: null,
      decisionReasons: [],
      rosterMembershipRef: null,
      lastOperationId: null,
      releasedAt: null,
      releaseReason: null,
      revision: 1,
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    const app = createTestApp({
      routes: {
        ...TEAM_ROUTES,
        'GET /team-entries': ok([
          teamEntry({ status: 'approved' }),
          teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue, status: 'approved' }),
        ]),
        'GET /placement-requests': ok(page([request])),
        'GET /person-names': personNames({ [ID.person]: ['Riley', 'Free'] }),
        'GET /placement-requests/{id}/candidates': ok([
          {
            teamEntryId: ID.entryRed,
            teamName: 'Red',
            divisionId: null,
            eligible: true,
            reasons: [],
            capacity: null,
            requestedTeammatesOnRoster: 0,
            recommended: false,
          },
        ]),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    const teams = await screen.findByRole('list', { name: 'Teams of the season' });
    expect(within(teams).getAllByText('5 players of 8 minimum')).toHaveLength(2);
    await user.click(await screen.findByRole('button', { name: 'Show candidate teams' }));
    expect(await screen.findByText('Choose a team for Riley Free')).toBeInTheDocument();
    const candidates = await screen.findByRole('list', { name: 'Candidate teams' });
    expect(within(candidates).getByRole('button', { name: 'Assign to Red' })).toBeInTheDocument();
    expect(within(candidates).queryByRole('button', { name: 'Assign to Blue' })).toBeNull();
    expect(
      within(candidates).getByText('Not offered as a candidate for Riley.'),
    ).toBeInTheDocument();
  });
});
