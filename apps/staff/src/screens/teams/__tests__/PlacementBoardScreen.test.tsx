/**
 * SCR-S-18 Placement board (SPK-PLACE-001 placement information, SPK-PLACE-002 explainable
 * candidates, staff-reviewed, SPK-PLACE-003 checked at commitment, a recommendation reserves
 * nothing, SPK-PLACE-005 no profiles, DEC-031 / DEC-051 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  TEAM_ROUTES,
  fail,
  ok,
  operation,
  page,
  person,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.placement,
    participantPersonId: ID.person,
    applicationId: null,
    enrollmentId: ID.enrollment,
    offeringId: null,
    seasonId: ID.season,
    status: 'unassigned',
    availability: [{ weekday: 2, from: '18:00', to: '21:00' }],
    preferredCompetitionId: null,
    preferredDivisionId: null,
    declaredLevel: 'Intermediate',
    positionPreferences: ['defender'],
    requestedTeammatePersonIds: [ID.child],
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
    revision: 2,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  };
}

const candidate = {
  teamEntryId: ID.entryRed,
  teamName: 'Red',
  divisionId: null,
  eligible: true,
  reasons: [
    {
      code: 'availability.match',
      severity: 'info',
      message: 'Plays on Tuesday evenings.',
      source: { type: 'team_entry', id: ID.entryRed },
    },
  ],
  capacity: { poolId: ID.poolCommercial, available: 3, capacity: 14 },
  requestedTeammatesOnRoster: 1,
  recommended: true,
};

const routes = {
  ...TEAM_ROUTES,
  'GET /team-entries': ok([teamEntry({ status: 'approved' })]),
  'GET /placement-requests': ok(page([request()])),
  'GET /people/{id}': ok(person(ID.person, 'Riley', 'Free')),
  'GET /placement-requests/{id}/candidates': ok([candidate]),
};

describe('SCR-S-18 PlacementBoardScreen (SPK-PLACE-001 to SPK-PLACE-003)', () => {
  it('lists unplaced entrants with the information they gave, by name only', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    const list = await screen.findByRole('list', { name: 'Placement requests' });
    expect(await within(list).findByText('Riley Free')).toBeInTheDocument();
    expect(within(list).getByText('Placement unassigned')).toBeInTheDocument();
    expect(within(list).getByText('Tuesday 18:00 to 21:00')).toBeInTheDocument();
    expect(within(list).getByText('Intermediate')).toBeInTheDocument();
    expect(screen.queryByText(/2016-05-04/)).toBeNull();
    // §4.14: the name read keeps only the name; no date of birth or contact reaches the cache.
    const cached = JSON.stringify(
      app.queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    expect(cached).not.toContain('2016-05-04');
    expect(cached).not.toContain('guardian@example.test');
    expect(app.fake.requests.find((r) => r.route === '/placement-requests')?.query).toMatchObject({
      seasonId: ID.season,
      status: 'unassigned',
    });
    expect(screen.getByText(/depends on DEC-031, DEC-051/)).toBeInTheDocument();
  });

  it('SPK-PLACE-001: pages through every placement request with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /placement-requests': (req: { query: Record<string, string> }) =>
          new Response(
            JSON.stringify(
              req.query.cursor === 'p-2'
                ? page([request({ id: ID.child, declaredLevel: 'Beginner' })])
                : page([request()], 'p-2'),
            ),
            { status: 200 },
          ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await screen.findByRole('list', { name: 'Placement requests' });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Beginner')).toBeInTheDocument();
    expect(
      app.fake.requests.some(
        (r) => r.route === '/placement-requests' && r.query['cursor'] === 'p-2',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
  });

  it('shows candidates with reasons and capacity, stating that a recommendation reserves nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await user.click(await screen.findByRole('button', { name: 'Show candidate teams' }));
    const candidates = await screen.findByRole('list', { name: 'Candidate teams' });
    expect(within(candidates).getByText('Eligible')).toBeInTheDocument();
    expect(within(candidates).getByText('Recommended')).toBeInTheDocument();
    expect(within(candidates).getByText(/3 of 14 roster places free/)).toBeInTheDocument();
    expect(within(candidates).getByText('Plays on Tuesday evenings.')).toBeInTheDocument();
    expect(screen.getByText(/A recommendation reserves nothing/)).toBeInTheDocument();
  });

  it('proposes a team with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /placement-requests/{id}/propose': ok(
          request({ status: 'proposed', proposedTeamEntryId: ID.entryRed }),
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await user.click(await screen.findByRole('button', { name: 'Show candidate teams' }));
    await user.click(await screen.findByRole('button', { name: 'Propose Red' }));
    expect(await screen.findByText('Placement proposed')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({ teamEntryId: ID.entryRed, expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('shows CAPACITY_UNAVAILABLE at commitment with its code and reloads the candidates', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /placement-requests/{id}/assign': fail(
          409,
          'CAPACITY_UNAVAILABLE',
          'join_waitlist_or_choose_alternative',
          {
            message: 'The roster is full.',
          },
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await user.click(await screen.findByRole('button', { name: 'Show candidate teams' }));
    await user.click(await screen.findByRole('button', { name: 'Assign to Red' }));
    expect(await screen.findByText('The roster is full.')).toBeInTheDocument();
    expect(screen.getByText(/Error code: CAPACITY_UNAVAILABLE/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'See alternatives' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/placement-requests/{id}/candidates'),
      ).toHaveLength(2),
    );
  });

  it('shows an assignment whose follow-up was not recorded as recovery required', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /operations/{id}': ok(operation('recovery_required')),
        'POST /placement-requests/{id}/assign': ok(
          request({
            status: 'assigned',
            assignedTeamEntryId: ID.entryRed,
            lastOperationId: ID.operation,
          }),
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await user.click(await screen.findByRole('button', { name: 'Show candidate teams' }));
    await user.click(await screen.findByRole('button', { name: 'Assign to Red' }));
    expect(await screen.findByText('Placement assigned')).toBeInTheDocument();
    expect(await screen.findByText('recovery_required')).toBeInTheDocument();
  });

  it('releases an assigned placement only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /placement-requests': ok(
          page([request({ status: 'assigned', assignedTeamEntryId: ID.entryRed })]),
        ),
        'GET /operations/{id}': ok(operation('succeeded')),
        'POST /placement-requests/{id}/release': ok(request({ status: 'released' })),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    await user.click(await screen.findByRole('button', { name: 'Release the placement' }));
    const form = screen.getByRole('form', { name: 'Release the placement' });
    await user.click(within(form).getByRole('button', { name: 'Release the placement' }));
    expect(within(form).getByText('Give a reason.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason/), 'Player withdrew.');
    await user.click(within(form).getByRole('button', { name: 'Release the placement' }));
    expect(await within(form).findByText('Placement released')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      reason: 'Player withdrew.',
      expectedRevision: 2,
    });
  });

  it('shows the empty and not-available states', async () => {
    const app = createTestApp({ routes: { ...routes, 'GET /placement-requests': ok(page([])) } });
    render(app.at(`/teams/seasons/${ID.season}/placement`));
    expect(
      await screen.findByRole('heading', { name: 'No unplaced entrants' }),
    ).toBeInTheDocument();

    const denied = createTestApp({
      routes: {
        ...routes,
        'GET /placement-requests': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(denied.at(`/teams/seasons/${ID.season}/placement`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
});
