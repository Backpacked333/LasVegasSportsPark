/**
 * Text fields show their focus and follow the theme (`useInputChrome`; SPK-UX-009 visible focus,
 * SPK-UX-010 one visual system): checked on the account form's field, which every form shares.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TextField } from '../../screens/account/components/forms';
import { ThemeProvider } from '../ThemeProvider';
import { classicTheme, legendsTheme } from '../theme';
import { MemoryThemeStore } from '../theme-preference';

const flat = (element: { props: { style?: unknown } }) =>
  StyleSheet.flatten(element.props.style as never) as Record<string, unknown>;

describe('text field focus and theme', () => {
  it('a focused field takes the focus colour and gives it back on blur', () => {
    render(<TextField label="Email" value="" onChangeText={() => undefined} testID="field" />);
    const field = screen.getByTestId('field');
    expect(flat(field).borderColor).toBe(classicTheme.colors.control);
    fireEvent(field, 'focus');
    expect(flat(screen.getByTestId('field')).borderColor).toBe(classicTheme.colors.focus);
    fireEvent(screen.getByTestId('field'), 'blur');
    expect(flat(screen.getByTestId('field')).borderColor).toBe(classicTheme.colors.control);
  });

  it('an error keeps its own border while the field is focused', () => {
    render(
      <TextField
        label="Email"
        value="x"
        onChangeText={() => undefined}
        error="Enter an email address"
        testID="field"
      />,
    );
    fireEvent(screen.getByTestId('field'), 'focus');
    expect(flat(screen.getByTestId('field')).borderColor).toBe(classicTheme.colors.danger);
  });

  it('in Legends mode the keyboard is dark and the caret and focus are gold', () => {
    render(
      <ThemeProvider store={new MemoryThemeStore('legends')}>
        <TextField label="Email" value="" onChangeText={() => undefined} testID="field" />
      </ThemeProvider>,
    );
    const field = screen.getByTestId('field');
    expect(field).toHaveProp('keyboardAppearance', 'dark');
    expect(field).toHaveProp('selectionColor', legendsTheme.colors.primary);
    fireEvent(field, 'focus');
    expect(flat(screen.getByTestId('field')).borderColor).toBe(legendsTheme.colors.focus);
  });
});
