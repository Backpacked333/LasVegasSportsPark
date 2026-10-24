/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001, SPK-CAT-002, SPK-CAT-004, §4.14; journey A1).
 * Browses the public catalog `GET /v1/offerings`: published offerings with child-safe fields only,
 * each with its registration window state ("Registration opens <date>", "Registration open",
 * "Registration paused", never a paused offering shown as closed). Private or draft offerings are
 * simply absent: the API does not return them.
 *
 * States: loading; empty (nothing published for the filter); ready; offline (cached list with its
 * age); unavailable (catalog not reachable, retry); filter application keeps the list on screen.
 * A signed-out visitor browses the organization configured for this build (deployment setting);
 * without one they are asked to sign in.
 *
 * Pickup sessions, rentals, packages and memberships are conditional capabilities pending DEC-016,
 * DEC-072 to DEC-082 (Product owner): they get no filter here, and appear only when the API
 * publishes one. The API has no format or age-band filter (reported as an API gap); format and age
 * band are shown on every item.
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type ResponseBody,
  type Schema,
} from '@sportspark/api-client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  OFFERING_KIND_LABELS,
  ageBandLabel,
  formatMoney,
  type OfferingKind,
} from '../../features/registration/format';
import { useRegistrationProgress } from '../../features/registration/progress';
import { registrationRoutes } from '../../features/registration/routes';
import { offeringDates, registrationWindowStatus } from '../../features/registration/status';
import { useApi, useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

type PublicOffering = Schema<'PublicOffering'>;
type OfferingPage = ResponseBody<'/offerings', 'get'>;

export const DISCOVER_PAGE_SIZE = 50;

/** Kinds with a filter. Conditional capabilities (pickup, rental, package, membership) have none. */
export const DISCOVER_FILTER_KINDS: readonly OfferingKind[] = [
  'season',
  'term',
  'camp',
  'session',
  'trial',
  'private_coaching',
];

export function offeringSummary(offering: PublicOffering): string {
  return [
    OFFERING_KIND_LABELS[offering.kind],
    offering.format,
    ageBandLabel(offering.ageBand),
    offeringDates(offering),
    offering.locationLabel,
    offering.price
      ? `From ${formatMoney(offering.price.basePriceMinor, offering.price.currency)}`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function useOfferingPages(query: { kind?: OfferingKind; organization?: string }, enabled: boolean) {
  const api = useApi();
  const result = useInfiniteQuery<ApiResponse<OfferingPage>, ApiError>({
    queryKey: [...apiQueryKey('/offerings', { query }), 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.request('get', '/offerings', {
        query: {
          limit: DISCOVER_PAGE_SIZE,
          ...query,
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        signal,
      }),
    getNextPageParam: (last) => last.data.nextCursor,
    enabled,
  });
  const pages = result.data?.pages;
  return {
    boundary: {
      data: pages ? pages.flatMap((p) => p.data.items) : undefined,
      error: result.error,
      fetchStatus: result.fetchStatus,
      updatedAt: pages?.[0]?.receivedAt ?? null,
      refetch: result.refetch,
    },
    hasNextPage: result.hasNextPage,
    fetchNextPage: result.fetchNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
  };
}

function ResumeCard() {
  const router = useRouter();
  const { progress } = useRegistrationProgress();
  if (!progress.checkoutId && !progress.basketId && progress.waitlistEntryIds.length === 0) {
    return null;
  }
  return (
    <View style={styles.resume} testID="discover-resume">
      {progress.checkoutId ? (
        <Button
          label="Check your payment and registration"
          onPress={() => router.push(registrationRoutes.outcome(progress.checkoutId as string))}
        />
      ) : progress.basketId ? (
        <Button
          label="Continue your registration"
          onPress={() => router.push(registrationRoutes.basket(progress.basketId as string))}
        />
      ) : null}
      {progress.waitlistEntryIds.length > 0 ? (
        <Button
          label="Your waitlists"
          variant="secondary"
          onPress={() => router.push(registrationRoutes.waitlists())}
        />
      ) : null}
    </View>
  );
}

function KindFilter({
  value,
  onChange,
}: {
  value: OfferingKind | null;
  onChange: (kind: OfferingKind | null) => void;
}) {
  const options: { kind: OfferingKind | null; label: string }[] = [
    { kind: null, label: 'All activities' },
    ...DISCOVER_FILTER_KINDS.map((kind) => ({ kind, label: OFFERING_KIND_LABELS[kind] })),
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
            <Text style={[styles.chipText, checked && styles.chipTextOn]}>
              {checked ? `✓ ${option.label}` : option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function DiscoverScreen() {
  const { session, services } = useApp();
  const router = useRouter();
  const [kind, setKind] = useState<OfferingKind | null>(null);
  const signedIn = session.status === 'signed_in';
  const slug = services.config.organizationSlug ?? null;
  const canBrowse = signedIn || slug !== null;
  const query = {
    ...(kind ? { kind } : {}),
    ...(!signedIn && slug ? { organization: slug } : {}),
  };
  const pages = useOfferingPages(query, session.status !== 'loading' && canBrowse);

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
      {signedIn ? <ResumeCard /> : null}
      <KindFilter value={kind} onChange={setKind} />
      <QueryBoundary
        query={pages.boundary}
        label="activities"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: kind
            ? `No ${OFFERING_KIND_LABELS[kind].toLowerCase()} activities`
            : 'No activities',
          description: kind
            ? 'Nothing of this type is published right now. Choose All activities to see everything.'
            : 'Leagues, programs, camps and other activities appear here when the facility publishes them.',
          ...(kind ? { actionLabel: 'Show all activities', onAction: () => setKind(null) } : {}),
        }}
        unavailableOffline={['Registration']}
      >
        {(items) => (
          <View>
            <View accessibilityRole="list">
              {items.map((offering) => (
                <ListRow
                  key={offering.id}
                  title={offering.name}
                  detail={offeringSummary(offering)}
                  status={registrationWindowStatus(offering)}
                  onPress={() => router.push(registrationRoutes.offering(offering.id))}
                  accessibilityHint="Opens the activity details"
                  testID={`offering-${offering.id}`}
                />
              ))}
            </View>
            {pages.hasNextPage ? (
              <View style={styles.more}>
                <Button
                  label="Show more activities"
                  variant="secondary"
                  busy={pages.isFetchingNextPage}
                  onPress={() => void pages.fetchNextPage()}
                />
              </View>
            ) : null}
          </View>
        )}
      </QueryBoundary>
      <Text style={styles.caption}>
        Pickup sessions and rentals are listed only when the facility offers them; whether they are
        offered is still being decided (DEC-082, DEC-076).
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  resume: { padding: spacing.lg, gap: spacing.sm },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  chipOn: { backgroundColor: colors.primary },
  chipText: { ...type.caption, color: colors.primary, fontWeight: '600' },
  chipTextOn: { color: colors.primaryText },
  more: { padding: spacing.lg },
  caption: { ...type.caption, color: colors.textMuted, padding: spacing.lg },
});
