/**
 * ChoiceList (ADR-008 visual system v2; SPK-UX-009 role, name and checked state; SPK-UX-010
 * simple customer choices): radio and checkbox cards, disabled options, a trailing price, the
 * group error read with each card, and a selection haptic that never stands alone.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { ChoiceList, choiceName, type ChoiceOption } from '../ChoiceList';
import { MIN_TOUCH_SIZE } from '../theme';

type Day = 'sat' | 'sun' | 'mon';
const DAYS: readonly ChoiceOption<Day>[] = [
  { value: 'sat', label: 'Saturday', description: 'Morning session', trailing: '$40.00' },
  { value: 'sun', label: 'Sunday' },
  { value: 'mon', label: 'Monday', disabled: true, description: 'Full' },
];

function Single({ initial = null }: { initial?: Day | null }) {
  const [value, setValue] = useState<Day | null>(initial);
  return <ChoiceList label="Day" mode="single" options={DAYS} value={value} onChange={setValue} />;
}

function Multiple() {
  const [value, setValue] = useState<Day[]>([]);
  return (
    <ChoiceList label="Days" mode="multiple" options={DAYS} value={value} onChange={setValue} />
  );
}

describe('ChoiceList (ADR-008)', () => {
  it('names a card by its label, trailing words and description', () => {
    expect(choiceName(DAYS[0]!)).toBe('Saturday, $40.00, Morning session');
    expect(choiceName({ value: 'x', label: 'Kit', trailing: null, trailingLabel: 'Free' })).toBe(
      'Kit, Free',
    );
  });

  it('SPK-UX-009: single mode is a radio group whose cards expose checked', async () => {
    const { haptics } = await renderUi(<Single />);
    // A group is not an element of its own (that would merge its cards): its role and name are props.
    expect(screen.getByLabelText('Day')).toHaveProp('accessibilityRole', 'radiogroup');
    const saturday = screen.getByRole('radio', { name: 'Saturday, $40.00, Morning session' });
    expect(saturday).not.toBeChecked();
    fireEvent.press(saturday);
    expect(screen.getByRole('radio', { name: 'Saturday, $40.00, Morning session' })).toBeChecked();
    expect(haptics.events).toEqual(['selection']);
    // The chosen card again changes nothing and plays nothing.
    fireEvent.press(screen.getByRole('radio', { name: 'Saturday, $40.00, Morning session' }));
    expect(haptics.events).toEqual(['selection']);
    fireEvent.press(screen.getByRole('radio', { name: 'Sunday' }));
    expect(screen.getByRole('radio', { name: 'Sunday' })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Saturday, $40.00, Morning session' }),
    ).not.toBeChecked();
  });

  it('SPK-UX-009: multiple mode is checkboxes kept in the options order', async () => {
    const onChange = jest.fn();
    const { haptics, rerender } = await renderUi(
      <ChoiceList
        label="Days"
        mode="multiple"
        options={DAYS}
        value={['sun']}
        onChange={onChange}
      />,
    );
    fireEvent.press(screen.getByRole('checkbox', { name: 'Saturday, $40.00, Morning session' }));
    expect(onChange).toHaveBeenLastCalledWith(['sat', 'sun']);
    fireEvent.press(screen.getByRole('checkbox', { name: 'Sunday' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(haptics.events).toEqual(['selection', 'selection']);
    rerender(<Multiple />);
    fireEvent.press(screen.getByRole('checkbox', { name: 'Sunday' }));
    expect(screen.getByRole('checkbox', { name: 'Sunday' })).toBeChecked();
  });

  it('a disabled option is announced as disabled and cannot be chosen', async () => {
    const { haptics } = await renderUi(<Single />);
    const monday = screen.getByRole('radio', { name: 'Monday, Full' });
    expect(monday).toBeDisabled();
    fireEvent.press(monday);
    expect(screen.getByRole('radio', { name: 'Monday, Full' })).not.toBeChecked();
    expect(haptics.events).toEqual([]);
  });

  it('SPK-UX-009: the group error is shown and read with every card', async () => {
    await renderUi(
      <ChoiceList
        label="Day"
        mode="single"
        options={DAYS}
        value={null}
        onChange={() => undefined}
        error="Choose a day"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('✕ Choose a day');
    expect(screen.getByRole('radio', { name: 'Sunday' })).toHaveProp(
      'accessibilityHint',
      'Error: Choose a day',
    );
  });

  it('every card is at least 44 pt', async () => {
    await renderUi(<Single />);
    for (const card of screen.getAllByRole('radio')) {
      expect(drawnStyle(card).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    }
  });

  it.each(THEME_NAMES)('marks the chosen card with the %s tokens', async (name) => {
    const { theme } = await renderUi(<Single initial="sun" />, { theme: name });
    const chosen = drawnStyle(screen.getByRole('radio', { name: 'Sunday' }));
    expect(chosen.borderColor).toBe(theme.colors.primary);
    expect(chosen.backgroundColor).toBe(theme.colors.tonal);
    expect(drawnStyle(screen.getByRole('radio', { name: /^Saturday/ })).backgroundColor).toBe(
      theme.colors.background,
    );
  });

  it('chooses the same way with motion on (nothing in it waits for an animation)', async () => {
    await renderUi(<Single />, { motion: 'full' });
    fireEvent.press(screen.getByRole('radio', { name: 'Sunday' }));
    expect(screen.getByRole('radio', { name: 'Sunday' })).toBeChecked();
  });
});
