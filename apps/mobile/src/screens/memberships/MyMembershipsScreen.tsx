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
 * desk: the API has no customer command for them). "Membership active" only inside the term the
 * API states: before it the start day, after it "Term ended", and a confirmed membership without a
 * term reads "Term not available" (it books nothing, POL-038). The term's end is the last local
 * day it includes (the API's `termEndsAt` is exclusive). While the switch is on, a confirmed
 * membership can be renewed at checkout (`RenewMembership`) and, inside its term with sessions of
 * named activities, used to book a session (`BookWithMembership`, `POST /v1/session-bookings`
 * with `membershipEnrollmentId`, ENR-12). A pending or confirmed membership links to its
 * enrollment's cancellation (`/enrollments/{id}/cancel`, SCR-C-33: the API's cancellation preview
 * and command), never gated by the switch (cancellations keep working while it is off, DEC-016).
 *
 * Behind `CapabilityGate` for `memberships` (DEC-016, DEC-072) with `whenOff="notice"`: existing
 * memberships stay readable while the switch is off; renewal is a new commitment and is offered
 * and booking with a membership are new commitments, offered only while it is on (the API refuses
 * them with CAPABILITY_DISABLED otherwise). Membership terms and
 * member pricing stay pending (POL-038, DEC-007); no price is shown here.
 *
 * Visual system v2 (ADR-008) and customer words (PA-11): each membership is a `Card`; an empty
 * list shows the payments illustration with "Open Explore"; pulling the page down reads it again.
 * Customers reach this screen only while the switch is on (Account hides the row otherwise); a
 * link opened while it is off still shows the memberships already held under the plain
 * "Memberships turned off" notice.
 *
 * States: loading; empty ("No memberships", with Explore); ready; error with the code and "Try
 * again"; permission restriction (not available); offline or stale (cached with its age, renewal
 * and booking need a connection); turned off (notice above the list, no renewal or booking).
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { moneyRoutes } from '../../features/money/routes';
import {
  appliesToText,
  attendanceText,
  membershipBookable,
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
import { Card } from '../../ui/Card';
import { FieldValue as Field } from '../../ui/Field';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { Actions, usePullToRefresh } from '../../features/money/surfaces';
import { BookWithMembership } from './BookWithMembership';
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
  /** The API reports `memberships` on: renewal and booking are new commitments (DEC-016). */
  canRenew: boolean;
}) {
  const styles = useStyles();
  const router = useRouter();
  const now = useNow();
  const [renewing, setRenewing] = useState(false);
  const status = membershipStatus(membership, now, zone.zone);
  const cancellable = membership.status === 'pending' || membership.status === 'confirmed';
  const applies = appliesToText(membership.attendance);
  const included = membership.attendance?.mode === 'included_sessions';
  const notice = zoneNotice(zone, membership.createdAt);
  return (
    <Card style={styles.card} testID={`membership-${membership.enrollmentId}`}>
      <Text variant="headline" accessibilityRole="header">
        {membership.offeringName ?? 'Membership'}
      </Text>
      <StatusBadge {...status} />
      <Field label="For" value={forWhom} />
      <Field label="Term" value={termText(membership, zone.zone)} />
      <Field label="Includes" value={attendanceText(membership.attendance)} />
      {applies ? (
        <Text variant="caption" tone="muted">
          {applies}
        </Text>
      ) : null}
      {included ? (
        membership.usage.length > 0 ? (
          <View accessibilityRole="list" accessibilityLabel="Sessions used">
            {membership.usage.map((u) => (
              <Text variant="body" key={u.periodKey}>
                {usageText(u)}
              </Text>
            ))}
          </View>
        ) : (
          <Text variant="caption" tone="muted">
            No included sessions used yet.
          </Text>
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
              {s.reason ? (
                <Text variant="caption" tone="muted">{`Reason: ${s.reason}`}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <Text variant="caption" tone="muted">
        Suspending a membership is arranged by the front desk.
      </Text>
      {membership.renewedFromEnrollmentId ? (
        <Text variant="caption" tone="muted">
          This membership renews an earlier one.
        </Text>
      ) : null}
      {notice ? (
        <Text variant="caption" tone="muted">
          {notice}
        </Text>
      ) : null}
      {membership.status === 'confirmed' && canRenew ? (
        renewing ? (
          <RenewMembership
            enrollmentId={membership.enrollmentId}
            onClose={() => setRenewing(false)}
          />
        ) : (
          <Actions>
            <Button
              label="Renew"
              variant="secondary"
              onPress={() => setRenewing(true)}
              accessibilityHint={`Renews ${membership.offeringName ?? 'this membership'} at checkout`}
            />
          </Actions>
        )
      ) : null}
      <BookWithMembership
        membership={membership}
        canStart={canRenew && membershipBookable(membership, now)}
      />
      {cancellable ? (
        <Actions>
          <Button
            label="Cancel this membership"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.cancel(membership.enrollmentId))}
            accessibilityHint="Shows what canceling would change before anything is sent"
          />
        </Actions>
      ) : null}
    </Card>
  );
}

function MembershipsList() {
  const styles = useStyles();
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
            'Memberships you or your family hold appear here, with what each one includes. Find one in Explore.',
          actionLabel: 'Open Explore',
          onAction: () => router.push('/discover'),
          source: illustrations['empty-calendar'],
          testID: 'memberships-empty',
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
  const styles = useStyles();
  const { refreshing, onRefresh } = usePullToRefresh();
  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <View testID="screen-my-memberships">
        <RequireSession what="your memberships">
          {/* The title bar says "Memberships": the page does not say it again. */}
          <View style={styles.header}>
            <Text variant="caption" tone="muted">
              A membership includes only what its terms say. Each one below lists the sessions it
              includes.
            </Text>
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

const useStyles = makeStyles(() => ({
  header: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.xs },
  list: { gap: spacing.sm, paddingVertical: spacing.sm },
  card: { gap: spacing.sm },
  suspension: { gap: spacing.xxs },
}));
