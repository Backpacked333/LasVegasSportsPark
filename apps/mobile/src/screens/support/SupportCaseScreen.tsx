/**
 * SCR-C-38 one support request (SPK-SUPPORT-002, SUP-01): `GET /v1/me/cases/{id}` shows the
 * request's category, title, who it is about ("For", SUP-07: "You" or a given name from
 * `GET /v1/person-names`), status in words, when it was sent, last updated and resolved. The API
 * shows a customer nothing else (no notes, owner, queue or history, §4.14). Someone else's
 * request, or an id that names nothing, is NOT_FOUND and shown as "not available" with no hint
 * that it exists (§4.10). The record re-reads on return to the app, so a status staff changed
 * meanwhile shows with its age (stale version, §4.15).
 *
 * Replying (SUP-06): while the request is not resolved, "Reply to the team" sends
 * `POST /v1/me/cases/{id}/replies`; a request "Waiting for you" goes back to the team. The
 * person's own replies are listed from `GET /v1/me/cases/{id}/replies` (never staff notes). One
 * idempotency key per reply (§4.9): "Check again" resends the same text under the same key. A
 * request resolved meanwhile is refused (INVALID_TRANSITION) and "Reload" reads it again. The
 * draft is kept on every failure and offline (sending needs a connection, §4.15).
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { Body, Caption, Field, Section, TextField } from '../../features/money/ui';
import { nameOf, useMe, usePersonNames, useSignedIn } from '../../features/today/queries';
import { displayZone, formatWhen } from '../../features/today/time';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { CommandError, type NotAvailableCopy } from '../account/components/CommandError';
import {
  CATEGORY_LABELS,
  caseStatus,
  caseStatusMeaning,
  isUuid,
  type CustomerCase,
} from './support-model';

const REPLY_NOT_FOUND: NotAvailableCopy = {
  title: 'Not available',
  description: 'This request is not available to you any more. Your requests are under Support.',
};

/** Statuses a reply is taken in (SUP-06): a resolved or closed request is reopened by staff. */
const REPLYABLE: readonly CustomerCase['status'][] = [
  'open',
  'waiting_customer',
  'waiting_internal',
];

/**
 * SUP-06: the person's own replies and the reply form, while the request is not resolved. A reply
 * to a request "Waiting for you" returns it to the team; the status shown is the API's answer.
 */
function CaseReplies({ request, onReload }: { request: CustomerCase; onReload: () => void }) {
  const zone = displayZone(null);
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<CustomerCase | null>(null);
  const replies = useApiQuery({
    path: '/me/cases/{id}/replies',
    request: { path: { id: request.id } },
    enabled: useSignedIn(),
  });
  const send = useApiCommand('post', '/me/cases/{id}/replies', {
    invalidate: [
      ['api', '/me/cases'],
      ['api', '/me/cases/{id}'],
      ['api', '/me/cases/{id}/replies'],
    ],
  });
  const canReply = REPLYABLE.includes(request.status);
  // The reply last sent: "Check again" resends exactly it, under the same idempotency key, even if
  // the draft was edited after a send without an answer (edited text would be a second reply).
  const lastSent = useRef<string | null>(null);
  const sendReply = (body: string) => {
    lastSent.current = body;
    void send
      .submit({ path: { id: request.id }, body: { body } })
      .then((updated) => {
        setSent(updated);
        // The draft is cleared only if it is still the text that was sent.
        setDraft((d) => (d.trim() === body ? '' : d));
      })
      .catch(() => undefined); // shown from send.error; the draft stays
  };
  const submit = () => {
    const body = draft.trim();
    if (!body) {
      setError('Write your reply.');
      return;
    }
    setError(null);
    sendReply(body);
  };
  const sendAgain = () => {
    if (lastSent.current) sendReply(lastSent.current);
  };
  const own = replies.data ?? [];
  return (
    <Section title="Your replies" testID="support-replies">
      {replies.data === undefined ? (
        replies.error ? (
          <View style={styles.reply} testID="support-replies-failed">
            <Caption>Your replies could not be read. The request itself is shown above.</Caption>
            <Button label="Try again" variant="secondary" onPress={() => void replies.refetch()} />
          </View>
        ) : (
          <Caption>Reading your replies…</Caption>
        )
      ) : own.length === 0 ? (
        <Caption>You have not replied on this request.</Caption>
      ) : (
        own.map((r) => (
          <View key={r.id} style={styles.reply} testID="support-reply">
            <Caption>Sent {formatWhen(r.sentAt, zone.zone)}</Caption>
            <Body>{r.body}</Body>
          </View>
        ))
      )}
      {sent ? (
        <LiveRegion
          announcement={sentences('Reply sent', caseStatusMeaning(sent.status))}
          testID="support-reply-sent"
        >
          <StatusBadge tone="success" label="Reply sent" />
          <Body>{caseStatusMeaning(sent.status)}</Body>
        </LiveRegion>
      ) : null}
      {canReply ? (
        <>
          <TextField
            label="Reply to the team"
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              setSent(null);
            }}
            error={error}
            hint="Answer what the team asked, or add anything that helps."
            multiline
            testID="support-reply-text"
          />
          <Button
            label="Send reply"
            busy={send.isProcessing}
            disabled={offline}
            onPress={submit}
            testID="support-reply-send"
          />
          {offline ? (
            <Caption>Sending needs a connection. Your reply stays on this screen.</Caption>
          ) : null}
        </>
      ) : (
        <Caption>
          This request is resolved and takes no more replies. If you still need help, send a new
          request from Support.
        </Caption>
      )}
      {send.error ? (
        <CommandError
          error={send.error}
          onRetry={sendAgain}
          onReload={onReload}
          notFound={REPLY_NOT_FOUND}
        />
      ) : null}
    </Section>
  );
}

function CaseContent({ caseId }: { caseId: string }) {
  const router = useRouter();
  const zone = displayZone(null);
  const read = useApiQuery({
    path: '/me/cases/{id}',
    request: { path: { id: caseId } },
    enabled: useSignedIn(),
    refetchOnWindowFocus: 'always',
  });
  const me = useMe();
  const subject = read.data?.subjectPersonId ?? null;
  const names = usePersonNames(subject ? [subject] : [], me.data);
  return (
    <QueryBoundary query={read} label="your request" empty={{ title: '', description: '' }}>
      {(c) => (
        <View testID="support-case">
          <Section title={c.title}>
            <StatusBadge {...caseStatus(c.status)} testID="support-case-status" />
            <Body>{caseStatusMeaning(c.status)}</Body>
            <Field label="About" value={CATEGORY_LABELS[c.category]} />
            {c.subjectPersonId ? (
              <Field label="For" value={nameOf(names, c.subjectPersonId)} />
            ) : null}
            <Field label="Sent" value={formatWhen(c.createdAt, zone.zone)} />
            <Field label="Last updated" value={formatWhen(c.updatedAt, zone.zone)} />
            {c.resolvedAt ? (
              <Field label="Resolved" value={formatWhen(c.resolvedAt, zone.zone)} />
            ) : null}
            <Caption>
              Notes and internal details stay with the facility team. A request never replaces a
              change itself: refunds, transfers and permission changes are made as their own
              actions.
            </Caption>
          </Section>
          <CaseReplies request={c} onReload={() => void read.refetch()} />
          <View style={styles.pad}>
            <Button
              label="Back to support"
              variant="secondary"
              onPress={() => router.push('/support' as Href)}
            />
          </View>
        </View>
      )}
    </QueryBoundary>
  );
}

export function SupportCaseScreen({ caseId }: { caseId: string | null }) {
  return (
    <Screen>
      <RequireSession what="your support request">
        {caseId ? (
          <CaseContent caseId={caseId} />
        ) : (
          <StateView
            variant="unavailable"
            title="Link not available"
            description="This link does not open a request. Your requests are listed under Support."
          />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/support/[caseId].tsx (an opaque id only). */
export function SupportCaseRoute() {
  const { caseId } = useLocalSearchParams<{ caseId?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Support request' }} />
      <SupportCaseScreen caseId={isUuid(caseId) ? caseId : null} />
    </>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg },
  reply: { gap: spacing.xs },
});
