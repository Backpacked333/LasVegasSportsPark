/**
 * SCR-C-20 Activity or fixture detail, activity variant (SPK-UX-004, SPK-COMMS-005,
 * SPK-SCHED-008, SPK-UX-008, SPK-UX-009, §4.14): one program session or booked session for one
 * participant.
 *
 * - The route carries opaque ids only: the session, and the enrollment or the session booking it
 *   belongs to (`/sessions/<sessionId>?enrollmentId=…` or `?bookingId=…`); never a name.
 * - `GET /v1/enrollments/{id}` or `GET /v1/session-bookings/{id}` decides whether the person may
 *   see this at all (the participant, a guardian holding `view`, staff). NOT_FOUND is "not
 *   available" with no hint that anything exists (§4.10).
 * - The card (SCR-C-04) shows participant, activity, place, time, status in journeys.md
 *   vocabulary (payment processing, awaiting placement and confirmed apart), and the latest
 *   change with old and new details. A canceled session says so with the reason.
 * - Times are on the facility clock: the enrollment's `offering.timezone` (ENR-02), else the
 *   facility of the offering (`GET /v1/facilities/{id}`), which also names the place.
 * - The top is the activity's picture with its facts as tags, its status and the change
 *   (`ActivityHero`, ADR-008).
 * - Arrival guidance is POL-046 (Operations, pending): its plain message, the code in the fold
 *   (PA-11).
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { pendingMessage } from '../../copy/pending';
import { nameOf, useMe, usePersonNames, useSignedIn } from '../../features/today/queries';
import { SectionQueryState } from '../../features/today/read-state';
import { useSessionActivity, type SessionRef } from '../../features/today/session-activity';
import { zoneNotice } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LastUpdated } from '../../ui/LastUpdated';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { layout, spacing } from '../../ui/theme';
import { ActivityHero } from './ActivityHero';

type Enrollment = Schema<'Enrollment'>;
type SessionBooking = Schema<'SessionBooking'>;

export interface SessionDetailProps {
  sessionId: string | undefined;
  enrollmentId?: string;
  bookingId?: string;
}

function refOf(
  sessionId: string,
  enrollment: Enrollment | undefined,
  booking: SessionBooking | undefined,
): SessionRef | null {
  if (booking) {
    return {
      kind: 'session_booking',
      personId: booking.participantPersonId,
      offeringId: booking.offeringId,
      sessionId: booking.sessionId,
      enrollmentId: null,
      sessionBookingId: booking.id,
      title: 'Activity',
      start: booking.scheduledStart,
      end: booking.scheduledEnd,
      status: booking.status,
    };
  }
  if (enrollment) {
    return {
      kind: 'enrollment_session',
      personId: enrollment.participantPersonId,
      offeringId: enrollment.offeringId,
      sessionId,
      enrollmentId: enrollment.id,
      sessionBookingId: null,
      title: enrollment.offering?.name ?? 'Activity',
      start: '',
      end: '',
      status: enrollment.status,
      facilityId: enrollment.offering?.facilityId ?? null,
      timezone: enrollment.offering?.timezone ?? null,
    };
  }
  return null;
}

function SessionContent({
  sessionId,
  enrollmentId,
  bookingId,
}: SessionDetailProps & { sessionId: string }) {
  const now = useNow();
  const signedIn = useSignedIn();
  const me = useMe();
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId ?? '' } },
    enabled: signedIn && !!enrollmentId,
  });
  const booking = useApiQuery({
    path: '/session-bookings/{id}',
    request: { path: { id: bookingId ?? '' } },
    enabled: signedIn && !!bookingId,
  });
  const owner = bookingId ? booking : enrollment;
  // §4.10, §4.14: once the API answers NOT_FOUND or ACCESS_DENIED for the owning record, its cached
  // copy is no longer shown.
  const revoked = owner.error !== null && presentationForError(owner.error) === 'unavailable';
  const ref = revoked ? null : refOf(sessionId, enrollment.data, booking.data);
  const names = usePersonNames(ref ? [ref.personId] : [], me.data);
  const activity = useSessionActivity(ref, ref ? nameOf(names, ref.personId) : '', {
    sessionBooking: booking.data,
  });

  if (!ref || !activity.model) {
    return (
      <SectionQueryState
        read={owner}
        label="the activity"
        unavailable={{
          description:
            'This activity is not available. Check the link, or contact the front desk if you expected to see it.',
        }}
      />
    );
  }
  if (activity.sessionsRead.data === undefined) {
    return <SectionQueryState read={activity.sessionsRead} label="the activity" />;
  }
  if (activity.session === undefined) {
    // The offering's sessions loaded but this one is not among them.
    return <StateView variant="unavailable" />;
  }

  const session = activity.session;
  const notice = zoneNotice(activity.model.zone, activity.model.start || now);
  return (
    <View testID="session-detail">
      <LastUpdated at={owner.updatedAt} now={now} />
      <View>
        <ActivityHero
          model={activity.model}
          source={artworkFor(activity.offering ?? { title: activity.model.title }, 'wide').source}
          testID="session-card"
        />
        {notice ? (
          <Text variant="caption" tone="muted" style={styles.note}>
            {notice}
          </Text>
        ) : null}
      </View>
      {session?.status === 'canceled' ? (
        <Section variant="carousel" title="Canceled" testID="session-canceled">
          <Text variant="caption" tone="muted" style={styles.note}>
            This session was canceled{session.cancelReason ? `: ${session.cancelReason}` : '.'}
          </Text>
        </Section>
      ) : null}
      {activity.offering?.description ? (
        <Section variant="carousel" title="About">
          <Text variant="caption" tone="muted" style={styles.note}>
            {activity.offering.description}
          </Text>
        </Section>
      ) : null}
      <Section variant="carousel" title="Arrival guidance">
        <View style={styles.pad}>
          <StateView
            variant="pending-decision"
            subject="Arrival guidance for this activity"
            message={pendingMessage('POL-046')}
            decisions={['POL-046']}
            owner="Operations"
          />
        </View>
      </Section>
    </View>
  );
}

export function SessionDetailScreen({ sessionId, enrollmentId, bookingId }: SessionDetailProps) {
  return (
    <Screen>
      <RequireSession what="this activity">
        {sessionId && (enrollmentId || bookingId) ? (
          <SessionContent sessionId={sessionId} enrollmentId={enrollmentId} bookingId={bookingId} />
        ) : (
          <StateView variant="unavailable" />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/sessions/<sessionId>?enrollmentId=<id>` or `?bookingId=<id>`. */
export function SessionDetailRoute() {
  const params = useLocalSearchParams<{
    sessionId?: string;
    enrollmentId?: string;
    bookingId?: string;
  }>();
  const one = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return (
    <SessionDetailScreen
      sessionId={one(params.sessionId)}
      enrollmentId={one(params.enrollmentId)}
      bookingId={one(params.bookingId)}
    />
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg },
  /** A note at the page's side margin, inside an edge-to-edge section. */
  note: { paddingHorizontal: layout.gutter },
});
