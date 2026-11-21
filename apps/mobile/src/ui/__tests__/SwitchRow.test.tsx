/**
 * SwitchRow (ADR-008 visual system v2; SPK-UX-009 a switch with its name, checked state and the
 * words "On"/"Off", one 44 pt target; a haptic is never the only feedback).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Switch } from 'react-native';
import {
  drawnStyle,
  isHiddenFromScreenReaders,
  renderUi,
  THEME_NAMES,
} from '../../testing/ui-actions';
import { SwitchRow } from '../SwitchRow';
import { classicTheme, legendsTheme, MIN_TOUCH_SIZE } from '../theme';

function Reminders({ disabled = false }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <SwitchRow
      label="Session reminders"
      description="The evening before"
      value={on}
      onChange={setOn}
      disabled={disabled}
    />
  );
}

describe('SwitchRow (ADR-008)', () => {
  it('SPK-UX-009: the row is one switch named by its label, with checked state', async () => {
    const { haptics } = await renderUi(<Reminders />);
    const row = screen.getByRole('switch', { name: 'Session reminders' });
    expect(row).not.toBeChecked();
    expect(row).toHaveProp('accessibilityHint', 'The evening before');
    expect(screen.getByText('Off. The evening before')).toBeOnTheScreen();
    fireEvent.press(row);
    expect(screen.getByRole('switch', { name: 'Session reminders' })).toBeChecked();
    expect(screen.getByText('On. The evening before')).toBeOnTheScreen();
    expect(haptics.events).toEqual(['selection']);
  });

  it('the drawn switch only shows the state and is hidden from screen readers', async () => {
    await renderUi(<Reminders />);
    const drawn = screen.UNSAFE_getByType(Switch);
    expect(isHiddenFromScreenReaders(drawn.parent!)).toBe(true);
    fireEvent(drawn, 'valueChange', true);
    expect(screen.getByRole('switch', { name: 'Session reminders' })).toBeChecked();
  });

  it('a disabled row says so and does not change', async () => {
    const { haptics } = await renderUi(<Reminders disabled />);
    const row = screen.getByRole('switch', { name: 'Session reminders' });
    expect(row).toBeDisabled();
    fireEvent.press(row);
    expect(screen.getByRole('switch', { name: 'Session reminders' })).not.toBeChecked();
    expect(haptics.events).toEqual([]);
  });

  it('a fuller accessible name can carry its section', async () => {
    await renderUi(
      <SwitchRow
        label="Email"
        accessibilityLabel="Email for essential notices"
        value
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Email for essential notices' })).toBeChecked();
  });

  it('is at least 44 pt tall', async () => {
    await renderUi(<Reminders />);
    expect(
      drawnStyle(screen.getByRole('switch', { name: 'Session reminders' })).minHeight,
    ).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
  });

  it.each(THEME_NAMES)('tracks with the %s theme tokens', async (name) => {
    const { theme } = await renderUi(<Reminders />, { theme: name });
    expect(screen.UNSAFE_getByType(Switch).props.trackColor).toEqual({
      false: theme.colors.control,
      true: theme.colors.primary,
    });
    // ADR-008: a light thumb, never the platform's teal (which sat on the accent in Legends mode).
    expect(screen.UNSAFE_getByType(Switch).props.thumbColor).toBe(
      name === 'legends' ? legendsTheme.colors.text : classicTheme.colors.background,
    );
  });

  it('toggles at once with motion on', async () => {
    await renderUi(<Reminders />, { motion: 'full' });
    fireEvent.press(screen.getByRole('switch', { name: 'Session reminders' }));
    expect(screen.getByRole('switch', { name: 'Session reminders' })).toBeChecked();
  });
});
