import { OidcError, type OidcTokens } from '@sportspark/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSignIn } from '../../../session/managed-sign-in';
import { createTestApp } from '../../../testing/test-app';

const TOKENS: OidcTokens = {
  bearerToken: 'provider-token',
  expiresAt: '2026-10-24T13:00:00.000Z',
  refreshToken: 'provider-refresh',
};

function managed(overrides: Partial<ManagedSignIn> = {}): ManagedSignIn {
  return {
    start: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ tokens: TOKENS, returnTo: '/today' })),
    renew: vi.fn(async () => TOKENS),
    signOut: vi.fn(async () => true),
    ...overrides,
  };
}

const ACCOUNT = {
  id: '0192f1a0-0000-7000-8000-0000000000cc',
  issuer: 'https://identity.example.test',
  subject: 'user-1',
  personId: null,
  status: 'active',
  lastLoginAt: null,
  revision: 1,
  createdAt: '2026-10-24T12:00:00.000Z',
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('managed staff sign-in screens (§4.13, §4.14, DEC-018, SPK-UX-008)', () => {
  it('a build that names a provider offers managed sign-in, not the pending decision, and returns to the page first asked for', async () => {
    const service = managed();
    const app = createTestApp({ session: null, managedSignIn: service });
    render(app.at('/finance'));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(service.start).toHaveBeenCalledWith('/finance');
    expect(screen.queryByTestId('state-pending-decision')).not.toBeInTheDocument();
  });

  it('a build that names no provider still says sign-in is pending', async () => {
    const app = createTestApp({ session: null });
    render(app.at('/sign-in'));
    expect(await screen.findByRole('heading', { name: 'Sportspark staff' })).toBeInTheDocument();
  });

  it('an unreachable provider is said plainly and the button works again; offline it is disabled', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new OidcError('provider_unavailable', 'down'))
      .mockResolvedValueOnce(undefined);
    const app = createTestApp({ session: null, managedSignIn: managed({ start }) });
    render(app.at('/sign-in'));
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Continue to sign-in' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The sign-in service could not be reached. Nothing was changed. Try again.',
    );
    await user.click(screen.getByRole('button', { name: 'Continue to sign-in' }));
    expect(start).toHaveBeenCalledTimes(2);

    app.connectivity.set(false);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue to sign-in' })).toBeDisabled(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Signing in needs a connection.');
  });

  it('the return page exchanges the answer once, registers the login account, stores the session and opens the dashboard', async () => {
    const service = managed({
      complete: vi.fn(async () => ({ tokens: TOKENS, returnTo: '/today' })),
    });
    const app = createTestApp({
      session: null,
      managedSignIn: service,
      config: { organizationSlug: 'the-park' },
      routes: { 'POST /accounts/register': { status: 200, body: ACCOUNT } },
    });
    window.history.replaceState(null, '', '/sign-in/callback?code=abc&state=xyz');
    render(app.at('/sign-in/callback?code=abc&state=xyz'));

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(service.complete).toHaveBeenCalledTimes(1);
    expect(service.complete).toHaveBeenCalledWith(
      expect.stringContaining('/sign-in/callback?code=abc&state=xyz'),
    );
    // The code does not stay in the address bar of a shared device.
    expect(window.location.search).toBe('');
    expect(await app.sessionStore.load()).toEqual({
      token: 'provider-token',
      expiresAt: TOKENS.expiresAt,
      accountId: ACCOUNT.id,
      refreshToken: 'provider-refresh',
    });
    const registration = app.fake.requests.find((r) => r.path === '/accounts/register');
    expect(registration?.headers['authorization']).toBe('Bearer provider-token');
    expect(registration?.body).toEqual({ organizationSlug: 'the-park' });
  });

  it('with no organization named, only an existing account signs in; a verified identity without one is told to ask an administrator and nothing is stored', async () => {
    const app = createTestApp({
      session: null,
      managedSignIn: managed(),
      routes: {
        'GET /me': {
          status: 401,
          body: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'No active account matches this token.',
            correlationId: 'c-1',
            nextAction: 'sign_in',
          },
        },
      },
    });
    render(app.at('/sign-in/callback?code=abc&state=xyz'));
    expect(await screen.findByText('No staff account for this sign-in')).toBeInTheDocument();
    expect(await app.sessionStore.load()).toBeNull();
    expect(app.fake.requests.some((r) => r.path === '/accounts/register')).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Back to sign-in' }));
    expect(await screen.findByRole('button', { name: 'Continue to sign-in' })).toBeInTheDocument();
  });

  it('an answer that belongs to no sign-in started here, a cancelled sign-in and an outage each say what happened and store nothing', async () => {
    for (const [error, title] of [
      [new OidcError('response_mismatch', 'x'), 'This sign-in could not be completed'],
      [new OidcError('sign_in_refused', 'x', 'access_denied'), 'Sign-in was not completed'],
      [new OidcError('provider_unavailable', 'x'), 'Sign-in service not available'],
    ] as const) {
      const app = createTestApp({
        session: null,
        managedSignIn: managed({
          complete: vi.fn(async () => {
            throw error;
          }),
        }),
      });
      const view = render(app.at('/sign-in/callback?error=access_denied&state=xyz'));
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(await app.sessionStore.load()).toBeNull();
      expect(app.fake.requests).toEqual([]);
      view.unmount();
    }
  });

  it('§4.14: signing out ends the session here and at the provider', async () => {
    const service = managed();
    const app = createTestApp({ managedSignIn: service });
    render(app.at('/today'));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(service.signOut).toHaveBeenCalledTimes(1));
    expect(await app.sessionStore.load()).toBeNull();
  });
});
