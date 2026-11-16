/**
 * Select (ADR-008 visual system v2; SPK-UX-009 a button named by its label with the current
 * choice as its value, a sheet of radios, focus back to the button). Driven through
 * `chooseInSheet` (src/testing/ui.ts), as screen tests will.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { chooseInSheet } from '../../testing/ui';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import type { ChoiceOption } from '../ChoiceList';
import { Select } from '../Select';
import { MIN_TOUCH_SIZE } from '../theme';

type Size = 's' | 'm' | 'l';
const SIZES: readonly ChoiceOption<Size>[] = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium', trailing: 'Most chosen' },
  { value: 'l', label: 'Large', disabled: true },
];

function ShirtSize({ error }: { error?: string }) {
  const [value, setValue] = useState<Size | null>(null);
  return (
    <Select
      label="Shirt size"
      hint="Adult sizes"
      required
      error={error}
      value={value}
      options={SIZES}
      onChange={setValue}
    />
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Select (ADR-008)', () => {
  it('SPK-UX-009: is a button named by its label, with the choice as its value', async () => {
    await renderUi(<ShirtSize />);
    const button = screen.getByRole('button', { name: 'Shirt size' });
    expect(button).toHaveAccessibilityValue({ text: 'Choose' });
    expect(button).toHaveProp('accessibilityHint', 'Required. Adult sizes.');
    expect(button).toBeCollapsed();
  });

  it('opens a sheet of radios; choosing closes it and shows the choice', async () => {
    const { haptics } = await renderUi(<ShirtSize />);
    await chooseInSheet(screen, 'Shirt size', 'Medium, Most chosen');
    expect(screen.queryByTestId('sheet')).toBeNull();
    const button = screen.getByRole('button', { name: 'Shirt size' });
    expect(button).toHaveAccessibilityValue({ text: 'Medium' });
    expect(screen.getByText('Medium')).toBeOnTheScreen();
    expect(haptics.events).toEqual(['selection']);
  });

  it('marks the current option checked and disabled options disabled', async () => {
    await renderUi(<ShirtSize />);
    await chooseInSheet(screen, 'Shirt size', 'Small');
    fireEvent.press(screen.getByRole('button', { name: 'Shirt size' }));
    expect(screen.getByRole('radio', { name: 'Small' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Large' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Shirt size', includeHiddenElements: true }),
    ).toBeExpanded();
  });

  it('SPK-UX-009: focus goes back to the button when the sheet closes', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    await renderUi(<ShirtSize />);
    fireEvent.press(screen.getByRole('button', { name: 'Shirt size' }));
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
    expect(focus.mock.calls[1]![0]).toBeTruthy();
    expect(focus.mock.calls[1]![1]).toBe('focus');
    expect(focus.mock.calls[1]![0]).not.toBe(focus.mock.calls[0]![0]);
  });

  it('shows its error in words and is at least 44 pt', async () => {
    await renderUi(<ShirtSize error="Choose a size" />);
    expect(screen.getByRole('alert')).toHaveTextContent('✕ Choose a size');
    const button = screen.getByRole('button', { name: 'Shirt size' });
    expect(button).toHaveProp('accessibilityHint', 'Required. Adult sizes. Error: Choose a size.');
    expect(drawnStyle(button).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
  });

  it.each(THEME_NAMES)('draws as a field in the %s theme', async (name) => {
    const { theme } = await renderUi(<ShirtSize />, { theme: name });
    const box = drawnStyle(screen.getByRole('button', { name: 'Shirt size' }));
    expect(box.borderColor).toBe(theme.colors.control);
    expect(box.backgroundColor).toBe(theme.colors.background);
  });

  it('chooses the same way with motion on', async () => {
    await renderUi(<ShirtSize />, { motion: 'full' });
    await chooseInSheet(screen, 'Shirt size', 'Small');
    expect(screen.getByRole('button', { name: 'Shirt size' })).toHaveAccessibilityValue({
      text: 'Small',
    });
  });
});
