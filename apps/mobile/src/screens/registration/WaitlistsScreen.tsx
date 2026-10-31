/**
 * SCR-C-16 Waitlist entries (SPK-REG-008, SPK-UX-001; ENR-01): every waitlist entry of the
 * signed-in customer and of the people they may view, from `GET /v1/me/waitlist-entries`
 * (newest first, keyset pages with "Load more"), wherever it was joined: this device, another
 * one or the front desk. Each entry shows its participant, the offering's name as the API gives
 * it (also for an offering no longer listed), its status and any open offer with the server's
 * deadline ("Place offered. Accept by <server time>.", in the facility zone of the entry's
 * offering from `GET /v1/offerings/{id}`, SPK-SCHED-008; the device zone, named, while that
 * offering is not readable). Open offers come first, then the other
 * active entries, then history. A child the account may not view is never listed (the API leaves
 * them out). Offer notices arrive in the inbox (ENR-09).
 *
 * States: loading; empty (no waitlists, with the way to Discover); ready; error with code and
 * "Try again"; not available; offline (the list with its age; accepting needs a connection).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { useParticipantNames } from '../../features/registration/participants';
import { useOfferingTimeZones } from '../../features/registration/queries';
import { registrationRoutes } from '../../features/registration/routes';
import { offerDeadlineStatus, waitlistEntryStatus } from '../../features/registration/status';
import { Section } from '../../features/registration/ui';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';

type MyWaitlistEntry = Schema<'MyWaitlistEntry'>;

export const WAITLIST_PAGE_SIZE = 20;

const ACTIVE: readonly MyWaitlistEntry['status'][] = ['waiting', 'offered'];

function EntryRows({
  entries,
  names,
  zoneOf,
  now,
}: {
  entries: readonly MyWaitlistEntry[];
  names: (personId: string) => string;
  /** The facility zone of an entry's offering (SPK-SCHED-008), when its offering is readable. */
  zoneOf: (offeringId: string) => string | undefined;
  now: Date;
}) {
  const router = useRouter();
  return (
    <View accessibilityRole="list">
      {entries.map((entry) => {
        const offeringName = entry.offeringName ?? 'An activity no longer listed';
        const status =
          entry.openOffer?.status === 'offered'
            ? offerDeadlineStatus(entry.openOffer.expiresAt, now, zoneOf(entry.offeringId))
            : waitlistEntryStatus(entry, offeringName, now, zoneOf(entry.offeringId));
        return (
          <ListRow
            key={entry.id}
            title={`${names(entry.participantPersonId)}: ${offeringName}`}
            status={status}
            onPress={() => router.push(registrationRoutes.waitlist(entry.id))}
            accessibilityHint="Opens the waitlist entry and any offer"
            testID={`waitlist-row-${entry.id}`}
          />
        );
      })}
    </View>
  );
}

function WaitlistList() {
  const router = useRouter();
  const now = useNow();
  const pages = useApiPages({
    path: '/me/waitlist-entries',
    request: { query: { limit: WAITLIST_PAGE_SIZE } },
  });
  const items = pages.data ?? [];
  const names = useParticipantNames(items.map((e) => e.participantPersonId));
  // Only an open offer shows an instant (its deadline): read those offerings for their zone.
  const zoneOf = useOfferingTimeZones(
    items.filter((e) => e.openOffer?.status === 'offered').map((e) => e.offeringId),
  );
  return (
    <View>
      <QueryBoundary
        query={pages}
        label="your waitlists"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No waitlists',
          description:
            'When you join a waitlist, it appears here. When a place is offered, you can accept it before the offer ends.',
          actionLabel: 'Discover activities',
          onAction: () => router.push(registrationRoutes.discover()),
        }}
        unavailableOffline={['Accepting an offer', 'Leaving a waitlist']}
      >
        {(list) => {
          const offered = list.filter((e) => e.openOffer?.status === 'offered');
          const waiting = list.filter(
            (e) => ACTIVE.includes(e.status) && e.openOffer?.status !== 'offered',
          );
          const history = list.filter(
            (e) => !ACTIVE.includes(e.status) && e.openOffer?.status !== 'offered',
          );
          return (
            <View>
              {offered.length > 0 ? (
                <Section title="Places offered" testID="waitlists-offered">
                  <EntryRows entries={offered} names={names} zoneOf={zoneOf} now={now} />
                </Section>
              ) : null}
              {waiting.length > 0 ? (
                <Section title="Waiting" testID="waitlists-waiting">
                  <EntryRows entries={waiting} names={names} zoneOf={zoneOf} now={now} />
                </Section>
              ) : null}
              {history.length > 0 ? (
                <Section title="Earlier waitlists" testID="waitlists-history">
                  <EntryRows entries={history} names={names} zoneOf={zoneOf} now={now} />
                </Section>
              ) : null}
            </View>
          );
        }}
      </QueryBoundary>
      <LoadMore pages={pages} label="waitlist entries" />
    </View>
  );
}

export function WaitlistsScreen() {
  return (
    <Screen>
      <RequireSession what="your waitlists">
        <WaitlistList />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/waitlists.tsx. */
export function WaitlistsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Your waitlists' }} />
      <WaitlistsScreen />
    </>
  );
}
