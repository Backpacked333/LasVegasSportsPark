/**
 * Card v2 (ADR-008, SPK-UX-009, SPK-UX-010): elevation levels, the pressable card as one button,
 * and that the existing Card, Eyebrow and SectionCard look and read as before.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { pressedStyle, renderSurface } from '../../testing/ui-surfaces';
import { Card, Eyebrow, SectionCard } from '../Card';
import { ListRow } from '../ListRow';
import { MotionProvider } from '../motion';
import { classicTheme, elevation, legendsTheme, motionTokens } from '../theme';

const flat = (element: { props: { style?: unknown } }) =>
  StyleSheet.flatten(element.props.style as never) as Record<string, unknown>;

describe('Card (ADR-008)', () => {
  it('keeps the bordered card, the night card and the section card as they were', async () => {
    await renderSurface(
      <>
        <Card testID="plain">
          <Text>Body</Text>
        </Card>
        <Card tone="night" testID="night">
          <Text>Hero</Text>
        </Card>
        <SectionCard title="For you to know" testID="section">
          <ListRow title="Field change" />
        </SectionCard>
      </>,
    );
    expect(screen.getByTestId('plain')).toHaveStyle({
      backgroundColor: classicTheme.colors.background,
      borderWidth: 1,
      borderColor: classicTheme.colors.border,
    });
    expect(screen.getByTestId('night')).toHaveStyle({ backgroundColor: classicTheme.colors.night });
    expect(screen.getByRole('header', { name: 'For you to know' })).toBeOnTheScreen();
    // Rows inside a card are flat: no card of their own.
    expect(screen.getByLabelText('Field change')).toHaveStyle({ borderTopWidth: 1 });
    // A card is not a control unless it is pressable.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'draws an elevation level of the %s theme instead of the line border',
    async (name, theme) => {
      await renderSurface(
        <Card elevation="raised" testID="card">
          <Text>Raised</Text>
        </Card>,
        { theme: name },
      );
      const style = flat(screen.getByTestId('card'));
      const level = elevation(theme, 'raised');
      expect(style.backgroundColor).toBe(level.backgroundColor);
      if (theme.dark) {
        expect(style.borderColor).toBe(theme.colors.control);
        expect(style.boxShadow).toBeUndefined();
      } else {
        expect(style.boxShadow).toBe(level.boxShadow);
        expect(style.borderWidth).toBeUndefined();
      }
    },
  );

  it('SPK-UX-009: a pressable card is one button, named by its words or its label, at least 44 pt', async () => {
    const onPress = jest.fn();
    const { rerender } = await renderSurface(
      <Card onPress={onPress}>
        <Text>U10 Saturday league</Text>
      </Card>,
    );
    const card = screen.getByRole('button', { name: 'U10 Saturday league' });
    expect(flat(card).minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(
      <Card onPress={onPress} accessibilityLabel="U10 Saturday league, starts 7 November" disabled>
        <Text>U10 Saturday league</Text>
      </Card>,
    );
    const disabled = screen.getByRole('button', { name: 'U10 Saturday league, starts 7 November' });
    expect(disabled).toBeDisabled();
    fireEvent.press(disabled);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('SPK-UX-010 reduced motion: a pressed card fills at once and shrinks only when motion is allowed', async () => {
    const card = (
      <Card onPress={() => undefined} accessibilityLabel="Open">
        <Text>Open</Text>
      </Card>
    );
    const { rerender } = await renderSurface(card);
    expect(pressedStyle(screen, 'Open').backgroundColor).toBe(classicTheme.colors.surface);
    expect(pressedStyle(screen, 'Open').transform).toBeUndefined();

    rerender(<MotionProvider reduced={false}>{card}</MotionProvider>);
    expect(pressedStyle(screen, 'Open').backgroundColor).toBe(classicTheme.colors.surface);
    expect(pressedStyle(screen, 'Open').transform).toEqual([{ scale: motionTokens.pressScale }]);
  });

  it('Eyebrow is a header in the muted colour of the theme', async () => {
    await renderSurface(<Eyebrow>Next up</Eyebrow>, { theme: 'legends' });
    expect(screen.getByRole('header', { name: 'Next up' })).toHaveStyle({
      color: legendsTheme.colors.textMuted,
    });
  });
});
