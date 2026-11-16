/**
 * The web preview build's storage stand-ins (`*.web.ts`): each keeps what its native module keeps,
 * under the same key, in the browser's storage, and each carries the marker that
 * scripts/check-release-bundle.mjs looks for in native bundles. Jest runs as iOS, so the files are
 * imported by their full names here; the app never imports them directly (Metro picks them on the
 * web only).
 */
import { secureProgressBackend } from '../../features/registration/progress-storage.web';
import { passSecureStorage } from '../../screens/pass/pass-secure-storage.web';
import { SESSION_STORAGE_KEY, SecureSessionStore } from '../../session/secure-session-store.web';
import { SecureThemeStore, THEME_STORAGE_KEY } from '../../ui/secure-theme-store.web';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const globals = globalThis as { localStorage?: unknown; sessionStorage?: unknown };
let local: MemoryStorage;
let session: MemoryStorage;

beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  globals.localStorage = local;
  globals.sessionStorage = session;
});

afterEach(() => {
  delete globals.localStorage;
  delete globals.sessionStorage;
});

describe('Browser preview storage (web build only)', () => {
  it('carries the marker the release-bundle check refuses in native bundles', () => {
    for (const kind of [
      new SecureThemeStore().kind,
      new SecureSessionStore().kind,
      passSecureStorage.kind,
      secureProgressBackend.kind,
    ]) {
      expect(kind).toBe('Browser preview storage');
    }
  });

  it('keeps the Legends mode choice in localStorage under the native key', () => {
    const store = new SecureThemeStore();
    expect(store.read()).toBeNull();
    store.write('legends');
    expect(local.getItem(THEME_STORAGE_KEY)).toBe('legends');
    expect(new SecureThemeStore().read()).toBe('legends');
    local.setItem(THEME_STORAGE_KEY, 'neon');
    expect(store.read()).toBeNull();
  });

  it('keeps the session in sessionStorage for the open tab only', async () => {
    const store = new SecureSessionStore();
    const value = { token: 't', expiresAt: null, accountId: 'acct-1' };
    expect(await store.load()).toBeNull();
    await store.save(value);
    expect(JSON.parse(session.getItem(SESSION_STORAGE_KEY) ?? 'null')).toEqual(value);
    expect(local.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(await new SecureSessionStore().load()).toEqual(value);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('keeps the pass and the registration progress in localStorage', async () => {
    await passSecureStorage.setItem('sportspark.pass.acct-1', '{"passId":"p"}');
    expect(await passSecureStorage.getItem('sportspark.pass.acct-1')).toBe('{"passId":"p"}');
    await passSecureStorage.removeItem('sportspark.pass.acct-1');
    expect(await passSecureStorage.getItem('sportspark.pass.acct-1')).toBeNull();

    expect(await secureProgressBackend.read()).toBeNull();
    await secureProgressBackend.write('{"accountId":"acct-1"}');
    expect(await secureProgressBackend.read()).toBe('{"accountId":"acct-1"}');
  });

  it('reads nothing, and never throws on a read, where the browser offers no storage', async () => {
    delete globals.localStorage;
    delete globals.sessionStorage;
    expect(new SecureThemeStore().read()).toBeNull();
    expect(() => new SecureThemeStore().write('legends')).not.toThrow();
    expect(await new SecureSessionStore().load()).toBeNull();
    expect(await passSecureStorage.getItem('k')).toBeNull();
    expect(await secureProgressBackend.read()).toBeNull();
  });
});
