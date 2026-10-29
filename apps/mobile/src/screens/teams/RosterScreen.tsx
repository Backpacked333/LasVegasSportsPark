/**
 * SCR-C-23 Roster and invitations (SPK-IAM-004, SPK-CAP-001, SPK-CAP-002, SPK-COMP-005, POL-044).
 * For the captain:
 *
 * - Invite players: `POST /v1/team-entries/{id}/invitations`, one per recipient. The API records
 *   the inviting actor, recipient, scope (this entry's roster) and expiry; the expiry is set by
 *   the server under POL-044 (pending) and shown once sent, never invented here. Several
 *   recipients can be invited at once: each is its own intent with its own idempotency key and
 *   its own outcome (partial completion permitted and shown per recipient). No messaging provider
 *   is selected, so each sent invitation is shared from the native share sheet.
 * - Revoke an open invitation: `POST /v1/team-invitations/{id}/revoke`.
 * - Review permitted join requests: `POST /v1/join-requests/{id}/decide` with the request's
 *   revision; approval is re-checked for eligibility by the API.
 * - Roster membership with effective dates, including history and pending rows
 *   (`GET /v1/team-entries/{id}/roster?includeHistory=true`, SPK-COMP-005), with eligibility as
 *   reason codes only (SPK-CAP-002).
 * - Hand over the captain or co-captain role to an active roster member
 *   (`POST /v1/team-entries/{id}/roles/handover`, CMP-13; features/teams/RoleHandover.tsx).
 *
 * Each tool is offered only when the workspace lists its action for this viewer
 * (`viewer.availableActions`, CMP-02); the API authorizes every command again.
 *
 * States: loading; empty (no roster members yet); ready; validation failure (recipient contact
 * invalid; roster limit reached per the rule set); permission restriction (the API's NOT_FOUND or
 * ACCESS_DENIED: not available); stale version (an invitation already accepted or revoked: reload);
 * offline (invite disabled, the draft kept); processing (sending); success ("Open until <date>");
 * partial completion per recipient; recovery: a failed send is retried under the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDay } from '../../features/teams/format';
import { InvitationIssued } from '../../features/teams/InvitationIssued';
import {
  rosterNames,
  TEAM_ACTIONS,
  WORKSPACE_KEY,
  type Viewer,
  type Workspace,
} from '../../features/teams/queries';
import { RoleHandover } from '../../features/teams/RoleHandover';
import { idParam, teamRoutes } from '../../features/teams/routes';
import {
  eligibilityIndicatorStatus,
  invitationStatus,
  isCurrentPlayer,
  rosterMemberStatus,
} from '../../features/teams/status';
import { CaptainOnly, TeamFrame } from '../../features/teams/TeamFrame';
import {
  Body,
  ButtonRow,
  CommandFailure,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  Section,
  TextField,
  Title,
} from '../../features/teams/ui';
import { useKeyedCommands } from '../../features/teams/useKeyedCommands';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

type RosterMember = Schema<'RosterMember'>;
type TeamInvitation = Schema<'TeamInvitation'>;
type JoinRequest = Schema<'JoinRequest'>;

const ROSTER_KEY = ['api', '/team-entries/{id}/roster'] as const;
export const REVOKE_REASON = 'Revoked by the captain in the app';

interface Recipient {
  key: string;
  kind: 'email' | 'phone';
  value: string;
}

function recipientError(recipient: Recipient): string | null {
  const value = recipient.value.trim();
  if (value.length === 0) return 'Enter an email address or phone number.';
  if (recipient.kind === 'email' && !/^[^@\s]+@[^@\s]+$/.test(value)) {
    return 'Enter an email address like name@example.com.';
  }
  if (recipient.kind === 'phone' && value.replace(/\D/g, '').length < 7) {
    return 'Enter a phone number with at least 7 digits.';
  }
  return null;
}

function InviteForm({ workspace }: { workspace: Workspace }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const counter = useRef(1);
  const [recipients, setRecipients] = useState<Recipient[]>([
    { key: 'r1', kind: 'email', value: '' },
  ]);
  const [message, setMessage] = useState('');
  const [attempted, setAttempted] = useState(false);
  const invite = useKeyedCommands('post', '/team-entries/{id}/invitations', {
    invalidate: [WORKSPACE_KEY, ROSTER_KEY],
  });

  const update = (key: string, patch: Partial<Recipient>) =>
    setRecipients((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const sendOne = (recipient: Recipient) =>
    invite.submit(recipient.key, {
      path: { id: workspace.entry.id },
      body: {
        recipientContact: { kind: recipient.kind, value: recipient.value.trim() },
        ...(message.trim() ? { message: message.trim() } : {}),
      },
    });
  const sendAll = async () => {
    setAttempted(true);
    for (const recipient of recipients) {
      const state = invite.states[recipient.key];
      if (state?.status === 'succeeded' || state?.status === 'processing') continue;
      if (recipientError(recipient)) continue;
      // One request at a time, in order: each recipient is its own intent and outcome.
      await sendOne(recipient);
    }
  };
  const sending = Object.values(invite.states).some((s) => s.status === 'processing');
  const pendingCount = recipients.filter(
    (r) => invite.states[r.key]?.status !== 'succeeded',
  ).length;

  return (
    <Section title="Invite players" testID="invite-form">
      <Body muted>
        {`An invitation asks one person to join the ${workspace.team.name} roster for ${workspace.season.name}. It records you as the inviter, grants nothing until it is accepted, and expires on the date the service sets under the league's invitation policy (POL-044, still being decided).`}
      </Body>
      {recipients.map((recipient, index) => {
        const state = invite.states[recipient.key];
        const label = `Recipient ${index + 1}`;
        if (state?.status === 'succeeded') {
          return (
            <InvitationIssued
              key={recipient.key}
              invitation={state.data}
              recipient={recipient.value.trim()}
              teamName={workspace.team.name}
            />
          );
        }
        const localError = attempted ? recipientError(recipient) : null;
        return (
          <View key={recipient.key} style={styles.recipient} testID={`recipient-${index + 1}`}>
            <RadioGroup label={`${label}: contact by`}>
              <RadioRow
                label="Email"
                checked={recipient.kind === 'email'}
                onSelect={() => update(recipient.key, { kind: 'email' })}
              />
              <RadioRow
                label="Phone"
                checked={recipient.kind === 'phone'}
                onSelect={() => update(recipient.key, { kind: 'phone' })}
              />
            </RadioGroup>
            <TextField
              label={`${label}: ${recipient.kind === 'email' ? 'email address' : 'phone number'}`}
              value={recipient.value}
              onChangeText={(value) => update(recipient.key, { value })}
              keyboardType={recipient.kind === 'email' ? 'email-address' : 'phone-pad'}
              autoCapitalize="none"
              error={localError}
            />
            {state?.status === 'processing' ? <Body muted>Sending…</Body> : null}
            {state?.status === 'failed' ? (
              <CommandFailure
                error={state.error}
                onRetry={() => void sendOne(recipient)}
                unavailableText="Inviting players is not available to you for this team."
                testID={`recipient-${index + 1}-failure`}
              />
            ) : null}
            {recipients.length > 1 && state?.status !== 'processing' ? (
              <Button
                label={`Remove ${label.toLowerCase()}`}
                variant="secondary"
                onPress={() => {
                  invite.forget(recipient.key);
                  setRecipients((list) => list.filter((r) => r.key !== recipient.key));
                }}
              />
            ) : null}
          </View>
        );
      })}
      <TextField
        label="Message (optional)"
        value={message}
        onChangeText={setMessage}
        multiline
        hint="Sent with every invitation in this batch."
      />
      {offline ? <OfflineNotice what="Inviting players" /> : null}
      <ButtonRow>
        <Button
          label="Add another recipient"
          variant="secondary"
          onPress={() => {
            counter.current += 1;
            setRecipients((list) => [
              ...list,
              { key: `r${counter.current}`, kind: 'email', value: '' },
            ]);
          }}
        />
        <Button
          label={pendingCount > 1 ? `Send ${pendingCount} invitations` : 'Send invitation'}
          onPress={() => void sendAll()}
          disabled={offline || pendingCount === 0}
          busy={sending}
        />
      </ButtonRow>
    </Section>
  );
}

function recipientOf(invitation: TeamInvitation, names: Map<string, string>): string {
  if (invitation.recipientContact) return invitation.recipientContact.value;
  if (invitation.recipientPersonId) {
    return names.get(invitation.recipientPersonId) ?? 'Invited player';
  }
  return 'Invited player';
}

function PendingInvitation({
  invitation,
  recipient,
  canRevoke,
  onReload,
}: {
  invitation: TeamInvitation;
  recipient: string;
  /** `competition.revoke_team_invitation` is listed for this viewer (CMP-02). */
  canRevoke: boolean;
  onReload: () => void;
}) {
  const { reachable } = useConnectivity();
  const [confirming, setConfirming] = useState(false);
  const revoke = useApiCommand('post', '/team-invitations/{id}/revoke', {
    invalidate: [WORKSPACE_KEY, ROSTER_KEY],
  });
  const submit = () =>
    void revoke
      .submit({ path: { id: invitation.id }, body: { reason: REVOKE_REASON } })
      .catch(() => undefined);
  if (revoke.data) {
    return <ListRow title={recipient} status={invitationStatus(revoke.data)} />;
  }
  return (
    <View style={styles.item} testID={`invitation-${invitation.id}`}>
      <ListRow
        title={recipient}
        detail={invitation.message ?? undefined}
        status={invitationStatus(invitation)}
      />
      {!canRevoke ? null : confirming ? (
        <>
          <Body>{`Revoke the invitation for ${recipient}? Its link stops working.`}</Body>
          <ButtonRow>
            <Button
              label="Revoke invitation"
              onPress={submit}
              busy={revoke.isProcessing}
              disabled={reachable === false}
            />
            <Button
              label="Keep invitation"
              variant="secondary"
              onPress={() => {
                revoke.reset();
                setConfirming(false);
              }}
            />
          </ButtonRow>
        </>
      ) : (
        <Button
          label={`Revoke the invitation for ${recipient}`}
          variant="secondary"
          onPress={() => setConfirming(true)}
          disabled={reachable === false}
        />
      )}
      {revoke.error ? (
        <CommandFailure
          error={revoke.error}
          onRetry={submit}
          onReload={() => {
            revoke.reset();
            setConfirming(false);
            onReload();
          }}
          unavailableText="Revoking this invitation is not available to you."
        />
      ) : null}
    </View>
  );
}

function JoinRequestItem({
  request,
  name,
  canDecide,
}: {
  request: JoinRequest;
  name: string;
  /** `competition.decide_join_request` is listed for this viewer (CMP-02). */
  canDecide: boolean;
}) {
  const { reachable } = useConnectivity();
  const decide = useApiCommand('post', '/join-requests/{id}/decide', {
    invalidate: [WORKSPACE_KEY, ROSTER_KEY],
  });
  const [lastDecision, setLastDecision] = useState<'approve' | 'decline' | null>(null);
  const submit = (decision: 'approve' | 'decline') => {
    setLastDecision(decision);
    void decide
      .submit({
        path: { id: request.id },
        body: { decision, expectedRevision: request.revision },
      })
      .catch(() => undefined);
  };
  if (decide.data) {
    const approved = decide.data.request.status === 'approved';
    return (
      <ListRow
        title={name}
        status={
          approved && decide.data.membership
            ? {
                tone: 'success',
                label: `Approved: on the roster from ${formatDay(decide.data.membership.effectiveFrom)}`,
              }
            : { tone: 'neutral', label: approved ? 'Approved' : 'Declined' }
        }
      />
    );
  }
  return (
    <View style={styles.item} testID={`join-request-${request.id}`}>
      <ListRow
        title={name}
        detail={request.message ?? undefined}
        status={{ tone: 'info', label: 'Requested to join' }}
      />
      {canDecide ? (
        <ButtonRow>
          <Button
            label={`Approve ${name}`}
            onPress={() => submit('approve')}
            busy={decide.isProcessing && lastDecision === 'approve'}
            disabled={reachable === false || decide.isProcessing}
          />
          <Button
            label={`Decline ${name}`}
            variant="secondary"
            onPress={() => submit('decline')}
            busy={decide.isProcessing && lastDecision === 'decline'}
            disabled={reachable === false || decide.isProcessing}
          />
        </ButtonRow>
      ) : null}
      {decide.error ? (
        <CommandFailure
          error={decide.error}
          onRetry={() => lastDecision && submit(lastDecision)}
          unavailableText="Deciding this request is not available to you."
        />
      ) : null}
    </View>
  );
}

function memberDetail(member: RosterMember): string | undefined {
  const parts: string[] = [];
  if (member.jerseyNumber !== null) parts.push(`Jersey ${member.jerseyNumber}`);
  const eligibility = eligibilityIndicatorStatus(member.eligibility);
  if (eligibility && member.status !== 'removed') parts.push(eligibility.label);
  if (member.removalReason) parts.push(`Reason: ${member.removalReason}`);
  return parts.length > 0 ? parts.join('. ') : undefined;
}

export function RosterList({ members, now }: { members: RosterMember[]; now: Date }) {
  const current = members.filter((m) => isCurrentPlayer(m, now));
  const waiting = members.filter((m) => m.status === 'invited' || m.status === 'requested');
  const history = members.filter((m) => !current.includes(m) && !waiting.includes(m));
  const group = (title: string, list: RosterMember[], testID: string) =>
    list.length === 0 ? null : (
      <View accessibilityRole="list" testID={testID}>
        <Body muted>{title}</Body>
        {list.map((m) => (
          <ListRow
            key={m.id}
            title={m.displayName}
            detail={memberDetail(m)}
            status={rosterMemberStatus(m, now)}
          />
        ))}
      </View>
    );
  if (members.length === 0) {
    return <Body>No roster members yet. Invite players above.</Body>;
  }
  return (
    <View style={styles.groups}>
      {group('On the roster now', current, 'roster-current')}
      {group('Waiting for an answer', waiting, 'roster-waiting')}
      {group('Earlier roster (kept for match history)', history, 'roster-history')}
    </View>
  );
}

function RosterContent({
  workspace,
  viewer,
  refetch,
}: {
  workspace: Workspace;
  viewer: Viewer;
  refetch: () => void;
}) {
  const now = useNow();
  const router = useRouter();
  const queryClient = useQueryClient();
  const roster = useApiQuery({
    path: '/team-entries/{id}/roster',
    request: { path: { id: workspace.entry.id }, query: { includeHistory: 'true' } },
  });
  const names = rosterNames(workspace);
  const r = workspace.readiness;
  return (
    <View>
      <Title>{`${workspace.team.name}: roster`}</Title>
      {viewer.can(TEAM_ACTIONS.invite) ? (
        <InviteForm workspace={workspace} />
      ) : (
        <Section title="Invite players">
          <Body>Inviting players is not available for this team now.</Body>
        </Section>
      )}
      <Section title="Open invitations">
        {(workspace.pendingInvitations ?? []).length === 0 ? (
          <Body>No open invitations.</Body>
        ) : (
          (workspace.pendingInvitations ?? []).map((invitation) => (
            <PendingInvitation
              key={invitation.id}
              invitation={invitation}
              recipient={recipientOf(invitation, names)}
              canRevoke={viewer.can(TEAM_ACTIONS.revokeInvitation)}
              onReload={refetch}
            />
          ))
        )}
      </Section>
      <Section title="Join requests">
        {(workspace.pendingJoinRequests ?? []).length === 0 ? (
          <Body>No join requests waiting.</Body>
        ) : (
          (workspace.pendingJoinRequests ?? []).map((request) => (
            <JoinRequestItem
              key={request.id}
              request={request}
              name={names.get(request.personId) ?? 'A player'}
              canDecide={viewer.can(TEAM_ACTIONS.decideJoinRequest)}
            />
          ))
        )}
      </Section>
      {viewer.can(TEAM_ACTIONS.handoverRole) ? (
        <Section title="Captain and co-captain" testID="leaders">
          <RoleHandover
            workspace={workspace}
            viewer={viewer}
            onReload={refetch}
            onDone={() => {
              void queryClient.invalidateQueries({ queryKey: WORKSPACE_KEY });
              router.replace(teamRoutes.workspace(workspace.entry.id));
            }}
          />
        </Section>
      ) : null}
      <Section title="Roster" testID="roster">
        <StatusBadge
          tone={r.rosterComplete ? 'success' : 'warning'}
          label={`${r.rosterComplete ? 'Roster complete' : 'Roster not complete'}: ${r.rosterCount} on the roster (minimum ${r.rosterMin}, maximum ${r.rosterMax})`}
        />
        <QueryBoundary
          query={roster}
          label="the roster"
          empty={{ title: 'No roster', description: 'No roster members yet.' }}
          unavailableOffline={['invitations', 'join request decisions']}
        >
          {(data) => <RosterList members={data.members} now={now} />}
        </QueryBoundary>
      </Section>
    </View>
  );
}

export function RosterScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame
      entryId={entryId}
      what="this team's roster"
      unavailableOffline={['invitations', 'join request decisions']}
    >
      {(ws, viewer, reload) =>
        viewer.captainView ? (
          <RosterContent workspace={ws} viewer={viewer} refetch={reload} />
        ) : (
          <CaptainOnly what="Managing the roster" />
        )
      }
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/roster.tsx. */
export function RosterRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Roster and invitations' }} />
      <RosterScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  recipient: { gap: spacing.sm, paddingVertical: spacing.sm },
  item: { gap: spacing.xs, paddingVertical: spacing.xs },
  groups: { gap: spacing.md },
});
