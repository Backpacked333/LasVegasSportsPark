/**
 * Money at a glance for the person whose balances are shown (SCR-C-34; SPK-PAY-004, SPK-PAY-009,
 * SPK-PAY-011, §4.10): `GET /v1/people/{id}/money-summary`, readable by the person themselves and
 * by whoever holds `pay` for them (protected family money: anyone else gets NOT_FOUND, shown as
 * "not available" without implying more).
 *
 * It opens the Payments page with two stat tiles (ADR-008 `StatTile`, tabular figures, one element
 * each for screen readers): "Amount due" (what is owed on open balances, with how many are open
 * and past due; the warning tone only with words that say "past due") and "Credits" (credits that
 * can be spent). Below them, the rest as the API states it: credits still waiting for approval
 * (POL-015, never spendable yet) and receipts paid this year with refunds shown apart, never
 * netted (receipts, not revenue). Shown per currency and never converted or summed across
 * currencies. "This year" starts on the date the API names, in the zone it names.
 *
 * States: loading; ready; not available (protected NOT_FOUND or ACCESS_DENIED); error with code
 * and "Try again"; offline with nothing cached; stale with its age (the list's own notice).
 */
import type { Schema } from '@sportspark/api-client';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../../features/money/format';
import type { AccountPerson } from '../../features/money/people';
import { formatInstantIn } from '../../features/money/time-zone';
import { Card } from '../../ui/Card';
import { FieldValue } from '../../ui/Field';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Section } from '../../ui/Section';
import { StatTile } from '../../ui/StatTile';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';

type Amount = Schema<'CurrencyAmount'>;
type Summary = Schema<'PersonMoneySummary'>;

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

/** The amount-due tile's line under the figure: how many balances are open and past due. */
export function amountDueSublabel(open: number, pastDue: number): string {
  if (open === 0) return 'Nothing to pay';
  const toPay = `${open} to pay`;
  return pastDue > 0 ? `${toPay}, ${pastDue} past due` : `${toPay}, none past due`;
}

function Tiles({ data }: { data: Summary }) {
  const styles = useStyles();
  return (
    <View style={styles.tiles}>
      <StatTile
        label="Amount due"
        value={amountsText(data.accountBalance, 'None')}
        sublabel={amountDueSublabel(data.openObligations, data.pastDueObligations)}
        tone={data.pastDueObligations > 0 ? 'warning' : 'default'}
        testID="money-amount-due"
      />
      <StatTile
        label="Credits"
        value={amountsText(data.creditsAvailable, 'None')}
        sublabel="Ready to use"
        testID="money-credits"
      />
    </View>
  );
}

function Facts({ data }: { data: Summary }) {
  const styles = useStyles();
  return (
    <Card style={styles.facts}>
      {data.creditsPendingApproval.some((a) => a.amountMinor !== 0) ? (
        <FieldValue
          label="Credits waiting for approval (not usable yet)"
          value={amountsText(data.creditsPendingApproval, 'None')}
          testID="money-credits-pending"
        />
      ) : null}
      <FieldValue
        label={`Paid since ${yearStart(data.paidSince, data.yearTimeZone)}`}
        value={amountsText(data.paidThisYear, 'Nothing yet')}
        testID="money-paid"
      />
      {data.refundedThisYear.some((a) => a.amountMinor !== 0) ? (
        <FieldValue
          label="Refunded in the same period"
          value={amountsText(data.refundedThisYear, 'None')}
          testID="money-refunded"
        />
      ) : null}
      <Text variant="footnote" tone="muted">
        {`Each currency is shown on its own. Refunds are listed apart from payments. As of ${formatInstantIn(data.asOf, data.yearTimeZone)}.`}
      </Text>
    </Card>
  );
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
    <Section title={`${whose} money`} variant="plain" testID="money-summary">
      {data === undefined ? (
        summary.error ? (
          <QueryErrorView
            error={summary.error}
            onRetry={() => void summary.refetch()}
            unavailable={{
              title: 'Money summary not available',
              description: 'The amounts below are shown where your account may see them.',
            }}
          />
        ) : (
          <StateView variant="loading" label="the money summary" />
        )
      ) : (
        <>
          <Tiles data={data} />
          <Facts data={data} />
        </>
      )}
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  facts: { marginHorizontal: 0, marginVertical: 0, gap: spacing.sm },
}));
