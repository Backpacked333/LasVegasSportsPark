/**
 * SCR-S-08 season and divisions (SPK-COMP-001, SPK-COMP-003, SPK-UX-008): the season machine with
 * expectedRevision, STALE_REVISION with "Reload", divisions with documented criteria and the
 * pending DEC-048 note.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  created,
  division,
  facilities,
  fail,
  ok,
  ruleSet,
  season,
} from '../../../features/competition/__tests__/fixtures';
import { describeCriteria } from '../SeasonScreen';

const routes = {
  'GET /seasons/{id}': ok(season()),
  'GET /divisions': ok([division()]),
  'GET /rule-sets/{id}': ok(ruleSet()),
};

describe('SCR-S-08 SeasonScreen (SPK-COMP-003)', () => {
  it('shows the season, its rule-set version and divisions with documented criteria', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/leagues/seasons/${ID.season}`));
    expect(await screen.findByRole('heading', { name: 'Autumn 2026' })).toBeInTheDocument();
    expect(await screen.findByText('Indoor 6v6, version 1')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Divisions' });
    expect(within(list).getByText('Ages 18 and over · Level: Open')).toBeInTheDocument();
    expect(within(list).getByText(/Teams placed: 2 of 8/)).toBeInTheDocument();
    expect(
      within(list).getByRole('link', { name: 'Generate fixtures for Division A' }),
    ).toHaveAttribute('href', `/leagues/divisions/${ID.division}/fixture-generation`);
    // DEC-048 approved combinations are pending: named, not invented.
    expect(screen.getByText(/depends on DEC-048/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Season screens' })).toBeInTheDocument();
  });

  it('names a division’s facility from the directory and links its tournament pools', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /divisions': ok([division({ facilityId: ID.facility })]),
        'GET /facilities': ok(facilities()),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    const list = await screen.findByRole('list', { name: 'Divisions' });
    expect(await within(list).findByText(/· North Park/)).toBeInTheDocument();
    expect(
      within(list).getByRole('link', { name: 'Tournament pools of Division A' }),
    ).toHaveAttribute('href', `/leagues/divisions/${ID.division}/pools`);
    expect(screen.getByRole('link', { name: 'Result revisions' })).toHaveAttribute(
      'href',
      `/leagues/seasons/${ID.season}/results`,
    );
  });

  it('opens the season with the expected revision and an idempotency key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes, 'PATCH /seasons/{id}': ok(season({ status: 'open', revision: 5 })) },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await user.click(await screen.findByRole('button', { name: 'Open the season' }));
    expect(await screen.findByText('Season open')).toBeInTheDocument();
    const patch = app.fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ expectedRevision: 4, status: 'open' });
    expect(patch?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('archiving asks for confirmation, names the consequence and sends the reason (irreversible)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes, 'PATCH /seasons/{id}': ok(season({ status: 'archived' })) },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const confirm = screen.getByRole('group', { name: 'Confirm: Archive' });
    expect(within(confirm).getByText(/Archiving cannot be undone/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
    await user.type(within(confirm).getByLabelText(/^Reason/), 'Season cancelled by the league.');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm: Archive' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        expectedRevision: season().revision,
        status: 'archived',
        reason: 'Season cancelled by the league.',
      }),
    );
  });

  it('reports STALE_REVISION with "Reload", which fetches the current season', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'PATCH /seasons/{id}': fail(409, 'STALE_REVISION', 'reload_and_retry'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await user.click(await screen.findByRole('button', { name: 'Open the season' }));
    expect(await screen.findByText('This record changed')).toBeInTheDocument();
    expect(screen.getByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/seasons/{id}' && r.method === 'GET'),
      ).toHaveLength(2),
    );
  });

  it('retries a timed-out transition with the same idempotency key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        ...routes,
        'PATCH /seasons/{id}': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('network down');
          return new Response(JSON.stringify(season({ status: 'open' })), { status: 200 });
        },
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await user.click(await screen.findByRole('button', { name: 'Open the season' }));
    expect(await screen.findByText('Outcome not known yet')).toBeInTheDocument();
    expect(screen.queryByText(/Not sent/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const keys = app.fake.requests
      .filter((r) => r.method === 'PATCH')
      .map((r) => r.headers['idempotency-key']);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it('creates a division with documented criteria and validates the age band', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes, 'POST /divisions': created(division({ name: 'Division B' })) },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    await user.click(await screen.findByRole('button', { name: 'New division' }));
    const form = screen.getByRole('form', { name: 'New division' });
    await user.type(within(form).getByLabelText(/^Division name/), 'Division B');
    await user.type(within(form).getByLabelText('Minimum age'), '30');
    await user.type(within(form).getByLabelText('Maximum age'), '20');
    await user.click(within(form).getByRole('button', { name: 'Create division' }));
    expect(within(form).getByText('The maximum age is below the minimum.')).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Maximum age'));
    await user.type(within(form).getByLabelText('Playing level'), 'Recreational');
    await user.click(within(form).getByRole('button', { name: 'Create division' }));
    expect(await within(form).findByText('Division Division B created')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/divisions' && r.method === 'POST');
    expect(post?.body).toEqual({
      seasonId: ID.season,
      name: 'Division B',
      criteria: {
        ageBand: { minAge: 30, maxAge: null },
        level: 'Recreational',
        category: null,
        format: null,
      },
    });
  });

  it('shows a season the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /seasons/{id}': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at(`/leagues/seasons/${ID.season}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('describes criteria in words and says when none are documented', () => {
    expect(
      describeCriteria({
        ageBand: { minAge: 8, maxAge: 10 },
        level: null,
        category: 'Girls',
        format: '7v7',
      }),
    ).toBe('Ages 8 to 10 · Category: Girls · Format: 7v7');
    expect(describeCriteria({ ageBand: null, level: null, category: null, format: null })).toBe(
      'No documented criteria',
    );
  });
});
