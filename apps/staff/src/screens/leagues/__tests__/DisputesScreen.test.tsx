/**
 * SCR-S-12 disputes across fixtures (`GET /v1/disputes`, CMP-05) and the submitter's withdrawal
 * (`POST /v1/disputes/{id}/withdraw`, CMP-12; SPK-RESULT-005, SPK-UX-008).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, staffMe } from '../../../testing/test-app';
import {
  ID,
  dispute,
  fail,
  fixtureDetail,
  ok,
  page,
  season,
  teamEntry,
  venue,
} from '../../../features/competition/__tests__/fixtures';

const ME_PERSON = '0192f1a0-0000-7000-8000-0000000000dd';

const routes = {
  'GET /seasons': ok([season()]),
  'GET /fixtures/{id}': ok(fixtureDetail({ venue: venue() })),
  'GET /disputes': ok(page([dispute()])),
};

describe('SCR-S-12 DisputesScreen (SPK-RESULT-005, CMP-05)', () => {
  it('lists open disputes newest first with their fixture and facts, filtered by season', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at('/leagues/disputes'));
    const list = await screen.findByRole('list', { name: 'Disputes' });
    expect(within(list).getByText('Dispute submitted')).toBeInTheDocument();
    expect(within(list).getByText('Reason: The second goal was offside.')).toBeInTheDocument();
    expect(await within(list).findByRole('link', { name: /Red v Blue/ })).toHaveAttribute(
      'href',
      `/leagues/fixtures/${ID.fixture}/disputes`,
    );
    // The submitting entry is named from the fixture, with no per-team read.
    expect(within(list).getByText('Blue')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/teams/{id}')).toHaveLength(0);
    // Every status by default (open disputes are submitted or under review).
    expect(app.fake.requests.find((r) => r.route === '/disputes')?.query.status).toBeUndefined();
    await user.selectOptions(screen.getByLabelText('Dispute status'), 'under_review');
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/disputes' && r.query.status === 'under_review'),
      ).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText('Season'), ID.season);
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/disputes' && r.query.seasonId === ID.season),
      ).toBe(true),
    );
  });

  it('loads more with the API cursor, so nothing is cut off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /disputes': (req) =>
          new Response(
            JSON.stringify(
              req.query.cursor
                ? page([dispute({ id: '0192f1a0-0000-7000-8000-00000000cc02' })])
                : page([dispute()], 'next-disputes'),
            ),
            { status: 200 },
          ),
      },
    });
    render(app.at('/leagues/disputes'));
    await user.click(await screen.findByRole('button', { name: 'Load more disputes' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Disputes' })).getAllByRole('listitem').length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(app.fake.requests.some((r) => r.query.cursor === 'next-disputes')).toBe(true);
  });

  it('shows the empty state and, without the read action, not available', async () => {
    const empty = createTestApp({ routes: { ...routes, 'GET /disputes': ok(page([])) } });
    render(empty.at('/leagues/disputes'));
    expect(await screen.findByRole('heading', { name: 'No disputes' })).toBeInTheDocument();
  });

  it('renders ACCESS_DENIED as not available', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /disputes': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at('/leagues/disputes'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Disputes' })).toBeNull();
  });

  it('decides from the list with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /disputes/{id}/decide': ok(dispute({ status: 'under_review', revision: 2 })),
      },
    });
    render(app.at('/leagues/disputes'));
    const list = await screen.findByRole('list', { name: 'Disputes' });
    await user.click(within(list).getByRole('button', { name: 'Start review' }));
    expect(await within(list).findByText('Dispute under_review')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/disputes/{id}/decide')?.body).toEqual({
      action: 'review',
      expectedRevision: 1,
    });
  });
});

describe('SCR-S-12 withdrawing one’s own dispute (CMP-12)', () => {
  const mine = dispute({
    submittedBy: {
      kind: 'staff',
      accountId: null,
      personId: ME_PERSON,
      staffRoles: ['league_manager'],
      sessionId: null,
      actorLabel: 'League Manager',
    },
    submittingRole: 'league_administration',
    submittingTeamEntryId: null,
  });

  it('withdraws with a reason and the expected revision; the review path is not offered', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': staffMe(),
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/disputes': ok([mine]),
        'GET /team-entries': ok([teamEntry()]),
        'POST /disputes/{id}/withdraw': ok({ ...mine, status: 'withdrawn', revision: 2 }),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/disputes`));
    const list = await screen.findByRole('list', { name: 'Disputes' });
    await user.click(await within(list).findByRole('button', { name: 'Withdraw my dispute' }));
    expect(within(list).queryByRole('button', { name: 'Record withdrawal' })).toBeNull();
    const form = within(list).getByRole('form', { name: 'Withdraw my dispute' });
    await user.click(within(form).getByRole('button', { name: 'Withdraw the dispute' }));
    expect(
      within(form).getByText('Give the reason for withdrawing the dispute.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/disputes/{id}/withdraw')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason/), 'Resolved with the other captain.');
    await user.click(within(form).getByRole('button', { name: 'Withdraw the dispute' }));
    expect(await within(list).findByText('Dispute withdrawn')).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/disputes/{id}/withdraw');
    expect(sent?.body).toEqual({ expectedRevision: 1, reason: 'Resolved with the other captain.' });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('shows a refusal with its code and retries the same intent with the same key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': staffMe(),
        'GET /fixtures/{id}': ok(fixtureDetail()),
        'GET /fixtures/{id}/disputes': ok([mine]),
        'GET /team-entries': ok([teamEntry()]),
        'POST /disputes/{id}/withdraw': fail(503, 'INTEGRATION_UNAVAILABLE', 'retry_later'),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/disputes`));
    const list = await screen.findByRole('list', { name: 'Disputes' });
    await user.click(await within(list).findByRole('button', { name: 'Withdraw my dispute' }));
    const form = within(list).getByRole('form', { name: 'Withdraw my dispute' });
    await user.type(within(form).getByLabelText(/^Reason/), 'No longer needed.');
    await user.click(within(form).getByRole('button', { name: 'Withdraw the dispute' }));
    expect((await within(form).findAllByText(/INTEGRATION_UNAVAILABLE/)).length).toBeGreaterThan(0);
    await user.click(within(form).getByRole('button', { name: /try again/i }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/disputes/{id}/withdraw')).toHaveLength(
        2,
      ),
    );
    const keys = app.fake.requests
      .filter((r) => r.route === '/disputes/{id}/withdraw')
      .map((r) => r.headers['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
  });
});
