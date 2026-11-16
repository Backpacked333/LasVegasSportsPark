/**
 * DateStrip (ADR-008 visual system v2; SPK-UX-009 full-date names and the selected state;
 * SPK-SCHED-008 "today" on the facility's clock; SPK-UX-010 a slide only with motion on).
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { getAnimatedStyle } from 'react-native-reanimated';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { DateStrip, todayIn, weekStartOf, weekTitle } from '../DateStrip';
import { MIN_TOUCH_SIZE } from '../theme';

// 07:00 UTC on Wednesday 18 November is still Tuesday 17 November in Las Vegas.
const NOW = new Date('2026-11-18T07:00:00.000Z');
const ZONE = 'America/Los_Angeles';

function Schedule({
  onWeekChange,
  initial = '2026-11-18',
}: {
  onWeekChange?: (start: string) => void;
  initial?: string;
}) {
  const [day, setDay] = useState(initial);
  return (
    <DateStrip
      value={day}
      onChange={setDay}
      today={NOW}
      timeZone={ZONE}
      markedDates={['2026-11-19']}
      onWeekChange={onWeekChange}
    />
  );
}

function translateX(): number {
  const style = getAnimatedStyle(screen.getByTestId('date-strip-days')) as {
    transform?: { translateX: number }[];
  };
  return style.transform?.[0]?.translateX ?? 0;
}

describe('DateStrip dates', () => {
  it('SPK-SCHED-008: today is the day on the facility clock, never the system clock', () => {
    expect(todayIn(NOW, ZONE)).toBe('2026-11-17');
    expect(todayIn(NOW, 'UTC')).toBe('2026-11-18');
    expect(todayIn('2026-11-20')).toBe('2026-11-20');
  });

  it('starts weeks on Sunday or Monday and names the month or months', () => {
    expect(weekStartOf('2026-11-18')).toBe('2026-11-15');
    expect(weekStartOf('2026-11-18', 1)).toBe('2026-11-16');
    expect(weekTitle('2026-11-15')).toBe('November 2026');
    expect(weekTitle('2026-11-29')).toBe('November to December 2026');
    expect(weekTitle('2026-12-27')).toBe('December 2026 to January 2027');
  });
});

describe('DateStrip (ADR-008)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SPK-UX-009: shows a short label and names each day in full', async () => {
    await renderUi(<Schedule />);
    const day = screen.getByRole('button', { name: 'Friday 20 November' });
    expect(day).toHaveTextContent('Fri20');
    expect(screen.getByRole('button', { name: 'Tuesday 17 November, today' })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Thursday 19 November, has activities' }),
    ).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /November/ })).toHaveLength(7);
  });

  it('SPK-UX-009: the chosen day is selected; a new day plays the selection haptic', async () => {
    const { haptics } = await renderUi(<Schedule />);
    expect(screen.getByRole('button', { name: 'Wednesday 18 November' })).toBeSelected();
    fireEvent.press(screen.getByRole('button', { name: 'Friday 20 November' }));
    expect(screen.getByRole('button', { name: 'Friday 20 November' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Wednesday 18 November' })).not.toBeSelected();
    expect(haptics.events).toEqual(['selection']);
  });

  it('moves a week back and forward, and Today comes back to today', async () => {
    const onWeekChange = jest.fn();
    await renderUi(<Schedule onWeekChange={onWeekChange} />);
    fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
    expect(onWeekChange).toHaveBeenLastCalledWith('2026-11-22');
    expect(screen.getByText('November 2026')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sunday 22 November' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByText('November to December 2026')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Previous week' }));
    fireEvent.press(screen.getByRole('button', { name: 'Previous week' }));
    fireEvent.press(screen.getByRole('button', { name: 'Previous week' }));
    expect(onWeekChange).toHaveBeenLastCalledWith('2026-11-08');
    fireEvent.press(screen.getByRole('button', { name: 'Today' }));
    expect(onWeekChange).toHaveBeenLastCalledWith('2026-11-15');
    expect(screen.getByRole('button', { name: 'Tuesday 17 November, today' })).toBeSelected();
  });

  it('a day chosen from above brings its week into view', async () => {
    const { rerender } = await renderUi(
      <DateStrip value="2026-11-18" onChange={() => undefined} today={NOW} timeZone={ZONE} />,
    );
    rerender(
      <DateStrip value="2026-12-02" onChange={() => undefined} today={NOW} timeZone={ZONE} />,
    );
    expect(screen.getByRole('button', { name: 'Wednesday 2 December' })).toBeSelected();
  });

  it('every button is at least 44 pt', async () => {
    await renderUi(<Schedule />);
    for (const button of screen.getAllByRole('button')) {
      const style = drawnStyle(button);
      expect(style.minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
      expect(style.minWidth).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    }
  });

  it('SPK-UX-009: does not slide while motion is reduced', async () => {
    jest.useFakeTimers();
    await renderUi(<Schedule />);
    fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
    act(() => jest.advanceTimersByTime(32));
    expect(translateX()).toBe(0);
  });

  it('SPK-UX-010: slides the new week in with motion on', async () => {
    jest.useFakeTimers();
    await renderUi(<Schedule />, { motion: 'full' });
    fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
    // A frame in: the days are on their way in from the right.
    act(() => jest.advanceTimersByTime(32));
    expect(translateX()).toBeGreaterThan(0);
    act(() => jest.advanceTimersByTime(1_000));
    expect(translateX()).toBe(0);
  });

  it.each(THEME_NAMES)('fills the selected day with the %s primary', async (name) => {
    const { theme } = await renderUi(<Schedule />, { theme: name });
    expect(
      drawnStyle(screen.getByRole('button', { name: 'Wednesday 18 November' })).backgroundColor,
    ).toBe(theme.colors.primary);
    expect(screen.getByText('18')).toHaveStyle({ color: theme.colors.primaryText });
    expect(
      drawnStyle(screen.getByRole('button', { name: 'Tuesday 17 November, today' })).borderColor,
    ).toBe(theme.colors.primary);
  });
});
