/**
 * One idempotency key per user intent (§4.9), with the API's replay rule: the API stores every
 * domain (4xx) answer under the key and replays it for the same key and body, so after a definitive
 * refusal the next attempt is a new intent; an unknown outcome (no response, retryable code) keeps
 * the key so the retry can never apply the effect twice.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useKeyedCommands } from '../../features/operations/commands';
import { AppProviders, MUTATION_DEFAULTS, createQueryClient } from '../../providers/AppProviders';
import { createTestApp, staffMe } from '../../testing/test-app';
import { useApiCommand } from '../useApiCommand';
import { useApiQuery } from '../useApiQuery';

const ID = '0192f1a0-0000-7000-8000-000000000501';

function keysOf(app: ReturnType<typeof createTestApp>, route: string) {
  return app.fake.requests
    .filter((r) => r.route === route)
    .map((r) => r.headers['idempotency-key']);
}

describe('commands offline (§4.15, R3-SCREEN-STATES-01)', () => {
  it('the dashboard data layer never pauses a command offline to send it by itself on reconnect', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /maintenance-restrictions/{id}/release': () => {
          calls += 1;
          // The device has no connection: the request cannot be completed.
          throw new TypeError('Failed to fetch');
        },
      },
    });
    // The production client (createQueryClient), not the test defaults.
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations).toMatchObject(MUTATION_DEFAULTS);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppProviders services={app.services} queryClient={client}>
        {children}
      </AppProviders>
    );
    const { result } = renderHook(
      () => useApiCommand('post', '/maintenance-restrictions/{id}/release'),
      { wrapper },
    );
    act(() => app.connectivity.set(false));
    const request = { path: { id: ID }, body: { expectedRevision: 2, reason: 'Inspected' } };
    await act(async () => {
      await result.current.submit(request as never).catch(() => undefined);
    });
    // It settled at once as a failure the screen shows, instead of waiting paused.
    await waitFor(() => expect(result.current.error?.isOffline).toBe(true));
    expect(result.current.isProcessing).toBe(false);
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused),
    ).toBe(false);
    act(() => app.connectivity.set(true));
    await act(async () => {
      await client.resumePausedMutations();
    });
    expect(calls).toBe(1);
  });
});

describe('useApiCommand (§4.9)', () => {
  it('a 4xx refusal (ELIGIBILITY_FAILED), then the same release again, sends a new key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /maintenance-restrictions/{id}/release': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                422,
                apiErrorBody('ELIGIBILITY_FAILED', { nextAction: 'review_eligibility_reasons' }),
              )
            : fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(
      () => useApiCommand('post', '/maintenance-restrictions/{id}/release'),
      { wrapper: app.wrapper },
    );
    const request = { path: { id: ID }, body: { expectedRevision: 2, reason: 'Inspected' } };
    await act(async () => {
      await result.current.submit(request as never).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.code).toBe('ELIGIBILITY_FAILED'));
    await act(async () => {
      await result.current.submit(request as never);
    });
    const keys = keysOf(app, '/maintenance-restrictions/{id}/release');
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a timeout keeps the key: the retry is the same intent', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /maintenance-restrictions/{id}/release': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('Failed to fetch');
          return fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(
      () => useApiCommand('post', '/maintenance-restrictions/{id}/release'),
      { wrapper: app.wrapper },
    );
    const request = { path: { id: ID }, body: { expectedRevision: 2, reason: 'Inspected' } };
    await act(async () => {
      await result.current.submit(request as never).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.isOffline).toBe(true));
    await act(async () => {
      await result.current.submit(request as never);
    });
    const keys = keysOf(app, '/maintenance-restrictions/{id}/release');
    expect(keys).toEqual([keys[0], keys[0]]);
  });
});

describe('useKeyedCommands (§4.9)', () => {
  it('a 409 then a retry gives a new key; a network failure then a retry gives the same key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /fee-submissions/{id}/approve': () => {
          calls += 1;
          if (calls === 1) {
            return fakeResponse(
              409,
              apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }),
            );
          }
          if (calls === 2) throw new TypeError('Failed to fetch');
          return fakeResponse(200, { ok: true });
        },
      },
    });
    const { result } = renderHook(() => useKeyedCommands(), { wrapper: app.wrapper });
    const request = { path: { id: ID }, body: { expectedRevision: 1 } };
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await result.current.run(
          `approve|${ID}`,
          'post',
          '/fee-submissions/{id}/approve' as never,
          request as never,
        );
      });
    }
    const keys = keysOf(app, '/fee-submissions/{id}/approve');
    expect(keys).toHaveLength(3);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });
});

describe('reread before a new request (SPK-PAY-007, SPK-PAY-008)', () => {
  function readsOf(app: ReturnType<typeof createTestApp>) {
    return app.fake.requests.filter((r) => r.route === '/me').length;
  }

  function mount(app: ReturnType<typeof createTestApp>, invalidate: (readonly unknown[])[]) {
    return renderHook(
      () => ({
        shown: useApiQuery({ path: '/me' }),
        command: useApiCommand('post', '/maintenance-restrictions/{id}/release', { invalidate }),
      }),
      { wrapper: app.wrapper },
    );
  }

  it('resolves only after the shown record was read again', async () => {
    const app = createTestApp();
    const { result } = mount(app, [['api', '/me']]);
    await waitFor(() => expect(result.current.shown.data).toBeDefined());
    const before = readsOf(app);
    await act(() => result.current.command.reread());
    expect(readsOf(app)).toBe(before + 1);
  });

  it('offline, the read cannot start (TanStack pauses it): reread rejects and nothing was read', async () => {
    const app = createTestApp();
    const { result } = mount(app, [['api', '/me']]);
    await waitFor(() => expect(result.current.shown.data).toBeDefined());
    const before = readsOf(app);
    act(() => app.connectivity.set(false));
    let outcome: unknown = 'resolved';
    await act(async () => {
      await result.current.command.reread().catch((e: unknown) => (outcome = e));
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(readsOf(app)).toBe(before);
  });

  it('a read that fails, or no shown record to read, rejects', async () => {
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me': () => {
          reads += 1;
          return reads === 1
            ? fakeResponse(200, staffMe().body)
            : fakeResponse(500, apiErrorBody('INTERNAL_ERROR'));
        },
      },
    });
    const { result } = mount(app, [['api', '/me']]);
    await waitFor(() => expect(result.current.shown.data).toBeDefined());
    await act(async () => {
      await expect(result.current.command.reread()).rejects.toBeTruthy();
    });

    const nothingShown = mount(createTestApp(), [['api', '/refunds']]);
    await act(async () => {
      await expect(nothingShown.result.current.command.reread()).rejects.toThrow(
        'Nothing on screen to read again.',
      );
    });
  });
});
