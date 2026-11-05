/**
 * Session packages, mine and my family's (SCR-C-35 next to credits and makeups; Package G
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
 * States: loading; empty ("No session packages"); ready; error with code and "Try again";
 * permission restriction (not available); offline or stale (cached with its age); turned off
 * (notice above the list, and no "Book a session"); while the switch itself is unknown (its read
 * loading, failed or offline) that state is shown above the list, which follows its own read.
 */
import { StyleSheet, View } from 'react-native';
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
import { Caption, Field, Section } from '../../features/money/ui';
import { zoneAbbreviation, type DisplayZone } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';
import { BookWithPackage } from './BookWithPackage';

export const PACKAGES_STILL_AVAILABLE = 'Packages you already hold stay listed here.';

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
  const now = useNow();
  const nameOf = useNameOf();
  const canBook = bookingOn && packageRedeemable(pkg, now);
  const at = (iso: string) => formatInstantIn(iso, zone.zone);
  const eligible = pkg.appliesTo.offeringIds.length + pkg.appliesTo.programIds.length;
  const history = packageHistory(pkg);
  return (
    <View style={styles.card} testID={`package-${pkg.id}`}>
      <StatusBadge {...packageStatus(pkg, now)} />
      <Field label="Package" value={pkg.offeringName ?? 'Session package'} />
      <Field label="For" value={nameOf(pkg.participantPersonId)} />
      <Field
        label="Sessions"
        value={`${pkg.remainingCredits} left, ${pkg.redeemedCount} used, of ${pkg.credits}`}
      />
      <Field
        label="Expiry"
        value={pkg.expiresAt ? `Expires ${at(pkg.expiresAt)}` : 'No expiry set for this package'}
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
            <Caption key={r.id}>
              {r.kind === 'reversal'
                ? `Booking reversed, session returned on ${at(r.redeemedAt)}${r.reason ? `: ${r.reason}` : ''}`
                : `Session booked on ${at(r.redeemedAt)}`}
            </Caption>
          ))}
        </View>
      ) : (
        <Caption>Not used yet.</Caption>
      )}
      {zone.facility ? null : (
        <Caption>
          {`Dates are in this device's time zone (${zoneAbbreviation(pkg.issuedAt, zone.zone)}): the facility's time zone is not available for this package.`}
        </Caption>
      )}
      <BookWithPackage pkg={pkg} canStart={canBook} />
    </View>
  );
}

/** The account's session packages, in cursor pages. */
export function SessionPackagesList() {
  const packages = useApiPages({
    path: '/me/package-entitlements',
    request: { query: { limit: 20 } },
  });
  const zones = useOfferingZones((packages.data ?? []).map((p) => p.offeringId));
  // Read here, next to the gate's own read, so the cards never start another permissions read.
  // The API still refuses a booking with CAPABILITY_DISABLED if the switch changed meanwhile.
  const bookingOn = usePermissions().isCapabilityEnabled('session_packages') === true;
  return (
    <>
      <QueryBoundary
        query={packages}
        label="session packages"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No session packages',
          description:
            'Packages of sessions you or your family buy appear here, with sessions left and when they expire.',
        }}
        unavailableOffline={['loading more packages']}
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
      <LoadMore pages={packages} label="session packages" />
    </>
  );
}

/** The list behind its capability switch (DEC-016, DEC-074), kept readable while it is off. */
export function SessionPackagesSection({ title = 'Session packages' }: { title?: string }) {
  return (
    <Section title={title} testID="packages-section">
      <Caption>
        A session package holds sessions to book. It is not money and is never added to credits.
      </Caption>
      <CapabilityGate
        capability="session_packages"
        subject="Session packages"
        whenOff="notice"
        stillAvailable={PACKAGES_STILL_AVAILABLE}
      >
        <SessionPackagesList />
      </CapabilityGate>
    </Section>
  );
}

export function MySessionPackagesScreen() {
  return (
    <Screen>
      <View testID="screen-my-session-packages">
        <RequireSession what="your session packages">
          <SessionPackagesSection title="Your session packages" />
        </RequireSession>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: spacing.md,
    gap: spacing.xs,
  },
  list: { gap: spacing.sm },
});
