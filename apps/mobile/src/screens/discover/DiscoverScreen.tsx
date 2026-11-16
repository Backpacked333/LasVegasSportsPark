/**
 * SCR-C-07 Discover, shown as Explore (SPK-UX-002, SPK-CAT-001, SPK-CAT-002, SPK-CAT-004,
 * SPK-SCHED-008, §4.14; journey A1; PA-11 **Proposed** label and customer words; ADR-008 visual
 * system v2). Browses the public catalog `GET /v1/offerings`: published activities with child-safe
 * fields only, each as a picture card with its registration window ("Registration opens <date>" in
 * the facility's time zone, "Registration open", "Registration paused", never a paused activity
 * shown as closed). Private or draft activities are simply absent: the API does not return them.
 *
 * Finding something. Every filter is applied by the API, each change is a new read of the list
 * (its loading state while it answers), and the chips always show what is applied:
 * - Search: free text (`q`, 2 to 100 characters; every word must appear in the activity's name,
 *   description, activity type, format, location or program name, as the API matches it), sent
 *   after a short pause in typing or at once on the keyboard's search key.
 * - Category chips (`kind`): Leagues, Classes, Camps, Trials, Coaching. Pickup, rentals, parties,
 *   class packs and memberships are conditional capabilities (K-12, DEC-016, DEC-072 to DEC-082):
 *   a signed-in customer gets their chip only while the organization's switch is on
 *   (`GET /v1/me/permissions`); with the switch off there is no chip and no note (PA-11).
 * - Sport chips add their word to `q` (with the search text, if any), so no other parameter is
 *   needed. "Format" (`format`, as the facility writes it) is a sheet at the end of that row.
 * - When chips: "This week" (today to Sunday) and "This month" (today to its last day), from
 *   today in the facility's zone (SPK-SCHED-008), and "Pick dates" (a range sheet). A range is
 *   sent as `from` (activities ending on or after it starts) and `to` (starting on or before it
 *   ends), so every activity that runs on any day of it is listed. A range that ends before it
 *   starts cannot be applied.
 * Filtering by age waits on DEC-003; no age filter is offered and each card shows its age band.
 *
 * States: loading; empty (nothing published for the filter, with the search illustration and
 * "Show all activities", shown right under the search so it is on the first screen); ready; validation failure (search or a filter sheet); offline (cached
 * list with its age); unavailable (catalog not reachable, retry, the code in "Details for
 * support"); paged with "Load more activities"; pull to refresh. A signed-out visitor browses the
 * organization configured for this build (deployment setting), and is also offered today's
 * schedule and the public standings when the organization has made them public (SPK-SCHED-010,
 * proposed amendment PA-06; PublicViews.tsx); without an organization they are asked to sign in.
 * Signed in, "In progress" lists what the customer can come back to, from the API (SPK-UX-001),
 * and "Picked for <child>" (PickedFor.tsx) shows activities whose age band fits a family member
 * (`GET /v1/me/offering-suggestions`) while no filter is applied, by age only, never as
 * eligibility. Promotions: each card shows the automatic discounts the API lists for it now
 * (`promotions`, never promo codes) as tags; the review decides what is applied.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState, type RefObject } from 'react';
import { View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { artworkFor } from '../../artwork/artworkFor';
import { illustrations } from '../../artwork/manifest';
import type { OfferingKind } from '../../features/registration/format';
import {
  MY_BASKETS_KEY,
  MY_CHECKOUTS_KEY,
  MY_WAITLIST_KEY,
} from '../../features/registration/in-progress';
import { InProgressCard } from '../../features/registration/InProgressCard';
import { registrationRoutes } from '../../features/registration/routes';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Chip, ChipRow } from '../../ui/Chip';
import { addIsoDays, DateRangeField, type DateRange } from '../../ui/DateField';
import { todayIn, weekStartOf } from '../../ui/DateStrip';
import { EmptyState } from '../../ui/EmptyState';
import { FieldError, SearchField, TextField } from '../../ui/Field';
import { LoadMore } from '../../ui/LoadMore';
import { MediaCard } from '../../ui/MediaCard';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { StateView } from '../../ui/StateView';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { PublicLinks } from '../public/PublicViews';
import {
  CONDITIONAL_CATEGORIES,
  EXPLORE_CATEGORIES,
  EXPLORE_SPORTS,
  KIND_WORD,
  offeringCardLabel,
  offeringCardLine,
  offeringPlaceLine,
  offeringTags,
  shortDates,
} from './offering-look';
import { PickedFor } from './PickedFor';

type OfferingListItem = Schema<'OfferingListItem'>;

export const DISCOVER_PAGE_SIZE = 50;

/** How long the search waits after the last keystroke before it is sent. */
export const SEARCH_DEBOUNCE_MS = 400;

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

/** Field messages for a filter as entered; empty when it can be sent. */
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

/** A "When" chip: a fixed range from today, or dates picked in the sheet. */
export type WhenChoice = 'week' | 'month' | 'dates';

/**
 * The dates "This week" and "This month" send, from `today` (an ISO date in the facility's
 * zone): today to the Sunday of its week (weeks start on Monday), or today to the month's last
 * day.
 */
export function whenRange(when: 'week' | 'month', today: string): { from: string; to: string } {
  if (when === 'week') return { from: today, to: addIsoDays(weekStartOf(today, 1), 6) };
  const [y, m] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: today, to: `${today.slice(0, 8)}${String(last).padStart(2, '0')}` };
}

/** What the screen has applied, as the list read sends it. */
export interface ExploreSelection {
  kind: OfferingKind | null;
  /** The sport chip's word, added to `q`. */
  sport: string | null;
  /** The applied search text. */
  search: string;
  filter: DiscoverFilter;
}

/** The `q` sent: the search text, then the sport's word. Empty when neither is applied. */
export function searchQuery(selection: Pick<ExploreSelection, 'search' | 'sport'>): string {
  return [selection.search.trim(), selection.sport ?? '']
    .filter((part) => part !== '')
    .join(' ')
    .slice(0, 100);
}

/** The query of `GET /v1/offerings` for a selection (only parameters the API accepts). */
export function exploreQuery(
  selection: ExploreSelection,
  context: { signedIn: boolean; organizationSlug: string | null },
) {
  const q = searchQuery(selection);
  const { filter, kind } = selection;
  return {
    limit: DISCOVER_PAGE_SIZE,
    ...(kind ? { kind } : {}),
    ...(filter.format ? { format: filter.format } : {}),
    ...(filter.from ? { from: filter.from } : {}),
    ...(filter.to ? { to: filter.to } : {}),
    ...(q ? { q } : {}),
    ...(!context.signedIn && context.organizationSlug
      ? { organization: context.organizationSlug }
      : {}),
  };
}

function ActivityCard({ offering }: { offering: OfferingListItem }) {
  const router = useRouter();
  const styles = useStyles();
  return (
    <MediaCard
      form="hero"
      source={artworkFor(offering, 'wide').source}
      aspectRatio={16 / 9}
      eyebrow={KIND_WORD[offering.kind]}
      title={offering.name}
      meta={[offeringCardLine(offering), offeringPlaceLine(offering)].filter(Boolean)}
      tags={offeringTags(offering)}
      accessibilityLabel={offeringCardLabel(offering)}
      accessibilityHint="Opens the activity"
      onPress={() => router.push(registrationRoutes.offering(offering.id))}
      style={styles.card}
      testID={`offering-${offering.id}`}
    />
  );
}

/** "Pick dates": a range in a sheet; both dates are needed and the end is not before the start. */
function DatesSheet({
  open,
  applied,
  onApply,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  applied: DateRange;
  onApply: (range: { from: string; to: string } | null) => void;
  onClose: () => void;
  returnFocusTo: RefObject<View | null>;
}) {
  const [draft, setDraft] = useState<DateRange>(applied);
  const complete = draft.start !== null && draft.end !== null && draft.start <= draft.end;
  const hasApplied = applied.start !== null || applied.end !== null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pick dates"
      returnFocusTo={returnFocusTo}
      footer={
        <View style={{ gap: spacing.sm }}>
          <Button
            label="Apply"
            size="lg"
            block
            disabled={!complete}
            onPress={() =>
              draft.start && draft.end ? onApply({ from: draft.start, to: draft.end }) : undefined
            }
          />
          {hasApplied ? (
            <Button label="Clear dates" variant="secondary" block onPress={() => onApply(null)} />
          ) : null}
        </View>
      }
    >
      <DateRangeField
        label="Dates"
        hint="Activities that run on any day between these dates"
        startLabel="From"
        endLabel="To"
        value={draft}
        onChange={setDraft}
      />
    </Sheet>
  );
}

/** "Format": the facility's own words for it ("7v7"), sent as `format`. */
function FormatSheet({
  open,
  applied,
  onApply,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  applied: string;
  onApply: (format: string) => void;
  onClose: () => void;
  returnFocusTo: RefObject<View | null>;
}) {
  const [draft, setDraft] = useState(applied);
  const [problem, setProblem] = useState<string | null>(null);
  const apply = () => {
    const found = filterProblems({ ...EMPTY_FILTER, format: draft }).format ?? null;
    setProblem(found);
    if (!found) onApply(draft.trim());
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Format"
      returnFocusTo={returnFocusTo}
      footer={
        <View style={{ gap: spacing.sm }}>
          <Button label="Apply" size="lg" block onPress={apply} />
          {applied ? (
            <Button label="Clear format" variant="secondary" block onPress={() => onApply('')} />
          ) : null}
        </View>
      }
    >
      <TextField
        label="Format"
        hint="As the facility writes it, for example 7v7"
        value={draft}
        onChangeText={setDraft}
        error={problem}
        onSubmitEditing={apply}
        returnKeyType="done"
      />
    </Sheet>
  );
}

export function DiscoverScreen() {
  const styles = useStyles();
  const { session, services } = useApp();
  const router = useRouter();
  const now = useNow();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<OfferingKind | null>(null);
  const [sport, setSport] = useState<string | null>(null);
  const [filter, setFilter] = useState<DiscoverFilter>(EMPTY_FILTER);
  const [when, setWhen] = useState<WhenChoice | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'dates' | 'format' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const datesTrigger = useRef<View>(null);
  const formatTrigger = useRef<View>(null);
  const signedIn = session.status === 'signed_in';
  const permissions = usePermissions({ enabled: signedIn });
  const slug = services.config.organizationSlug ?? null;
  const canBrowse = signedIn || slug !== null;
  const categories = [
    ...EXPLORE_CATEGORIES,
    ...CONDITIONAL_CATEGORIES.filter(
      (c) => signedIn && permissions.isCapabilityEnabled(c.capability) === true,
    ),
  ];
  const selection: ExploreSelection = { kind, sport, search, filter };
  const q = searchQuery(selection);
  const pages = useApiPages({
    path: '/offerings',
    request: { query: exploreQuery(selection, { signedIn, organizationSlug: slug }) },
    enabled: session.status !== 'loading' && canBrowse,
  });
  const dated = filter.from !== '' || filter.to !== '';
  const chipsApplied = kind !== null || sport !== null || filter.format !== '' || dated;
  const filtered = chipsApplied || search !== '';

  const runSearch = (text: string) => {
    const problem = searchProblem(text);
    setSearchError(problem);
    if (!problem) setSearch(text.trim());
  };
  const showAll = () => {
    setKind(null);
    setSport(null);
    setFilter(EMPTY_FILTER);
    setWhen(null);
    setDraft('');
    setSearch('');
    setSearchError(null);
  };
  const clearChips = () => {
    setKind(null);
    setSport(null);
    setFilter(EMPTY_FILTER);
    setWhen(null);
  };
  const chooseWhen = (choice: 'week' | 'month') => {
    if (when === choice) {
      setWhen(null);
      setFilter((f) => ({ ...f, from: '', to: '' }));
      return;
    }
    // SPK-SCHED-008: "today" is the facility's day, read from the injected clock.
    const today = todayIn(now, pages.data?.[0]?.facility.timezone ?? null);
    setWhen(choice);
    setFilter((f) => ({ ...f, ...whenRange(choice, today) }));
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(pages.refetch()),
        queryClient.invalidateQueries({ queryKey: ['api', '/me/offering-suggestions'] }),
        ...(signedIn
          ? [MY_BASKETS_KEY, MY_CHECKOUTS_KEY, MY_WAITLIST_KEY].map((queryKey) =>
              queryClient.invalidateQueries({ queryKey }),
            )
          : []),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

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
          description="Leagues, classes, camps and other activities appear here after you sign in."
          actionLabel="Sign in"
          onAction={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }

  // §4.10: once the API answers NOT_FOUND or ACCESS_DENIED, cached items are no longer shown.
  const unavailable = pages.error !== null && presentationForError(pages.error) === 'unavailable';
  const items = unavailable ? [] : (pages.data ?? []);
  const emptyTitle = q
    ? `No activities match "${q}"`
    : kind
      ? `No ${KIND_WORD[kind].toLowerCase()} activities`
      : filtered
        ? 'No activities match these filters'
        : 'No activities';
  const empty =
    pages.data !== undefined && !unavailable ? (
      <EmptyState
        source={illustrations['empty-search']}
        title={emptyTitle}
        message={
          filtered
            ? 'Nothing matching this filter is published right now. Show all activities to see everything.'
            : 'Leagues, classes, camps and other activities appear here when the facility publishes them.'
        }
        action={filtered ? { label: 'Show all activities', onPress: showAll } : undefined}
        testID="discover-empty"
      />
    ) : null;

  const pickedDates: DateRange =
    when === 'dates'
      ? { start: filter.from, end: filter.to }
      : {
          start: null,
          end: null,
        };

  return (
    <Screen<OfferingListItem>
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      list={{
        data: items,
        keyExtractor: (offering) => offering.id,
        renderItem: ({ item }) => <ActivityCard offering={item} />,
        ListFooterComponent: <LoadMore pages={pages} label="activities" />,
      }}
    >
      {signedIn ? <InProgressCard /> : null}
      {/* SPK-SCHED-010: today's schedule and public standings need no sign-in. */}
      {!signedIn ? <PublicLinks /> : null}
      <View style={styles.search}>
        <SearchField
          label="Search activities"
          placeholder="Leagues, camps, classes, fields…"
          value={draft}
          onChangeText={setDraft}
          onSearch={runSearch}
          debounceMs={SEARCH_DEBOUNCE_MS}
          testID="discover-q"
        />
        <FieldError error={searchError} />
      </View>
      {/*
        No results: the answer comes straight under the search, above the filter rows, so it is on
        the first screen even on a small phone (375 x 667); the filters stay below to change.
      */}
      {items.length === 0 ? empty : null}
      <View style={styles.chips}>
        <ChipRow
          mode="single"
          label="Activity type"
          allowEmpty
          options={categories.map((c) => ({ value: c.kind, label: c.label, icon: c.icon }))}
          value={kind}
          onChange={setKind}
          testID="discover-categories"
        />
        <ChipRow label="Sport" testID="discover-sports">
          {EXPLORE_SPORTS.map((s) => (
            <Chip
              key={s.word}
              label={s.label}
              selected={sport === s.word}
              onPress={() => setSport(sport === s.word ? null : s.word)}
            />
          ))}
          <View ref={formatTrigger} collapsable={false}>
            <Chip
              label={filter.format ? `Format: ${filter.format}` : 'Format'}
              icon="tune"
              selected={filter.format !== ''}
              accessibilityHint="Choose a format, such as 7v7"
              onPress={() => setSheet('format')}
            />
          </View>
        </ChipRow>
        <ChipRow label="When" testID="discover-when">
          <Chip label="This week" selected={when === 'week'} onPress={() => chooseWhen('week')} />
          <Chip
            label="This month"
            selected={when === 'month'}
            onPress={() => chooseWhen('month')}
          />
          <View ref={datesTrigger} collapsable={false}>
            <Chip
              label={
                when === 'dates'
                  ? shortDates({ startsOn: filter.from, endsOn: filter.to })
                  : 'Pick dates'
              }
              accessibilityLabel={
                when === 'dates'
                  ? `Pick dates, ${shortDates({ startsOn: filter.from, endsOn: filter.to })}`
                  : 'Pick dates'
              }
              icon="calendar_today"
              selected={when === 'dates'}
              onPress={() => setSheet('dates')}
            />
          </View>
          {chipsApplied ? <Chip label="Clear filters" icon="close" onPress={clearChips} /> : null}
        </ChipRow>
      </View>
      {signedIn && !filtered ? <PickedFor /> : null}
      {/* The list's own state (loading, failure, offline with its age); the items follow. */}
      <QueryBoundary
        query={pages}
        label="activities"
        empty={{ title: emptyTitle, description: '' }}
        unavailableOffline={['Registration']}
      >
        {() => null}
      </QueryBoundary>
      {sheet === 'dates' ? (
        <DatesSheet
          open
          applied={pickedDates}
          returnFocusTo={datesTrigger}
          onClose={() => setSheet(null)}
          onApply={(range) => {
            setSheet(null);
            setWhen(range ? 'dates' : null);
            setFilter((f) => ({ ...f, from: range?.from ?? '', to: range?.to ?? '' }));
          }}
        />
      ) : null}
      {sheet === 'format' ? (
        <FormatSheet
          open
          applied={filter.format}
          returnFocusTo={formatTrigger}
          onClose={() => setSheet(null)}
          onApply={(format) => {
            setSheet(null);
            setFilter((f) => ({ ...f, format }));
          }}
        />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  search: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm, gap: spacing.xs },
  chips: { gap: spacing.sm, paddingVertical: spacing.md },
  card: { marginHorizontal: layout.gutter, marginBottom: layout.cardGap },
}));
