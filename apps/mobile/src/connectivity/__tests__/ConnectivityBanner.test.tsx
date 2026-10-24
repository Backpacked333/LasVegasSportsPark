/**
 * SCR-C-40 Connectivity and stale-data banner (SPK-UX-001, SPK-UX-008, §4.15, §6.2 "Poor
 * connectivity"): hidden when online and fresh; offline with the age of what is shown and the
 * actions that need a connection; stale only when a threshold is configured (DEC-032/DEC-033).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { createTestApp } from '../../testing/test-app';
import { ConnectivityBanner, OFFLINE_UNAVAILABLE_ACTIONS } from '../ConnectivityBanner';

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

  it('shows "Back online. Refreshing" while refetching after reconnecting', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': async () => {
          calls += 1;
          if (calls > 1) await new Promise<void>((resolve) => (release = resolve));
          return fakeResponse(200, ME.body);
        },
      },
    });
    render(<Harness />, { wrapper: app.wrapper });
    expect(await screen.findByText('loaded')).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByLabelText('You are offline')).toBeOnTheScreen();
    act(() => app.sources.setReachable(true));
    expect(await screen.findByLabelText('Back online. Refreshing')).toBeOnTheScreen();
    expect(calls).toBe(2);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId('connectivity-banner')).toBeNull());
    expect(calls).toBe(2);
  });
});
