/**
 * SCR-C-08 Offering detail (SPK-CAT-001, SPK-REG-002, §4.5 date-based eligibility, POL-001,
 * POL-007; journey A1). Reads `GET /v1/offerings/{id}` (public, child-safe view) and its sessions:
 * name, description, activity type, format, location, dates, registration window, age band,
 * capacity units, price basis with approved taxes and fees, required forms and the cancellation
 * policy, then the entry point to registration (SCR-C-09).
 *
 * States: loading; withdrawn or never published reads "not available" (NOT_FOUND, no hint it
 * exists); ready; stale (re-read on return to the app: a paused or closed window shows as such);
 * offline (cached detail with its age, registration disabled); registration unavailable unless the
 * API reports `registration_open`.
 *
 * Not shown, because the API does not provide them to customers (reported as API gaps):
 * eligibility per authorized participant before a basket line is added (no preview endpoint), the
 * responsible manager (staff-only), and the facility's time zone (times use the device's zone).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import {
  OFFERING_KIND_LABELS,
  ageBandLabel,
  capacityLabel,
  formatInstant,
  formatMoney,
} from '../../features/registration/format';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { offeringDates, registrationWindowStatus } from '../../features/registration/status';
import { Body, ButtonRow, Detail, Section, Title } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';

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

function SessionsSection({ sessions }: { sessions: OfferingSession[] | undefined }) {
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
                ? `Canceled (was ${formatInstant(s.scheduledStart)})`
                : formatInstant(s.scheduledStart)
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
              {o.format ? <Detail label="Format" value={o.format} /> : null}
              {o.locationLabel ? <Detail label="Location" value={o.locationLabel} /> : null}
              <Detail label="Dates" value={offeringDates(o)} />
              {o.registrationOpensAt ? (
                <Detail label="Registration opens" value={formatInstant(o.registrationOpensAt)} />
              ) : null}
              {o.registrationClosesAt ? (
                <Detail label="Registration closes" value={formatInstant(o.registrationClosesAt)} />
              ) : null}
            </Section>
            <Section title="Who can take part">
              <Detail label="Age" value={ageBandLabel(o.ageBand) ?? 'No age limits'} />
              <Body muted>
                Eligibility is checked for each participant when you add them, against the
                activity's rules and dates of birth.
              </Body>
            </Section>
            {o.capacity.length > 0 ? (
              <Section title="Places">
                {o.capacity.map((c) => (
                  <Body key={c.unit}>{capacityLabel(c)}</Body>
                ))}
                <Body muted>A place is held for you only during checkout.</Body>
              </Section>
            ) : null}
            <PriceSection offering={o} />
            <SessionsSection sessions={sessions.data} />
            <PoliciesSection offering={o} signedIn={signedIn} />
            <RegistrationAction offering={o} />
          </View>
        )}
      </QueryBoundary>
    </Screen>
  );
}

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
