/**
 * Gallery specimens of StateView (SPK-UX-008): every state, with made-up content. The error is a
 * locally built `ApiError`; nothing here calls the API.
 */
import { ApiError } from '@sportspark/api-client';
import { useNow } from '../providers/AppProviders';
import { Section } from '../ui/Section';
import { StateView } from '../ui/StateView';
import { useToast } from '../ui/Toast';

const STALE_ERROR = new ApiError({
  kind: 'api',
  status: 409,
  code: 'STALE_REVISION',
  message: 'This changed since it was loaded.',
  nextAction: 'reload',
  correlationId: 'corr-gallery-0001',
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function StateSpecimens() {
  const toast = useToast();
  const now = useNow();
  const pretend = (message: string) => () => toast.show({ message, tone: 'info' });
  return (
    <Section title="StateView" subtitle="Loading, empty, error, offline, unavailable, decisions">
      <StateView variant="loading" label="registrations" />
      <StateView
        variant="empty"
        title="No registrations yet"
        description="Activities you register for show here."
        actionLabel="Explore activities"
        onAction={pretend('Explore')}
      />
      <StateView variant="error" error={STALE_ERROR} onRetry={pretend('Try again')} />
      <StateView
        variant="offline-stale"
        updatedAt={new Date(now.getTime() - TWO_HOURS_MS)}
        now={now}
        offline
        unavailableActions={['Registration', 'Payment']}
        onRetry={pretend('Check again')}
      />
      <StateView
        variant="unavailable"
        title="Not available"
        description="This isn't something you can open."
      />
      <StateView
        variant="pending-decision"
        subject="Paying in the app"
        decisions={['DEC-019']}
        owner="Technical lead"
        message="Pay at the front desk for now."
        action={{ label: 'Call the front desk', onPress: pretend('Call') }}
      />
      <StateView
        variant="turned-off"
        subject="Rentals"
        decisions={['DEC-016']}
        stillAvailable="Your existing bookings stay visible."
      />
    </Section>
  );
}
