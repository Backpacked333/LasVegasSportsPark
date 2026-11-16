/**
 * SCR-C-17 open invitations (SPK-IAM-004, SPK-CAP-001; the inventory's "empty (no open
 * invitations)"): the family access invitations (`GET /v1/me/invitations?direction=received&
 * status=pending`) and team invitations (`GET /v1/me/team-invitations?status=pending`) addressed to
 * this person or to an email or phone they verified, newest first, each opening its detail
 * (InvitationScreen) to read before answering. Both lists are keyset pages with "Load more".
 *
 * Only invitations still open are listed. Both lists filter on the effective status, so one past
 * its expiry is not returned even before the sweep records it (the team list does since the
 * stage-4 API fix); rows whose `effectiveStatus` is not `pending` are still left out here as a
 * guard, and do not count against "No open invitations". The same rule is applied to both lists. Answering needs the token from the invitation link (except declining a team invitation); the
 * detail says so. Invitations this person sent are on the family screen (SCR-C-31).
 *
 * Cards (PA-11, ADR-008): each open invitation is a card (its facts and status, which opens the
 * invitation) with "Accept" and "Decline". Both open the invitation's page, where the answer is
 * given with the link's token and confirmed (Decline opens straight to its confirmation); nothing
 * is answered from the list. Pull to refresh reads both lists again.
 *
 * States: loading; empty ("No open invitations"); ready; validation failure: not applicable;
 * permission restriction (an account not linked to a person has none: finish setup); stale
 * version: not applicable, refreshed on return; offline (cached lists with their age); processing:
 * not applicable; success: not applicable; partial completion: one list can fail while the other
 * shows, each with its own error and "Try again"; recovery required: not applicable.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { layout, spacing } from '../../ui/theme';
import { listPermissions, useMe } from '../account/components/account-data';
import { invitationStatus, relationshipLabel, subjectsText } from './InvitationScreen';

type FamilyView = Schema<'InvitationView'>;
type TeamView = Schema<'TeamInvitationView'>;

const PAGE_SIZE = 20;

/** Still open as the API states it now (`effectiveStatus`), not only as stored. */
function isOpen(invitation: { effectiveStatus: string }): boolean {
  return invitation.effectiveStatus === 'pending';
}

/** In-app route of one invitation; ids only, never a token or a name (§4.14). */
export function invitationRoute(id: string, type: 'family' | 'team', answer?: 'decline'): string {
  return `/invitations/${id}?type=${type}${answer ? `&answer=${answer}` : ''}`;
}

export function InvitationsRoute() {
  return <InvitationsScreen />;
}

export function InvitationsScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Pull to refresh: both lists again.
  const refresh = () => {
    setRefreshing(true);
    void queryClient.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Text variant="body" tone="muted" style={styles.intro}>
        Invitations sent to you, or to an email or phone you verified, that are still open.
      </Text>
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
      <Section title="Family access" variant="plain" testID="invitations-family">
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
            <View
              accessibilityRole="list"
              accessibilityLabel="Family access invitations"
              style={styles.cards}
            >
              {items.map((invitation) => (
                <InvitationCard
                  key={invitation.id}
                  open={(answer) => router.push(invitationRoute(invitation.id, 'family', answer))}
                >
                  <FamilyRow
                    invitation={invitation}
                    onPress={() => router.push(invitationRoute(invitation.id, 'family'))}
                  />
                </InvitationCard>
              ))}
            </View>
          )}
        </QueryBoundary>
        <LoadMore pages={family} label="family access invitations" />
      </Section>
      <Section title="Teams" variant="plain" testID="invitations-team">
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
            <View
              accessibilityRole="list"
              accessibilityLabel="Team invitations"
              style={styles.cards}
            >
              {items.map((invitation) => (
                <InvitationCard
                  key={invitation.id}
                  open={(answer) => router.push(invitationRoute(invitation.id, 'team', answer))}
                >
                  <TeamRow
                    invitation={invitation}
                    onPress={() => router.push(invitationRoute(invitation.id, 'team'))}
                  />
                </InvitationCard>
              ))}
            </View>
          )}
        </QueryBoundary>
        <LoadMore pages={team} label="team invitations" />
      </Section>
      <Text variant="body" tone="muted" style={styles.intro}>
        Answered, expired and withdrawn invitations are not listed. Invitations you sent are under
        Family and permissions.
      </Text>
    </View>
  );
}

/**
 * One open invitation: its row (which opens it), then "Accept" and "Decline", which open it to
 * answer there (Decline at its confirmation). Nothing is sent from the list.
 */
function InvitationCard({
  open,
  children,
}: {
  open: (answer?: 'decline') => void;
  children: ReactNode;
}) {
  return (
    <Card>
      {children}
      <View style={styles.answers}>
        <Button
          label="Accept"
          onPress={() => open()}
          accessibilityHint="Opens the invitation to accept it"
        />
        <Button
          label="Decline"
          variant="secondary"
          onPress={() => open('decline')}
          accessibilityHint="Opens the invitation to confirm declining it"
        />
      </View>
    </Card>
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

const styles = {
  intro: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  cards: { gap: spacing.md },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.sm },
} as const;
