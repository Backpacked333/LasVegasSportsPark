/**
 * SCR-C-40 Connectivity and stale-data banner (SPK-UX-001, SPK-UX-008, §4.15, §6.2 "Poor
 * connectivity"): hidden when online and fresh; offline with the age of what is shown and the
 * actions that need a connection; refreshing and then "updated" after reconnecting; degraded when
 * the service cannot refresh what is shown; stale only when a threshold is configured
 * (DEC-032/DEC-033).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { createTestApp } from '../../testing/test-app';
import {
  ConnectivityBanner,
  OFFLINE_UNAVAILABLE_ACTIONS,
  REFRESHED_NOTICE_MS,
} from '../ConnectivityBanner';

const ME = {
  status: 200,
  body: { principal: {}, person: null, staffMemberships: [], authorities: [] },
};

function ShownData() {
  const me = useApiQuery({ path: '/me' });
  return <Text>{me.data ? 'loaded' : 'waiting'}</Text>;
}

function Harness() {
  return (
    <>
      <ConnectivityBanner />
      <ShownData />
    </>
  );
}

describe('SCR-C-40 ConnectivityBanner', () => {
  it('is hidden while online with fresh data', async () => {
    const app = createTestApp({ routes: { 'GET /me': ME } });
    render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    expect(screen.queryByTestId('connectivity-banner')).toBeNull();
  });

  it('when offline, states the age of what is shown and lists actions that need a connection', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: { 'GET /me': ME }, now: () => now });
    render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();

    now = new Date('2026-10-24T14:05:00.000Z');
    act(() => app.sources.setReachable(false));
    const banner = screen.getByTestId('connectivity-banner');
    expect(banner).toHaveProp('accessibilityRole', 'alert');
    expect(screen.getByLabelText('You are offline')).toBeOnTheScreen();
    expect(
      screen.getByText(
        `Showing information from 2 hours ago. Needs a connection: ${OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}.`,
      ),
    ).toBeOnTheScreen();
  });

  it('says when nothing has been loaded yet, rather than showing an age', async () => {
    const app = createTestApp({ routes: {}, reachable: false });
    render(<ConnectivityBanner />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Nothing has been loaded yet\./)).toBeOnTheScreen();
  });

  it('never calls data stale while the threshold is pending (DEC-032/DEC-033)', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: { 'GET /me': ME }, now: () => now });
    render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    now = new Date('2026-10-25T12:00:00.000Z');
    act(() => app.sources.setForeground(false));
    expect(screen.queryByText('Some information may be out of date')).toBeNull();
  });

  it('calls shown data stale once it is older than a configured threshold', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({
      routes: { 'GET /me': ME },
      now: () => now,
      config: { staleDataThresholdMs: 10 * 60_000 },
    });
    const view = render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    now = new Date('2026-10-24T12:30:00.000Z');
    view.rerender(<Harness />);
    expect(await screen.findByLabelText('Some information may be out of date')).toBeOnTheScreen();
    expect(screen.getByText('Updated 30 minutes ago.')).toBeOnTheScreen();
  });

  it('shows "Back online. Refreshing" while refetching after reconnecting, then "Updated" for a minute', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({
      now: () => now,
      routes: {
        'GET /me': async () => {
          calls += 1;
          if (calls > 1) await new Promise<void>((resolve) => (release = resolve));
          return fakeResponse(200, ME.body);
        },
      },
    });
    const view = render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByLabelText('You are offline')).toBeOnTheScreen();
    act(() => app.sources.setReachable(true));
    expect(await screen.findByLabelText('Back online. Refreshing')).toBeOnTheScreen();
    expect(calls).toBe(2);
    await act(async () => release());
    expect(await screen.findByLabelText('Back online. Updated just now')).toBeOnTheScreen();
    expect(calls).toBe(2);
    now = new Date(now.getTime() + REFRESHED_NOTICE_MS + 1_000);
    view.rerender(<Harness />);
    await waitFor(() => expect(screen.queryByTestId('connectivity-banner')).toBeNull());
  });

  it('when online but the service cannot refresh what is shown, says so with the code and offers a retry', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': () => {
          calls += 1;
          return calls === 2
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, ME.body);
        },
      },
    });
    render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    await act(async () => {
      await app.queryClient.refetchQueries({ type: 'active' });
    });
    expect(
      await screen.findByLabelText('Some information could not be refreshed'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/error code INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    // The data already shown stays.
    expect(screen.getByText('loaded')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.queryByTestId('connectivity-banner')).toBeNull());
    expect(calls).toBe(3);
  });

  it('offers a refresh when shown data is older than a configured threshold', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': () => {
          calls += 1;
          return fakeResponse(200, ME.body);
        },
      },
      now: () => now,
      config: { staleDataThresholdMs: 10 * 60_000 },
    });
    const view = render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    now = new Date('2026-10-24T12:30:00.000Z');
    view.rerender(<Harness />);
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await act(async () => {
      fireEvent.press(refresh);
    });
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('connectivity-banner')).toBeNull());
  });
});
