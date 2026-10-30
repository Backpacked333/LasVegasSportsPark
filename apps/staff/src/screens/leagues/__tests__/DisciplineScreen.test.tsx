/**
 * SCR-S-12 Disputes and discipline (SPK-RESULT-005 disputes, SPK-DISC-001 restricted records,
 * SPK-DISC-002 suspension fields, SPK-DISC-003 approval and overturn, SPK-DISC-004 restricted
 * narratives, DEC-010 / DEC-063 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { fakeResponse } from '@sportspark/api-client/testing';
import { mePermissions } from '../../../testing/test-app';
import {
  ID,
  TEAM_ROUTES,
  appeal,
  competition,
  created,
  decision,
  fail,
  fixtureDetail,
  ok,
  page,
  personNames,
  personSearchResult,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';

const actor = (label: string) => ({
  kind: 'staff',
  accountId: null,
  personId: null,
  actorLabel: label,
});
const NARRATIVE = 'Player B was pushed after the whistle near the bench.';

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.incident,
    kind: 'misconduct',
    fixtureId: ID.fixture,
    seasonId: ID.season,
    competitionId: ID.competition,
    subjectPersonId: ID.person,
    teamEntryId: ID.entryRed,
    resultRevisionId: null,
    occurredAt: '2026-11-07T18:40:00.000Z',
    minute: 40,
    cardKind: null,
    severity: 'medium',
    summary: 'Misconduct after the final whistle',
    narrative: NARRATIVE,
    evidence: [{ kind: 'match_report', reference: 'report-17' }],
    reportedBy: actor('Referee R. One'),
    status: 'open',
    closedAt: null,
    closureNote: null,
    revision: 1,
    createdAt: '2026-11-07T19:00:00.000Z',
    updatedAt: '2026-11-07T19:00:00.000Z',
    ...overrides,
  };
}

function suspension(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.suspension,
    subjectPersonId: ID.person,
    decisionId: null,
    basis: 'Red card for violent conduct.',
    scope: 'competitions',
    competitionIds: [ID.competition],
    effectiveFrom: null,
    effectiveTo: null,
    matchCount: 2,
    matchesServed: 0,
    servedFixtureIds: [],
    completionCriteria: 'Serve two matches of this competition.',
    sourceKind: 'red_card',
    sourceFixtureId: ID.fixture,
    sourceResultRevisionId: ID.result1,
    status: 'proposed',
    approvedBy: null,
    approvedAt: null,
    appealStatus: 'none',
    overturnedAt: null,
    overturnReason: null,
    revision: 1,
    createdAt: '2026-11-08T09:00:00.000Z',
    updatedAt: '2026-11-08T09:00:00.000Z',
    ...overrides,
  };
}

const NAMES = personNames({ [ID.person]: ['Sam', 'Player'] });

const disciplineRoutes = {
  'GET /incidents': ok([incident()]),
  'GET /suspensions': ok([suspension()]),
  'GET /competitions': ok([competition()]),
  'GET /person-names': NAMES,
  'GET /disciplinary-decisions': ok(page([])),
  'GET /appeals': ok(page([])),
};

describe('SCR-S-12 DisciplineScreen (SPK-DISC-001 to SPK-DISC-004)', () => {
  it('lists incidents by their safe summary only, never the narrative', async () => {
    const app = createTestApp({ routes: disciplineRoutes });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Incidents' });
    expect(
      within(list).getByRole('link', {
        name: 'Misconduct report: Misconduct after the final whistle',
      }),
    ).toHaveAttribute('href', `/leagues/discipline/incidents/${ID.incident}`);
    expect(screen.queryByText(NARRATIVE)).toBeNull();
    expect(screen.getByText(/depends on DEC-010, DEC-063/)).toBeInTheDocument();
  });

  it('shows every SPK-DISC-002 suspension field and approves with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'PATCH /suspensions/{id}': ok(suspension({ status: 'active', revision: 2 })),
      },
    });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Suspensions' });
    expect(await within(list).findByText('Sam Player')).toBeInTheDocument();
    expect(within(list).getByText('Red card for violent conduct.')).toBeInTheDocument();
    expect(within(list).getByText('Only: Autumn League')).toBeInTheDocument();
    expect(within(list).getByText('0 of 2 matches served')).toBeInTheDocument();
    expect(within(list).getByText('Serve two matches of this competition.')).toBeInTheDocument();
    expect(within(list).getByText('Not approved')).toBeInTheDocument();
    expect(within(list).getByText('No appeal')).toBeInTheDocument();
    expect(within(list).getByText('Proposed by the rule set from a red card')).toBeInTheDocument();
    // No date of birth is shown for the subject.
    expect(screen.queryByText(/2016-05-04/)).toBeNull();
    await user.click(within(list).getByRole('button', { name: 'Approve' }));
    expect(await within(list).findByText('Suspension active')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      action: 'approve',
      expectedRevision: 1,
    });
  });

  it('overturns only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'PATCH /suspensions/{id}': ok(suspension({ status: 'overturned' })),
      },
    });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Suspensions' });
    await user.click(within(list).getByRole('button', { name: 'Overturn' }));
    const form = within(list).getByRole('form', { name: 'Overturn the suspension' });
    await user.click(within(form).getByRole('button', { name: 'Overturn the suspension' }));
    expect(within(form).getByText('Overturning needs a reason.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason for overturning/), 'Appeal granted.');
    await user.click(within(form).getByRole('button', { name: 'Overturn the suspension' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        action: 'overturn',
        expectedRevision: 1,
        reason: 'Appeal granted.',
      }),
    );
  });

  it('refuses a proposed suspension without scope or completion criteria (validation failure)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...disciplineRoutes, 'POST /suspensions': created(suspension()) },
    });
    render(app.at('/leagues/discipline'));
    await user.click(await screen.findByRole('button', { name: 'Propose a suspension' }));
    const form = screen.getByRole('form', { name: 'Propose a suspension' });
    await user.click(within(form).getByRole('button', { name: 'Propose the suspension' }));
    expect(
      within(form).getByText(
        'Choose the scope: a suspension is never assumed to apply everywhere.',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByText('State the completion criteria.')).toBeInTheDocument();
    expect(
      within(form).getByText('State an effective period or a match count.'),
    ).toBeInTheDocument();
    // Without identity.lookup_person the person is entered by reference (ID-02).
    await user.type(within(form).getByLabelText(/^Suspended person: person reference/), ID.person);
    expect(await within(form).findByText('Sam Player')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Basis/), 'Violent conduct.');
    await user.selectOptions(within(form).getByLabelText(/^Scope/), 'competitions');
    await user.click(within(form).getByLabelText('Autumn League'));
    await user.type(within(form).getByLabelText('Match count'), '2');
    await user.type(within(form).getByLabelText(/^Completion criteria/), 'Serve two matches.');
    await user.click(within(form).getByRole('button', { name: 'Propose the suspension' }));
    expect(
      await within(form).findByText('Suspension proposed: awaiting approval'),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      subjectPersonId: ID.person,
      basis: 'Violent conduct.',
      terms: {
        scope: 'competitions',
        competitionIds: [ID.competition],
        matchCount: 2,
        completionCriteria: 'Serve two matches.',
      },
    });
    // After success the form is cleared, so a second click cannot propose a duplicate (§4.9).
    expect(within(form).getByLabelText(/^Suspended person: person reference/)).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: 'Propose the suspension' }));
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('renders restricted lists as not available to a viewer without discipline authority', async () => {
    const app = createTestApp({
      routes: {
        'GET /incidents': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
        'GET /suspensions': fail(404, 'NOT_FOUND', 'verify_reference'),
        'GET /disciplinary-decisions': fail(
          403,
          'ACCESS_DENIED',
          'contact_support_or_request_access',
        ),
        'GET /appeals': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
        'GET /competitions': ok([]),
      },
    });
    render(app.at('/leagues/discipline'));
    await waitFor(() => expect(screen.getAllByText('Not available')).toHaveLength(4));
    expect(screen.queryByRole('list', { name: 'Disciplinary decisions' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Appeals' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Incidents' })).toBeNull();
  });
});

describe('SCR-S-12 suspension subject by person search (ID-02, SPK-IAM-002)', () => {
  it('finds the person by name and proposes with the chosen reference; results carry names only', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'GET /me/permissions': mePermissions({ actions: ['identity.lookup_person'] }),
        'GET /people': ok(page([personSearchResult(ID.person, 'Sam', 'Player')])),
        'POST /suspensions': created(suspension()),
      },
    });
    render(app.at('/leagues/discipline'));
    await user.click(await screen.findByRole('button', { name: 'Propose a suspension' }));
    const form = screen.getByRole('form', { name: 'Propose a suspension' });
    const search = await within(form).findByLabelText(/^Suspended person: find by name/);
    await user.type(search, 'S');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(within(form).getByText(/Enter 2 to 100 characters/)).toBeInTheDocument();
    await user.type(search, 'am');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await user.click(
      await within(form).findByRole('button', { name: 'Choose Sam Player as suspended person' }),
    );
    expect(within(form).getByTestId('chosen-person')).toHaveTextContent('Sam Player');
    const query = app.fake.requests.find((r) => r.route === '/people');
    expect(query?.query.query).toBe('Sam');
    await user.type(within(form).getByLabelText(/^Basis/), 'Violent conduct.');
    await user.selectOptions(within(form).getByLabelText(/^Scope/), 'all');
    await user.type(within(form).getByLabelText('Match count'), '1');
    await user.type(within(form).getByLabelText(/^Completion criteria/), 'Serve one match.');
    await user.click(within(form).getByRole('button', { name: 'Propose the suspension' }));
    await waitFor(() =>
      expect(
        (app.fake.requests.find((r) => r.method === 'POST')?.body as { subjectPersonId: string })
          .subjectPersonId,
      ).toBe(ID.person),
    );
  });

  it('says when no person matches, and a refused search reads as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'GET /me/permissions': mePermissions({ actions: ['identity.lookup_person'] }),
        'GET /people': ok(page([])),
      },
    });
    render(app.at('/leagues/discipline'));
    await user.click(await screen.findByRole('button', { name: 'Propose a suspension' }));
    const form = screen.getByRole('form', { name: 'Propose a suspension' });
    await user.type(await within(form).findByLabelText(/^Suspended person: find by name/), 'Zed');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(await within(form).findByRole('heading', { name: 'No person matches' })).toBeVisible();
    app.fake.set('GET /people', fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'));
    const search = within(form).getByLabelText(/^Suspended person: find by name/);
    await user.clear(search);
    await user.type(search, 'Zoe');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(await within(form).findByText('Not available')).toBeInTheDocument();
  });
});

describe('SCR-S-12 decisions and appeals lists (CMP-05, SPK-DISC-003, SPK-DISC-005)', () => {
  it('lists decisions with their facts and overturns one only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'GET /disciplinary-decisions': ok(page([decision()], 'next-decisions')),
        'POST /disciplinary-decisions/{id}/overturn': ok(
          decision({ status: 'overturned', revision: 2 }),
        ),
      },
    });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Disciplinary decisions' });
    expect(await within(list).findByText(/Sam Player/)).toBeInTheDocument();
    expect(within(list).getByText('Decision issued')).toBeInTheDocument();
    expect(within(list).getByText('Red card for serious foul play.')).toBeInTheDocument();
    // More decisions exist: nothing is silently cut off.
    expect(screen.getByRole('button', { name: 'Load more decisions' })).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Overturn the decision' }));
    const form = within(list).getByRole('form', { name: 'Overturn the decision' });
    await user.click(within(form).getByRole('button', { name: 'Overturn' }));
    expect(within(form).getByText('Overturning a decision needs a reason.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason for overturning/), 'Appeal granted.');
    await user.click(within(form).getByRole('button', { name: 'Overturn' }));
    expect(await within(list).findByText('Decision overturned')).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/disciplinary-decisions/{id}/overturn');
    expect(sent?.body).toEqual({ expectedRevision: 1, reason: 'Appeal granted.' });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('filters decisions by status and competition', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: disciplineRoutes });
    render(app.at('/leagues/discipline'));
    await user.selectOptions(await screen.findByLabelText('Decision status'), 'overturned');
    await user.selectOptions(screen.getByLabelText('Competition'), ID.competition);
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) =>
            r.route === '/disciplinary-decisions' &&
            r.query.status === 'overturned' &&
            r.query.competitionId === ID.competition,
        ),
      ).toBe(true),
    );
  });

  it('reviews and denies an appeal along its machine, a decision needing a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'GET /appeals': ok(page([appeal()])),
        'POST /appeals/{id}/decide': (req) =>
          fakeResponse(
            200,
            appeal({
              status:
                (req.body as { action: string }).action === 'review' ? 'under_review' : 'denied',
              revision: 2,
            }),
          ),
      },
    });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Appeals' });
    expect(within(list).getByText('Appeal submitted')).toBeInTheDocument();
    expect(within(list).getByText('Grounds: The foul was accidental.')).toBeInTheDocument();
    const actions = within(list).getByRole('group', { name: /Actions for appeal/ });
    for (const name of ['Start review', 'Grant', 'Deny', 'Record withdrawal']) {
      expect(within(actions).getByRole('button', { name })).toBeInTheDocument();
    }
    await user.click(within(actions).getByRole('button', { name: 'Deny' }));
    const form = within(list).getByRole('form', { name: 'Deny the appeal' });
    await user.click(within(form).getByRole('button', { name: 'Confirm: deny' }));
    expect(
      within(form).getByText('Granting or denying an appeal needs a reason.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/appeals/{id}/decide')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason/), 'The foul was deliberate.');
    await user.click(within(form).getByRole('button', { name: 'Confirm: deny' }));
    expect(await within(list).findByText('Appeal denied')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/appeals/{id}/decide')?.body).toEqual({
      action: 'deny',
      expectedRevision: 1,
      reason: 'The foul was deliberate.',
    });
  });

  it('reports a changed appeal (STALE_REVISION) with Reload, and shows the empty state', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...disciplineRoutes,
        'GET /appeals': ok(page([appeal()])),
        'POST /appeals/{id}/decide': fail(409, 'STALE_REVISION', 'reload_and_retry'),
      },
    });
    render(app.at('/leagues/discipline'));
    const list = await screen.findByRole('list', { name: 'Appeals' });
    await user.click(within(list).getByRole('button', { name: 'Start review' }));
    expect(await within(list).findByText('This record changed')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/appeals')).toHaveLength(2),
    );

    const empty = createTestApp({ routes: disciplineRoutes });
    render(empty.at('/leagues/discipline'));
    expect(await screen.findByRole('heading', { name: 'No appeals' })).toBeInTheDocument();
  });
});

describe('SCR-S-12 IncidentScreen (SPK-DISC-004, SPK-DISC-005)', () => {
  it('hides the narrative until the viewer chooses to show it, with the restriction stated', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /incidents/{id}': ok(incident()),
        'GET /person-names': NAMES,
      },
    });
    render(app.at(`/leagues/discipline/incidents/${ID.incident}`));
    expect(await screen.findByText('Misconduct after the final whistle')).toBeInTheDocument();
    expect(screen.queryByText(NARRATIVE)).toBeNull();
    expect(screen.getByText('Restricted narrative')).toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show the restricted narrative' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await user.click(show);
    expect(screen.getByTestId('incident-narrative')).toHaveTextContent(NARRATIVE);
    expect(screen.getByRole('button', { name: 'Hide the narrative' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('starts a review with the expected revision and reports STALE_REVISION with Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /incidents/{id}': ok(incident()),
        'GET /person-names': NAMES,
        'PATCH /incidents/{id}': fail(409, 'STALE_REVISION', 'reload_and_retry'),
      },
    });
    render(app.at(`/leagues/discipline/incidents/${ID.incident}`));
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('This record changed')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      action: 'review',
      expectedRevision: 1,
    });
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/incidents/{id}' && r.method === 'GET'),
      ).toHaveLength(2),
    );
  });

  it('never implies that a protected incident exists', async () => {
    const app = createTestApp({
      routes: { 'GET /incidents/{id}': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(app.at(`/leagues/discipline/incidents/${ID.incident}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText('Restricted narrative')).toBeNull();
  });
});

describe('SCR-S-12 FixtureDisputesScreen (SPK-RESULT-005)', () => {
  function dispute(overrides: Record<string, unknown> = {}) {
    return {
      id: ID.dispute,
      fixtureId: ID.fixture,
      resultRevisionId: ID.result1,
      submittingTeamEntryId: ID.entryBlue,
      submittingRole: 'captain',
      submittedBy: actor('Captain C. Blue'),
      submittedAt: '2026-11-08T10:00:00.000Z',
      submissionDeadlineAt: '2026-11-09T19:00:00.000Z',
      reason: 'An ineligible player took part.',
      evidence: [{ kind: 'photo', reference: 'evidence-3', description: 'Team sheet' }],
      status: 'submitted',
      reviewer: null,
      decision: null,
      decidedAt: null,
      decisionReason: null,
      publicationConsequence: null,
      appealStatus: 'none',
      revision: 1,
      createdAt: '2026-11-08T10:00:00.000Z',
      updatedAt: '2026-11-08T10:00:00.000Z',
      ...overrides,
    };
  }
  const routes = {
    ...TEAM_ROUTES,
    'GET /fixtures/{id}': ok(fixtureDetail()),
    'GET /fixtures/{id}/disputes': ok([dispute()]),
    'GET /team-entries': ok([teamEntry({ id: ID.entryBlue, teamId: ID.teamBlue })]),
  };

  it('shows every dispute fact and decides only with outcome, consequence and reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /disputes/{id}/decide': ok(
          dispute({
            status: 'decided',
            decision: 'upheld',
            publicationConsequence: 'correction_required',
          }),
        ),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/disputes`));
    const list = await screen.findByRole('list', { name: 'Disputes' });
    expect(within(list).getByText('Dispute submitted')).toBeInTheDocument();
    expect(within(list).getByText('Reason: An ineligible player took part.')).toBeInTheDocument();
    expect(within(list).getByText('Photo: evidence-3 (Team sheet)')).toBeInTheDocument();
    expect(await within(list).findByText('Blue')).toBeInTheDocument();
    expect(within(list).getByText('Not assigned yet')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Decide' }));
    const form = within(list).getByRole('form', { name: 'Decide the dispute' });
    await user.click(within(form).getByRole('button', { name: 'Record the decision' }));
    expect(within(form).getByText('Choose upheld or rejected.')).toBeInTheDocument();
    expect(within(form).getByText('Give the reason for the decision.')).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText(/^Decision/), 'upheld');
    await user.selectOptions(
      within(form).getByLabelText(/^Publication consequence/),
      'correction_required',
    );
    await user.type(within(form).getByLabelText(/^Reason/), 'Player was suspended.');
    await user.click(within(form).getByRole('button', { name: 'Record the decision' }));
    expect(await within(list).findByText('Dispute decided')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      action: 'decide',
      expectedRevision: 1,
      decision: 'upheld',
      publicationConsequence: 'correction_required',
      reason: 'Player was suspended.',
    });
  });

  it('starts a review, and shows the empty state for a fixture without disputes', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /disputes/{id}/decide': ok(dispute({ status: 'under_review' })),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/disputes`));
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
        action: 'review',
        expectedRevision: 1,
      }),
    );

    const empty = createTestApp({ routes: { ...routes, 'GET /fixtures/{id}/disputes': ok([]) } });
    render(empty.at(`/leagues/fixtures/${ID.fixture}/disputes`));
    expect(await screen.findByRole('heading', { name: 'No disputes' })).toBeInTheDocument();
  });
});
