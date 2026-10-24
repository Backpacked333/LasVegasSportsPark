/**
 * Data layer and session behaviour: one idempotency key per user intent, reused on retry (§4.9);
 * session expiry clears the secret and asks to sign in again (§4.13, §6.2 "Expired session");
 * an update-required answer covers the app (SCR-C-39, SPK-AT-027, proposed DEC-092).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, renderHook, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { UpdateGate } from '../../navigation/UpdateGate';
import { createTestApp } from '../../testing/test-app';
import { InboxScreen } from '../../screens/inbox/InboxScreen';
import { useApiCommand } from '../useApiCommand';
import { useApiQuery } from '../useApiQuery';

const ASSIGNMENT = '0192f1a0-0000-7000-8000-000000000301';

describe('useApiCommand (§4.9)', () => {
  it('reuses the key when the same input is retried and starts a new intent when the input changes', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /assignments/{id}/accept': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(() => useApiCommand('post', '/assignments/{id}/accept'), {
      wrapper: app.wrapper,
    });
    await act(async () => undefined); // let the providers finish loading the session
    const request = { path: { id: ASSIGNMENT }, body: { expectedRevision: 2 } };

    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    expect(result.current.error?.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(result.current.error?.retryable).toBe(true);

    await act(async () => {
      await result.current.submit(request);
    });
    await act(async () => {
      await result.current.submit({ ...request, body: { expectedRevision: 3 } });
    });

    expect(app.fake.requests.map((r) => r.headers['idempotency-key'])).toEqual([
      'key-00000001',
      'key-00000001',
      'key-00000002',
    ]);
    expect(app.fake.requests[0]?.body).toEqual({ expectedRevision: 2 });
  });
});

describe('session expiry and update required', () => {
  it('drops the stored session when the API answers AUTHENTICATION_REQUIRED and asks to sign in again', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () =>
          fakeResponse(
            401,
            apiErrorBody('AUTHENTICATION_REQUIRED', { nextAction: 'authenticate' }),
          ),
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Your session ended' })).toBeOnTheScreen();
    expect(await app.sessionStore.load()).toBeNull();
  });

  it('covers the app with "Update required" when the API says this build is unsupported', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          fakeResponse(
            426,
            apiErrorBody('CLIENT_UPDATE_REQUIRED', {
              nextAction: 'update_app',
              details: { minimumVersion: '0.3.0' },
            }),
          ),
      },
    });
    function Content() {
      const me = useApiQuery({ path: '/me' });
      return <Text>{me.status}</Text>;
    }
    render(
      <UpdateGate>
        <Content />
      </UpdateGate>,
      { wrapper: app.wrapper },
    );
    await waitFor(() => expect(screen.getByTestId('update-required')).toBeOnTheScreen());
    expect(
      screen.getByText(/You have version 0\.1\.0; version 0\.3\.0 or later is required/),
    ).toBeOnTheScreen();
  });
});
