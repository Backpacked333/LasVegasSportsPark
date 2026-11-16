/**
 * Class packs (the API's session packages), mine and my family's (SCR-C-35 next to credits and makeups; Package G
 * conditional, §3.16; ENR-11, SPK-COND-002: a redemption is transactional and reversible).
 * Route: `/session-packages`, from Account; the same list is a section of SCR-C-35 (`/credits`).
 *
 * Reads `GET /v1/me/package-entitlements` (the caller's and their dependants' packages, newest
 * first, cursor pages with "Load more"). Each package shows the activity, whose it is, sessions
 * left, used and bought, the expiry as the API states it (none when the package definition chose
 * none, POL-039; never a rule the app invents), and its redemption history: each booking that used
 * a session and each reversal that returned one, with its reason. A package is not money: it is
 * never added to credits (SPK-PAY-009).
 *
 * Behind `CapabilityGate` for `session_packages` (DEC-016, DEC-074, Product owner) with
 * `whenOff="notice"`: while the switch is off the turned-off state names the decisions, and the
 * packages already held stay listed (the API keeps reads, reversals and expiry working).
 *
 * Dates are in the facility's time zone when the package's offering states it
 * (`GET /v1/offerings/{id}` facility timezone, SPK-SCHED-008), otherwise the device's, named.
 *
 * Booking a session with a package credit (`POST /v1/session-bookings` with
 * `packageEntitlementId`, ENR-11) opens in place on a package the API reports active with sessions
 * left, while the switch is on (BookWithPackage.tsx). Package redemption and reversal terms are
 * POL-039 and POL-007 (pending): the API applies them, the app states none.
 *
 * Customer words (PA-11): "class pack", never "session package"; the turned-off notice reads
 * "Class packs turned off". Customers reach this screen only while the switch is on (Account hides
 * the row otherwise); packs already held stay readable whatever the switch says. Visual system v2
 * (ADR-008): each pack is a `Card`; an empty list shows the payments illustration.
 *
 * States: loading; empty ("No class packs"); ready; error with code and "Try again";
 * permission restriction (not available); offline or stale (cached with its age); turned off
 * (notice above the list, and no "Book a session"); while the switch itself is unknown (its read
 * loading, failed or offline) that state is shown above the list, which follows its own read.
 */
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import {
  packageHistory,
  packageRedeemable,
  packageStatus,
  type PackageEntitlement,
} from '../../features/money/payment-lists';
import { useNameOf } from '../../features/money/people';
import { formatInstantIn, useOfferingZones } from '../../features/money/time-zone';
import { zoneAbbreviation, type DisplayZone } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { Card } from '../../ui/Card';
import { FieldValue as Field } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';
import { usePullToRefresh } from '../../features/money/surfaces';
import { BookWithPackage } from './BookWithPackage';

/** What the screen, its section and its turned-off notice call it (PA-11). */
export const PACKAGES_TITLE = 'Class packs';
export const PACKAGES_PAGE_SIZE = 20;
export const PACKAGES_STILL_AVAILABLE = 'Class packs you already have stay listed here.';

function PackageCard({
  pkg,
  zone,
  bookingOn,
}: {
  pkg: PackageEntitlement;
  zone: DisplayZone;
  /** The API reports `session_packages` on (booking is a new commitment, DEC-016, DEC-074). */
  bookingOn: boolean;
}) {
  const styles = useStyles();
  const now = useNow();
  const nameOf = useNameOf();
  const canBook = bookingOn && packageRedeemable(pkg, now);
  const at = (iso: string) => formatInstantIn(iso, zone.zone);
  const eligible = pkg.appliesTo.offeringIds.length + pkg.appliesTo.programIds.length;
  const history = packageHistory(pkg);
  return (
    <Card style={styles.card} testID={`package-${pkg.id}`}>
      <StatusBadge {...packageStatus(pkg, now)} />
      <Field label="Class pack" value={pkg.offeringName ?? 'Class pack'} />
      <Field label="For" value={nameOf(pkg.participantPersonId)} />
      <Field
        label="Sessions"
        value={`${pkg.remainingCredits} left, ${pkg.redeemedCount} used, of ${pkg.credits}`}
      />
      <Field
        label="Expiry"
        value={pkg.expiresAt ? `Expires ${at(pkg.expiresAt)}` : 'No expiry set for this class pack'}
      />
      <Field label="Bought" value={at(pkg.issuedAt)} />
      {eligible > 0 ? (
        <Field
          label="Can be used for"
          value={`${eligible} eligible ${eligible === 1 ? 'activity or program' : 'activities or programs'}`}
        />
      ) : null}
      {pkg.status === 'revoked' && pkg.revokedAt ? (
        <Field
          label="Revoked"
          value={`${at(pkg.revokedAt)}${pkg.revokedReason ? `. ${pkg.revokedReason}` : ''}`}
        />
      ) : null}
      {history.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Redemption history">
          {history.map((r) => (
            <Text variant="caption" tone="muted" key={r.id}>
              {r.kind === 'reversal'
                ? `Booking reversed, session returned on ${at(r.redeemedAt)}${r.reason ? `: ${r.reason}` : ''}`
                : `Session booked on ${at(r.redeemedAt)}`}
            </Text>
          ))}
        </View>
      ) : (
        <Text variant="caption" tone="muted">
          Not used yet.
        </Text>
      )}
      {zone.facility ? null : (
        <Text variant="caption" tone="muted">
          {`Dates are in this device's time zone (${zoneAbbreviation(pkg.issuedAt, zone.zone)}): the facility's time zone is not available for this class pack.`}
        </Text>
      )}
      <BookWithPackage pkg={pkg} canStart={canBook} />
    </Card>
  );
}

/** The account's class packs, in cursor pages. */
export function SessionPackagesList() {
  const styles = useStyles();
  const packages = useApiPages({
    path: '/me/package-entitlements',
    request: { query: { limit: PACKAGES_PAGE_SIZE } },
  });
  const zones = useOfferingZones((packages.data ?? []).map((p) => p.offeringId));
  // Read here, next to the gate's own read, so the cards never start another permissions read.
  // The API still refuses a booking with CAPABILITY_DISABLED if the switch changed meanwhile.
  const bookingOn = usePermissions().isCapabilityEnabled('session_packages') === true;
  return (
    <>
      <QueryBoundary
        query={packages}
        label="class packs"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No class packs',
          description:
            'Class packs you or your family buy appear here, with sessions left and when they expire.',
          source: illustrations['empty-payments'],
          testID: 'packages-empty',
        }}
        unavailableOffline={['loading more class packs']}
      >
        {(items) => (
          <View accessibilityRole="list" style={styles.list}>
            {items.map((pkg) => {
              const zone = zones.get(pkg.offeringId);
              return zone ? (
                <PackageCard key={pkg.id} pkg={pkg} zone={zone} bookingOn={bookingOn} />
              ) : null;
            })}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={packages} label="class packs" />
    </>
  );
}

/**
 * The list behind its capability switch (DEC-016, DEC-074), kept readable while it is off.
 * `onlyWhenRelevant` (the Credits page): while the API reports the switch off and the account
 * holds no class pack, nothing is shown, so customers never meet a feature they cannot use there.
 */
export function SessionPackagesSection({
  title = PACKAGES_TITLE,
  onlyWhenRelevant = false,
}: {
  title?: string;
  onlyWhenRelevant?: boolean;
}) {
  const switchOff = usePermissions().isCapabilityEnabled('session_packages') === false;
  // The same read as the list below (one request): whether the account holds any pack.
  const packages = useApiPages({
    path: '/me/package-entitlements',
    request: { query: { limit: PACKAGES_PAGE_SIZE } },
  });
  if (onlyWhenRelevant && switchOff && packages.data?.length === 0) return null;
  return (
    <Section title={title} testID="packages-section">
      <Text variant="caption" tone="muted">
        A class pack holds sessions to book. It is not money and is never added to credits.
      </Text>
      <CapabilityGate
        capability="session_packages"
        subject={PACKAGES_TITLE}
        whenOff="notice"
        stillAvailable={PACKAGES_STILL_AVAILABLE}
      >
        <SessionPackagesList />
      </CapabilityGate>
    </Section>
  );
}

export function MySessionPackagesScreen() {
  const { refreshing, onRefresh } = usePullToRefresh();
  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <View testID="screen-my-session-packages">
        <RequireSession what="your class packs">
          <SessionPackagesSection title="Your class packs" />
        </RequireSession>
      </View>
    </Screen>
  );
}

/** Route component for app/session-packages/index.tsx: the customer's title in the header (PA-11). */
export function MySessionPackagesRoute() {
  return (
    <>
      <Stack.Screen options={{ title: PACKAGES_TITLE }} />
      <MySessionPackagesScreen />
    </>
  );
}

const useStyles = makeStyles(() => ({
  card: { gap: spacing.sm },
  list: { gap: spacing.sm },
}));
