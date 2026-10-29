/**
 * SCR-C-36 Preferences (SPK-UX-001 push registration and preferences, SPK-COMMS-001,
 * SPK-COMMS-007 "Essential operational communications and promotional preferences must be
 * separately represented", SPK-COMMS-008 private calendar feeds, DEC-062, POL-024).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  me,
  namesRoute,
  ok,
  person,
  SELF,
} from '../../account/__tests__/fixtures';
import { FEED_REVOKED_TEXT, feedUrl } from '../CalendarFeedsSection';
import { PreferencesScreen } from '../PreferencesScreen';
import { PushPermissionProvider } from '../push-permission';

type Pref = {
  channel: 'in_app' | 'push' | 'email' | 'sms';
  category: 'operational' | 'promotional';
  enabled: boolean;
  stored: boolean;
  locked: boolean;
  updatedAt: string | null;
};

function prefs(overrides: Partial<Record<string, Partial<Pref>>> = {}) {
  const rows: Pref[] = [];
  for (const category of ['operational', 'promotional'] as const) {
    for (const channel of ['in_app', 'push', 'email', 'sms'] as const) {
      const locked = category === 'operational' && channel === 'in_app';
      rows.push({
        channel,
        category,
        enabled:
          channel === 'in_app' ||
          channel === 'email' ||
          (category === 'operational' && channel === 'push'),
        stored: false,
        locked,
        updatedAt: null,
        ...overrides[`${category}:${channel}`],
      });
    }
  }
  return { personId: SELF, preferences: rows };
}

const TEST_REVOKED_AT = '2026-10-24T11:00:00.000Z';
const FEED = {
  id: '0192f1a0-0000-7000-8000-00000000f101',
  personId: SELF,
  label: 'Family',
  scope: { subjectPersonIds: [CHILD] },
  lastAccessedAt: null,
  accessCount: 0,
  revokedAt: null,
  revision: 3,
  createdAt: '2026-10-20T10:00:00.000Z',
};

function prefsApp(routes: Record<string, unknown> = {}, reachable = true) {
  return createTestApp({
    reachable,
    routes: {
      'GET /me/communication-preferences': ok(prefs()),
      'GET /me/calendar-feeds': ok({ feeds: [] }),
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
      'GET /person-names': namesRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
      'GET /me/push-devices': ok({ devices: [] }),
      ...(routes as Record<string, never>),
    },
  });
}

describe('SCR-C-36 PreferencesScreen', () => {
  it('SPK-COMMS-007: shows essential and promotional preferences separately; in-app essential notices are always on, not a switch', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Essential notices' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Promotional messages' })).toBeOnTheScreen();
    const locked = screen.getByTestId('pref-operational:in_app');
    expect(locked).toHaveProp(
      'accessibilityLabel',
      'In the app, Essential notices always appear in the app and cannot be switched off., Always on',
    );
    expect(screen.queryByRole('switch', { name: 'In the app for essential notices' })).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'In the app for promotional messages' }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Push notifications for essential notices' }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Push notifications for promotional messages' }),
    ).not.toBeChecked();
    expect(screen.getAllByText('Off. Facility default').length).toBeGreaterThan(0);
  });

  it('shows which channels the facility uses as pending DEC-062', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        /The choice of channels the facility uses is not available yet: it depends on DEC-062/,
      ),
    ).toBeOnTheScreen();
  });

  it('saves only the changed preferences with an idempotency key and says "Preferences saved"', async () => {
    let saved = false;
    const after = prefs({ 'promotional:email': { enabled: false, stored: true } });
    const app = prefsApp({
      'GET /me/communication-preferences': () => fakeResponse(200, saved ? after : prefs()),
      'PATCH /me/communication-preferences': () => {
        saved = true;
        return fakeResponse(200, after);
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const save = await screen.findByRole('button', { name: 'Save preferences' });
    expect(save).toBeDisabled();
    fireEvent(
      screen.getByRole('switch', { name: 'Email for promotional messages' }),
      'valueChange',
      false,
    );
    expect(screen.getByRole('button', { name: 'Save preferences' })).not.toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByLabelText('Preferences saved')).toBeOnTheScreen();
    const patch = app.fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({
      preferences: [{ channel: 'email', category: 'promotional', enabled: false }],
    });
    expect(patch?.headers['idempotency-key']).toBe('key-00000001');
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Email for promotional messages' }),
      ).not.toBeChecked(),
    );
  });

  it('a failed save keeps the choice, shows the code and retries under the same key', async () => {
    let calls = 0;
    const app = prefsApp({
      'PATCH /me/communication-preferences': () => {
        calls += 1;
        return apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' });
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    fireEvent(
      await screen.findByRole('switch', { name: 'Text messages (SMS) for essential notices' }),
      'valueChange',
      true,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Save preferences' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(
      screen.getByRole('switch', { name: 'Text messages (SMS) for essential notices' }),
    ).toBeChecked();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const keys = app.fake.requests
      .filter((r) => r.method === 'PATCH')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['key-00000001', 'key-00000001']);
  });

  it('offline: switches and saving are disabled; nothing is queued', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('switch', { name: 'Email for essential notices' }),
    ).not.toBeDisabled();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('switch', { name: 'Email for essential notices' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    expect(screen.getByText('Changes need a connection and are not queued.')).toBeOnTheScreen();
  });

  it('push on this device: not set up in this build (DEC-061), essential notices stay in the inbox', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Push is not set up in this version')).toBeOnTheScreen();
    expect(screen.getAllByText(/Essential notices always appear in the app's inbox/).length).toBe(
      1,
    );
  });

  it('permission restriction: push denied by the operating system is explained and in-app notices continue', async () => {
    const app = prefsApp();
    const reader = { status: async () => 'denied' as const };
    render(
      <app.wrapper>
        <PushPermissionProvider reader={reader}>
          <PreferencesScreen />
        </PushPermissionProvider>
      </app.wrapper>,
    );
    expect(await screen.findByLabelText('Push is turned off for this app')).toBeOnTheScreen();
    expect(screen.getByText(/Essential notices still appear in the app's inbox/)).toBeOnTheScreen();
  });

  it('API errors on reading preferences show the code (NOT_FOUND shown as not available)', async () => {
    const app = prefsApp({
      'GET /me/communication-preferences': () =>
        apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });
});

describe('SCR-C-36 calendar feeds (SPK-COMMS-008)', () => {
  it('lists feeds with "Calendar feed active" and revokes with the expected revision', async () => {
    const app = prefsApp({
      'GET /me/calendar-feeds': ok({ feeds: [FEED] }),
      'POST /me/calendar-feeds/{id}/revoke': ok({
        ...FEED,
        revokedAt: '2026-10-24T12:00:00.000Z',
        revision: 4,
      }),
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText(
        'Family, Your activities and 1 other person. Not used yet., Calendar feed active',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Revoke Family' }));
    fireEvent.press(screen.getByRole('button', { name: 'Revoke now' }));
    expect(await screen.findByText(FEED_REVOKED_TEXT)).toBeOnTheScreen();
    const revoke = app.fake.requests.find((r) => r.route === '/me/calendar-feeds/{id}/revoke');
    expect(revoke?.body).toEqual({ expectedRevision: 3 });
    expect(revoke?.params.id).toBe(FEED.id);
  });

  it('stale version: a feed revoked on another device offers a Reload button that shows its current state', async () => {
    let revokedElsewhere = false;
    const app = prefsApp({
      'GET /me/calendar-feeds': () =>
        fakeResponse(200, {
          feeds: [revokedElsewhere ? { ...FEED, revokedAt: TEST_REVOKED_AT, revision: 4 } : FEED],
        }),
      'POST /me/calendar-feeds/{id}/revoke': () => {
        revokedElsewhere = true;
        return fakeResponse(409, {
          code: 'STALE_REVISION',
          message: 'The record changed.',
          correlationId: 'corr-feed',
          nextAction: 'reload_and_retry',
        });
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Revoke Family' }));
    fireEvent.press(screen.getByRole('button', { name: 'Revoke now' }));
    const reload = await screen.findByRole('button', { name: 'Reload' });
    fireEvent.press(reload);
    expect(
      await screen.findByLabelText(
        'Family, Your activities and 1 other person. Not used yet., Feed link revoked',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull();
  });

  it('creates a feed for the person and a child they may view, and shares the link shown once', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const app = prefsApp({
      'POST /me/calendar-feeds': {
        status: 201,
        body: {
          ...FEED,
          token: 'feed-token-value-0123456789',
          path: '/v1/calendar-feeds/feed-token-value-0123456789.ics',
        },
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    fireEvent.changeText(await screen.findByLabelText('Feed name (optional)'), 'Family');
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Sam Morgan' }));
    fireEvent.press(screen.getByRole('button', { name: 'Create calendar feed' }));
    const created = await screen.findByTestId('feed-created');
    const post = app.fake.requests.find(
      (r) => r.route === '/me/calendar-feeds' && r.method === 'POST',
    );
    expect(post?.body).toEqual({ label: 'Family', subjectPersonIds: [CHILD] });
    fireEvent.press(within(created).getByRole('button', { name: 'Share calendar link' }));
    expect(share).toHaveBeenCalledWith({
      message: 'http://api.test/v1/calendar-feeds/feed-token-value-0123456789.ics',
    });
    share.mockRestore();
  });

  it('builds the feed URL from the API origin', () => {
    expect(feedUrl('https://api.example/v1', '/v1/calendar-feeds/t.ics')).toBe(
      'https://api.example/v1/calendar-feeds/t.ics',
    );
    expect(feedUrl('/v1', '/v1/calendar-feeds/t.ics')).toBe('/v1/calendar-feeds/t.ics');
  });

  it('shows a revoked feed as "Feed link revoked" without a revoke action', async () => {
    const app = prefsApp({
      'GET /me/calendar-feeds': ok({ feeds: [{ ...FEED, revokedAt: '2026-10-22T10:00:00.000Z' }] }),
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText(
        'Family, Your activities and 1 other person. Not used yet., Feed link revoked',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Revoke Family' })).toBeNull();
  });
});

describe('SCR-C-36 push devices (SPK-UX-001 push registration, SPK-IAM-006; DEC-061, DEC-020)', () => {
  const DEVICE = '0192f1a0-0000-7000-8000-00000000f301';
  const OLD_DEVICE = '0192f1a0-0000-7000-8000-00000000f302';

  function device(overrides: Record<string, unknown> = {}) {
    return {
      id: DEVICE,
      personId: SELF,
      accountId: '0192f1a0-0000-7000-8000-0000000000aa',
      platform: 'ios',
      tokenHint: 'a1b2',
      appVersion: '0.1.0',
      status: 'active',
      registeredAt: '2026-10-01T10:00:00.000Z',
      lastSeenAt: '2026-10-23T10:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
      revision: 2,
      ...overrides,
    };
  }

  it('this build has no push module: registering this device is pending DEC-061 and DEC-020', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        /Registering this device for push notifications is not available yet: it depends on DEC-061, DEC-020/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Register this device' })).toBeNull();
    expect(
      app.fake.requests.some((r) => r.route === '/me/push-devices' && r.method === 'POST'),
    ).toBe(false);
  });

  it('lists the registered devices by token hint only, with their state; a stopped one has no action', async () => {
    const app = prefsApp({
      'GET /me/push-devices': ok({
        devices: [
          device({
            id: OLD_DEVICE,
            platform: 'android',
            tokenHint: 'zz99',
            status: 'revoked',
            revokedAt: '2026-10-10T10:00:00.000Z',
            revokedReason: 'reregistered',
          }),
          device(),
        ],
      }),
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const active = await screen.findByTestId(`push-device-${DEVICE}`);
    expect(
      within(active).getByLabelText(
        /^iPhone or iPad ending a1b2, App version 0\.1\.0\. Registered .*\. Last seen .*, Receives push$/,
      ),
    ).toBeOnTheScreen();
    expect(
      within(active).getByRole('button', { name: 'Stop push to iPhone or iPad ending a1b2' }),
    ).toBeOnTheScreen();
    const stopped = screen.getByTestId(`push-device-${OLD_DEVICE}`);
    expect(within(stopped).getByLabelText('No longer receives push')).toBeOnTheScreen();
    expect(within(stopped).queryByRole('button')).toBeNull();
  });

  it('SPK-IAM-006: stops push to a device with a reason and its revision; the list then shows it stopped', async () => {
    let revoked = false;
    const app = prefsApp({
      'GET /me/push-devices': () =>
        fakeResponse(200, {
          devices: [
            revoked
              ? device({ status: 'revoked', revokedAt: '2026-10-24T12:00:00.000Z', revision: 3 })
              : device(),
          ],
        }),
      'POST /me/push-devices/{id}/revoke': () => {
        revoked = true;
        return fakeResponse(
          200,
          device({ status: 'revoked', revokedAt: '2026-10-24T12:00:00.000Z', revision: 3 }),
        );
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`push-device-${DEVICE}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Stop push to iPhone or iPad ending a1b2' }),
    );
    fireEvent.press(within(row).getByRole('button', { name: 'Stop push' }));
    expect(within(row).getByText(/Say why you are stopping push here/)).toBeOnTheScreen();
    fireEvent.changeText(within(row).getByLabelText('Reason'), 'Old phone');
    fireEvent.press(within(row).getByRole('button', { name: 'Stop push' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`push-device-${DEVICE}`)).getByLabelText(
          'No longer receives push',
        ),
      ).toBeOnTheScreen(),
    );
    const post = app.fake.requests.find((r) => r.route === '/me/push-devices/{id}/revoke');
    expect(post?.params.id).toBe(DEVICE);
    expect(post?.body).toEqual({ reason: 'Old phone', expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('a failed stop keeps the reason, shows the code and retries under the same key', async () => {
    let calls = 0;
    const app = prefsApp({
      'GET /me/push-devices': ok({ devices: [device()] }),
      'POST /me/push-devices/{id}/revoke': () => {
        calls += 1;
        return apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' });
      },
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`push-device-${DEVICE}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Stop push to iPhone or iPad ending a1b2' }),
    );
    fireEvent.changeText(within(row).getByLabelText('Reason'), 'Old phone');
    fireEvent.press(within(row).getByRole('button', { name: 'Stop push' }));
    expect(await within(row).findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(within(row).getByLabelText('Reason')).toHaveProp('value', 'Old phone');
    fireEvent.press(within(row).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const keys = app.fake.requests
      .filter((r) => r.route === '/me/push-devices/{id}/revoke')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['key-00000001', 'key-00000001']);
  });

  it('a device the API no longer has (NOT_FOUND) is "not available"', async () => {
    const app = prefsApp({
      'GET /me/push-devices': ok({ devices: [device()] }),
      'POST /me/push-devices/{id}/revoke': () =>
        apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`push-device-${DEVICE}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Stop push to iPhone or iPad ending a1b2' }),
    );
    fireEvent.changeText(within(row).getByLabelText('Reason'), 'Old phone');
    fireEvent.press(within(row).getByRole('button', { name: 'Stop push' }));
    expect(await within(row).findByLabelText('Device not available')).toBeOnTheScreen();
    expect(within(row).queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('empty: no device receives push, and essential notices stay in the app', async () => {
    const app = prefsApp();
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No devices registered' })).toBeOnTheScreen();
  });

  it('a build that supplies a push token registers this install with platform, token and app version', async () => {
    const app = prefsApp({
      'POST /me/push-devices': { status: 201, body: device() },
    });
    const reader = {
      status: async () => 'granted' as const,
      deviceToken: async () => 'platform-push-token-a1b2',
    };
    render(
      <app.wrapper>
        <PushPermissionProvider reader={reader}>
          <PreferencesScreen />
        </PushPermissionProvider>
      </app.wrapper>,
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Register this device' }));
    expect(await screen.findByLabelText('This device receives push')).toBeOnTheScreen();
    const post = app.fake.requests.find(
      (r) => r.route === '/me/push-devices' && r.method === 'POST',
    );
    expect(post?.body).toEqual({
      platform: 'ios',
      token: 'platform-push-token-a1b2',
      appVersion: '0.1.0',
    });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
    expect(screen.queryByText(/DEC-061, DEC-020/)).toBeNull();
  });

  it('offline: stopping push is disabled and nothing is queued', async () => {
    const app = prefsApp({ 'GET /me/push-devices': ok({ devices: [device()] }) });
    render(<PreferencesScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`push-device-${DEVICE}`);
    act(() => app.sources.setReachable(false));
    expect(
      within(row).getByRole('button', { name: 'Stop push to iPhone or iPad ending a1b2' }),
    ).toBeDisabled();
  });
});
