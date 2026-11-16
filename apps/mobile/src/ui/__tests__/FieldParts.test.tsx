/**
 * The field pieces added to `ui/Field` for the feature kits' adapters (ADR-008, Phase 3):
 * `FieldErrorText` (an error with its glyph, announced as the bare message), `FieldInput` (the
 * outlined input with focus chrome and no words of its own) and `FieldValue` (a read-only
 * "label: value" fact read as one element). SPK-UX-008, SPK-UX-009.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { drawnStyle, renderUi } from '../../testing/ui-actions';
import { FieldErrorText, FieldInput, FieldValue } from '../Field';
import { classicTheme } from '../theme';

/** Renders on iOS, so `LiveText` posts its words to VoiceOver; returns what was posted. */
async function renderOnIos(element: ReactElement): Promise<() => string[]> {
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  const os = Platform.OS;
  Platform.OS = 'ios';
  try {
    await renderUi(element);
  } finally {
    Platform.OS = os;
  }
  await act(async () => {
    await Promise.resolve();
  });
  return () => announce.mock.calls.map(([words]) => words);
}

describe('FieldErrorText (ADR-008)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('SPK-UX-008: shows the error with its glyph and announces the bare message as an alert', async () => {
    const announced = await renderOnIos(
      <FieldErrorText error="Choose a time." glyph="▲" testID="error" />,
    );
    const error = screen.getByTestId('error');
    expect(error).toHaveTextContent('▲ Choose a time.');
    expect(error).toHaveProp('accessibilityRole', 'alert');
    expect(error).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(announced()).toEqual(['Choose a time.']);
  });

  it('draws "✕" by default, can leave out the alert role and announce other words', async () => {
    const announced = await renderOnIos(
      <FieldErrorText
        error="Enter a reason."
        alert={false}
        announcement="Reason: Enter a reason."
        testID="error"
      />,
    );
    expect(screen.getByTestId('error')).toHaveTextContent('✕ Enter a reason.');
    expect(screen.getByTestId('error')).not.toHaveProp('accessibilityRole', 'alert');
    expect(announced()).toEqual(['Reason: Enter a reason.']);
  });

  it('renders nothing without an error', async () => {
    await renderUi(<FieldErrorText error={null} testID="error" />);
    expect(screen.queryByTestId('error')).toBeNull();
  });
});

describe('FieldInput (ADR-008)', () => {
  it('SPK-UX-009: carries only the words the caller gives it', async () => {
    await renderUi(
      <FieldInput
        value="Sam"
        onChangeText={() => undefined}
        accessibilityLabel="Name. Too short"
        accessibilityHint="As on the ID"
        testID="input"
      />,
    );
    const input = screen.getByTestId('input');
    expect(input).toHaveProp('accessibilityLabel', 'Name. Too short');
    expect(input).toHaveProp('accessibilityHint', 'As on the ID');
    expect(input).not.toHaveProp('accessibilityState');
    expect(input).toHaveProp('value', 'Sam');
  });

  it('shows its focus; the error border wins over it; a read-only input is filled', async () => {
    const onFocus = jest.fn();
    const { rerender } = await renderUi(
      <FieldInput value="" onChangeText={() => undefined} onFocus={onFocus} testID="input" />,
    );
    expect(drawnStyle(screen.getByTestId('input')).borderColor).toBe(classicTheme.colors.control);
    fireEvent(screen.getByTestId('input'), 'focus');
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(drawnStyle(screen.getByTestId('input')).borderColor).toBe(classicTheme.colors.focus);
    rerender(
      <FieldInput
        value=""
        onChangeText={() => undefined}
        invalid
        editable={false}
        testID="input"
      />,
    );
    const drawn = drawnStyle(screen.getByTestId('input'));
    expect(drawn.borderColor).toBe(classicTheme.colors.danger);
    expect(drawn.backgroundColor).toBe(classicTheme.colors.surface);
    expect(screen.getByTestId('input')).toHaveProp('editable', false);
  });
});

describe('FieldValue (ADR-008)', () => {
  it('SPK-UX-009: a fact is one element read "label: value", stacked or inline', async () => {
    const { rerender } = await renderUi(<FieldValue label="Amount" value="$40.00" testID="fact" />);
    expect(screen.getByLabelText('Amount: $40.00')).toBe(screen.getByTestId('fact'));
    expect(screen.getByText('Amount')).toBeOnTheScreen();
    expect(screen.getByText('$40.00')).toBeOnTheScreen();
    expect(drawnStyle(screen.getByTestId('fact')).flexDirection).toBeUndefined();
    rerender(<FieldValue label="Total" value="$80.00" layout="inline" emphasis testID="fact" />);
    expect(screen.getByLabelText('Total: $80.00')).toBeOnTheScreen();
    expect(drawnStyle(screen.getByTestId('fact')).flexDirection).toBe('row');
  });
});
