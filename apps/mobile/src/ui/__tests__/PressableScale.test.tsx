/**
 * PressableScale (ADR-008 motion, SPK-UX-009, SPK-UX-010 restrained animation): it springs to the
 * press scale only with motion on, never while motion is reduced, and its haptic plays only for a
 * press that lands.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { PressableScale } from '../PressableScale';
import { MIN_TOUCH_SIZE, motionTokens } from '../theme';

function Target(props: { onPress?: () => void; disabled?: boolean; haptic?: 'light' | 'none' }) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Open the schedule"
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress ?? (() => undefined)}
      haptic={props.haptic ?? 'light'}
      style={({ pressed }) => ({ minHeight: MIN_TOUCH_SIZE, opacity: pressed ? 0.5 : 1 })}
    >
      {({ pressed }) => <Text>{pressed ? 'held' : 'idle'}</Text>}
    </PressableScale>
  );
}

const scaleOf = (style: Record<string, unknown>) =>
  (style.transform as { scale?: number }[] | undefined)?.find((t) => t.scale !== undefined)?.scale;

describe('PressableScale (ADR-008)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the role, name and state through and keeps a 44 pt target', async () => {
    await renderUi(<Target disabled />);
    const target = screen.getByRole('button', { name: 'Open the schedule' });
    expect(target).toBeDisabled();
    expect(drawnStyle(target).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('SPK-UX-009: with motion reduced it never scales; the pressed style still applies at once', async () => {
    await renderUi(<Target />);
    const target = screen.getByRole('button', { name: 'Open the schedule' });
    fireEvent(target, 'pressIn');
    expect(screen.getByText('held')).toBeOnTheScreen();
    expect(drawnStyle(target).opacity).toBe(0.5);
    expect(drawnStyle(target).transform).toBeUndefined();
    fireEvent(target, 'pressOut');
    expect(screen.getByText('idle')).toBeOnTheScreen();
  });

  it('with motion on it springs to the press scale and back', async () => {
    jest.useFakeTimers();
    await renderUi(<Target />, { motion: 'full' });
    const target = screen.getByRole('button', { name: 'Open the schedule' });
    expect(scaleOf(getAnimatedStyle(target) as Record<string, unknown>)).toBe(1);
    fireEvent(target, 'pressIn');
    act(() => jest.advanceTimersByTime(1_000));
    expect(scaleOf(getAnimatedStyle(target) as Record<string, unknown>)).toBeCloseTo(
      motionTokens.pressScale,
      2,
    );
    fireEvent(target, 'pressOut');
    act(() => jest.advanceTimersByTime(1_000));
    expect(scaleOf(getAnimatedStyle(target) as Record<string, unknown>)).toBeCloseTo(1, 2);
  });

  it('plays its haptic when a press lands, and none for a disabled press', async () => {
    const onPress = jest.fn();
    const { haptics, rerender } = await renderUi(<Target onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Open the schedule' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.events).toEqual(['impact:light']);

    rerender(<Target onPress={onPress} disabled />);
    fireEvent.press(screen.getByRole('button', { name: 'Open the schedule' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.events).toEqual(['impact:light']);
  });

  it('renders without the app providers, with silent haptics', async () => {
    const onPress = jest.fn();
    render(<Target onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Open the schedule' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(THEME_NAMES)('renders in the %s theme', async (theme) => {
    await renderUi(<Target />, { theme });
    expect(screen.getByRole('button', { name: 'Open the schedule' })).toBeOnTheScreen();
  });
});
