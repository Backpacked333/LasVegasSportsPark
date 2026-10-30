/**
 * SCR-S-17 Roster management (SPK-COMP-005 effective dates and history, SPK-CAP-004 guests and
 * substitutes never bypass eligibility, SPK-AT-013 a suspended player added as a substitute is
 * refused with reasons, POL-032, DEC-066 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  ID,
  eligibilityReason,
  fail,
  ok,
  page,
  personNames,
  personSearchResult,
  ruleSet,
  season,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.member,
    teamEntryId: ID.entryRed,
    personId: ID.person,
    displayName: 'Alex Keeper',
    personKind: 'adult',
    status: 'active',
    statusBeforeRemoval: null,
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: null,
    jerseyNumber: 1,
    source: 'captain',
    removedAt: null,
    removalReason: null,
    eligibility: { status: 'eligible', blocking: 0, warnings: 0, codes: [] },
    ...overrides,
  };
}

const workspace = {
  entry: teamEntry({ status: 'approved' }),
  team: {
    id: ID.teamRed,
    name: 'Red',
    colors: {},
    createdByPersonId: null,
    status: 'active',
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  season: {
    id: ID.season,
    name: season().name,
    status: 'open',
    startsOn: '2026-11-01',
    endsOn: '2026-12-20',
  },
  division: { id: ID.division, name: 'Division A' },
  ruleSet: { id: ID.ruleSet, name: 'Indoor 6v6', version: 1 },
  roles: [],
  roster: [],
  readiness: {
    approval: 'approved',
    financialStatusRef: null,
    rosterCount: 1,
    rosterMin: 8,
    rosterMax: 14,
    rosterComplete: false,
    eligiblePlayers: 1,
    pendingInvitations: 0,
    pendingJoinRequests: 0,
    issues: [],
  },
  pendingInvitations: [],
  pendingJoinRequests: [],
  upcomingFixtures: [],
  viewer: {
    roles: [],
    actingAsCaptain: false,
    availableActions: ['competition.manage_roster', 'competition.handover_team_role'],
  },
};

const roster = (members: unknown[]) => ({
  teamEntryId: ID.entryRed,
  at: '2026-10-24T12:00:00.000Z',
  members,
});

const routes = {
  'GET /team-entries/{id}': ok(workspace),
  'GET /rule-sets/{id}': ok(ruleSet()),
  'GET /team-entries/{id}/roster': ok(
    roster([
      member(),
      member({
        id: '0192f1a0-0000-7000-8000-00000000d802',
        personId: ID.child,
        displayName: 'Jo Unknown',
        status: 'guest',
        jerseyNumber: null,
        eligibility: null,
      }),
    ]),
  ),
};

describe('SCR-S-17 RosterScreen (SPK-COMP-005, SPK-CAP-004)', () => {
  it('lists effective memberships with status, dates and an eligibility that is never assumed', async () => {
    const app = createTestApp({ routes });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    expect(await screen.findByRole('heading', { name: 'Roster: Red' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Roster' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('Alex Keeper (#1)')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Roster active')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Eligible')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Roster guest')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Eligibility unknown')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByText('Eligible')).toBeNull();
    expect(await screen.findByTestId('roster-policy')).toHaveTextContent(
      'guests allowed (at most 2 at once); substitutes allowed',
    );
    expect(screen.getByText(/depends on DEC-066/)).toBeInTheDocument();
  });

  it('reads the roster as of a past instant, with history, so a removed player stays on record', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await screen.findByRole('list', { name: 'Roster' });
    await user.type(screen.getByLabelText('Roster as of'), '2026-10-17T19:00');
    await user.click(screen.getByLabelText('Include pending and removed rows'));
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) =>
            r.route === '/team-entries/{id}/roster' &&
            r.method === 'GET' &&
            r.query.includeHistory === 'true' &&
            typeof r.query.at === 'string' &&
            r.query.at.startsWith('2026-10-1'),
        ),
      ).toBe(true),
    );
  });

  it('refuses an ineligible substitute and lists every reason with who resolves it (SPK-AT-013)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/roster': fail(
          422,
          'ELIGIBILITY_FAILED',
          'review_eligibility_reasons',
          {
            message: 'The player is not eligible for this roster.',
            details: {
              personId: ID.child,
              reasons: [
                eligibilityReason({
                  code: 'discipline.suspended',
                  message: 'An active suspension applies to this competition.',
                  responsibleRole: 'league_manager',
                  requiredAction: 'Wait until the suspension is served.',
                }),
              ],
            },
          },
        ),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.click(within(form).getByRole('button', { name: 'Add to the roster' }));
    expect(
      within(form).getByText('Find the player by name, or enter the reference from their record.'),
    ).toBeInTheDocument();
    // Without identity.lookup_person the player is entered by reference (ID-02).
    expect(within(form).getByText(/Person search is not available to your account/)).toBeVisible();
    await user.type(within(form).getByLabelText(/^Player: person reference/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Playing status/), 'substitute');
    await user.click(within(form).getByRole('button', { name: 'Add to the roster' }));
    expect(await within(form).findByText('Not eligible')).toBeInTheDocument();
    const reasons = within(form).getByRole('list', { name: 'Eligibility reasons' });
    expect(
      within(reasons).getByText('An active suspension applies to this competition.'),
    ).toBeInTheDocument();
    expect(within(reasons).getByText(/Resolved by: League manager/)).toBeInTheDocument();
    expect(within(form).getByText(/Error code: ELIGIBILITY_FAILED/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: workspace.entry.revision,
      changes: [{ action: 'add', personId: ID.child, status: 'substitute' }],
    });
    // The input is kept for the user to correct.
    expect(within(form).getByLabelText(/^Player: person reference/)).toHaveValue(ID.child);
  });

  it('adds a player and states the effective date', async () => {
    const user = userEvent.setup();
    const added = member({
      personId: ID.child,
      displayName: 'New Player',
      effectiveFrom: '2026-10-24T12:00:00.000Z',
    });
    const app = createTestApp({
      routes: { ...routes, 'POST /team-entries/{id}/roster': ok(roster([member(), added])) },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.type(within(form).getByLabelText(/^Player: person reference/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Playing status/), 'active');
    await user.type(within(form).getByLabelText('Jersey number'), '9');
    await user.click(within(form).getByRole('button', { name: 'Add to the roster' }));
    expect(await within(form).findByText(/New Player active, effective from/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.headers['idempotency-key']).toMatch(
      /^key-/,
    );
  });

  it('removes a player only with a reason and reloads after STALE_REVISION', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/roster': fail(409, 'STALE_REVISION', 'reload_and_retry'),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(
      await screen.findByRole('button', { name: 'Remove Alex Keeper from the roster' }),
    );
    const form = screen.getByRole('form', { name: 'Remove Alex Keeper' });
    await user.click(within(form).getByRole('button', { name: 'Remove from the roster' }));
    expect(within(form).getByText('Give the reason for the removal.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason/), 'Moved away.');
    await user.click(within(form).getByRole('button', { name: 'Remove from the roster' }));
    expect(await within(form).findByText('This record changed')).toBeInTheDocument();
    // SCR-S-17: the change carries the team entry revision, so a concurrent edit is refused.
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      expectedRevision: workspace.entry.revision,
      changes: [{ action: 'remove', personId: expect.any(String), reason: 'Moved away.' }],
    });
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter(
          (r) => r.route === '/team-entries/{id}/roster' && r.method === 'GET',
        ),
      ).toHaveLength(2),
    );
  });

  it('explains a player’s eligibility on request', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /team-entries/{id}/eligibility': ok({
          teamEntryId: ID.entryRed,
          personId: ID.person,
          at: '2026-10-24T12:00:00.000Z',
          membershipStatus: 'active',
          eligible: false,
          reasons: [
            eligibilityReason({ code: 'age.too_young', message: 'Below the division age band.' }),
          ],
          evaluatedAt: '2026-10-24T12:00:00.000Z',
        }),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(
      await screen.findByRole('button', { name: 'Explain eligibility of Alex Keeper' }),
    );
    expect(await screen.findByText('Below the division age band.')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/team-entries/{id}/eligibility')?.query,
    ).toEqual({ personId: ID.person, status: 'active' });
  });

  it('offers adding and removing players only when the workspace lists competition.manage_roster (CMP-02)', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /team-entries/{id}': ok({
          ...workspace,
          viewer: {
            roles: [],
            actingAsCaptain: false,
            availableActions: ['competition.manage_team'],
          },
        }),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    const list = await screen.findByRole('list', { name: 'Roster' });
    expect(await screen.findByTestId('roster-changes-unavailable')).toHaveTextContent(
      'Adding and removing players is not available to you on this entry now.',
    );
    expect(screen.queryByRole('button', { name: 'Add a player' })).toBeNull();
    expect(within(list).queryByRole('button', { name: /^Remove / })).toBeNull();
    // Reading and explaining stay available.
    expect(
      within(list).getByRole('button', { name: 'Explain eligibility of Alex Keeper' }),
    ).toBeVisible();
  });

  it('still shows ACCESS_DENIED from the roster command as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/roster': fail(
          403,
          'ACCESS_DENIED',
          'contact_support_or_request_access',
        ),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(
      await screen.findByRole('button', { name: 'Remove Alex Keeper from the roster' }),
    );
    const form = screen.getByRole('form', { name: 'Remove Alex Keeper' });
    await user.type(within(form).getByLabelText(/^Reason/), 'Moved away.');
    await user.click(within(form).getByRole('button', { name: 'Remove from the roster' }));
    expect(await within(form).findByText('Not available to you')).toBeInTheDocument();
  });

  it('shows a roster the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /team-entries/{id}': fail(404, 'NOT_FOUND', 'verify_reference'),
        'GET /team-entries/{id}/roster': fail(404, 'NOT_FOUND', 'verify_reference'),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a player' })).toBeDisabled();
  });
});

describe('SCR-S-17 adding a player found by person search (ID-02, SPK-IAM-002, §4.14)', () => {
  const searchRoutes = {
    ...routes,
    'GET /me/permissions': mePermissions({ actions: ['identity.lookup_person'] }),
    'GET /people': ok(page([personSearchResult(ID.child, 'Nia', 'Striker')], 'more-people')),
    'GET /person-names': personNames({ [ID.child]: ['Nia', 'Striker', 'adult'] }),
  };

  it('finds the player by name, confirms the choice by name and adds with that reference', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...searchRoutes,
        'POST /team-entries/{id}/roster': ok(
          roster([member({ personId: ID.child, displayName: 'Nia Striker' })]),
        ),
      },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.type(await within(form).findByLabelText(/^Player: find by name/), 'Nia');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    const results = await within(form).findByRole('list', { name: /People matching/ });
    // Names, kind and status only; never a date of birth or contact.
    expect(within(results).getByText('Nia Striker')).toBeInTheDocument();
    expect(form.textContent).not.toMatch(/@|\d{4}-\d{2}-\d{2}/);
    // More matches exist: nothing is silently cut off.
    expect(within(form).getByRole('button', { name: 'Load more people' })).toBeVisible();
    await user.click(within(results).getByRole('button', { name: 'Choose Nia Striker as player' }));
    expect(await within(form).findByTestId('chosen-person')).toHaveTextContent('Nia Striker');
    await user.selectOptions(within(form).getByLabelText(/^Playing status/), 'active');
    await user.click(within(form).getByRole('button', { name: 'Add to the roster' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
        expectedRevision: workspace.entry.revision,
        changes: [{ action: 'add', personId: ID.child, status: 'active' }],
      }),
    );
    // The search text never reaches the page address.
    expect(window.location.href).not.toContain('Nia');
  });

  it('searches when Enter is pressed in the search box, without submitting the add form (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: searchRoutes });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.type(await within(form).findByLabelText(/^Player: find by name/), 'Nia{Enter}');
    const results = await within(form).findByRole('list', { name: /People matching/ });
    expect(within(results).getByText('Nia Striker')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/people')?.query.query).toBe('Nia');
    // The enclosing form was not submitted: no validation messages, no roster command.
    expect(within(form).queryByText(/Find the player by name, or enter the reference/)).toBeNull();
    expect(within(form).queryByText('Choose active, guest or substitute.')).toBeNull();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('lets the player be changed after choosing, and entered by reference instead', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: searchRoutes });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.click(
      await within(form).findByRole('button', { name: 'Enter a reference instead' }),
    );
    await user.type(within(form).getByLabelText(/^Player: person reference/), ID.child);
    expect(await within(form).findByTestId('reference-preview')).toHaveTextContent('Nia Striker');
    await user.click(within(form).getByRole('button', { name: 'Find by name instead' }));
    expect(within(form).getByTestId('chosen-person')).toHaveTextContent('Nia Striker');
    await user.click(within(form).getByRole('button', { name: 'Change player' }));
    expect(within(form).getByLabelText(/^Player: find by name/)).toHaveValue('');
  });

  it('names a reference the viewer may not view as not available, never more', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes, 'GET /person-names': personNames({}) },
    });
    render(app.at(`/teams/entries/${ID.entryRed}/roster`));
    await user.click(await screen.findByRole('button', { name: 'Add a player' }));
    const form = screen.getByRole('form', { name: 'Add a player' });
    await user.type(within(form).getByLabelText(/^Player: person reference/), ID.child);
    expect(await within(form).findByTestId('reference-preview')).toHaveTextContent(
      'Person not available to you',
    );
  });
});
