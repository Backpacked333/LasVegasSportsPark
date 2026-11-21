/**
 * Staff S 2d "Coach workspace · take attendance by tapping" (INTERACTIONS 2d rows 1 to 5;
 * SPK-ENTRY-005, SPK-ENTRY-004, §4.7 invariant 9, §4.15, SPK-UX-007): the tiles cycle, a long press
 * marks absent, marks wait for their Undo then are sent (a correction once recorded), they queue
 * offline, a failure reverts, flags open their detail (care notes read on tap), and the counts
 * follow.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_QUEUE_STORAGE_KEY } from '../../../../features/operations/offline/queue';
import { createTestApp } from '../../../../testing/test-app';
import { HOLD_MS } from '../CoachNow';
import { CORRECTION_REASON } from '../useTileAttendance';
import { AVA, BEN, LEO, NOAH, coachRoutes } from './coach-fixtures';

const tile = (name: RegExp) => screen.findByRole('button', { name });
const counts = () => screen.getByRole('list', { name: 'Attendance so far' });
const dismissToast = async () => {
  const toast = await screen.findByTestId('toast');
  fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss message' }));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('S 2d coach attendance tiles', () => {
  it("SPK-UX-007: the workspace opens the coach's session now as tiles with the header counts", async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace'));
    expect(await screen.findByRole('heading', { name: 'Little Kickers' })).toBeInTheDocument();
    expect(screen.getByText('Now · 12 min in')).toBeInTheDocument();
    expect(await screen.findByText(/Court 1 · 4 registered/)).toBeInTheDocument();
    const c = counts();
    expect(within(c).getByText('Here').previousSibling).toHaveTextContent('1');
    expect(within(c).getByText('Late').previousSibling).toHaveTextContent('1');
    expect(within(c).getByText('Unmarked').previousSibling).toHaveTextContent('2');
    // State written on the tile, a late arrival with its time (facility zone).
    expect(await tile(/^Ava Kim, Here/)).toHaveTextContent('✓ Here');
    expect(await tile(/^Noah Brooks, Late 4:53/)).toHaveTextContent('◷ Late 4:53');
    expect(screen.getByRole('link', { name: /Pickup at 5:33/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/pickup'),
    );
  });

  it('SPK-ENTRY-005: a tap cycles Unmarked → Here → Late → Unmarked on the device, and Undo sends nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace'));
    await user.click(await tile(/^Ben Tran, Unmarked/));
    expect(await tile(/^Ben Tran, Here/)).toBeInTheDocument();
    expect(within(counts()).getByText('Here').previousSibling).toHaveTextContent('2');
    await user.click(await tile(/^Ben Tran, Here/));
    expect(await tile(/^Ben Tran, Late/)).toBeInTheDocument();
    await user.click(await tile(/^Ben Tran, Late/));
    expect(await tile(/^Ben Tran, Unmarked/)).toBeInTheDocument();
    await user.click(await tile(/^Ben Tran, Unmarked/));
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Ben T. · ✓ Here');
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await tile(/^Ben Tran, Unmarked/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(false);
  });

  it('SPK-ENTRY-005: the mark is sent when its Undo window closes, one observation with an idempotency key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'POST /attendance-observations': {
          status: 201,
          body: {
            observation: { id: 'obs-new', observedState: 'present' },
            duplicate: false,
            conflict: null,
          },
        },
      }),
    });
    render(app.at('/workspace'));
    await user.click(await tile(/^Ben Tran, Unmarked/));
    await dismissToast();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(true),
    );
    const sent = app.fake.requests.filter((r) => r.route === '/attendance-observations');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      personId: BEN,
      activity: { type: 'session', offeringId: expect.any(String), sessionId: expect.any(String) },
      observedState: 'present',
    });
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('a new toast for another child sends the first mark at once (one toast at a time)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'POST /attendance-observations': {
          status: 201,
          body: { observation: { id: 'x' }, duplicate: false, conflict: null },
        },
      }),
    });
    render(app.at('/workspace'));
    await user.click(await tile(/^Ben Tran, Unmarked/));
    await user.click(await tile(/^Leo Ortiz, Unmarked/));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/attendance-observations')).toHaveLength(
        1,
      ),
    );
    expect(
      (
        app.fake.requests.find((r) => r.route === '/attendance-observations')?.body as {
          personId: string;
        }
      ).personId,
    ).toBe(BEN);
  });

  it('§4.7 invariant 9: changing a recorded mark is a correction with a reason, never a second first mark', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'POST /attendance-observations/{id}/corrections': {
          status: 201,
          body: { observation: { id: 'obs-corr' } },
        },
      }),
    });
    render(app.at('/workspace'));
    // Ava is recorded here; a tap marks her late, a second tap back to here (never Unmarked).
    await user.click(await tile(/^Ava Kim, Here/));
    await user.click(await tile(/^Ava Kim, Late/));
    expect(await tile(/^Ava Kim, Here/)).toBeInTheDocument();
    await user.click(await tile(/^Ava Kim, Here/));
    await dismissToast();
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/attendance-observations/{id}/corrections'),
      ).toBe(true),
    );
    const correction = app.fake.requests.find(
      (r) => r.route === '/attendance-observations/{id}/corrections',
    );
    expect(correction?.body).toEqual({ observedState: 'late', reason: CORRECTION_REASON });
    expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(false);
  });

  it('INTERACTIONS 2d row 2: a 0.5 s press marks absent with a light vibration (A on the keyboard too)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const vibrate = vi.fn();
    Object.defineProperty(window.navigator, 'vibrate', { value: vibrate, configurable: true });
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace'));
    const leo = await tile(/^Leo Ortiz, Unmarked/);
    fireEvent.pointerDown(leo, { button: 0 });
    act(() => vi.advanceTimersByTime(HOLD_MS + 10));
    fireEvent.pointerUp(leo);
    fireEvent.click(leo);
    expect(await tile(/^Leo Ortiz, Absent/)).toBeInTheDocument();
    expect(vibrate).toHaveBeenCalledWith(15);
    expect(within(counts()).getByText('Absent').previousSibling).toHaveTextContent('1');
    // The click that ends the press does not also cycle the tile.
    expect(screen.queryByRole('button', { name: /^Leo Ortiz, Here/ })).toBeNull();
    const ben = await tile(/^Ben Tran, Unmarked/);
    fireEvent.keyDown(ben, { key: 'a' });
    expect(await tile(/^Ben Tran, Absent/)).toBeInTheDocument();
  });

  it('§4.15: offline, a first mark is queued on the device against the roster, nothing is sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace'));
    await tile(/^Ben Tran, Unmarked/);
    act(() => app.connectivity.set(false));
    await user.click(await tile(/^Ben Tran, Unmarked/));
    await dismissToast();
    expect(await tile(/^Ben Tran, Here, queued on this device/)).toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY) ?? '{}') as {
      pending?: Array<{ item: { personId: string; observedState: string; kind: string } }>;
    };
    expect(stored.pending?.[0]?.item).toMatchObject({
      kind: 'attendance',
      personId: BEN,
      observedState: 'present',
    });
    expect(app.fake.requests.some((r) => r.route === '/attendance-observations')).toBe(false);
    // A recorded mark cannot change offline (corrections need a connection).
    await user.click(await tile(/^Ava Kim, Here/));
    await dismissToast();
    expect(
      await screen.findByText(/changing a recorded mark needs a connection/),
    ).toBeInTheDocument();
  });

  it("a failed save reverts the tile and says what didn't save, with Try again", async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'POST /attendance-observations': () =>
          fakeResponse(409, {
            code: 'INVALID_TRANSITION',
            message: 'No',
            correlationId: 'c',
            nextAction: 'reload',
          }),
      }),
    });
    render(app.at('/workspace'));
    await user.click(await tile(/^Ben Tran, Unmarked/));
    await dismissToast();
    expect(await screen.findByText(/Ben T\.: Here didn't save/)).toBeInTheDocument();
    expect(await tile(/^Ben Tran, Unmarked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('INTERACTIONS 2d row 3: flags show on the tile; the allergy sheet reads the note on tap (audited by the API)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'GET /attendance/care-notes': {
          status: 200,
          body: {
            personId: NOAH,
            notes: [{ id: 'n1', kind: 'allergy', body: 'Tree nuts. Pen in the blue bag.' }],
            readAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at('/workspace'));
    const form = await screen.findByRole('button', { name: 'Form missing for Leo Ortiz: details' });
    // No care-note text is read until the flag is tapped.
    expect(app.fake.requests.some((r) => r.route === '/attendance/care-notes')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Allergy for Noah Brooks: details' }));
    const sheet = await screen.findByTestId('coach-flag-sheet');
    expect(await within(sheet).findByText('Tree nuts. Pen in the blue bag.')).toBeInTheDocument();
    expect(within(sheet).getByText(/recorded in the audit log/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/attendance/care-notes')?.query,
    ).toMatchObject({
      personId: NOAH,
    });
    await user.click(within(sheet).getByRole('button', { name: /close/i }));
    await user.click(form);
    expect(await screen.findByText(/Liability waiver/)).toBeInTheDocument();
  });

  it('"Show all" expands the grid past the first six children', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 8 }, (_, i) => ({
      personId: `0192f1a0-0000-7000-8000-0000000d00${10 + i}`,
      givenName: `Kid${i}`,
      familyName: 'Test',
      displayName: `Kid${i} Test`,
      effectiveState: null,
      status: 'recorded',
      currentObservationIds: [],
      history: [],
    }));
    const app = createTestApp({
      routes: coachRoutes({
        'GET /attendance': {
          status: 200,
          body: { activity: {}, people: many, expected: null },
        },
      }),
    });
    render(app.at('/workspace'));
    const grid = await screen.findByRole('list', { name: 'Children' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(within(grid).getAllByRole('listitem')).toHaveLength(8);
    void AVA;
    void LEO;
  });

  it('with no session on now, the workspace shows the assignment list', async () => {
    const app = createTestApp({
      routes: coachRoutes({
        'GET /me/assignments': {
          status: 200,
          body: { evaluatedAt: '2026-10-24T12:00:00.000Z', items: [] },
        },
      }),
    });
    render(app.at('/workspace'));
    expect(await screen.findByRole('heading', { name: 'My assignments' })).toBeInTheDocument();
  });
});
