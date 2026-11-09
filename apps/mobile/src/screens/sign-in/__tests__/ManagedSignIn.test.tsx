/**
 * SCR-C-01, SCR-C-02 managed sign-in (SPK-UX-001, SPK-IAM-002, §4.13, §4.14, DEC-018).
 */
import { OidcError, type OidcTokens } from '@sportspark/api-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ManagedSignIn } from '../../../session/managed-sign-in';
import { createTestApp } from '../../../testing/test-app';
import { apiError, me, ok } from '../../account/__tests__/fixtures';
import { SignInScreen } from '../SignInScreen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const TOKENS: OidcTokens = {
  bearerToken: 'provider-token',
  expiresAt: '2026-10-24T13:00:00.000Z',
  refreshToken: 'provider-refresh',
};
const ACCOUNT_ID = '0192f1a0-0000-7000-8000-0000000000aa';
const account = (personId: string | null) => ({
  id: ACCOUNT_ID,
  issuer: 'https://identity.example.test',
  subject: 'user-1',
  personId,
  status: 'active',
  lastLoginAt: null,
  revision: 1,
  createdAt: '2026-10-24T12:00:00.000Z',
});

const managed = (signIn: ManagedSignIn['signIn']): ManagedSignIn => ({
  signIn,
  renew: async () => TOKENS,
});

beforeEach(() => mockReplace.mockClear());

describe('SCR-C-01 managed sign-in', () => {
  it('a build that names a provider offers sign-in, not the pending decision', async () => {
    const app = createTestApp({ session: null, managedSignIn: managed(async () => TOKENS) });
    render(<SignInScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Continue to sign-in' })).toBeOnTheScreen();
    expect(screen.queryByText(/depends on DEC-018/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Recover an existing account' })).toBeOnTheScreen();
  });

  it('first sign-in: registers the login account, stores the session with its refresh token, and opens account setup because no participant record is linked', async () => {
    const app = createTestApp({
      session: null,
      managedSignIn: managed(async () => TOKENS),
      config: { organizationSlug: 'the-park' },
      routes: { 'POST /accounts/register': ok(account(null)) },
    });
    render(<SignInScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding'));
    expect(await app.sessionStore.load()).toEqual({
      token: 'provider-token',
      expiresAt: TOKENS.expiresAt,
      accountId: ACCOUNT_ID,
      refreshToken: 'provider-refresh',
    });
    const registration = app.fake.requests.find((r) => r.route === '/accounts/register');
    expect(registration?.headers.authorization).toBe('Bearer provider-token');
    expect(registration?.body).toEqual({ organizationSlug: 'the-park' });
  });

  it('a returning person whose account is linked goes Home', async () => {
    const app = createTestApp({
      session: null,
      managedSignIn: managed(async () => TOKENS),
      config: { organizationSlug: 'the-park' },
      routes: { 'POST /accounts/register': ok(account('0192f1a0-0000-7000-8000-0000000000dd')) },
    });
    render(<SignInScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('with no organization named, only an existing account signs in; a verified identity without one is told so and nothing is stored', async () => {
    const existing = createTestApp({
      session: null,
      managedSignIn: managed(async () => TOKENS),
      routes: { 'GET /me': ok(me({})) },
    });
    const first = render(<SignInScreen />, { wrapper: existing.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(existing.fake.requests.some((r) => r.route === '/accounts/register')).toBe(false);
    first.unmount();

    const unknown = createTestApp({
      session: null,
      managedSignIn: managed(async () => TOKENS),
      routes: {
        'GET /me': () =>
          apiError(401, 'AUTHENTICATION_REQUIRED', { message: 'No active account matches.' }),
      },
    });
    mockReplace.mockClear();
    render(<SignInScreen />, { wrapper: unknown.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(await screen.findByTestId('sign-in-problem')).toHaveTextContent(
      'You signed in, but no account here matches. Ask the front desk to set up your account.',
    );
    expect(await unknown.sessionStore.load()).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('closing the sign-in page, an unreachable provider and an answer for another attempt each say what happened, store nothing and leave the button usable', async () => {
    const outcomes: Array<[ManagedSignIn['signIn'], string]> = [
      [async () => null, 'Sign-in was closed before it finished.'],
      [
        async () => {
          throw new OidcError('provider_unavailable', 'down');
        },
        'The sign-in service could not be reached. Nothing was changed. Try again.',
      ],
      [
        async () => {
          throw new OidcError('response_mismatch', 'x');
        },
        'This sign-in could not be completed. Nothing was changed. Try again.',
      ],
    ];
    for (const [signIn, message] of outcomes) {
      const app = createTestApp({ session: null, managedSignIn: managed(signIn) });
      const view = render(<SignInScreen />, { wrapper: app.wrapper });
      fireEvent.press(await screen.findByRole('button', { name: 'Continue to sign-in' }));
      expect(await screen.findByTestId('sign-in-problem')).toHaveTextContent(message);
      expect(await app.sessionStore.load()).toBeNull();
      expect(app.fake.requests).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Continue to sign-in' })).toBeEnabled();
      view.unmount();
    }
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('offline: the button is disabled and says sign-in needs a connection', async () => {
    const app = createTestApp({
      session: null,
      reachable: false,
      managedSignIn: managed(async () => TOKENS),
    });
    render(<SignInScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Continue to sign-in' })).toBeDisabled();
    expect(screen.getByText('Signing in needs a connection.')).toBeOnTheScreen();
  });
});
