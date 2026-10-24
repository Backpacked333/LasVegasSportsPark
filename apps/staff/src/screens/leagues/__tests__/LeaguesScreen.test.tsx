/**
 * SCR-S-08 Competition, season and division setup: competitions list and creation, a competition's
 * lifecycle and seasons (SPK-COMP-001, SPK-COMP-002, SPK-UX-008, §4.9 Idempotency-Key and
 * expectedRevision, §4.10 error contract).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  competition,
  created,
  fail,
  ok,
  ruleSet,
  season,
} from '../../../features/competition/__tests__/fixtures';

describe('SCR-S-08 LeaguesScreen (SPK-COMP-001)', () => {
  it('lists competitions with kind, format and status in words', async () => {
    const app = createTestApp({ routes: { 'GET /competitions': ok([competition()]) } });
    render(app.at('/leagues'));
    const list = await screen.findByRole('list', { name: 'Competitions' });
    expect(within(list).getByRole('link', { name: 'Autumn League' })).toHaveAttribute(
      'href',
      `/leagues/competitions/${ID.competition}`,
    );
    expect(within(list).getByText('League · Boarded indoor soccer')).toBeInTheDocument();
    expect(within(list).getByText('Competition draft')).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Leagues and tournaments screens' }),
    ).toBeInTheDocument();
  });

  it('shows the empty state with the way to create one', async () => {
    const app = createTestApp({ routes: { 'GET /competitions': ok([]) } });
    render(app.at('/leagues'));
    expect(await screen.findByRole('heading', { name: 'No competitions' })).toBeInTheDocument();
  });

  it('shows the API error code and a recovery action when the list fails', async () => {
    const app = createTestApp({
      routes: { 'GET /competitions': fail(500, 'INTERNAL_ERROR', 'retry_or_contact_support') },
    });
    render(app.at('/leagues'));
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('validates a new competition before sending, then creates it with an idempotency key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /competitions': ok([]),
        'POST /competitions': created(competition()),
        'GET /competitions/{id}': ok(competition()),
        'GET /seasons': ok([]),
      },
    });
    render(app.at('/leagues'));
    await user.click(await screen.findByRole('button', { name: 'New competition' }));
    const form = screen.getByRole('form', { name: 'New competition' });
    await user.click(within(form).getByRole('button', { name: 'Create competition' }));
    expect(within(form).getByText('Enter the competition name.')).toBeInTheDocument();
    expect(within(form).getByText('Choose the soccer format.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);

    await user.type(within(form).getByLabelText(/^Name/), 'Autumn League');
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'league');
    await user.selectOptions(within(form).getByLabelText(/^Soccer format/), 'indoor_boarded');
    await user.click(within(form).getByRole('button', { name: 'Create competition' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/competitions' && r.method === 'POST'),
      ).toBe(true),
    );
    const post = app.fake.requests.find((r) => r.route === '/competitions' && r.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Autumn League',
      kind: 'league',
      sportFormat: 'indoor_boarded',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(await screen.findByRole('heading', { name: 'Autumn League' })).toBeInTheDocument();
  });

  it('shows ACCESS_DENIED on create as not available to this account', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /competitions': ok([]),
        'POST /competitions': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access', {
          message: 'Missing competition.manage_competitions.',
        }),
      },
    });
    render(app.at('/leagues'));
    await user.click(await screen.findByRole('button', { name: 'New competition' }));
    const form = screen.getByRole('form', { name: 'New competition' });
    await user.type(within(form).getByLabelText(/^Name/), 'X');
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'league');
    await user.selectOptions(within(form).getByLabelText(/^Soccer format/), 'futsal');
    await user.click(within(form).getByRole('button', { name: 'Create competition' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/Missing competition.manage_competitions/)).toBeInTheDocument();
  });
});

describe('SCR-S-08 CompetitionScreen (SPK-COMP-001, SPK-COMP-002)', () => {
  const routes = {
    'GET /competitions/{id}': ok(competition()),
    'GET /seasons': ok([season()]),
    'GET /rule-sets': ok([ruleSet()]),
  };

  it('moves the competition through its machine with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'PATCH /competitions/{id}': ok(competition({ status: 'active', revision: 3 })),
      },
    });
    render(app.at(`/leagues/competitions/${ID.competition}`));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Competition active')).toBeInTheDocument();
    const patch = app.fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ expectedRevision: 2, status: 'active' });
  });

  it('lists seasons and keeps the season copy unavailable with the reason', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/leagues/competitions/${ID.competition}`));
    const seasons = await screen.findByRole('list', { name: 'Seasons' });
    expect(within(seasons).getByRole('link', { name: 'Autumn 2026' })).toBeInTheDocument();
    expect(within(seasons).getByText('Season draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy a season as a draft' })).toBeDisabled();
    expect(screen.getByText(/the API has no copy command/)).toBeInTheDocument();
  });

  it('creates a season against the latest rule-set version of the competition’s format', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /seasons': created(season()),
        'GET /seasons/{id}': ok(season()),
        'GET /divisions': ok([]),
        'GET /rule-sets/{id}': ok(ruleSet()),
      },
    });
    render(app.at(`/leagues/competitions/${ID.competition}`));
    await user.click(await screen.findByRole('button', { name: 'New season' }));
    const form = screen.getByRole('form', { name: 'New season' });
    await user.type(within(form).getByLabelText(/^Season name/), 'Autumn 2026');
    await user.selectOptions(within(form).getByLabelText(/^Rule-set version/), ID.ruleSet);
    await user.type(within(form).getByLabelText(/^First day/), '2026-11-01');
    await user.type(within(form).getByLabelText(/^Last day/), '2026-12-20');
    await user.click(within(form).getByRole('button', { name: 'Create season (draft)' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/seasons' && r.method === 'POST')).toBe(
        true,
      ),
    );
    const rules = app.fake.requests.find((r) => r.route === '/rule-sets');
    expect(rules?.query).toEqual({ format: 'indoor_boarded', latestOnly: 'true' });
    const post = app.fake.requests.find((r) => r.route === '/seasons' && r.method === 'POST');
    expect(post?.body).toEqual({
      competitionId: ID.competition,
      name: 'Autumn 2026',
      ruleSetId: ID.ruleSet,
      startsOn: '2026-11-01',
      endsOn: '2026-12-20',
    });
  });

  it('shows a competition the API will not show as not available', async () => {
    const app = createTestApp({
      routes: { 'GET /competitions/{id}': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(app.at(`/leagues/competitions/${ID.competition}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Seasons' })).toBeNull();
  });
});
