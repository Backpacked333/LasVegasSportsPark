/**
 * SCR-S-31 Offline queue and synchronisation review: SPK-AT-018 (observations synchronise once;
 * a retried batch keeps its client batch id and idempotency key; conflicts are kept for review),
 * §4.15 (identifier, actor, event, observed time and snapshot per item; items of another account
 * wait for that account).
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
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
  oneFacilityMe,
  person,
  syncBatch,
} from '../../../features/operations/testing';
import { FACILITY_A, TEST_SESSION, createTestApp } from '../../../testing/test-app';

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

const people = (req: FakeRequest) =>
  fakeResponse(
    200,
    person(req.params.id ?? '', req.params.id === CHILD_1 ? 'Alex' : 'Blake', 'Rivera').body,
  );

describe('SCR-S-31 OfflineQueueScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows each queued item with its fields and keeps another account’s items for that account', async () => {
    seed();
    const app = createTestApp({
      routes: { 'GET /me': oneFacilityMe(), 'GET /people/{id}': people },
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
        'GET /people/{id}': people,
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
        'GET /people/{id}': people,
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

  it('shows the API’s refusal for an unapproved scope as not available', async () => {
    seed();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /people/{id}': people,
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
    expect(await screen.findByTestId('command-unavailable')).toHaveTextContent(
      'entry.sync_offline',
    );
  });

  it('is empty when nothing is queued', async () => {
    const app = createTestApp({ routes: { 'GET /me': oneFacilityMe() } });
    render(app.at('/arrival/offline'));
    expect(await screen.findByText('Nothing queued')).toBeInTheDocument();
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
  });
});
