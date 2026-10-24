/**
 * SCR-C-05 Facility pass (SPK-ENTRY-002, SPK-ENTRY-003, SPK-UX-002, §4.9, §4.13, §4.14, §4.15).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { me, ok, SELF } from '../../../features/today/__tests__/fixtures';
import { createTestApp, TEST_SESSION } from '../../../testing/test-app';
import {
  MemoryPassStore,
  PassStoreContext,
  SecurePassStore,
  passStorageKey,
  type StoredPass,
} from '../pass-store';
import { groupReference, PassScreen, REPLACE_REASON } from '../PassScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void values.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void values.delete(key)),
  };
});

const ACCOUNT = TEST_SESSION.accountId as string;
const PASS_ONE = '0192f1a0-0000-7000-8000-00000000aa01';
const PASS_TWO = '0192f1a0-0000-7000-8000-00000000aa02';
const REF_ONE = 'spk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
const REF_TWO = 'spk_ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS';

function issued(id: string, reference: string) {
  return {
    pass: {
      id,
      holderKind: 'person',
      holderPersonId: SELF,
      holderHouseholdId: null,
      status: 'active',
      issuedAt: '2026-10-24T11:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
      revision: 1,
    },
    reference,
  };
}

const STORED: StoredPass = {
  passId: PASS_ONE,
  reference: REF_ONE,
  issuedAt: '2026-10-22T17:00:00.000Z',
  revision: 1,
};

function setup(
  routes: Record<string, FakeHandler>,
  options: { stored?: StoredPass; reachable?: boolean; now?: () => Date } = {},
) {
  const store = new MemoryPassStore();
  if (options.stored) store.values.set(ACCOUNT, options.stored);
  const app = createTestApp({ routes, reachable: options.reachable, now: options.now });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <app.wrapper>
      <PassStoreContext.Provider value={store}>{children}</PassStoreContext.Provider>
    </app.wrapper>
  );
  render(<PassScreen />, { wrapper: Wrapper });
  return { app, store };
}

describe('SCR-C-05 PassScreen', () => {
  it('SPK-ENTRY-002: issues a personal pass and shows only the opaque reference, kept on this device', async () => {
    const { app, store } = setup({
      'GET /me': ok(me()),
      'POST /passes': { status: 201, body: issued(PASS_ONE, REF_ONE) },
    });
    expect(await screen.findByRole('header', { name: 'No pass on this device' })).toBeOnTheScreen();
    fireEvent.press(await screen.findByRole('button', { name: 'Get my pass' }));

    expect(await screen.findByText(groupReference(REF_ONE))).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Facility pass reference: /)).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.route === '/passes');
    expect(post?.body).toEqual({ holder: { kind: 'person', personId: SELF } });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    expect(await store.load(ACCOUNT)).toEqual({
      passId: PASS_ONE,
      reference: REF_ONE,
      issuedAt: '2026-10-24T11:00:00.000Z',
      revision: 1,
      pendingRevoke: null,
    });
    // No name, household or child detail anywhere on the pass (§4.14).
    expect(screen.queryByText(/Alex|Morgan/)).toBeNull();
    // The scannable symbol waits on the scanner decision.
    expect(
      screen.getByText(
        /A scannable code for this pass is not available yet: it depends on DEC-023/,
      ),
    ).toBeOnTheScreen();
  });

  it('§4.15: offline, shows the stored pass with its age and says the desk may refuse it if revoked', async () => {
    const { app } = setup({ 'GET /me': ok(me()) }, { stored: STORED, reachable: false });
    expect(await screen.findByText(groupReference(REF_ONE))).toBeOnTheScreen();
    expect(screen.getByText(/^Issued Thu, Oct 22, 10:00 AM PDT \(1 day ago\)\./)).toBeOnTheScreen();
    expect(screen.getByLabelText('Shown from this device')).toBeOnTheScreen();
    expect(screen.getByText(/may refuse it if it was revoked/)).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('replaces a pass: issues the new one first, then revokes the old with reason and expected revision', async () => {
    const { app, store } = setup(
      {
        'GET /me': ok(me()),
        'POST /passes': { status: 201, body: issued(PASS_TWO, REF_TWO) },
        'POST /passes/{id}/revoke': ok({ ...issued(PASS_ONE, REF_ONE).pass, status: 'revoked' }),
      },
      { stored: STORED },
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Replace pass' }));
    expect(screen.getByText(/the current one stops working/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText(groupReference(REF_TWO))).toBeOnTheScreen();
    const routes = app.fake.requests.map((r) => r.route);
    expect(routes.indexOf('/passes')).toBeLessThan(routes.indexOf('/passes/{id}/revoke'));
    const revoke = app.fake.requests.find((r) => r.route === '/passes/{id}/revoke');
    expect(revoke?.params.id).toBe(PASS_ONE);
    expect(revoke?.body).toEqual({ reason: REPLACE_REASON, expectedRevision: 1 });
    expect((await store.load(ACCOUNT))?.passId).toBe(PASS_TWO);
    expect(screen.queryByTestId('pass-revoke-problem')).toBeNull();
  });

  it('keeps the new pass and says the old one may still be active when revoking fails', async () => {
    setup(
      {
        'GET /me': ok(me()),
        'POST /passes': { status: 201, body: issued(PASS_TWO, REF_TWO) },
        'POST /passes/{id}/revoke': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      },
      { stored: STORED },
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Replace pass' }));
    fireEvent.press(screen.getByRole('button', { name: 'Replace' }));
    expect(await screen.findByLabelText('Previous pass may still be active')).toBeOnTheScreen();
    expect(screen.getByText(/error code INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByText(groupReference(REF_TWO))).toBeOnTheScreen();
  });

  it('§4.9: an unconfirmed revoke (no answer) offers Try again, which resends the same revoke with the same key', async () => {
    let revokes = 0;
    const { app, store } = setup(
      {
        'GET /me': ok(me()),
        'POST /passes': { status: 201, body: issued(PASS_TWO, REF_TWO) },
        'POST /passes/{id}/revoke': () => {
          revokes += 1;
          if (revokes === 1) throw new TypeError('Network request failed');
          return fakeResponse(200, { ...issued(PASS_ONE, REF_ONE).pass, status: 'revoked' });
        },
      },
      { stored: STORED },
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Replace pass' }));
    fireEvent.press(screen.getByRole('button', { name: 'Replace' }));
    expect(
      await screen.findByText(/We could not confirm the previous pass was withdrawn/),
    ).toBeOnTheScreen();
    expect((await store.load(ACCOUNT))?.pendingRevoke).toEqual({ passId: PASS_ONE, revision: 1 });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    const sent = app.fake.requests.filter((r) => r.route === '/passes/{id}/revoke');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers['idempotency-key']).toBe(sent[0]?.headers['idempotency-key']);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(screen.queryByTestId('pass-revoke-unconfirmed')).toBeNull();
    expect((await store.load(ACCOUNT))?.pendingRevoke).toBeNull();
  });

  it('never revokes the previous pass when the new one could not be saved on the device', async () => {
    const { app, store } = setup(
      {
        'GET /me': ok(me()),
        'POST /passes': { status: 201, body: issued(PASS_TWO, REF_TWO) },
        'POST /passes/{id}/revoke': ok({ ...issued(PASS_ONE, REF_ONE).pass, status: 'revoked' }),
      },
      { stored: STORED },
    );
    store.save = jest.fn(async () => {
      throw new Error('keychain locked');
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Replace pass' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Replace' }));
    });
    expect(
      await screen.findByText(/your previous pass was kept and\s+still works/),
    ).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/passes/{id}/revoke')).toHaveLength(0);
  });

  it('§4.14: a session without an account id never reads or writes a shared pass key', async () => {
    const store = new MemoryPassStore();
    store.values.set('account', STORED);
    const app = createTestApp({
      session: { ...TEST_SESSION, accountId: null },
      routes: { 'GET /me': ok({ ...me(), principal: { ...me().principal, accountId: null } }) },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <app.wrapper>
        <PassStoreContext.Provider value={store}>{children}</PassStoreContext.Provider>
      </app.wrapper>
    );
    render(<PassScreen />, { wrapper: Wrapper });
    expect(await screen.findByLabelText('Pass unavailable')).toBeOnTheScreen();
    expect(screen.queryByText(groupReference(REF_ONE))).toBeNull();
  });

  it('SPK-UX-009: screen readers hear the reference itself, spelled out', async () => {
    setup({ 'GET /me': ok(me()) }, { stored: STORED });
    const reference = await screen.findByTestId('pass-reference');
    const label = String(reference.props.accessibilityLabel);
    expect(label).toContain(groupReference(REF_ONE).split('').join(' '));
  });

  it('§4.9: a retry after INTEGRATION_UNAVAILABLE reuses the idempotency key, so one pass is issued', async () => {
    let calls = 0;
    const { app } = setup({
      'GET /me': ok(me()),
      'POST /passes': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', {
                nextAction: 'retry_later',
                correlationId: 'corr-pass',
              }),
            )
          : fakeResponse(201, issued(PASS_ONE, REF_ONE));
      },
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Get my pass' }));
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-pass/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(groupReference(REF_ONE))).toBeOnTheScreen();
    const posts = app.fake.requests.filter((r) => r.route === '/passes');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['idempotency-key']).toBe(posts[1]?.headers['idempotency-key']);
  });

  it('shows a denied issue as "Pass not available", without the code, and an unlinked account as not available', async () => {
    setup({
      'GET /me': ok(me()),
      'POST /passes': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Get my pass' }));
    expect(await screen.findByLabelText('Pass not available')).toBeOnTheScreen();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();

    screen.unmount();
    const unlinked = me();
    unlinked.principal.personId = null as unknown as string;
    setup({ 'GET /me': ok(unlinked) });
    expect(
      await screen.findByText(/needs your account to be linked to a person/),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Get my pass' })).toBeNull();
  });

  it('disables getting a pass offline and says it needs a connection', async () => {
    const { app } = setup({ 'GET /me': ok(me()) });
    expect(await screen.findByRole('button', { name: 'Get my pass' })).toBeEnabled();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Get my pass' })).toBeDisabled();
    expect(screen.getByText('Getting or replacing a pass needs a connection.')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('SecurePassStore (§4.13)', () => {
  it('keeps the pass in the secure store under the account, readable only on this unlocked device', async () => {
    const store = new SecurePassStore();
    await store.save('acct-1', STORED);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'sportspark.pass.acct-1',
      JSON.stringify(STORED),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(await store.load('acct-1')).toEqual({ ...STORED, pendingRevoke: null });
    expect(await store.load('acct-2')).toBeNull();
    await store.clear('acct-1');
    expect(await store.load('acct-1')).toBeNull();
    expect(passStorageKey('a b/c')).toBe('sportspark.pass.a_b_c');
  });
});
