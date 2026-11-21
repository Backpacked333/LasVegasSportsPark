/**
 * SCR-C-07 Discover, shown as Explore: "shop for one child" (redesign handoff M 1d; INTERACTIONS
 * "1d · Explore"; SPK-UX-002, SPK-CAT-001, SPK-CAT-002, SPK-CAT-004, SPK-SCHED-008, SPK-REG-005,
 * §4.14; ADR-008 visual system v2, PA-11 customer words, both **Proposed**).
 *
 * - **Search** (row 1): free text sent to `GET /v1/offerings?q=` after a 250 ms pause in typing
 *   (or at once on the keyboard's search key). The API matches the activity's name, description,
 *   activity type (the sport), format, location and program; it does not index coaches, so a
 *   coach's name finds nothing yet (**Proposed** follow-up for the catalog). No results: "Nothing
 *   matches. Try a sport or a day." with chips for popular sports.
 * - **Looking for** (row 2): the household as chips with each child's age ("Maya · 8"), on the
 *   shared who-filter (Home and Calendar use the same choice, remembered on the device). With a
 *   child chosen the list keeps only activities whose published age band includes their age, and
 *   the hint says so; tapping the chosen chip again shows everyone. Registration still asks the
 *   API's eligibility (Who step).
 * - **One fit answer per card** (row 3): ✕ "Full · waitlist", ▲ "Clashes with Desert Foxes"
 *   (the activity's sessions against the child's calendar for eight weeks: sessions, bookings and
 *   team games) or ✓ "Fits Maya's week"; nothing while unknown.
 * - **Places** (row 4): "3 left" at five or fewer from `GET /v1/offering-availability`; hidden when
 *   that read fails, never guessed.
 * - **Promotions**: the automatic discount the API lists now, as a floodlight tag on the picture.
 * - Camp weeks of one program are one card (the weeks are chosen on Options, 2a).
 * - Category chips (All, Camps, Leagues, Classes, …; conditional capabilities only while their
 *   switch is on), and a filters sheet behind the tune button: This week, This month, Pick dates
 *   and the facility's format words.
 *
 * States: loading (skeleton rows), empty, no results, error with code and "Try again", offline
 * (cached list with its age in the shared banner), paged with "Load more activities", pull to
 * refresh. Signed out: the configured organization's catalog with the public schedule links, no
 * "Looking for". Signed in, "In progress" lists what the customer can come back to.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { illustrations } from '../../artwork/manifest';
import { useBusyTimes } from '../../features/register/family-busy';
import { useExploreFacts } from '../../features/register/explore-facts';
import {
  ageFits,
  campName,
  cardPrice,
  fitAnswer,
  groupForExplore,
  lengthWords,
  meetingPattern,
  placesBadge,
  shortRange,
  wholeMoney,
  type ExploreItem,
} from '../../features/register/fit';
import {
  chipLabel,
  lookingForHint,
  useLookingFor,
  type LookingForPerson,
} from '../../features/register/looking-for';
import type { OfferingKind } from '../../features/registration/format';
import {
  MY_BASKETS_KEY,
  MY_CHECKOUTS_KEY,
  MY_WAITLIST_KEY,
} from '../../features/registration/in-progress';
import { InProgressCard } from '../../features/registration/InProgressCard';
import { registrationRoutes } from '../../features/registration/routes';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Chip, ChipRow } from '../../ui/Chip';
import { addIsoDays, DateRangeField, type DateRange } from '../../ui/DateField';
import { todayIn, weekStartOf } from '../../ui/DateStrip';
import { EmptyState } from '../../ui/EmptyState';
import { FieldError, SearchField, TextField } from '../../ui/Field';
import { IconButton } from '../../ui/IconButton';
import { LoadMore } from '../../ui/LoadMore';
import { personColorOf } from '../../ui/person-colors';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { Skeleton } from '../../ui/Skeleton';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { fonts, layout, makeStyles, radius, spacing, useTheme } from '../../ui/theme';
import { PublicLinks } from '../public/PublicViews';
import { ActivityRow, PickedCard, type CardFacts } from './ExploreCards';
import { CONDITIONAL_CATEGORIES, EXPLORE_CATEGORIES, EXPLORE_SPORTS } from './offering-look';

type OfferingListItem = Schema<'OfferingListItem'>;
type PublicOffering = Schema<'PublicOffering'>;

export const DISCOVER_PAGE_SIZE = 50;

/** How long the search waits after the last keystroke before it is sent (handoff 1d row 1). */
export const SEARCH_DEBOUNCE_MS = 250;

/** How many "Picked for" tiles are asked for. */
export const PICKED_COUNT = 6;

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
  /** The applied search text. */
  search: string;
  filter: DiscoverFilter;
}

/** The query of `GET /v1/offerings` for a selection (only parameters the API accepts). */
export function exploreQuery(
  selection: ExploreSelection,
  context: { signedIn: boolean; organizationSlug: string | null },
) {
  const q = selection.search.trim().slice(0, 100);
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

/** Keeps what the chosen person's age fits (everything without a person or an age). */
export function forPerson<T extends Pick<PublicOffering, 'ageBand'>>(
  items: readonly T[],
  person: Pick<LookingForPerson, 'age'> | null,
): T[] {
  if (!person || person.age === null) return [...items];
  const age = person.age;
  return items.filter((o) => ageFits(o.ageBand, age));
}

/** "Picked for Maya", "All for Maya"; "Picked for you"; "All activities" for everyone. */
export function listTitle(person: LookingForPerson | null): string {
  if (!person) return 'All activities';
  return person.self ? 'All for you' : `All for ${person.givenName}`;
}

/** The card's words and answers for one grouped item. */
function factsFor(
  item: ExploreItem<PublicOffering>,
  facts: ReturnType<typeof useExploreFacts>,
  busy: ReturnType<typeof useBusyTimes>['busy'],
  person: LookingForPerson | null,
): CardFacts {
  const lead = item.lead;
  const zone = lead.facility.timezone;
  const sessions = facts.sessionsOf(lead.id);
  const camp = item.members.length > 1 || lead.kind === 'camp';
  const first = item.members[0] ?? lead;
  const last = item.members[item.members.length - 1] ?? lead;
  const pattern = sessions ? meetingPattern(sessions, zone, { range: camp }) : null;
  const length = sessions ? lengthWords(sessions, zone) : null;
  const when = camp
    ? [shortRange(first.startsOn, last.endsOn), pattern?.replace(/^Weekdays /u, '')]
        .filter(Boolean)
        .join(' · ')
    : pattern
      ? [pattern, length].filter(Boolean).join(' · ')
      : shortRange(lead.startsOn, lead.endsOn);
  const price = lead.price && !lead.price.notQuotable ? lead.price : null;
  const availability = facts.availabilityOf(lead.id);
  return {
    name: camp ? campName(item.name) : item.name,
    when,
    price:
      camp && price
        ? `${wholeMoney(price.basePriceMinor, price.currency)} / week`
        : cardPrice(lead.price),
    fit: fitAnswer({
      offeringIds: item.members.map((m) => m.id),
      availability,
      sessions,
      busy,
      childName: person ? (person.self ? 'your' : person.givenName) : null,
    }),
    places: placesBadge(availability),
    promotion: lead.promotions[0]?.name ?? null,
  };
}

function LookingFor({
  people,
  selected,
  onSelect,
}: {
  people: readonly LookingForPerson[];
  selected: LookingForPerson | null;
  onSelect: (personId: string | null) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  if (people.length === 0) return null;
  return (
    <View style={styles.lookingFor} testID="looking-for">
      <Text variant="label" tone="muted">
        Looking for
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.lookingChips}
        accessibilityRole="radiogroup"
        accessibilityLabel="Looking for"
      >
        {people.map((person) => {
          const on = selected?.id === person.id;
          return (
            <Pressable
              key={person.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, selected: on }}
              accessibilityLabel={
                person.self
                  ? `Me (${person.givenName})`
                  : person.age !== null
                    ? `${person.givenName}, ${person.age}`
                    : person.givenName
              }
              accessibilityHint={on ? 'Tap again to show everyone' : undefined}
              hitSlop={{ top: 2, bottom: 2 }}
              onPress={() => onSelect(on ? null : person.id)}
              style={[
                styles.personChip,
                person.self ? styles.meChip : null,
                on ? styles.personChipOn : styles.personChipOff,
              ]}
              testID={`looking-for-${person.self ? 'me' : person.id}`}
            >
              {person.self ? null : (
                <Avatar
                  name={person.givenName}
                  id={person.id}
                  personColor={personColorOf(theme, person.slot)}
                  size={30}
                  decorative
                />
              )}
              <Text style={[styles.personLabel, on ? styles.personLabelOn : null]}>
                {chipLabel(person)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text variant="footnote" tone="muted" testID="looking-for-hint">
        {lookingForHint(selected)}
      </Text>
    </View>
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

/** The tune button's sheet: when, and the facility's format words ("7v7"). */
function FiltersSheet({
  open,
  filter,
  when,
  onWhen,
  onPickDates,
  onFormat,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  filter: DiscoverFilter;
  when: WhenChoice | null;
  onWhen: (choice: 'week' | 'month') => void;
  onPickDates: () => void;
  onFormat: (format: string) => void;
  onClose: () => void;
  returnFocusTo: RefObject<View | null>;
}) {
  const [draft, setDraft] = useState(filter.format);
  const [problem, setProblem] = useState<string | null>(null);
  const apply = () => {
    const found = filterProblems({ ...EMPTY_FILTER, format: draft }).format ?? null;
    setProblem(found);
    if (!found) onFormat(draft.trim());
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filters"
      returnFocusTo={returnFocusTo}
      footer={<Button label="Show activities" size="lg" block onPress={apply} />}
    >
      <ChipRow label="When" testID="discover-when" inset={0}>
        <Chip label="This week" selected={when === 'week'} onPress={() => onWhen('week')} />
        <Chip label="This month" selected={when === 'month'} onPress={() => onWhen('month')} />
        <Chip
          label={when === 'dates' ? shortRange(filter.from, filter.to) : 'Pick dates'}
          icon="calendar_today"
          selected={when === 'dates'}
          onPress={onPickDates}
        />
      </ChipRow>
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

function RowSkeletons() {
  const styles = useStyles();
  return (
    <View style={styles.skeletons} testID="discover-loading" accessible={false}>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} shape="block" height={88} />
      ))}
    </View>
  );
}

export function DiscoverScreen() {
  const styles = useStyles();
  const { session, services } = useApp();
  const router = useRouter();
  const now = useNow();
  const { width } = useWindowDimensions();
  const queryClient = useQueryClient();
  const signedIn = session.status === 'signed_in';
  const [kind, setKind] = useState<OfferingKind | null>(null);
  const [filter, setFilter] = useState<DiscoverFilter>(EMPTY_FILTER);
  const [when, setWhen] = useState<WhenChoice | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'filters' | 'dates' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const filtersTrigger = useRef<View>(null);
  const permissions = usePermissions({ enabled: signedIn });
  const slug = services.config.organizationSlug ?? null;
  const canBrowse = signedIn || slug !== null;
  const categories = [
    EXPLORE_CATEGORIES.find((c) => c.kind === 'camp'),
    EXPLORE_CATEGORIES.find((c) => c.kind === 'season'),
    EXPLORE_CATEGORIES.find((c) => c.kind === 'term'),
    ...EXPLORE_CATEGORIES.filter((c) => !['camp', 'season', 'term'].includes(c.kind)),
    ...CONDITIONAL_CATEGORIES.filter(
      (c) => signedIn && permissions.isCapabilityEnabled(c.capability) === true,
    ),
  ].filter((c): c is (typeof EXPLORE_CATEGORIES)[number] => c !== undefined);
  const pages = useApiPages({
    path: '/offerings',
    request: {
      query: exploreQuery({ kind, search, filter }, { signedIn, organizationSlug: slug }),
    },
    enabled: session.status !== 'loading' && canBrowse,
  });
  const zone = useKnownFacilityZone(pages.data?.[0]?.facility.timezone).zone;
  const lookingFor = useLookingFor(zone);
  const person = signedIn ? lookingFor.selected : null;
  const busy = useBusyTimes(person?.id ?? null, zone).busy;

  // §4.10: once the API answers NOT_FOUND or ACCESS_DENIED, cached items are no longer shown.
  const unavailable = pages.error !== null && presentationForError(pages.error) === 'unavailable';
  const items = useMemo(
    () => groupForExplore(forPerson(unavailable ? [] : (pages.data ?? []), person)),
    [pages.data, unavailable, person],
  );
  const picked = useApiQuery({
    path: '/me/offering-suggestions',
    request: { query: { participantPersonId: person?.id ?? '', limit: PICKED_COUNT } },
    enabled: signedIn && person !== null && !person.self,
    staleTime: 60_000,
  });
  const filtered = kind !== null || search !== '' || filter.format !== '' || when !== null;
  const pickedItems = useMemo(
    () =>
      filtered || !person || person.self
        ? []
        : groupForExplore((picked.data?.items ?? []).map((s) => s.offering)),
    [picked.data, filtered, person],
  );
  const leads = [...items, ...pickedItems].map((i) => i.lead.id);
  const facts = useExploreFacts(leads, leads, signedIn);

  const runSearch = (text: string) => {
    const problem = searchProblem(text);
    setSearchError(problem);
    if (!problem) setSearch(text.trim());
  };
  const showAll = () => {
    setKind(null);
    setFilter(EMPTY_FILTER);
    setWhen(null);
    setDraft('');
    setSearch('');
    setSearchError(null);
  };
  const chooseWhen = (choice: 'week' | 'month') => {
    if (when === choice) {
      setWhen(null);
      setFilter((f) => ({ ...f, from: '', to: '' }));
      return;
    }
    // SPK-SCHED-008: "today" is the facility's day, read from the injected clock.
    const today = todayIn(now, zone);
    setWhen(choice);
    setFilter((f) => ({ ...f, ...whenRange(choice, today) }));
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(pages.refetch()),
        queryClient.invalidateQueries({ queryKey: ['api', '/me/offering-suggestions'] }),
        queryClient.invalidateQueries({ queryKey: ['api', '/offering-availability'] }),
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
        <RowSkeletons />
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

  const open = (item: ExploreItem<PublicOffering>) =>
    router.push(registrationRoutes.offering(item.lead.id));
  const noResults =
    pages.data !== undefined && !unavailable && items.length === 0 ? (
      filtered || person ? (
        <View style={styles.noResults}>
          <EmptyState
            source={illustrations['empty-search']}
            title="Nothing matches. Try a sport or a day."
            message={
              person && person.age !== null && !filtered
                ? `Nothing published fits age ${person.age} right now.`
                : 'Search for a sport, or clear the filters to see everything.'
            }
            announce
            testID="discover-empty"
          />
          <ChipRow label="Popular sports" testID="discover-sports">
            {EXPLORE_SPORTS.map((s) => (
              <Chip
                key={s.word}
                label={s.label}
                onPress={() => {
                  setDraft(s.label);
                  runSearch(s.word);
                }}
              />
            ))}
          </ChipRow>
          {filtered ? (
            <Button label="Show all activities" variant="secondary" onPress={showAll} />
          ) : null}
        </View>
      ) : (
        <EmptyState
          source={illustrations['empty-search']}
          title="No activities"
          message="Leagues, classes, camps and other activities appear here when the facility publishes them."
          testID="discover-empty"
        />
      )
    ) : null;

  const tileWidth = Math.min(240, Math.round(width * 0.56));
  return (
    <Screen<ExploreItem<OfferingListItem>>
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      list={{
        data: items as ExploreItem<OfferingListItem>[],
        keyExtractor: (item) => item.lead.id,
        renderItem: ({ item }) => (
          <View style={styles.rowWrap}>
            <ActivityRow
              offering={item.lead}
              facts={factsFor(item, facts, busy, person)}
              onPress={() => open(item)}
              testID={`offering-${item.lead.id}`}
            />
          </View>
        ),
        ListFooterComponent: <LoadMore pages={pages} label="activities" />,
      }}
    >
      {/* SPK-SCHED-010: today's schedule and public standings need no sign-in. */}
      {!signedIn ? <PublicLinks /> : null}
      <View style={styles.searchRow}>
        <SearchField
          label="Search activities"
          placeholder="Camps, leagues, classes…"
          value={draft}
          onChangeText={setDraft}
          onSearch={runSearch}
          debounceMs={SEARCH_DEBOUNCE_MS}
          style={styles.searchField}
          testID="discover-q"
        />
        <View ref={filtersTrigger} collapsable={false}>
          <IconButton
            icon="tune"
            label={filter.format || when ? 'Filters, some applied' : 'Filters'}
            onPress={() => setSheet('filters')}
            testID="discover-filters"
          />
        </View>
      </View>
      <View style={styles.gutter}>
        <FieldError error={searchError} />
      </View>
      {signedIn ? (
        <LookingFor
          people={lookingFor.people}
          selected={person}
          onSelect={(id) => lookingFor.select(id)}
        />
      ) : null}
      <View style={styles.categories}>
        <ChipRow label="Activity type" testID="discover-categories">
          <Chip label="All" selected={kind === null} onPress={() => setKind(null)} />
          {categories.map((c) => (
            <Chip
              key={c.kind}
              label={c.label}
              selected={kind === c.kind}
              onPress={() => setKind(kind === c.kind ? null : c.kind)}
            />
          ))}
        </ChipRow>
      </View>
      {signedIn ? <InProgressCard /> : null}
      {pickedItems.length > 0 && person ? (
        <View style={styles.section} testID="discover-picked">
          <Text variant="title3" heading style={styles.gutter}>
            {`Picked for ${person.givenName}`}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pickedRow}
          >
            {pickedItems.map((item) => (
              <PickedCard
                key={item.lead.id}
                offering={item.lead}
                facts={factsFor(item, facts, busy, person)}
                width={tileWidth}
                onPress={() => open(item)}
                testID={`picked-${item.lead.id}`}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {noResults}
      {/* The list's own state (loading, failure, offline with its age); the items follow. */}
      {pages.data === undefined && pages.error === null ? (
        <RowSkeletons />
      ) : (
        <QueryBoundary
          query={pages}
          label="activities"
          empty={{ title: 'No activities', description: '' }}
          unavailableOffline={['Registration']}
        >
          {() => null}
        </QueryBoundary>
      )}
      {items.length > 0 ? (
        <View style={[styles.listHead, styles.gutter]}>
          <Text variant="title3" heading>
            {listTitle(person)}
          </Text>
          <Text variant="footnote" tone="muted" testID="discover-count">
            {`${items.length} ${items.length === 1 ? 'result' : 'results'}`}
          </Text>
        </View>
      ) : null}
      {sheet === 'filters' ? (
        <FiltersSheet
          open
          filter={filter}
          when={when}
          onWhen={chooseWhen}
          onPickDates={() => setSheet('dates')}
          onFormat={(format) => {
            setSheet(null);
            setFilter((f) => ({ ...f, format }));
          }}
          onClose={() => setSheet(null)}
          returnFocusTo={filtersTrigger}
        />
      ) : null}
      {sheet === 'dates' ? (
        <DatesSheet
          open
          applied={
            when === 'dates' ? { start: filter.from, end: filter.to } : { start: null, end: null }
          }
          returnFocusTo={filtersTrigger}
          onClose={() => setSheet(null)}
          onApply={(range) => {
            setSheet(null);
            setWhen(range ? 'dates' : null);
            setFilter((f) => ({ ...f, from: range?.from ?? '', to: range?.to ?? '' }));
          }}
        />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  gutter: { paddingHorizontal: layout.gutter },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: layout.gutter,
    paddingRight: layout.gutter - spacing.xs,
    paddingTop: spacing.sm,
  },
  searchField: { flex: 1 },
  lookingFor: {
    marginHorizontal: layout.gutter,
    marginTop: 14,
    padding: 14,
    paddingTop: spacing.md,
    gap: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderCurve: 'continuous',
  },
  lookingChips: { flexDirection: 'row', gap: spacing.sm },
  personChip: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: 5,
    paddingRight: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  meChip: { paddingLeft: 14 },
  personChipOn: { backgroundColor: colors.chipSelected, borderColor: colors.chipSelected },
  personChipOff: { backgroundColor: colors.background, borderColor: colors.control },
  personLabel: { ...fonts.semibold, fontSize: 14, lineHeight: 18, color: colors.text },
  personLabelOn: { color: colors.onChipSelected },
  categories: { paddingTop: spacing.md },
  section: { marginTop: 20, gap: spacing.sm },
  pickedRow: { gap: spacing.md, paddingHorizontal: layout.gutter, paddingBottom: spacing.xs },
  listHead: {
    marginTop: 20,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  rowWrap: { paddingHorizontal: layout.gutter, marginBottom: spacing.sm },
  noResults: { gap: spacing.md, paddingVertical: spacing.lg },
  skeletons: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
}));
