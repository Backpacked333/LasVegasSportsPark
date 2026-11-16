/**
 * AppHeader (ADR-008, SPK-UX-009): the large title as a header, with eyebrow, subtitle and actions.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { AppHeader } from '../AppHeader';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme, type } from '../theme';

function PassButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Facility pass"
      onPress={onPress}
      style={{ minWidth: 44, minHeight: 44 }}
    >
      <Text>Pass</Text>
    </Pressable>
  );
}

describe('AppHeader (ADR-008)', () => {
  it('SPK-UX-009: the title is a header in the large-title style; the words around it are plain', async () => {
    await renderSurface(
      <AppHeader title="Home" eyebrow="Saturday 24 October" subtitle="2 games today" />,
    );
    expect(screen.getByRole('header', { name: 'Home' })).toHaveStyle({
      fontSize: type.largeTitle.fontSize,
      lineHeight: type.largeTitle.lineHeight,
    });
    expect(screen.getAllByRole('header')).toHaveLength(1);
    expect(screen.getByText('Saturday 24 October')).toBeOnTheScreen();
    expect(screen.getByText('2 games today')).toBeOnTheScreen();
  });

  it('SPK-UX-009: holds its actions in a row at least 44 pt tall', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <AppHeader title="Home" actions={<PassButton onPress={onPress} />} testID="header" />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Facility pass' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('header-actions')).toHaveStyle({ minHeight: 44 });
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('draws in the text colours of the %s theme', async (name, theme) => {
    await renderSurface(<AppHeader title="Teams" eyebrow="This week" />, { theme: name });
    expect(screen.getByRole('header', { name: 'Teams' })).toHaveStyle({
      color: theme.colors.text,
    });
    expect(screen.getByText('This week')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<AppHeader title="Calendar" testID="header" />);
    const still = screen.getByTestId('header').props.style;
    rerender(
      <MotionProvider reduced={false}>
        <AppHeader title="Calendar" testID="header" />
      </MotionProvider>,
    );
    expect(screen.getByTestId('header').props.style).toEqual(still);
  });
});
