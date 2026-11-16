/**
 * InfoCard (ADR-008, SPK-UX-009): a tinted notice read as one element, each tone with its own icon,
 * and an optional action of its own.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { INFO_CARD_ICONS, InfoCard } from '../InfoCard';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

describe('InfoCard (ADR-008)', () => {
  it('SPK-UX-009: reads title and message as one element and offers its action as a button', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <InfoCard
        tone="warning"
        title="Field change"
        message="Your game moved to Pitch 4"
        action={{ label: 'See the map', onPress }}
      >
        <Text>Extra</Text>
      </InfoCard>,
    );
    expect(screen.getByLabelText('Field change. Your game moved to Pitch 4.')).toBeOnTheScreen();
    expect(screen.getByText('Your game moved to Pitch 4')).toBeOnTheScreen();
    const action = screen.getByRole('button', { name: 'See the map' });
    expect(StyleSheet.flatten(action.props.style).minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Extra')).toBeOnTheScreen();
  });

  it('SPK-UX-009: is not a control without an action', async () => {
    await renderSurface(<InfoCard message="Pay at the front desk for now." />);
    expect(screen.getByLabelText('Pay at the front desk for now.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('SPK-UX-009: gives every tone its own icon, so the tone never rests on colour', async () => {
    const icons = Object.values(INFO_CARD_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
    await renderSurface(<InfoCard tone="success" message="Saved" />);
    // The icon is decorative: drawn, but hidden from screen readers.
    expect(screen.getByText('check_circle', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText('check_circle')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'uses the tone tints of the %s theme with full-contrast words',
    async (name, theme) => {
      await renderSurface(
        <>
          {(['info', 'warning', 'success', 'danger'] as const).map((tone) => (
            <InfoCard key={tone} tone={tone} message={`${tone} note`} testID={tone} />
          ))}
        </>,
        { theme: name },
      );
      for (const tone of ['info', 'warning', 'success', 'danger'] as const) {
        expect(screen.getByTestId(tone)).toHaveStyle({
          backgroundColor: theme.toneBackgrounds[tone],
        });
        expect(screen.getByText(`${tone} note`)).toHaveStyle({ color: theme.colors.text });
        expect(
          screen.getByText(INFO_CARD_ICONS[tone], { includeHiddenElements: true }),
        ).toHaveStyle({ color: theme.colors[tone] });
      }
    },
  );

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<InfoCard message="Note" testID="card" />);
    const still = screen.getByTestId('card').props.style;
    rerender(
      <MotionProvider reduced={false}>
        <InfoCard message="Note" testID="card" />
      </MotionProvider>,
    );
    expect(screen.getByTestId('card').props.style).toEqual(still);
  });
});
