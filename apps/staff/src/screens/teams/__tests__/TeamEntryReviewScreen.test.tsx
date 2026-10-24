/**
 * SCR-S-16 Team entry review (SPK-COMP-004 approval, financial status, roster completion and
 * competition eligibility distinct, what is missing and who resolves it; SPK-AT-003) and the Teams
 * area home.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  TEAM_ROUTES,
  competition,
  division,
  fail,
  ok,
  season,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

const routes = {
  ...TEAM_ROUTES,
  'GET /divisions': ok([division()]),
  'GET /team-entries': ok([teamEntry()]),
};

describe('SCR-S-16 TeamEntryReviewScreen (SPK-COMP-004)', () => {
  it('keeps approval, financial status, roster completion and eligibility apart', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const list = await screen.findByRole('list', { name: 'Team entries' });
    expect(await within(list).findByText('Red')).toBeInTheDocument();
    const facets = within(list).getByLabelText('Entry facets');
    expect(within(facets).getByText('Entry applied')).toBeInTheDocument();
    expect(within(facets).getByText('No obligation recorded by finance yet')).toBeInTheDocument();
    expect(within(facets).getByText('Roster incomplete')).toBeInTheDocument();
    expect(within(facets).getByText('5 players (rule set 8 to 14)')).toBeInTheDocument();
    expect(within(facets).getByText('Eligibility review required')).toBeInTheDocument();
    // What is missing, and who can resolve it.
    expect(within(list).getByText(/Missing: 3 more players/)).toBeInTheDocument();
    const missing = within(list).getByRole('list', { name: 'What is missing' });
    expect(
      within(missing).getByText(
        'Resolved by: Captain. Required action: Add players to the roster.',
      ),
    ).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Roster' })).toHaveAttribute(
      'href',
      `/teams/entries/${ID.entryRed}/roster`,
    );
  });

  it('never presents approved as paid or roster-complete', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /team-entries': ok([
          teamEntry({ status: 'approved', financialStatusRef: 'obl-1234567890' }),
        ]),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const facets = await screen.findByLabelText('Entry facets');
    expect(within(facets).getByText('Entry approved')).toBeInTheDocument();
    expect(within(facets).getByText('Obligation obl-1234')).toBeInTheDocument();
    expect(within(facets).getByText('Roster incomplete')).toBeInTheDocument();
    expect(within(facets).queryByText(/paid/i)).toBeNull();
  });

  it('declines only with a reason, then sends it with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/reject': ok(
          teamEntry({ status: 'rejected', rejectionReason: 'Late' }),
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    const form = screen.getByRole('form', { name: 'Decline the entry' });
    await user.click(within(form).getByRole('button', { name: 'Decline the entry' }));
    expect(
      within(form).getByText('A decline needs a reason the captain will see.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason/), 'Registration closed.');
    await user.click(within(form).getByRole('button', { name: 'Decline the entry' }));
    expect(await screen.findByText('Entry rejected')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({ expectedRevision: 3, reason: 'Registration closed.' });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('approves and places the entry in a division, showing capacity in the choice', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/approve': ok(
          teamEntry({ status: 'approved', divisionId: ID.division }),
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const form = screen.getByRole('form', { name: 'Approve the entry' });
    const select = within(form).getByLabelText('Place in division');
    expect(
      within(select).getByRole('option', { name: 'Division A (2 of 8 places used)' }),
    ).toBeInTheDocument();
    await user.selectOptions(select, ID.division);
    await user.click(within(form).getByRole('button', { name: 'Approve the entry' }));
    expect(await screen.findByText('Entry approved')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: 3,
      divisionId: ID.division,
    });
  });

  it('shows CAPACITY_UNAVAILABLE on placement with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/approve': fail(
          409,
          'CAPACITY_UNAVAILABLE',
          'join_waitlist_or_choose_alternative',
          {
            message: 'The division is full.',
          },
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const form = screen.getByRole('form', { name: 'Approve the entry' });
    await user.selectOptions(within(form).getByLabelText('Place in division'), ID.division);
    await user.click(within(form).getByRole('button', { name: 'Approve the entry' }));
    expect(await screen.findByText('The division is full.')).toBeInTheDocument();
    expect(screen.getByText(/Error code: CAPACITY_UNAVAILABLE/)).toBeInTheDocument();
  });

  it('Try again repeats the command that timed out, even after another form is opened', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/approve': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('network down');
          return new Response(JSON.stringify(teamEntry({ status: 'approved' })), { status: 200 });
        },
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const form = screen.getByRole('form', { name: 'Approve the entry' });
    await user.click(within(form).getByRole('button', { name: 'Approve the entry' }));
    expect(await screen.findByText('Outcome not known yet')).toBeInTheDocument();
    // Opening the decline form does not turn "Try again" into a decline.
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Entry approved')).toBeInTheDocument();
    const posts = app.fake.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.route)).toEqual([
      '/team-entries/{id}/approve',
      '/team-entries/{id}/approve',
    ]);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
  });

  it('shows the list as not available to an account without the permission', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /team-entries': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('shows the empty state when no team applied', async () => {
    const app = createTestApp({ routes: { ...routes, 'GET /team-entries': ok([]) } });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    expect(await screen.findByRole('heading', { name: 'No entries' })).toBeInTheDocument();
  });
});

describe('Teams and placement area home (SPK-UX-005)', () => {
  it('lists the seasons of a chosen competition with links to their screens', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /competitions': ok([competition()]), 'GET /seasons': ok([season()]) },
    });
    render(app.at('/teams'));
    await user.selectOptions(await screen.findByLabelText('Competition'), ID.competition);
    const list = await screen.findByRole('list', { name: 'Seasons' });
    expect(within(list).getByRole('link', { name: 'Team entries of Autumn 2026' })).toHaveAttribute(
      'href',
      `/teams/seasons/${ID.season}/entries`,
    );
    expect(
      within(list).getByRole('link', { name: 'Placement board of Autumn 2026' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/seasons')?.query).toEqual({
        competitionId: ID.competition,
      }),
    );
  });
});
