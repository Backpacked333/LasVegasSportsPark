/**
 * SCR-S-04 Schedule draft editor: SPK-SCHED-005 (autosave with base revisions, author, last save,
 * validation results, no customer notices), SPK-SCHED-007 (series scope with the exact changed
 * events listed), SPK-SCHED-008 (facility-local entry), SPK-UX-008 (stale, offline, read-only,
 * not available), SPK-UX-009 (labelled controls, no drag needed).
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  INVENTORY,
  PITCH,
  draft,
  event,
  oneFacilityRoutes,
  page,
} from '../../../features/schedule-facilities/test-fixtures';
import { createTestApp } from '../../../testing/test-app';

const GAME = event({ id: 'e-game', title: 'U12 Red v Blue' });
const MOVE = {
  sequence: 1,
  kind: 'move' as const,
  targetEventId: 'e-game',
  baseEventRevision: 1,
  proposed: {
    scheduledStart: '2026-10-25T02:00:00.000Z',
    scheduledEnd: '2026-10-25T03:30:00.000Z',
  },
  resourceIds: [],
};
const DRAFT = draft({ id: 'd1', changes: [MOVE] });

/** Echoes an autosave like the API: revision + 1, changes renumbered, base revisions captured. */
function echoSave(request: FakeRequest) {
  const body = request.body as {
    expectedRevision: number;
    changes: Array<Record<string, unknown>>;
  };
  return fakeResponse(
    200,
    draft({
      id: 'd1',
      revision: body.expectedRevision + 1,
      lastSavedAt: '2026-10-24T12:01:00.000Z',
      changes: body.changes.map((c, i) => ({
        sequence: i + 1,
        kind: c.kind as 'create',
        targetEventId: (c.targetEventId as string | undefined) ?? null,
        baseEventRevision: c.targetEventId ? 1 : null,
        proposed: (c.proposed as object | undefined) ?? {},
        resourceIds: (c.resourceIds as string[] | undefined) ?? [],
      })),
    }),
  );
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /schedule-drafts/{id}': { status: 200, body: DRAFT },
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /events/{id}': { status: 200, body: GAME },
    'GET /events': page([GAME]),
    'PATCH /schedule-drafts/{id}': echoSave,
    ...overrides,
  };
}

const patches = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'PATCH' && r.route === '/schedule-drafts/{id}');

function setLocal(group: string, date: string, time: string) {
  const field = screen.getByRole('group', { name: `${group} (America/Los_Angeles)` });
  fireEvent.change(within(field).getByLabelText('Date'), { target: { value: date } });
  fireEvent.change(within(field).getByLabelText('Time'), { target: { value: time } });
}

describe('SCR-S-04 ScheduleDraftEditorScreen', () => {
  it('SPK-SCHED-005: shows base revisions, proposed changes, author, last save and publication status', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1'));
    const change = await screen.findByTestId('draft-change-1');
    expect(await within(change).findByText('1. Move: U12 Red v Blue')).toBeInTheDocument();
    expect(
      await within(change).findByText(
        /Was .*18:00 to 19:30 PDT on Pitch 1\. Now .*19:00 to 20:30 PDT on Pitch 1\./,
      ),
    ).toBeInTheDocument();
    expect(
      await within(change).findByText('Base revision 1; event now at revision 1'),
    ).toBeInTheDocument();
    expect(screen.getByText('Sam Scheduler')).toBeInTheDocument();
    expect(screen.getByText('editing: Draft (autosaved 05:00)')).toBeInTheDocument();
    expect(
      screen.getByText('Not published. Customers see nothing from this draft.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-050/)).toBeInTheDocument();
  });

  it('autosaves a new event entered in facility local time, with expectedRevision and an idempotency key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1'));
    await screen.findByTestId('draft-change-1');
    await user.type(screen.getByLabelText('Title'), 'Make-up game');
    await user.selectOptions(screen.getByLabelText('Kind'), 'game');
    const spaces = screen.getByRole('group', { name: 'Spaces' });
    await user.click(within(spaces).getByLabelText(/Pitch 1 North/));
    setLocal('Starts', '2026-10-24', '18:00');
    setLocal('Ends', '2026-10-24', '19:00');
    await user.click(screen.getByRole('button', { name: 'Add new event to draft' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    const [save] = patches(app);
    expect(save?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(save?.body).toEqual({
      expectedRevision: 3,
      name: 'Week 9 changes',
      changes: [
        { kind: 'move', targetEventId: 'e-game', proposed: MOVE.proposed },
        {
          kind: 'create',
          resourceIds: [HALF_A],
          proposed: {
            kind: 'game',
            title: 'Make-up game',
            scheduledStart: '2026-10-25T01:00:00.000Z',
            scheduledEnd: '2026-10-25T02:00:00.000Z',
          },
        },
      ],
    });
    expect(await screen.findByText(/All changes saved\. Last saved/)).toBeInTheDocument();
    expect(screen.getByTestId('draft-change-2')).toHaveTextContent('New game: Make-up game');
  });

  it('refuses a local time that does not exist and asks which one when it happens twice (SPK-SCHED-008)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1'));
    await screen.findByTestId('draft-change-1');
    setLocal('Starts', '2026-11-01', '01:30');
    expect(screen.getByRole('radiogroup', { name: 'Which 01:30' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('Second 01:30 (PST)'));
    const starts = screen.getByRole('group', { name: 'Starts (America/Los_Angeles)' });
    expect(within(starts).getByText(/01:30 PST/)).toBeInTheDocument();
    setLocal('Ends', '2026-03-08', '02:30');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '02:30 does not exist on this date in America/Los_Angeles',
    );
  });

  it('stale version: keeps the edits after STALE_REVISION and saves them on the latest revision when asked', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /schedule-drafts/{id}': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    await user.click(
      await screen.findByRole('button', { name: 'Remove change 1: Move: U12 Red v Blue' }),
    );
    expect(await screen.findByTestId('draft-stale')).toHaveTextContent(
      'Not saved: draft changed elsewhere',
    );
    expect(screen.getByRole('heading', { name: 'No changes yet' })).toBeInTheDocument();
    app.fake.set('GET /schedule-drafts/{id}', {
      status: 200,
      body: draft({ id: 'd1', revision: 5, changes: [MOVE] }),
    });
    app.fake.set('PATCH /schedule-drafts/{id}', echoSave);
    await user.click(screen.getByRole('button', { name: 'Save my edits on the latest version' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]?.body).toMatchObject({ expectedRevision: 5, changes: [] });
    expect(await screen.findByText(/All changes saved/)).toBeInTheDocument();
  });

  it('offline: edits are kept on the page and saved when the connection returns', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/drafts/d1'));
    await screen.findByTestId('draft-change-1');
    act(() => app.connectivity.set(false));
    await user.click(screen.getByRole('button', { name: 'Remove change 1: Move: U12 Red v Blue' }));
    expect(await screen.findByText('Not saved: offline')).toBeInTheDocument();
    expect(patches(app)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    act(() => app.connectivity.set(true));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]?.body).toMatchObject({ expectedRevision: 3, changes: [] });
  });

  it('SPK-UX-008: when the service cannot be reached while the device is online, autosave offers Try again with the same key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'PATCH /schedule-drafts/{id}': (request) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
          return echoSave(request);
        },
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    await user.click(
      await screen.findByRole('button', { name: 'Remove change 1: Move: U12 Red v Blue' }),
    );
    expect(await screen.findByText('Not saved: service not reachable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    const [first, second] = patches(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toEqual(first?.body);
    expect(await screen.findByText(/All changes saved/)).toBeInTheDocument();
  });

  it('validation failure: lists conflicts per change (SPK-SCHED-004)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/validate': {
          status: 200,
          body: draft({
            id: 'd1',
            revision: 4,
            status: 'editing',
            changes: [MOVE],
            validatedAt: '2026-10-24T12:00:00.000Z',
            validationResults: {
              ok: false,
              validatedAt: '2026-10-24T12:00:00.000Z',
              issues: [
                {
                  severity: 'error',
                  code: 'physical_overlap',
                  message: 'Pitch 1 is booked for 7v7 adult league at that time.',
                  changeSequence: 1,
                  eventId: 'e-game',
                  detail: {
                    code: 'physical_overlap',
                    message: 'overlap',
                    conflictingEventIds: ['e-small'],
                  },
                },
              ],
            },
          }),
        },
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    await user.click(await screen.findByRole('button', { name: 'Validate' }));
    const results = await screen.findByRole('list', { name: 'Validation results for change 1' });
    expect(results).toHaveTextContent('Error');
    expect(results).toHaveTextContent('Pitch 1 is booked for 7v7 adult league at that time.');
    expect(results).toHaveTextContent('conflicts with 1 event');
    expect(
      screen.getByText(/Failed: validated .* with 1 error and 0 warnings\./),
    ).toBeInTheDocument();
    const validate = app.fake.requests.find((r) => r.route === '/schedule-drafts/{id}/validate');
    expect(validate?.body).toEqual({ expectedRevision: 3 });
  });

  it('rebase required: an event changed since the draft captured it pauses autosave until the user rebases', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /events/{id}': { status: 200, body: { ...GAME, revision: 2 } } }),
    });
    render(app.at('/schedule/drafts/d1'));
    const change = await screen.findByTestId('draft-change-1');
    expect(await within(change).findByText('Rebase required')).toBeInTheDocument();
    expect(
      within(change).getByText('Base revision 1; event now at revision 2'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Draft name'), ' (v2)');
    await user.tab();
    expect(await screen.findByText('Not saved: rebase required')).toBeInTheDocument();
    expect(patches(app)).toHaveLength(0);
    await user.click(within(change).getByRole('button', { name: 'Rebase onto the current event' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]?.body).toMatchObject({ name: 'Week 9 changes (v2)' });
  });

  it('SPK-SCHED-005: a rebase acknowledges one event revision; a further change to the event pauses autosave again', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /events/{id}': { status: 200, body: { ...GAME, revision: 2 } } }),
    });
    render(app.at('/schedule/drafts/d1'));
    const change = await screen.findByTestId('draft-change-1');
    await user.click(
      await within(change).findByRole('button', { name: 'Rebase onto the current event' }),
    );
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(await screen.findByText(/All changes saved/)).toBeInTheDocument();
    // The target event changes again elsewhere.
    app.fake.set('GET /events/{id}', { status: 200, body: { ...GAME, revision: 3 } });
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/events/{id}'] });
    });
    expect(
      await within(screen.getByTestId('draft-change-1')).findByRole('button', {
        name: 'Rebase onto the current event',
      }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Draft name'), ' (v3)');
    await user.tab();
    expect(await screen.findByText('Not saved: rebase required')).toBeInTheDocument();
    expect(patches(app)).toHaveLength(1);
  });

  it('SPK-SCHED-007: a "this and future" change is previewed and adds exactly the listed events', async () => {
    const user = userEvent.setup();
    const series = event({
      id: 'e-s3',
      title: 'Thursday futsal',
      seriesId: 'series-1',
      occurrenceIndex: 2,
      resourceIds: [PITCH],
    });
    const later = { ...series, id: 'e-s4', occurrenceIndex: 3 };
    const details = (e: typeof series) => ({
      title: e.title,
      kind: e.kind,
      scheduledStart: e.scheduledStart,
      scheduledEnd: e.scheduledEnd,
      timezone: e.timezone,
      facilityId: e.facilityId,
      resources: [{ id: PITCH, name: 'Pitch 1' }],
      status: 'published' as const,
    });
    const app = createTestApp({
      routes: routes({
        'GET /events': page([GAME, series]),
        'POST /event-series/{id}/edits': {
          status: 200,
          body: {
            seriesId: 'series-1',
            scope: 'this_and_future',
            committed: false,
            affected: [
              {
                eventId: 'e-s3',
                occurrenceIndex: 2,
                before: details(series),
                after: null,
                dstResolution: 'exact',
              },
              {
                eventId: 'e-s4',
                occurrenceIndex: 3,
                before: details(later),
                after: null,
                dstResolution: 'exact',
              },
            ],
            unchangedEventIds: ['e-s1', 'e-s2'],
          },
        },
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    await screen.findByTestId('draft-change-1');
    await screen.findByRole('option', { name: /Thursday futsal/ });
    await user.selectOptions(screen.getByLabelText('Event'), 'e-s3');
    await user.click(screen.getByLabelText('Cancel it'));
    await user.click(screen.getByLabelText('This and future occurrences'));
    await user.click(screen.getByRole('button', { name: 'Preview affected events' }));
    const preview = await screen.findByTestId('series-preview');
    expect(
      within(preview).getByRole('heading', { name: '2 events would change' }),
    ).toBeInTheDocument();
    expect(within(preview).getByText(/Occurrence 3: .*canceled/)).toBeInTheDocument();
    expect(
      within(preview).getByText(
        /2 other occurrences \(including past, played or attended ones\) keep their details/,
      ),
    ).toBeInTheDocument();
    const edit = app.fake.requests.find((r) => r.route === '/event-series/{id}/edits');
    expect(edit?.params).toEqual({ id: 'series-1' });
    expect(edit?.body).toEqual({
      scope: 'this_and_future',
      occurrenceIndex: 2,
      preview: true,
      changes: { cancel: true },
    });
    expect(patches(app)).toHaveLength(0);
    await user.click(within(preview).getByRole('button', { name: 'Add 2 changes to the draft' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect((patches(app)[0]?.body as { changes: unknown[] }).changes).toEqual([
      { kind: 'move', targetEventId: 'e-game', proposed: MOVE.proposed },
      { kind: 'cancel', targetEventId: 'e-s3', proposed: {} },
      { kind: 'cancel', targetEventId: 'e-s4', proposed: {} },
    ]);
  });

  it('a series preview the viewer may not run names the missing permission', async () => {
    const user = userEvent.setup();
    const series = event({
      id: 'e-s3',
      title: 'Thursday futsal',
      seriesId: 'series-1',
      occurrenceIndex: 2,
    });
    const app = createTestApp({
      routes: routes({
        'GET /events': page([series]),
        'POST /event-series/{id}/edits': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              nextAction: 'contact_support_or_request_access',
              details: { action: 'scheduling.manage_events' },
            }),
          ),
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    await screen.findByRole('option', { name: /Thursday futsal/ });
    await user.selectOptions(screen.getByLabelText('Event'), 'e-s3');
    await user.click(screen.getByLabelText('Cancel it'));
    await user.click(screen.getByLabelText('The entire series'));
    await user.click(screen.getByRole('button', { name: 'Preview affected events' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/the permission scheduling\.manage_events/)).toBeInTheDocument();
  });

  it('a published draft is read-only', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /schedule-drafts/{id}': {
          status: 200,
          body: draft({
            id: 'd1',
            status: 'published',
            publishedAt: '2026-10-24T11:00:00.000Z',
            changes: [MOVE],
          }),
        },
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    expect(await screen.findByText('This draft is published')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add new event to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove change/ })).toBeNull();
  });

  it('a draft the viewer may not see is shown as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /schedule-drafts/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      }),
    });
    render(app.at('/schedule/drafts/d1'));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByText('Week 9 changes')).toBeNull();
  });
});
