/**
 * EmptyState (SPK-UX-008 empty, ADR-008): decorative artwork, a title read as a header, a message
 * and an optional action.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { EmptyState } from '../EmptyState';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

const ART = { uri: 'asset:/artwork/empty-teams.webp' };

describe('EmptyState (SPK-UX-008)', () => {
  it('SPK-UX-008: says what would appear and offers the way to start, the artwork unread', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <EmptyState
        source={ART}
        title="No teams yet"
        message="Teams you join or create appear here."
        action={{ label: 'Find a team', onPress }}
      />,
    );
    expect(screen.getByRole('header', { name: 'No teams yet' })).toBeOnTheScreen();
    expect(screen.getByText('Teams you join or create appear here.')).toBeOnTheScreen();
    expect(screen.UNSAFE_getByType(Image).props.accessible).toBe(false);
    expect(screen.queryByRole('image')).toBeNull();
    const action = screen.getByRole('button', { name: 'Find a team' });
    expect(StyleSheet.flatten(action.props.style).minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is words only without artwork, and has no control without an action', async () => {
    await renderSurface(<EmptyState title="Nothing here" message="Check back later." />);
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('draws its words in the %s theme', async (name, theme) => {
    await renderSurface(<EmptyState title="No games" message="Games appear here." />, {
      theme: name,
    });
    expect(screen.getByRole('header', { name: 'No games' })).toHaveStyle({
      color: theme.colors.text,
    });
    expect(screen.getByText('Games appear here.')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('SPK-UX-009 reduced motion: the artwork appears at once unless motion is allowed', async () => {
    const view = <EmptyState source={ART} title="No games" message="Games appear here." />;
    const { rerender } = await renderSurface(view);
    expect(screen.UNSAFE_getByType(Image).props.transition).toBe(0);
    rerender(<MotionProvider reduced={false}>{view}</MotionProvider>);
    expect(screen.UNSAFE_getByType(Image).props.transition).toBeGreaterThan(0);
  });
});
