/**
 * The redesigned schedule's behaviour (handoff S 1b, S 3e, S 2b, S 5a; INTERACTIONS 1b rows 1 to 7,
 * 2b rows 1 to 5; SPK-SCHED-003, SPK-SCHED-005, SPK-SCHED-006, SPK-COMMS-005): booking from free
 * time, dragging a booking through a schedule draft with Notify or Undo, clashes refused, draft
 * blocks published or deleted, Day and Week keeping the date, the week's cells opening their day,
 * "Find a free slot" with Hold, and New booking from a held slot.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY,
  PITCH,
  ROOM,
  SCHEDULE_FACILITY_ACTIONS,
  draft,
  event,
  oneFacilityRoutes,
  page,
  scopedPermissions,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

/** Saturday 2026-10-24 in Los Angeles; the test clock is 05:00 PDT that morning. */
const GAME = event({
  id: 'e-game',
  title: 'Desert Foxes v Lions',
  resourceIds: [PITCH],
  // 10:00 to 11:00 PDT
  scheduledStart: '2026-10-24T17:00:00.000Z',
  scheduledEnd: '2026-10-24T18:00:00.000Z',
});
const RENTAL = event({
  id: 'e-rental',
  title: 'Garcia rental',
  kind: 'rental',
  resourceIds: [ROOM],
  // 12:00 to 13:30 PDT
  scheduledStart: '2026-10-24T19:00:00.000Z',
  scheduledEnd: '2026-10-24T20:30:00.000Z',
});

const MOVE_DRAFT = draft({
  id: 'd-move',
  name: 'Move: Desert Foxes v Lions',
  revision: 1,
  changes: [],
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /events': page([GAME, RENTAL]),
    'GET /sessions': page([]),
    'GET /closures': { status: 200, body: [] },
    'GET /schedule-drafts': { status: 200, body: [] },
    'GET /events/{id}/detail': {
      status: 200,
      body: {
        event: GAME,
        teams: [],
        staff: { identified: true, assignments: [] },
        committedPeople: [],
        attendees: { total: 14, byVia: { commitment: 14, enrollment: 0, booking: 0, roster: 0 } },
        fixtureId: null,
        messageAudience: { teamEntryIds: [], subjectPersonIds: [] },
      },
    },
    'POST /schedule-drafts': { status: 201, body: { ...MOVE_DRAFT, revision: 1 } },
    'POST /schedule-drafts/{id}/validate': {
      status: 200,
      body: {
        ...MOVE_DRAFT,
        status: 'validated',
        revision: 2,
        validationResults: { ok: true, validatedAt: '2026-10-24T12:00:00.000Z', issues: [] },
      },
    },
    'POST /schedule-drafts/{id}/publish': { status: 200, body: { id: 'pub-1' } },
    'POST /schedule-drafts/{id}/discard': {
      status: 200,
      body: { ...MOVE_DRAFT, status: 'discarded', revision: 3 },
    },
    ...overrides,
  };
}

/**
 * jsdom lays nothing out: each timeline track is given a box (rows 68 px apart, 1000 px wide from
 * x = 100) so a drag can be measured. The day window is 08:00 to 22:00 local (14 hours).
 */
const TRACK = { left: 100, width: 1400, top: 0, height: 68 };
const PX_PER_HOUR = TRACK.width / 14;
let restore: (() => void) | null = null;
beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains('tl-track')) {
      const tracks = [...document.querySelectorAll('.tl-track')];
      const i = tracks.indexOf(this);
      const top = TRACK.top + i * TRACK.height;
      return {
        x: TRACK.left,
        y: top,
        left: TRACK.left,
        top,
        width: TRACK.width,
        height: TRACK.height,
        right: TRACK.left + TRACK.width,
        bottom: top + TRACK.height,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  restore = () => {
    Element.prototype.getBoundingClientRect = original;
  };
});
afterEach(() => {
  restore?.();
  restore = null;
});

/** x of a local hour (8 = 08:00) on every track. */
const xAt = (hour: number) => TRACK.left + (hour - 8) * PX_PER_HOUR;
/** y in the middle of the n-th track. */
const yOf = (row: number) => TRACK.top + row * TRACK.height + 30;
function trackIndex(resourceId: string): number {
  const tracks = [...document.querySelectorAll('.tl-track')];
  return tracks.findIndex((t) => t.closest(`[data-testid="timeline-row-${resourceId}"]`));
}

function drag(block: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(block, { pointerId: 1, button: 0, pointerType: 'mouse', ...pt(from) });
  act(() => {
    window.dispatchEvent(pointer('pointermove', { x: from.x + 10, y: from.y }));
  });
  act(() => {
    window.dispatchEvent(pointer('pointermove', to));
  });
  act(() => {
    window.dispatchEvent(pointer('pointerup', to));
  });
}
const pt = (p: { x: number; y: number }) => ({ clientX: p.x, clientY: p.y });
function pointer(type: string, p: { x: number; y: number }) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}

async function gameBlock() {
  return screen.findByRole('button', { name: /^Desert Foxes v Lions, Game/ });
}

describe('S 3e drag a booking (INTERACTIONS 1b row 4, 1a row 4)', () => {
  it('SPK-SCHED-005: a drop writes and validates a one-change draft; Notify publishes it and tells people', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const block = await gameBlock();
    expect(block).toHaveAttribute('aria-roledescription', 'draggable booking');
    const row = trackIndex(PITCH);
    // Grab at 10:15, drop an hour later: 11:00 to 12:00 on the same pitch.
    drag(block, { x: xAt(10.25), y: yOf(row) }, { x: xAt(11.25), y: yOf(row) });
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/schedule-drafts/{id}/validate')).toBe(
        true,
      ),
    );
    const created = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/schedule-drafts',
    );
    expect(created?.body).toMatchObject({
      facilityId: FACILITY_A,
      name: 'Move: Desert Foxes v Lions',
      changes: [
        {
          kind: 'move',
          targetEventId: 'e-game',
          proposed: {
            scheduledStart: '2026-10-24T18:00:00.000Z',
            scheduledEnd: '2026-10-24T19:00:00.000Z',
          },
          resourceIds: [PITCH],
        },
      ],
    });
    expect(created?.headers['idempotency-key']).toBeTruthy();
    // Nobody is told yet: the toast waits for a choice and offers Notify.
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Not told yet');
    expect(within(toast).queryByRole('button', { name: 'Dismiss message' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/schedule-drafts/{id}/publish')).toBe(false);
    await user.click(await within(toast).findByRole('button', { name: 'Notify 14 people' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/schedule-drafts/{id}/publish')?.params,
      ).toEqual({ id: 'd-move' }),
    );
    expect(await screen.findByText('Moved. 14 people were told.')).toBeInTheDocument();
  });

  it('Undo discards the draft: nothing is published and nobody is told', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const block = await gameBlock();
    const row = trackIndex(PITCH);
    drag(block, { x: xAt(10.25), y: yOf(row) }, { x: xAt(12.25), y: yOf(row) });
    const toast = await screen.findByTestId('toast');
    await user.click(await within(toast).findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/schedule-drafts/{id}/discard')?.body,
      ).toMatchObject({ expectedRevision: 2 }),
    );
    expect(app.fake.requests.some((r) => r.route === '/schedule-drafts/{id}/publish')).toBe(false);
  });

  it('dropping on a clash snaps back and names what it hits; nothing is sent', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const block = await gameBlock();
    // To the party room at 12:15: the Garcia rental holds it from 12:00 to 13:30.
    drag(
      block,
      { x: xAt(10.25), y: yOf(trackIndex(PITCH)) },
      { x: xAt(12.5), y: yOf(trackIndex(ROOM)) },
    );
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'Not moved: it clashes with Garcia rental 12–1:30.',
    );
    expect(
      app.fake.requests.some((r) => r.route === '/schedule-drafts' && r.method === 'POST'),
    ).toBe(false);
  });

  it("the schedule's own validation refusing the move discards the draft and says why", async () => {
    const app = createTestApp({
      routes: routes({
        'POST /schedule-drafts/{id}/validate': {
          status: 200,
          body: {
            ...MOVE_DRAFT,
            revision: 2,
            validationResults: {
              ok: false,
              validatedAt: '2026-10-24T12:00:00.000Z',
              issues: [
                {
                  severity: 'error',
                  code: 'outside_operating_hours',
                  message: 'Outside the operating hours of Pitch 1.',
                },
              ],
            },
          },
        },
      }),
    });
    render(app.at('/schedule/calendar'));
    const block = await gameBlock();
    const row = trackIndex(PITCH);
    drag(block, { x: xAt(10.25), y: yOf(row) }, { x: xAt(13.25), y: yOf(row) });
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'Not moved: Outside the operating hours of Pitch 1.',
    );
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/schedule-drafts/{id}/discard')).toBe(true),
    );
  });

  it('a role that does not publish cannot drag, and the rail says why', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': scopedPermissions(
          SCHEDULE_FACILITY_ACTIONS.filter(
            (a) => a !== 'scheduling.manage_drafts' && a !== 'scheduling.publish_schedule',
          ),
        ),
      }),
    });
    render(app.at('/schedule/calendar'));
    const block = await gameBlock();
    await waitFor(() => expect(block).not.toHaveAttribute('aria-roledescription'));
    await user.click(block);
    const rail = screen.getByRole('complementary', { name: 'Selected on the timeline' });
    expect(rail).toHaveTextContent(
      'Moving a booking needs a scheduler or a manager who publishes the schedule.',
    );
  });
});

describe('S 1b day timeline', () => {
  it('INTERACTIONS 1b row 2: a free gap opens New booking with the space and the whole gap', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /bookings': page([]), 'GET /offerings': page([]) }),
    });
    render(app.at('/schedule/calendar'));
    const gap = await screen.findByRole('button', { name: 'Free 8–12 on Party room: book' });
    await user.click(gap);
    const drawer = await screen.findByTestId('new-booking');
    expect(drawer).toHaveTextContent('Sat 24 · 8–12 · Party room');
  });

  it('INTERACTIONS 1b row 6: a draft block is published or deleted from the rail', async () => {
    const user = userEvent.setup();
    const MAKEUP = draft({
      id: 'd-makeup',
      name: 'Make-up: Comets v Hawks',
      changes: [
        {
          sequence: 1,
          kind: 'create',
          targetEventId: null,
          baseEventRevision: null,
          proposed: {
            kind: 'game',
            title: 'Make-up',
            scheduledStart: '2026-10-24T20:00:00.000Z',
            scheduledEnd: '2026-10-24T21:00:00.000Z',
          },
          resourceIds: [PITCH],
        },
      ],
    });
    const app = createTestApp({
      routes: routes({ 'GET /schedule-drafts': { status: 200, body: [MAKEUP] } }),
    });
    render(app.at('/schedule/calendar'));
    expect(await screen.findByRole('button', { name: '◷ 1 draft' })).toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: /^Make-up, Game, .*Draft, not published/ }),
    );
    const rail = screen.getByRole('complementary', { name: 'Selected on the timeline' });
    await user.click(within(rail).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/schedule-drafts/{id}/publish')?.params,
      ).toEqual({ id: 'd-makeup' }),
    );
  });

  it('the draft and conflict chips filter the grid to those blocks', async () => {
    const user = userEvent.setup();
    const CLINIC = draft({
      id: 'd-clinic',
      name: 'Skills clinic',
      changes: [
        {
          sequence: 1,
          kind: 'create',
          targetEventId: null,
          baseEventRevision: null,
          proposed: {
            kind: 'session',
            title: 'Skills clinic',
            scheduledStart: '2026-10-24T18:30:00.000Z',
            scheduledEnd: '2026-10-24T19:30:00.000Z',
          },
          resourceIds: [ROOM],
        },
      ],
    });
    const app = createTestApp({
      routes: routes({ 'GET /schedule-drafts': { status: 200, body: [CLINIC] } }),
    });
    render(app.at('/schedule/calendar'));
    await user.click(await screen.findByRole('button', { name: '✕ 1 conflict' }));
    expect(await gameBlock()).toHaveAttribute('data-dim', 'true');
    expect(
      screen.getByRole('button', { name: /^Garcia rental, .*conflict: overlaps Skills clinic/ }),
    ).not.toHaveAttribute('data-dim');
  });

  it('INTERACTIONS 1b row 7: Day and Week keep the date; a week cell opens that day', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    await gameBlock();
    await user.click(screen.getByRole('button', { name: 'Next day' }));
    await user.click(screen.getByRole('radio', { name: 'Week' }));
    // Week of Monday 2026-10-19 (it holds Sunday the 25th).
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/events').at(-1)?.query.start).toBe(
        '2026-10-19T07:00:00.000Z',
      ),
    );
    const cell = await screen.findByRole('button', { name: /^Pitch 1, Sat 24, .*Open the day/ });
    expect(cell).toHaveAccessibleName(/1 booking/);
    await user.click(cell);
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/events').at(-1)?.query.start).toBe(
        '2026-10-24T07:00:00.000Z',
      ),
    );
    expect(await screen.findByRole('radio', { name: 'Day' })).toBeChecked();
  });
});

describe('S 2b Find a free slot and S 5a New booking', () => {
  const AVAILABILITY = {
    facilityId: FACILITY_A,
    window: { start: '2026-10-24T07:00:00.000Z', end: '2026-11-07T07:00:00.000Z' },
    durationMinutes: 90,
    stepMinutes: 30,
    resources: [
      {
        resourceId: INVENTORY[1]!.id,
        name: 'Pitch 1 North',
        kind: 'subdivision',
        parentResourceId: PITCH,
        // Sunday 25th, 09:00 PDT
        slots: [{ start: '2026-10-25T16:00:00.000Z', end: '2026-10-25T17:30:00.000Z' }],
      },
    ],
  };

  it('INTERACTIONS 2b rows 3 and 4: matches are listed; Hold opens New booking with the 15-minute screen hold', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /resource-availability': { status: 200, body: AVAILABILITY },
        'GET /bookings': page([]),
        'GET /offerings': page([]),
      }),
    });
    render(app.at('/schedule/calendar?view=week'));
    await user.click(await screen.findByRole('button', { name: 'Find a free slot' }));
    const panel = await screen.findByTestId('free-slot-panel');
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Space type' }), '7v7');
    expect(await within(panel).findByText('1 match, earliest first')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Prices and holds proposed · not in the API yet');
    await user.click(
      within(panel).getByRole('button', { name: /^Hold Pitch 1 North, Sun 25 · 9–10:30/ }),
    );
    const drawer = await screen.findByTestId('new-booking');
    expect(drawer).toHaveTextContent('Sun 25 · 9–10:30 · Pitch 1 North held for you');
    expect(drawer).toHaveTextContent('15:00');
    expect(drawer).toHaveTextContent('Proposed: kept on this screen only');
  });

  it('no match: says so and suggests an easier search', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /resource-availability': { status: 200, body: { ...AVAILABILITY, resources: [] } },
      }),
    });
    render(app.at('/schedule/calendar?view=week'));
    await user.click(await screen.findByRole('button', { name: 'Find a free slot' }));
    expect(
      await screen.findByText('No free 90-min 11v11 field slot. Try 60 min or weekdays.'),
    ).toBeInTheDocument();
  });

  it('the hold warns at 2:00 with Keep holding and is released at 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let now = Date.parse('2026-10-24T12:00:00.000Z');
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const app = createTestApp({
        now: () => new Date(now),
        routes: routes({
          'GET /resource-availability': { status: 200, body: AVAILABILITY },
          'GET /bookings': page([]),
          'GET /offerings': page([]),
        }),
      });
      render(app.at('/schedule/calendar?view=week'));
      await user.click(await screen.findByRole('button', { name: 'Find a free slot' }));
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Space type' }), '7v7');
      await user.click(await screen.findByRole('button', { name: /^Hold Pitch 1 North/ }));
      const drawer = await screen.findByTestId('new-booking');
      now += 13 * 60_000 + 5_000;
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(within(drawer).getByRole('button', { name: 'Keep holding' })).toBeInTheDocument();
      now += 2 * 60_000;
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(drawer).toHaveTextContent('was released');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S 5a: Enter picks the top customer; booking sends POST /bookings and shows the price the API quotes', async () => {
    const user = userEvent.setup();
    const OFFERING = {
      id: 'o-rent',
      name: 'Private 7v7 game',
      kind: 'rental',
      publicationState: 'published',
      bookingTermsPolicyVersionId: 'pv-1',
      facilityId: FACILITY_A,
      facility: { id: FACILITY_A, name: 'Facility A', timezone: 'America/Los_Angeles' },
    };
    const app = createTestApp({
      routes: routes({
        'GET /resource-availability': { status: 200, body: AVAILABILITY },
        'GET /bookings': page([]),
        'GET /offerings': page([OFFERING]),
        'GET /offerings/{id}/booking-availability': {
          status: 200,
          body: {
            offeringId: 'o-rent',
            timezone: 'America/Los_Angeles',
            durationMinutes: 60,
            resourceCount: 1,
            resources: [{ resourceId: INVENTORY[1]!.id, name: 'Pitch 1 North', freeIntervals: [] }],
          },
        },
        'GET /people': page([
          {
            id: 'p-luis',
            givenName: 'Luis',
            familyName: 'Garcia',
            kind: 'adult',
            status: 'active',
            matchedOn: 'name',
          },
        ]),
        'POST /bookings': {
          status: 201,
          body: {
            id: 'b-1',
            kind: 'rental',
            status: 'held',
            outstanding: ['payment'],
            basketId: 'basket-1',
          },
        },
        'POST /registration-quotes': {
          status: 201,
          body: {
            id: 'q-1',
            currency: 'USD',
            totalMinor: 18_000,
            lines: [{ id: 'l-1', description: 'Pitch 1 North · 90 min', baseAmountMinor: 18_000 }],
          },
        },
      }),
    });
    render(app.at('/schedule/calendar?view=week'));
    await user.click(await screen.findByRole('button', { name: 'Find a free slot' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Space type' }), '7v7');
    await user.click(await screen.findByRole('button', { name: /^Hold Pitch 1 North/ }));
    const drawer = await screen.findByTestId('new-booking');
    await user.type(within(drawer).getByLabelText('Customer'), 'gar');
    expect(await within(drawer).findByText('Luis Garcia')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(await within(drawer).findByRole('button', { name: 'Change' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(drawer).getByRole('combobox', { name: 'Use' })).toHaveValue('o-rent'),
    );
    await user.click(within(drawer).getByRole('button', { name: 'Book and take payment' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/bookings' && r.method === 'POST')?.body,
      ).toMatchObject({
        offeringId: 'o-rent',
        bookerPersonId: 'p-luis',
        start: '2026-10-25T16:00:00.000Z',
        end: '2026-10-25T17:30:00.000Z',
        resourceIds: [INVENTORY[1]!.id],
      }),
    );
    expect(await within(drawer).findByText(/Booked · pending payment/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Charge card · \$180\.00/ })).toHaveAttribute(
      'href',
      '/registrations/assisted/basket-1',
    );
    expect(within(drawer).getByRole('button', { name: /Text a pay link/ })).toBeDisabled();
  });
});
