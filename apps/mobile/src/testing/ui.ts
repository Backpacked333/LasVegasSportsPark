/**
 * Test helpers for the inputs and sheets of the visual system v2 (ADR-008): the one place that
 * knows how a sheet, a select and a date field are driven, so screen tests say what the person does
 * ("choose Saturday in Day") and keep working when the mechanics change. Under Jest a `Sheet`
 * renders through React Native's `Modal` and a `DateField` is a typed `YYYY-MM-DD` input
 * (src/ui/Sheet.tsx, src/ui/DateField.tsx).
 *
 *   await chooseInSheet(screen, 'Day', 'Saturday');
 *   pickDate(screen, 'Date of birth', '2015-04-09');
 */
import {
  act,
  fireEvent,
  waitFor,
  within,
  type screen as Screen,
} from '@testing-library/react-native';

type Queries = Pick<
  typeof Screen,
  'getByRole' | 'getAllByRole' | 'getAllByTestId' | 'queryAllByTestId' | 'getByLabelText'
>;
type Name = string | RegExp;
type SheetElement = ReturnType<Queries['getAllByTestId']>[number];

/** The sheet that opened last (sheets render their content only while open). */
export function openSheet(screen: Queries): SheetElement {
  const sheets = screen.queryAllByTestId('sheet');
  const last = sheets[sheets.length - 1];
  if (!last) throw new Error('No sheet is open.');
  return last;
}

/**
 * Presses the control named `triggerName` (a `Select`'s button, a filter button), then the option
 * named `optionName` in the sheet it opened: a radio, a checkbox or a button. Resolves once the
 * option was pressed; a `Select` has closed its sheet by then.
 */
export async function chooseInSheet(
  screen: Queries,
  triggerName: Name,
  optionName: Name,
): Promise<void> {
  fireEvent.press(screen.getByRole('button', { name: triggerName }));
  const sheet = await waitFor(() => openSheet(screen));
  const scope = within(sheet);
  const option =
    scope.queryByRole('radio', { name: optionName }) ??
    scope.queryByRole('checkbox', { name: optionName }) ??
    scope.getByRole('button', { name: optionName });
  await act(async () => {
    fireEvent.press(option);
  });
}

/**
 * Types `isoDate` (`YYYY-MM-DD`) into the date field named `fieldName` and leaves it, as a person
 * typing the date on the web would; the field reports the date (or shows its error).
 */
export function pickDate(screen: Queries, fieldName: Name, isoDate: string): void {
  const input = screen.getByLabelText(fieldName);
  fireEvent(input, 'focus');
  fireEvent.changeText(input, isoDate);
  fireEvent(input, 'blur');
}
