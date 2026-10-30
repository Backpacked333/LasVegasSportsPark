/**
 * SCR-C-22 "contact the operating team" (SPK-CAP-001, SPK-SUPPORT-002; SUP-01). A captain opens a
 * support request about the team with `POST /v1/me/support-requests` (category `team`, the entry as
 * `teamEntryId`); the API checks that the caller captains the entry and routes the request by
 * category. The answer is the request's status only, never notes, owner or queue (§4.14); its
 * progress is on Support (SCR-C-38). How quickly the operating team answers is DEC-015 (pending),
 * so no response time is promised here. The form is shown only when the workspace says the viewer
 * acts as captain (`viewer.actingAsCaptain`, the API's team role `captain`); a roster player, and a
 * co-captain the rule set does not let act as captain, are pointed to Support, where a request is
 * about themselves.
 *
 * States: ready (the form); validation failure (title and description required, the API's field
 * issues); permission restriction (not the captain: "not available"); offline (sending disabled,
 * the draft kept); processing (sending); success ("Request sent", its status); recovery: a failed
 * send is retried under the same idempotency key, and the draft is kept on any failure.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { formatInstant } from './format';
import type { Workspace } from './queries';
import { Body, CommandFailure, OfflineNotice, TextField } from './ui';

/** Lengths the API accepts (`CustomerSupportRequestBody`). */
export const SUPPORT_TITLE_MAX = 200;
export const SUPPORT_DESCRIPTION_MAX = 5000;

/** A request's status in customer words (SUP-01: the status only). */
export function supportCaseStatus(status: Schema<'CaseStatus'>): StatusBadgeProps {
  switch (status) {
    case 'open':
      return { tone: 'info', label: 'Request open' };
    case 'waiting_customer':
      return { tone: 'warning', label: 'Waiting for your reply' };
    case 'waiting_internal':
      return { tone: 'pending', label: 'In progress' };
    case 'resolved':
      return { tone: 'success', label: 'Resolved' };
    case 'closed':
      return { tone: 'neutral', label: 'Closed' };
  }
}

function lengthError(value: string, max: number, what: string): string | null {
  if (!value.trim()) return `Enter ${what}.`;
  if (value.trim().length > max) return `Keep ${what} to ${max} characters.`;
  return null;
}

export function ContactOperations({ workspace }: { workspace: Workspace }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attempted, setAttempted] = useState(false);
  const send = useApiCommand('post', '/me/support-requests', {
    invalidate: [['api', '/me/cases']],
  });
  const titleError = attempted ? lengthError(title, SUPPORT_TITLE_MAX, 'a short title') : null;
  const descriptionError = attempted
    ? lengthError(description, SUPPORT_DESCRIPTION_MAX, 'what you need')
    : null;

  const submit = () => {
    setAttempted(true);
    if (
      lengthError(title, SUPPORT_TITLE_MAX, 'a short title') ||
      lengthError(description, SUPPORT_DESCRIPTION_MAX, 'what you need')
    ) {
      return;
    }
    void send
      .submit({
        body: {
          category: 'team',
          title: title.trim(),
          description: description.trim(),
          teamEntryId: workspace.entry.id,
        },
      })
      .catch(() => undefined);
  };

  if (send.data) {
    const sent = send.data;
    return (
      <View style={styles.group} testID="support-request-sent" accessibilityLiveRegion="polite">
        <StatusBadge {...supportCaseStatus(sent.status)} />
        <Body>{`Request sent ${formatInstant(sent.createdAt)}: "${sent.title}". The operating team answers through Support.`}</Body>
        <Button
          label="See your support requests"
          variant="secondary"
          onPress={() => router.push('/support')}
        />
      </View>
    );
  }

  return (
    <View style={styles.group} testID="contact-operations">
      <Body muted>
        {`Ask the operating team about ${workspace.team.name}, for example a game, a field or the roster. The request is about the team, so do not include private family details.`}
      </Body>
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        hint="A few words, for example: Field 2 lights out."
      />
      <TextField
        label="What you need"
        value={description}
        onChangeText={setDescription}
        multiline
        error={descriptionError}
      />
      {offline ? <OfflineNotice what="Contacting the operating team" /> : null}
      <Button
        label="Send to the operating team"
        onPress={submit}
        disabled={offline}
        busy={send.isProcessing}
      />
      <Body muted>
        How quickly requests are answered is still being decided (DEC-015), so no response time is
        given.
      </Body>
      {send.error ? (
        <CommandFailure
          error={send.error}
          onRetry={submit}
          unavailableText="Contacting the operating team about this team is not available to you. Use Support for a request about yourself."
        />
      ) : null}
    </View>
  );
}

/** For roster players: a request about themselves is made on Support (SCR-C-38). */
export function ContactThroughSupport() {
  const router = useRouter();
  return (
    <View style={styles.group}>
      <Body>
        Your captain contacts the operating team about the team. For a question about yourself, open
        a request on Support.
      </Body>
      <Button label="Open Support" variant="secondary" onPress={() => router.push('/support')} />
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
