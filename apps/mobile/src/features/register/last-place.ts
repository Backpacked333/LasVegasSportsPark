/**
 * "The last place just went" (redesign handoff M 4e; INTERACTIONS "1e–1g" row 7; SPK-AT-005): when
 * the hold (or the payment) finds a chosen week full, nothing is charged, and the parent gets the
 * choices with prices already worked out again. Pure.
 *
 * - With weeks still free: "Book Week 2, waitlist Week 1" (pre-selected, the best), "Book Week 2
 *   only", "Start over"; the price is the estimate for the weeks still free.
 * - With nothing free: "Join the waitlist" (pre-selected), "Start over".
 * - A discount the old price had and the new one has not is explained by name, so the new total
 *   is no surprise ("The Multi-week discount no longer applies.").
 */
export type LastPlaceChoice = 'book_and_wait' | 'book_only' | 'wait' | 'start_over';

export interface LastPlaceOption {
  value: LastPlaceChoice;
  label: string;
  detail: string;
}

export interface LastPlaceModel {
  title: string;
  options: LastPlaceOption[];
  /** The pre-selected (best) choice. */
  best: LastPlaceChoice;
  droppedNote: string | null;
  /** The button's words for each choice. */
  actionOf: (choice: LastPlaceChoice) => string;
}

/** "Week 1", "Week 1 and Week 3". */
function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function lastPlaceModel(input: {
  /** Labels of the weeks (or the activity) that are now full. */
  full: readonly string[];
  /** Labels of the chosen weeks that are still free. */
  free: readonly string[];
  /** "$116.00": the re-worked price of the free weeks; null while it is not known. */
  freeTotal: string | null;
  /** Discount names on the old price, and on the re-worked one. */
  discountsBefore: readonly string[];
  discountsAfter: readonly string[];
  /** A camp (weeks to go back to) or a single activity. */
  camp: boolean;
}): LastPlaceModel {
  const fullNames = names(input.full);
  const freeNames = names(input.free);
  const pay = input.freeTotal ? `Pay ${input.freeTotal}` : 'Pay';
  const startOver: LastPlaceOption = {
    value: 'start_over',
    label: 'Start over',
    detail: input.camp ? 'Back to choosing weeks' : 'Back to the activity',
  };
  const options: LastPlaceOption[] =
    input.free.length > 0
      ? [
          {
            value: 'book_and_wait',
            label: `Book ${freeNames}, waitlist ${fullNames}`,
            detail: input.freeTotal ? `${pay} now · join the ${fullNames} list` : 'Join the list',
          },
          { value: 'book_only', label: `Book ${freeNames} only`, detail: pay },
          startOver,
        ]
      : [
          {
            value: 'wait',
            label: 'Join the waitlist',
            detail: "No charge now. We'll tell you when a place opens.",
          },
          startOver,
        ];
  const dropped = input.discountsBefore.filter((d) => !input.discountsAfter.includes(d));
  return {
    title:
      input.camp && input.full.length > 0
        ? `${fullNames} just filled up`
        : 'The last place just went',
    options,
    best: options[0]?.value ?? 'start_over',
    droppedNote:
      dropped.length > 0
        ? `The ${names(dropped)} ${dropped.length === 1 ? 'discount no longer applies' : 'discounts no longer apply'}.`
        : null,
    actionOf: (choice) => {
      switch (choice) {
        case 'book_and_wait':
          return `${pay} and join the list`;
        case 'book_only':
          return pay;
        case 'wait':
          return 'Join the waitlist';
        case 'start_over':
          return 'Start over';
      }
    },
  };
}
