/**
 * SCR-C-23 hand over the captain or co-captain role (CMP-13; SPK-COMP-005, SPK-CAP-001, §4.9):
 * `POST /v1/team-entries/{id}/roles/handover` with the role, its current holder, the new holder,
 * a reason and the entry's revision (`expectedRevision`). The outgoing and incoming role records
 * end and start at one instant, kept as history. Offered only when the workspace lists
 * `competition.handover_team_role` for this viewer (CMP-02). The new holder must be an active
 * roster member; the API also checks eligibility (ELIGIBILITY_FAILED with reasons) and its other
 * rules (ROLE_NOT_HELD, ROLE_ALREADY_HELD, NOT_ON_ROSTER, and CAPTAIN_MUST_BE_ADULT, a proposed
 * default the API applies), sent as VALIDATION_FAILED with the rule in `details.code`: the API's
 * message is shown with both codes ("Error code: VALIDATION_FAILED (CAPTAIN_MUST_BE_ADULT)", see
 * CommandFailure) and nothing is pre-decided here.
 *
 * States: ready; validation failure (no role, holder or reason chosen; the API's reasons);
 * permission restriction ("not available"); stale version (the entry changed: reload); offline
 * (disabled, choices kept); processing; success ("<name> is captain from <time>"); recovery: a
 * failed handover is retried under the same idempotency key.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { formatInstant } from './format';
import { currentLeaders, MY_TEAMS_KEY, rosterNames, type Viewer, type Workspace } from './queries';
import { isCurrentPlayer } from './status';
import {
  Body,
  ButtonRow,
  CommandFailure,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  TextField,
} from './ui';

type RoleRecord = Schema<'TeamRoleRecord'>;
type HandoverRole = 'captain' | 'co_captain';

export const ROLE_LABELS: Record<HandoverRole, string> = {
  captain: 'Captain',
  co_captain: 'Co-captain',
};

/** Active roster members now who could take `role` from `fromPersonId` (the API re-checks). */
export function handoverCandidates(
  workspace: Workspace,
  role: HandoverRole,
  fromPersonId: string,
  now: Date,
) {
  const leaders = currentLeaders(workspace, now);
  return workspace.roster.filter(
    (m) =>
      m.status === 'active' &&
      isCurrentPlayer(m, now) &&
      new Date(m.effectiveFrom) <= now &&
      m.personId !== fromPersonId &&
      !leaders.some((r) => r.personId === m.personId && (r.role === role || r.role === 'captain')),
  );
}

export function RoleHandover({
  workspace,
  viewer,
  onReload,
  onDone,
}: {
  workspace: Workspace;
  viewer: Viewer;
  /** Reads the workspace again (after STALE_REVISION or INVALID_TRANSITION). */
  onReload: () => void;
  /** After success: refresh the workspace and leave this screen. */
  onDone: () => void;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const names = rosterNames(workspace);
  const leaders = currentLeaders(workspace, now);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [toPersonId, setToPersonId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The workspace is refreshed by "Show the team", so the outcome stays on screen until then.
  const handover = useApiCommand('post', '/team-entries/{id}/roles/handover', {
    invalidate: [MY_TEAMS_KEY, ['api', '/team-entries/{id}/roster']],
  });
  const record: RoleRecord | undefined = leaders.find((r) => r.id === recordId);
  const role = record?.role as HandoverRole | undefined;
  const candidates =
    record && role ? handoverCandidates(workspace, role, record.personId, now) : [];
  const holderName = (personId: string) =>
    personId === viewer.personId ? 'you' : (names.get(personId) ?? 'a team member');
  const toName = toPersonId ? (names.get(toPersonId) ?? 'the new holder') : '';

  const errors = {
    role: attempted && !record ? 'Choose the role to hand over.' : null,
    to: attempted && record && !toPersonId ? 'Choose who takes the role.' : null,
    reason: attempted && !reason.trim() ? 'Give the reason for the handover.' : null,
  };
  const ready = record !== undefined && toPersonId !== null && reason.trim().length > 0;

  const review = () => {
    setAttempted(true);
    if (ready) setConfirming(true);
  };
  const submit = () => {
    if (!record || !role || !toPersonId || !reason.trim()) return;
    void handover
      .submit({
        path: { id: workspace.entry.id },
        body: {
          role,
          fromPersonId: record.personId,
          toPersonId,
          reason: reason.trim(),
          expectedRevision: workspace.entry.revision,
        },
      })
      .catch(() => undefined);
  };

  if (handover.data) {
    const done = handover.data;
    const label = ROLE_LABELS[done.role === 'co_captain' ? 'co_captain' : 'captain'];
    return (
      <View style={styles.group} testID="handover-done" accessibilityLiveRegion="polite">
        <StatusBadge
          tone="success"
          label={`${names.get(done.toPersonId) ?? 'The new holder'} is ${label.toLowerCase()} from ${formatInstant(done.effectiveAt)}`}
        />
        <Body>
          {done.fromPersonId === viewer.personId
            ? `You no longer hold the ${label.toLowerCase()} role. Earlier role records are kept as history.`
            : 'Earlier role records are kept as history.'}
        </Body>
        <Button label="Show the team" onPress={onDone} />
      </View>
    );
  }

  if (leaders.length === 0) {
    return <Body>No one holds the captain or co-captain role now.</Body>;
  }

  return (
    <View style={styles.group} testID="role-handover">
      <Body muted>
        The role passes to an active roster member at once; the change is recorded with your reason
        and the earlier role is kept as history.
      </Body>
      <RadioGroup label="Role to hand over">
        {leaders.map((r) => (
          <RadioRow
            key={r.id}
            label={`${ROLE_LABELS[r.role === 'co_captain' ? 'co_captain' : 'captain']}, held by ${holderName(r.personId)}`}
            checked={recordId === r.id}
            onSelect={() => {
              setRecordId(r.id);
              setToPersonId(null);
              setConfirming(false);
              handover.reset();
            }}
          />
        ))}
      </RadioGroup>
      {errors.role ? <Body>{`▲ ${errors.role}`}</Body> : null}
      {record ? (
        candidates.length === 0 ? (
          <Body>No active roster member can take this role now.</Body>
        ) : (
          <RadioGroup label="New holder">
            {candidates.map((m) => (
              <RadioRow
                key={m.personId}
                label={m.displayName}
                checked={toPersonId === m.personId}
                onSelect={() => {
                  setToPersonId(m.personId);
                  setConfirming(false);
                }}
              />
            ))}
          </RadioGroup>
        )
      ) : null}
      {errors.to ? <Body>{`▲ ${errors.to}`}</Body> : null}
      <TextField
        label="Reason"
        value={reason}
        onChangeText={(text) => {
          setReason(text);
          setConfirming(false);
        }}
        error={errors.reason}
        hint="Recorded with the change, for example: stepping down for the rest of the season."
      />
      {offline ? <OfflineNotice what="Handing over a role" /> : null}
      {confirming && record && role ? (
        <>
          <Body>{`Hand the ${ROLE_LABELS[role].toLowerCase()} role from ${holderName(record.personId)} to ${toName}?`}</Body>
          <ButtonRow>
            <Button
              label={`Hand over to ${toName}`}
              onPress={submit}
              busy={handover.isProcessing}
              disabled={offline}
            />
            <Button
              label="Not now"
              variant="secondary"
              onPress={() => {
                handover.reset();
                setConfirming(false);
              }}
            />
          </ButtonRow>
        </>
      ) : (
        <Button label="Review the handover" variant="secondary" onPress={review} />
      )}
      {handover.error ? (
        <CommandFailure
          error={handover.error}
          onRetry={submit}
          onReload={() => {
            handover.reset();
            setConfirming(false);
            onReload();
          }}
          unavailableText="Handing over this role is not available to you."
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
