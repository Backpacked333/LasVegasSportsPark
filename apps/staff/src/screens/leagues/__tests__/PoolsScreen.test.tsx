/**
 * SCR-S-13 tournament pools behind the tournaments capability (CMP-15; §3.16; DEC-016, DEC-078)
 * and seeding a bracket node from final standings (CMP-10; SPK-COMP-001, SPK-RESULT-003).
 */
import { capabilityDisabledBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  ID,
  bracketNode,
  created,
  division,
  fail,
  ok,
  page,
  pool,
  poolStandings,
  standings,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

const ON = { 'GET /me/permissions': mePermissions({ enabled: ['tournaments'] }) };

const entries = [
  teamEntry({ status: 'approved', divisionId: ID.division }),
  teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue, status: 'approved', divisionId: ID.division }),
];

const poolRoutes = {
  'GET /pools/{id}': ok(pool()),
  'GET /pools/{id}/standings': ok(poolStandings()),
  'GET /divisions/{id}': ok(division()),
  'GET /team-entries': ok(entries),
  'GET /seasons/{id}/bracket-nodes': ok([]),
};

describe('SCR-S-13 DivisionPoolsScreen (CMP-15, DEC-016, DEC-078)', () => {
  it('creates a pool while tournaments is on and opens it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...ON,
        ...poolRoutes,
        'POST /divisions/{id}/pools': created(pool({ entries: [] })),
      },
    });
    render(app.at(`/leagues/divisions/${ID.division}/pools`));
    const form = await screen.findByRole('form', { name: 'Create a pool' });
    await user.click(within(form).getByRole('button', { name: 'Create the pool' }));
    expect(within(form).getByText('Name the pool.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Pool name/), 'Pool A');
    await user.click(within(form).getByRole('button', { name: 'Create the pool' }));
    expect(await screen.findByRole('heading', { name: 'Pool: Pool A' })).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/divisions/{id}/pools');
    expect(sent?.body).toEqual({ name: 'Pool A' });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('shows "Tournaments turned off" and offers no new pool while the switch is off', async () => {
    const app = createTestApp({ routes: poolRoutes });
    render(app.at(`/leagues/divisions/${ID.division}/pools`));
    expect(await screen.findByText('Tournament pools turned off')).toBeInTheDocument();
    expect(screen.getByText(/DEC-016, DEC-078/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create a pool' })).toBeNull();
    // Existing pools stay reachable by reference.
    expect(screen.getByRole('form', { name: 'Open a pool' })).toBeInTheDocument();
  });

  it('shows the turned-off state when the API refuses creation with CAPABILITY_DISABLED', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...ON,
        ...poolRoutes,
        'POST /divisions/{id}/pools': () =>
          fakeResponse(403, capabilityDisabledBody('tournaments', ['DEC-016', 'DEC-078'])),
      },
    });
    render(app.at(`/leagues/divisions/${ID.division}/pools`));
    const form = await screen.findByRole('form', { name: 'Create a pool' });
    await user.type(within(form).getByLabelText(/^Pool name/), 'Pool A');
    await user.click(within(form).getByRole('button', { name: 'Create the pool' }));
    expect(await within(form).findByText('Tournaments turned off')).toBeInTheDocument();
  });

  it('opens a pool by its reference, checked before navigating', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: poolRoutes });
    render(app.at(`/leagues/divisions/${ID.division}/pools`));
    const form = await screen.findByRole('form', { name: 'Open a pool' });
    await user.type(within(form).getByLabelText('Pool reference'), 'not-a-reference');
    await user.click(within(form).getByRole('button', { name: 'Open the pool' }));
    expect(within(form).getByText(/Enter the pool reference/)).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Pool reference'));
    await user.type(within(form).getByLabelText('Pool reference'), ID.pool);
    await user.click(within(form).getByRole('button', { name: 'Open the pool' }));
    expect(await screen.findByRole('heading', { name: 'Pool: Pool A' })).toBeInTheDocument();
  });
});

describe('SCR-S-13 PoolScreen (CMP-15)', () => {
  it('shows entries and standings; places an entry with the pool revision while on', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...ON,
        ...poolRoutes,
        'POST /pools/{id}/entries': ok(
          pool({
            entries: [
              { teamEntryId: ID.entryRed, teamName: 'Red', seed: 1 },
              { teamEntryId: ID.entryBlue, teamName: 'Blue', seed: 2 },
            ],
            revision: 3,
          }),
        ),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    const list = await screen.findByRole('list', { name: 'Pool entries' });
    expect(within(list).getByText('Red')).toBeInTheDocument();
    expect(within(list).getByText('Seed 1')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Pool standings' })).toBeInTheDocument();
    expect(screen.getByText('Final')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Place an entry in the pool' });
    // Red is already in the pool; only Blue is offered.
    const select = within(form).getByLabelText(/^Team entry/);
    expect(within(select).queryByRole('option', { name: 'Red' })).toBeNull();
    await user.selectOptions(select, ID.entryBlue);
    await user.type(within(form).getByLabelText('Seed'), '2');
    await user.click(within(form).getByRole('button', { name: 'Place in the pool' }));
    expect(await within(form).findByText('Entry placed in the pool')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/pools/{id}/entries')?.body).toEqual({
      teamEntryId: ID.entryBlue,
      expectedRevision: 2,
      seed: 2,
    });
  });

  it('keeps existing pools readable and removable while tournaments is off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...poolRoutes,
        'POST /pools/{id}/entries/{teamEntryId}/remove': ok(pool({ entries: [], revision: 3 })),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    expect(await screen.findByText('Tournament pools turned off')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Place an entry in the pool' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Pool entries' });
    await user.click(within(list).getByRole('button', { name: 'Remove Red from the pool' }));
    const form = within(list).getByRole('form', { name: 'Remove Red' });
    await user.click(within(form).getByRole('button', { name: 'Remove from the pool' }));
    expect(within(form).getByText('Give the reason for removing the entry.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason/), 'Team withdrew.');
    await user.click(within(form).getByRole('button', { name: 'Remove from the pool' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/pools/{id}/entries/{teamEntryId}/remove'),
      ).toMatchObject({
        params: { id: ID.pool, teamEntryId: ID.entryRed },
        body: { reason: 'Team withdrew.', expectedRevision: 2 },
      }),
    );
  });

  it('says the pool table is not final while fixtures have no official result', async () => {
    const app = createTestApp({
      routes: {
        ...poolRoutes,
        'GET /pools/{id}/standings': ok(poolStandings({ pendingFixtureIds: [ID.fixture2] })),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    expect(await screen.findByText('Not final')).toBeInTheDocument();
    expect(screen.getByText(/1 fixture between pool entries has no official result/)).toBeVisible();
  });

  it('never implies that a pool the viewer may not see exists', async () => {
    const app = createTestApp({
      routes: { 'GET /pools/{id}': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Pool entries' })).toBeNull();
  });
});

describe('SCR-S-13 seeding a bracket node from standings (CMP-10, CMP-15)', () => {
  const unpublished = bracketNode({
    published: false,
    homeEntryId: null,
    awayEntryId: null,
    homeTeamName: null,
    awayTeamName: null,
    revision: 4,
  });

  it('seeds from a pool’s final standings with the node revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...poolRoutes,
        'GET /seasons/{id}/bracket-nodes': ok([unpublished]),
        'POST /bracket-nodes/{id}/seed-from-standings': ok(
          bracketNode({
            published: false,
            homeEntryId: ID.entryRed,
            awayEntryId: null,
            homeTeamName: 'Red',
            awayTeamName: null,
            revision: 5,
          }),
        ),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    const nodes = await screen.findByRole('list', { name: 'Bracket nodes to seed' });
    await user.click(within(nodes).getByRole('button', { name: 'Seed Final from standings' }));
    const form = within(nodes).getByRole('form', { name: 'Seed Final from standings' });
    await user.click(within(form).getByRole('button', { name: 'Seed from standings' }));
    expect(
      within(form).getByText('Give the rank for at least one seeded slot.'),
    ).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Rank for the home slot/), '1');
    await user.click(within(form).getByRole('button', { name: 'Seed from standings' }));
    expect(await within(form).findByText('Seeded: Red v away slot empty')).toBeInTheDocument();
    const sent = app.fake.requests.find(
      (r) => r.route === '/bracket-nodes/{id}/seed-from-standings',
    );
    expect(sent?.body).toEqual({
      expectedRevision: 4,
      sources: [{ poolId: ID.pool, rank: 1, slot: 'home' }],
    });
  });

  it('explains a table that is not final and an unresolved tie, never as a changed record', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...poolRoutes,
        'GET /seasons/{id}/bracket-nodes': ok([unpublished]),
        'POST /bracket-nodes/{id}/seed-from-standings': fail(
          409,
          'INVALID_TRANSITION',
          'reload_and_retry',
          { details: { code: 'STANDINGS_NOT_FINAL', pendingFixtureIds: [ID.fixture2] } },
        ),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    const nodes = await screen.findByRole('list', { name: 'Bracket nodes to seed' });
    await user.click(within(nodes).getByRole('button', { name: 'Seed Final from standings' }));
    const form = within(nodes).getByRole('form', { name: 'Seed Final from standings' });
    await user.type(within(form).getByLabelText(/^Rank for the home slot/), '1');
    await user.click(within(form).getByRole('button', { name: 'Seed from standings' }));
    expect(await within(form).findByText('Standings not final')).toBeInTheDocument();
    expect(within(form).getByText(/1 fixture has no official result yet/)).toBeVisible();
    expect(within(form).queryByText('This record changed')).toBeNull();

    app.fake.set(
      'POST /bracket-nodes/{id}/seed-from-standings',
      fail(409, 'INVALID_TRANSITION', 'reload_and_retry', {
        details: { code: 'UNRESOLVED_TIE', rank: 1, tiedEntryIds: [ID.entryRed] },
      }),
    );
    await user.clear(within(form).getByLabelText(/^Rank for the home slot/));
    await user.type(within(form).getByLabelText(/^Rank for the home slot/), '2');
    await user.click(within(form).getByRole('button', { name: 'Seed from standings' }));
    expect(await within(form).findByText('Unresolved tie')).toBeInTheDocument();
    expect(
      within(within(form).getByRole('list', { name: 'Tied entries' })).getByText('Red'),
    ).toBeVisible();
  });

  it('seeds an unpublished node from a division’s standings on the standings screen', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /divisions': ok([division()]),
        'GET /team-entries': ok(entries),
        'GET /seasons/{id}/standings': ok(standings()),
        'GET /seasons/{id}/bracket-nodes': ok([unpublished]),
        'GET /exceptions': ok(page([])),
        'POST /bracket-nodes/{id}/seed-from-standings': ok(
          bracketNode({ published: false, revision: 5 }),
        ),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}/standings`));
    await user.click(await screen.findByRole('button', { name: 'Seed Final from standings' }));
    const form = screen.getByRole('form', { name: 'Seed Final from standings' });
    await user.selectOptions(within(form).getByLabelText(/^Standings to seed from/), 'division');
    await user.selectOptions(within(form).getByLabelText(/^Division/), ID.division);
    await user.type(within(form).getByLabelText(/^Rank for the home slot/), '1');
    await user.type(within(form).getByLabelText(/^Rank for the away slot/), '2');
    await user.click(within(form).getByRole('button', { name: 'Seed from standings' }));
    expect(await within(form).findByText('Seeded: Red v Blue')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/bracket-nodes/{id}/seed-from-standings')?.body,
    ).toEqual({
      expectedRevision: 4,
      sources: [
        { divisionId: ID.division, rank: 1, slot: 'home' },
        { divisionId: ID.division, rank: 2, slot: 'away' },
      ],
    });
  });
});
