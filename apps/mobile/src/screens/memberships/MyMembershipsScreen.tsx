/**
 * My memberships and my family's (Package G, conditional; §3.16 Memberships row "eligibility
 * benefits, effective dates, renewal, suspension, cancellation, entitlement effects"; ENR-12;
 * SPK-COND-001: a membership never means unlimited attendance unless its entitlement says so).
 * Route: `/memberships`, from Account and from a membership enrollment (SCR-C-32).
 *
 * Reads `GET /v1/me/memberships` (the caller's and their dependants' memberships, newest first,
 * cursor pages with "Load more"). Each one shows whose it is ("You" or the given name, §4.14), its
 * status, its term in the facility's time zone (through its offering, SPK-SCHED-008), exactly
 * what attendance it includes and where (or that it cannot be shown: nothing is assumed), the
 * sessions used in each period with the period's limit, and its suspensions (arranged by the front
 * desk: the API has no customer command for them). A confirmed membership can be renewed at
 * checkout (`RenewMembership`) while the switch is on.
 *
 * Behind `CapabilityGate` for `memberships` (DEC-016, DEC-072) with `whenOff="notice"`: existing
 * memberships stay readable while the switch is off; renewal is a new commitment and is offered
 * only while it is on (the API refuses it with CAPABILITY_DISABLED otherwise). Membership terms and
 * member pricing stay pending (POL-038, DEC-007); no price is shown here.
 *
 * States: loading; empty ("No memberships", with Discover); ready; error with the code and "Try
 * again"; permission restriction (not available); offline or stale (cached with its age, renewal
 * needs a connection); turned off (notice above the list).
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { Body, ButtonRow, Caption, Field } from '../../features/money/ui';
import {
  appliesToText,
  attendanceText,
  membershipStatus,
  suspensionText,
  termText,
  usageText,
  type Membership,
} from '../../features/package-g/membership-model';
import { usePersonLabels } from '../../features/package-g/people';
import { useOfferingZones } from '../../features/package-g/time';
import { displayZone, zoneNotice, type DisplayZone } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { RenewMembership } from './RenewMembership';

export const MEMBERSHIPS_STILL_AVAILABLE = 'Memberships you already hold stay available here.';
export const MEMBERSHIPS_PAGE_SIZE = 20;

/** Memberships are keyed by their enrollment (module level: a stable `keyOf`). */
const membershipKey = (m: Membership) => m.enrollmentId;

function MembershipCard({
  membership,
  zone,
  forWhom,
  canRenew,
}: {
  membership: Membership;
  zone: DisplayZone;
  forWhom: string;
  canRenew: boolean;
}) {
  const now = useNow();
  const [renewing, setRenewing] = useState(false);
  const status = membershipStatus(membership, now);
  const applies = appliesToText(membership.attendance);
  const included = membership.attendance?.mode === 'included_sessions';
  const notice = zoneNotice(zone, membership.createdAt);
  return (
    <View style={styles.card} testID={`membership-${membership.enrollmentId}`}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        {membership.offeringName ?? 'Membership'}
      </Text>
      <StatusBadge {...status} />
      <Field label="For" value={forWhom} />
      <Field label="Term" value={termText(membership, zone.zone)} />
      <Field label="Includes" value={attendanceText(membership.attendance)} />
      {applies ? <Caption>{applies}</Caption> : null}
      {included ? (
        membership.usage.length > 0 ? (
          <View accessibilityRole="list" accessibilityLabel="Sessions used">
            {membership.usage.map((u) => (
              <Body key={u.periodKey}>{usageText(u)}</Body>
            ))}
          </View>
        ) : (
          <Caption>No included sessions used yet.</Caption>
        )
      ) : null}
      {membership.suspensions.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Suspensions">
          {membership.suspensions.map((s) => (
            <View key={s.id} style={styles.suspension}>
              <StatusBadge
                tone={s.status === 'active' ? 'warning' : 'neutral'}
                label={suspensionText(s, zone.zone)}
              />
              {s.reason ? <Caption>{`Reason: ${s.reason}`}</Caption> : null}
            </View>
          ))}
        </View>
      ) : null}
      <Caption>Suspending a membership is arranged by the front desk.</Caption>
      {membership.renewedFromEnrollmentId ? (
        <Caption>This membership renews an earlier one.</Caption>
      ) : null}
      {notice ? <Caption>{notice}</Caption> : null}
      {membership.status === 'confirmed' && canRenew ? (
        renewing ? (
          <RenewMembership
            enrollmentId={membership.enrollmentId}
            onClose={() => setRenewing(false)}
          />
        ) : (
          <ButtonRow>
            <Button
              label="Renew"
              variant="secondary"
              onPress={() => setRenewing(true)}
              accessibilityHint={`Renews ${membership.offeringName ?? 'this membership'} at checkout`}
            />
          </ButtonRow>
        )
      ) : null}
    </View>
  );
}

function MembershipsList() {
  const router = useRouter();
  const permissions = usePermissions();
  const canRenew = permissions.isCapabilityEnabled('memberships') === true;
  const memberships = useApiPages({
    path: '/me/memberships',
    request: { query: { limit: MEMBERSHIPS_PAGE_SIZE } },
    keyOf: membershipKey,
  });
  const items = memberships.data ?? [];
  const zones = useOfferingZones(items.map((m) => m.offeringId));
  const labelOf = usePersonLabels(items.map((m) => m.participantPersonId));
  return (
    <>
      <QueryBoundary
        query={memberships}
        label="memberships"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No memberships',
          description:
            'Memberships you or your family hold appear here, with what each one includes. Find one in Discover.',
          actionLabel: 'Open Discover',
          onAction: () => router.push('/discover'),
        }}
        unavailableOffline={['Renewing']}
      >
        {(list) => (
          <View accessibilityRole="list" style={styles.list}>
            {list.map((m) => (
              <MembershipCard
                key={m.enrollmentId}
                membership={m}
                zone={zones.get(m.offeringId) ?? displayZone(null)}
                forWhom={labelOf(m.participantPersonId)}
                canRenew={canRenew}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={memberships} label="memberships" />
    </>
  );
}

export function MyMembershipsScreen() {
  return (
    <Screen>
      <View testID="screen-my-memberships">
        <RequireSession what="your memberships">
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Memberships
            </Text>
            <Caption>
              A membership includes only what its terms say. Each one below lists the sessions it
              includes.
            </Caption>
          </View>
          <CapabilityGate
            capability="memberships"
            subject="Memberships"
            whenOff="notice"
            stillAvailable={MEMBERSHIPS_STILL_AVAILABLE}
          >
            <MembershipsList />
          </CapabilityGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.xs },
  title: { ...type.title, color: colors.text },
  list: { gap: spacing.sm, padding: spacing.lg },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardTitle: { ...type.heading, color: colors.text },
  suspension: { gap: 2 },
});
