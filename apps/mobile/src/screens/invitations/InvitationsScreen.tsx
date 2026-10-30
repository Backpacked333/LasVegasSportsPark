/**
 * SCR-C-17 open invitations (SPK-IAM-004, SPK-CAP-001; the inventory's "empty (no open
 * invitations)"): the family access invitations (`GET /v1/me/invitations?direction=received&
 * status=pending`) and team invitations (`GET /v1/me/team-invitations?status=pending`) addressed to
 * this person or to an email or phone they verified, newest first, each opening its detail
 * (InvitationScreen) to read before answering. Both lists are keyset pages with "Load more".
 *
 * Only invitations still open are listed. The family list filters on the effective status, so
 * one past its expiry is not returned; the team list filters on the stored status (reported), so a
 * pending team invitation past its expiry that the sweep has not recorded yet comes back with
 * `effectiveStatus` `expired`: such rows are left out here, and do not count against "No open
 * invitations". The same rule is applied to both lists. Answering needs the token from the invitation link (except declining a team invitation); the
 * detail says so. Invitations this person sent are on the family screen (SCR-C-31).
 *
 * States: loading; empty ("No open invitations"); ready; validation failure: not applicable;
 * permission restriction (an account not linked to a person has none: finish setup); stale
 * version: not applicable, refreshed on return; offline (cached lists with their age); processing:
 * not applicable; success: not applicable; partial completion: one list can fail while the other
 * shows, each with its own error and "Try again"; recovery required: not applicable.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { listPermissions, useMe } from '../account/components/account-data';
import { Paragraph, SectionHeader } from '../account/components/forms';
import { invitationStatus, relationshipLabel, subjectsText } from './InvitationScreen';

type FamilyView = Schema<'InvitationView'>;
type TeamView = Schema<'TeamInvitationView'>;

const PAGE_SIZE = 20;

/** Still open as the API states it now (`effectiveStatus`), not only as stored. */
function isOpen(invitation: { effectiveStatus: string }): boolean {
  return invitation.effectiveStatus === 'pending';
}

/** In-app route of one invitation; ids only, never a token or a name (§4.14). */
export function invitationRoute(id: string, type: 'family' | 'team'): string {
  return `/invitations/${id}?type=${type}`;
}

export function InvitationsRoute() {
  return <InvitationsScreen />;
}

export function InvitationsScreen() {
  return (
    <Screen>
      <SectionHeader
        title="Invitations"
        detail="Invitations sent to you, or to an email or phone you verified, that are still open."
      />
      <RequireSession what="your invitations">
        <InvitationsContent />
      </RequireSession>
    </Screen>
  );
}

function InvitationsContent() {
  const router = useRouter();
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your account"
      empty={{ title: 'No account details', description: '' }}
    >
      {(data) =>
        data.person ? (
          <OpenInvitations />
        ) : (
          <StateView
            variant="unavailable"
            title="Finish setting up first"
            description="Invitations are shown once your account is linked to your participant record."
            actionLabel="Go to account setup"
            onAction={() => router.push('/onboarding')}
          />
        )
      }
    </QueryBoundary>
  );
}

function OpenInvitations() {
  const router = useRouter();
  const family = useApiPages({
    path: '/me/invitations',
    request: { query: { direction: 'received', status: 'pending', limit: PAGE_SIZE } },
  });
  const team = useApiPages({
    path: '/me/team-invitations',
    request: { query: { status: 'pending', limit: PAGE_SIZE } },
  });
  const openFamily = family.data?.filter(isOpen);
  const openTeam = team.data?.filter(isOpen);
  const bothEmpty = openFamily?.length === 0 && openTeam?.length === 0;
  return (
    <View>
      {bothEmpty ? (
        <StateView
          variant="empty"
          title="No open invitations"
          description="When someone invites you to hold permissions for a family member, or to join a team, it appears here. You can also open the link you received."
        />
      ) : null}
      <View testID="invitations-family">
        <SectionHeader title="Family access" />
        <QueryBoundary
          query={{ ...family, data: openFamily }}
          label="family access invitations"
          isEmpty={(items) => items.length === 0}
          empty={{
            title: 'No family access invitations',
            description: 'Open invitations to hold permissions for someone appear here.',
          }}
        >
          {(items) => (
            <View accessibilityRole="list" accessibilityLabel="Family access invitations">
              {items.map((invitation) => (
                <FamilyRow
                  key={invitation.id}
                  invitation={invitation}
                  onPress={() => router.push(invitationRoute(invitation.id, 'family'))}
                />
              ))}
            </View>
          )}
        </QueryBoundary>
        <LoadMore pages={family} label="family access invitations" />
      </View>
      <View testID="invitations-team">
        <SectionHeader title="Teams" />
        <QueryBoundary
          query={{ ...team, data: openTeam }}
          label="team invitations"
          isEmpty={(items) => items.length === 0}
          empty={{
            title: 'No team invitations',
            description: 'Open invitations to join a team roster appear here.',
          }}
        >
          {(items) => (
            <View accessibilityRole="list" accessibilityLabel="Team invitations">
              {items.map((invitation) => (
                <TeamRow
                  key={invitation.id}
                  invitation={invitation}
                  onPress={() => router.push(invitationRoute(invitation.id, 'team'))}
                />
              ))}
            </View>
          )}
        </QueryBoundary>
        <LoadMore pages={team} label="team invitations" />
      </View>
      <Paragraph muted>
        Answered, expired and withdrawn invitations are not listed. Invitations you sent are under
        Family and permissions.
      </Paragraph>
    </View>
  );
}

function FamilyRow({ invitation, onPress }: { invitation: FamilyView; onPress: () => void }) {
  const from = invitation.inviter?.displayName || 'The facility';
  return (
    <ListRow
      title={`${relationshipLabel(invitation.relationshipKind)} for ${subjectsText(invitation.subjects)}`}
      detail={`From ${from}. ${listPermissions(invitation.requestedPermissions)}`}
      status={invitationStatus(invitation.effectiveStatus, invitation.expiresAt)}
      onPress={onPress}
      accessibilityHint="Opens the invitation"
      testID={`invitation-family-${invitation.id}`}
    />
  );
}

function TeamRow({ invitation, onPress }: { invitation: TeamView; onPress: () => void }) {
  const from = invitation.invitedBy?.displayName || 'The league';
  return (
    <ListRow
      title={invitation.teamName}
      detail={`${invitation.seasonName}. From ${from}`}
      status={invitationStatus(invitation.effectiveStatus, invitation.expiresAt)}
      onPress={onPress}
      accessibilityHint="Opens the invitation"
      testID={`invitation-team-${invitation.id}`}
    />
  );
}
