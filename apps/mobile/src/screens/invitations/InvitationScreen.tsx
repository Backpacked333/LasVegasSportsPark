/**
 * SCR-C-17 Invitation acceptance (SPK-IAM-004, SPK-IAM-003, SPK-CAP-001, POL-044 pending).
 *
 * Two kinds of invitation reach this screen from a link (SCR-C-39), with the id in the route and
 * the token held in memory:
 *
 * - family access (guardian, caregiver or pickup delegate): `POST /v1/invitations/{id}/accept`.
 *   The API grants only the requested permissions the sender still holds and reports the rest as
 *   `droppedPermissions`; the success state lists both explicitly.
 * - team: `POST /v1/team-invitations/{id}/accept`, for the person themself or for a child over
 *   whom they hold `register` (from `GET /v1/me` authorities; the API re-checks).
 *
 * The API has no read of an invitation before acceptance, so the sender, scope, requested
 * permissions and expiry cannot be shown before Accept (reported); they are shown after. Declining
 * is not offered by the API either: "Not now" records nothing.
 *
 * States: loading; empty (no invitation to show: open the link); ready; validation failure: not
 * applicable, "cannot accept for this participant" instead; permission restriction (addressed to
 * someone else: not available, no hint it exists); stale version (expired, revoked or already
 * answered, from INVALID_TRANSITION); offline (cannot accept, invitation kept); processing;
 * success (granted scope listed); partial completion: not permitted; recovery required: not
 * applicable, a failed accept shows "Try again" under the same idempotency key.
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { forgetLinkSecret, readLinkSecret } from '../../links/link-secrets';
import { isUuid } from '../../links/link-targets';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import {
  formatDateTime,
  listPermissions,
  ME_QUERY_KEY,
  personDisplayName,
  personNameText,
  usePersonName,
  useMe,
  type MeData,
} from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { Paragraph, RadioGroup, RadioRow, SectionHeader } from '../account/components/forms';

export type InvitationType = 'family' | 'team';

type FamilyAccepted = Schema<'InvitationAccepted'>;
type TeamAccepted = Schema<'TeamInvitationAccepted'>;

/** journeys.md section 3: "Accepted", "Declined" (team only), "Expired", "Revoked". */
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

function noLongerOpen(error: ApiError): string | null {
  if (error.code !== 'INVALID_TRANSITION') return null;
  return invitationStateLabel((error.details as { from?: unknown } | undefined)?.from);
}

function isDeadInvitation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return noLongerOpen(error) !== null || error.isNotFound;
}

/** Route entry: `/invitations/{id}?type=family|team`; the token comes from memory, not the route. */
export function InvitationRoute() {
  const params = useLocalSearchParams<{ id?: string; type?: string }>();
  const type: InvitationType = params.type === 'team' ? 'team' : 'family';
  const id = typeof params.id === 'string' ? params.id : '';
  // Read once: the token is forgotten after a confirmed acceptance, the outcome stays on screen.
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
        {token && isUuid(invitationId) ? (
          type === 'team' ? (
            <TeamInvitation invitationId={invitationId} token={token} />
          ) : (
            <FamilyInvitation invitationId={invitationId} token={token} />
          )
        ) : (
          <StateView
            variant="empty"
            title="No invitation to show"
            description="Open the invitation link you received. Invitations are not listed in the app yet."
          />
        )}
      </RequireSession>
    </Screen>
  );
}

function PreviewUnavailable() {
  return (
    <StateView
      variant="unavailable"
      title="Details shown after you accept"
      description="The app cannot show who sent this invitation, what it covers or when it expires until you accept it. Accepting never gives more than the sender is allowed to give."
    />
  );
}

function NotNow() {
  const router = useRouter();
  return (
    <>
      <Button
        label="Not now"
        variant="secondary"
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        accessibilityHint="Leaves without answering. Nothing is recorded."
      />
      <Paragraph muted inset={false}>
        Declining in the app is not available yet. The invitation stays unanswered until it expires
        or the sender withdraws it.
      </Paragraph>
    </>
  );
}

function OfflineNotice({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return <Paragraph muted>Accepting needs a connection. The invitation is kept.</Paragraph>;
}

const ADDRESSED_ELSEWHERE = {
  title: 'Invitation not available',
  description:
    'Check that you opened the link you received and that you are signed in with the account it was sent to.',
};

function FamilyInvitation({ invitationId, token }: { invitationId: string; token: string }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const accept = useApiCommand('post', '/invitations/{id}/accept', {
    invalidate: [ME_QUERY_KEY],
  });
  const submit = async () => {
    try {
      await accept.submit({ path: { id: invitationId }, body: { token } });
      forgetLinkSecret('invitation', invitationId);
    } catch (error) {
      // accept.error is rendered below; the invitation is kept for "Try again" unless the API says
      // it is closed or unknown, in which case its token is dead and is not offered again.
      if (isDeadInvitation(error)) forgetLinkSecret('invitation', invitationId);
    }
  };

  if (accept.data) return <FamilyAcceptedView result={accept.data} />;
  const stale = accept.error ? noLongerOpen(accept.error) : null;
  return (
    <View style={styles.body}>
      <Paragraph>
        Accepting gives you only the permissions the sender is allowed to give over the people in
        this invitation. Anything else is left out and listed after you accept.
      </Paragraph>
      <PreviewUnavailable />
      <View style={styles.actions}>
        <Button
          label="Accept invitation"
          onPress={() => void submit()}
          busy={accept.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <NotNow />
      </View>
      <OfflineNotice offline={offline} />
      {accept.error && stale ? (
        <StaleInvitation label={stale} />
      ) : accept.error ? (
        <CommandError
          error={accept.error}
          onRetry={() => void submit()}
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
    </View>
  );
}

function StaleInvitation({ label }: { label: string }) {
  return (
    <View style={styles.result}>
      <StatusBadge tone="neutral" label={label} />
      <Paragraph inset={false}>
        This invitation is no longer open, so it cannot be accepted. Ask the sender for a new one if
        you still need it.
      </Paragraph>
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
  for (const relationship of result.relationships) add(relationship.subjectPersonId);
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

function TeamInvitation({ invitationId, token }: { invitationId: string; token: string }) {
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="who can accept"
      empty={{ title: 'No account details', description: '' }}
      unavailableOffline={['accepting the invitation']}
    >
      {(data) => <TeamInvitationForm me={data} invitationId={invitationId} token={token} />}
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

function TeamInvitationForm({
  me,
  invitationId,
  token,
}: {
  me: MeData;
  invitationId: string;
  token: string;
}) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  // The person themself, plus each person the API says they may register (SPK-IAM-003).
  const children = me.authorities.filter((a) => a.permissions.includes('register'));
  const [participant, setParticipant] = useState<string | null>(me.person?.id ?? null);
  const accept = useApiCommand('post', '/team-invitations/{id}/accept', {
    invalidate: [ME_QUERY_KEY],
  });

  if (!me.person) {
    return (
      <StateView
        variant="unavailable"
        title="Finish setting up first"
        description="Link your account to your participant record before accepting a team invitation."
        actionLabel="Go to account setup"
        onAction={() => router.push('/onboarding')}
      />
    );
  }
  const self = me.person.id;
  const choose = (next: string) => {
    setParticipant(next);
    accept.reset();
  };
  const submit = async () => {
    if (!participant) return;
    try {
      await accept.submit({
        path: { id: invitationId },
        body: participant === self ? { token } : { token, personId: participant },
      });
      forgetLinkSecret('team-invitation', invitationId);
    } catch (error) {
      // accept.error is rendered below; the choice is kept. A closed or unknown invitation's token
      // is dead and is not offered again.
      if (isDeadInvitation(error)) forgetLinkSecret('team-invitation', invitationId);
    }
  };

  if (accept.data) return <TeamAcceptedView result={accept.data} />;
  const stale = accept.error ? noLongerOpen(accept.error) : null;
  return (
    <View style={styles.body}>
      <Paragraph>
        Accepting adds the participant you choose to the team roster. Only the person the invitation
        was sent to, or their guardian, can accept it.
      </Paragraph>
      <PreviewUnavailable />
      {children.length > 0 ? (
        <RadioGroup label="Accept for">
          <RadioRow
            label={`You, ${personDisplayName(me.person)}`}
            checked={participant === self}
            disabled={accept.isProcessing}
            onPress={() => choose(self)}
          />
          {children.map((child) => (
            <ParticipantRadio
              key={child.subjectPersonId}
              personId={child.subjectPersonId}
              checked={participant === child.subjectPersonId}
              disabled={accept.isProcessing}
              onPress={() => choose(child.subjectPersonId)}
            />
          ))}
        </RadioGroup>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Accept invitation"
          onPress={() => void submit()}
          busy={accept.isProcessing}
          disabled={offline || !participant}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <NotNow />
      </View>
      <OfflineNotice offline={offline} />
      {accept.error && stale ? (
        <StaleInvitation label={stale} />
      ) : accept.error ? (
        <CommandError
          error={accept.error}
          onRetry={() => void submit()}
          notFound={ADDRESSED_ELSEWHERE}
          denied={{
            title: 'You cannot accept for this participant',
            description: accept.error.message,
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
