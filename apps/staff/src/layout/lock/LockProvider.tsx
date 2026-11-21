/**
 * Shared desk tablet lock (redesign handoff S 3h, INTERACTIONS shell row 4; Proposed). On a device
 * marked "shared desk tablet" (a per-device setting in the user menu, which asks for a PIN the
 * first time), the dashboard locks after 10 minutes without a touch, a key or a scroll, or at once
 * with "Lock now". While locked:
 *
 * - the page underneath keeps its place (route, drawers, half-typed fields) but is inert, so
 *   unlocking returns exactly where the staff member was;
 * - the lock screen keeps check-ins moving (`LockScreen`): a pass that clears checks in by itself,
 *   anything else says "Please wait for staff";
 * - the 4-digit PIN unlocks; five wrong tries block the keypad for a minute; "Switch user" signs
 *   this session out so another staff member signs in.
 *
 * The lock state is kept in this browser's storage per account, so a reload stays locked. It is a
 * screen guard, not authentication: the API session and its guard are unchanged (see `pin.ts`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from '../../providers/AppProviders';
import {
  IDLE_LOCK_MS,
  SHARED_DEVICE_KEY,
  UNLOCKED,
  afterWrongPin,
  hashPin,
  readLockState,
  readPin,
  verifyPin,
  writeLockState,
  writePin,
  type LockState,
} from './pin';

export type UnlockResult = 'unlocked' | 'wrong' | 'blocked' | 'signed_out';

export interface LockApi {
  /** This device is a shared desk tablet that locks when idle. */
  sharedDevice: boolean;
  hasPin: boolean;
  state: LockState;
  /** Turn shared-device locking on with a new PIN, or off (which forgets the PIN). */
  enableSharedDevice(pin: string): Promise<void>;
  disableSharedDevice(): void;
  lockNow(): void;
  unlock(pin: string): Promise<UnlockResult>;
  /** Sign this session out from the lock screen (another staff member signs in). */
  switchUser(): Promise<void>;
}

const LockContext = createContext<LockApi | null>(null);

export function useLock(): LockApi | null {
  return useContext(LockContext);
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function LockProvider({ children }: { children: ReactNode }) {
  const { preferences, session, services, signOut } = useApp();
  const accountId = session.session?.accountId ?? null;
  const [sharedDevice, setSharedDevice] = useState(
    () => preferences.get(SHARED_DEVICE_KEY) === 'on',
  );
  const [hasPin, setHasPin] = useState(() =>
    accountId ? readPin(preferences, accountId) !== null : false,
  );
  const [state, setState] = useState<LockState>(() =>
    accountId ? readLockState(preferences, accountId) : UNLOCKED,
  );

  // A different account on this device: read its own PIN and lock state.
  useEffect(() => {
    setHasPin(accountId ? readPin(preferences, accountId) !== null : false);
    setState(accountId ? readLockState(preferences, accountId) : UNLOCKED);
  }, [accountId, preferences]);

  const save = useCallback(
    (next: LockState) => {
      setState(next);
      if (accountId) writeLockState(preferences, accountId, next);
    },
    [accountId, preferences],
  );

  const lockNow = useCallback(() => {
    if (!accountId || readPin(preferences, accountId) === null) return;
    const current = readLockState(preferences, accountId);
    if (current.locked) return;
    save({ ...current, locked: true, lockedAt: services.now().toISOString(), failures: 0 });
  }, [accountId, preferences, save, services]);

  // Idle timer: only on a shared device with a PIN, and only while unlocked.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!sharedDevice || !hasPin || state.locked) return;
    const restart = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(lockNow, IDLE_LOCK_MS);
    };
    restart();
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, restart, { passive: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, restart);
    };
  }, [sharedDevice, hasPin, state.locked, lockNow]);

  const enableSharedDevice = useCallback(
    async (pin: string) => {
      if (!accountId) return;
      writePin(preferences, accountId, await hashPin(pin));
      preferences.set(SHARED_DEVICE_KEY, 'on');
      setHasPin(true);
      setSharedDevice(true);
    },
    [accountId, preferences],
  );

  const disableSharedDevice = useCallback(() => {
    preferences.set(SHARED_DEVICE_KEY, null);
    if (accountId) writePin(preferences, accountId, null);
    setHasPin(false);
    setSharedDevice(false);
  }, [accountId, preferences]);

  const switchUser = useCallback(async () => {
    if (accountId) writeLockState(preferences, accountId, UNLOCKED);
    setState(UNLOCKED);
    await signOut();
  }, [accountId, preferences, signOut]);

  const unlock = useCallback(
    async (pin: string): Promise<UnlockResult> => {
      if (!accountId) return 'wrong';
      const stored = readPin(preferences, accountId);
      const current = readLockState(preferences, accountId);
      const now = services.now();
      if (current.blockedUntil && new Date(current.blockedUntil).getTime() > now.getTime()) {
        return 'blocked';
      }
      if (stored && (await verifyPin(pin, stored))) {
        save(UNLOCKED);
        return 'unlocked';
      }
      const next = afterWrongPin({ ...current, blockedUntil: null }, now);
      if (next.signOut) {
        await switchUser();
        return 'signed_out';
      }
      save(next.state);
      return next.state.blockedUntil ? 'blocked' : 'wrong';
    },
    [accountId, preferences, services, save, switchUser],
  );

  const value = useMemo<LockApi>(
    () => ({
      sharedDevice,
      hasPin,
      state,
      enableSharedDevice,
      disableSharedDevice,
      lockNow,
      unlock,
      switchUser,
    }),
    [
      sharedDevice,
      hasPin,
      state,
      enableSharedDevice,
      disableSharedDevice,
      lockNow,
      unlock,
      switchUser,
    ],
  );
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}
