/**
 * SCR-C-35 Credits and makeup entitlements: redeem a makeup against an eligible session
 * (SPK-YOUTH-004, SPK-AT-020, §4.9, SPK-UX-008; POL-010, POL-035 are the API's rules).
 *
 * The eligible replacements come from the entitlement: its eligible offerings
 * (`GET /v1/offerings/{id}`) and the published offerings of its eligible programs
 * (`GET /v1/offerings?programId=`). Choosing one lists its upcoming scheduled sessions
 * (`GET /v1/offerings/{id}/sessions`); "Book this session" sends
 * `POST /v1/makeup-entitlements/{id}/redeem` with `expectedRevision` and one idempotency key per
 * intent. The database enforces the redemption limit, so two guardians booking at once can never
 * both use the last makeup: the loser reads "Not available: already redeemed" (SPK-AT-020).
 *
 * States: loading; empty (no eligible session to book); ready; validation failure (the session is
 * not an eligible replacement: the API's reasons); permission restriction (not available);
 * stale version (the makeup changed, for example it was just used: reload); offline (booking
 * disabled); processing (busy); success ("Booked" or "Booking pending" with the session time);
 * partial completion: not permitted; recovery required: not applicable, a failed booking is
 * retried under the same key.
 */
import { apiQueryKey, type ApiError, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { formatDateRange, formatInstant, hasPassed } from '../../features/money/format';
import { useNameOf } from '../../features/money/people';
import { useApiRecords } from '../../features/money/records';
import { moneyRoutes, param } from '../../features/money/routes';
import {
  bookingStatus,
  makeupRedeemable,
  makeupStatus,
  type MakeupEntitlement,
  type SessionBooking,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, ChoiceRow, Field, Section } from '../../features/money/ui';
import { useApi, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type PublicOffering = Schema<'PublicOffering'>;
type OfferingPage = { items: PublicOffering[]; nextCursor: string | null };

/** Why the API refused a redemption, in the customer's words (SPK-AT-020). */
export function redemptionRefusal(error: ApiError): string | null {
  if (error.code !== 'RESOURCE_CONFLICT') return null;
  const details = (error.details ?? {}) as { code?: unknown; status?: unknown };
  if (details.code === 'MAKEUP_REDEMPTION_LIMIT') return 'Not available: already redeemed';
  if (details.code === 'MAKEUP_NOT_REDEEMABLE') {
    if (details.status === 'exhausted') return 'Not available: already redeemed';
    if (details.status === 'revoked') return 'Not available: this makeup was revoked';
    return 'Not available: this makeup has expired';
  }
  return null;
}

/** Offerings of the eligible programs, read with the same keys `useApiQuery` uses. */
function useProgramOfferings(programIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: programIds.map((programId) => {
      const query = { programId, limit: 50 };
      return {
        queryKey: apiQueryKey('/offerings', { query }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          (
            api.request as (
              method: 'get',
              path: string,
              options: object,
            ) => Promise<ApiResponse<OfferingPage>>
          )('get', '/offerings', { query, signal }),
      };
    }),
  });
}

function Booked({ booking }: { booking: SessionBooking }) {
  const router = useRouter();
  return (
    <Section title="Makeup session booked">
      <StatusBadge {...bookingStatus(booking.status)} testID="redeem-success" />
      <Field
        label="Session"
        value={`${formatInstant(booking.scheduledStart)} to ${formatInstant(booking.scheduledEnd)}`}
      />
      <ButtonRow>
        <Button
          label="Back to credits and makeups"
          onPress={() => router.replace(moneyRoutes.credits())}
        />
      </ButtonRow>
    </Section>
  );
}

function RedeemForm({ makeup, reload }: { makeup: MakeupEntitlement; reload: () => void }) {
  const now = useNow();
  const nameOf = useNameOf();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const direct = useApiRecords('/offerings/{id}', makeup.eligibleOfferingIds);
  const fromPrograms = useProgramOfferings(makeup.eligibleProgramIds);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [booking, setBooking] = useState<SessionBooking | null>(null);
  const redeem = useApiCommand('post', '/makeup-entitlements/{id}/redeem', {
    invalidate: [
      ['api', '/makeup-entitlements'],
      ['api', '/makeup-entitlements/{id}'],
    ],
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId ?? '' } },
    enabled: offeringId !== null,
  });

  if (booking) return <Booked booking={booking} />;

  const offerings = new Map<string, PublicOffering>();
  for (const id of makeup.eligibleOfferingIds) {
    const record = direct[id]?.data;
    if (record) offerings.set(record.id, record);
  }
  for (const result of fromPrograms) {
    for (const o of result.data?.data.items ?? []) offerings.set(o.id, o);
  }
  const loadingChoices =
    Object.values(direct).some((r) => r.loading) || fromPrograms.some((r) => r.isPending);
  const upcoming = (sessions.data ?? []).filter(
    (s) => s.status === 'scheduled' && !hasPassed(s.scheduledStart, now),
  );

  const submit = async (body: {
    offeringId: string;
    sessionId: string;
    expectedRevision: number;
  }) => {
    setFailure(null);
    try {
      setBooking((await redeem.submit({ path: { id: makeup.id }, body })) as SessionBooking);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  const book = () => {
    if (!offeringId || !sessionId) return;
    void submit({ offeringId, sessionId, expectedRevision: makeup.revision });
  };
  const refusal = failure ? redemptionRefusal(failure) : null;
  const ineligible = failure?.code === 'ELIGIBILITY_FAILED';
  const reasons = ineligible
    ? (((failure?.details ?? {}) as { reasons?: { message?: string }[] }).reasons ?? [])
        .map((r) => r.message)
        .filter((m): m is string => typeof m === 'string')
    : [];

  return (
    <View>
      <Section title="Makeup">
        <Field label="Participant" value={nameOf(makeup.participantPersonId)} />
        <StatusBadge {...makeupStatus(makeup, now)} />
      </Section>
      {!makeupRedeemable(makeup, now) ? (
        <StateView
          variant="unavailable"
          title="Nothing left to book"
          description="This makeup can no longer be booked."
        />
      ) : (
        <>
          <Section title="Choose an activity">
            {loadingChoices && offerings.size === 0 ? (
              <StateView variant="loading" label="eligible activities" />
            ) : offerings.size === 0 ? (
              <StateView
                variant="empty"
                title="No eligible activity is listed"
                description="None of the activities this makeup can replace is published right now. The front desk can help."
              />
            ) : (
              <View accessibilityRole="radiogroup" accessibilityLabel="Eligible activity">
                {[...offerings.values()].map((o) => (
                  <ChoiceRow
                    key={o.id}
                    mode="radio"
                    label={o.name}
                    detail={formatDateRange(o.startsOn, o.endsOn)}
                    checked={offeringId === o.id}
                    onPress={() => {
                      setOfferingId(o.id);
                      setSessionId(null);
                      setFailure(null);
                    }}
                  />
                ))}
              </View>
            )}
          </Section>
          {offeringId ? (
            <Section title="Choose a session">
              <QueryBoundary
                query={sessions}
                label="sessions"
                isEmpty={() => upcoming.length === 0}
                empty={{
                  title: 'No upcoming sessions',
                  description: 'This activity has no upcoming session to book. Choose another.',
                }}
                unavailableOffline={['booking a makeup session']}
              >
                {() => (
                  <View accessibilityRole="radiogroup" accessibilityLabel="Session">
                    {upcoming.map((s) => (
                      <ChoiceRow
                        key={s.id}
                        mode="radio"
                        label={s.title ?? `Session ${s.sequence}`}
                        detail={formatInstant(s.scheduledStart)}
                        checked={sessionId === s.id}
                        onPress={() => {
                          setSessionId(s.id);
                          setFailure(null);
                        }}
                      />
                    ))}
                  </View>
                )}
              </QueryBoundary>
            </Section>
          ) : null}
          <Section title="Book">
            <Caption>Session times are shown in this device’s time zone.</Caption>
            {offline ? <Caption>Needs a connection.</Caption> : null}
            <ButtonRow>
              <Button
                label="Book this session"
                onPress={book}
                disabled={!offeringId || !sessionId || offline || refusal !== null}
                busy={redeem.isProcessing}
                accessibilityHint="Uses one makeup to book the chosen session"
              />
            </ButtonRow>
            {refusal ? (
              <StatusBadge tone="neutral" label={refusal} testID="redeem-refused" />
            ) : ineligible ? (
              <View testID="redeem-ineligible">
                <StatusBadge tone="warning" label="This session is not an eligible replacement" />
                {reasons.map((m) => (
                  <Body key={m}>{m}</Body>
                ))}
                <Caption>Error code: {failure?.code}</Caption>
              </View>
            ) : failure ? (
              <CommandFailure
                error={failure}
                what="the booking"
                onRetry={book}
                onReload={() => {
                  setFailure(null);
                  redeem.reset();
                  reload();
                }}
              />
            ) : null}
          </Section>
        </>
      )}
    </View>
  );
}

export function MakeupRedeemScreen({ makeupId }: { makeupId: string }) {
  const makeup = useApiQuery({
    path: '/makeup-entitlements/{id}',
    request: { path: { id: makeupId } },
  });
  return (
    <Screen>
      <RequireSession what="this makeup">
        <QueryBoundary
          query={makeup}
          label="the makeup"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['booking a makeup session']}
        >
          {(data) => <RedeemForm makeup={data} reload={() => void makeup.refetch()} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/credits/makeup/[id].tsx. */
export function MakeupRedeemRoute() {
  const id = param(useLocalSearchParams<{ id: string }>().id);
  return (
    <>
      <Stack.Screen options={{ title: 'Book a makeup session' }} />
      <MakeupRedeemScreen makeupId={id} />
    </>
  );
}
