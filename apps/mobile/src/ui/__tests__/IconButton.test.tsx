/**
 * IconButton (ADR-008 visual system v2; SPK-UX-009 role, name, state, 44 pt targets; SPK-UX-010
 * restrained press motion): the label names it, a count is folded into that name and badged
 * visually, and the press scale only runs with motion on.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import {
  drawnStyle,
  isHiddenFromScreenReaders,
  renderUi,
  THEME_NAMES,
} from '../../testing/ui-actions';
import { badgeText, IconButton, iconButtonName } from '../IconButton';
import { motionTokens, THEMES } from '../theme';

describe('IconButton (ADR-008, SPK-UX-009)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is a button named by its label; the icon is decorative', async () => {
    const onPress = jest.fn();
    await renderUi(
      <IconButton icon="notifications" label="Notification inbox" onPress={onPress} />,
    );
    const button = screen.getByRole('button', { name: 'Notification inbox' });
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('notifications')).toBeNull();
  });

  it('folds a count into the name ("Notification inbox, 3 unread") and badges it', async () => {
    await renderUi(
      <IconButton
        icon="notifications"
        label="Notification inbox"
        count={3}
        onPress={() => undefined}
        testID="inbox"
      />,
    );
    expect(screen.getByRole('button', { name: 'Notification inbox, 3 unread' })).toBeOnTheScreen();
    const badge = screen.getByTestId('inbox-badge', { includeHiddenElements: true });
    expect(isHiddenFromScreenReaders(badge)).toBe(true);
    expect(screen.getByText('3', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('no count or a count of 0 draws no badge and leaves the name as the label', async () => {
    const { rerender } = await renderUi(
      <IconButton
        icon="shopping_bag"
        label="Basket"
        count={0}
        onPress={() => undefined}
        testID="b"
      />,
    );
    expect(screen.getByRole('button', { name: 'Basket' })).toBeOnTheScreen();
    expect(screen.queryByTestId('b-badge', { includeHiddenElements: true })).toBeNull();
    rerender(
      <IconButton
        icon="shopping_bag"
        label="Basket"
        count={2}
        countLabel="items"
        onPress={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Basket, 2 items' })).toBeOnTheScreen();
  });

  it('shows 99+ above 99 but keeps the exact number in the name', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(140)).toBe('99+');
    expect(iconButtonName('Notification inbox', 140)).toBe('Notification inbox, 140 unread');
  });

  it('SPK-UX-009: a capped count says "more than" in the name and "99+" on the badge', async () => {
    await renderUi(
      <IconButton
        icon="notifications"
        label="Notification inbox"
        count={99}
        countCapped
        onPress={() => undefined}
        testID="inbox"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Notification inbox, more than 99 unread' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('inbox-badge', { includeHiddenElements: true })).toHaveTextContent(
      '99+',
    );
    expect(badgeText(99, true)).toBe('99+');
    expect(iconButtonName('Notification inbox', 99, 'unread', true)).toBe(
      'Notification inbox, more than 99 unread',
    );
  });

  it('SPK-UX-009: is a 44 pt target in every variant', async () => {
    await renderUi(
      <>
        <IconButton icon="close" label="Close plain" onPress={() => undefined} />
        <IconButton icon="close" label="Close tonal" variant="tonal" onPress={() => undefined} />
        <IconButton icon="close" label="Close media" variant="onMedia" onPress={() => undefined} />
      </>,
    );
    for (const name of ['Close plain', 'Close tonal', 'Close media']) {
      const style = drawnStyle(screen.getByRole('button', { name }));
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('exposes the disabled state and plays nothing for a disabled press', async () => {
    const onPress = jest.fn();
    const { haptics } = await renderUi(
      <IconButton icon="share" label="Share" onPress={onPress} disabled />,
    );
    const button = screen.getByRole('button', { name: 'Share' });
    expect(button).toBeDisabled();
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(haptics.events).toEqual([]);
  });

  it('a press that lands plays a light impact', async () => {
    const { haptics } = await renderUi(
      <IconButton icon="share" label="Share" onPress={() => undefined} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Share' }));
    expect(haptics.events).toEqual(['impact:light']);
  });

  it('SPK-UX-009: nothing moves with motion reduced; with motion on a press scales', async () => {
    const { unmount } = await renderUi(
      <IconButton icon="share" label="Share" onPress={() => undefined} />,
    );
    fireEvent(screen.getByRole('button', { name: 'Share' }), 'pressIn');
    expect(drawnStyle(screen.getByRole('button', { name: 'Share' })).transform).toBeUndefined();
    unmount();

    jest.useFakeTimers();
    await renderUi(<IconButton icon="share" label="Share" onPress={() => undefined} />, {
      motion: 'full',
    });
    const button = screen.getByRole('button', { name: 'Share' });
    fireEvent(button, 'pressIn');
    act(() => jest.advanceTimersByTime(1_000));
    const transform = (getAnimatedStyle(button) as { transform: { scale: number }[] }).transform;
    expect(transform[0]!.scale).toBeCloseTo(motionTokens.pressScale, 2);
  });

  it.each(THEME_NAMES)('draws the variants and the badge in %s tokens', async (name) => {
    const { colors } = THEMES[name];
    await renderUi(
      <>
        <IconButton
          icon="notifications"
          label="Inbox"
          count={4}
          onPress={() => undefined}
          testID="inbox"
        />
        <IconButton icon="tune" label="Filters" variant="tonal" onPress={() => undefined} />
        <IconButton icon="close" label="Close" variant="onMedia" onPress={() => undefined} />
      </>,
      { theme: name },
    );
    expect(drawnStyle(screen.getByRole('button', { name: 'Filters' })).backgroundColor).toBe(
      colors.tonal,
    );
    expect(drawnStyle(screen.getByRole('button', { name: 'Close' })).backgroundColor).toBe(
      colors.scrimEnd,
    );
    const badge = screen.getByTestId('inbox-badge', { includeHiddenElements: true });
    expect(drawnStyle(badge).backgroundColor).toBe(colors.countBadge);
    expect(drawnStyle(screen.getByText('4', { includeHiddenElements: true })).color).toBe(
      colors.onCountBadge,
    );
    expect(drawnStyle(screen.getByText('tune', { includeHiddenElements: true })).color).toBe(
      colors.onTonal,
    );
  });

  it('renders without the app providers', () => {
    render(<IconButton icon="close" label="Close" onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeOnTheScreen();
  });
});
