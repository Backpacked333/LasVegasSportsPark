/**
 * Register 2/3 · Options (redesign handoff M 2a; INTERACTIONS "1e–1g" rows 3 to 5; SPK-REG-005,
 * SPK-PAY-002, SPK-PAY-003, SPK-PAY-014, SPK-REG-012).
 *
 * - **Camp weeks** as a checklist (`CampWeeks.tsx` reads: the camp offerings of one program and
 *   their live places, `GET /v1/offering-availability`): "▲ 3 left" at five or fewer, "● 9 left",
 *   "✕ Full · waitlist" (still choosable: it joins the waitlist), a week not open yet disabled with
 *   its opening date. A week without a capacity pool shows no count, never a guess.
 * - **Extras**: the activity's add-ons (`GET /v1/offerings/{id}/purchase-options`) as switches, the
 *   same code on every chosen week ("Early drop-off · 7:30 AM", "+$10 a day"). With none, the block
 *   reads "Extras proposed" (pending tone): no extras are invented.
 * - An activity sold by tier (a full week or chosen days) asks each person with `PurchaseChoices`.
 * - The night price bar is sticky: "2 of 4 weeks · Maya", the total from
 *   `POST /v1/discounts/evaluate` plus the extras switched on, the automatic discount applied
 *   ("Multi-week −10% applied"), and "estimate" until Review's binding price. Review is disabled
 *   with no week chosen.
 */
import type { Schema } from '@sportspark/api-client';
import { Pressable, ScrollView, View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import {
  campName,
  lengthWords,
  shortDate,
  shortRange,
  weekLabel,
  wholeMoney,
} from '../../../features/register/fit';
import {
  previewLines,
  useDiscountPreview,
  type useCampWeeks,
  type Week,
} from '../../../features/registration/CampWeeks';
import {
  EMPTY_SELECTION,
  PurchaseChoices,
  type PurchaseSelection,
} from '../../../features/registration/PurchaseChoices';
import { formatMoney } from '../../../features/registration/format';
import { useConnectivity } from '../../../providers/AppProviders';
import { Icon } from '../../../ui/Icon';
import { StatusBadge, type StatusBadgeProps } from '../../../ui/StatusBadge';
import { SwitchRow } from '../../../ui/SwitchRow';
import { Text } from '../../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabularFigures,
  useTheme,
} from '../../../ui/theme';
import { StepHeader } from './StepChrome';

type Offering = Schema<'Offering'>;
type Availability = Schema<'OfferingAvailability'>;
type OfferingAddon = Schema<'OfferingAddon'>;
type OfferingSession = Schema<'OfferingSession'>;
type PurchaseOptions = Schema<'OfferingPurchaseOptions'>;

/** A week's places as Options shows them (always a badge when the count is known). */
export function weekPlaces(availability: Availability | undefined): StatusBadgeProps | null {
  if (!availability || availability.status === 'not_configured') return null;
  if (availability.status === 'full' || (availability.remaining ?? 0) <= 0) {
    return { tone: 'danger', label: 'Full · waitlist' };
  }
  const left = availability.remaining ?? 0;
  return { tone: left <= 5 ? 'warning' : 'neutral', label: `${left} left` };
}

/** "+$10 a day", "+$15". */
export function addonPrice(addon: OfferingAddon): string {
  const amount = wholeMoney(addon.priceMinor, addon.currency);
  return addon.selection === 'per_session' ? `+${amount} a day` : `+${amount}`;
}

/** The estimate the bar shows: the evaluated weeks plus the extras switched on. */
export function extrasEstimate(
  chosenWeeks: readonly string[],
  people: number,
  extras: readonly string[],
  addonsOf: (weekId: string) => readonly OfferingAddon[],
  daysOf: (weekId: string) => number,
): number {
  let total = 0;
  for (const week of chosenWeeks) {
    for (const addon of addonsOf(week)) {
      if (!extras.includes(addon.code) || addon.status !== 'active') continue;
      total += addon.priceMinor * (addon.selection === 'per_session' ? daysOf(week) : 1) * people;
    }
  }
  return total;
}

function WeekRow({
  week,
  checked,
  places,
  sessions,
  onPress,
}: {
  week: Week;
  checked: boolean;
  places: StatusBadgeProps | null;
  sessions: OfferingSession[] | undefined;
  onPress: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const open = week.publicationState === 'registration_open';
  const zone = week.facility.timezone;
  const length = sessions ? lengthWords(sessions, zone) : null;
  const price = week.price && !week.price.notQuotable ? week.price : null;
  const opens =
    !open && week.registrationOpensAt
      ? `Opens ${shortDate(week.registrationOpensAt.slice(0, 10))}`
      : !open
        ? 'Not open yet'
        : null;
  const detail = [length, price ? wholeMoney(price.basePriceMinor, price.currency) : null]
    .filter(Boolean)
    .join(' · ');
  const full = places?.tone === 'danger';
  const title = `${weekLabel(week.name)} · ${shortRange(week.startsOn, week.endsOn)}`;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: checked && open, disabled: !open }}
      accessibilityLabel={[
        title,
        detail,
        opens ?? places?.label,
        checked && full ? 'Joins the waitlist' : null,
      ]
        .filter(Boolean)
        .join('. ')}
      disabled={!open}
      onPress={onPress}
      style={[styles.week, checked && open ? styles.weekOn : null, open ? null : styles.weekClosed]}
      testID={`week-${week.id}`}
    >
      <View style={[styles.box, checked && open ? styles.boxOn : null]}>
        {checked && open ? <Icon name="check" size={18} color={colors.primaryText} /> : null}
      </View>
      <View style={styles.weekWords}>
        <Text style={[styles.weekTitle, open ? null : styles.closedText]}>{title}</Text>
        <Text variant="footnote" tone="muted">
          {[detail, opens].filter(Boolean).join(' · ')}
        </Text>
        {checked && full ? (
          <Text variant="footnote" tone="muted">
            Choosing it joins the waitlist.
          </Text>
        ) : null}
      </View>
      {open && places ? <StatusBadge {...places} /> : null}
    </Pressable>
  );
}

export function OptionsStep({
  offering,
  camp,
  chosenWeeks,
  onToggleWeek,
  addons,
  extras,
  onToggleExtra,
  extrasProposed,
  tierOptions,
  tierSessions,
  choices,
  onChoices,
  choicesAsked,
  people,
  addonsOf,
  sessionsOf,
  onBack,
  onReview,
}: {
  offering: Offering;
  camp: ReturnType<typeof useCampWeeks> | null;
  chosenWeeks: readonly string[];
  onToggleWeek: (weekId: string) => void;
  addons: readonly OfferingAddon[];
  extras: readonly string[];
  onToggleExtra: (code: string) => void;
  /** No add-ons are sold for this activity: the proposed extras note. */
  extrasProposed: boolean;
  /** Set for an activity sold by tier: each person chooses with `PurchaseChoices`. */
  tierOptions: PurchaseOptions | null;
  tierSessions: readonly OfferingSession[];
  choices: Readonly<Record<string, PurchaseSelection>>;
  onChoices: (personId: string, value: PurchaseSelection) => void;
  choicesAsked: boolean;
  people: readonly { personId: string; name: string }[];
  addonsOf: (weekId: string) => readonly OfferingAddon[];
  sessionsOf: (weekId: string) => OfferingSession[] | undefined;
  onBack: () => void;
  onReview: () => void;
}) {
  const styles = useStyles();
  const insets = useInsets();
  const offline = useConnectivity().reachable === false;
  const weeks = camp?.weeks ?? [];
  const chosen = weeks.filter(
    (w) => chosenWeeks.includes(w.id) && w.publicationState === 'registration_open',
  );
  const forWhom = people.map((p) => p.name).join(', ');
  const currencies = [...new Set(chosen.map((w) => w.price?.currency ?? null))];
  const currency =
    chosen.every((w) => w.price && !w.price.notQuotable) && currencies.length === 1
      ? (currencies[0] ?? null)
      : null;
  const preview = useDiscountPreview(
    currency,
    previewLines(
      chosen.map((w) => w.id),
      people.map((p) => p.personId),
    ),
    !offline && camp !== null,
  );
  const extrasTotal = extrasEstimate(
    chosen.map((w) => w.id),
    people.length,
    extras,
    addonsOf,
    (id) => (sessionsOf(id) ?? []).filter((s) => s.status !== 'canceled').length,
  );
  const applied = preview.data?.discounts.filter((d) => d.applied && d.amountMinor !== 0) ?? [];
  const total = preview.data ? preview.data.totalNetMinor + extrasTotal : null;
  const summary = camp
    ? `${chosen.length} of ${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'} · ${forWhom}`
    : forWhom;
  const canReview = camp ? chosen.length > 0 : true;
  return (
    <View style={styles.root} testID="register-options">
      <StepHeader title={campName(offering.name)} step="Options" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {camp ? (
          <>
            <View style={styles.heading}>
              <Text variant="title1" heading>
                Which weeks?
              </Text>
              <Text variant="label" tone="muted">
                {`For ${forWhom}`}
              </Text>
            </View>
            <View style={styles.weeks} accessibilityRole="list">
              {weeks.map((week) => (
                <WeekRow
                  key={week.id}
                  week={week}
                  checked={chosenWeeks.includes(week.id)}
                  places={weekPlaces(camp.availabilityOf(week.id))}
                  sessions={sessionsOf(week.id)}
                  onPress={() => onToggleWeek(week.id)}
                />
              ))}
            </View>
            {camp.availability.data === undefined && camp.availability.error ? (
              <Text variant="footnote" tone="muted">
                Places left couldn&apos;t be loaded. Places are checked on Review.
              </Text>
            ) : null}
          </>
        ) : null}
        {tierOptions
          ? people.map((p) => (
              <PurchaseChoices
                key={p.personId}
                personId={p.personId}
                personName={p.name}
                options={tierOptions}
                sessions={[...tierSessions]}
                timeZone={offering.facility.timezone}
                value={choices[p.personId] ?? EMPTY_SELECTION}
                onChange={(value) => onChoices(p.personId, value)}
                showMissing={choicesAsked}
              />
            ))
          : null}
        {!tierOptions && (addons.length > 0 || extrasProposed) ? (
          <View style={styles.extras}>
            <Text variant="callout" style={styles.extrasTitle} heading>
              Extras
            </Text>
            {addons.length > 0 ? (
              <View style={styles.extrasCard}>
                {addons.map((addon, i) => (
                  <SwitchRow
                    key={addon.id}
                    label={addon.name}
                    description={addonPrice(addon)}
                    value={extras.includes(addon.code)}
                    onChange={() => onToggleExtra(addon.code)}
                    style={i > 0 ? styles.divider : undefined}
                    testID={`extra-${addon.code}`}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.proposed} testID="extras-proposed">
                <StatusBadge tone="pending" label="Extras proposed" />
                <Text variant="footnote" tone="muted">
                  Early drop-off and lunch can&apos;t be added in the app for this camp yet. The
                  front desk can help.
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.bar, { marginBottom: insets.bottom + spacing.md }]} testID="price-bar">
        <View
          style={styles.barWords}
          accessible
          accessibilityLabel={[
            summary,
            total !== null && preview.data
              ? `Estimate ${formatMoney(total, preview.data.currency)}`
              : null,
            ...applied.map((d) => `${d.name} applied`),
          ]
            .filter(Boolean)
            .join('. ')}
          testID="price-bar-words"
        >
          <Text style={styles.barSummary} numberOfLines={1}>
            {summary}
          </Text>
          <Text style={styles.barTotal}>
            {total !== null && preview.data
              ? formatMoney(total, preview.data.currency)
              : camp && chosen.length === 0
                ? 'Choose a week'
                : offline
                  ? 'Needs a connection'
                  : camp
                    ? '…'
                    : 'Price on Review'}
          </Text>
          <Text style={styles.barNote} numberOfLines={2}>
            {[...applied.map((d) => `${d.name} applied`), camp ? 'estimate' : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review"
          accessibilityState={{ disabled: !canReview }}
          disabled={!canReview}
          onPress={onReview}
          style={({ pressed }) => [
            styles.review,
            !canReview ? styles.reviewOff : null,
            pressed ? styles.reviewPressed : null,
          ]}
          testID="options-review"
        >
          <Text style={styles.reviewLabel}>Review</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: layout.gutter, paddingTop: 14, paddingBottom: spacing.xl, gap: 10 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  weeks: { gap: 10 },
  week: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  weekOn: {
    borderWidth: 2,
    paddingVertical: 11,
    paddingHorizontal: 13,
    borderColor: colors.primary,
    backgroundColor: colors.selectedSurface,
  },
  weekClosed: { backgroundColor: colors.surface },
  box: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  weekWords: { flex: 1, gap: 2 },
  weekTitle: { ...fonts.bold, fontSize: 16, lineHeight: 21, color: colors.text },
  closedText: { color: colors.textMuted },
  extras: { gap: spacing.sm, marginTop: spacing.sm },
  extrasTitle: { ...fonts.semibold },
  extrasCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  proposed: { gap: spacing.xs },
  bar: {
    marginHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.night,
  },
  barWords: { flex: 1, gap: 2 },
  barSummary: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.floodlight },
  barTotal: {
    ...fonts.bold,
    ...tabularFigures,
    fontSize: 24,
    lineHeight: 28,
    color: colors.onNight,
  },
  barNote: { ...fonts.regular, fontSize: 12, lineHeight: 16, color: colors.nightText },
  review: {
    height: 52,
    minWidth: 96,
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.floodlight,
  },
  reviewOff: { opacity: 0.45 },
  reviewPressed: { opacity: 0.85 },
  reviewLabel: { ...fonts.bold, fontSize: 16, color: colors.onFloodlight },
}));
