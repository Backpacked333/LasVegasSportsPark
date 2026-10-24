/**
 * SCR-S-05 Publication review (SPK-SCHED-006, SPK-FIX-002, SPK-AT-008, §4.7 invariant 4,
 * `POST /v1/schedule-drafts/{id}/publish`), and the drafts list that leads to it (SCR-S-04 entry):
 * all-or-nothing failures reported as "nothing was published", partial publication with remaining
 * obligations, idempotent retry with the same key, permission and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY,
  draft,
  event,
  oneFacilityRoutes,
  page,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const GAME = event({ id: 'e-game', title: 'U12 Red v Blue' });
const DRAFT = draft({
  id: 'd1',
  revision: 6,
  status: 'validated',
  validatedAt: '2026-10-24T12:00:00.000Z',
  validationResults: {
    ok: true,
    validatedAt: '2026-10-24T12:00:00.000Z',
    issues: [
      {
        severity: 'warning',
        code: 'insufficient_rest',
        message: 'Red has 45 minutes between games.',
        changeSequence: 1,
      },
    ],
  },
  changes: [
    {
      sequence: 1,
      kind: 'move',
      targetEventId: 'e-game',
      baseEventRevision: 1,
      proposed: {
        scheduledStart: '2026-10-25T02:00:00.000Z',
        scheduledEnd: '2026-10-25T03:30:00.000Z',
      },
      resourceIds: [],
    },
  ],
});

const PUBLICATION = {
  id: 'pub-1',
  draftId: 'd1',
  facilityId: FACILITY_A,
  operationId: 'op-1',
  committedAt: '2026-10-24T12:05:00.000Z',
  eventIds: ['e-game'],
  noticeEventIds: ['n-1'],
  summary: {
    changes: [{ sequence: 1, kind: 'move', eventId: 'e-game' }],
    remainingObligations: [
      {
        code: 'unscheduled_games',
        message: '2 division games are not scheduled yet.',
        owner: 'league_manager',
        deadline: '2026-10-30T07:00:00.000Z',
      },
    ],
  },
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /schedule-drafts/{id}': { status: 200, body: DRAFT },
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /events/{id}': { status: 200, body: GAME },
    'POST /schedule-drafts/{id}/publish': { status: 200, body: PUBLICATION },
    'GET /operations/{id}': {
      status: 200,
      body: {
        id: 'op-1',
        kind: 'scheduling.publish_schedule',
        status: 'succeeded',
        correlationId: null,
        result: null,
        error: null,
        createdAt: '2026-10-24T12:05:00.000Z',
        updatedAt: '2026-10-24T12:05:00.000Z',
        completedAt: '2026-10-24T12:05:00.000Z',
      },
    },
    ...overrides,
  };
}

const publishes = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/schedule-drafts/{id}/publish');

describe('SCR-S-05 PublicationReviewScreen', () => {
  it('shows the preflight, exactly what changes and the notices that follow', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1/publish'));
    expect(await screen.findByText(/Passed .*: 0 errors, 1 warning\./)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Preflight results' })).toHaveTextContent(
      'Change 1: Red has 45 minutes between games.',
    );
    const changes = screen.getByRole('list', { name: 'Changes to publish' });
    expect(
      await within(changes).findByText(
        /Was .*18:00 to 19:30 PDT on Pitch 1\. Now .*19:00 to 20:30 PDT/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /one schedule notice per changed event \(1\) is queued with the old and new details/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-012, DEC-062/)).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Publication steps' }).querySelectorAll('li'),
    ).toHaveLength(7);
  });

  it('publishes with the expected revision and a key, then shows a partial publication with owner and deadline (SPK-FIX-002)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.type(
      await screen.findByLabelText('Note for the audit record (optional)'),
      'Weather move',
    );
    await user.click(screen.getByRole('button', { name: 'Publish 1 change' }));
    const result = await screen.findByTestId('publication-result');
    expect(publishes(app)[0]?.body).toEqual({ expectedRevision: 6, reason: 'Weather move' });
    expect(publishes(app)[0]?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(within(result).getByText('Published with remaining obligations')).toBeInTheDocument();
    expect(
      within(result).getByText(/1 event changed, 1 schedule notice queued/),
    ).toBeInTheDocument();
    const remaining = within(result).getByRole('list', { name: 'Remaining obligations' });
    expect(remaining).toHaveTextContent('2 division games are not scheduled yet.');
    expect(remaining).toHaveTextContent('Owner: league_manager');
    expect(remaining).toHaveTextContent(/Deadline: .*00:00 PDT/);
    expect(await within(result).findByText('Operation succeeded: Done')).toBeInTheDocument();
  });

  it('SPK-AT-008: a physical conflict publishes nothing and lists the conflicts', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': () =>
          fakeResponse(
            409,
            apiErrorBody('RESOURCE_CONFLICT', {
              nextAction: 'resolve_conflict',
              message: 'The draft conflicts with current records.',
              details: {
                issues: [
                  {
                    severity: 'error',
                    code: 'physical_overlap',
                    message: 'Pitch 1 North is already booked.',
                    changeSequence: 1,
                  },
                ],
                conflictingEventIds: ['e-other'],
              },
            }),
          ),
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    const failure = await screen.findByTestId('publish-failure');
    expect(
      within(failure).getByRole('heading', { name: 'Nothing was published' }),
    ).toBeInTheDocument();
    expect(within(failure).getByRole('list', { name: 'Conflicts' })).toHaveTextContent(
      'Change 1: Pitch 1 North is already booked.',
    );
    expect(failure).toHaveTextContent('1 existing event involved');
    expect(failure).toHaveTextContent('Error code: RESOURCE_CONFLICT');
    expect(screen.queryByTestId('publication-result')).toBeNull();
  });

  it('stale version: STALE_REVISION publishes nothing and offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    expect(
      await screen.findByRole('heading', { name: 'Nothing was published' }),
    ).toBeInTheDocument();
    const before = app.fake.requests.filter((r) => r.route === '/schedule-drafts/{id}').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/schedule-drafts/{id}').length,
      ).toBeGreaterThan(before),
    );
  });

  it('unmet blocking fixture obligations publish nothing and are listed', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              nextAction: 'correct_input',
              message: 'Fixture obligations are not satisfied.',
              details: {
                obligations: [
                  {
                    code: 'missing_fixtures',
                    message: 'Round 3 is missing 1 fixture.',
                    owner: 'league_manager',
                    deadline: null,
                    blocking: true,
                  },
                ],
              },
            }),
          ),
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    expect(
      await screen.findByRole('list', { name: 'Unmet fixture obligations' }),
    ).toHaveTextContent('Round 3 is missing 1 fixture. (missing_fixtures, owner league_manager)');
    expect(screen.getByRole('heading', { name: 'Nothing was published' })).toBeInTheDocument();
  });

  it('retrying after no answer sends the same idempotency key, so nothing publishes twice', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
          return fakeResponse(200, PUBLICATION, { 'Idempotent-Replayed': 'true' });
        },
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    expect(await screen.findByText('Error code: NETWORK_UNAVAILABLE')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('publication-result')).toBeInTheDocument();
    const [first, second] = publishes(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('permission restriction: ACCESS_DENIED is not available and names the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              nextAction: 'contact_support_or_request_access',
              details: { action: 'scheduling.publish_schedule' },
            }),
          ),
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/the permission scheduling\.publish_schedule/)).toBeInTheDocument();
  });

  it('offline: publishing is disabled and says it needs a connection', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1/publish'));
    await screen.findByRole('button', { name: 'Publish 1 change' });
    act(() => app.connectivity.set(false));
    expect(await screen.findByText('Publishing needs a connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish 1 change' })).toBeDisabled();
  });

  it('recovery required: an operation left recovery_required is shown as needing attention', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/publish': {
          status: 200,
          body: { ...PUBLICATION, summary: { ...PUBLICATION.summary, remainingObligations: [] } },
        },
        'GET /operations/{id}': {
          status: 200,
          body: {
            id: 'op-1',
            kind: 'scheduling.publish_schedule',
            status: 'recovery_required',
            correlationId: null,
            result: null,
            error: null,
            createdAt: '2026-10-24T12:05:00.000Z',
            updatedAt: '2026-10-24T12:05:00.000Z',
            completedAt: null,
          },
        },
      }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    await user.click(await screen.findByRole('button', { name: 'Publish 1 change' }));
    expect(
      await screen.findByText('Operation recovery_required: Needs attention'),
    ).toBeInTheDocument();
    expect(screen.getByText(/do not publish the same changes again/)).toBeInTheDocument();
  });
});

describe('SCR-S-04 drafts list', () => {
  it('lists drafts with status and author, and opens a new draft with a key per intent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...oneFacilityRoutes(),
        'GET /schedule-drafts': {
          status: 200,
          body: [DRAFT, draft({ id: 'd2', name: 'Old draft', status: 'failed' })],
        },
        'POST /schedule-drafts': {
          status: 201,
          body: draft({ id: 'd3', name: 'Halloween', revision: 1 }),
        },
        'GET /schedule-drafts/{id}': {
          status: 200,
          body: draft({ id: 'd3', name: 'Halloween', revision: 1 }),
        },
        'GET /resources': { status: 200, body: INVENTORY },
        'GET /events': page([]),
      },
    });
    render(app.at('/schedule/drafts'));
    const list = await screen.findByRole('list', { name: 'Schedule drafts' });
    expect(within(list).getByText('failed: Validation failed')).toBeInTheDocument();
    expect(within(list).getAllByText(/Author: Sam Scheduler/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Open draft' }));
    expect(screen.getByText('Enter a name for the draft.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Draft name'), 'Halloween');
    await user.click(screen.getByRole('button', { name: 'Open draft' }));
    expect(await screen.findByRole('heading', { name: 'Schedule draft' })).toBeInTheDocument();
    const create = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/schedule-drafts',
    );
    expect(create?.body).toEqual({ facilityId: FACILITY_A, name: 'Halloween' });
    expect(create?.headers['idempotency-key']).toMatch(/^key-/);
  });
});
