/**
 * SCR-C-35 Credits and makeups (makeup entitlements in the API;SPK-PAY-009, SPK-YOUTH-004, SPK-AT-020, SPK-UX-008,
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
 * - Class packs (session packages in the API, `GET /v1/me/package-entitlements`, ENR-11; Package G
 *   behind the `session_packages` switch, DEC-016, DEC-074): a third, separate list for the whole
 *   account, with sessions left, expiry and redemption history (MySessionPackagesScreen.tsx). While
 *   the switch is off the section shows only when the account already holds a pack, under the
 *   plain "Class packs turned off" notice; packs already held stay listed.
 *
 * The page opens with the chosen person's balances as stat tiles (ADR-008 `StatTile`): "Credit
 * balance" is the API's `creditsAvailable` per currency (`GET /v1/people/{id}/money-summary`,
 * never added up here), shown when that read answers; "Makeup sessions available" counts the
 * sessions left on makeups that can still be booked. A credit without an expiry says "Ask the
 * front desk when your credit expires." with DEC-058 in the "Details for support" fold (PA-11).
 * Pulling the page down reads everything again.
 *
 * Credits are read in cursor pages with "Load more", so none is silently cut off (§4.5).
 *
 * States: loading; empty (no credits, with the payments illustration, and no makeups: two
 * separate empties); ready; validation
 * failure and processing: on the redeem screen; permission restriction (each section reads "not
 * available" on its own: credits need the pay permission, makeups the view permission); stale
 * version: refreshed on return; offline (cached with age, booking needs a connection); success
 * ("Booked") on the redeem screen; partial completion: not permitted.
 */
import { presentationForError } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { pendingMessage } from '../../copy/pending';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
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
  makeupRemaining,
  makeupStatus,
  type Credit,
  type MakeupEntitlement,
} from '../../features/money/status';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { Card as UiCard } from '../../ui/Card';
import { FieldValue as Field } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { StatTile } from '../../ui/StatTile';
import { SupportDetails } from '../../ui/SupportDetails';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { Actions, MoneyEmpty, usePullToRefresh } from '../../features/money/surfaces';
import { amountsText } from '../payments/MoneySummary';
import { SessionPackagesSection } from '../session-packages/MySessionPackagesScreen';

const REFERENCE_LABELS: Record<string, string> = {
  obligation: 'an amount due',
  order: 'a registration order',
  quote: 'a registration',
  checkout: 'a registration',
};

function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles();
  return (
    <UiCard style={styles.card} testID={testID}>
      {children}
    </UiCard>
  );
}

function CreditCard({ credit }: { credit: Credit }) {
  const styles = useStyles();
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
        value={credit.expiresAt ? `Expires ${formatDay(credit.expiresAt)}` : 'Not set'}
      />
      {credit.expiresAt ? null : (
        // No policy claim: whether and when credits expire is pending (SPK-PAY-009, DEC-058).
        <View style={styles.pending} testID={`credit-expiry-${credit.id}`}>
          <Text variant="caption" tone="muted">
            {pendingMessage('DEC-058')}
          </Text>
          <SupportDetails decisions={['DEC-058']} owner="Finance" />
        </View>
      )}
      <Field label="Source" value={CREDIT_SOURCE_LABELS[credit.sourceKind]} />
      {credit.reason ? <Field label="Reason" value={credit.reason} /> : null}
      {credit.redemptions.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Redemption history">
          {credit.redemptions.map((r) => (
            <Text variant="caption" tone="muted" key={r.id}>
              {r.kind === 'reversal' ? 'Returned' : 'Used'}{' '}
              {formatMoney(Math.abs(r.amountMinor), credit.currency)}{' '}
              {r.kind === 'reversal' ? 'from' : 'on'}{' '}
              {REFERENCE_LABELS[r.referenceType] ?? 'a payment'} on {formatInstant(r.redeemedAt)}
            </Text>
          ))}
        </View>
      ) : (
        <Text variant="caption" tone="muted">
          Not used yet.
        </Text>
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
            <Text variant="caption" tone="muted" key={r.id}>
              {r.kind === 'reversal' ? 'Booking reversed' : 'Session booked'} on{' '}
              {formatInstant(r.redeemedAt)}
            </Text>
          ))}
        </View>
      ) : null}
      {makeupRedeemable(makeup, now) ? (
        <Actions>
          <Button
            label="Book a makeup session"
            variant="secondary"
            disabled={offline}
            accessibilityHint="Choose an eligible session for this makeup"
            onPress={() => router.push(moneyRoutes.makeup(makeup.id))}
          />
        </Actions>
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
  const styles = useStyles();
  const credits = useApiPages({
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
        // No `isEmpty`: the empty list is drawn below, with the payments illustration.
        empty={{ title: '', description: '' }}
      >
        {(items) =>
          items.length === 0 ? (
            <MoneyEmpty
              title="No credits"
              message="Money credits from the facility appear here, with what they can be used for and when they expire."
              testID="credits-empty"
            />
          ) : (
            <View accessibilityRole="list" style={styles.list}>
              {items.map((credit) => (
                <CreditCard key={credit.id} credit={credit} />
              ))}
            </View>
          )
        }
      </QueryBoundary>
      <LoadMore pages={credits} label="credits" />
    </Section>
  );
}

function MakeupsSection({ person }: { person: AccountPerson }) {
  const styles = useStyles();
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
      <Text variant="caption" tone="muted">
        A makeup session is not money: it replaces a session and is booked, not spent.
      </Text>
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

/**
 * The person's balances at the top: the API's credit balance (shown once the money summary
 * answers; the credits list below keeps its own states) and the makeup sessions left to book.
 */
function BalanceTiles({ person }: { person: AccountPerson }) {
  const styles = useStyles();
  const now = useNow();
  const summary = useApiQuery({
    path: '/people/{id}/money-summary',
    request: { path: { id: person.personId } },
    staleTime: 30_000,
  });
  const makeups = useApiQuery({
    path: '/makeup-entitlements',
    request: { query: { participantPersonId: person.personId } },
  });
  const credits = summary.data?.creditsAvailable;
  const left =
    makeups.data === undefined
      ? null
      : makeups.data
          .filter((m) => makeupRedeemable(m, now))
          .reduce((sum, m) => sum + makeupRemaining(m), 0);
  if (credits === undefined && left === null) return null;
  return (
    <View style={styles.tiles} testID="credits-tiles">
      {credits !== undefined ? (
        <StatTile
          label="Credit balance"
          value={amountsText(credits, 'None')}
          sublabel="Ready to use"
          testID="credits-balance"
        />
      ) : null}
      {left !== null ? (
        <StatTile
          label="Makeup sessions available"
          value={String(left)}
          sublabel={left === 1 ? 'Session to book' : 'Sessions to book'}
          testID="makeups-available"
        />
      ) : null}
    </View>
  );
}

export function CreditsScreen() {
  const { refreshing, onRefresh } = usePullToRefresh();
  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <RequireSession what="credits and makeups">
        <PeopleGate pickerLabel="Show credits and makeups of">
          {(person) => (
            <View key={person.personId}>
              <BalanceTiles person={person} />
              <CreditsSection person={person} />
              <MakeupsSection person={person} />
            </View>
          )}
        </PeopleGate>
        <SessionPackagesSection onlyWhenRelevant />
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  card: { gap: spacing.sm },
  list: { gap: spacing.sm },
  pending: { gap: spacing.xs },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    marginTop: spacing.sm,
  },
}));

/** Route component for app/credits/index.tsx. */
export function CreditsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Credits and makeups' }} />
      <CreditsScreen />
    </>
  );
}
