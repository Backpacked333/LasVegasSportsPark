/**
 * Haptics (ADR-008): the device plays them through expo-haptics, the web plays nothing, a failing
 * engine is never an error, and tests record what would have played.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ExpoHaptics from 'expo-haptics';
import { Pressable, Text } from 'react-native';
import { createTestApp, settleQueries } from '../../testing/test-app';
import { useApp } from '../AppProviders';
import { RecordingHaptics, deviceHaptics, platformHaptics, silentHaptics } from '../haptics';

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

const native = jest.mocked(ExpoHaptics);

describe('deviceHaptics (ADR-008)', () => {
  it('plays each event with the matching expo-haptics call', () => {
    deviceHaptics.selection();
    deviceHaptics.impact('light');
    deviceHaptics.impact('medium');
    deviceHaptics.success();
    deviceHaptics.warning();
    expect(native.selectionAsync).toHaveBeenCalledTimes(1);
    expect(native.impactAsync.mock.calls).toEqual([['light'], ['medium']]);
    expect(native.notificationAsync.mock.calls).toEqual([['success'], ['warning']]);
  });

  it('skips a haptic the engine refuses or cannot play, without an error', async () => {
    native.selectionAsync.mockReturnValueOnce(Promise.reject(new Error('no engine')));
    native.impactAsync.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    expect(() => deviceHaptics.selection()).not.toThrow();
    expect(() => deviceHaptics.impact('light')).not.toThrow();
    // The rejected promise is handled: nothing surfaces after the call returns.
    await Promise.resolve();
  });
});

describe('platformHaptics (ADR-008)', () => {
  it('uses the device engine on iOS and Android and nothing on the web', () => {
    expect(platformHaptics('ios')).toBe(deviceHaptics);
    expect(platformHaptics('android')).toBe(deviceHaptics);
    expect(platformHaptics('web')).toBe(silentHaptics);
    silentHaptics.selection();
    silentHaptics.impact('medium');
    silentHaptics.success();
    silentHaptics.warning();
    expect(native.selectionAsync).not.toHaveBeenCalled();
    expect(native.impactAsync).not.toHaveBeenCalled();
    expect(native.notificationAsync).not.toHaveBeenCalled();
  });
});

describe('RecordingHaptics (test double)', () => {
  it('records events in order and clears', () => {
    const haptics = new RecordingHaptics();
    haptics.selection();
    haptics.impact('medium');
    haptics.success();
    haptics.warning();
    haptics.impact('light');
    expect(haptics.events).toEqual([
      'selection',
      'impact:medium',
      'success',
      'warning',
      'impact:light',
    ]);
    haptics.clear();
    expect(haptics.events).toEqual([]);
  });

  it('is the haptics service of createTestApp', async () => {
    function Choice() {
      const { services } = useApp();
      return (
        <Pressable accessibilityRole="button" onPress={() => services.haptics.selection()}>
          <Text>Choose</Text>
        </Pressable>
      );
    }
    const app = createTestApp();
    render(<Choice />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Choose' }));
    await settleQueries(app.queryClient);
    expect(app.haptics.events).toEqual(['selection']);
    expect(native.selectionAsync).not.toHaveBeenCalled();
  });
});
