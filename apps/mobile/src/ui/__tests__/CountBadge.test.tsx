/**
 * CountBadge (ADR-008, SPK-UX-009): a count read once, through its parent, or on its own words.
 */
import { screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { CountBadge, countBadgeText } from '../CountBadge';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

describe('CountBadge (ADR-008)', () => {
  it('shows nothing for 0, the count, and "99+" above the maximum', () => {
    expect(countBadgeText(0)).toBeNull();
    expect(countBadgeText(-2)).toBeNull();
    expect(countBadgeText(3)).toBe('3');
    expect(countBadgeText(120)).toBe('99+');
    expect(countBadgeText(12, 9)).toBe('9+');
  });

  it('SPK-UX-009: is hidden inside a control that names the count, so it is read once', async () => {
    await renderSurface(
      <Pressable accessibilityRole="button" accessibilityLabel="Notification inbox, 3 unread">
        <Text>Inbox</Text>
        <CountBadge count={3} testID="badge" />
      </Pressable>,
    );
    expect(screen.getByRole('button', { name: 'Notification inbox, 3 unread' })).toBeOnTheScreen();
    expect(screen.queryByTestId('badge')).toBeNull();
    expect(screen.getByTestId('badge', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'no-hide-descendants',
    );
  });

  it('SPK-UX-009: a badge on its own is text with its words, and never a touch target', async () => {
    await renderSurface(<CountBadge count={4} accessibilityLabel="4 waiting" />);
    const badge = screen.getByRole('text', { name: '4 waiting' });
    expect(badge).toBeOnTheScreen();
    expect(screen.getByText('4')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws nothing at 0', async () => {
    await renderSurface(<CountBadge count={0} accessibilityLabel="0 waiting" testID="badge" />);
    expect(screen.queryByTestId('badge', { includeHiddenElements: true })).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('uses the count-badge colours of the %s theme', async (name, theme) => {
    await renderSurface(<CountBadge count={2} accessibilityLabel="2 new" />, { theme: name });
    expect(screen.getByRole('text', { name: '2 new' })).toHaveStyle({
      backgroundColor: theme.colors.countBadge,
    });
    expect(screen.getByText('2')).toHaveStyle({ color: theme.colors.onCountBadge });
  });

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<CountBadge count={5} accessibilityLabel="5 new" />);
    const still = screen.getByRole('text', { name: '5 new' }).props.style;
    rerender(
      <MotionProvider reduced={false}>
        <CountBadge count={5} accessibilityLabel="5 new" />
      </MotionProvider>,
    );
    expect(screen.getByRole('text', { name: '5 new' }).props.style).toEqual(still);
  });
});
