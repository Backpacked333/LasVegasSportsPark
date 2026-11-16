/**
 * DateField and DateRangeField (ADR-008 visual system v2; SPK-UX-009 names and errors read with
 * the field; SPK-UX-008 what was typed is kept). Under Jest the field is a typed `YYYY-MM-DD`
 * input, driven through `pickDate` (src/testing/ui.ts).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { pickDate } from '../../testing/ui';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import {
  addIsoDays,
  DateField,
  DateRangeField,
  datePresentationFor,
  dateProblem,
  END_BEFORE_START,
  fullDateName,
  isIsoDate,
  isoWeekday,
  type DateRange,
} from '../DateField';
import { MIN_TOUCH_SIZE } from '../theme';

const FORMAT_ERROR = 'Enter the date as year-month-day, for example 2026-11-18.';

function Birthday({ onChange }: { onChange?: (value: string | null) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <DateField
      label="Date of birth"
      value={value}
      maximumDate="2026-11-16"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('calendar dates', () => {
  it('accepts only real dates written YYYY-MM-DD', () => {
    expect(isIsoDate('2026-11-18')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('18/11/2026')).toBe(false);
  });

  it('adds days across months and years, and names the date in full', () => {
    expect(addIsoDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addIsoDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(isoWeekday('2026-11-18')).toBe(3);
    expect(fullDateName('2026-11-18')).toBe('Wednesday 18 November 2026');
    expect(fullDateName('2026-11-18', false)).toBe('Wednesday 18 November');
  });

  it('explains what is wrong with a typed date', () => {
    expect(dateProblem('2026-11')).toBe(FORMAT_ERROR);
    expect(dateProblem('2026-11-01', { minimumDate: '2026-11-02' })).toBe(
      'Choose Monday 2 November 2026 or later.',
    );
    expect(dateProblem('2026-11-20', { maximumDate: '2026-11-16' })).toBe(
      'Choose Monday 16 November 2026 or earlier.',
    );
    expect(dateProblem('2026-11-10', { minimumDate: '2026-11-02' })).toBeNull();
  });

  it('uses the device picker on iOS and Android and typed text on the web and in Jest', () => {
    expect(datePresentationFor({ os: 'ios', test: false })).toBe('picker');
    expect(datePresentationFor({ os: 'android', test: false })).toBe('picker');
    expect(datePresentationFor({ os: 'web', test: false })).toBe('text');
    expect(datePresentationFor({ os: 'ios', test: true })).toBe('text');
  });
});

describe('DateField (ADR-008)', () => {
  it('SPK-UX-009: the input is named by its label and says how to type the date', async () => {
    await renderUi(<Birthday />);
    const input = screen.getByLabelText('Date of birth');
    expect(input).toHaveProp('accessibilityHint', 'Year-month-day, for example 2026-11-18.');
    expect(input).toHaveProp('placeholder', 'YYYY-MM-DD');
  });

  it('reports a valid date as an ISO string (and plays the selection haptic)', async () => {
    const onChange = jest.fn();
    const { haptics } = await renderUi(<Birthday onChange={onChange} />);
    pickDate(screen, 'Date of birth', '2015-04-09');
    expect(onChange).toHaveBeenLastCalledWith('2015-04-09');
    expect(screen.getByLabelText('Date of birth')).toHaveProp('value', '2015-04-09');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(haptics.events).toEqual(['selection']);
  });

  it('SPK-UX-008: an invalid date shows the error in words and keeps what was typed', async () => {
    const onChange = jest.fn();
    await renderUi(<Birthday onChange={onChange} />);
    const input = screen.getByLabelText('Date of birth');
    fireEvent.changeText(input, '2015-4-9');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(input, 'blur');
    expect(screen.getByRole('alert')).toHaveTextContent(`✕ ${FORMAT_ERROR}`);
    expect(screen.getByLabelText('Date of birth')).toHaveProp('value', '2015-4-9');
    expect(screen.getByLabelText('Date of birth')).toHaveProp(
      'accessibilityHint',
      `Year-month-day, for example 2026-11-18. Error: ${FORMAT_ERROR}`,
    );
    expect(onChange).not.toHaveBeenCalled();
    // Corrected: the error goes and the date is reported.
    pickDate(screen, 'Date of birth', '2015-04-09');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('2015-04-09');
  });

  it('refuses a date outside its bounds, and an emptied field reports null', async () => {
    const onChange = jest.fn();
    await renderUi(<Birthday onChange={onChange} />);
    pickDate(screen, 'Date of birth', '2027-01-01');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '✕ Choose Monday 16 November 2026 or earlier.',
    );
    pickDate(screen, 'Date of birth', '2015-04-09');
    pickDate(screen, 'Date of birth', '');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows a new value given from above', async () => {
    const { rerender } = await renderUi(
      <DateField label="Start" value="2026-11-18" onChange={() => undefined} />,
    );
    expect(screen.getByLabelText('Start')).toHaveProp('value', '2026-11-18');
    rerender(<DateField label="Start" value="2026-12-01" onChange={() => undefined} />);
    expect(screen.getByLabelText('Start')).toHaveProp('value', '2026-12-01');
  });

  it('is at least 44 pt tall', async () => {
    await renderUi(<Birthday />);
    expect(drawnStyle(screen.getByLabelText('Date of birth')).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_SIZE,
    );
  });

  it.each(THEME_NAMES)('draws as a field in the %s theme', async (name) => {
    const { theme } = await renderUi(<Birthday />, { theme: name });
    const input = screen.getByLabelText('Date of birth');
    expect(drawnStyle(input).backgroundColor).toBe(theme.colors.background);
    fireEvent.changeText(input, 'soon');
    fireEvent(input, 'blur');
    expect(drawnStyle(screen.getByLabelText('Date of birth')).borderColor).toBe(
      theme.colors.danger,
    );
  });

  it('the device presentation is a button that reads the date in full', async () => {
    await renderUi(
      <DateField
        label="Camp week"
        value="2026-11-18"
        onChange={() => undefined}
        presentation="picker"
      />,
      { motion: 'full' },
    );
    const button = screen.getByRole('button', { name: 'Camp week' });
    expect(button).toHaveAccessibilityValue({ text: 'Wednesday 18 November 2026' });
    expect(drawnStyle(button).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
  });

  it('on iOS, Done on an empty field commits the date the picker shows, without a wheel turn', async () => {
    const onChange = jest.fn();
    await renderUi(
      <DateField
        label="Camp week"
        value={null}
        minimumDate="2026-12-21"
        onChange={onChange}
        presentation="picker"
      />,
      { motion: 'full' },
    );
    fireEvent.press(screen.getByRole('button', { name: 'Camp week' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-12-21');
  });

  it('on iOS, Done on a field that already has a date changes nothing', async () => {
    const onChange = jest.fn();
    await renderUi(
      <DateField label="Camp week" value="2026-11-18" onChange={onChange} presentation="picker" />,
      { motion: 'full' },
    );
    fireEvent.press(screen.getByRole('button', { name: 'Camp week' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Done' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DateRangeField (ADR-008)', () => {
  function Stay({ initial }: { initial: DateRange }) {
    const [value, setValue] = useState(initial);
    return <DateRangeField label="Camp dates" value={value} onChange={setValue} />;
  }

  it('picks a start and an end date, each named on its own', async () => {
    await renderUi(<Stay initial={{ start: null, end: null }} />);
    expect(screen.getByText('Camp dates')).toBeOnTheScreen();
    pickDate(screen, 'Start date', '2026-12-21');
    pickDate(screen, 'End date', '2026-12-23');
    expect(screen.getByLabelText('Start date')).toHaveProp('value', '2026-12-21');
    expect(screen.getByLabelText('End date')).toHaveProp('value', '2026-12-23');
  });

  it('refuses an end before the start', async () => {
    await renderUi(<Stay initial={{ start: '2026-12-21', end: null }} />);
    pickDate(screen, 'End date', '2026-12-20');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '✕ Choose Monday 21 December 2026 or later.',
    );
  });

  it('flags a reversed range given from above', async () => {
    await renderUi(<Stay initial={{ start: '2026-12-21', end: '2026-12-20' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(`✕ ${END_BEFORE_START}`);
  });
});
