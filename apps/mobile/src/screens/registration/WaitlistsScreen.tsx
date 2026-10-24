/**
 * SCR-C-16 Waitlist entries (SPK-REG-008): the waitlists joined from this device, each read again
 * from `GET /v1/waitlist-entries/{id}` with its current status and any open offer. The API has no
 * customer-scoped list of waitlist entries (reported as an API gap), so entries joined elsewhere
 * (another device, the front desk) are not listed here; an entry the API no longer shows to this
 * account reads "not available" without detail.
 *
 * States: loading per entry; empty (none joined here); ready; not available; offline (each entry
 * with the age of what is shown, through the foundation banner).
 */
import { presentationForError } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useParticipantNames } from '../../features/registration/participants';
import { useRegistrationProgress } from '../../features/registration/progress';
import { useApiRecords } from '../../features/registration/queries';
import { registrationRoutes } from '../../features/registration/routes';
import { waitlistEntryStatus } from '../../features/registration/status';
import { Body, Section } from '../../features/registration/ui';
import { useApp, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

function WaitlistList() {
  const router = useRouter();
  const now = useNow();
  const { session } = useApp();
  const { progress } = useRegistrationProgress();
  const ids = progress.waitlistEntryIds;
  const entries = useApiRecords('/waitlist-entries/{id}', ids, session.status === 'signed_in');
  const loaded = ids.map((id) => entries[id]?.data).filter((e) => e !== undefined);
  const names = useParticipantNames(loaded.map((e) => e.participantPersonId));
  const offerings = useApiRecords(
    '/offerings/{id}',
    loaded.map((e) => e.offeringId),
  );
  if (ids.length === 0) {
    return (
      <StateView
        variant="empty"
        title="No waitlists"
        description="Waitlists you join in this app appear here. When a place is offered, you can accept it before the offer ends."
        actionLabel="Discover activities"
        onAction={() => router.push(registrationRoutes.discover())}
      />
    );
  }
  return (
    <View>
      <View accessibilityRole="list">
        {ids.map((id) => {
          const record = entries[id];
          if (!record || record.loading) {
            return <StateView key={id} variant="loading" label="waitlist entry" />;
          }
          const entry = record.data;
          // Only a protected NOT_FOUND or a permission restriction reads as not available; a
          // temporary failure keeps its code and "Try again" (SPK-UX-008).
          if (!entry || (record.error && presentationForError(record.error) === 'unavailable')) {
            if (record.error && presentationForError(record.error) !== 'unavailable') {
              return (
                <View key={id} testID={`waitlist-row-${id}`}>
                  <QueryErrorView error={record.error} onRetry={record.refetch} />
                </View>
              );
            }
            return (
              <ListRow
                key={id}
                title="Waitlist entry not available"
                detail="It may have ended, or it is not shown to this account."
                testID={`waitlist-row-${id}`}
              />
            );
          }
          const offeringName = offerings[entry.offeringId]?.data?.name ?? 'Activity';
          return (
            <ListRow
              key={id}
              title={`${names(entry.participantPersonId)}: ${offeringName}`}
              status={waitlistEntryStatus(entry, offeringName, now)}
              onPress={() => router.push(registrationRoutes.waitlist(id))}
              accessibilityHint="Opens the waitlist entry and any offer"
              testID={`waitlist-row-${id}`}
            />
          );
        })}
      </View>
      <Section title="Other waitlists">
        <Body muted>
          Waitlists joined on another device or at the front desk are not listed here yet.
        </Body>
      </Section>
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
