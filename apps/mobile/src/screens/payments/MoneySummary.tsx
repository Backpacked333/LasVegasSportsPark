/**
 * Money at a glance for the person whose balances are shown (SCR-C-34; SPK-PAY-004, SPK-PAY-009,
 * SPK-PAY-011, §4.10): `GET /v1/people/{id}/money-summary`, readable by the person themselves and
 * by whoever holds `pay` for them (protected household money: anyone else gets NOT_FOUND, shown as
 * "not available" without implying more).
 *
 * Shown as the API states it, per currency and never converted or summed across currencies: what
 * is owed on open balances and how many are past due, credits that can be spent and credits still
 * waiting for approval (POL-015, never spendable yet), and receipts paid this year with refunds
 * shown apart, never netted (receipts, not revenue). "This year" starts on the date the API names,
 * in the zone it names.
 *
 * States: loading; ready; not available (protected NOT_FOUND or ACCESS_DENIED); error with code
 * and "Try again"; offline with nothing cached; stale with its age (the list's own notice).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../../features/money/format';
import type { AccountPerson } from '../../features/money/people';
import { formatInstantIn } from '../../features/money/time-zone';
import { Caption, Field, Section } from '../../features/money/ui';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

type Amount = Schema<'CurrencyAmount'>;

/** "$45.00", "$45.00 and CA$10.00"; `none` when the list is empty. */
export function amountsText(amounts: readonly Amount[], none: string): string {
  const shown = amounts.filter((a) => a.amountMinor !== 0);
  if (shown.length === 0) return none;
  return shown.map((a) => formatMoney(a.amountMinor, a.currency)).join(' and ');
}

/** "Jan 1, 2026" in the zone the API took the year in. */
function yearStart(iso: string, zone: string): string {
  return formatInstantIn(iso, zone).replace(/, \d{1,2}:\d{2}.*$/, '');
}

export function MoneySummary({ person }: { person: AccountPerson }) {
  const summary = useApiQuery({
    path: '/people/{id}/money-summary',
    request: { path: { id: person.personId } },
    staleTime: 30_000,
  });
  const whose = person.self ? 'Your' : `${person.displayName}'s`;
  const data = summary.data;
  return (
    <Section title={`${whose} money`} testID="money-summary">
      {data === undefined ? (
        summary.error ? (
          <QueryErrorView
            error={summary.error}
            onRetry={() => void summary.refetch()}
            unavailable={{
              title: 'Money summary not available',
              description: 'The balances below are shown where your account may see them.',
            }}
          />
        ) : (
          <StateView variant="loading" label="the money summary" />
        )
      ) : (
        <>
          <Field
            label="Owed on open balances"
            value={amountsText(data.accountBalance, 'Nothing owed')}
            testID="money-balance"
          />
          <Field
            label="Open balances"
            value={
              data.pastDueObligations > 0
                ? `${data.openObligations} open, ${data.pastDueObligations} past due`
                : `${data.openObligations} open, none past due`
            }
            testID="money-open"
          />
          <Field
            label="Credits you can use"
            value={amountsText(data.creditsAvailable, 'None')}
            testID="money-credits"
          />
          {data.creditsPendingApproval.some((a) => a.amountMinor !== 0) ? (
            <Field
              label="Credits waiting for approval (not usable yet)"
              value={amountsText(data.creditsPendingApproval, 'None')}
              testID="money-credits-pending"
            />
          ) : null}
          <Field
            label={`Paid since ${yearStart(data.paidSince, data.yearTimeZone)}`}
            value={amountsText(data.paidThisYear, 'Nothing yet')}
            testID="money-paid"
          />
          {data.refundedThisYear.some((a) => a.amountMinor !== 0) ? (
            <Field
              label="Refunded in the same period"
              value={amountsText(data.refundedThisYear, 'None')}
              testID="money-refunded"
            />
          ) : null}
          <Caption>
            {`Each currency is shown on its own. Refunds are listed apart from payments. As of ${formatInstantIn(data.asOf, data.yearTimeZone)}.`}
          </Caption>
        </>
      )}
    </Section>
  );
}
