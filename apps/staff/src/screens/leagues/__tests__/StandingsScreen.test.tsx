/**
 * SCR-S-13 Standings and brackets (SPK-RESULT-001 official results only, SPK-RESULT-003 versioned
 * rule set and tiebreak explanations, SPK-RESULT-004 / SPK-AT-014 nodes under review, bracket
 * progression; seeding and tournament pools are in PoolsScreen.test.tsx).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  TEAM_ROUTES,
  bracketNode,
  division,
  fail,
  ok,
  page,
  reviewTask,
  standings,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

const base = {
  ...TEAM_ROUTES,
  'GET /divisions': ok([division()]),
  'GET /team-entries': ok([
    teamEntry({ status: 'approved' }),
    teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue, status: 'approved' }),
  ]),
  'GET /seasons/{id}/standings': ok(standings()),
  'GET /seasons/{id}/bracket-nodes': ok([]),
  'GET /exceptions': ok(page([])),
};

describe('SCR-S-13 StandingsScreen (SPK-RESULT-003)', () => {
  it('shows the table with its rule-set version, computation time and official sources', async () => {
    const app = createTestApp({ routes: base });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    const table = await screen.findByRole('table', { name: 'Standings' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[1] as HTMLElement).getByRole('rowheader', { name: 'Red' }),
    ).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Points' })).toBeInTheDocument();
    expect(screen.getByTestId('standings-provenance')).toHaveTextContent(
      /Rule set version 3 .* from 2 official results · standings revision/,
    );
  });

  it('explains how a tie on points was decided, step by step', async () => {
    const app = createTestApp({ routes: base });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    const ties = await screen.findByRole('list', { name: 'Tiebreak explanations' });
    expect(within(ties).getByText('Red, Blue on 6 points')).toBeInTheDocument();
    expect(within(ties).getByText('Tie resolved')).toBeInTheDocument();
    expect(
      within(ties).getByText(
        /Head to head resolved the tie: Red won the match between the two teams./,
      ),
    ).toBeInTheDocument();
  });

  it('asks for a division’s standings and says when no result is official yet', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/standings': (req) =>
          new Response(
            JSON.stringify(
              req.query.divisionId
                ? standings({ sourceResultIds: [], rows: [], tiebreakExplanations: [] })
                : standings(),
            ),
            { status: 200 },
          ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    await screen.findByRole('table', { name: 'Standings' });
    await user.selectOptions(screen.getByLabelText('Division'), ID.division);
    expect(
      await screen.findByRole('heading', { name: 'No official results yet' }),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.some(
        (r) => r.route === '/seasons/{id}/standings' && r.query.divisionId === ID.division,
      ),
    ).toBe(true);
  });

  it('shows the API error code when standings cannot be read', async () => {
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/standings': fail(500, 'INTERNAL_ERROR', 'retry_or_contact_support'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeInTheDocument();
  });
});

describe('SCR-S-13 brackets (SPK-COMP-001 bracket progression, SPK-AT-014)', () => {
  it('shows each side’s source, marks a node touched by an open correction review as under review', async () => {
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/bracket-nodes': ok([
          bracketNode(),
          bracketNode({
            id: ID.node2,
            name: null,
            round: 2,
            slot: 1,
            sourceRule: { home: { kind: 'winner_of', nodeId: ID.node1 }, away: { kind: 'bye' } },
            homeEntryId: null,
            awayEntryId: null,
            fixtureId: null,
            published: false,
          }),
        ]),
        'GET /exceptions': ok(page([reviewTask()])),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    const round1 = await screen.findByRole('list', { name: 'Round 1' });
    expect(await within(round1).findByText('Under review')).toBeInTheDocument();
    expect(within(round1).getByText('Published')).toBeInTheDocument();
    expect(within(round1).getByText(/Seed 1/)).toBeInTheDocument();
    const round2 = screen.getByRole('list', { name: 'Round 2' });
    expect(within(round2).getByText(/Winner of Final/)).toBeInTheDocument();
    expect(within(round2).getByText(/^Bye/)).toBeInTheDocument();
    expect(within(round2).getByText('Not published')).toBeInTheDocument();
    expect(within(round2).queryByText('Under review')).toBeNull();
    // Team names come with the node (CMP-01): no per-team read.
    expect(within(round1).getByText('Red')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/teams/{id}')).toHaveLength(0);
  });

  it('SCR-S-13: an acknowledged correction review keeps the node under review and offers no Publish', async () => {
    const node = bracketNode({ published: false, revision: 4 });
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/bracket-nodes': ok([node]),
        'GET /exceptions': ok(page([reviewTask({ status: 'acknowledged' })])),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    const round1 = await screen.findByRole('list', { name: 'Round 1' });
    expect(await within(round1).findByText('Under review')).toBeInTheDocument();
    expect(within(round1).queryByRole('button', { name: /Publish bracket node/ })).toBeNull();
    const request = app.fake.requests.find((r) => r.route === '/exceptions');
    expect(request?.query['status']).toBeUndefined();
  });

  it('publishes a bracket node with the expected revision', async () => {
    const user = userEvent.setup();
    const node = bracketNode({ published: false, revision: 4 });
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/bracket-nodes': ok([node]),
        'POST /bracket-nodes/{id}/publish': ok({ ...node, published: true }),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    await user.click(await screen.findByRole('button', { name: 'Publish bracket node Final' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
        expectedRevision: 4,
      }),
    );
  });

  it('says the review state is unknown when review tasks cannot be read', async () => {
    const app = createTestApp({
      routes: {
        ...base,
        'GET /seasons/{id}/bracket-nodes': ok([bracketNode()]),
        'GET /exceptions': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    expect(
      await screen.findByText(/whether a node is under review is unknown/),
    ).toBeInTheDocument();
    expect(screen.getByText('Review status unknown')).toBeInTheDocument();
  });
});
