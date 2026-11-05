/**
 * Development sign-in (development builds only): obtains a token from the API's local identity
 * provider (`POST /v1/dev/tokens`, §5.2) and stores it as the session. When the API is not in
 * development the endpoint answers NOT_FOUND and the screen says the sign-in is not available.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createTestApp } from '../../testing/test-app';
import { DevSignIn } from '../index';

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));

const ACCOUNT = '0192f1a0-0000-7000-8000-0000000000bb';

describe('development sign-in', () => {
  it('exists in development builds (__DEV__) only', () => {
    expect(__DEV__).toBe(true);
    expect(DevSignIn).not.toBeNull();
  });

  it('gets a local token for an account id and stores it as the session', async () => {
    const app = createTestApp({
      session: null,
      routes: {
        'POST /dev/tokens': {
          status: 201,
          body: { token: 'dev-token', accountId: ACCOUNT, expiresAt: '2026-10-24T20:00:00.000Z' },
        },
      },
    });
    const Screen = DevSignIn!;
    render(<Screen />, { wrapper: app.wrapper });

    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText('Account id'), ACCOUNT);
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(async () =>
      expect(await app.sessionStore.load()).toEqual({
        token: 'dev-token',
        accountId: ACCOUNT,
        expiresAt: '2026-10-24T20:00:00.000Z',
      }),
    );
    expect(app.fake.requests[0]?.body).toEqual({ accountId: ACCOUNT });
    expect(app.fake.requests[0]?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('says the sign-in is not available when the API is not in development (NOT_FOUND)', async () => {
    const app = createTestApp({
      session: null,
      routes: { 'POST /dev/tokens': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) },
    });
    const Screen = DevSignIn!;
    render(<Screen />, { wrapper: app.wrapper });
    fireEvent.changeText(screen.getByLabelText('Account id'), ACCOUNT);
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('Development sign-in not available')).toBeOnTheScreen();
    // The input is kept for a retry (SPK-UX-008).
    expect(screen.getByLabelText('Account id')).toHaveDisplayValue(ACCOUNT);
    expect(await app.sessionStore.load()).toBeNull();
  });
});
