/**
 * SCR-C-25 Team contributions, team view (SPK-PAY-004, SPK-PAY-005, SPK-PAY-011, SPK-CAP-002,
 * SPK-AT-022, DEC-008, POL-014, POL-015). Reads `GET /v1/obligations?teamEntryId=`: each team
 * obligation with its billing model, total, received, allocated and remaining shown together, any
 * excess kept visible, and the contributions requested from players with amount and status only
 * (never anyone's account or payment details). The captain requests a contribution from a roster
 * player with `POST /v1/obligations/{id}/contribution-requests`; a request does not duplicate the
 * team debt and grants no authority over the player's account. Each player pays their own line
 * (ContributionScreen).
 *
 * The billing model (individual, one responsible payer, contributions) is the API's record of the
 * league's choice under DEC-008 / POL-014; the overpayment handling is POL-015 (pending).
 *
 * States: loading; empty (no team obligation: individual billing, or not recorded yet); ready;
 * validation failure (the request exceeds what the API allows); permission restriction (the API's
 * NOT_FOUND or ACCESS_DENIED: team totals not available to this person); stale (another
 * contribution landed: totals refresh after every command and on focus); offline (requesting
 * disabled); processing; success (the request listed); recovery: retried under the same key.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDay, formatMoney, parseMoneyInput } from '../../features/teams/format';
import { ObligationTotals } from '../../features/teams/ObligationTotals';
import { rosterNames, type Viewer, type Workspace } from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import {
  OBLIGATION_MODE_LABELS,
  contributionStatus,
  isCurrentPlayer,
  obligationStatus,
} from '../../features/teams/status';
import { TeamFrame } from '../../features/teams/TeamFrame';
import {
  Body,
  CommandFailure,
  Detail,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  Section,
  TextField,
  Title,
} from '../../features/teams/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

type Obligation = Schema<'Obligation'>;

const OBLIGATIONS_KEY = ['api', '/obligations'] as const;

function RequestContribution({
  obligation,
  workspace,
}: {
  obligation: Obligation;
  workspace: Workspace;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const players = workspace.roster.filter((m) => isCurrentPlayer(m, now));
  const [personId, setPersonId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [attempted, setAttempted] = useState(false);
  const request = useApiCommand('post', '/obligations/{id}/contribution-requests', {
    invalidate: [OBLIGATIONS_KEY],
  });
  const currency = obligation.totals.currency;
  const amountMinor = parseMoneyInput(amount, currency);
  const amountError =
    attempted && amountMinor === null ? `Enter an amount in ${currency}, for example 25.00.` : null;
  const playerError = attempted && !personId ? 'Choose the player to ask.' : null;
  const send = () => {
    setAttempted(true);
    if (!personId || amountMinor === null) return;
    void request
      .submit({
        path: { id: obligation.id },
        body: {
          requestedPersonId: personId,
          amountMinor,
          ...(message.trim() ? { message: message.trim() } : {}),
        },
      })
      .then(() => {
        setPersonId(null);
        setAmount('');
        setMessage('');
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  const name = (id: string) => players.find((p) => p.personId === id)?.displayName ?? 'the player';
  return (
    <View style={styles.form} testID={`request-contribution-${obligation.id}`}>
      <Body>
        A contribution request asks one player to pay part of this team obligation. It does not add
        to the team debt and gives you no access to the player&apos;s account: each player pays
        their own contribution.
      </Body>
      <RadioGroup label="Player">
        {players.map((p) => (
          <RadioRow
            key={p.personId}
            label={p.displayName}
            checked={personId === p.personId}
            onSelect={() => setPersonId(p.personId)}
          />
        ))}
      </RadioGroup>
      {playerError ? <Body>{`▲ ${playerError}`}</Body> : null}
      <TextField
        label={`Amount (${currency})`}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        error={amountError}
        hint={`Remaining on the team obligation: ${formatMoney(obligation.totals.remainingMinor, currency)}`}
      />
      <TextField label="Message (optional)" value={message} onChangeText={setMessage} multiline />
      {offline ? <OfflineNotice what="Requesting a contribution" /> : null}
      <Button
        label="Request contribution"
        onPress={send}
        disabled={offline}
        busy={request.isProcessing}
      />
      {request.data ? (
        <StatusBadge
          tone="success"
          label={`Contribution requested from ${name(request.data.requestedPersonId)}: ${formatMoney(request.data.amountMinor, request.data.currency)}`}
        />
      ) : null}
      {request.error ? (
        <CommandFailure
          error={request.error}
          onRetry={send}
          unavailableText="Requesting contributions is not available to you for this team."
        />
      ) : null}
    </View>
  );
}

function ObligationSection({
  obligation,
  workspace,
  viewer,
}: {
  obligation: Obligation;
  workspace: Workspace;
  viewer: Viewer;
}) {
  const names = rosterNames(workspace);
  return (
    <Section title={obligation.description} testID={`obligation-${obligation.id}`}>
      <StatusBadge {...obligationStatus(obligation.status)} />
      <Detail label="Billing" value={OBLIGATION_MODE_LABELS[obligation.mode]} />
      <Detail label="Due" value={formatDay(obligation.dueAt)} />
      <ObligationTotals totals={obligation.totals} />
      {obligation.contributions ? (
        <View accessibilityRole="list" testID={`contributions-${obligation.id}`}>
          <Body muted>Requested contributions (amounts and status only)</Body>
          {obligation.contributions.length === 0 ? (
            <Body>No contributions requested yet.</Body>
          ) : (
            obligation.contributions.map((c) => (
              <ListRow
                key={c.id}
                title={names.get(c.requestedPersonId) ?? 'Roster player'}
                detail={formatMoney(c.amountMinor, c.currency)}
                status={contributionStatus(c)}
              />
            ))
          )}
        </View>
      ) : null}
      {viewer.captainView &&
      obligation.mode === 'team_with_contributions' &&
      obligation.status === 'open' ? (
        <RequestContribution obligation={obligation} workspace={workspace} />
      ) : null}
    </Section>
  );
}

function ContributionsContent({ workspace, viewer }: { workspace: Workspace; viewer: Viewer }) {
  const obligations = useApiQuery({
    path: '/obligations',
    request: { query: { teamEntryId: workspace.entry.id, limit: 50 } },
  });
  const restricted =
    obligations.data === undefined &&
    obligations.error !== null &&
    presentationForError(obligations.error) === 'unavailable';
  return (
    <View>
      <Title>{`${workspace.team.name}: contributions`}</Title>
      {restricted ? (
        <StateView
          variant="unavailable"
          title="Team totals not available"
          description="The team's totals are shown to the captain and the responsible payer. A contribution requested from you is shown from its request, with your own payment only."
        />
      ) : (
        <QueryBoundary
          query={obligations}
          label="the team's obligations"
          isEmpty={(page) => page.items.length === 0}
          empty={{
            title: 'No team obligation',
            description:
              'Players are billed individually for this team, or the league has not recorded the team fee yet.',
          }}
          unavailableOffline={['requesting contributions', 'payments']}
        >
          {(page) => (
            <View>
              {page.items.map((o) => (
                <ObligationSection
                  key={o.id}
                  obligation={o}
                  workspace={workspace}
                  viewer={viewer}
                />
              ))}
            </View>
          )}
        </QueryBoundary>
      )}
    </View>
  );
}

export function TeamContributionsScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame
      entryId={entryId}
      what="this team's contributions"
      unavailableOffline={['requesting contributions', 'payments']}
    >
      {(ws, viewer) => <ContributionsContent workspace={ws} viewer={viewer} />}
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/contributions.tsx. */
export function TeamContributionsRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Team contributions' }} />
      <TeamContributionsScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm, paddingTop: spacing.sm },
});
