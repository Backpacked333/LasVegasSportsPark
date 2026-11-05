/**
 * §4.13 secure session storage: the session secret goes to the platform secure store under one
 * key, readable only while the device is unlocked and never restored to another device.
 * Device-level lifecycle and recovery (reinstall, backup restore) needs physical devices (§6.2).
 */
import * as SecureStore from 'expo-secure-store';
import { SESSION_STORAGE_KEY, SecureSessionStore } from '../secure-session-store';

jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void values.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void values.delete(key)),
  };
});

describe('SecureSessionStore (§4.13)', () => {
  it('saves to and clears from the secure store with device-only accessibility', async () => {
    const store = new SecureSessionStore();
    expect(await store.load()).toBeNull();
    await store.save({ token: 't-1', expiresAt: '2026-10-24T20:00:00.000Z', accountId: 'a' });

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: 't-1', expiresAt: '2026-10-24T20:00:00.000Z', accountId: 'a' }),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(await new SecureSessionStore().load()).toEqual({
      token: 't-1',
      expiresAt: '2026-10-24T20:00:00.000Z',
      accountId: 'a',
    });

    await store.clear();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(SESSION_STORAGE_KEY, {
      keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    });
    expect(await store.load()).toBeNull();
    expect(await new SecureSessionStore().load()).toBeNull();
  });

  it('treats a corrupt stored value as signed out', async () => {
    await SecureStore.setItemAsync(SESSION_STORAGE_KEY, '{not json');
    expect(await new SecureSessionStore().load()).toBeNull();
  });
});
