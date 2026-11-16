/**
 * Field, TextField and SearchField (ADR-008 visual system v2; SPK-UX-009 names, descriptions and
 * targets; SPK-UX-008 a field error keeps what was typed).
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { fieldAccessibility, SearchField, TextField } from '../Field';
import { MIN_TOUCH_SIZE, THEMES } from '../theme';

describe('fieldAccessibility (SPK-UX-009)', () => {
  it('names the control by its label and reads required, the hint and then the error', () => {
    expect(
      fieldAccessibility({
        label: 'Email',
        hint: 'We send receipts here',
        error: 'Enter an email address',
        required: true,
      }),
    ).toEqual({
      accessibilityLabel: 'Email',
      accessibilityHint: 'Required. We send receipts here. Error: Enter an email address.',
    });
    expect(fieldAccessibility({ label: 'Email' })).toEqual({
      accessibilityLabel: 'Email',
      accessibilityHint: undefined,
    });
  });
});

describe('TextField (ADR-008)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('SPK-UX-009: its accessible name is the label; hint and error are read after it', async () => {
    await renderUi(
      <TextField
        label="Player name"
        hint="As on the ID"
        required
        value=""
        onChangeText={() => undefined}
      />,
    );
    const input = screen.getByLabelText('Player name');
    expect(input).toHaveProp('accessibilityLabel', 'Player name');
    expect(input).toHaveProp('accessibilityHint', 'Required. As on the ID.');
    expect(screen.getByText('Required')).toBeOnTheScreen();
    expect(screen.getByText('As on the ID')).toBeOnTheScreen();
  });

  it('SPK-UX-008: shows and announces the error in words and keeps what was typed', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    const os = Platform.OS;
    Platform.OS = 'ios';
    try {
      await renderUi(
        <TextField
          label="Email"
          value="sam@"
          onChangeText={() => undefined}
          error="Enter an email address"
        />,
      );
    } finally {
      Platform.OS = os;
    }
    expect(screen.getByRole('alert')).toHaveTextContent('✕ Enter an email address');
    expect(announce).toHaveBeenCalledWith('Error: Enter an email address', { queue: true });
    const input = screen.getByLabelText('Email');
    expect(input).toHaveProp('value', 'sam@');
    expect(input).toHaveProp('accessibilityHint', 'Error: Enter an email address.');
  });

  it('SPK-UX-008: error options keep a form\'s own words: "▲", the bare message, no alert role', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    const os = Platform.OS;
    Platform.OS = 'ios';
    try {
      await renderUi(
        <TextField
          label="Amount"
          value="2x"
          onChangeText={() => undefined}
          error="Enter an amount in USD."
          errorGlyph="▲"
          errorAnnouncement="message"
          errorAlert={false}
        />,
      );
    } finally {
      Platform.OS = os;
    }
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('▲ Enter an amount in USD.')).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith('Enter an amount in USD.', { queue: true });
    expect(screen.getByLabelText('Amount')).toHaveProp(
      'accessibilityHint',
      'Error: Enter an amount in USD.',
    );
  });

  it('passes typing through and shows disabled state', async () => {
    const onChangeText = jest.fn();
    const { rerender } = await renderUi(
      <TextField label="Team name" value="" onChangeText={onChangeText} />,
    );
    fireEvent.changeText(screen.getByLabelText('Team name'), 'Vegas Lights');
    expect(onChangeText).toHaveBeenCalledWith('Vegas Lights');
    rerender(<TextField label="Team name" value="" onChangeText={onChangeText} editable={false} />);
    expect(screen.getByLabelText('Team name')).toBeDisabled();
  });

  it('is at least 44 pt tall', async () => {
    await renderUi(<TextField label="Email" value="" onChangeText={() => undefined} />);
    expect(drawnStyle(screen.getByLabelText('Email')).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_SIZE,
    );
  });

  it.each(THEME_NAMES)('draws in the %s theme with its tokens and keyboard', async (name) => {
    const { theme } = await renderUi(
      <TextField label="Email" value="" onChangeText={() => undefined} error="Required" />,
      { theme: name },
    );
    const input = screen.getByLabelText('Email');
    expect(drawnStyle(input).borderColor).toBe(theme.colors.danger);
    expect(drawnStyle(input).backgroundColor).toBe(theme.colors.background);
    expect(input).toHaveProp('keyboardAppearance', theme.dark ? 'dark' : 'light');
  });

  it('has nothing to animate: it renders the same with motion on', async () => {
    await renderUi(<TextField label="Email" value="" onChangeText={() => undefined} />, {
      motion: 'full',
    });
    expect(screen.getByLabelText('Email')).toBeOnTheScreen();
  });
});

describe('SearchField (ADR-008)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SPK-UX-009: has the search role and its label as name', async () => {
    await renderUi(
      <SearchField label="Search activities" value="" onChangeText={() => undefined} />,
    );
    const input = screen.getByRole('search', { name: 'Search activities' });
    expect(input).toHaveProp('placeholder', 'Search activities');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('a clear button (44 pt) empties the field and searches at once', async () => {
    const onChangeText = jest.fn();
    const onSearch = jest.fn();
    await renderUi(
      <SearchField
        value="futsal"
        onChangeText={onChangeText}
        onSearch={onSearch}
        debounceMs={300}
      />,
    );
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(drawnStyle(clear).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    expect(drawnStyle(clear).minWidth).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    fireEvent.press(clear);
    expect(onChangeText).toHaveBeenCalledWith('');
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('debounces the search by debounceMs, on timers tests control', async () => {
    jest.useFakeTimers();
    const onSearch = jest.fn();
    await renderUi(
      <SearchField value="" onChangeText={() => undefined} onSearch={onSearch} debounceMs={300} />,
    );
    const input = screen.getByRole('search', { name: 'Search' });
    fireEvent.changeText(input, 'so');
    act(() => jest.advanceTimersByTime(200));
    fireEvent.changeText(input, 'soc');
    act(() => jest.advanceTimersByTime(299));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('soc');
  });

  it('searches at once without a debounce, and on the search key', async () => {
    const onSearch = jest.fn();
    await renderUi(<SearchField value="camp" onChangeText={() => undefined} onSearch={onSearch} />);
    const input = screen.getByRole('search', { name: 'Search' });
    fireEvent.changeText(input, 'camps');
    expect(onSearch).toHaveBeenLastCalledWith('camps');
    fireEvent(input, 'submitEditing');
    expect(onSearch).toHaveBeenLastCalledWith('camp');
  });

  it.each(THEME_NAMES)('draws in the %s theme on the surface token', async (name) => {
    await renderUi(<SearchField value="" onChangeText={() => undefined} testID="search" />, {
      theme: name,
      motion: 'full',
    });
    expect(drawnStyle(screen.getByTestId('search-box')).backgroundColor).toBe(
      THEMES[name].colors.surface,
    );
  });
});
