/**
 * SCR-C-08 Offering detail (SPK-CAT-001, SPK-REG-002, §4.5 date-based eligibility, POL-001,
 * POL-007; journey A1). Reads `GET /v1/offerings/{id}` (public, child-safe view) and its sessions:
 * name, description, activity type, format, location, dates, registration window, age band,
 * capacity units, price basis with approved taxes and fees, required forms and the cancellation
 * policy, then the entry point to registration (SCR-C-09).
 *
 * Times are shown in the facility's time zone (`facility.timezone`, SPK-SCHED-008), with the
 * zone named. Signed in, "Who can take part" shows the read-only eligibility of each person the
 * account may register, for each intent the offering accepts
 * (`GET /v1/offerings/{id}/registration-options`, ENR-05, SPK-REG-002): reasons and permitted
 * alternatives as the API words them, unknown evidence as "not known yet", never a pass. A person
 * the account may only view is "not available to register", with no further detail (SPK-IAM-003).
 *
 * States: loading; withdrawn or never published reads "not available" (NOT_FOUND, no hint it
 * exists); ready; stale (re-read on return to the app: a paused or closed window shows as such);
 * offline (cached detail with its age, registration disabled); registration unavailable unless the
 * API reports `registration_open`; the eligibility section has its own loading, error and
 * not-available states.
 *
 * Not shown: the responsible manager, which the API gives to staff only (`staff` is null for
 * customers; reported).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import {
  OFFERING_KIND_LABELS,
  ageBandLabel,
  capacityLabel,
  formatInstant,
  formatMoney,
} from '../../features/registration/format';
import {
  eligibilityMessages,
  eligibilityOf,
  eligibilityStatus,
  mayRegister,
  useRegistrationOptions,
} from '../../features/registration/options';
import { useParticipants } from '../../features/registration/participants';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { offeringDates, registrationWindowStatus } from '../../features/registration/status';
import { INTENT_LABELS } from '../../features/registration/intents';
import { Body, ButtonRow, Detail, Section, Title } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

type Offering = Schema<'Offering'>;
type OfferingSession = Schema<'OfferingSession'>;
type ChargeLine = Schema<'ChargeLine'>;

export const SESSIONS_SHOWN = 8;

function chargeText(charge: ChargeLine, currency: string): string {
  const amount =
    charge.amountMinor !== undefined
      ? formatMoney(charge.amountMinor, currency)
      : `${(charge.basisPoints ?? 0) / 100}%`;
  return `${amount}${charge.inclusive ? ', included in the price' : ', added to the price'}`;
}

function PriceSection({ offering }: { offering: Offering }) {
  const price = offering.price;
  return (
    <Section title="Price">
      {price ? (
        <>
          <Detail
            label="Base price"
            value={formatMoney(price.basePriceMinor, price.currency)}
            emphasis
          />
          {price.chargeLines.map((charge) => (
            <Detail
              key={charge.code}
              label={charge.label}
              value={chargeText(charge, price.currency)}
            />
          ))}
          <Body muted>
            Your quote shows the final price for each participant, with discounts and credits.
          </Body>
        </>
      ) : (
        <Body>No price is published for this activity yet.</Body>
      )}
    </Section>
  );
}

function SessionsSection({
  sessions,
  timeZone,
}: {
  sessions: OfferingSession[] | undefined;
  timeZone: string;
}) {
  if (!sessions || sessions.length === 0) return null;
  const shown = sessions.slice(0, SESSIONS_SHOWN);
  return (
    <Section title="Sessions">
      <View accessibilityRole="list">
        {shown.map((s) => (
          <Detail
            key={s.id}
            label={s.title ?? `Session ${s.sequence}`}
            value={
              s.status === 'canceled'
                ? `Canceled (was ${formatInstant(s.scheduledStart, timeZone)})`
                : formatInstant(s.scheduledStart, timeZone)
            }
          />
        ))}
      </View>
      {sessions.length > shown.length ? (
        <Body muted>{`And ${sessions.length - shown.length} more sessions.`}</Body>
      ) : null}
    </Section>
  );
}

function PoliciesSection({ offering, signedIn }: { offering: Offering; signedIn: boolean }) {
  const ids = [
    ...offering.requiredFormPolicyVersionIds,
    ...(offering.cancellationPolicyVersionId ? [offering.cancellationPolicyVersionId] : []),
  ];
  const policies = useApiRecords('/policy-versions/{id}', ids, signedIn);
  const titleOf = (id: string) => policies[id]?.data?.title ?? null;
  const forms = offering.requiredFormPolicyVersionIds;
  const cancellation = offering.cancellationPolicyVersionId;
  return (
    <>
      <Section title="Required forms">
        {forms.length === 0 ? (
          <Body>No forms are required.</Body>
        ) : (
          <>
            <Body>
              {`${forms.length} form${forms.length === 1 ? '' : 's'} must be signed for each participant before a place is held. A guardian signs for a child.`}
            </Body>
            {signedIn
              ? forms.map((id) => (titleOf(id) ? <Body key={id}>{`• ${titleOf(id)}`}</Body> : null))
              : null}
          </>
        )}
      </Section>
      <Section title="Cancellation policy">
        {cancellation ? (
          <Body>
            {titleOf(cancellation) ??
              (signedIn
                ? 'This activity has a cancellation policy. Its wording is shown on your quote.'
                : 'This activity has a cancellation policy. Sign in to read it.')}
          </Body>
        ) : (
          <Body>No cancellation policy is attached to this activity.</Body>
        )}
      </Section>
    </>
  );
}

/**
 * SPK-REG-002: read-only eligibility per participant the account may register. Nothing is held;
 * the API evaluates again when a line is added.
 */
function EligibilitySection({ offering }: { offering: Offering }) {
  const { participants, me, namesLoading, namesError, retryNames } = useParticipants();
  const ids = participants.map((p) => p.personId);
  const options = useRegistrationOptions(
    offering.id,
    ids,
    me.data !== undefined && !namesLoading && namesError === null,
  );
  return (
    <Section title="Who can take part">
      <Detail label="Age" value={ageBandLabel(offering.ageBand) ?? 'No age limits'} />
      {me.isPending ||
      namesLoading ||
      (options.data === undefined && options.isPending && options.fetchStatus === 'fetching') ? (
        <StateView variant="loading" label="eligibility for your family" />
      ) : me.error ? (
        <QueryErrorView error={me.error} onRetry={() => void me.refetch()} />
      ) : namesError ? (
        <QueryErrorView error={namesError} onRetry={() => retryNames?.()} />
      ) : options.data === undefined && options.error ? (
        <QueryErrorView
          error={options.error}
          onRetry={() => void options.refetch()}
          unavailable={{
            title: 'Eligibility not available',
            description: 'Eligibility is checked for each participant when you register.',
          }}
        />
      ) : participants.length === 0 ? (
        <Body muted>Add yourself or your family members in Account to see who can take part.</Body>
      ) : (
        <View accessibilityRole="list" testID="eligibility-preview">
          {participants.map((p) => {
            if (!mayRegister(options.data, p.personId)) {
              return (
                <Detail
                  key={p.personId}
                  label={p.displayName}
                  value="Not available to register from your account"
                  testID={`eligibility-${p.self ? 'self' : p.personId}`}
                />
              );
            }
            return (
              <View key={p.personId} testID={`eligibility-${p.self ? 'self' : p.personId}`}>
                {(options.data?.availableIntents ?? []).map((intent) => {
                  const result = eligibilityOf(options.data, p.personId, intent);
                  if (!result) return null;
                  const status = eligibilityStatus(result);
                  const { reasons, alternatives } = eligibilityMessages(result);
                  return (
                    <View
                      key={intent}
                      style={styles.eligibility}
                      accessible
                      accessibilityLabel={[
                        `${p.displayName}, ${INTENT_LABELS[intent].title}: ${status.label}`,
                        ...reasons,
                        ...alternatives,
                      ].join('. ')}
                    >
                      <Body>{`${p.displayName}: ${INTENT_LABELS[intent].title}`}</Body>
                      <StatusBadge {...status} />
                      {reasons.map((reason) => (
                        <Body key={reason} muted>{`• ${reason}`}</Body>
                      ))}
                      {alternatives.map((alternative) => (
                        <Body key={alternative} muted>{`→ ${alternative}`}</Body>
                      ))}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      )}
      <Body muted>
        Eligibility is checked again when you add someone, against the activity's rules and dates of
        birth. Nothing is held until checkout.
      </Body>
    </Section>
  );
}

function RegistrationAction({ offering }: { offering: Offering }) {
  const router = useRouter();
  const { session } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  if (offering.publicationState === 'registration_paused') {
    return (
      <Section title="Registration">
        <Body>Registration is paused. Existing registrations are kept.</Body>
      </Section>
    );
  }
  if (offering.publicationState !== 'registration_open') {
    return (
      <Section title="Registration">
        <Body>Registration is not open for this activity right now.</Body>
      </Section>
    );
  }
  if (session.status !== 'signed_in') {
    return (
      <ButtonRow>
        <Button label="Sign in to register" onPress={() => router.push('/sign-in')} />
      </ButtonRow>
    );
  }
  return (
    <ButtonRow>
      <Button
        label="Register"
        onPress={() => router.push(registrationRoutes.start(offering.id))}
        disabled={offline}
        accessibilityHint="Choose who to register and how"
      />
      {offline ? <Body muted>Registration needs a connection.</Body> : null}
    </ButtonRow>
  );
}

export function OfferingDetailScreen({ offeringId }: { offeringId: string }) {
  const { session } = useApp();
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: session.status !== 'loading',
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
    enabled: offering.data !== undefined,
  });
  const signedIn = session.status === 'signed_in';
  return (
    <Screen>
      <QueryBoundary
        query={offering}
        label="activity"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['Registration']}
      >
        {(o) => (
          <View>
            <Section title={OFFERING_KIND_LABELS[o.kind]}>
              <Title>{o.name}</Title>
              <StatusBadge {...registrationWindowStatus(o)} testID="offering-window" />
              {o.description ? <Body>{o.description}</Body> : null}
            </Section>
            <Section title="About">
              <Detail label="Activity" value={o.activityType} />
              <Detail label="Facility" value={o.facility.name} />
              {o.format ? <Detail label="Format" value={o.format} /> : null}
              {o.locationLabel ? <Detail label="Location" value={o.locationLabel} /> : null}
              <Detail label="Dates" value={offeringDates(o)} />
              {o.registrationOpensAt ? (
                <Detail
                  label="Registration opens"
                  value={formatInstant(o.registrationOpensAt, o.facility.timezone)}
                />
              ) : null}
              {o.registrationClosesAt ? (
                <Detail
                  label="Registration closes"
                  value={formatInstant(o.registrationClosesAt, o.facility.timezone)}
                />
              ) : null}
            </Section>
            {signedIn ? (
              <EligibilitySection offering={o} />
            ) : (
              <Section title="Who can take part">
                <Detail label="Age" value={ageBandLabel(o.ageBand) ?? 'No age limits'} />
                <Body muted>
                  Sign in to see whether you or your family members can take part. Eligibility is
                  checked against the activity's rules and dates of birth.
                </Body>
              </Section>
            )}
            {o.capacity.length > 0 ? (
              <Section title="Places">
                {o.capacity.map((c) => (
                  <Body key={c.unit}>{capacityLabel(c)}</Body>
                ))}
                <Body muted>A place is held for you only during checkout.</Body>
              </Section>
            ) : null}
            <PriceSection offering={o} />
            <SessionsSection sessions={sessions.data} timeZone={o.facility.timezone} />
            <PoliciesSection offering={o} signedIn={signedIn} />
            <RegistrationAction offering={o} />
          </View>
        )}
      </QueryBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  eligibility: { paddingVertical: spacing.xs, gap: spacing.xs },
});

/** Route component for app/registration/offering/[offeringId].tsx. */
export function OfferingDetailRoute() {
  const offeringId = param(useLocalSearchParams<{ offeringId: string }>().offeringId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Activity' }} />
      <OfferingDetailScreen offeringId={offeringId} />
    </>
  );
}
