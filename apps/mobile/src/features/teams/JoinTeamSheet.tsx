/**
 * Join a team confirm sheet (redesign handoff 3c; INTERACTIONS 1b row 8; CMP-03, SPK-CAP-001).
 * Opened from Home's To do "Answer" on a team invitation (`GET /v1/me/team-invitations`).
 *
 * - Shows what the invitation states: the team, the season, who invited, their message and when
 *   the invitation ends. The first game, the field, a fee and a calendar clash are drawn in the
 *   design but the invitation read does not carry them, so they are not shown (nothing guessed).
 * - "Join <team>" accepts it as the signed-in recipient (`POST /v1/team-invitations/{id}/accept`,
 *   no link token needed from the recipient's own list) and the caller says "You joined FC Neon.
 *   Added to Calendar." (the team's games are in the calendar from then on).
 * - "Not now" hides the invitation from To do for 7 days on this device (until the app closes in
 *   this build: the snooze is kept in memory, `snoozeInvitation`).
 * - A failed accept stays in the sheet with the shared `CommandError`. Offline, Join is disabled.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useEffect, useState, type RefObject } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { initialsFor } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, radius, spacing } from '../../ui/theme';
import { formatDay } from '../today/time';

type TeamInvitationView = Schema<'TeamInvitationView'>;

/** How long "Not now" hides an invitation (handoff 3c). */
export const NOT_NOW_DAYS = 7;

const snoozed = new Map<string, number>();

/** Invitations hidden with "Not now": id → until (ms). */
export function snoozedInvitations(): ReadonlyMap<string, number> {
  return snoozed;
}

export function snoozeInvitation(id: string, now: Date): void {
  snoozed.set(id, now.getTime() + NOT_NOW_DAYS * 86_400_000);
}

export interface JoinTeamSheetProps {
  open: boolean;
  onClose: () => void;
  invitation: TeamInvitationView | null;
  zone: string;
  onJoined: (invitation: TeamInvitationView) => void;
  onNotNow: (invitation: TeamInvitationView) => void;
  returnFocusTo?: RefObject<unknown>;
}

export function JoinTeamSheet({
  open,
  onClose,
  invitation,
  zone,
  onJoined,
  onNotNow,
  returnFocusTo,
}: JoinTeamSheetProps) {
  const styles = useStyles();
  const offline = useConnectivity().reachable === false;
  const accept = useApiCommand('post', '/team-invitations/{id}/accept', {
    invalidate: [
      ['api', '/me/team-invitations'],
      ['api', '/me/team-entries'],
      ['api', '/me/fixtures'],
    ],
  });
  const [failure, setFailure] = useState<ApiError | null>(null);
  useEffect(() => {
    if (open) setFailure(null);
  }, [open, invitation?.id]);

  const join = async () => {
    if (!invitation) return;
    setFailure(null);
    try {
      await accept.submit({
        path: { id: invitation.id },
        body: { expectedRevision: invitation.revision },
      });
      onJoined(invitation);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  const from = invitation?.invitedBy?.displayName ?? null;
  return (
    <Sheet
      open={open && invitation !== null}
      onClose={onClose}
      title={invitation ? `Join ${invitation.teamName}` : 'Join a team'}
      locked={accept.isProcessing}
      returnFocusTo={returnFocusTo}
      headerContent={<View />}
      testID="join-sheet"
    >
      {invitation ? (
        <View style={styles.body}>
          <View
            style={styles.badge}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={styles.badgeText}>{initialsFor(invitation.teamName)}</Text>
          </View>
          <Text variant="footnote" tone="muted" style={styles.center}>
            {from ? `${from} invited you to` : 'You are invited to'}
          </Text>
          <Text variant="title1" style={styles.center} accessibilityRole="header">
            {invitation.teamName}
          </Text>
          <Text variant="callout" tone="muted" style={styles.center}>
            {invitation.seasonName}
          </Text>
          {invitation.message ? (
            <Text variant="callout" style={styles.center}>{`"${invitation.message}"`}</Text>
          ) : null}
          <View style={styles.facts}>
            <Fact label="Season" value={invitation.seasonName} />
            <Fact label="Answer by" value={formatDay(invitation.expiresAt, zone)} last />
          </View>
          <CommandError
            wording="team"
            error={failure}
            what="joining the team"
            onRetry={() => void join()}
          />
          <Button
            label={`Join ${invitation.teamName}`}
            size="lg"
            block
            busy={accept.isProcessing}
            disabled={offline}
            onPress={() => void join()}
            testID="join-submit"
          />
          {offline ? (
            <Text variant="footnote" tone="muted" style={styles.center}>
              Joining needs a connection.
            </Text>
          ) : null}
          <Button
            label="Not now"
            variant="text"
            block
            onPress={() => onNotNow(invitation)}
            accessibilityHint={`Hides the invitation for ${NOT_NOW_DAYS} days`}
            testID="join-not-now"
          />
        </View>
      ) : null}
    </Sheet>
  );
}

function Fact({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const styles = useStyles();
  return (
    <View
      style={[styles.fact, last ? null : styles.factLine]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text variant="callout" tone="muted">
        {label}
      </Text>
      <Text variant="callout" style={styles.factValue}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  body: { gap: spacing.sm, paddingBottom: spacing.sm, alignItems: 'stretch' },
  center: { textAlign: 'center' },
  badge: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.night,
  },
  badgeText: { ...fonts.extrabold, fontSize: 24, color: colors.floodlight },
  facts: {
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.page,
  },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
    gap: spacing.md,
  },
  factLine: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  factValue: { ...fonts.bold, flexShrink: 1, textAlign: 'right' },
}));
