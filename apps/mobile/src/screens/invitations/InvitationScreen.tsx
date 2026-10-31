/**
 * SCR-C-17 Invitation acceptance (SPK-IAM-004, SPK-IAM-003, SPK-CAP-001, POL-044 pending).
 *
 * Two kinds of invitation reach this screen, from a link (SCR-C-39: the token is held in memory,
 * never in the route) or from the invitations list (no token):
 *
 * - family access (guardian, caregiver or delegate): read first with `GET /v1/me/invitations/{id}`
 *   (sender, the people it covers, the relationship, each requested permission and the expiry, as
 *   the API states them); accept with `POST /v1/invitations/{id}/accept` and decline with
 *   `POST /v1/invitations/{id}/decline` (the token and the revision read, so a decision made on a
 *   stale view is refused). The API grants only the requested permissions the sender still holds
 *   and reports the rest as `droppedPermissions`; the success state lists both explicitly.
 * - team: read first with `GET /v1/team-invitations/{id}` (team, season, sender, message, expiry);
 *   accept with `POST /v1/team-invitations/{id}/accept`, for the person themself or for a child over
 *   whom they hold `register` (from `GET /v1/me` authorities; the API re-checks); decline with
 *   `POST /v1/team-invitations/{id}/decline` (no token needed, the revision read is sent).
 *
 * Accepting a family or team invitation, and declining a family one, needs the token from the link:
 * opened from the list without it, the invitation is shown and the screen says to open the link.
 * How long an invitation stays open is POL-044 (pending): the screen shows the API's `expiresAt`.
 *
 * States: loading; empty: not applicable here (the list, SCR-C-17 InvitationsScreen, has it);
 * ready (details before deciding); validation failure: not applicable, "cannot accept for this
 * participant" instead; permission restriction (addressed to someone else, or the account not
 * linked or not verified for it: not available, no hint it exists); stale version (expired,
 * revoked or already answered, from the read or from INVALID_TRANSITION, which reads the
 * invitation again and shows the closed state in the badge meanwhile, never "Open until"; an
 * invitation the signed-in person accepted says so and points to Family and permissions;
 * STALE_REVISION on decline offers Reload); offline (cannot accept or decline, invitation kept);
 * processing (nothing can be cancelled while an answer is in flight); success (granted scope
 * listed, or "Declined"); partial completion: not permitted; recovery required: not applicable, a
 * failed accept or decline shows "Try again", which resends the same request under the same
 * idempotency key, until the read shows the invitation closed.
 */
import { ApiError, presentationForError, type Schema } from '@sportspark/api-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { forgetLinkSecret, readLinkSecret } from '../../links/link-secrets';
import { isUuid } from '../../links/link-targets';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import {
  formatDateTime,
  listPermissions,
  ME_QUERY_KEY,
  personDisplayName,
  personNameText,
  usePersonName,
  useMe,
  type GrantPermission,
  type MeData,
} from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import {
  Paragraph,
  RadioGroup,
  RadioRow,
  SectionHeader,
  TextField,
} from '../account/components/forms';

export type InvitationType = 'family' | 'team';

type FamilyView = Schema<'InvitationView'>;
type TeamView = Schema<'TeamInvitationView'>;
type FamilyAccepted = Schema<'InvitationAccepted'>;
type TeamAccepted = Schema<'TeamInvitationAccepted'>;
type InvitationState = FamilyView['effectiveStatus'];

/** Query keys of the invitation reads, refreshed after an answer. */
export const INVITATION_KEYS = {
  familyList: ['api', '/me/invitations'] as const,
  family: ['api', '/me/invitations/{id}'] as const,
  teamList: ['api', '/me/team-invitations'] as const,
  team: ['api', '/team-invitations/{id}'] as const,
};

/** journeys.md section 3: "Accepted", "Declined", "Expired", "Revoked". */
export function invitationStateLabel(state: unknown): string {
  switch (state) {
    case 'accepted':
      return 'Accepted';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
    default:
      return 'No longer open';
  }
}

/** The badge of an invitation in its effective state: open (with its expiry) or closed. */
export function invitationStatus(state: InvitationState, expiresAt: string): StatusBadgeProps {
  if (state === 'pending')
    return { tone: 'info', label: `Open until ${formatDateTime(expiresAt)}` };
  return { tone: 'neutral', label: invitationStateLabel(state) };
}

const RELATIONSHIP_LABELS: Record<FamilyView['relationshipKind'], string> = {
  guardian: 'Guardian',
  caregiver: 'Caregiver',
  delegate: 'Delegate',
};

export function relationshipLabel(kind: FamilyView['relationshipKind']): string {
  return RELATIONSHIP_LABELS[kind];
}

/** The people an invitation covers, by the names the API gives (fixed at issue). */
export function subjectsText(subjects: FamilyView['subjects']): string {
  const names = subjects.map((s) => s.displayName).filter((n) => n.length > 0);
  if (names.length === 0) return 'People not named';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The state an INVALID_TRANSITION answer names (`details.from`: the invitation is closed), or
 * null for any other answer.
 */
function closedStateOf(error: ApiError | null): string | null {
  if (!error || error.code !== 'INVALID_TRANSITION') return null;
  const from = (error.details as { from?: unknown } | undefined)?.from;
  return typeof from === 'string' ? from : 'closed';
}

function isDeadInvitation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return closedStateOf(error) !== null || error.isNotFound;
}

/**
 * The badge at the top: the read's state, unless an answer was refused because the invitation is
 * closed and the read has not caught up yet; then the closed state the API named, never "Open
 * until" next to a closed invitation.
 */
function badgeOf(
  state: InvitationState,
  expiresAt: string,
  refusedAs: string | null,
): StatusBadgeProps {
  if (state === 'pending' && refusedAs !== null) {
    return { tone: 'neutral', label: invitationStateLabel(refusedAs) };
  }
  return invitationStatus(state, expiresAt);
}

/** What a closed invitation means for someone who did not accept it (journeys.md section 3). */
function closedCopy(state: string): string {
  const askAgain = 'Ask the sender for a new one if you still need it.';
  switch (state) {
    case 'accepted':
      return 'This invitation has already been accepted, so it cannot be answered again.';
    case 'declined':
      return `This invitation was declined, so it can no longer be accepted, and nothing was granted from it. ${askAgain}`;
    case 'expired':
      return `This invitation has expired, so it cannot be answered. ${askAgain}`;
    case 'revoked':
      return `The sender withdrew this invitation, so it cannot be answered. ${askAgain}`;
    default:
      return `This invitation is no longer open, so it cannot be answered. ${askAgain}`;
  }
}

/** Route entry: `/invitations/{id}?type=family|team`; the token comes from memory, not the route. */
export function InvitationRoute() {
  const params = useLocalSearchParams<{ id?: string; type?: string }>();
  const type: InvitationType = params.type === 'team' ? 'team' : 'family';
  const id = typeof params.id === 'string' ? params.id : '';
  // Read once: the token is forgotten after a confirmed answer, the outcome stays on screen.
  const [token] = useState(() =>
    isUuid(id) ? readLinkSecret(type === 'team' ? 'team-invitation' : 'invitation', id) : null,
  );
  return <InvitationScreen invitationId={id} type={type} token={token} />;
}

export function InvitationScreen({
  invitationId,
  type,
  token,
}: {
  invitationId: string;
  type: InvitationType;
  token: string | null;
}) {
  return (
    <Screen>
      <SectionHeader title={type === 'team' ? 'Team invitation' : 'Family access invitation'} />
      <RequireSession what="this invitation">
        {isUuid(invitationId) ? (
          <LinkedPerson>
            {(me) =>
              type === 'team' ? (
                <TeamInvitation me={me} invitationId={invitationId} token={token} />
              ) : (
                <FamilyInvitation me={me} invitationId={invitationId} token={token} />
              )
            }
          </LinkedPerson>
        ) : (
          <StateView
            variant="unavailable"
            title="Invitation not available"
            description="This link is incomplete or damaged. Open the invitation link you received again."
          />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Only a person can read or answer an invitation: an unlinked account finishes setup first. */
function LinkedPerson({ children }: { children: (me: MeData) => ReactNode }) {
  const router = useRouter();
  const me = useMe();
  if (me.data === undefined) {
    return (
      <QueryBoundary
        query={me}
        label="your account"
        empty={{ title: 'No account details', description: '' }}
      >
        {() => null}
      </QueryBoundary>
    );
  }
  if (!me.data.person) {
    return (
      <StateView
        variant="unavailable"
        title="Finish setting up first"
        description="Link your account to your participant record before answering an invitation."
        actionLabel="Go to account setup"
        onAction={() => router.push('/onboarding')}
      />
    );
  }
  return <>{children(me.data)}</>;
}

const ADDRESSED_ELSEWHERE = {
  title: 'Invitation not available',
  description:
    'Check that you opened the link you received, that you are signed in with the account it was sent to, and that the email or phone it was sent to is verified on this account.',
};

function NotNow() {
  const router = useRouter();
  return (
    <Button
      label="Not now"
      variant="secondary"
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      accessibilityHint="Leaves without answering. Nothing is recorded."
    />
  );
}

function OfflineNotice({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return (
    <Paragraph muted>Answering an invitation needs a connection. The invitation is kept.</Paragraph>
  );
}

/**
 * A closed invitation (its state is in the badge above): what that means now. One the signed-in
 * person accepted (an earlier answer whose outcome was not known, or one given on another device)
 * says so and points to what it gave them (SPK-IAM-004); they are not told to ask for a new one.
 */
function StaleInvitation({
  state,
  at,
  acceptedByYou = false,
  granted,
}: {
  state: string;
  at?: string | null;
  acceptedByYou?: boolean;
  /** Family access: the permissions the acceptance granted, as the API recorded them. */
  granted?: readonly GrantPermission[];
}) {
  const router = useRouter();
  return (
    <View style={styles.result} testID="invitation-closed">
      {acceptedByYou ? (
        <>
          <Paragraph inset={false}>You accepted this invitation.</Paragraph>
          {granted ? (
            <Paragraph
              inset={false}
            >{`Permissions granted: ${listPermissions(granted)}.`}</Paragraph>
          ) : null}
          <Paragraph inset={false}>
            What you may do for each person is listed under Family and permissions.
          </Paragraph>
          <Button
            label="Open Family and permissions"
            variant="secondary"
            onPress={() => router.push('/family')}
          />
        </>
      ) : (
        <Paragraph inset={false}>{closedCopy(state)}</Paragraph>
      )}
      {at ? (
        <Paragraph muted inset={false}>
          {`${invitationStateLabel(state)} ${formatDateTime(at)}.`}
        </Paragraph>
      ) : null}
    </View>
  );
}

function DeclinedView() {
  return (
    <View style={styles.result} testID="invitation-declined">
      <StatusBadge tone="neutral" label="Declined" />
      <Paragraph inset={false}>
        You declined this invitation. It can no longer be accepted, and nothing was granted.
      </Paragraph>
    </View>
  );
}

/** One fact of an invitation as a readable row ("From, Jordan Lee"). */
function Fact({ title, detail }: { title: string; detail: string }) {
  return <ListRow title={title} detail={detail} />;
}

/**
 * Declining is final, so it is confirmed first; the reason is optional (the API takes one). The
 * request of the intent (with the revision read when it started) is kept: "Try again" resends it
 * unchanged under the same key (§4.9), even if the read has refreshed since. While the decline is
 * in flight it cannot be cancelled: its outcome is not known yet.
 */
function DeclineConfirm({
  busy,
  disabled,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  disabled: boolean;
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <View style={styles.body} testID="decline-confirm">
      <Paragraph>
        Declining is final: this invitation can no longer be accepted. Nothing is granted.
      </Paragraph>
      <TextField
        label="Reason (optional)"
        hint="Kept with the invitation."
        value={reason}
        onChangeText={setReason}
        editable={!busy}
        testID="decline-reason"
      />
      <View style={styles.actions}>
        <Button
          label="Confirm decline"
          onPress={() => onConfirm(reason.trim().length > 0 ? reason.trim() : undefined)}
          busy={busy}
          disabled={disabled}
          accessibilityHint={disabled ? 'Needs a connection' : undefined}
        />
        <Button
          label="Keep invitation"
          variant="secondary"
          onPress={onCancel}
          disabled={busy}
          accessibilityHint={busy ? 'Waiting for the answer to the decline' : undefined}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Family access
// ---------------------------------------------------------------------------------------------
function FamilyInvitation({
  me,
  invitationId,
  token,
}: {
  me: MeData;
  invitationId: string;
  token: string | null;
}) {
  const view = useApiQuery({
    path: '/me/invitations/{id}',
    request: { path: { id: invitationId } },
    staleTime: 0,
  });
  if (view.error && presentationForError(view.error) === 'unavailable') {
    return <StateView variant="unavailable" {...ADDRESSED_ELSEWHERE} />;
  }
  return (
    <QueryBoundary
      query={view}
      label="the invitation"
      empty={{ title: 'No invitation to show', description: '' }}
      unavailableOffline={['accepting or declining the invitation']}
    >
      {(invitation) => (
        <FamilyInvitationBody
          me={me}
          invitation={invitation}
          token={token}
          onReload={() => void view.refetch()}
        />
      )}
    </QueryBoundary>
  );
}

function FamilyFacts({ invitation }: { invitation: FamilyView }) {
  return (
    <View accessibilityRole="list" accessibilityLabel="Invitation details">
      <Fact title="From" detail={invitation.inviter?.displayName || 'The facility'} />
      <Fact title="For" detail={subjectsText(invitation.subjects)} />
      <Fact title="As" detail={relationshipLabel(invitation.relationshipKind)} />
      <Fact
        title="Permissions requested"
        detail={`${listPermissions(invitation.requestedPermissions)}. Each one is separate.`}
      />
      {invitation.recipientContact ? (
        <Fact title="Sent to" detail={invitation.recipientContact.value} />
      ) : null}
    </View>
  );
}

function closedAt(invitation: FamilyView): string | null {
  switch (invitation.effectiveStatus) {
    case 'accepted':
      return invitation.acceptedAt;
    case 'declined':
      return invitation.declinedAt;
    case 'revoked':
      return invitation.revokedAt;
    case 'expired':
      return invitation.expiresAt;
    default:
      return null;
  }
}

type FamilyDecline = { token: string; reason?: string; expectedRevision: number };

function FamilyInvitationBody({
  me,
  invitation,
  token,
  onReload,
}: {
  me: MeData;
  invitation: FamilyView;
  token: string | null;
  onReload: () => void;
}) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [declining, setDeclining] = useState(false);
  const refresh = [
    ME_QUERY_KEY,
    INVITATION_KEYS.familyList,
    INVITATION_KEYS.family,
    ['api', '/me/access-grants'],
  ] as const;
  const accept = useApiCommand('post', '/invitations/{id}/accept', { invalidate: refresh });
  const decline = useApiCommand('post', '/invitations/{id}/decline', { invalidate: refresh });
  // The whole request of the decline intent, revision included, so "Try again" resends it as is.
  const declineRequest = useRef<FamilyDecline | null>(null);
  const id = invitation.id;

  /** A closed or unknown invitation's token is dead; a closed one is read again (stale version). */
  const afterRefusal = (error: unknown) => {
    if (isDeadInvitation(error)) forgetLinkSecret('invitation', id);
    if (error instanceof ApiError && closedStateOf(error) !== null) onReload();
  };

  const submitAccept = async () => {
    if (!token) return;
    try {
      await accept.submit({ path: { id }, body: { token } });
      forgetLinkSecret('invitation', id);
    } catch (error) {
      // accept.error is rendered below; the invitation is kept for "Try again" unless the API says
      // it is closed or unknown.
      afterRefusal(error);
    }
  };

  const sendDecline = async (request: FamilyDecline) => {
    declineRequest.current = request;
    try {
      await decline.submit({ path: { id }, body: request });
      forgetLinkSecret('invitation', id);
    } catch (error) {
      afterRefusal(error);
    }
  };

  if (accept.data) return <FamilyAcceptedView result={accept.data} />;
  if (decline.data) return <DeclinedView />;

  const refusedAs = closedStateOf(accept.error) ?? closedStateOf(decline.error);
  const pending = invitation.effectiveStatus === 'pending';
  const open = pending && refusedAs === null;
  const busy = accept.isProcessing || decline.isProcessing;
  const acceptedByYou =
    invitation.effectiveStatus === 'accepted' &&
    me.person !== null &&
    invitation.acceptedByPersonId === me.person.id;
  return (
    <View style={styles.body}>
      <View style={styles.result}>
        <StatusBadge {...badgeOf(invitation.effectiveStatus, invitation.expiresAt, refusedAs)} />
      </View>
      <FamilyFacts invitation={invitation} />
      {!pending ? (
        <StaleInvitation
          state={invitation.effectiveStatus}
          at={closedAt(invitation)}
          acceptedByYou={acceptedByYou}
          granted={acceptedByYou ? invitation.grantedPermissions : undefined}
        />
      ) : refusedAs !== null ? (
        <StaleInvitation state={refusedAs} />
      ) : null}
      {open ? (
        <>
          <Paragraph>
            Accepting gives you only the permissions the sender is still allowed to give over the
            people in this invitation. Anything else is left out and listed after you accept.
          </Paragraph>
          {token === null ? (
            <>
              <Paragraph>
                To accept or decline, open the invitation link you received. The link shows that the
                invitation was sent to you.
              </Paragraph>
              <View style={styles.actions}>
                <NotNow />
              </View>
            </>
          ) : declining ? (
            <DeclineConfirm
              busy={decline.isProcessing}
              disabled={offline || accept.isProcessing}
              onConfirm={(reason) =>
                void sendDecline({
                  token,
                  expectedRevision: invitation.revision,
                  ...(reason === undefined ? {} : { reason }),
                })
              }
              onCancel={() => {
                setDeclining(false);
                declineRequest.current = null;
                decline.reset();
              }}
            />
          ) : (
            <View style={styles.actions}>
              <Button
                label="Accept invitation"
                onPress={() => void submitAccept()}
                busy={accept.isProcessing}
                disabled={offline || busy}
                accessibilityHint={offline ? 'Needs a connection' : undefined}
              />
              <Button
                label="Decline"
                variant="secondary"
                onPress={() => setDeclining(true)}
                disabled={busy}
                accessibilityHint="Asks you to confirm. Declining cannot be undone."
              />
              <NotNow />
            </View>
          )}
          <OfflineNotice offline={offline && token !== null} />
        </>
      ) : null}
      {/* Once the read shows the invitation closed, a failed answer has nothing left to retry. */}
      {accept.error && pending && closedStateOf(accept.error) === null ? (
        <CommandError
          error={accept.error}
          onRetry={() => void submitAccept()}
          notFound={ADDRESSED_ELSEWHERE}
          denied={
            accept.error.code === 'ACCESS_DENIED'
              ? {
                  title: 'You cannot accept this invitation yet',
                  description: accept.error.message,
                  actionLabel: 'Go to account setup',
                  onAction: () => router.push('/onboarding'),
                }
              : undefined
          }
        />
      ) : null}
      {decline.error && pending && closedStateOf(decline.error) === null ? (
        <CommandError
          error={decline.error}
          onRetry={() => {
            if (declineRequest.current) void sendDecline(declineRequest.current);
          }}
          onReload={() => {
            decline.reset();
            declineRequest.current = null;
            setDeclining(false);
            onReload();
          }}
          notFound={ADDRESSED_ELSEWHERE}
          denied={{
            title: 'You cannot decline this invitation',
            description: decline.error.message,
          }}
        />
      ) : null}
    </View>
  );
}

function GrantedFor({
  personId,
  permissions,
  notGranted,
}: {
  personId: string;
  permissions: FamilyAccepted['grants'][number]['permission'][];
  /** Requested for this person but not granted: the sender no longer holds them for this person. */
  notGranted: FamilyAccepted['grants'][number]['permission'][];
}) {
  const name = personNameText(usePersonName(personId));
  const granted = permissions.length > 0 ? listPermissions(permissions) : 'no permissions';
  const left =
    notGranted.length > 0
      ? `. Not granted for ${name}, because the sender no longer holds them: ${listPermissions(notGranted)}`
      : '';
  return (
    <View accessible accessibilityLabel={`${name}: ${granted}${left}`}>
      <Paragraph inset={false}>
        {name}: {granted}
      </Paragraph>
      {notGranted.length > 0 ? (
        <Paragraph muted inset={false}>
          Not granted for {name}, because the sender no longer holds them:{' '}
          {listPermissions(notGranted)}.
        </Paragraph>
      ) : null}
    </View>
  );
}

type Permission = FamilyAccepted['grants'][number]['permission'];

/**
 * What the acceptance granted, per subject (SPK-IAM-004: the granted scope listed explicitly). The
 * API's `droppedPermissions` is the union over all subjects, so what was left out is worked out for
 * each subject: the requested permissions minus that subject's effective grants.
 */
export function grantsBySubject(
  result: FamilyAccepted,
): { personId: string; granted: Permission[]; notGranted: Permission[] }[] {
  const subjects: string[] = [];
  const add = (id: string) => {
    if (!subjects.includes(id)) subjects.push(id);
  };
  // `Relationship` is published as nullable at the component (reported OpenAPI issue).
  for (const relationship of result.relationships) {
    if (relationship) add(relationship.subjectPersonId);
  }
  for (const grant of result.grants) add(grant.subjectPersonId);
  return subjects.map((personId) => {
    const granted = result.grants
      .filter((g) => g.effective && g.subjectPersonId === personId)
      .map((g) => g.permission);
    const notGranted = result.invitation.requestedPermissions.filter((p) => !granted.includes(p));
    return { personId, granted, notGranted };
  });
}

function FamilyAcceptedView({ result }: { result: FamilyAccepted }) {
  const bySubject = grantsBySubject(result);
  const anyGranted = bySubject.some((s) => s.granted.length > 0);
  return (
    <View style={styles.result} testID="invitation-accepted">
      <StatusBadge tone="success" label="Accepted" />
      <Paragraph inset={false}>What you can do now:</Paragraph>
      {!anyGranted && bySubject.every((s) => s.notGranted.length === 0) ? (
        <Paragraph inset={false}>No permissions were granted.</Paragraph>
      ) : (
        <View accessibilityRole="list">
          {bySubject.map((s) => (
            <GrantedFor
              key={s.personId}
              personId={s.personId}
              permissions={s.granted}
              notGranted={s.notGranted}
            />
          ))}
        </View>
      )}
      {bySubject.length === 0 && result.droppedPermissions.length > 0 ? (
        <Paragraph inset={false}>
          Not granted, because the sender no longer holds them:{' '}
          {listPermissions(result.droppedPermissions)}.
        </Paragraph>
      ) : null}
      <Paragraph muted inset={false}>
        Nothing else was granted.
      </Paragraph>
      {result.invitation.acceptedAt ? (
        <Paragraph muted inset={false}>
          Accepted {formatDateTime(result.invitation.acceptedAt)}.
        </Paragraph>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------
function TeamInvitation({
  me,
  invitationId,
  token,
}: {
  me: MeData;
  invitationId: string;
  token: string | null;
}) {
  const view = useApiQuery({
    path: '/team-invitations/{id}',
    request: { path: { id: invitationId } },
    staleTime: 0,
  });
  if (view.error && presentationForError(view.error) === 'unavailable') {
    return <StateView variant="unavailable" {...ADDRESSED_ELSEWHERE} />;
  }
  return (
    <QueryBoundary
      query={view}
      label="the invitation"
      empty={{ title: 'No invitation to show', description: '' }}
      unavailableOffline={['accepting or declining the invitation']}
    >
      {(invitation) => (
        <TeamInvitationBody
          me={me}
          invitation={invitation}
          token={token}
          onReload={() => void view.refetch()}
        />
      )}
    </QueryBoundary>
  );
}

function ParticipantRadio({
  personId,
  checked,
  disabled,
  onPress,
}: {
  personId: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const name = usePersonName(personId);
  return (
    <RadioRow
      label={personNameText(name)}
      checked={checked}
      disabled={disabled || name.status !== 'ready'}
      onPress={onPress}
    />
  );
}

function TeamFacts({ invitation }: { invitation: TeamView }) {
  return (
    <View accessibilityRole="list" accessibilityLabel="Invitation details">
      <Fact title="Team" detail={invitation.teamName} />
      <Fact title="Season" detail={invitation.seasonName} />
      <Fact title="From" detail={invitation.invitedBy?.displayName || 'The league'} />
      {invitation.message ? <Fact title="Message" detail={invitation.message} /> : null}
    </View>
  );
}

type TeamDecline = { reason?: string; expectedRevision: number };

function TeamInvitationBody({
  me,
  invitation,
  token,
  onReload,
}: {
  me: MeData;
  invitation: TeamView;
  token: string | null;
  onReload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const self = me.person?.id ?? null;
  // The person themself, plus each person the API says they may register (SPK-IAM-003).
  const children = me.authorities.filter((a) => a.permissions.includes('register'));
  const [participant, setParticipant] = useState<string | null>(self);
  const [declining, setDeclining] = useState(false);
  const refresh = [
    ME_QUERY_KEY,
    INVITATION_KEYS.teamList,
    INVITATION_KEYS.team,
    ['api', '/me/team-entries'],
  ] as const;
  const accept = useApiCommand('post', '/team-invitations/{id}/accept', { invalidate: refresh });
  const decline = useApiCommand('post', '/team-invitations/{id}/decline', {
    invalidate: refresh,
  });
  // The whole request of the decline intent, revision included, so "Try again" resends it as is.
  const declineRequest = useRef<TeamDecline | null>(null);
  const id = invitation.id;

  /** A closed or unknown invitation's token is dead; a closed one is read again (stale version). */
  const afterRefusal = (error: unknown) => {
    if (isDeadInvitation(error)) forgetLinkSecret('team-invitation', id);
    if (error instanceof ApiError && closedStateOf(error) !== null) onReload();
  };

  const choose = (next: string) => {
    setParticipant(next);
    accept.reset();
  };
  const submitAccept = async () => {
    if (!participant || !token) return;
    try {
      await accept.submit({
        path: { id },
        body: participant === self ? { token } : { token, personId: participant },
      });
      forgetLinkSecret('team-invitation', id);
    } catch (error) {
      // accept.error is rendered below; the choice is kept.
      afterRefusal(error);
    }
  };
  const sendDecline = async (request: TeamDecline) => {
    declineRequest.current = request;
    try {
      await decline.submit({ path: { id }, body: request });
      forgetLinkSecret('team-invitation', id);
    } catch (error) {
      afterRefusal(error);
    }
  };

  if (accept.data) return <TeamAcceptedView result={accept.data} />;
  if (decline.data) return <DeclinedView />;

  const refusedAs = closedStateOf(accept.error) ?? closedStateOf(decline.error);
  const pending = invitation.effectiveStatus === 'pending';
  const open = pending && refusedAs === null;
  const busy = accept.isProcessing || decline.isProcessing;
  return (
    <View style={styles.body}>
      <View style={styles.result}>
        <StatusBadge {...badgeOf(invitation.effectiveStatus, invitation.expiresAt, refusedAs)} />
      </View>
      <TeamFacts invitation={invitation} />
      {!pending ? (
        <StaleInvitation state={invitation.effectiveStatus} />
      ) : refusedAs !== null ? (
        <StaleInvitation state={refusedAs} />
      ) : null}
      {open ? (
        <>
          <Paragraph>
            Accepting adds the participant you choose to the team roster. Only the person the
            invitation was sent to, or their guardian, can accept it.
          </Paragraph>
          {token !== null && children.length > 0 && self ? (
            <RadioGroup label="Accept for">
              <RadioRow
                label={`You, ${me.person ? personDisplayName(me.person) : ''}`}
                checked={participant === self}
                disabled={busy}
                onPress={() => choose(self)}
              />
              {children.map((child) => (
                <ParticipantRadio
                  key={child.subjectPersonId}
                  personId={child.subjectPersonId}
                  checked={participant === child.subjectPersonId}
                  disabled={busy}
                  onPress={() => choose(child.subjectPersonId)}
                />
              ))}
            </RadioGroup>
          ) : null}
          {token === null ? (
            <Paragraph>
              To accept, open the invitation link you received. You can decline here.
            </Paragraph>
          ) : null}
          {declining ? (
            <DeclineConfirm
              busy={decline.isProcessing}
              disabled={offline || accept.isProcessing}
              onConfirm={(reason) =>
                void sendDecline({
                  expectedRevision: invitation.revision,
                  ...(reason === undefined ? {} : { reason }),
                })
              }
              onCancel={() => {
                setDeclining(false);
                declineRequest.current = null;
                decline.reset();
              }}
            />
          ) : (
            <View style={styles.actions}>
              {token !== null ? (
                <Button
                  label="Accept invitation"
                  onPress={() => void submitAccept()}
                  busy={accept.isProcessing}
                  disabled={offline || busy || !participant}
                  accessibilityHint={offline ? 'Needs a connection' : undefined}
                />
              ) : null}
              <Button
                label="Decline"
                variant="secondary"
                onPress={() => setDeclining(true)}
                disabled={busy}
                accessibilityHint="Asks you to confirm. Declining cannot be undone."
              />
              <NotNow />
            </View>
          )}
          <OfflineNotice offline={offline} />
        </>
      ) : null}
      {/* Once the read shows the invitation closed, a failed answer has nothing left to retry. */}
      {accept.error && pending && closedStateOf(accept.error) === null ? (
        <CommandError
          error={accept.error}
          onRetry={() => void submitAccept()}
          notFound={ADDRESSED_ELSEWHERE}
          denied={{
            title: 'You cannot accept for this participant',
            description: accept.error.message,
          }}
        />
      ) : null}
      {decline.error && pending && closedStateOf(decline.error) === null ? (
        <CommandError
          error={decline.error}
          onRetry={() => {
            if (declineRequest.current) void sendDecline(declineRequest.current);
          }}
          onReload={() => {
            decline.reset();
            declineRequest.current = null;
            setDeclining(false);
            onReload();
          }}
          notFound={ADDRESSED_ELSEWHERE}
          denied={{
            title: 'You cannot decline this invitation',
            description: decline.error.message,
          }}
        />
      ) : null}
    </View>
  );
}

function TeamAcceptedView({ result }: { result: TeamAccepted }) {
  return (
    <View style={styles.result} testID="invitation-accepted">
      <StatusBadge tone="success" label="Accepted" />
      <Paragraph inset={false}>
        {result.membership.displayName} is on the team roster
        {result.membership.status === 'active' ? '' : ` as ${result.membership.status}`}.
      </Paragraph>
      <Paragraph muted inset={false}>
        Nothing else was granted.
      </Paragraph>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingTop: spacing.md },
  actions: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  result: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
});
