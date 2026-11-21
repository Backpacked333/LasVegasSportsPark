/**
 * Redesign handoff staff shell (INTERACTIONS "Shell" rows 1 to 4) and S 3h: G then T/S/R/A,
 * disabled while typing; rail badges fed from this device; the account menu; the shared desk
 * tablet lock (PIN, five wrong tries block for a minute, unlock returns to the same page, a reload
 * stays locked, Switch user signs out, check-ins keep working while locked); the phone tab bar.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACILITY_A, createTestApp, facilityDirectoryOf, staffMe } from '../../testing/test-app';
import { useRailBadge } from '../RailBadges';
import { RailBadgeProvider, useRailBadges } from '../RailBadges';
import { BLOCK_MS, IDLE_LOCK_MS, afterWrongPin, hashPin, verifyPin, UNLOCKED } from '../lock/pin';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('keyboard: G then T / S / R / A (shell row 2)', () => {
  it('goes to Today, Schedule, Registrations and Arrival; not while typing', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/finance'));
    await screen.findByRole('heading', { level: 2, name: 'Finance' });
    await user.keyboard('gs');
    expect(
      await screen.findByRole('link', { name: 'Schedule', current: 'page' }),
    ).toBeInTheDocument();
    await user.keyboard('ga');
    expect(
      await screen.findByRole('link', { name: 'Arrival and attendance', current: 'page' }),
    ).toBeInTheDocument();
    await user.keyboard('gt');
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    // In a field the letters are the field's.
    await user.click(screen.getByRole('button', { name: 'Jump to a screen or an action' }));
    const palette = await screen.findByRole('dialog');
    const search = within(palette).getByRole('combobox');
    await user.type(search, 'gr');
    expect(search).toHaveValue('gr');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: 'Today', current: 'page' })).toBeInTheDocument();
  });
});

describe('rail badges (shell row 1)', () => {
  it('a device count replaces the API count for its area and says what it counts', () => {
    function Feeder({ count }: { count: number }) {
      useRailBadge(
        'arrival',
        count > 0 ? { count, tone: 'warning', label: `${count} check-ins waiting to sync` } : null,
      );
      return null;
    }
    function Reader() {
      const badges = useRailBadges();
      const b = badges.get('arrival');
      return <p>{b ? `${b.count}: ${b.label}` : 'none'}</p>;
    }
    const { rerender } = render(
      <RailBadgeProvider>
        <Feeder count={2} />
        <Reader />
      </RailBadgeProvider>,
    );
    expect(screen.getByText('2: 2 check-ins waiting to sync')).toBeInTheDocument();
    rerender(
      <RailBadgeProvider>
        <Feeder count={0} />
        <Reader />
      </RailBadgeProvider>,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('pills carry the tone of the wait: red on Today', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/attention': {
          status: 200,
          body: {
            computedAt: '2026-10-24T12:00:00.000Z',
            cap: 99,
            areas: [{ area: 'today', count: 3, capped: false, counts: 'open issues' }],
          },
        },
      },
    });
    render(app.at('/finance'));
    expect(await screen.findByTestId('nav-count-today')).toHaveAttribute('data-tone', 'danger');
  });
});

describe('account menu (shell row 4)', () => {
  it('offers Profile, the tablet lock, Switch user and Sign out; Escape closes it', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/finance'));
    const button = await screen.findByRole('button', { name: /account menu/ });
    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: /Lock this tablet when idle/ }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitem', { name: 'Switch user' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});

describe('S 3h PIN rules (lock/pin.ts)', () => {
  it('keeps only a salted hash, checks it, and blocks at the fifth wrong try', async () => {
    const stored = await hashPin('2468');
    expect(JSON.stringify(stored)).not.toContain('2468');
    expect(await verifyPin('2468', stored)).toBe(true);
    expect(await verifyPin('1357', stored)).toBe(false);
    expect((await hashPin('2468')).salt).not.toBe(stored.salt);
    const now = new Date('2026-10-24T12:00:00Z');
    let state = { ...UNLOCKED, locked: true };
    for (let i = 0; i < 4; i += 1) state = afterWrongPin(state, now).state;
    expect(state.failures).toBe(4);
    const fifth = afterWrongPin(state, now);
    expect(fifth.state.blockedUntil).toBe(new Date(now.getTime() + BLOCK_MS).toISOString());
    expect(fifth.signOut).toBe(false);
    const third = afterWrongPin({ ...state, blocks: 2 }, now);
    expect(third.signOut).toBe(true);
  });
});

async function turnOnLock(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /account menu/ }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: /Lock this tablet/ }));
  const dialog = screen.getByRole('dialog', { name: 'Lock this tablet when idle' });
  await user.type(within(dialog).getByLabelText('Choose a 4-digit PIN'), '2468');
  await user.type(within(dialog).getByLabelText('Type it again'), '2468');
  await user.click(within(dialog).getByRole('button', { name: 'Turn on the lock' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Lock this tablet when idle' })).toBeNull(),
  );
}

async function lockNow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /account menu/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Lock now' }));
  return screen.findByTestId('lock-screen');
}

async function typePin(user: ReturnType<typeof userEvent.setup>, pin: string) {
  const keypad = within(screen.getByRole('group', { name: 'PIN keypad' }));
  for (const d of pin) await user.click(keypad.getByRole('button', { name: d }));
}

describe('S 3h shared desk tablet lock', () => {
  it('locks on demand, unlocks with the PIN back to the same page, and the PIN never leaves the device', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/finance'));
    await screen.findByRole('heading', { level: 2, name: 'Finance' });
    await turnOnLock(user);
    const lock = await lockNow(user);
    expect(within(lock).getByRole('heading', { name: 'Scan your pass' })).toBeInTheDocument();
    expect(document.querySelector('.shell')).toHaveAttribute('inert');
    await typePin(user, '2468');
    await waitFor(() => expect(screen.queryByTestId('lock-screen')).toBeNull());
    expect(screen.getByRole('heading', { level: 2, name: 'Finance' })).toBeInTheDocument();
    expect(app.fake.requests.some((r) => JSON.stringify(r.body ?? '').includes('2468'))).toBe(
      false,
    );
  });

  it('five wrong tries block the keypad for a minute; a reload stays locked', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    const { unmount } = render(app.at('/finance'));
    await turnOnLock(user);
    await lockNow(user);
    for (let i = 0; i < 4; i += 1) {
      await typePin(user, '1111');
      await screen.findByText(/Wrong PIN/);
    }
    await typePin(user, '1111');
    expect(await screen.findByText(/Too many wrong tries\. Try again in/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'PIN keypad' })).getByRole('button', { name: '2' }),
    ).toBeDisabled();
    unmount();
    // The same browser storage: still locked after a reload.
    render(app.at('/finance'));
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
  });

  it('Switch user signs this session out', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/finance'));
    await turnOnLock(user);
    await lockNow(user);
    await user.click(screen.getByRole('button', { name: 'Switch user' }));
    await waitFor(async () => expect(await app.sessionStore.load()).toBeNull());
    expect(screen.queryByTestId('lock-screen')).toBeNull();
  });

  it('locks after 10 minutes without a touch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const app = createTestApp();
    render(app.at('/finance'));
    await turnOnLock(user);
    await act(() => vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1_000));
    expect(screen.queryByTestId('lock-screen')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
  });

  it('while locked a cleared pass checks in by itself; anything else says "Please wait for staff"', async () => {
    const user = userEvent.setup();
    const scan = (checkin: unknown) => ({
      pass: { id: 'pass', holderKind: 'household' },
      facilityId: FACILITY_A,
      scannedAt: '2026-10-24T12:00:00.000Z',
      window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
      people: [
        {
          personId: 'kid',
          givenName: 'Maya',
          familyName: 'Ortiz',
          kind: 'child',
          relation: 'dependent',
          onSite: false,
          visitId: null,
          holderMayCollect: true,
          careNotes: [{ id: 'n', kind: 'allergy', body: 'Peanuts' }],
          activities: [
            {
              activity: {
                type: 'event',
                id: 'ev',
                offeringId: null,
                sessionId: null,
                eventId: 'ev',
              },
              title: 'Little Kickers',
              scheduledStart: '2026-10-24T12:15:00.000Z',
              scheduledEnd: '2026-10-24T13:15:00.000Z',
              basis: { kind: 'enrollment', id: 'en', status: 'confirmed' },
              checkin,
            },
          ],
        },
      ],
      recorded: 'nothing',
      nextAction: 'select',
    });
    let status = 'admitted';
    const app = createTestApp({
      routes: {
        'GET /me': staffMe([FACILITY_A]),
        'GET /facilities': facilityDirectoryOf([FACILITY_A]),
        'POST /passes/scan': () => fakeResponse(200, scan(null)),
        'POST /session-checkins': () => fakeResponse(201, { id: 'c', status, issues: [] }),
      },
    });
    render(app.at('/finance'));
    await turnOnLock(user);
    await lockNow(user);
    const input = screen.getByLabelText('Pass reference');
    await user.type(input, 'PASS-REFERENCE-0001{Enter}');
    expect(await screen.findByText(/Checked in: Maya/)).toBeInTheDocument();
    // No care note or family name is shown on the locked screen.
    expect(screen.queryByText(/Peanuts|Ortiz/)).toBeNull();
    const sent = app.fake.requests.find((r) => r.route === '/session-checkins');
    expect(sent?.body).toMatchObject({
      personId: 'kid',
      activity: { type: 'event', eventId: 'ev' },
    });
    status = 'held';
    await user.type(input, 'PASS-REFERENCE-0002{Enter}');
    expect(await screen.findByText('Please wait for staff')).toBeInTheDocument();
  });
});

describe('phone tab bar (S 1d)', () => {
  it('under 600 px the rail becomes a tab bar with Today, Scan, Schedule and Report', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 600px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    render(createTestApp().at('/today'));
    const tabs = within(await screen.findByRole('navigation', { name: 'Quick tabs' }));
    await waitFor(() =>
      expect(tabs.getAllByRole('link').map((a) => a.textContent)).toEqual([
        'Today',
        'Scan',
        'Schedule',
        'Report',
      ]),
    );
    expect(tabs.getByRole('link', { name: 'Scan' })).toHaveAttribute('href', '/arrival');
  });
});
