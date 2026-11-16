/**
 * The waiting team's section of the workspace (SPK-COMP-006, proposed amendment PA-10): that the
 * team is waiting, for which division, its place in the order and since when; an open offer with
 * the time to answer by, which the captain accepts
 * (`POST /v1/team-entry-place-offers/{id}/accept`) or declines (`.../decline`); and withdrawing
 * the team from the list (`POST /v1/team-entries/{id}/withdraw`, with a reason). Everyone who may
 * open the workspace sees the wait; the answers and the withdrawal are offered only when the API
 * lists their action for this viewer (`viewer.availableActions`), and the API authorizes each
 * command again.
 *
 * A waiting team holds no place and owes nothing. How long an offer stands and whether offers
 * follow the order are the league's rules, still to be decided (DEC-104): the screen shows the
 * expiry and the order the API reports and promises nothing else.
 *
 * States: ready; validation failure (a withdrawal needs a reason); permission restriction ("not
 * available"; a switch turned off reads "turned off"); stale version (the offer expired or was
 * answered meanwhile: reload); offline (disabled, nothing queued); processing; success.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { LiveRegion } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { makeStyles, spacing } from '../../ui/theme';
import { formatInstant, ordinal } from './format';
import type { Workspace } from './queries';
import { CommandError } from '../../ui/CommandError';
import { FieldValue, TextField } from '../../ui/Field';
import { OfflineNotice } from '../../ui/OfflineNotice';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';

/** The waiting list actions of `viewer.availableActions` (competition.actions.ts). */
export const WAITING_ACTIONS = {
  accept: 'competition.accept_team_place_offer',
  decline: 'competition.decline_team_place_offer',
  withdrawEntry: 'competition.withdraw_team_entry',
} as const;

const INVALIDATE = [
  ['api', '/team-entries/{id}'],
  ['api', '/me/team-entries'],
] as const;

const ACCEPTED =
  'You accepted the place. The league reviews the team as usual; payment follows approval.';
const DECLINED = 'You declined the offer. Your team keeps its place in the order.';
const WITHDRAWN = 'Your team was withdrawn from the waiting list.';

type Waiting = NonNullable<Workspace['waiting']>;

export function waitingPlaceText(waiting: Pick<Waiting, 'position' | 'listLength'>): string {
  return `${ordinal(waiting.position)} of ${waiting.listLength} waiting`;
}

function OfferAnswer({
  offer,
  canAccept,
  canDecline,
  onReload,
}: {
  offer: NonNullable<Waiting['openOffer']>;
  canAccept: boolean;
  canDecline: boolean;
  onReload: () => void;
}) {
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const accept = useApiCommand('post', '/team-entry-place-offers/{id}/accept', {
    invalidate: INVALIDATE,
  });
  const decline = useApiCommand('post', '/team-entry-place-offers/{id}/decline', {
    invalidate: INVALIDATE,
  });
  const request = { path: { id: offer.id }, body: { expectedRevision: offer.revision } };
  const doAccept = () => {
    decline.reset();
    void accept.submit(request).catch(() => undefined);
  };
  const doDecline = () => {
    accept.reset();
    void decline.submit(request).catch(() => undefined);
  };
  if (accept.data) {
    return (
      <LiveRegion announcement={ACCEPTED} testID="waiting-offer-accepted">
        <Text variant="body">{ACCEPTED}</Text>
      </LiveRegion>
    );
  }
  if (decline.data) {
    return (
      <LiveRegion announcement={DECLINED} testID="waiting-offer-declined">
        <Text variant="body">{DECLINED}</Text>
      </LiveRegion>
    );
  }
  const error = accept.error ?? decline.error;
  return (
    <View style={styles.group} testID="waiting-offer">
      <StatusBadge tone="info" label={`A place is offered in ${offer.divisionName}`} />
      <FieldValue layout="inline" label="Answer by" value={formatInstant(offer.expiresAt)} />
      <Text variant="caption" tone="muted">
        The place is held for your team until then. Accepting sends the team to the league for
        approval; nothing is charged by accepting.
      </Text>
      {canAccept || canDecline ? (
        <>
          {offline ? <OfflineNotice what="Answering the offer" /> : null}
          <View style={buttonRowStyles.row}>
            {canAccept ? (
              <Button
                label="Accept the place"
                onPress={doAccept}
                busy={accept.isProcessing}
                disabled={offline || decline.isProcessing}
              />
            ) : null}
            {canDecline ? (
              <Button
                label="Decline the offer"
                variant="secondary"
                onPress={doDecline}
                busy={decline.isProcessing}
                disabled={offline || accept.isProcessing}
                accessibilityHint="Your team keeps its place in the order"
              />
            ) : null}
          </View>
        </>
      ) : (
        <Text variant="caption" tone="muted">
          The team&apos;s captain answers the offer.
        </Text>
      )}
      {error ? (
        <CommandError
          wording="team"
          error={error}
          onRetry={accept.error ? doAccept : doDecline}
          onReload={() => {
            accept.reset();
            decline.reset();
            onReload();
          }}
          unavailableText="Answering this offer is not available to you."
        />
      ) : null}
    </View>
  );
}

function WithdrawFromList({ workspace, onReload }: { workspace: Workspace; onReload: () => void }) {
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const withdraw = useApiCommand('post', '/team-entries/{id}/withdraw', {
    invalidate: INVALIDATE,
  });
  const reasonError = attempted && !reason.trim() ? 'Give the reason for withdrawing.' : null;
  const submit = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void withdraw
      .submit({
        path: { id: workspace.entry.id },
        body: { reason: reason.trim(), expectedRevision: workspace.entry.revision },
      })
      .catch(() => undefined);
  };
  if (withdraw.data) {
    return (
      <LiveRegion announcement={WITHDRAWN} testID="waiting-withdrawn">
        <Text variant="body">{WITHDRAWN}</Text>
      </LiveRegion>
    );
  }
  if (!open) {
    return (
      <Button
        label="Withdraw from the waiting list"
        variant="secondary"
        onPress={() => setOpen(true)}
        disabled={offline}
        accessibilityHint="Asks for a reason; the team leaves the list"
      />
    );
  }
  return (
    <View style={styles.group} testID="waiting-withdraw">
      <TextField
        label="Reason for withdrawing"
        value={reason}
        onChangeText={setReason}
        multiline
        error={reasonError}
      />
      <Text variant="caption" tone="muted">
        A withdrawn team leaves the list and loses its place in the order. An open offer is closed
        with it.
      </Text>
      {offline ? <OfflineNotice what="Withdrawing the team" /> : null}
      <View style={buttonRowStyles.row}>
        <Button
          label="Withdraw the team"
          onPress={submit}
          busy={withdraw.isProcessing}
          disabled={offline}
        />
        <Button
          label="Keep waiting"
          variant="secondary"
          onPress={() => {
            withdraw.reset();
            setOpen(false);
            setAttempted(false);
          }}
        />
      </View>
      {withdraw.error ? (
        <CommandError
          wording="team"
          error={withdraw.error}
          onRetry={submit}
          onReload={() => {
            withdraw.reset();
            setOpen(false);
            onReload();
          }}
          unavailableText="Withdrawing this team is not available to you."
        />
      ) : null}
    </View>
  );
}

export function TeamWaiting({
  workspace,
  onReload,
}: {
  workspace: Workspace;
  /** Reads the workspace again (after STALE_REVISION or INVALID_TRANSITION). */
  onReload: () => void;
}) {
  const waiting = workspace.waiting;
  if (!waiting) return null;
  const actions = workspace.viewer.availableActions;
  return (
    <Section title="Waiting list" testID="team-waiting">
      <Text variant="body">
        {waiting.division
          ? `Your team is waiting for a place in ${waiting.division.name}.`
          : 'Your team is waiting for a place in this season.'}
      </Text>
      <FieldValue layout="inline" label="Place in the order" value={waitingPlaceText(waiting)} />
      <FieldValue layout="inline" label="Waiting since" value={formatInstant(waiting.since)} />
      <Text variant="caption" tone="muted">
        A waiting team holds no place and owes nothing. The league offers a place when one opens and
        chooses which waiting team it goes to.
      </Text>
      {waiting.openOffer ? (
        <OfferAnswer
          offer={waiting.openOffer}
          canAccept={actions.includes(WAITING_ACTIONS.accept)}
          canDecline={actions.includes(WAITING_ACTIONS.decline)}
          onReload={onReload}
        />
      ) : (
        <Text variant="caption" tone="muted">
          No place has been offered yet.
        </Text>
      )}
      {actions.includes(WAITING_ACTIONS.withdrawEntry) ? (
        <WithdrawFromList workspace={workspace} onReload={onReload} />
      ) : null}
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  group: { gap: spacing.sm },
}));

/** A row of buttons under a form or a choice. */
const buttonRowStyles = StyleSheet.create({
  row: { gap: spacing.sm, paddingTop: spacing.xs },
});
