/**
 * MediaCard (ADR-008, SPK-UX-009): hero, tile and compact forms, each one focusable element with
 * one name; words over artwork only on the scrim, and below the picture at large text sizes.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import { pressedStyle, renderSurface } from '../../testing/ui-surfaces';
import { LARGE_TEXT_SCALE, MediaCard, mediaCardLabel, mediaTextPlacement } from '../MediaCard';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme, motionTokens } from '../theme';

const PHOTO = { uri: 'asset:/artwork/soccer-league.webp' };
const NAME = 'Fall league, U10 Saturday league, Saturdays 9 am, Pitch 2, Ages 9 to 10';

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  act(() => {
    Dimensions.set({ window, screen: window });
  });
}

function League(props: Partial<React.ComponentProps<typeof MediaCard>>) {
  return (
    <MediaCard
      form="hero"
      source={PHOTO}
      eyebrow="Fall league"
      title="U10 Saturday league"
      meta={['Saturdays 9 am', 'Pitch 2']}
      tags={['Ages 9 to 10']}
      {...props}
    />
  );
}

describe('MediaCard (ADR-008)', () => {
  const initial = Dimensions.get('window');
  afterEach(() => {
    act(() => {
      Dimensions.set({ window: initial, screen: initial });
    });
  });

  it('builds one name from eyebrow, title, meta and tags', () => {
    expect(
      mediaCardLabel({
        eyebrow: 'Fall league',
        title: 'U10 Saturday league',
        meta: ['Saturdays 9 am', 'Pitch 2'],
        tags: ['Ages 9 to 10'],
      }),
    ).toBe(NAME);
    expect(mediaTextPlacement(1)).toBe('over');
    expect(mediaTextPlacement(LARGE_TEXT_SCALE)).toBe('below');
  });

  it.each(['hero', 'tile', 'compact'] as const)(
    'SPK-UX-009: a %s card is one button with one name, at least 44 pt, its picture unread',
    async (form) => {
      setFontScale(1);
      const onPress = jest.fn();
      await renderSurface(<League form={form} onPress={onPress} width={240} />);
      const card = screen.getByRole('button', { name: NAME });
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(StyleSheet.flatten(card.props.style).minHeight).toBeGreaterThanOrEqual(44);
      fireEvent.press(card);
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(screen.UNSAFE_getByType(Image).props.accessible).toBe(false);
    },
  );

  it('SPK-UX-009: without an action it is still one element, and the trailing control stays its own', async () => {
    const onSave = jest.fn();
    await renderSurface(
      <League
        trailing={
          <Pressable accessibilityRole="button" accessibilityLabel="Save" onPress={onSave}>
            <Text>Save</Text>
          </Pressable>
        }
      />,
    );
    expect(screen.getByLabelText(NAME)).toHaveProp('accessible', true);
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'ADR-008: words over the picture sit on the scrim of the %s theme in onMedia colours',
    async (name, theme) => {
      setFontScale(1);
      await renderSurface(<League testID="card" />, { theme: name });
      expect(screen.UNSAFE_getByType(LinearGradient).props.colors).toEqual([
        theme.colors.scrimStart,
        theme.colors.scrimEnd,
      ]);
      expect(screen.getByText('U10 Saturday league')).toHaveStyle({ color: theme.colors.onMedia });
      expect(screen.getByText('Saturdays 9 am')).toHaveStyle({ color: theme.colors.onMediaMuted });
      expect(screen.getByText('Ages 9 to 10')).toHaveStyle({ color: theme.colors.onMedia });
      // The solid band under the words is the scrim's end colour.
      expect(screen.getByTestId('card-scrim')).toHaveStyle({
        backgroundColor: theme.colors.scrimEnd,
      });
    },
  );

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'SPK-UX-009 large text: the words move below the picture in the page colours (%s)',
    async (name, theme) => {
      setFontScale(LARGE_TEXT_SCALE);
      await renderSurface(<League form="tile" width={240} />, { theme: name });
      expect(screen.UNSAFE_queryAllByType(LinearGradient)).toHaveLength(0);
      expect(screen.getByText('U10 Saturday league')).toHaveStyle({ color: theme.colors.text });
      expect(screen.getByText('Saturdays 9 am')).toHaveStyle({ color: theme.colors.textMuted });
      expect(screen.getByLabelText(NAME)).toBeOnTheScreen();
    },
  );

  it('a compact card never puts words over its thumbnail', async () => {
    setFontScale(1);
    await renderSurface(<League form="compact" />);
    expect(screen.UNSAFE_queryAllByType(LinearGradient)).toHaveLength(0);
    expect(screen.getByText('U10 Saturday league')).toHaveStyle({
      color: classicTheme.colors.text,
    });
  });

  it('SPK-UX-010 reduced motion: a pressed card dims at once and shrinks only when motion is allowed', async () => {
    setFontScale(1);
    const card = <League onPress={() => undefined} />;
    const { rerender } = await renderSurface(card);
    expect(pressedStyle(screen, NAME).opacity).toBeLessThan(1);
    expect(pressedStyle(screen, NAME).transform).toBeUndefined();
    rerender(<MotionProvider reduced={false}>{card}</MotionProvider>);
    expect(pressedStyle(screen, NAME).transform).toEqual([{ scale: motionTokens.pressScale }]);
  });
});
