/**
 * Link secrets belong to the account signed in when the link arrived (§4.13 session expiry and
 * recovery, §4.14 protected secrets; R3-SECURITY-07): ending the session or signing in as another
 * account drops them, and a link opened while signed out passes to the account that signs in.
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

  it('§4.13 session expiry: an AUTHENTICATION_REQUIRED answer drops the link secrets held for the account', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          fakeResponse(
            401,
            apiErrorBody('AUTHENTICATION_REQUIRED', { nextAction: 'authenticate' }),
          ),
      },
    });
    let session: ReturnType<typeof useApp>['session'] | null = null;
    function Probe({ read }: { read: boolean }) {
      session = useApp().session;
      const me = useApiQuery({ path: '/me', enabled: read });
      return <Text>{me.status}</Text>;
    }
    const view = render(<Probe read={false} />, { wrapper: app.wrapper });
    await waitFor(() => expect(session?.status).toBe('signed_in'));
    holdLinkSecret('invitation', TOKEN, ID); // opened while the account is signed in
    view.rerender(<Probe read />);
    await waitFor(() => expect(session?.expired).toBe(true));
    expect(await app.sessionStore.load()).toBeNull();
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
