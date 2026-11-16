/**
 * Chip and ChipRow (ADR-008 visual system v2; SPK-UX-009 chips expose `selected`, 44 pt targets,
 * selection shown by a check and a tonal fill, never colour alone).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { Chip, ChipRow, type ChipOption } from '../Chip';
import { MIN_TOUCH_SIZE } from '../theme';

type Sport = 'soccer' | 'futsal' | 'basketball';
const SPORTS: readonly ChipOption<Sport>[] = [
  { value: 'soccer', label: 'Soccer' },
  { value: 'futsal', label: 'Futsal' },
  { value: 'basketball', label: 'Basketball', disabled: true },
];

function SingleRow({ allowEmpty = false }: { allowEmpty?: boolean }) {
  const [value, setValue] = useState<Sport | null>('soccer');
  return (
    <ChipRow
      label="Sport"
      mode="single"
      options={SPORTS}
      value={value}
      onChange={setValue}
      allowEmpty={allowEmpty}
    />
  );
}

function MultipleRow() {
  const [value, setValue] = useState<Sport[]>([]);
  return (
    <ChipRow label="Sport" mode="multiple" options={SPORTS} value={value} onChange={setValue} />
  );
}

describe('Chip (ADR-008)', () => {
  it('SPK-UX-009: a selectable chip is a button that exposes selected', async () => {
    const onPress = jest.fn();
    const { haptics, rerender } = await renderUi(
      <Chip label="Weekends" selected={false} onPress={onPress} />,
    );
    const chip = screen.getByRole('button', { name: 'Weekends' });
    expect(chip).not.toBeSelected();
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.events).toEqual(['selection']);
    rerender(<Chip label="Weekends" selected onPress={onPress} />);
    expect(screen.getByRole('button', { name: 'Weekends' })).toBeSelected();
  });

  it('a plain chip is an action: no selected state and no selection haptic', async () => {
    const onPress = jest.fn();
    const { haptics } = await renderUi(<Chip label="Add filter" icon="add" onPress={onPress} />);
    const chip = screen.getByRole('button', { name: 'Add filter' });
    expect(chip.props.accessibilityState).toEqual({ disabled: false });
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.events).toEqual([]);
  });

  it('is at least 44 pt tall', async () => {
    await renderUi(<Chip label="Weekends" selected={false} />);
    expect(
      drawnStyle(screen.getByRole('button', { name: 'Weekends' })).minHeight,
    ).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
  });

  it.each(THEME_NAMES)('is tonal when selected in the %s theme', async (name) => {
    const { theme, rerender } = await renderUi(<Chip label="Weekends" selected={false} />, {
      theme: name,
    });
    expect(drawnStyle(screen.getByRole('button', { name: 'Weekends' })).backgroundColor).toBe(
      theme.colors.background,
    );
    rerender(<Chip label="Weekends" selected />);
    expect(drawnStyle(screen.getByRole('button', { name: 'Weekends' })).backgroundColor).toBe(
      theme.colors.tonal,
    );
    // The check glyph shows it too.
    expect(screen.getByText('check', { includeHiddenElements: true })).toBeOnTheScreen();
  });
});

describe('ChipRow (ADR-008)', () => {
  it('single selection moves the selected state; the selected chip stays without allowEmpty', async () => {
    const { haptics } = await renderUi(<SingleRow />);
    expect(screen.getByLabelText('Sport')).toHaveProp('accessibilityRole', 'toolbar');
    expect(screen.getByRole('button', { name: 'Soccer' })).toBeSelected();
    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    expect(screen.getByRole('button', { name: 'Futsal' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Soccer' })).not.toBeSelected();
    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    expect(screen.getByRole('button', { name: 'Futsal' })).toBeSelected();
    expect(haptics.events.length).toBeGreaterThanOrEqual(1);
  });

  it('allowEmpty clears the choice when the selected chip is pressed again', async () => {
    await renderUi(<SingleRow allowEmpty />);
    fireEvent.press(screen.getByRole('button', { name: 'Soccer' }));
    expect(screen.getByRole('button', { name: 'Soccer' })).not.toBeSelected();
  });

  it('multiple selection toggles each chip; a disabled chip cannot be chosen', async () => {
    await renderUi(<MultipleRow />);
    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    fireEvent.press(screen.getByRole('button', { name: 'Soccer' }));
    expect(screen.getByRole('button', { name: 'Futsal' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Soccer' })).toBeSelected();
    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    expect(screen.getByRole('button', { name: 'Futsal' })).not.toBeSelected();
    expect(screen.getByRole('button', { name: 'Basketball' })).toBeDisabled();
  });

  it('takes plain chips as children, with motion on as well', async () => {
    await renderUi(
      <ChipRow label="Quick filters">
        <Chip label="Today" onPress={() => undefined} />
        <Chip label="This week" onPress={() => undefined} />
      </ChipRow>,
      { motion: 'full' },
    );
    expect(screen.getByRole('button', { name: 'This week' })).toBeOnTheScreen();
  });
});
