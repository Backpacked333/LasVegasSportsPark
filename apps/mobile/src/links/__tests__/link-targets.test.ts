/**
 * SCR-C-39 safe deep-link destinations (§4.13, SPK-UX-001 "Verified links"): links are parsed
 * against a closed list, ids must be UUIDs, tokens have the contract's form, and every URL the
 * operating system hands the app is rewritten to Home or the link landing.
 */
import {
  clearLinkSecrets,
  forgetLinkSecret,
  holdLinkSecret,
  readLinkSecret,
} from '../link-secrets';
import { buildAppLink, resolveLinkParams, safeSystemPath } from '../link-targets';
import { redirectSystemPath } from '../native-intent';

const ID = '0192f1a0-0000-7000-8000-00000000c001';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';

describe('resolveLinkParams (§4.13 closed list of destinations)', () => {
  it('accepts each supported destination with well-formed parts', () => {
    expect(resolveLinkParams({ to: 'invitation', id: ID, token: TOKEN })).toEqual({
      kind: 'target',
      target: { to: 'invitation', id: ID, token: TOKEN },
    });
    expect(
      resolveLinkParams({ to: 'team-invitation', id: ID.toUpperCase(), token: TOKEN }),
    ).toEqual({ kind: 'target', target: { to: 'team-invitation', id: ID, token: TOKEN } });
    expect(resolveLinkParams({ to: 'claim', token: TOKEN })).toEqual({
      kind: 'target',
      target: { to: 'claim', token: TOKEN },
    });
    expect(resolveLinkParams({ to: 'operation', id: ID })).toEqual({
      kind: 'target',
      target: { to: 'operation', id: ID },
    });
    for (const to of ['inbox', 'account', 'family', 'preferences'] as const) {
      expect(resolveLinkParams({ to })).toEqual({ kind: 'target', target: { to } });
    }
  });

  it('treats a missing or badly formed part as a malformed link (validation failure)', () => {
    expect(resolveLinkParams({})).toEqual({ kind: 'malformed' });
    expect(resolveLinkParams({ to: 'invitation', id: 'not-a-uuid', token: TOKEN })).toEqual({
      kind: 'malformed',
    });
    expect(resolveLinkParams({ to: 'invitation', id: ID, token: 'short' })).toEqual({
      kind: 'malformed',
    });
    expect(resolveLinkParams({ to: 'claim', token: '<script>alert(1)</script>xxxxxxx' })).toEqual({
      kind: 'malformed',
    });
    expect(resolveLinkParams({ to: 'operation', id: [ID, ID] })).toEqual({ kind: 'malformed' });
  });

  it('refuses destinations outside the list, and ignores extra parameters', () => {
    expect(resolveLinkParams({ to: 'payments' })).toEqual({ kind: 'unsupported' });
    expect(resolveLinkParams({ to: 'https://evil.example' })).toEqual({ kind: 'unsupported' });
    expect(resolveLinkParams({ problem: 'unsupported' })).toEqual({ kind: 'unsupported' });
    expect(resolveLinkParams({ to: 'inbox', redirect: 'https://evil.example' })).toEqual({
      kind: 'target',
      target: { to: 'inbox' },
    });
  });
});

describe('safeSystemPath (+native-intent, §4.13)', () => {
  const prod = { development: false };

  it('sends app-scheme links to the link landing with their query', () => {
    expect(safeSystemPath('sportspark://link?to=inbox', prod)).toBe('/link?to=inbox');
    expect(safeSystemPath('sportspark:///link?to=family', prod)).toBe('/link?to=family');
    expect(safeSystemPath('https://app.example/link?to=preferences', prod)).toBe(
      '/link?to=preferences',
    );
  });

  it('opens Home for the bare scheme and refuses every other route from outside the app', () => {
    expect(safeSystemPath('sportspark://', prod)).toBe('/');
    expect(safeSystemPath('sportspark://sign-in', prod)).toBe('/link?problem=unsupported');
    expect(safeSystemPath('sportspark://payments/123', prod)).toBe('/link?problem=unsupported');
    expect(safeSystemPath('javascript://alert(1)', prod)).toBe('/link?problem=unsupported');
    expect(safeSystemPath('file:///etc/passwd', prod)).toBe('/link?problem=unsupported');
  });

  it('accepts development-server URLs only in development builds', () => {
    const url = 'exp://192.168.1.10:8081/--/link?to=inbox';
    expect(safeSystemPath(url, { development: true })).toBe('/link?to=inbox');
    expect(safeSystemPath('exp://192.168.1.10:8081', { development: true })).toBe('/');
    expect(safeSystemPath(url, prod)).toBe('/link?problem=unsupported');
  });

  it('leaves bare in-app paths to the router (its unknown-path screen is "Link not available")', () => {
    expect(safeSystemPath('/discover', prod)).toBe('/discover');
  });

  it('round-trips a shared invitation link to the landing without changing the token', () => {
    const link = buildAppLink({ to: 'invitation', id: ID, token: TOKEN });
    expect(link).toBe(`sportspark://link?to=invitation&id=${ID}&token=${TOKEN}`);
    const path = safeSystemPath(link, prod);
    const query = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
    expect(resolveLinkParams(query)).toEqual({
      kind: 'target',
      target: { to: 'invitation', id: ID, token: TOKEN },
    });
  });

  it('redirectSystemPath never throws on hostile input', () => {
    expect(() => redirectSystemPath({ path: '\u0000://￿', initial: true })).not.toThrow();
    expect(redirectSystemPath({ path: 'sportspark://link?to=inbox', initial: false })).toBe(
      '/link?to=inbox',
    );
  });
});

describe('link secrets (§4.14: tokens in memory only)', () => {
  afterEach(clearLinkSecrets);

  it('holds a token per invitation until it is used', () => {
    holdLinkSecret('invitation', TOKEN, ID);
    expect(readLinkSecret('invitation', ID)).toBe(TOKEN);
    expect(readLinkSecret('team-invitation', ID)).toBeNull();
    forgetLinkSecret('invitation', ID);
    expect(readLinkSecret('invitation', ID)).toBeNull();
  });
});
