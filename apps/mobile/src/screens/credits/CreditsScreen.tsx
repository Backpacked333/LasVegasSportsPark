/**
 * SCR-C-35 Credits and makeup entitlements (SPK-PAY-009, SPK-YOUTH-004, SPK-AT-020, SPK-UX-008,
 * SPK-UX-010; POL-010, POL-035 and DEC-058 govern credit expiry, uses and makeup rules and are the
 * API's values, never the app's).
 *
 * Two different assets, shown apart and never added together (journeys.md "Credit: <amount>" and
 * "Makeup sessions available: <count>, expires <date>"):
 * - Credits (`GET /v1/credits?ownerPersonId=`): remaining and original amount, currency, permitted
 *   uses, expiry as the API states it, source, reason and redemption history.
 * - Makeup entitlements (`GET /v1/makeup-entitlements?participantPersonId=`): originating event,
 *   eligible replacements, expiry, redemption limit and history, with "Book a makeup session"
 *   (SCR-C-35 redeem) while one can still be redeemed.
 *
 * States: loading; empty (no credits and no makeups, two separate empties); ready; validation
 * failure and processing: on the redeem screen; permission restriction (each section reads "not
 * available" on its own: credits need the pay permission, makeups the view permission); stale
 * version: refreshed on return; offline (cached with age, booking needs a connection); success
 * ("Booked") on the redeem screen; partial completion: not permitted.
 */
import { presentationForError } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDay, formatInstant, formatMoney } from '../../features/money/format';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { moneyRoutes } from '../../features/money/routes';
import {
  CREDIT_SOURCE_LABELS,
  CREDIT_USE_LABELS,
  MAKEUP_ORIGIN_LABELS,
  creditStatus,
  makeupRedeemable,
  makeupStatus,
  type Credit,
  type MakeupEntitlement,
} from '../../features/money/status';
import { ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

const REFERENCE_LABELS: Record<string, string> = {
  obligation: 'a balance due',
  order: 'a registration order',
  quote: 'a registration',
  checkout: 'a registration',
};

function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      {children}
    </View>
  );
}

function CreditCard({ credit }: { credit: Credit }) {
  const uses = credit.permittedUses.map((u) => CREDIT_USE_LABELS[u]).join(' and ');
  return (
    <Card testID={`credit-${credit.id}`}>
      <StatusBadge {...creditStatus(credit)} />
      <Field
        label="Remaining"
        value={`${formatMoney(credit.remainingMinor, credit.currency)} of ${formatMoney(credit.originalMinor, credit.currency)}`}
      />
      <Field label="Can be used for" value={uses} />
      <Field
        label="Expiry"
        value={credit.expiresAt ? `Expires ${formatDay(credit.expiresAt)}` : 'Expiry: not set'}
      />
      {credit.expiresAt ? null : (
        // No policy claim: whether and when credits expire is pending (SPK-PAY-009).
        <Caption>Credit expiry rules are not decided yet (DEC-058, Finance).</Caption>
      )}
      <Field label="Source" value={CREDIT_SOURCE_LABELS[credit.sourceKind]} />
      {credit.reason ? <Field label="Reason" value={credit.reason} /> : null}
      {credit.redemptions.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Redemption history">
          {credit.redemptions.map((r) => (
            <Caption key={r.id}>
              {r.kind === 'reversal' ? 'Returned' : 'Used'}{' '}
              {formatMoney(Math.abs(r.amountMinor), credit.currency)}{' '}
              {r.kind === 'reversal' ? 'from' : 'on'}{' '}
              {REFERENCE_LABELS[r.referenceType] ?? 'a payment'} on {formatInstant(r.redeemedAt)}
            </Caption>
          ))}
        </View>
      ) : (
        <Caption>Not used yet.</Caption>
      )}
    </Card>
  );
}

function MakeupCard({ makeup }: { makeup: MakeupEntitlement }) {
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const replacements = makeup.eligibleOfferingIds.length + makeup.eligibleProgramIds.length;
  return (
    <Card testID={`makeup-${makeup.id}`}>
      <StatusBadge {...makeupStatus(makeup, now)} />
      <Field label="Why" value={`${MAKEUP_ORIGIN_LABELS[makeup.originKind]}. ${makeup.reason}`} />
      <Field label="Used" value={`${makeup.redeemedCount} of ${makeup.redemptionLimit}`} />
      <Field label="Expires" value={formatInstant(makeup.expiresAt)} />
      <Field
        label="Can replace"
        value={`${replacements} eligible ${replacements === 1 ? 'activity or program' : 'activities or programs'}`}
      />
      {makeup.redemptions.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Redemption history">
          {makeup.redemptions.map((r) => (
            <Caption key={r.id}>
              {r.kind === 'reversal' ? 'Booking reversed' : 'Session booked'} on{' '}
              {formatInstant(r.redeemedAt)}
            </Caption>
          ))}
        </View>
      ) : null}
      {makeupRedeemable(makeup, now) ? (
        <ButtonRow>
          <Button
            label="Book a makeup session"
            variant="secondary"
            disabled={offline}
            accessibilityHint="Choose an eligible session for this makeup"
            onPress={() => router.push(moneyRoutes.makeup(makeup.id))}
          />
        </ButtonRow>
      ) : null}
    </Card>
  );
}

/** A section's own failure: one restricted asset never hides the other (SPK-UX-008). */
function SectionUnavailable({ what }: { what: string }) {
  return (
    <StateView
      variant="unavailable"
      description={`${what} are not available to your account for this person.`}
    />
  );
}

function CreditsSection({ person }: { person: AccountPerson }) {
  const credits = useApiQuery({
    path: '/credits',
    request: { query: { ownerPersonId: person.personId, limit: 50 } },
  });
  if (
    credits.data === undefined &&
    credits.error &&
    presentationForError(credits.error) === 'unavailable'
  ) {
    return (
      <Section title="Credits" testID="credits-section">
        <SectionUnavailable what="Credits" />
      </Section>
    );
  }
  return (
    <Section title="Credits" testID="credits-section">
      <QueryBoundary
        query={credits}
        label="credits"
        isEmpty={(page) => page.items.length === 0}
        empty={{
          title: 'No credits',
          description:
            'Money credits from the facility appear here, with what they can be used for and when they expire.',
        }}
      >
        {(page) => (
          <View accessibilityRole="list" style={styles.list}>
            {page.items.map((credit) => (
              <CreditCard key={credit.id} credit={credit} />
            ))}
          </View>
        )}
      </QueryBoundary>
    </Section>
  );
}

function MakeupsSection({ person }: { person: AccountPerson }) {
  const makeups = useApiQuery({
    path: '/makeup-entitlements',
    request: { query: { participantPersonId: person.personId } },
  });
  if (
    makeups.data === undefined &&
    makeups.error &&
    presentationForError(makeups.error) === 'unavailable'
  ) {
    return (
      <Section title="Makeup sessions" testID="makeups-section">
        <SectionUnavailable what="Makeup sessions" />
      </Section>
    );
  }
  return (
    <Section title="Makeup sessions" testID="makeups-section">
      <Caption>
        A makeup session is not money: it replaces a session and is booked, not spent.
      </Caption>
      <QueryBoundary
        query={makeups}
        label="makeup sessions"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No makeup sessions',
          description:
            'When a session is canceled or missed and the program offers a makeup, it appears here to book.',
        }}
        unavailableOffline={['booking a makeup session']}
      >
        {(items) => (
          <View accessibilityRole="list" style={styles.list}>
            {items.map((makeup) => (
              <MakeupCard key={makeup.id} makeup={makeup} />
            ))}
          </View>
        )}
      </QueryBoundary>
    </Section>
  );
}

export function CreditsScreen() {
  return (
    <Screen>
      <RequireSession what="credits and makeup sessions">
        <PeopleGate pickerLabel="Show credits and makeups of">
          {(person) => (
            <View key={person.personId}>
              <CreditsSection person={person} />
              <MakeupsSection person={person} />
            </View>
          )}
        </PeopleGate>
      </RequireSession>
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

/** Route component for app/credits/index.tsx. */
export function CreditsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Credits and makeup sessions' }} />
      <CreditsScreen />
    </>
  );
}
