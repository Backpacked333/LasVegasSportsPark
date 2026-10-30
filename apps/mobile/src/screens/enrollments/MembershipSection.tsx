/**
 * SCR-C-32 for a membership enrollment (§3.16 Package G memberships, SPK-COND-001; ENR-12;
 * capability `memberships`, DEC-016, DEC-072): its term, what attendance it includes, its
 * suspensions and usage, from `GET /v1/me/memberships`, and the renewal the customer may start.
 *
 * - Renewal: `POST /v1/enrollments/{id}/renew` adds the renewal of the chosen membership offering
 *   to the customer's open basket (the newest of `GET /v1/me/baskets`) or a new one; nothing is
 *   charged until checkout (SCR-C-11 to SCR-C-14). Only a confirmed membership renews
 *   (EnrollmentMachine; the API answers INVALID_TRANSITION otherwise). Behind the capability
 *   switch: while it is off the renewal reads "Membership renewal turned off", and a command
 *   refused with CAPABILITY_DISABLED shows the same state.
 * - Suspension: the API lets staff suspend a membership or end a suspension
 *   (`enrollment.manage_membership_suspension` has no customer form), so the customer sees the
 *   suspensions and is told the front desk arranges them; nothing is offered that the API would
 *   refuse. Membership terms and member pricing stay pending (POL-038, DEC-007).
 *
 * States: loading; the membership not among the API's first page reads "details under
 * Memberships"; error with code and "Try again" (the membership read, the renewal targets and the
 * open baskets the renewal goes into); offline (renewal needs a connection);
 * processing (adding the renewal); success (the basket); turned off.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { formatDateRange } from '../../features/money/format';
import { ButtonRow, Caption, ChoiceRow, Field, Section } from '../../features/money/ui';
import { packageGRoutes } from '../../features/package-g/routes';
import { formatInstant } from '../../features/registration/format';
import {
  MY_BASKETS_KEY,
  openBasketOf,
  useMyBaskets,
} from '../../features/registration/in-progress';
import { registrationRoutes } from '../../features/registration/routes';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Enrollment = Schema<'Enrollment'>;
type Membership = Schema<'Membership'>;
type Suspension = Schema<'MembershipSuspension'>;

export const MEMBERSHIPS_PAGE_SIZE = 50;

const PERIOD_WORDS: Record<'week' | 'month' | 'membership_term', string> = {
  week: 'each week',
  month: 'each month',
  membership_term: 'during the membership',
};

/** SPK-COND-001: what attendance the membership includes, exactly as its definition states. */
export function attendanceText(attendance: Membership['attendance']): string {
  if (!attendance) return 'Not available';
  switch (attendance.mode) {
    case 'none':
      return 'No sessions included';
    case 'unlimited':
      return 'Unlimited sessions';
    case 'included_sessions':
      return attendance.limit
        ? `${attendance.limit.count} session${attendance.limit.count === 1 ? '' : 's'} ${PERIOD_WORDS[attendance.limit.period]}`
        : 'Included sessions';
  }
}

export function suspensionText(suspension: Suspension, timeZone?: string): string {
  const from = formatInstant(suspension.from, timeZone);
  if (suspension.status === 'ended') {
    return suspension.endedAt
      ? `Suspended from ${from}; ended ${formatInstant(suspension.endedAt, timeZone)}`
      : `Suspended from ${from}; ended`;
  }
  return suspension.until
    ? `Suspended from ${from} until ${formatInstant(suspension.until, timeZone)}`
    : `Suspended from ${from} until the front desk ends it`;
}

function Renewal({ enrollment }: { enrollment: Enrollment }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const targets = useApiQuery({
    path: '/offerings',
    request: { query: { kind: 'membership', limit: 20 } },
  });
  const baskets = useMyBaskets();
  const renew = useApiCommand('post', '/enrollments/{id}/renew', {
    invalidate: [MY_BASKETS_KEY, ['api', '/baskets/{id}']],
  });
  const [targetId, setTargetId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const open = (targets.data?.items ?? []).filter(
    (o) => o.publicationState === 'registration_open',
  );
  const openBasket = openBasketOf(baskets.data);
  const submit = async () => {
    if (!targetId) return;
    setFailure(null);
    try {
      const basket = await renew.submit({
        path: { id: enrollment.id },
        body: { targetOfferingId: targetId, ...(openBasket ? { basketId: openBasket.id } : {}) },
      });
      router.push(registrationRoutes.basket(basket.id));
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <Section title="Renew" testID="membership-renewal">
      <Caption>
        Renewing adds the membership to your basket. Nothing is charged until you check out.
      </Caption>
      {targets.data === undefined ? (
        targets.error ? (
          <QueryErrorView error={targets.error} onRetry={() => void targets.refetch()} />
        ) : (
          <StateView variant="loading" label="memberships you can renew into" />
        )
      ) : open.length === 0 ? (
        <Caption>No membership is open for registration right now.</Caption>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel="Membership to renew into">
          {open.map((o) => (
            <ChoiceRow
              key={o.id}
              mode="radio"
              label={o.name}
              detail={formatDateRange(o.startsOn, o.endsOn)}
              checked={targetId === o.id}
              onPress={() => {
                setTargetId(o.id);
                setFailure(null);
                renew.reset();
              }}
            />
          ))}
        </View>
      )}
      {baskets.data === undefined && baskets.error ? (
        // Without the list of open baskets the renewal cannot know where to go (it never opens a
        // second basket next to an open one): the read's code and "Try again".
        <View testID="renewal-baskets-error">
          <QueryErrorView error={baskets.error} onRetry={() => void baskets.refetch()} />
        </View>
      ) : null}
      {failure ? (
        <CommandFailure
          error={failure}
          what="the renewal"
          onRetry={() => void submit()}
          onReload={() => {
            setFailure(null);
            renew.reset();
            void targets.refetch();
          }}
        />
      ) : null}
      <ButtonRow>
        <Button
          label="Add the renewal to your basket"
          onPress={() => void submit()}
          disabled={!targetId || offline || baskets.data === undefined}
          busy={renew.isProcessing}
        />
        {offline ? <Caption>Renewing needs a connection.</Caption> : null}
      </ButtonRow>
    </Section>
  );
}

export function MembershipSection({
  enrollment,
  timeZone,
}: {
  enrollment: Enrollment;
  /** The facility zone of the membership's offering (SPK-SCHED-008), when known. */
  timeZone?: string;
}) {
  const router = useRouter();
  const memberships = useApiQuery({
    path: '/me/memberships',
    request: { query: { limit: MEMBERSHIPS_PAGE_SIZE } },
  });
  const membership = memberships.data?.items.find((m) => m.enrollmentId === enrollment.id);
  // Reading a membership is never gated; only the renewal (a new commitment) is (DEC-016).
  return (
    <View>
      <Section title="Membership" testID="membership">
        {memberships.data === undefined ? (
          memberships.error ? (
            <QueryErrorView
              error={memberships.error}
              onRetry={() => void memberships.refetch()}
              unavailable={{ title: 'Membership details not available' }}
            />
          ) : (
            <StateView variant="loading" label="the membership" />
          )
        ) : membership ? (
          <>
            {membership.termStartsAt && membership.termEndsAt ? (
              <Field
                label="Term"
                value={`${formatInstant(membership.termStartsAt, timeZone)} to ${formatInstant(
                  membership.termEndsAt,
                  timeZone,
                )}`}
              />
            ) : (
              <Field label="Term" value="Set when the membership is confirmed" />
            )}
            <Field label="Includes" value={attendanceText(membership.attendance)} />
            {membership.usage.map((u) => (
              <Field
                key={u.periodKey}
                label={`Used (${u.periodKey})`}
                value={`${u.usedCount} of ${u.limitCount}`}
              />
            ))}
            {membership.suspensions.length > 0 ? (
              <View accessibilityRole="list">
                {membership.suspensions.map((s) => (
                  <StatusBadge
                    key={s.id}
                    tone={s.status === 'active' ? 'warning' : 'neutral'}
                    label={suspensionText(s, timeZone)}
                  />
                ))}
              </View>
            ) : null}
            <Caption>
              Suspending a membership is arranged by the front desk; it is not available in the app.
            </Caption>
          </>
        ) : (
          <>
            <Caption>The details of this membership are under Memberships.</Caption>
            <ButtonRow>
              <Button
                label="Open memberships"
                variant="secondary"
                onPress={() => router.push(packageGRoutes.memberships())}
              />
            </ButtonRow>
          </>
        )}
      </Section>
      {enrollment.status === 'confirmed' ? (
        <CapabilityGate capability="memberships" subject="Membership renewal">
          <Renewal enrollment={enrollment} />
        </CapabilityGate>
      ) : null}
    </View>
  );
}
