/**
 * The Legends mode choice on the device (`SecureThemeStore`): one key in the installed key-value
 * store, tolerant of a store that cannot be read or written. The device module is replaced here
 * (the only way to exercise it off a device); everything else injects `MemoryThemeStore`.
 */
import * as SecureStore from 'expo-secure-store';
import { SecureThemeStore, THEME_STORAGE_KEY } from '../secure-theme-store';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const getItem = SecureStore.getItem as jest.Mock;
const setItem = SecureStore.setItem as jest.Mock;

describe('SecureThemeStore', () => {
  it('reads the stored theme name, and nothing for a value it does not know', () => {
    getItem.mockReturnValueOnce('legends');
    expect(new SecureThemeStore().read()).toBe('legends');
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, expect.any(Object));
    getItem.mockReturnValueOnce('sepia');
    expect(new SecureThemeStore().read()).toBeNull();
    getItem.mockReturnValueOnce(null);
    expect(new SecureThemeStore().read()).toBeNull();
  });

  it('writes the theme name under its key', () => {
    new SecureThemeStore().write('legends');
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'legends', expect.any(Object));
  });

  it('a store that fails leaves the classic theme and never throws', () => {
    getItem.mockImplementationOnce(() => {
      throw new Error('keychain unavailable');
    });
    expect(new SecureThemeStore().read()).toBeNull();
    setItem.mockImplementationOnce(() => {
      throw new Error('keychain unavailable');
    });
    expect(() => new SecureThemeStore().write('classic')).not.toThrow();
  });
});
