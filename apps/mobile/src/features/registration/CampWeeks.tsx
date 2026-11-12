/**
 * Camp registration: choose the weeks and see an informational total (SCR-C-09 for a camp
 * offering; park UI "Register: pick weeks, see the price"; SPK-REG-001, SPK-REG-005, SPK-PAY-001,
 * SPK-PAY-002, SPK-PAY-003).
 *
 * - The weeks are the camp offerings of the same program
 *   (`GET /v1/offerings?programId=&kind=camp`, published only), in date order; the week the customer
 *   opened is always listed and chosen first. A week is chosen only while its registration is open.
 * - Places left come from `GET /v1/offering-availability?offeringIds=` (live: holds and commitments
 *   count, SPK-REG-005). A full week reads "Full" and can still be added, as any full offering
 *   could before: the basket offers its waitlist when no place is free (SCR-C-11, SCR-C-16). A
 *   week without a configured pool shows no count, never a guess. The count is not a hold: a
 *   place is held only at checkout.
 * - The total is `POST /v1/discounts/evaluate` for one line per chosen week and person (pure
 *   evaluation, nothing is redeemed or held), with the automatic discounts it applied. It is an
 *   estimate: the binding price is the existing quote step (`POST /v1/registration-quotes`,
 *   SCR-C-12), which is unchanged. Each week is added as its own basket line and the API checks
 *   every line again (eligibility, authority, duplicates).
 *
 * States: the weeks list has loading, error with code and "Try again" (the opened week stays
 * usable alone), and offline; the total has "choose who is going", loading, unpriced, error with
 * code and "Try again", and offline (no estimate is shown, the last one is not kept as current).
 */
import { apiQueryKey, type ApiError, type Schema } from '@sportspark/api-client';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useConnectivity } from '../../providers/AppProviders';
import { Card, Eyebrow } from '../../ui/Card';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { fonts, makeStyles, spacing, type, useTheme } from '../../ui/theme';
import { formatMoney } from './format';
import { promotionText } from './promotions';
import { offeringDates, registrationWindowStatus } from './status';
import { Body, ChoiceRow, Section } from './ui';

type Offering = Schema<'Offering'>;
type PublicOffering = Schema<'PublicOffering'>;
type Availability = Schema<'OfferingAvailability'>;
type Evaluation = Schema<'DiscountEvaluation'>;

/** The API reads at most 20 offerings' availability at once (MAX_AVAILABILITY_OFFERINGS). */
export const MAX_WEEKS = 20;

export type Week = Pick<
  PublicOffering,
  | 'id'
  | 'name'
  | 'startsOn'
  | 'endsOn'
  | 'publicationState'
  | 'registrationOpensAt'
  | 'price'
  | 'promotions'
  | 'facility'
>;

/** The opened week first among equals, every week once, in date order (at most MAX_WEEKS). */
export function campWeeks(opened: Week, listed: readonly Week[] | undefined): Week[] {
  const byId = new Map<string, Week>([[opened.id, opened]]);
  for (const week of listed ?? []) if (!byId.has(week.id)) byId.set(week.id, week);
  return [...byId.values()]
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id))
    .slice(0, MAX_WEEKS);
}

/** "24 places left", "1 place left", "Full"; null when no pool is configured or not known. */
export function placesStatus(availability: Availability | undefined): StatusBadgeProps | null {
  if (!availability || availability.status === 'not_configured') return null;
  if (availability.status === 'full' || (availability.remaining ?? 0) <= 0) {
    return { tone: 'danger', label: 'Full' };
  }
  const left = availability.remaining ?? 0;
  return {
    tone: left <= 5 ? 'warning' : 'neutral',
    label: `${left} ${left === 1 ? 'place' : 'places'} left`,
  };
}

/**
 * Whether a week can be chosen now: its registration is open. A full week stays choosable (the
 * basket offers the waitlist), so the flow for a full offering is what it was.
 */
export function weekChoosable(week: Week): boolean {
  return week.publicationState === 'registration_open';
}

/** The weeks of the camp, their places left and how the reads stand. */
export function useCampWeeks(offering: Offering, enabled = true) {
  const list = useApiQuery({
    path: '/offerings',
    request: { query: { programId: offering.programId, kind: 'camp', limit: 50 } },
    enabled,
    staleTime: 60_000,
  });
  const weeks = campWeeks(offering, list.data?.items);
  const ids = weeks.map((w) => w.id);
  const availability = useApiQuery({
    path: '/offering-availability',
    request: { query: { offeringIds: ids.join(',') } },
    // Once the weeks are known (or could not be read), so the counts are read once.
    enabled: enabled && (list.data !== undefined || list.error !== null),
    // Live counts: read again on every return to the screen.
    refetchOnWindowFocus: 'always',
  });
  const byId = new Map((availability.data?.items ?? []).map((a) => [a.offeringId, a] as const));
  const hidden = new Set(availability.data?.unavailableOfferingIds ?? []);
  return {
    // A week the API no longer lists as available to read is left out (never the opened one,
    // which this screen read itself).
    weeks: weeks.filter((w) => w.id === offering.id || !hidden.has(w.id)),
    availabilityOf: (id: string) => byId.get(id),
    list,
    availability,
  };
}

export function CampWeekPicker({
  camp,
  chosen,
  onToggle,
}: {
  camp: ReturnType<typeof useCampWeeks>;
  chosen: readonly string[];
  onToggle: (weekId: string) => void;
}) {
  const { weeks, availabilityOf, list, availability } = camp;
  return (
    <Section title="Weeks" testID="camp-weeks">
      <View accessibilityRole="list">
        {weeks.map((week) => {
          const places = placesStatus(availabilityOf(week.id));
          const choosable = weekChoosable(week);
          const checked = chosen.includes(week.id);
          const window =
            week.publicationState === 'registration_open' ? null : registrationWindowStatus(week);
          const detail = [
            offeringDates(week),
            week.price
              ? formatMoney(week.price.basePriceMinor, week.price.currency)
              : 'No price published yet',
            places?.label,
            window?.label,
            ...week.promotions.map((p) => promotionText(p, week.facility.timezone)),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <ChoiceRow
              key={week.id}
              label={week.name}
              detail={detail}
              checked={checked && choosable}
              disabled={!choosable}
              onToggle={() => onToggle(week.id)}
              testID={`camp-week-${week.id}`}
            />
          );
        })}
      </View>
      {list.data === undefined && list.error ? (
        <>
          <Body muted>The other weeks of this camp could not be loaded.</Body>
          <QueryErrorView error={list.error} onRetry={() => void list.refetch()} />
        </>
      ) : list.data === undefined ? (
        <StateView variant="loading" label="the weeks of this camp" />
      ) : null}
      {availability.data === undefined && availability.error ? (
        <>
          <Body muted>Places left could not be loaded. Places are checked at checkout.</Body>
          <QueryErrorView error={availability.error} onRetry={() => void availability.refetch()} />
        </>
      ) : null}
      {weeks.some(
        (w) => chosen.includes(w.id) && placesStatus(availabilityOf(w.id))?.label === 'Full',
      ) ? (
        <Body>A full week can still be added: your basket offers its waitlist.</Body>
      ) : null}
      <Body muted>
        Places left change as other families register. A place is held for you only at checkout.
      </Body>
    </Section>
  );
}

interface PreviewLine {
  lineId: string;
  offeringId: string;
  participantPersonId: string;
}

/** One line per chosen week and person, in a stable order (the request and its cache key). */
export function previewLines(
  weekIds: readonly string[],
  personIds: readonly string[],
): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const offeringId of [...weekIds].sort()) {
    for (const participantPersonId of [...personIds].sort()) {
      lines.push({
        lineId: `${offeringId}:${participantPersonId}`,
        offeringId,
        participantPersonId,
      });
    }
  }
  return lines;
}

/**
 * The informational total: `POST /v1/discounts/evaluate` is a pure evaluation (no idempotency
 * key needed by the API; the client sends one with every POST), cached by its request like a read.
 */
export function useDiscountPreview(
  currency: string | null,
  lines: readonly PreviewLine[],
  enabled: boolean,
) {
  const api = useApi();
  const body = currency ? { currency, lines: [...lines], codes: [] } : null;
  return useQuery<Evaluation, ApiError>({
    queryKey: apiQueryKey('/discounts/evaluate', { query: body ?? {} }),
    queryFn: async () => {
      if (!body) throw new Error('No currency to evaluate in.');
      return api.post('/discounts/evaluate', { body, intent: api.newIntent() });
    },
    enabled: enabled && body !== null && lines.length > 0,
    staleTime: 30_000,
  });
}

export function CampPriceBar({
  weeks,
  chosenWeekIds,
  personIds,
  personNames,
}: {
  weeks: readonly Week[];
  chosenWeekIds: readonly string[];
  personIds: readonly string[];
  /** Given names of the chosen people, for "2 of 3 weeks · Ada". */
  personNames: readonly string[];
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const chosen = weeks.filter((w) => chosenWeekIds.includes(w.id));
  const currencies = [...new Set(chosen.map((w) => w.price?.currency ?? null))];
  const unpriced = chosen.some((w) => w.price === null);
  const currency = !unpriced && currencies.length === 1 ? (currencies[0] ?? null) : null;
  const lines = previewLines(
    chosen.map((w) => w.id),
    personIds,
  );
  const preview = useDiscountPreview(currency, lines, !offline);
  const summary = [
    `${chosen.length} of ${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'}`,
    personNames.length > 0 ? personNames.join(', ') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  let content;
  if (chosen.length === 0) {
    content = <Text style={styles.note}>Choose at least one week.</Text>;
  } else if (personIds.length === 0) {
    content = <Text style={styles.note}>Choose who is going to see the total.</Text>;
  } else if (unpriced || currency === null) {
    content = (
      <Text style={styles.note}>
        A total cannot be shown here for these weeks. Your quote gives the price.
      </Text>
    );
  } else if (offline) {
    content = <Text style={styles.note}>The total needs a connection.</Text>;
  } else if (preview.data) {
    const total = formatMoney(preview.data.totalNetMinor, preview.data.currency);
    const applied = preview.data.discounts.filter((d) => d.applied && d.amountMinor !== 0);
    content = (
      <View
        accessible
        accessibilityLabel={[
          `Estimated total ${total}`,
          ...applied.map(
            (d) => `${d.name} applied, ${formatMoney(d.amountMinor, preview.data.currency)} off`,
          ),
          'Your quote gives the binding price',
        ].join('. ')}
        testID="camp-total"
      >
        {applied.map((d) => (
          <Text key={d.discountDefinitionId} style={styles.note}>
            {`${d.name} applied: −${formatMoney(d.amountMinor, preview.data.currency)}`}
          </Text>
        ))}
        <Text style={styles.total}>{total}</Text>
        <Text style={styles.note}>
          Estimate before credits. Your quote gives the binding price.
        </Text>
      </View>
    );
  } else if (preview.error) {
    content = (
      <View style={styles.light}>
        <Body>The total could not be worked out. Your quote gives the price.</Body>
        <QueryErrorView error={preview.error} onRetry={() => void preview.refetch()} />
      </View>
    );
  } else {
    content = <StateView variant="loading" label="the total" />;
  }
  return (
    <Card tone="night" testID="camp-price-bar">
      <Eyebrow color={colors.floodlight}>{summary}</Eyebrow>
      {content}
      {preview.data && preview.isFetching ? (
        <StatusBadge tone="info" label="Updating the total" />
      ) : null}
    </Card>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  note: { ...type.caption, color: colors.nightText },
  total: {
    ...type.title,
    ...fonts.display,
    color: colors.onNight,
    paddingVertical: spacing.xs,
  },
  light: { backgroundColor: colors.background, borderRadius: 12, padding: spacing.sm },
}));
