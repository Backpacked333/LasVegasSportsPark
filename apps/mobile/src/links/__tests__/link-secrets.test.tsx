/**
 * Link secrets belong to the account signed in when the link arrived (§4.13 session expiry and
 * recovery, §4.14 protected secrets; R3-SECURITY-07): signing out or signing in as another account
 * drops them; an expired session keeps them, unoffered, for the same account to sign in again
 * (§6.2 "Expired session", NA-04); a link opened while signed out passes to the account that signs
 * in.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, renderHook, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { createTestApp, TEST_SESSION } from '../../testing/test-app';
import {
  clearLinkSecrets,
  forgetLinkSecret,
  holdLinkSecret,
  linkSecretsFollowSession,
  linkSecretsSessionExpired,
  readLinkSecret,
} from '../link-secrets';
import { useLinkSecret } from '../useLinkSecret';

const ID = '0192f1a0-0000-7000-8000-00000000c001';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';
const A = { accountId: '0192f1a0-0000-7000-8000-0000000000aa' };
const B = { accountId: '0192f1a0-0000-7000-8000-0000000000bb' };

afterEach(clearLinkSecrets);

describe('R3-SECURITY-07 link secrets follow the session (§4.13, §4.14)', () => {
  it('a link opened while nobody is signed in is kept for the account that signs in next', () => {
    linkSecretsFollowSession(null);
    holdLinkSecret('claim', TOKEN);
    expect(readLinkSecret('claim')).toBe(TOKEN);
    linkSecretsFollowSession(A);
    expect(readLinkSecret('claim')).toBe(TOKEN);
  });

  it('signing out drops every secret held for the account', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('claim', TOKEN);
    holdLinkSecret('invitation', TOKEN, ID);
    linkSecretsFollowSession(null);
    expect(readLinkSecret('claim')).toBeNull();
    expect(readLinkSecret('invitation', ID)).toBeNull();
    // Nothing comes back for the next account either.
    linkSecretsFollowSession(B);
    expect(readLinkSecret('claim')).toBeNull();
    expect(readLinkSecret('invitation', ID)).toBeNull();
  });

  it('signing in as another account drops the previous account’s secrets; the same account keeps them', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('team-invitation', TOKEN, ID);
    linkSecretsFollowSession(A);
    expect(readLinkSecret('team-invitation', ID)).toBe(TOKEN);
    linkSecretsFollowSession(B);
    expect(readLinkSecret('team-invitation', ID)).toBeNull();
    linkSecretsFollowSession(A);
    expect(readLinkSecret('team-invitation', ID)).toBeNull();
  });

  it('a session that does not name its account never inherits what another session held (fail closed)', () => {
    linkSecretsFollowSession({ accountId: null });
    holdLinkSecret('claim', TOKEN);
    expect(readLinkSecret('claim')).toBe(TOKEN);
    linkSecretsFollowSession({ accountId: null });
    expect(readLinkSecret('claim')).toBeNull();
  });

  it('useLinkSecret keeps what it read, and reads again when the session changes hands', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('claim', TOKEN);
    const { result } = renderHook(() => useLinkSecret('claim'));
    expect(result.current).toBe(TOKEN);
    // Forgotten after the API answered: the screen keeps showing the outcome it read.
    act(() => forgetLinkSecret('claim'));
    expect(result.current).toBe(TOKEN);
    act(() => linkSecretsFollowSession(null));
    expect(result.current).toBeNull();
    act(() => linkSecretsFollowSession(B));
    expect(result.current).toBeNull();
  });

  it('NA-04 expired session, same account signs in again: the invitation token is offered again; another account signs in: it is not', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('invitation', TOKEN, ID);
    holdLinkSecret('claim', TOKEN);
    linkSecretsSessionExpired();
    // Nobody is signed in: nothing is offered.
    expect(readLinkSecret('invitation', ID)).toBeNull();
    expect(readLinkSecret('claim')).toBeNull();
    linkSecretsFollowSession(A);
    expect(readLinkSecret('invitation', ID)).toBe(TOKEN);
    expect(readLinkSecret('claim')).toBe(TOKEN);

    linkSecretsSessionExpired();
    linkSecretsFollowSession(B);
    expect(readLinkSecret('invitation', ID)).toBeNull();
    expect(readLinkSecret('claim')).toBeNull();
    // Dropped, not hidden: A signing in afterwards gets nothing either.
    linkSecretsFollowSession(A);
    expect(readLinkSecret('invitation', ID)).toBeNull();
  });

  it('§4.13: a secret kept through an expiry is dropped by a session that does not name its account, and by a sign-out', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('claim', TOKEN);
    linkSecretsSessionExpired();
    linkSecretsFollowSession({ accountId: null });
    linkSecretsFollowSession(A);
    expect(readLinkSecret('claim')).toBeNull();

    holdLinkSecret('claim', TOKEN);
    linkSecretsSessionExpired();
    linkSecretsFollowSession(null);
    linkSecretsFollowSession(A);
    expect(readLinkSecret('claim')).toBeNull();
  });

  it('§4.13: an unnamed session’s secrets are dropped when it expires; a link opened after the expiry goes to whoever signs in', () => {
    linkSecretsFollowSession({ accountId: null });
    holdLinkSecret('claim', TOKEN);
    linkSecretsSessionExpired();
    linkSecretsFollowSession(A);
    expect(readLinkSecret('claim')).toBeNull();

    linkSecretsSessionExpired();
    // A second rejection while signed out keeps what was opened since.
    holdLinkSecret('invitation', TOKEN, ID);
    linkSecretsSessionExpired();
    linkSecretsFollowSession(B);
    expect(readLinkSecret('invitation', ID)).toBe(TOKEN);
  });

  it('NA-04 useLinkSecret offers nothing while the session is expired and the token again once the same account is back', () => {
    linkSecretsFollowSession(A);
    holdLinkSecret('invitation', TOKEN, ID);
    const { result } = renderHook(() => useLinkSecret('invitation', ID));
    expect(result.current).toBe(TOKEN);
    act(() => linkSecretsSessionExpired());
    expect(result.current).toBeNull();
    act(() => linkSecretsFollowSession(A));
    expect(result.current).toBe(TOKEN);
  });

  function expiringApp() {
    let expired = true;
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          expired
            ? fakeResponse(
                401,
                apiErrorBody('AUTHENTICATION_REQUIRED', { nextAction: 'authenticate' }),
              )
            : fakeResponse(200, {}),
      },
    });
    let context: ReturnType<typeof useApp> | null = null;
    function Probe({ read }: { read: boolean }) {
      context = useApp();
      const me = useApiQuery({ path: '/me', enabled: read });
      return <Text>{me.status}</Text>;
    }
    return {
      app,
      Probe,
      context: () => context,
      renew: () => {
        expired = false;
      },
    };
  }

  it('§4.13 NA-04: after AUTHENTICATION_REQUIRED the same account signing in again gets its invitation token back', async () => {
    const { app, Probe, context, renew } = expiringApp();
    const view = render(<Probe read={false} />, { wrapper: app.wrapper });
    await waitFor(() => expect(context()?.session.status).toBe('signed_in'));
    holdLinkSecret('invitation', TOKEN, ID); // opened while the account is signed in
    view.rerender(<Probe read />);
    await waitFor(() => expect(context()?.session.expired).toBe(true));
    expect(await app.sessionStore.load()).toBeNull();
    expect(readLinkSecret('invitation', ID)).toBeNull();
    renew();
    await act(async () => {
      await context()?.signIn({ ...TEST_SESSION, token: 'renewed-token' });
    });
    expect(readLinkSecret('invitation', ID)).toBe(TOKEN);
  });

  it('§4.13 R3-SECURITY-07: after AUTHENTICATION_REQUIRED another account signing in is not offered the invitation token', async () => {
    const { app, Probe, context, renew } = expiringApp();
    const view = render(<Probe read={false} />, { wrapper: app.wrapper });
    await waitFor(() => expect(context()?.session.status).toBe('signed_in'));
    holdLinkSecret('invitation', TOKEN, ID);
    view.rerender(<Probe read />);
    await waitFor(() => expect(context()?.session.expired).toBe(true));
    renew();
    await act(async () => {
      await context()?.signIn({ ...TEST_SESSION, token: 'other-token', ...B });
    });
    expect(readLinkSecret('invitation', ID)).toBeNull();
    await act(async () => {
      await context()?.signOut();
    });
    await act(async () => {
      await context()?.signIn(TEST_SESSION);
    });
    expect(readLinkSecret('invitation', ID)).toBeNull();
  });

  it('signing out through the app drops the secrets before the next person signs in', async () => {
    const app = createTestApp();
    const { result } = renderHook(() => useApp(), { wrapper: app.wrapper });
    await waitFor(() => expect(result.current.session.status).toBe('signed_in'));
    holdLinkSecret('claim', TOKEN);
    await act(async () => {
      await result.current.signOut();
    });
    expect(readLinkSecret('claim')).toBeNull();
    await act(async () => {
      await result.current.signIn({ ...TEST_SESSION, token: 'other-token', ...B });
    });
    expect(readLinkSecret('claim')).toBeNull();
  });
});
