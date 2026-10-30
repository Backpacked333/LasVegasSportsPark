/**
 * SCR-C-09 trial and pickup intents (SPK-REG-001; SPK-YOUTH-003 trials, SPK-PLACE-004 pickup
 * sessions; SPK-COND-001 package and membership credits; DEC-016, DEC-074, DEC-076, DEC-082):
 * one participant, one session of the offering, then
 *
 * - trial: `POST /v1/trial-participations` (`offeringId`, `participantPersonId`, an optional
 *   `sessionId`, `followUpConsent`). With a session the API holds a seat as a `trial` session
 *   booking; without one the front desk arranges the time;
 * - pickup: `POST /v1/session-bookings` (`offeringId`, `sessionId`, `participantPersonId`, and
 *   `packageEntitlementId` or `membershipEnrollmentId` when a credit pays for it). Pickup sessions
 *   sit behind `pickup_sessions` (DEC-082); a package credit behind `session_packages` (DEC-074),
 *   a membership behind `memberships` (DEC-072), each offered only while `GET /v1/me/permissions`
 *   reports it on, and the API checks every command again (CAPABILITY_DISABLED reads turned off).
 *
 * Money: a booking is offered here only when it owes nothing (the offering's price from the API
 * owes nothing, or a package or membership credit pays for it). The API has no customer command
 * to pay for a single priced session (reported): such a booking stays pending until the front
 * desk takes the payment, so the app does not start one. Whatever the API answers is shown as it
 * is: "Booked" only for a booking the API confirmed; a pending one reads "Booking pending" with
 * the server's hold expiry, never as booked.
 *
 * States: loading (sessions, credits); empty (no upcoming session); ready; validation failure
 * (the API's eligibility reasons, missing forms, no capacity, duplicate booking); permission
 * restriction (not available); offline (booking disabled, choices kept); processing; success
 * (booked, or pending with its expiry); turned off.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { PermissionsState } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { moneyRoutes } from '../money/routes';
import { CommandError } from './CommandError';
import { formatInstant } from './format';
import {
  blockingEligibilityReasons,
  eligibilityMessages,
  eligibilityOf,
  eligibilityStatus,
  mayRegister,
  type RegistrationOptions,
} from './options';
import type { Participant } from './participants';
import { Body, ButtonRow, ChoiceRow, Section } from './ui';

type Offering = Schema<'Offering'>;
type OfferingSession = Schema<'OfferingSession'>;
type SessionBooking = Schema<'SessionBooking'>;
type TrialParticipation = Schema<'TrialParticipation'>;
type PackageEntitlement = Schema<'PackageEntitlement'>;
type Membership = Schema<'Membership'>;

export type SessionIntent = 'trial' | 'pickup';

/** Credits are read from the first page of each list (the newest); the API checks the choice. */
export const CREDITS_PAGE_SIZE = 50;

/**
 * Whether the offering's price (as the API gives it) owes nothing for one place: no base price
 * and no non-inclusive fee or tax. The API applies the same rule and confirms such a booking at
 * once; it stays the API's decision (a booking it leaves pending is shown as pending).
 */
export function owesNothing(price: Offering['price']): boolean {
  if (!price) return true;
  if (price.basePriceMinor !== 0) return false;
  return price.chargeLines.every((c) => c.inclusive || (c.amountMinor ?? 0) === 0);
}

/** A package credit the participant may use for this offering (ENR-11). */
export function usablePackage(
  entitlement: PackageEntitlement,
  offering: Pick<Offering, 'id' | 'programId'>,
  participantPersonId: string,
): boolean {
  return (
    entitlement.participantPersonId === participantPersonId &&
    entitlement.status === 'active' &&
    entitlement.remainingCredits > 0 &&
    (entitlement.appliesTo.offeringIds.includes(offering.id) ||
      entitlement.appliesTo.programIds.includes(offering.programId))
  );
}

/** A confirmed membership of the participant that includes sessions (ENR-12). */
export function usableMembership(membership: Membership, participantPersonId: string): boolean {
  return (
    membership.participantPersonId === participantPersonId &&
    membership.status === 'confirmed' &&
    membership.attendance !== null &&
    membership.attendance.mode !== 'none'
  );
}

/** "Booked" only for what the API confirmed; a pending booking is never shown as booked. */
export function sessionBookingStatus(
  booking: Pick<SessionBooking, 'status' | 'expiresAt'>,
  what: 'session' | 'trial',
  timeZone?: string,
): StatusBadgeProps {
  const noun = what === 'trial' ? 'Trial' : 'Session';
  switch (booking.status) {
    case 'confirmed':
      return { tone: 'success', label: `${noun} booked` };
    case 'pending':
      return {
        tone: 'pending',
        label: booking.expiresAt
          ? `Booking pending: a payment is needed. The place is held until ${formatInstant(booking.expiresAt, timeZone)}.`
          : 'Booking pending: a payment is needed.',
      };
    case 'expired':
      return { tone: 'neutral', label: 'Booking expired' };
    case 'canceled':
      return { tone: 'neutral', label: 'Booking canceled' };
  }
}

function sessionLabel(session: OfferingSession): string {
  return session.title ?? `Session ${session.sequence}`;
}

type Basis =
  { kind: 'purchase' } | { kind: 'package'; id: string } | { kind: 'membership'; id: string };

function basisKey(basis: Basis | null): string {
  return basis ? `${basis.kind}:${'id' in basis ? basis.id : ''}` : '';
}

type Outcome =
  { kind: 'booking'; booking: SessionBooking } | { kind: 'trial'; trial: TrialParticipation };

function BookingOutcome({
  outcome,
  timeZone,
  sessionText,
}: {
  outcome: Outcome;
  timeZone: string;
  sessionText: string | null;
}) {
  const router = useRouter();
  const trialBookingId = outcome.kind === 'trial' ? outcome.trial.sessionBookingId : null;
  // A trial with a session holds its seat as a session booking: its status is the booking's.
  const trialBooking = useApiQuery({
    path: '/session-bookings/{id}',
    request: { path: { id: trialBookingId ?? '' } },
    enabled: trialBookingId !== null,
  });
  let status: StatusBadgeProps | null = null;
  if (outcome.kind === 'booking') {
    status = sessionBookingStatus(outcome.booking, 'session', timeZone);
  } else if (trialBookingId === null) {
    status = { tone: 'info', label: 'Trial recorded. The front desk arranges the session.' };
  } else if (trialBooking.data) {
    status = sessionBookingStatus(trialBooking.data, 'trial', timeZone);
  }
  return (
    <Section title={outcome.kind === 'trial' ? 'Your trial' : 'Your booking'}>
      {status ? <StatusBadge {...status} testID="session-booking-outcome" /> : null}
      {status === null && trialBooking.data === undefined && trialBooking.error ? (
        <QueryErrorView error={trialBooking.error} onRetry={() => void trialBooking.refetch()} />
      ) : null}
      {status === null && !trialBooking.error ? (
        <StateView variant="loading" label="the trial booking" />
      ) : null}
      {sessionText ? <Body>{sessionText}</Body> : null}
      <ButtonRow>
        <Button
          label="See your registrations"
          variant="secondary"
          onPress={() => router.push(moneyRoutes.enrollments())}
        />
      </ButtonRow>
    </Section>
  );
}

export function SessionBookingFlow({
  offering,
  intent,
  participants,
  options,
  permissions,
}: {
  offering: Offering;
  intent: SessionIntent;
  participants: readonly Participant[];
  options: RegistrationOptions;
  permissions: PermissionsState;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const timeZone = offering.facility.timezone;
  const [participantId, setParticipantId] = useState<string | null>(null);
  /** A session id, or 'none' for a trial the front desk schedules. */
  const [sessionChoice, setSessionChoice] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis | null>(null);
  const [followUpConsent, setFollowUpConsent] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offering.id } },
  });
  const packagesOn = permissions.isCapabilityEnabled('session_packages') === true;
  const membershipsOn = permissions.isCapabilityEnabled('memberships') === true;
  const packages = useApiQuery({
    path: '/me/package-entitlements',
    request: { query: { status: 'active', limit: CREDITS_PAGE_SIZE } },
    enabled: intent === 'pickup' && packagesOn,
  });
  const memberships = useApiQuery({
    path: '/me/memberships',
    request: { query: { status: 'confirmed', limit: CREDITS_PAGE_SIZE } },
    enabled: intent === 'pickup' && membershipsOn,
  });
  const invalidate = [
    ['api', '/session-bookings'],
    ['api', '/me/trial-participations'],
    ['api', '/me/package-entitlements'],
    ['api', '/me/memberships'],
  ] as const;
  const bookSession = useApiCommand('post', '/session-bookings', { invalidate });
  const bookTrial = useApiCommand('post', '/trial-participations', { invalidate });

  const upcoming = (sessions.data ?? []).filter(
    (s) => s.status === 'scheduled' && new Date(s.scheduledStart).getTime() > now.getTime(),
  );
  const chosenSession = upcoming.find((s) => s.id === sessionChoice) ?? null;
  const sessionText = chosenSession
    ? `${sessionLabel(chosenSession)}: ${formatInstant(chosenSession.scheduledStart, timeZone)}`
    : null;

  if (outcome) {
    return <BookingOutcome outcome={outcome} timeZone={timeZone} sessionText={sessionText} />;
  }

  const free = owesNothing(offering.price);
  const packageChoices = participantId
    ? (packages.data?.items ?? []).filter((p) => usablePackage(p, offering, participantId))
    : [];
  const membershipChoices = participantId
    ? (memberships.data?.items ?? []).filter((m) => usableMembership(m, participantId))
    : [];
  const bases: { basis: Basis; label: string; detail?: string }[] =
    intent === 'pickup'
      ? [
          ...(free ? [{ basis: { kind: 'purchase' } as Basis, label: 'No charge' }] : []),
          ...packageChoices.map((p) => ({
            basis: { kind: 'package', id: p.id } as Basis,
            label: `Use a credit from ${p.offeringName ?? 'your session package'}`,
            detail: `${p.remainingCredits} of ${p.credits} left`,
          })),
          ...membershipChoices.map((m) => ({
            basis: { kind: 'membership', id: m.enrollmentId } as Basis,
            label: `Use your membership ${m.offeringName ?? ''}`.trim(),
          })),
        ]
      : [];
  // The only basis offered is used without asking; a stale choice is dropped.
  const chosenBasis: Basis | null =
    intent === 'trial'
      ? null
      : (bases.find((b) => basisKey(b.basis) === basisKey(basis))?.basis ??
        (bases.length === 1 ? (bases[0]?.basis ?? null) : null));
  const creditsLoading =
    intent === 'pickup' &&
    ((packagesOn && packages.data === undefined && !packages.error) ||
      (membershipsOn && memberships.data === undefined && !memberships.error));
  const canPay = intent === 'trial' ? free || sessionChoice === 'none' : bases.length > 0;
  const ready =
    participantId !== null &&
    (intent === 'trial' ? sessionChoice !== null : chosenSession !== null) &&
    (intent === 'trial' ? canPay : chosenBasis !== null);

  const submit = async () => {
    if (!participantId) return;
    setFailure(null);
    try {
      if (intent === 'trial') {
        const trial = await bookTrial.submit({
          body: {
            offeringId: offering.id,
            participantPersonId: participantId,
            ...(chosenSession ? { sessionId: chosenSession.id } : {}),
            followUpConsent,
          },
        });
        setOutcome({ kind: 'trial', trial });
      } else {
        if (!chosenSession || !chosenBasis) return;
        const booking = await bookSession.submit({
          body: {
            offeringId: offering.id,
            sessionId: chosenSession.id,
            participantPersonId: participantId,
            ...(chosenBasis.kind === 'package' ? { packageEntitlementId: chosenBasis.id } : {}),
            ...(chosenBasis.kind === 'membership'
              ? { membershipEnrollmentId: chosenBasis.id }
              : {}),
          },
        });
        setOutcome({ kind: 'booking', booking });
      }
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  const reset = () => {
    setFailure(null);
    bookSession.reset();
    bookTrial.reset();
  };

  return (
    <View>
      <Section title={intent === 'trial' ? 'Who is trying it?' : 'Who is taking part?'}>
        <View accessibilityRole="radiogroup" accessibilityLabel="Participant">
          {participants.map((p) => {
            const allowed = mayRegister(options, p.personId);
            const result = eligibilityOf(options, p.personId, intent);
            const blocked = result ? blockingEligibilityReasons(result).length > 0 : false;
            const messages = result ? eligibilityMessages(result) : null;
            const detail = !allowed
              ? 'Not available: your account can view this person but not register them.'
              : result
                ? [
                    eligibilityStatus(result).label,
                    ...(messages?.reasons ?? []),
                    ...(messages?.alternatives ?? []),
                  ].join('. ')
                : undefined;
            return (
              <ChoiceRow
                key={p.personId}
                mode="radio"
                label={p.displayName}
                detail={detail}
                checked={participantId === p.personId}
                disabled={!allowed || blocked}
                onToggle={() => {
                  setParticipantId(p.personId);
                  setBasis(null);
                  reset();
                }}
                testID={`session-participant-${p.self ? 'self' : p.personId}`}
              />
            );
          })}
        </View>
      </Section>

      <Section title="Which session?">
        {sessions.data === undefined ? (
          sessions.error ? (
            <QueryErrorView error={sessions.error} onRetry={() => void sessions.refetch()} />
          ) : (
            <StateView variant="loading" label="the sessions" />
          )
        ) : (
          <View accessibilityRole="radiogroup" accessibilityLabel="Session">
            {upcoming.length === 0 ? (
              <Body muted>No upcoming session of this activity can be booked right now.</Body>
            ) : null}
            {upcoming.map((s) => (
              <ChoiceRow
                key={s.id}
                mode="radio"
                label={sessionLabel(s)}
                detail={formatInstant(s.scheduledStart, timeZone)}
                checked={sessionChoice === s.id}
                onToggle={() => {
                  setSessionChoice(s.id);
                  reset();
                }}
              />
            ))}
            {intent === 'trial' ? (
              <ChoiceRow
                mode="radio"
                label="No session yet"
                detail="The front desk arranges the time of the trial with you."
                checked={sessionChoice === 'none'}
                onToggle={() => {
                  setSessionChoice('none');
                  reset();
                }}
              />
            ) : null}
          </View>
        )}
      </Section>

      {intent === 'pickup' && participantId !== null ? (
        <Section title="How is it paid?">
          {creditsLoading ? <StateView variant="loading" label="your credits" /> : null}
          {packages.data === undefined && packages.error ? (
            <QueryErrorView error={packages.error} onRetry={() => void packages.refetch()} />
          ) : null}
          {memberships.data === undefined && memberships.error ? (
            <QueryErrorView error={memberships.error} onRetry={() => void memberships.refetch()} />
          ) : null}
          {bases.length > 0 ? (
            <View accessibilityRole="radiogroup" accessibilityLabel="Payment">
              {bases.map((b) => (
                <ChoiceRow
                  key={basisKey(b.basis)}
                  mode="radio"
                  label={b.label}
                  detail={b.detail}
                  checked={basisKey(chosenBasis) === basisKey(b.basis)}
                  onToggle={() => {
                    setBasis(b.basis);
                    reset();
                  }}
                />
              ))}
            </View>
          ) : null}
          {!creditsLoading && bases.length === 0 ? (
            <Body muted>
              Paying for a single session is not available in the app yet. The front desk can book
              it for you.
            </Body>
          ) : null}
        </Section>
      ) : null}

      {intent === 'trial' ? (
        <Section title="After the trial">
          <ChoiceRow
            label="Staff may use what they learn in this trial to offer a place afterwards"
            checked={followUpConsent}
            onToggle={() => {
              setFollowUpConsent((v) => !v);
              reset();
            }}
            testID="trial-follow-up"
          />
          {!canPay && sessionChoice !== null ? (
            <Body muted>
              Paying for a trial session is not available in the app yet. Choose &quot;No session
              yet&quot; or ask the front desk.
            </Body>
          ) : null}
        </Section>
      ) : null}

      <CommandError error={failure} onRetry={() => void submit()} onReload={reset} />
      <ButtonRow>
        <Button
          label={intent === 'trial' ? 'Book the trial' : 'Book the session'}
          onPress={() => void submit()}
          disabled={!ready || offline}
          busy={bookSession.isProcessing || bookTrial.isProcessing}
        />
        {offline ? <Body muted>Booking needs a connection. Your choices are kept.</Body> : null}
      </ButtonRow>
    </View>
  );
}
