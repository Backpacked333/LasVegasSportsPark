/**
 * Data layer and session behaviour: one idempotency key per user intent, reused on retry (§4.9);
 * session expiry clears the secret and asks to sign in again (§4.13, §6.2 "Expired session");
 * an update-required answer covers the app (SCR-C-39, SPK-AT-027, proposed DEC-092).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { onlineManager } from '@tanstack/react-query';
import { act, renderHook, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { UpdateGate } from '../../navigation/UpdateGate';
import { AppProviders, MUTATION_DEFAULTS, createQueryClient } from '../../providers/AppProviders';
import { createTestApp } from '../../testing/test-app';
import { InboxScreen } from '../../screens/inbox/InboxScreen';
import { useApiCommand } from '../useApiCommand';
import { useApiQuery } from '../useApiQuery';

const ASSIGNMENT = '0192f1a0-0000-7000-8000-000000000301';

describe('commands offline (§4.15, R3-SCREEN-STATES-01)', () => {
  it('the app data layer never pauses a command offline to send it by itself on reconnect', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /assignments/{id}/accept': () => {
          calls += 1;
          // The device has no connection: the request cannot be completed.
          throw new TypeError('Network request failed');
        },
      },
    });
    // The production client (createQueryClient), not the test defaults.
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations).toMatchObject(MUTATION_DEFAULTS);
    // Its command defaults are kept; only cache timers are turned off so Jest can exit.
    const defaults = client.getDefaultOptions();
    client.setDefaultOptions({
      queries: { ...defaults.queries, gcTime: Infinity },
      mutations: { ...defaults.mutations, gcTime: Infinity },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppProviders services={app.services} queryClient={client}>
        {children}
      </AppProviders>
    );
    const { result, unmount } = renderHook(
      () => useApiCommand('post', '/assignments/{id}/accept'),
      { wrapper },
    );
    await act(async () => undefined); // let the providers finish loading the session
    act(() => {
      app.sources.setReachable(false);
      onlineManager.setOnline(false);
    });
    const request = { path: { id: ASSIGNMENT }, body: { expectedRevision: 2 } };
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    // It settled at once as a failure the screen shows, instead of waiting paused.
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.isProcessing).toBe(false);
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused),
    ).toBe(false);
    act(() => {
      app.sources.setReachable(true);
      onlineManager.setOnline(true);
    });
    await act(async () => {
      await client.resumePausedMutations();
    });
    expect(calls).toBeLessThanOrEqual(1);
    unmount();
  });
});

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
    // The mutation error reaches the hook through TanStack Query's timer-batched notifier.
    await waitFor(() => expect(result.current.error?.code).toBe('INTEGRATION_UNAVAILABLE'));
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

describe('useApiCommand after a definitive refusal (§4.9, the API replays stored 4xx answers)', () => {
  it('MISSING_ACKNOWLEDGMENT, then the same press again, sends a new key (no stored replay)', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /baskets/{id}/hold': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                422,
                apiErrorBody('MISSING_ACKNOWLEDGMENT', { nextAction: 'complete_acknowledgment' }),
              )
            : fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(() => useApiCommand('post', '/baskets/{id}/hold'), {
      wrapper: app.wrapper,
    });
    await act(async () => undefined);
    const request = { path: { id: ASSIGNMENT }, body: { expectedRevision: 4 } };
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.code).toBe('MISSING_ACKNOWLEDGMENT'));
    await act(async () => {
      await result.current.submit(request);
    });
    const keys = app.fake.requests.map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(app.fake.requests[1]?.body).toEqual({ expectedRevision: 4 });
  });

  it('IDEMPOTENCY_OUTCOME_UNAVAILABLE keeps the key: the command committed, so the same press again is answered the same way instead of running under a new key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /baskets/{id}/hold': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                409,
                apiErrorBody('IDEMPOTENCY_OUTCOME_UNAVAILABLE', {
                  nextAction: 'reload_current_state',
                }),
              )
            : fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(() => useApiCommand('post', '/baskets/{id}/hold'), {
      wrapper: app.wrapper,
    });
    await act(async () => undefined);
    const request = { path: { id: ASSIGNMENT }, body: { expectedRevision: 4 } };
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.code).toBe('IDEMPOTENCY_OUTCOME_UNAVAILABLE'));
    // ApiError.keepsIntent ends the intent here; the app keeps it (keepsIntentAfterFailure).
    expect(result.current.error?.keepsIntent).toBe(false);
    await act(async () => {
      await result.current.submit(request);
    });
    const keys = app.fake.requests.map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual([keys[0], keys[0]]);
    // A deliberate new start (reset) is a new intent.
    act(() => result.current.reset());
    await act(async () => {
      await result.current.submit(request);
    });
    expect(app.fake.requests.map((r) => r.headers['idempotency-key'])[2]).not.toBe(keys[0]);
  });

  it('a timeout keeps the key for the retry of the same intent', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /baskets/{id}/hold': () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new TypeError('Network request failed'))
            : fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(() => useApiCommand('post', '/baskets/{id}/hold'), {
      wrapper: app.wrapper,
    });
    await act(async () => undefined);
    const request = { path: { id: ASSIGNMENT }, body: { expectedRevision: 4 } };
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.isOffline).toBe(true));
    await act(async () => {
      await result.current.submit(request);
    });
    const keys = app.fake.requests.map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual([keys[0], keys[0]]);
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
