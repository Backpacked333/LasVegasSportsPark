/**
 * StickyActionBar (ADR-008, SPK-UX-009): a summary read as one element and the primary action with
 * its busy and disabled states, on the `bar` elevation.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { StickyActionBar } from '../StickyActionBar';
import { buttonHeight, classicTheme, elevation, legendsTheme } from '../theme';

describe('StickyActionBar (ADR-008)', () => {
  it('SPK-UX-009: reads the summary as one element and offers the action as a 56 pt button (44 pt or more)', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <StickyActionBar
        summaryLabel="Total"
        summaryValue="$240.00"
        summaryNote="Includes fees"
        action={{ label: 'Review', onPress }}
      />,
    );
    expect(screen.getByLabelText('Total, $240.00, Includes fees')).toBeOnTheScreen();
    expect(screen.getByText('$240.00')).toHaveStyle({ fontVariant: ['tabular-nums'] });
    const button = screen.getByRole('button', { name: 'Review' });
    expect(StyleSheet.flatten(button.props.style).minHeight).toBe(buttonHeight.sticky);
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('SPK-UX-008: exposes busy and disabled, and never presses while busy', async () => {
    const onPress = jest.fn();
    const { rerender } = await renderSurface(
      <StickyActionBar action={{ label: 'Pay', onPress, busy: true }} />,
    );
    const busy = screen.getByRole('button', { name: 'Pay' });
    expect(busy).toBeBusy();
    expect(busy).toBeDisabled();
    fireEvent.press(busy);
    rerender(<StickyActionBar action={{ label: 'Pay', onPress, disabled: true }} />);
    expect(screen.getByRole('button', { name: 'Pay' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Pay' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('takes custom summary content instead of a label and a value', async () => {
    await renderSurface(
      <StickyActionBar action={{ label: 'Continue', onPress: () => undefined }}>
        <Text>2 players selected</Text>
      </StickyActionBar>,
    );
    expect(screen.getByText('2 players selected')).toBeOnTheScreen();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('sits on the bar elevation of the %s theme', async (name, theme) => {
    await renderSurface(
      <StickyActionBar testID="bar" action={{ label: 'Continue', onPress: () => undefined }} />,
      { theme: name },
    );
    const level = elevation(theme, 'bar');
    expect(screen.getByTestId('bar')).toHaveStyle(
      theme.dark
        ? { backgroundColor: level.backgroundColor, borderColor: theme.colors.border }
        : { backgroundColor: level.backgroundColor, boxShadow: level.boxShadow as string },
    );
  });

  it('SPK-UX-009 reduced motion: is the same bar with or without motion', async () => {
    const bar = <StickyActionBar testID="bar" action={{ label: 'Go', onPress: () => undefined }} />;
    const { rerender } = await renderSurface(bar);
    const still = screen.getByTestId('bar').props.style;
    rerender(<MotionProvider reduced={false}>{bar}</MotionProvider>);
    expect(screen.getByTestId('bar').props.style).toEqual(still);
  });
});
