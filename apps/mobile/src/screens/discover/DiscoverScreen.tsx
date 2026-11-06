/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001, SPK-CAT-002, SPK-CAT-004, SPK-SCHED-008, §4.14;
 * journey A1). Browses the public catalog `GET /v1/offerings`: published offerings with
 * child-safe fields only, each with its registration window state ("Registration opens <date>" in
 * the facility's time zone, "Registration open", "Registration paused", never a paused offering
 * shown as closed). Private or draft offerings are simply absent: the API does not return them.
 *
 * Filters (CAT-01): kind, exact format and a date range (`format`, `from`, `to`), applied by the
 * API; a malformed date or a range that ends before it starts is a field message (validation
 * failure) and nothing is sent. Each applied filter is a new read of the list (its loading state
 * while it answers), and the fields always show the filter that is applied. Filtering by age band waits on
 * DEC-003 (Product and operations): the API has no age filter, and age bands are shown on every
 * item. Pickup sessions, rentals, parties, packages and memberships are conditional capabilities
 * (DEC-016, DEC-072 to DEC-082, Product owner): a signed-in customer gets their filter only while
 * the organization's switch is on (`GET /v1/me/permissions`).
 *
 * States: loading; empty (nothing published for the filter); ready; validation failure (filter
 * input); offline (cached list with its age); unavailable (catalog not reachable, retry); paged
 * with "Load more activities". A signed-out visitor browses the organization configured for this
 * build (deployment setting); without one they are asked to sign in. Signed in, "In progress"
 * lists what the customer can come back to, from the API (SPK-UX-001).
 *
 * Look (park system): kind chips with an icon (the selected one on night pitch, marked "✓" too),
 * the format and date filters in a card, and each activity as a card with a tile in its kind's
 * colour.
 *
 * Search: free text (`q`, at least 2 characters; every word must appear in the offering's name,
 * description, activity type, format, location or program name, as the API matches it), applied
 * with "Search" like the other filters. Promotions: each activity shows the automatic discounts
 * the API lists for it now (`promotions`, never promo codes) as labelled pills; the quote decides
 * what is applied. Signed in, "Picked for <child>" (PickedFor.tsx) lists offerings whose age band
 * fits a family member (`GET /v1/me/offering-suggestions`), by age only, never as eligibility.
 */
import type { CapabilityId } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { OFFERING_KIND_LABELS, type OfferingKind } from '../../features/registration/format';
import { InProgressCard } from '../../features/registration/InProgressCard';
import { registrationRoutes } from '../../features/registration/routes';
import { promotionBadges } from '../../features/registration/promotions';
import { registrationWindowStatus } from '../../features/registration/status';
import { Body, ButtonRow, TextField } from '../../features/registration/ui';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Icon } from '../../ui/Icon';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { KIND_LOOK, offeringSummary } from './offering-look';
import { PickedFor } from './PickedFor';
import { colors, fonts, kindColors, MIN_TOUCH_SIZE, radius, spacing, type } from '../../ui/theme';

export const DISCOVER_PAGE_SIZE = 50;

/** Kinds that always have a filter. */
export const DISCOVER_FILTER_KINDS: readonly OfferingKind[] = [
  'season',
  'term',
  'camp',
  'session',
  'trial',
  'private_coaching',
];

/** Package G kinds, each filterable only while its capability switch is on (DEC-016). */
export const CONDITIONAL_FILTER_KINDS: readonly { kind: OfferingKind; capability: CapabilityId }[] =
  [
    { kind: 'pickup', capability: 'pickup_sessions' },
    { kind: 'rental', capability: 'rentals' },
    { kind: 'party', capability: 'parties' },
    { kind: 'package', capability: 'session_packages' },
    { kind: 'membership', capability: 'memberships' },
  ];

export { KIND_LOOK, offeringSummary };

export interface DiscoverFilter {
  format: string;
  from: string;
  to: string;
}

const EMPTY_FILTER: DiscoverFilter = { format: '', from: '', to: '' };
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD (the API's date-only format). */
export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Field messages for a filter as typed; empty when it can be sent. */
export function filterProblems(
  filter: DiscoverFilter,
): Partial<Record<keyof DiscoverFilter, string>> {
  const out: Partial<Record<keyof DiscoverFilter, string>> = {};
  const from = filter.from.trim();
  const to = filter.to.trim();
  if (from && !isCalendarDate(from))
    out.from = 'Enter a date as YYYY-MM-DD, for example 2026-11-02.';
  if (to && !isCalendarDate(to)) out.to = 'Enter a date as YYYY-MM-DD, for example 2026-12-14.';
  if (!out.from && !out.to && from && to && from > to) {
    out.to = 'The end date must not be before the start date.';
  }
  if (filter.format.trim().length > 100) out.format = 'Use at most 100 characters.';
  return out;
}

/** Field message for a search as typed; null when it can be sent (the API takes 2 to 100). */
export function searchProblem(text: string): string | null {
  const q = text.trim();
  if (q.length === 1) return 'Type at least 2 characters.';
  if (q.length > 100) return 'Use at most 100 characters.';
  return null;
}

function SearchBox({ applied, onApply }: { applied: string; onApply: (q: string) => void }) {
  const [draft, setDraft] = useState(applied);
  const [problem, setProblem] = useState<string | null>(null);
  const search = () => {
    const found = searchProblem(draft);
    setProblem(found);
    if (!found) onApply(draft.trim());
  };
  return (
    <Card testID="discover-search">
      <TextField
        label="Search activities"
        hint="Leagues, camps, classes, fields…"
        value={draft}
        onChangeText={setDraft}
        error={problem ?? undefined}
        testID="discover-q"
      />
      <ButtonRow>
        <Button label="Search" variant="secondary" onPress={search} />
        {applied ? (
          <Button
            label="Clear search"
            variant="secondary"
            onPress={() => {
              setDraft('');
              setProblem(null);
              onApply('');
            }}
          />
        ) : null}
      </ButtonRow>
    </Card>
  );
}

function KindFilter({
  kinds,
  value,
  onChange,
}: {
  kinds: readonly OfferingKind[];
  value: OfferingKind | null;
  onChange: (kind: OfferingKind | null) => void;
}) {
  const options: { kind: OfferingKind | null; label: string }[] = [
    { kind: null, label: 'All activities' },
    ...kinds.map((kind) => ({ kind, label: OFFERING_KIND_LABELS[kind] })),
  ];
  return (
    <View style={styles.filters} accessibilityRole="radiogroup" accessibilityLabel="Activity type">
      {options.map((option) => {
        const checked = option.kind === value;
        return (
          <Pressable
            key={option.label}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked }}
            onPress={() => onChange(option.kind)}
            style={[styles.chip, checked && styles.chipOn]}
            testID={`discover-filter-${option.kind ?? 'all'}`}
          >
            <Icon
              name={option.kind ? KIND_LOOK[option.kind][0] : 'apps'}
              size={18}
              color={checked ? colors.floodlight : colors.text}
            />
            <Text style={[styles.chipText, checked && styles.chipTextOn]}>
              {checked ? `✓ ${option.label}` : option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MoreFilters({
  applied,
  onApply,
}: {
  applied: DiscoverFilter;
  onApply: (filter: DiscoverFilter) => void;
}) {
  const [draft, setDraft] = useState<DiscoverFilter>(applied);
  const [problems, setProblems] = useState<Partial<Record<keyof DiscoverFilter, string>>>({});
  const set = (key: keyof DiscoverFilter) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const apply = () => {
    const found = filterProblems(draft);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    onApply({ format: draft.format.trim(), from: draft.from.trim(), to: draft.to.trim() });
  };
  const active = applied.format || applied.from || applied.to;
  return (
    <Card testID="discover-more-filters">
      <TextField
        label="Format"
        hint="As the facility writes it, for example 7v7"
        value={draft.format}
        onChangeText={set('format')}
        error={problems.format}
        testID="discover-format"
      />
      <TextField
        label="Ending on or after (YYYY-MM-DD)"
        value={draft.from}
        onChangeText={set('from')}
        error={problems.from}
        testID="discover-from"
      />
      <TextField
        label="Starting on or before (YYYY-MM-DD)"
        value={draft.to}
        onChangeText={set('to')}
        error={problems.to}
        testID="discover-to"
      />
      <ButtonRow>
        <Button label="Apply filters" variant="secondary" onPress={apply} />
        {active ? (
          <Button
            label="Clear filters"
            variant="secondary"
            onPress={() => {
              setDraft(EMPTY_FILTER);
              setProblems({});
              onApply(EMPTY_FILTER);
            }}
          />
        ) : null}
      </ButtonRow>
      <Body muted>
        Filtering by age is not available yet: it depends on DEC-003, which has not been decided
        (owner: Product and operations). Each activity shows its age band.
      </Body>
    </Card>
  );
}

export function DiscoverScreen() {
  const { session, services } = useApp();
  const router = useRouter();
  const [kind, setKind] = useState<OfferingKind | null>(null);
  const [filter, setFilter] = useState<DiscoverFilter>(EMPTY_FILTER);
  const [q, setQ] = useState('');
  const signedIn = session.status === 'signed_in';
  const permissions = usePermissions({ enabled: signedIn });
  const slug = services.config.organizationSlug ?? null;
  const canBrowse = signedIn || slug !== null;
  const conditional = CONDITIONAL_FILTER_KINDS.filter(
    (k) => signedIn && permissions.isCapabilityEnabled(k.capability) === true,
  );
  const kinds = [...DISCOVER_FILTER_KINDS, ...conditional.map((k) => k.kind)];
  const query = {
    limit: DISCOVER_PAGE_SIZE,
    ...(kind ? { kind } : {}),
    ...(filter.format ? { format: filter.format } : {}),
    ...(filter.from ? { from: filter.from } : {}),
    ...(filter.to ? { to: filter.to } : {}),
    ...(q ? { q } : {}),
    ...(!signedIn && slug ? { organization: slug } : {}),
  };
  const pages = useApiPages({
    path: '/offerings',
    request: { query },
    enabled: session.status !== 'loading' && canBrowse,
  });
  const filtered =
    kind !== null || filter.format !== '' || filter.from !== '' || filter.to !== '' || q !== '';

  if (session.status === 'loading') {
    return (
      <Screen>
        <StateView variant="loading" label="activities" />
      </Screen>
    );
  }
  if (!canBrowse) {
    return (
      <Screen>
        <StateView
          variant="empty"
          title="Sign in to see activities"
          description="Leagues, programs, camps and other activities appear here after you sign in."
          actionLabel="Sign in"
          onAction={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      {signedIn ? <InProgressCard /> : null}
      {/* Keyed like the filters below: the field always shows the search that is applied. */}
      <SearchBox key={`q:${q}`} applied={q} onApply={setQ} />
      {signedIn && !filtered ? <PickedFor /> : null}
      <KindFilter kinds={kinds} value={kind} onChange={setKind} />
      {/* Keyed by the applied filter: whenever it changes (applied, cleared, or "Show all
          activities"), the fields show exactly what is applied, never stale text. */}
      <MoreFilters key={JSON.stringify(filter)} applied={filter} onApply={setFilter} />
      <QueryBoundary
        query={pages}
        label="activities"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: q
            ? `No activities match "${q}"`
            : kind
              ? `No ${OFFERING_KIND_LABELS[kind].toLowerCase()} activities`
              : 'No activities',
          description: filtered
            ? 'Nothing matching this filter is published right now. Show all activities to see everything.'
            : 'Leagues, programs, camps and other activities appear here when the facility publishes them.',
          ...(filtered
            ? {
                actionLabel: 'Show all activities',
                onAction: () => {
                  setKind(null);
                  setFilter(EMPTY_FILTER);
                  setQ('');
                },
              }
            : {}),
        }}
        unavailableOffline={['Registration']}
      >
        {(items) => (
          <View accessibilityRole="list">
            {items.map((offering) => (
              <ListRow
                key={offering.id}
                title={offering.name}
                detail={offeringSummary(offering)}
                status={registrationWindowStatus(offering)}
                badges={promotionBadges(offering)}
                icon={KIND_LOOK[offering.kind][0]}
                iconTone={[KIND_LOOK[offering.kind][1], colors.primaryText]}
                onPress={() => router.push(registrationRoutes.offering(offering.id))}
                accessibilityHint="Opens the activity details"
                testID={`offering-${offering.id}`}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="activities" />
      {conditional.length < CONDITIONAL_FILTER_KINDS.length ? (
        <Text style={styles.caption}>
          Pickup sessions, rentals, parties, packages and memberships are listed only where the
          facility has turned them on; whether each is offered is still being decided (DEC-016).
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.night, borderColor: colors.night },
  chipText: { ...type.caption, ...fonts.bold, color: colors.text },
  chipTextOn: { color: colors.primaryText },
  caption: { ...type.caption, color: colors.textMuted, padding: spacing.lg },
});
