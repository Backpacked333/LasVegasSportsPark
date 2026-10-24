/**
 * SCR-C-29 Dispute submission (SPK-RESULT-005, POL-029, DEC-010). The captain of a competing entry
 * files a dispute on a game with `POST /v1/fixtures/{id}/disputes`: the entry it is filed for, the
 * official result revision it disputes, a reason and evidence references. The submission window is
 * the rule set's protest deadline (`GET /v1/rule-sets/{id}`, `protestDeadlineHours`), counted
 * from the official result's publication; the API checks it on submission and the app shows the
 * window it read, never one of its own. The reviewer, decision, publication consequence and appeal
 * status are the API's (shown here and on the game's results). How appeals and the discipline
 * procedure work is DEC-010 (League manager/operator, pending).
 *
 * States: loading; empty (no disputes yet for this game); ready; validation failure (outside the
 * window: "The dispute window closed <time>"; a missing reason); permission restriction (role not
 * eligible: not available); stale version (the result was corrected meanwhile: reload); offline
 * (draft kept, submit disabled); processing; success ("Disputed: under review"); the draft is kept
 * on any failure.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, plural } from '../../features/teams/format';
import type { Viewer, Workspace } from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import { PUBLICATION_CONSEQUENCE_LABELS, disputeStatus } from '../../features/teams/status';
import { CaptainOnly, TeamFrame } from '../../features/teams/TeamFrame';
import {
  Body,
  ButtonRow,
  CommandFailure,
  Detail,
  OfflineNotice,
  Section,
  TextField,
  Title,
} from '../../features/teams/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { orderRevisions } from './FixtureResultsScreen';

type Dispute = Schema<'Dispute'>;
type ResultRevision = Schema<'ResultRevision'>;

interface EvidenceDraft {
  key: string;
  kind: string;
  reference: string;
  description: string;
}

/** The API's `protest_window_closed` validation detail, when that is why it refused. */
export function windowClosedAt(error: ApiError): string | null {
  const details = error.details as { code?: unknown; submissionDeadlineAt?: unknown } | undefined;
  if (error.code !== 'VALIDATION_FAILED' || details?.code !== 'protest_window_closed') return null;
  return typeof details.submissionDeadlineAt === 'string' ? details.submissionDeadlineAt : '';
}

function WindowNotice({
  ruleSetId,
  ruleSetLabel,
  official,
}: {
  ruleSetId: string;
  ruleSetLabel: string;
  official: ResultRevision | null;
}) {
  const ruleSet = useApiQuery({ path: '/rule-sets/{id}', request: { path: { id: ruleSetId } } });
  const hours = ruleSet.data?.content.protestDeadlineHours;
  if (hours === undefined) {
    return (
      <Body muted>
        {ruleSet.error
          ? 'The dispute window could not be loaded. The service checks it when you submit.'
          : 'Loading the dispute window…'}
      </Body>
    );
  }
  const closes =
    official?.publishedAt !== undefined && official?.publishedAt !== null
      ? new Date(new Date(official.publishedAt).getTime() + hours * 3_600_000).toISOString()
      : null;
  return (
    <View style={styles.group} testID="dispute-window">
      <Detail
        label="Dispute window"
        value={`${plural(hours, 'hour')} after the official result is published (${ruleSetLabel})`}
      />
      {closes ? <Detail label="Window closes" value={formatInstant(closes)} /> : null}
      <Body muted>The service checks the window when you submit.</Body>
    </View>
  );
}

function ExistingDisputes({ disputes }: { disputes: Dispute[] }) {
  if (disputes.length === 0) return <Body>No disputes for this game yet.</Body>;
  return (
    <View accessibilityRole="list" style={styles.group}>
      {disputes.map((d) => (
        <View key={d.id} style={styles.group} testID={`dispute-${d.id}`}>
          <StatusBadge {...disputeStatus(d)} />
          <Body>{d.reason}</Body>
          <Body muted>{`Submitted ${formatInstant(d.submittedAt)}`}</Body>
          {d.publicationConsequence ? (
            <Body>{PUBLICATION_CONSEQUENCE_LABELS[d.publicationConsequence]}</Body>
          ) : null}
          {d.decisionReason ? <Body>{`Decision: ${d.decisionReason}`}</Body> : null}
          {d.appealStatus !== 'none' ? <Body>{`Appeal: ${d.appealStatus}`}</Body> : null}
        </View>
      ))}
    </View>
  );
}

function DisputeForm({
  workspace,
  fixtureId,
  official,
}: {
  workspace: Workspace;
  fixtureId: string;
  official: ResultRevision | null;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const counter = useRef(0);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [attempted, setAttempted] = useState(false);
  const submitDispute = useApiCommand('post', '/fixtures/{id}/disputes', {
    invalidate: [
      ['api', '/fixtures/{id}/disputes'],
      ['api', '/fixtures/{id}/results'],
    ],
  });
  const reasonError = attempted && !reason.trim() ? 'Give the reason for the dispute.' : null;
  const started = (e: EvidenceDraft) =>
    Boolean(e.kind.trim() || e.reference.trim() || e.description.trim());
  const complete = (e: EvidenceDraft) => Boolean(e.kind.trim() && e.reference.trim());
  // A started row without both a kind and a reference is never dropped silently: it blocks
  // sending and says what is missing, and the draft is kept.
  const incomplete = evidence.filter((e) => started(e) && !complete(e));
  const filled = evidence.filter(complete);
  const evidenceError = (e: EvidenceDraft) =>
    attempted && started(e) && !complete(e)
      ? 'Give the kind and the reference, or remove this evidence.'
      : null;
  const submit = () => {
    setAttempted(true);
    if (!reason.trim() || incomplete.length > 0) return;
    void submitDispute
      .submit({
        path: { id: fixtureId },
        body: {
          teamEntryId: workspace.entry.id,
          ...(official ? { resultRevisionId: official.id } : {}),
          reason: reason.trim(),
          evidence: filled.map((e) => ({
            kind: e.kind.trim(),
            reference: e.reference.trim(),
            ...(e.description.trim() ? { description: e.description.trim() } : {}),
          })),
        },
      })
      .then(() => {
        setReason('');
        setEvidence([]);
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  const update = (key: string, patch: Partial<EvidenceDraft>) =>
    setEvidence((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  if (submitDispute.data) {
    const d = submitDispute.data;
    return (
      <View style={styles.group} testID="dispute-submitted">
        <StatusBadge {...disputeStatus(d)} />
        <Body>
          {`Submitted ${formatInstant(d.submittedAt)}. The league reviews it; the decision and any change to the published result appear on the game's results.`}
        </Body>
      </View>
    );
  }
  const closedAt = submitDispute.error ? windowClosedAt(submitDispute.error) : null;
  return (
    <View style={styles.group}>
      <TextField
        label="Reason"
        value={reason}
        onChangeText={setReason}
        multiline
        error={reasonError}
        hint="What happened and what you ask the league to review."
      />
      {evidence.map((e, index) => (
        <View key={e.key} style={styles.evidence} testID={`evidence-${index + 1}`}>
          <TextField
            label={`Evidence ${index + 1}: kind`}
            value={e.kind}
            onChangeText={(kind) => update(e.key, { kind })}
            hint="For example video, photo or witness statement."
            error={!e.kind.trim() ? evidenceError(e) : null}
          />
          <TextField
            label={`Evidence ${index + 1}: reference`}
            value={e.reference}
            onChangeText={(reference) => update(e.key, { reference })}
            autoCapitalize="none"
            hint="A link or where the league can find it."
            error={!e.reference.trim() ? evidenceError(e) : null}
          />
          <TextField
            label={`Evidence ${index + 1}: description (optional)`}
            value={e.description}
            onChangeText={(description) => update(e.key, { description })}
          />
          <Button
            label={`Remove evidence ${index + 1}`}
            variant="secondary"
            onPress={() => setEvidence((list) => list.filter((x) => x.key !== e.key))}
          />
        </View>
      ))}
      <ButtonRow>
        <Button
          label="Add an evidence reference"
          variant="secondary"
          onPress={() => {
            counter.current += 1;
            setEvidence((list) => [
              ...list,
              { key: `e${counter.current}`, kind: '', reference: '', description: '' },
            ]);
          }}
        />
      </ButtonRow>
      {offline ? <OfflineNotice what="Submitting a dispute" /> : null}
      <Button
        label="Submit the dispute"
        onPress={submit}
        disabled={offline}
        busy={submitDispute.isProcessing}
      />
      {closedAt !== null && submitDispute.error ? (
        <View style={styles.group} testID="window-closed">
          <StatusBadge tone="danger" label="Dispute window closed" />
          <Body>
            {closedAt
              ? `The dispute window closed ${formatInstant(closedAt)}. Your draft is kept.`
              : 'The dispute window has closed. Your draft is kept.'}
          </Body>
          <Body muted>{`Error code: ${submitDispute.error.code}`}</Body>
        </View>
      ) : submitDispute.error ? (
        <CommandFailure
          error={submitDispute.error}
          onRetry={submit}
          unavailableText="Submitting a dispute for this game is not available to you."
        />
      ) : null}
    </View>
  );
}

function DisputeContent({
  workspace,
  viewer,
  fixtureId,
}: {
  workspace: Workspace;
  viewer: Viewer;
  fixtureId: string;
}) {
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
  });
  const disputes = useApiQuery({
    path: '/fixtures/{id}/disputes',
    request: { path: { id: fixtureId } },
  });
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  if (!viewer.captainView) return <CaptainOnly what="Submitting a dispute" />;
  if (results.data === undefined || fixture.data === undefined) {
    const error = results.error ?? fixture.error;
    if (error) {
      return error.isNotFound || error.isPermissionRestriction ? (
        <StateView variant="unavailable" />
      ) : (
        <CommandFailure
          error={error}
          onRetry={() => {
            void results.refetch();
            void fixture.refetch();
          }}
        />
      );
    }
    return <StateView variant="loading" label="the game's result" />;
  }
  const { official } = orderRevisions(results.data);
  const f = fixture.data;
  return (
    <View>
      <Title>{`Dispute: ${f.home.teamName} vs ${f.away?.teamName ?? 'Bye'}`}</Title>
      <Section title="Submission window">
        <WindowNotice
          ruleSetId={workspace.ruleSet.id}
          ruleSetLabel={`rule set ${workspace.ruleSet.name}, version ${workspace.ruleSet.version}`}
          official={official}
        />
        {official ? null : <Body>There is no official result for this game yet.</Body>}
      </Section>
      <Section title="Disputes for this game">
        {/* Loading, error and offline come from the read; "none yet" only for an empty list. */}
        <QueryBoundary
          query={disputes}
          label="the disputes for this game"
          isEmpty={(list) => list.length === 0}
          empty={{ title: 'No disputes yet', description: 'No disputes for this game yet.' }}
        >
          {(list) => <ExistingDisputes disputes={list} />}
        </QueryBoundary>
      </Section>
      <Section title="File a dispute">
        <Body muted>{`Filed for ${workspace.team.name} as its captain.`}</Body>
        <DisputeForm workspace={workspace} fixtureId={fixtureId} official={official} />
      </Section>
      <Section title="Decisions and appeals">
        <StateView
          variant="pending-decision"
          subject="How appeals of a dispute decision work"
          decisions={['DEC-010']}
          owner="League manager/operator"
        />
      </Section>
    </View>
  );
}

export function DisputeScreen({
  entryId,
  fixtureId,
}: {
  entryId: string | null;
  fixtureId: string | null;
}) {
  return (
    <TeamFrame
      entryId={fixtureId ? entryId : null}
      what="the dispute form"
      unavailableOffline={['submitting a dispute']}
    >
      {(ws, viewer) =>
        fixtureId ? <DisputeContent workspace={ws} viewer={viewer} fixtureId={fixtureId} /> : null
      }
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/disputes/[fixtureId].tsx. */
export function DisputeRoute() {
  const params = useLocalSearchParams<{ entryId: string; fixtureId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Dispute a result' }} />
      <DisputeScreen entryId={idParam(params.entryId)} fixtureId={idParam(params.fixtureId)} />
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  evidence: { gap: spacing.xs, paddingVertical: spacing.xs },
});
