/**
 * SCR-C-26 Roster change and substitute request (SPK-CAP-004, SPK-COMP-005, SPK-DISC-003,
 * SPK-AT-013, POL-032). The captain adds a former player back as a player, substitute or guest,
 * or removes a current player, with `POST /v1/team-entries/{id}/roster` and the entry's
 * `expectedRevision`. Before adding, `GET /v1/team-entries/{id}/eligibility` explains the API's
 * checks: competition eligibility, effective roster rules and limits, conflicting participation,
 * suspension status, required approvals and capacity. A guest or substitute label bypasses
 * nothing: the API applies the same checks and answers ELIGIBILITY_FAILED with its reasons.
 * Suspensions and eligibility always come from the API, never from the app.
 *
 * Someone new joins through an invitation (SCR-C-23): the captain cannot look people up. When the
 * rule set requires league approval for a guest or substitute (POL-032), the API refuses with
 * `approval_required`; the app shows "League approval required" (not a denial) and that the
 * league manager adds the player: no approval request can be recorded by the API (reported).
 * Effective dates are the server's "now"; removal keeps match history (SPK-COMP-005).
 *
 * States: loading; ready; validation failure (ELIGIBILITY_FAILED with reasons: suspended, roster
 * limit, conflicting participation); permission restriction (ACCESS_DENIED or NOT_FOUND: not
 * available; approval required shown as pending); stale version (the roster changed: reload,
 * the selection kept); offline (disabled); processing; success ("<role> from <date>").
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDay } from '../../features/teams/format';
import { WORKSPACE_KEY, type Workspace } from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import { isCurrentPlayer, rosterMemberStatus } from '../../features/teams/status';
import { CaptainOnly, TeamFrame } from '../../features/teams/TeamFrame';
import {
  Body,
  CommandFailure,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  ReasonList,
  Section,
  TextField,
  Title,
} from '../../features/teams/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

type PlayingStatus = Schema<'RosterPlayingStatus'>;
type RosterMember = Schema<'RosterMember'>;

const ROSTER_KEY = ['api', '/team-entries/{id}/roster'] as const;

export const PLAYING_STATUS_LABELS: Record<PlayingStatus, string> = {
  active: 'Player',
  substitute: 'Substitute',
  guest: 'Guest player',
};

function EligibilityCheck({
  entryId,
  personId,
  status,
}: {
  entryId: string;
  personId: string;
  status: PlayingStatus;
}) {
  const check = useApiQuery({
    path: '/team-entries/{id}/eligibility',
    request: { path: { id: entryId }, query: { personId, status } },
  });
  if (check.data === undefined) {
    if (check.error)
      return (
        <CommandFailure
          error={check.error}
          onRetry={() => void check.refetch()}
          unavailableText="Checking eligibility is not available to you for this team."
        />
      );
    return <StateView variant="loading" label="the eligibility check" />;
  }
  return (
    <View style={styles.group} testID="eligibility-result">
      {check.data.eligible ? (
        <StatusBadge
          tone="success"
          label={`Eligible as ${PLAYING_STATUS_LABELS[status].toLowerCase()} now`}
        />
      ) : (
        <StatusBadge tone="danger" label="Cannot be added now" />
      )}
      {check.data.reasons.length > 0 ? <ReasonList reasons={check.data.reasons} /> : null}
    </View>
  );
}

function AddPlayer({
  workspace,
  candidates,
  onReload,
}: {
  workspace: Workspace;
  candidates: RosterMember[];
  onReload: () => void;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [personId, setPersonId] = useState<string | null>(null);
  const [status, setStatus] = useState<PlayingStatus>('substitute');
  const [checking, setChecking] = useState(false);
  const change = useApiCommand('post', '/team-entries/{id}/roster', {
    invalidate: [WORKSPACE_KEY, ROSTER_KEY],
  });
  const submit = () => {
    if (!personId) return;
    void change
      .submit({
        path: { id: workspace.entry.id },
        body: {
          changes: [{ action: 'add', personId, status }],
          expectedRevision: workspace.entry.revision,
        },
      })
      .catch(() => undefined);
  };
  const added = change.data?.members.find(
    (m) => m.personId === personId && isCurrentPlayer(m, now),
  );
  if (candidates.length === 0) {
    return (
      <Body>
        No former players to add back. To add someone new, invite them from Roster and invitations:
        they join once they accept.
      </Body>
    );
  }
  return (
    <View style={styles.group}>
      <RadioGroup label="Former player">
        {candidates.map((m) => (
          <RadioRow
            key={m.id}
            label={m.displayName}
            detail={rosterMemberStatus(m, now).label}
            checked={personId === m.personId}
            onSelect={() => {
              setPersonId(m.personId);
              setChecking(false);
              change.reset();
            }}
          />
        ))}
      </RadioGroup>
      <RadioGroup label="Add as">
        {(['active', 'substitute', 'guest'] as const).map((s) => (
          <RadioRow
            key={s}
            label={PLAYING_STATUS_LABELS[s]}
            checked={status === s}
            onSelect={() => {
              setStatus(s);
              setChecking(false);
              change.reset();
            }}
          />
        ))}
      </RadioGroup>
      <Body muted>
        A guest or substitute label bypasses nothing: eligibility, roster limits, conflicting games,
        suspensions and required approvals are all checked. The change takes effect now.
      </Body>
      {offline ? <OfflineNotice what="Changing the roster" /> : null}
      <Button
        label="Check eligibility"
        variant="secondary"
        onPress={() => setChecking(true)}
        disabled={!personId || offline}
      />
      {checking && personId ? (
        <EligibilityCheck entryId={workspace.entry.id} personId={personId} status={status} />
      ) : null}
      <Button
        label="Add to the roster"
        onPress={submit}
        disabled={!personId || offline}
        busy={change.isProcessing}
      />
      {added ? (
        <StatusBadge
          tone="success"
          label={`Added: ${rosterMemberStatus(added, now).label}`}
          testID="change-success"
        />
      ) : null}
      {change.error ? (
        <CommandFailure
          error={change.error}
          onRetry={submit}
          onReload={() => {
            change.reset();
            onReload();
          }}
          unavailableText="Changing this roster is not available to you."
        />
      ) : null}
    </View>
  );
}

function RemovePlayer({
  workspace,
  current,
  onReload,
}: {
  workspace: Workspace;
  current: RosterMember[];
  onReload: () => void;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [personId, setPersonId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const change = useApiCommand('post', '/team-entries/{id}/roster', {
    invalidate: [WORKSPACE_KEY, ROSTER_KEY],
  });
  const submit = () => {
    setAttempted(true);
    if (!personId || !reason.trim()) return;
    void change
      .submit({
        path: { id: workspace.entry.id },
        body: {
          changes: [{ action: 'remove', personId, reason: reason.trim() }],
          expectedRevision: workspace.entry.revision,
        },
      })
      .catch(() => undefined);
  };
  const removed = change.data?.members.find((m) => m.personId === personId);
  return (
    <View style={styles.group}>
      <RadioGroup label="Current player">
        {current.map((m) => (
          <RadioRow
            key={m.id}
            label={m.displayName}
            detail={rosterMemberStatus(m, now).label}
            checked={personId === m.personId}
            onSelect={() => setPersonId(m.personId)}
          />
        ))}
      </RadioGroup>
      <TextField
        label="Reason for the removal"
        value={reason}
        onChangeText={setReason}
        multiline
        error={
          attempted && !reason.trim() ? 'Give a reason; it is kept with the roster history.' : null
        }
      />
      <Body muted>
        The removal takes effect now. Games already played keep this player in their history.
      </Body>
      {offline ? <OfflineNotice what="Changing the roster" /> : null}
      <Button
        label="Remove from the roster"
        onPress={submit}
        disabled={!personId || offline}
        busy={change.isProcessing}
      />
      {change.data ? (
        <StatusBadge
          tone="success"
          label={
            removed?.effectiveTo
              ? `Removed from ${formatDay(removed.effectiveTo)}`
              : 'Removed from the roster'
          }
          testID="change-success"
        />
      ) : null}
      {change.error ? (
        <CommandFailure
          error={change.error}
          onRetry={submit}
          onReload={() => {
            change.reset();
            onReload();
          }}
          unavailableText="Changing this roster is not available to you."
        />
      ) : null}
    </View>
  );
}

function RosterChangeContent({ workspace, reload }: { workspace: Workspace; reload: () => void }) {
  const now = useNow();
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const history = useApiQuery({
    path: '/team-entries/{id}/roster',
    request: { path: { id: workspace.entry.id }, query: { includeHistory: 'true' } },
  });
  const members = history.data?.members ?? workspace.roster;
  const current = members.filter((m) => isCurrentPlayer(m, now));
  const currentIds = new Set(current.map((m) => m.personId));
  const seen = new Set<string>();
  const candidates = members.filter((m) => {
    if (m.status !== 'removed' && !(m.effectiveTo && new Date(m.effectiveTo) <= now)) return false;
    if (currentIds.has(m.personId) || seen.has(m.personId)) return false;
    seen.add(m.personId);
    return true;
  });
  return (
    <View>
      <Title>{`${workspace.team.name}: roster change`}</Title>
      <Section title="Change">
        <RadioGroup label="What to change">
          <RadioRow
            label="Add a player or substitute"
            checked={mode === 'add'}
            onSelect={() => setMode('add')}
          />
          <RadioRow
            label="Remove a player"
            checked={mode === 'remove'}
            onSelect={() => setMode('remove')}
          />
        </RadioGroup>
      </Section>
      <Section title={mode === 'add' ? 'Add a player or substitute' : 'Remove a player'}>
        {mode === 'add' ? (
          <AddPlayer workspace={workspace} candidates={candidates} onReload={reload} />
        ) : (
          <RemovePlayer workspace={workspace} current={current} onReload={reload} />
        )}
      </Section>
    </View>
  );
}

export function RosterChangeScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame entryId={entryId} what="this team's roster" unavailableOffline={['roster changes']}>
      {(ws, viewer, reload) =>
        viewer.captainView ? (
          <RosterChangeContent workspace={ws} reload={reload} />
        ) : (
          <CaptainOnly what="Changing the roster" />
        )
      }
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/roster-change.tsx. */
export function RosterChangeRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Roster change' }} />
      <RosterChangeScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
