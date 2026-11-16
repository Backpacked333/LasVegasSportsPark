/**
 * SegmentedControl (ADR-008 visual system v2; SPK-UX-009 the tab or radio-group pattern with the
 * selected state exposed, 44 pt segments, the selection not shown by colour alone).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { SegmentedControl, type Segment } from '../SegmentedControl';
import { elevation, fonts, MIN_TOUCH_SIZE } from '../theme';

type When = 'upcoming' | 'past';
const WHEN: readonly Segment<When>[] = [
  { value: 'upcoming', label: 'Upcoming', accessibilityLabel: 'Upcoming sessions' },
  { value: 'past', label: 'Past' },
];

function Tabs({ pattern }: { pattern?: 'tabs' | 'radio' }) {
  const [value, setValue] = useState<When>('upcoming');
  return (
    <SegmentedControl
      label="Show"
      segments={WHEN}
      value={value}
      onChange={setValue}
      pattern={pattern}
    />
  );
}

describe('SegmentedControl (ADR-008)', () => {
  it('SPK-UX-009: the tabs pattern is a tablist of tabs with selected', async () => {
    const { haptics } = await renderUi(<Tabs />);
    expect(screen.getByLabelText('Show')).toHaveProp('accessibilityRole', 'tablist');
    expect(screen.getByRole('tab', { name: 'Upcoming sessions' })).toBeSelected();
    fireEvent.press(screen.getByRole('tab', { name: 'Past' }));
    expect(screen.getByRole('tab', { name: 'Past' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Upcoming sessions' })).not.toBeSelected();
    expect(haptics.events).toEqual(['selection']);
    // The current segment again: nothing changes, nothing plays.
    fireEvent.press(screen.getByRole('tab', { name: 'Past' }));
    expect(haptics.events).toEqual(['selection']);
  });

  it('SPK-UX-009: the radio pattern is a radiogroup of radios with checked', async () => {
    await renderUi(<Tabs pattern="radio" />);
    expect(screen.getByLabelText('Show')).toHaveProp('accessibilityRole', 'radiogroup');
    expect(screen.getByRole('radio', { name: 'Upcoming sessions' })).toBeChecked();
    fireEvent.press(screen.getByRole('radio', { name: 'Past' }));
    expect(screen.getByRole('radio', { name: 'Past' })).toBeChecked();
  });

  it('every segment is at least 44 pt', async () => {
    await renderUi(<Tabs />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(drawnStyle(tab).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    }
  });

  it.each(THEME_NAMES)('raises the selected segment in the %s theme', async (name) => {
    const { theme } = await renderUi(<Tabs />, { theme: name });
    const selected = drawnStyle(screen.getByRole('tab', { name: 'Upcoming sessions' }));
    expect(selected.backgroundColor).toBe(elevation(theme, 'raised').backgroundColor);
    expect(screen.getByText('Upcoming')).toHaveStyle({
      color: theme.colors.text,
      fontFamily: fonts.semibold.fontFamily,
    });
    expect(screen.getByText('Past')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('switches at once with motion on', async () => {
    await renderUi(<Tabs />, { motion: 'full' });
    fireEvent.press(screen.getByRole('tab', { name: 'Past' }));
    expect(screen.getByRole('tab', { name: 'Past' })).toBeSelected();
  });
});
