/**
 * SCR-S-31 Offline queue and synchronisation review: SPK-AT-018 (observations synchronise once;
 * a retried batch keeps its client batch id and idempotency key; conflicts are kept for review),
 * §4.15 (identifier, actor, event, observed time and snapshot per item; items of another account
 * wait for that account).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_QUEUE_STORAGE_KEY,
  type OfflineQueueState,
} from '../../../features/operations/offline/queue';
import {
  CHILD_1,
  CHILD_2,
  OFFERING,
  SESSION_1,
  nameEntry,
  oneFacilityMe,
  personNames,
  syncBatch,
} from '../../../features/operations/testing';
import { FACILITY_A, TEST_SESSION, createTestApp, mePermissions } from '../../../testing/test-app';

const OBS_MINE = '0192f1a0-0000-7000-8000-0000000000c1';
const OBS_OTHER = '0192f1a0-0000-7000-8000-0000000000c2';

function seed() {
  const snapshot = { reference: 'roster-1', takenAt: '2026-10-24T11:30:00.000Z' };
  const state: OfflineQueueState = {
    deviceId: 'staff-web-device-1',
    pending: [
      {
        item: {
          kind: 'attendance',
          clientObservationId: OBS_MINE,
          observedAt: '2026-10-24T11:45:00.000Z',
          personId: CHILD_1,
          activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
          observedState: 'present',
        },
        facilityId: FACILITY_A,
        snapshot,
        queuedBy: TEST_SESSION.accountId as string,
        queuedAt: '2026-10-24T11:45:00.000Z',
        context: 'Attendance: Junior skills',
        batchId: null,
      },
      {
        item: {
          kind: 'arrival',
          clientObservationId: OBS_OTHER,
          observedAt: '2026-10-24T11:40:00.000Z',
          personId: CHILD_2,
          visitorCategory: 'participant',
        },
        facilityId: FACILITY_A,
        snapshot,
        queuedBy: '0192f1a0-0000-7000-8000-0000000000ff',
        queuedAt: '2026-10-24T11:40:00.000Z',
        context: 'Facility arrival',
        batchId: null,
      },
    ],
    review: [],
    lastSync: null,
  };
  window.localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(state));
}

const people = personNames([
  nameEntry(CHILD_1, 'Alex', 'Rivera'),
  nameEntry(CHILD_2, 'Blake', 'Rivera'),
]);
const BATCH_ID = '0192f1a0-0000-7000-8000-0000000000d1';

describe('SCR-S-31 OfflineQueueScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows each queued item with its fields and keeps another account’s items for that account', async () => {
    seed();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        // The synchronisation on opening stays in flight: the items stay queued while shown.
        'POST /offline-sync': () => new Promise<never>(() => undefined),
      },
    });
    render(app.at('/arrival/offline'));
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2); // header + my one item
    expect(within(rows[1] as HTMLElement).getByText('Attendance: Present')).toBeInTheDocument();
    expect(await within(rows[1] as HTMLElement).findByText('Alex Rivera')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Taken 30 minutes ago')).toBeInTheDocument();
    expect(screen.getByText(/1 observation queued by another account/)).toBeInTheDocument();
    expect(screen.getByText(/DEC-032/)).toBeInTheDocument();
  });

  it('SPK-AT-018: synchronises once and keeps a conflict for review', async () => {
    seed();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        'POST /offline-sync': {
          status: 201,
          body: syncBatch([
            {
              clientObservationId: OBS_MINE,
              kind: 'attendance',
              outcome: 'accepted_with_conflict',
              reason: 'conflicting_observation',
            },
          ]),
        },
      },
    });
    render(app.at('/arrival/offline'));
    // Opened online with an item queued: it synchronises once on its own (§4.15).
    const kept = await screen.findByRole('list', { name: 'Observations kept for review' });
    expect(within(kept).getByText('Recorded with a conflict: kept for review')).toBeInTheDocument();
    expect(screen.getByTestId('sync-summary')).toHaveTextContent('0 synchronised, 1 for review');
    const syncs = app.fake.requests.filter((r) => r.route === '/offline-sync');
    expect(syncs).toHaveLength(1);
    const body = syncs[0]?.body as { deviceId: string; items: { clientObservationId: string }[] };
    expect(body.deviceId).toBe('staff-web-device-1');
    // Only this account's item is sent; the other account's stays queued.
    expect(body.items.map((i) => i.clientObservationId)).toEqual([OBS_MINE]);
    expect(screen.getByText('Nothing queued')).toBeInTheDocument();
    expect(screen.getByText(/1 observation queued by another account/)).toBeInTheDocument();
  });

  it('retries a failed batch with the same client batch id and idempotency key', async () => {
    seed();
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        'POST /offline-sync': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(
                201,
                syncBatch([
                  { clientObservationId: OBS_MINE, kind: 'attendance', outcome: 'accepted' },
                ]),
              );
        },
      },
    });
    render(app.at('/arrival/offline'));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeInTheDocument();
    // Still queued, never presented as recorded.
    expect(screen.getByRole('table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByTestId('sync-summary')).toHaveTextContent('1 synchronised'),
    );
    const [first, second] = app.fake.requests.filter((r) => r.route === '/offline-sync');
    expect((second?.body as { clientBatchId: string }).clientBatchId).toBe(
      (first?.body as { clientBatchId: string }).clientBatchId,
    );
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('§4.15: a batch refused for an unapproved scope is kept for review with the API’s reason, never replayed for ever', async () => {
    seed();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        'POST /offline-sync': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', {
            message: 'You need entry.sync_offline.',
            nextAction: 'contact_support_or_request_access',
          }),
        },
      },
    });
    render(app.at('/arrival/offline'));
    const review = await screen.findByRole('list', { name: 'Observations kept for review' });
    expect(
      within(review).getByText(
        'Not recorded: the service refused the batch: You need entry.sync_offline.',
      ),
    ).toBeInTheDocument();
    expect(within(review).getByText(/Error code: ACCESS_DENIED/)).toBeInTheDocument();
    // It left the queue, so a later run does not replay the stored refusal.
    expect(screen.getByRole('heading', { name: 'Nothing queued' })).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/offline-sync')).toHaveLength(1);
  });

  it('§4.15: a batch refused because the device clock was ahead says the stored times are sent unchanged; queued again it goes under a new batch with the original times', async () => {
    const user = userEvent.setup();
    seed();
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        'POST /offline-sync': (request) => {
          calls += 1;
          if (calls === 1) {
            return fakeResponse(
              400,
              apiErrorBody('VALIDATION_FAILED', {
                message: 'The roster snapshot is dated in the future.',
                nextAction: 'correct_input',
                details: { code: 'snapshot_in_future' },
              }),
            );
          }
          const body = request.body as { items: { clientObservationId: string; kind: string }[] };
          return fakeResponse(
            201,
            syncBatch(body.items.map((i) => ({ ...i, outcome: 'accepted' }))),
          );
        },
      },
    });
    render(app.at('/arrival/offline'));
    const review = await screen.findByRole('list', { name: 'Observations kept for review' });
    const hint = within(review).getByTestId('snapshot-in-future-hint');
    // Never "correct the clock, then queue it again": the stored times do not change.
    expect(hint).toHaveTextContent('The stored times are sent unchanged');
    expect(hint).toHaveTextContent('correcting the clock now does not fix them');
    expect(hint).toHaveTextContent('discard it and record the observation again while online');
    expect(hint).not.toHaveTextContent(/Correct the clock, then queue it again/);
    expect(
      within(review).getByText(/VALIDATION_FAILED \(snapshot_in_future\)/),
    ).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: /^Queue again:/ }));
    await user.click(await screen.findByRole('button', { name: 'Synchronise 1 now' }));
    await waitFor(() => expect(calls).toBe(2));
    const [first, second] = app.fake.requests.filter((r) => r.route === '/offline-sync');
    expect((second?.body as { clientBatchId: string }).clientBatchId).not.toBe(
      (first?.body as { clientBatchId: string }).clientBatchId,
    );
    expect(second?.headers['idempotency-key']).not.toBe(first?.headers['idempotency-key']);
    // The times stored with the observation are sent again exactly as queued.
    type Sent = { snapshot: { takenAt: string }; items: { observedAt: string }[] };
    expect((second?.body as Sent).snapshot.takenAt).toBe('2026-10-24T11:30:00.000Z');
    expect((second?.body as Sent).items[0]?.observedAt).toBe('2026-10-24T11:45:00.000Z');
    expect((second?.body as Sent).snapshot).toEqual((first?.body as Sent).snapshot);
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeInTheDocument();
  });

  it('is empty when nothing is queued', async () => {
    const app = createTestApp({ routes: { 'GET /me': oneFacilityMe() } });
    render(app.at('/arrival/offline'));
    expect(await screen.findByText('Nothing queued')).toBeInTheDocument();
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
  });

  it('ENT-01 / §4.15: reads a synchronised batch again with its per-item outcomes', async () => {
    seed();
    const user = userEvent.setup();
    const stored = {
      ...syncBatch([
        {
          clientObservationId: OBS_MINE,
          kind: 'attendance',
          outcome: 'accepted_with_conflict',
          reason: 'conflicting_observation',
        },
      ]),
      stale: true,
      snapshotAgeSeconds: 9000,
      exceptionIds: ['0192f1a0-0000-7000-8000-0000000000e9'],
    };
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /person-names': people,
        'POST /offline-sync': { status: 201, body: stored },
        'GET /offline-sync/{id}': { status: 200, body: stored },
      },
    });
    render(app.at('/arrival/offline'));
    const batches = await screen.findByRole('list', { name: 'Synchronised batches' });
    const row = within(batches).getAllByRole('listitem')[0] as HTMLElement;
    expect(row).toHaveTextContent('1 item: 0 synchronised, 1 for review');
    await user.click(within(row).getByRole('button', { name: /Show outcomes of Batch/ }));
    const detail = await screen.findByRole('list', { name: 'Item outcomes' });
    expect(
      within(detail).getByText('Recorded with a conflict: kept for review'),
    ).toBeInTheDocument();
    expect(within(detail).getByText(/conflicting_observation/)).toBeInTheDocument();
    expect(screen.getByText('Older than the maximum roster age: flagged')).toBeInTheDocument();
    expect(screen.getByText(/1 follow-up is raised in the Today workspace/)).toBeInTheDocument();
    const read = app.fake.requests.find((r) => r.route === '/offline-sync/{id}');
    expect(read?.params.id).toBe(BATCH_ID);
    // The kept item links to the same stored outcome.
    expect(
      screen.getByRole('button', { name: 'Show the batch outcome: Attendance: Present' }),
    ).toBeInTheDocument();
  });

  it('SPK-SCHED-008: shows a batch’s receipt and roster snapshot times in its facility zone', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /offline-sync/{id}': {
          status: 200,
          body: syncBatch([
            {
              clientObservationId: '0192f1a0-0000-7000-8000-0000000000c9',
              kind: 'arrival',
              outcome: 'accepted',
            },
          ]),
        },
      },
    });
    render(app.at('/arrival/offline'));
    await user.type(await screen.findByLabelText('Batch reference'), BATCH_ID);
    await user.click(screen.getByRole('button', { name: 'Open batch' }));
    const batch = await screen.findByTestId('offline-batch');
    // FACILITY_A is America/Los_Angeles (Today feed): 12:00Z is 05:00 PDT on any device.
    await waitFor(() =>
      expect(within(batch).getByText(/Taken .*05:00 (PDT|GMT-7)/)).toBeInTheDocument(),
    );
    expect(within(batch).getAllByText(/05:00 (PDT|GMT-7)/)).toHaveLength(2);
  });

  it('opens a batch by reference after validating it, and shows a refused one as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /offline-sync/{id}': {
          status: 404,
          body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
        },
      },
    });
    render(app.at('/arrival/offline'));
    await user.type(await screen.findByLabelText('Batch reference'), 'not-a-reference');
    await user.click(screen.getByRole('button', { name: 'Open batch' }));
    expect(await screen.findByText('Enter the full batch reference.')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/offline-sync/{id}')).toHaveLength(0);
    await user.clear(screen.getByLabelText('Batch reference'));
    await user.type(screen.getByLabelText('Batch reference'), BATCH_ID);
    await user.click(screen.getByRole('button', { name: 'Open batch' }));
    const batch = await screen.findByTestId('offline-batch');
    await waitFor(() => expect(within(batch).getByTestId('state-unavailable')).toBeInTheDocument());
  });

  describe('ENT-06 batches received at this facility (GET /v1/offline-sync)', () => {
    const OTHER_BATCH = '0192f1a0-0000-7000-8000-0000000000d2';
    function summary(id: string, overrides: Record<string, unknown> = {}) {
      const {
        items: _items,
        replayed: _replayed,
        operationId: _op,
        ...rest
      } = syncBatch([
        {
          clientObservationId: OBS_MINE,
          kind: 'arrival',
          outcome: 'rejected',
          reason: 'person_not_found',
        },
      ]);
      return {
        ...rest,
        id,
        deviceId: 'tablet-1',
        needsReview: true,
        submittedBy: {
          kind: 'staff',
          accountId: null,
          personId: null,
          actorLabel: 'Desk Dana',
        },
        ...overrides,
      };
    }

    it('lists every device’s batches for a desk reader, filters to those for review, and opens one', async () => {
      const user = userEvent.setup();
      const app = createTestApp({
        routes: {
          'GET /me': oneFacilityMe(),
          'GET /me/permissions': mePermissions({
            actions: [{ id: 'entry.read_offline_batch', facilityIds: [FACILITY_A] }],
          }),
          'GET /offline-sync': (req) =>
            fakeResponse(200, {
              items:
                req.query['needsReview'] === 'true'
                  ? [summary(BATCH_ID)]
                  : [
                      summary(OTHER_BATCH, {
                        deviceId: 'tablet-2',
                        needsReview: false,
                        counts: {
                          items: 1,
                          accepted: 1,
                          acceptedWithConflict: 0,
                          duplicate: 0,
                          rejected: 0,
                          stale: 0,
                        },
                      }),
                      summary(BATCH_ID),
                    ],
              nextCursor: null,
            }),
          'GET /offline-sync/{id}': {
            status: 200,
            body: syncBatch([
              {
                clientObservationId: OBS_MINE,
                kind: 'arrival',
                outcome: 'rejected',
                reason: 'person_not_found',
              },
            ]),
          },
        },
      });
      render(app.at('/arrival/offline'));
      const list = await screen.findByRole('list', { name: 'Batches received at this facility' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAccessibleName(/from tablet-2/);
      expect(within(rows[1] as HTMLElement).getByText('For review')).toBeInTheDocument();
      expect(within(rows[1] as HTMLElement).getByText(/sent by Desk Dana/)).toBeInTheDocument();
      const reads = app.fake.requests.filter(
        (r) => r.route === '/offline-sync' && r.method === 'GET',
      );
      expect(reads[0]?.query).toMatchObject({ facilityId: FACILITY_A });

      await user.click(screen.getByLabelText('Only batches with something for review'));
      await waitFor(() =>
        expect(
          within(
            screen.getByRole('list', { name: 'Batches received at this facility' }),
          ).getAllByRole('listitem'),
        ).toHaveLength(1),
      );
      expect(
        app.fake.requests.filter((r) => r.route === '/offline-sync' && r.method === 'GET').at(-1)
          ?.query,
      ).toMatchObject({ facilityId: FACILITY_A, needsReview: 'true' });

      const row = within(
        screen.getByRole('list', { name: 'Batches received at this facility' }),
      ).getByRole('listitem');
      await user.click(within(row).getByRole('button', { name: /^Show outcomes of Batch/ }));
      const opened = await within(row).findByTestId('offline-batch');
      expect(await within(opened).findByText('Rejected')).toBeInTheDocument();
    });

    it('is not shown, and nothing is read, without entry.read_offline_batch at the facility', async () => {
      const app = createTestApp({ routes: { 'GET /me': oneFacilityMe() } });
      render(app.at('/arrival/offline'));
      expect(await screen.findByLabelText('Batch reference')).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Batches received at this facility' }),
      ).toBeNull();
      expect(app.fake.requests.some((r) => r.route === '/offline-sync' && r.method === 'GET')).toBe(
        false,
      );
    });
  });
});
