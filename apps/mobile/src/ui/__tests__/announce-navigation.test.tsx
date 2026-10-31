/**
 * SPK-UX-009 (NA-A01): VoiceOver hears each result once, and only for the screen in view.
 * expo-router keeps the stack below the top screen (and visited tabs) mounted, and every Screen
 * renders its own connectivity banner, so without a focus check and one app-wide connectivity
 * announcement, going offline would be announced once per mounted screen (src/ui/announce.tsx).
 */
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { router, Stack } from 'expo-router';
import { AccessibilityInfo, Text } from 'react-native';
import {
  ConnectivityAnnouncer,
  OFFLINE_UNAVAILABLE_ACTIONS,
} from '../../connectivity/ConnectivityBanner';
import { useConnectivity } from '../../providers/AppProviders';
import { createTestApp } from '../../testing/test-app';
import { LiveRegion } from '../announce';
import { Screen } from '../Screen';

const announce = AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock;
const announced = () => announce.mock.calls.map((call) => call[0] as string);

const OFFLINE = `You are offline. Needs a connection: ${OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}.`;

/** A result that appears on its screen when the device goes offline. */
function ResultWhenOffline({ words }: { words: string }) {
  const { reachable } = useConnectivity();
  return <LiveRegion announcement={reachable === false ? words : null} />;
}

function renderTwoScreens() {
  const app = createTestApp();
  const Layout = () => (
    <app.wrapper>
      <ConnectivityAnnouncer />
      <Stack />
    </app.wrapper>
  );
  const Below = () => (
    <Screen>
      <Text>The screen below</Text>
      <ResultWhenOffline words="Result on the screen below." />
    </Screen>
  );
  const Top = () => (
    <Screen>
      <Text>The screen in view</Text>
      <ResultWhenOffline words="Result on the screen in view." />
    </Screen>
  );
  renderRouter({ _layout: Layout, index: Below, top: Top }, { initialUrl: '/' });
  return app;
}

describe('SPK-UX-009 announcements follow the screen in view', () => {
  it('two mounted screens going offline: "You are offline" is announced once, and only the result in view', async () => {
    const app = renderTwoScreens();
    expect(await screen.findByText('The screen below')).toBeOnTheScreen();
    act(() => router.push('/top'));
    expect(await screen.findByText('The screen in view')).toBeOnTheScreen();
    // Both screens are mounted, each with its banner.
    expect(screen.getByText('The screen below', { includeHiddenElements: true })).toBeTruthy();
    announce.mockClear();

    act(() => app.sources.setReachable(false));
    expect(
      await screen.findAllByTestId('connectivity-banner', { includeHiddenElements: true }),
    ).toHaveLength(2);
    expect(announced().filter((words) => words === OFFLINE)).toHaveLength(1);
    expect(announced()).toContain('Result on the screen in view.');
    expect(announced()).not.toContain('Result on the screen below.');

    // Back online: "Refreshing" and then "updated" are announced once each as well.
    announce.mockClear();
    act(() => app.sources.setReachable(true));
    await waitFor(() => expect(announced()).toContain('Back online. Information updated'));
    expect(announced().filter((words) => words === 'Back online. Refreshing')).toHaveLength(1);
    expect(
      announced().filter((words) => words === 'Back online. Information updated'),
    ).toHaveLength(1);
  });
});
