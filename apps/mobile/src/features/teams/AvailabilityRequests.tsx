/**
 * SCR-C-24 "request availability" (CMP-14; SPK-CAP-001, SPK-CAP-003): the captain asks the roster
 * players of one game who have not answered yet (`POST /v1/fixtures/{id}/availability-requests`);
 * a later request is the reminder and reaches only those still without an answer. Earlier
 * requests are listed with how many people each reached (`GET .../availability-requests`). The
 * API picks the recipients, so the app never counts or names them; each one (or the guardian of a
 * child player) gets a notice in the app's inbox. Offered only when the workspace lists
 * `competition.request_availability` for this viewer (CMP-02). Requests are refused once
 * availability closes for the game (INVALID_TRANSITION `AVAILABILITY_CLOSED`, at kickoff until a
 * rule set defines a cutoff, DEC-002): the app never decides that cutoff itself.
 *
 * States: loading; empty (no request sent yet); ready; validation failure (message too long);
 * permission restriction ("not available"); stale version (closed at kickoff: said so);
 * offline (sending disabled, the message kept); processing; success ("Asked N players");
 * recovery: a failed send is retried under the same idempotency key.
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { formatInstant, plural } from './format';
import { Body, CommandFailure, OfflineNotice, TextField } from './ui';

type AvailabilityRequest = Schema<'AvailabilityRequest'>;

/** The API's limit for the optional message (`CreateAvailabilityRequestBody`). */
export const REQUEST_MESSAGE_MAX = 500;

/**
 * `INVALID_TRANSITION` with `details.code: 'AVAILABILITY_CLOSED'` (CMP-04, CMP-14): the kickoff
 * it closed at, `''` when the API sent none, or null for any other error.
 */
export function availabilityClosedAt(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'INVALID_TRANSITION') return null;
  const details = error.details as { code?: unknown; scheduledStart?: unknown } | undefined;
  if (details?.code !== 'AVAILABILITY_CLOSED') return null;
  return typeof details.scheduledStart === 'string' ? details.scheduledStart : '';
}

/** "Answers for this game closed at kickoff …": shown instead of a generic stale failure. */
export function AvailabilityClosed({
  error,
  timeZone,
  what,
}: {
  error: ApiError;
  timeZone?: string | null;
  what: string;
}) {
  const at = availabilityClosedAt(error);
  return (
    <View style={styles.group} testID="availability-closed" accessibilityLiveRegion="polite">
      <StatusBadge tone="neutral" label="Availability closed" />
      <Body>
        {at
          ? `${what} closed at kickoff, ${formatInstant(at, timeZone)}.`
          : `${what} closed for this game.`}
      </Body>
      <Body muted>{`Error code: ${error.code}`}</Body>
    </View>
  );
}

export function requestSummary(request: AvailabilityRequest, timeZone?: string | null): string {
  const reached =
    request.recipientCount === 0
      ? 'nobody was still without an answer'
      : `asked ${plural(request.recipientCount, 'person', 'people')} without an answer`;
  return `${formatInstant(request.requestedAt, timeZone)}: ${reached}${request.message ? `. Message: "${request.message}"` : ''}`;
}

export function AvailabilityRequests({
  fixtureId,
  teamEntryId,
  timeZone,
}: {
  fixtureId: string;
  teamEntryId: string;
  /** The facility's zone from the fixture's venue, when known (SPK-SCHED-008). */
  timeZone?: string | null;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [message, setMessage] = useState('');
  const earlier = useApiQuery({
    path: '/fixtures/{id}/availability-requests',
    request: { path: { id: fixtureId }, query: { teamEntryId } },
  });
  const send = useApiCommand('post', '/fixtures/{id}/availability-requests', {
    invalidate: [['api', '/fixtures/{id}/availability-requests']],
  });
  const tooLong = message.trim().length > REQUEST_MESSAGE_MAX;
  const submit = () => {
    if (tooLong) return;
    void send
      .submit({
        path: { id: fixtureId },
        body: { teamEntryId, ...(message.trim() ? { message: message.trim() } : {}) },
      })
      .then(() => setMessage(''))
      .catch(() => undefined);
  };
  const reminder = (earlier.data?.length ?? 0) > 0;
  return (
    <View style={styles.group} testID={`availability-requests-${fixtureId}`}>
      <Body muted>
        Only players who have not answered are asked; each gets a notice in the app inbox (for a
        child player, the guardian does). A later request is a reminder to those still without an
        answer.
      </Body>
      <QueryBoundary
        query={earlier}
        label="earlier availability requests"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No request sent yet',
          description: 'Players can answer at any time; a request reminds those who have not.',
        }}
        unavailableOffline={['asking for availability']}
      >
        {(list) => (
          <View accessibilityRole="list" accessibilityLabel="Earlier availability requests">
            {[...list]
              .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
              .map((r) => (
                <View
                  key={r.id}
                  accessible
                  accessibilityLabel={`Request sent ${requestSummary(r, timeZone)}`}
                >
                  <Body>{`Request sent ${requestSummary(r, timeZone)}`}</Body>
                </View>
              ))}
          </View>
        )}
      </QueryBoundary>
      {send.data ? (
        <View accessibilityLiveRegion="polite">
          <StatusBadge
            tone="success"
            label={
              send.data.recipientCount === 0
                ? 'Everyone has answered: nobody was asked'
                : `Asked ${plural(send.data.recipientCount, 'person', 'people')} without an answer`
            }
          />
        </View>
      ) : null}
      <TextField
        label="Message to the players (optional)"
        value={message}
        onChangeText={setMessage}
        multiline
        error={tooLong ? `Keep the message to ${REQUEST_MESSAGE_MAX} characters.` : null}
      />
      {offline ? <OfflineNotice what="Asking for availability" /> : null}
      <Button
        label={
          reminder
            ? 'Send a reminder to players without an answer'
            : 'Ask players without an answer'
        }
        onPress={submit}
        disabled={offline || tooLong}
        busy={send.isProcessing}
      />
      {send.error && availabilityClosedAt(send.error) !== null ? (
        <AvailabilityClosed error={send.error} timeZone={timeZone} what="Availability requests" />
      ) : send.error ? (
        <CommandFailure
          error={send.error}
          onRetry={submit}
          onReload={() => {
            send.reset();
            void earlier.refetch();
          }}
          unavailableText="Asking the roster for availability is not available to you for this team."
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
