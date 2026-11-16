/**
 * StatTile (ADR-008, SPK-UX-009): label, value in tabular figures, sublabel and tone, read as one
 * element.
 */
import { screen } from '@testing-library/react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { StatTile } from '../StatTile';
import { classicTheme, elevation, legendsTheme } from '../theme';

describe('StatTile (ADR-008)', () => {
  it('SPK-UX-009: reads label, value and sublabel as one element that is not a control', async () => {
    await renderSurface(<StatTile label="Games played" value="8" sublabel="2 this week" />);
    expect(screen.getByLabelText('Games played, 8, 2 this week')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('SPK-UX-010: draws the value in tabular figures, so digits do not shift', async () => {
    await renderSurface(<StatTile label="Balance" value="$40.00" />);
    expect(screen.getByText('$40.00')).toHaveStyle({ fontVariant: ['tabular-nums'] });
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'sits on the card level and colours a toned value in the %s theme',
    async (name, theme) => {
      await renderSurface(
        <>
          <StatTile label="Amount due" value="$20.00" tone="warning" sublabel="Due Friday" />
          <StatTile label="Wins" value="5" />
        </>,
        { theme: name },
      );
      expect(screen.getByLabelText('Amount due, $20.00, Due Friday')).toHaveStyle({
        backgroundColor: elevation(theme, 'card').backgroundColor,
      });
      expect(screen.getByText('$20.00')).toHaveStyle({ color: theme.colors.warning });
      expect(screen.getByText('5')).toHaveStyle({ color: theme.colors.text });
      // The tone is never alone: the sublabel says what it means.
      expect(screen.getByText('Due Friday')).toBeOnTheScreen();
    },
  );

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<StatTile label="Wins" value="5" />);
    const still = screen.getByLabelText('Wins, 5').props.style;
    rerender(
      <MotionProvider reduced={false}>
        <StatTile label="Wins" value="5" />
      </MotionProvider>,
    );
    expect(screen.getByLabelText('Wins, 5').props.style).toEqual(still);
  });

  it('ADR-008: a plain tile has no card of its own (inside another card) and reads the same', async () => {
    await renderSurface(<StatTile plain label="Standing" value="1st" sublabel="of 4 teams" />);
    const tile = screen.getByLabelText('Standing, 1st, of 4 teams');
    expect(tile).not.toHaveStyle({ flex: 1 });
    expect(tile).not.toHaveStyle({ borderRadius: expect.any(Number) });
  });
});
