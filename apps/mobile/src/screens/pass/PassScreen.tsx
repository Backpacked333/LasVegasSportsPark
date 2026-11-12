/**
 * SCR-C-05 Facility pass (SPK-UX-002, SPK-ENTRY-002, SPK-ENTRY-003, §4.13, §4.14, §4.15).
 *
 * - Reachable from Home and every destination header, never a tab (SPK-UX-002).
 * - The pass is an opaque reference and nothing else: no name, household or child detail is shown
 *   or stored with it (SPK-ENTRY-002). Scanning it opens the desk's selection flow, where staff
 *   choose who actually arrived; the pass never marks anyone present (SPK-ENTRY-003).
 * - `POST /v1/passes` issues a personal pass to the signed-in person (the API allows a person to
 *   issue their own; household passes are issued by staff only). The reference comes back once,
 *   so it is kept in the device's secure store (pass-store.ts) and shown from there, also offline.
 * - "Replace pass" issues a new pass, saves it, then revokes the old one
 *   (`POST /v1/passes/{id}/revoke` with reason and expected revision), so the person is never left
 *   without a pass: when the save fails nothing is revoked; when the revoke gets no answer, the
 *   old pass stays recorded as pending and "Try again" resends the same revoke (same key).
 * - `GET /v1/me/passes` (ENT-01) lists the holder's own passes with their state, never the
 *   reference: the screen says whether the pass on this device is still active, and a pass staff
 *   revoked is shown as revoked (its reference is no longer offered for the desk) with "Get a new
 *   pass", which issues one without revoking anything. The staff revocation reason is withheld by
 *   the API (null), so none is shown. Offline, the last known state is shown with its age and the
 *   stored reference keeps the "may refuse it if it was revoked" caveat (§4.15).
 * - Passes the API lists as active but whose reference is not on this device (a reinstall, another
 *   phone) are listed under "Other active passes" with "Withdraw this pass" (`POST
 *   /v1/passes/{id}/revoke` with reason and the listed revision), so a lost reference can be
 *   stopped by its holder. The reference itself can never be shown again (only its hash is kept).
 * - The scannable symbol depends on the desk scanners, which are DEC-023 (Technical lead/account
 *   owners): until then the reference is shown as text, and that is labelled as pending.
 * - A failed issue or withdrawal is shown by the shared account `CommandError` (§4.9, SPK-UX-008):
 *   no definite answer (`mayHaveTakenEffect`) reads "No answer yet" with "Check again", which
 *   resends the same request under the same key; IDEMPOTENCY_OUTCOME_UNAVAILABLE reads "This may
 *   already have been done" with "Reload", after which a pass it made is listed under "Other active
 *   passes". Never "Something went wrong" for a request that may have gone through.
 * - The reference is a one-time secret (SPK-ENTRY-002, §4.14), so a replay of an issue does not
 *   carry it: `POST /v1/passes` withholds it from the stored answer and a same-key replay answers
 *   IDEMPOTENCY_SECRET_WITHHELD with `details.resourceId` = the pass id (entry module,
 *   R2-TENANCY-INPUT-01). The screen reads that as "Pass issued, but its reference cannot be shown
 *   again": the passes are read again, the pass it made is listed under "Other active passes" to
 *   withdraw, and getting a pass again is a new request.
 * - The replace flow's withdrawal of the previous pass decides with the same predicates: an answer
 *   lost after it committed (IDEMPOTENCY_OUTCOME_UNAVAILABLE) reads "This may already have been
 *   done" with "Reload", never "still active"; the pending withdrawal is kept until
 *   `GET /v1/me/passes` lists the previous pass as revoked, which settles it.
 * - Every result here (a failure, the replace flow's outcomes, a withdrawal) is announced to screen
 *   readers (`ui/announce`, SPK-UX-009).
 * - Look (park system): the pass is a night pitch card holding a white ticket with the reference
 *   in large condensed figures. No name is printed on it (SPK-ENTRY-002), and no symbol is drawn
 *   until DEC-023 decides the scanners.
 */
import {
  formatAge,
  presentationForError,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  keepsIntentAfterFailure,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery, type ApiQueryResult } from '../../api/useApiQuery';
import { useMe } from '../../features/today/queries';
import { Caption, Section, SectionQueryState } from '../../features/today/Section';
import { displayZone, formatWhen } from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { OutcomeLost } from '../../ui/OutcomeLost';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { Icon } from '../../ui/Icon';
import { StatusBadge } from '../../ui/StatusBadge';
import { fonts, makeStyles, radius, spacing, type, useTheme } from '../../ui/theme';
import { CommandError, type NotAvailableCopy } from '../account/components/CommandError';
import { usePassStore, type StoredPass } from './pass-store';

type MyPass = Schema<'MyPass'>;

/** The reason recorded when the holder replaces their own pass (RevokePassRequest.reason). */
export const REPLACE_REASON = 'Replaced by the holder in the app';
/** The reason recorded when the holder withdraws a pass whose reference is not on this device. */
export const WITHDRAW_REASON = 'Withdrawn by the holder in the app: reference not on this device';

const MY_PASSES_KEY = ['api', '/me/passes'] as const;

const REPLACE_QUESTION =
  'Replace this pass? The new pass works straight away and the current one stops working.';

/** A refused issue (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED, NOT_FOUND), without the code. */
const ISSUE_NOT_AVAILABLE: NotAvailableCopy = {
  title: 'Pass not available',
  description: 'A pass cannot be issued to this account. The front desk can help.',
};
/** A refused withdrawal of a pass whose reference is not on this device. */
const WITHDRAW_NOT_AVAILABLE: NotAvailableCopy = {
  title: 'Pass not available',
  description:
    'This pass is no longer available to withdraw from the app. The front desk can help.',
};

/**
 * What the API says about the pass stored on this device (ENT-01): `active`, `revoked` (with when),
 * `unlisted` (the API's list does not include it, so nothing is claimed), or `unknown` (not read).
 */
export type HeldPassState =
  | { kind: 'active' }
  | { kind: 'revoked'; revokedAt: string | null }
  | { kind: 'unlisted' }
  | { kind: 'unknown' };

export function heldPassState(
  passId: string | null | undefined,
  passes: readonly MyPass[] | undefined,
): HeldPassState {
  if (!passId || !passes) return { kind: 'unknown' };
  const listed = passes.find((p) => p.id === passId);
  if (!listed) return { kind: 'unlisted' };
  if (listed.status === 'revoked') return { kind: 'revoked', revokedAt: listed.revokedAt };
  return { kind: 'active' };
}

/** Active person passes the API lists that are not the one on this device (nor being replaced). */
export function otherActivePasses(
  passes: readonly MyPass[] | undefined,
  stored: StoredPass | null,
): MyPass[] {
  return (passes ?? []).filter(
    (p) =>
      p.status === 'active' && p.id !== stored?.passId && p.id !== stored?.pendingRevoke?.passId,
  );
}

/** "SPK1 ABCD …": groups of four so the reference can be read out at the desk. */
export function groupReference(reference: string): string {
  return reference.match(/.{1,4}/g)?.join(' ') ?? reference;
}

/** Codes after which the old pass is known to be unusable already (revoked or gone). */
const ALREADY_WITHDRAWN = new Set(['STALE_REVISION', 'INVALID_TRANSITION', 'NOT_FOUND']);

function PassContent() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { session } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const now = useNow();
  const store = usePassStore();
  const me = useMe();
  // The pass is kept under the account the API names (or the session's), never under a shared
  // key: another person signing in on this device never sees it (SPK-ENTRY-002, §4.14).
  const accountKey = me.data?.principal.accountId ?? session.session?.accountId ?? null;
  const [stored, setStored] = useState<{ loaded: boolean; pass: StoredPass | null }>({
    loaded: false,
    pass: null,
  });
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [revokeProblem, setRevokeProblem] = useState<ApiError | null>(null);
  const [saveProblem, setSaveProblem] = useState(false);
  const issue = useApiCommand('post', '/passes', { invalidate: [MY_PASSES_KEY] });
  const revoke = useApiCommand('post', '/passes/{id}/revoke', { invalidate: [MY_PASSES_KEY] });
  const passes = useApiQuery({ path: '/me/passes', enabled: session.status === 'signed_in' });

  useEffect(() => {
    if (!accountKey) return undefined;
    let active = true;
    store
      .load(accountKey)
      .then((pass) => active && setStored({ loaded: true, pass }))
      .catch(() => active && setStored({ loaded: true, pass: null }));
    return () => {
      active = false;
    };
  }, [store, accountKey]);

  const personId = me.data?.principal.personId ?? null;

  /** Revokes the replaced pass; the same request (same key) on every retry of this intent. */
  const revokePrevious = useCallback(
    async (current: StoredPass) => {
      const pending = current.pendingRevoke;
      if (!pending || !accountKey) return;
      setRevokeProblem(null);
      try {
        await revoke.submit({
          path: { id: pending.passId },
          body: { reason: REPLACE_REASON, expectedRevision: pending.revision },
        });
      } catch (error) {
        const e = error as ApiError;
        if (!ALREADY_WITHDRAWN.has(e.code)) {
          setRevokeProblem(e);
          // The outcome is unknown, worth retrying, or committed with its answer lost: keep the
          // pending revoke (and its key). A lost answer is settled when the list shows the pass
          // revoked; nothing else is sent for it.
          if (keepsIntentAfterFailure(e)) return;
        }
      }
      const settled: StoredPass = { ...current, pendingRevoke: null };
      await store.save(accountKey, settled).catch(() => undefined);
      setStored({ loaded: true, pass: settled });
    },
    [accountKey, revoke, store],
  );

  const held = heldPassState(stored.pass?.passId, passes.data);

  // The replaced pass is listed as revoked (its withdrawal committed although the answer was lost,
  // or the desk withdrew it): nothing is pending any more.
  const pendingRevoke = stored.pass?.pendingRevoke ?? null;
  const pendingWithdrawn =
    pendingRevoke !== null &&
    passes.data?.some((p) => p.id === pendingRevoke.passId && p.status === 'revoked') === true;
  useEffect(() => {
    if (!pendingWithdrawn || !accountKey || !stored.pass) return;
    const settled: StoredPass = { ...stored.pass, pendingRevoke: null };
    setRevokeProblem(null);
    setStored({ loaded: true, pass: settled });
    void store.save(accountKey, settled).catch(() => undefined);
  }, [pendingWithdrawn, accountKey, stored.pass, store]);

  // A replayed issue whose reference the API withholds (§4.14): the pass exists, unshown. The
  // list is read again so it appears under "Other active passes", where it can be withdrawn.
  const queryClient = useQueryClient();
  const issueWithheld = issue.error !== null && secretWithheldOf(issue.error) !== null;
  useEffect(() => {
    if (issueWithheld) void queryClient.invalidateQueries({ queryKey: MY_PASSES_KEY });
  }, [issueWithheld, issue.error, queryClient]);

  const getPass = useCallback(async () => {
    if (!personId || !accountKey) return;
    // A pass the API already lists as revoked is not revoked again (nothing to withdraw).
    const previous = held.kind === 'revoked' ? null : stored.pass;
    setRevokeProblem(null);
    setSaveProblem(false);
    let issued;
    try {
      // One intent: a retry after a timeout reuses the key, so the API answers for the same pass
      // (without its reference: IDEMPOTENCY_SECRET_WITHHELD, handled by `issueWithheld` above)
      issued = await issue.submit({ body: { holder: { kind: 'person', personId } } });
    } catch {
      return; // shown from issue.error; the stored pass (if any) is untouched
    }
    const next: StoredPass = {
      passId: issued.pass.id,
      reference: issued.reference,
      issuedAt: issued.pass.issuedAt,
      revision: issued.pass.revision,
      pendingRevoke:
        previous && previous.passId !== issued.pass.id
          ? {
              passId: previous.passId,
              // The revision the API lists now, when it was read; else the one stored at issue.
              revision:
                passes.data?.find((p) => p.id === previous.passId)?.revision ?? previous.revision,
            }
          : null,
    };
    try {
      await store.save(accountKey, next);
    } catch {
      // Without a saved copy the new reference would be lost on restart (the API shows it only
      // once), so the previous pass, the one stored here, is not revoked.
      setSaveProblem(true);
      setConfirmReplace(false);
      return;
    }
    setStored({ loaded: true, pass: next });
    setConfirmReplace(false);
    if (next.pendingRevoke) await revokePrevious(next);
  }, [personId, accountKey, stored.pass, held.kind, passes.data, issue, store, revokePrevious]);

  if (!accountKey) {
    if (me.data === undefined) return <SectionQueryState read={me} label="your pass" />;
    return (
      <StateView
        variant="unavailable"
        title="Pass unavailable"
        description="A pass needs a signed-in account. Contact the front desk."
      />
    );
  }
  if (!stored.loaded) return <StateView variant="loading" label="your pass" />;

  const pass = stored.pass;
  const zone = displayZone(null);
  const unlinked = me.data !== undefined && !personId;

  return (
    <View testID="pass-content">
      {pass && held.kind === 'revoked' ? (
        <Section title="Your facility pass" testID="pass-revoked">
          <View style={styles.pad}>
            <StatusBadge tone="danger" label="Pass revoked" testID="pass-state" />
            <Caption>
              The pass on this device was withdrawn
              {held.revokedAt ? ` on ${formatWhen(held.revokedAt, zone.zone)}` : ''}, so the front
              desk will not accept it. Get a new pass to show at the desk.
            </Caption>
          </View>
        </Section>
      ) : pass ? (
        <Section title="Your facility pass" testID="pass-ready">
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>Facility pass</Text>
            <View
              style={styles.reference}
              accessible
              // Spelled out, so VoiceOver and TalkBack read the reference itself (SPK-UX-009).
              accessibilityLabel={`Facility pass reference: ${groupReference(pass.reference).split('').join(' ')}. Show this at the front desk.`}
              testID="pass-reference"
            >
              <Text style={styles.referenceText} selectable>
                {groupReference(pass.reference)}
              </Text>
              <Text style={styles.referenceHint}>Show at the front desk</Text>
            </View>
            <View style={styles.heroNote}>
              <Icon name="location_on" size={22} color={colors.floodlight} />
              <Text style={styles.heroNoteText}>
                Kept on this device, so it shows without a connection.
              </Text>
            </View>
          </View>
          <Caption testID="pass-issued">
            Issued {formatWhen(pass.issuedAt, zone.zone)} ({formatAge(new Date(pass.issuedAt), now)}
            ).
          </Caption>
          <Caption>
            Show this at the front desk. It does not contain your name or any family details; staff
            choose who is arriving after it is scanned.
          </Caption>
          <PassStateLine held={held} passes={passes} offline={offline} now={now} />
          <View style={styles.pad}>
            <StateView
              variant="pending-decision"
              subject="A scannable code for this pass"
              decisions={['DEC-023']}
              owner="Technical lead/account owners"
            />
          </View>
        </Section>
      ) : (
        <StateView
          variant="empty"
          title="No pass on this device"
          description="Get a personal facility pass to show at the front desk. Passes for a household are issued by staff at the desk."
        />
      )}

      {me.data === undefined ? (
        <SectionQueryState read={me} label="your account" />
      ) : unlinked ? (
        <StateView
          variant="unavailable"
          description="A pass needs your account to be linked to a person. Finish setting up your account first."
        />
      ) : (
        <View style={styles.actions}>
          {pass && held.kind === 'revoked' ? (
            <Button
              label="Get a new pass"
              busy={issue.isProcessing}
              disabled={offline}
              onPress={() => void getPass()}
              testID="pass-get-new"
            />
          ) : null}
          {pass && held.kind !== 'revoked' && !confirmReplace ? (
            <Button
              label="Replace pass"
              variant="secondary"
              disabled={offline}
              onPress={() => setConfirmReplace(true)}
              accessibilityHint="Asks before replacing; the current pass stops working"
              testID="pass-replace"
            />
          ) : null}
          {pass && held.kind !== 'revoked' && confirmReplace ? (
            <LiveRegion style={styles.confirm} announcement={REPLACE_QUESTION}>
              <Text style={styles.body}>{REPLACE_QUESTION}</Text>
              <Button
                label="Replace"
                busy={issue.isProcessing || revoke.isProcessing}
                disabled={offline}
                onPress={() => void getPass()}
                testID="pass-replace-confirm"
              />
              <Button
                label="Keep this pass"
                variant="secondary"
                onPress={() => setConfirmReplace(false)}
              />
            </LiveRegion>
          ) : null}
          {!pass ? (
            <Button
              label="Get my pass"
              busy={issue.isProcessing}
              disabled={offline}
              onPress={() => void getPass()}
              testID="pass-get"
            />
          ) : null}
          {offline ? <Caption>Getting or replacing a pass needs a connection.</Caption> : null}
        </View>
      )}

      {otherActivePasses(passes.data, pass).length > 0 ? (
        <Section title="Other active passes" testID="pass-others">
          <Caption>
            {pass
              ? 'These passes are still active, but their references are not on this device. A reference is shown only once, when the pass is issued. Withdraw any you no longer have.'
              : 'You have an active pass, but its reference is not on this device: a reference is shown only once, when the pass is issued. Withdraw it if you no longer have it, and get a new one here.'}
          </Caption>
          <View accessibilityRole="list">
            {otherActivePasses(passes.data, pass).map((other) => (
              <OtherPass
                key={other.id}
                pass={other}
                zone={zone.zone}
                offline={offline}
                onReload={() => void passes.refetch()}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {issue.error && issueWithheld ? (
        <IssueWithheld error={issue.error} hasPass={pass !== null} />
      ) : issue.error ? (
        // "Check again" after no answer resends the same issue (same key), so one pass is issued.
        <CommandError
          error={issue.error}
          onRetry={() => void getPass()}
          notFound={ISSUE_NOT_AVAILABLE}
          denied={ISSUE_NOT_AVAILABLE}
        />
      ) : null}
      {saveProblem ? (
        <LiveRegion
          style={styles.pad}
          testID="pass-save-problem"
          announcement={sentences(SAVE_PROBLEM_LABEL, SAVE_PROBLEM_TEXT)}
        >
          <StatusBadge tone="warning" label={SAVE_PROBLEM_LABEL} />
          <Caption>{SAVE_PROBLEM_TEXT}</Caption>
        </LiveRegion>
      ) : null}
      {pass?.pendingRevoke && revokeProblem && tookEffectOutcomeLost(revokeProblem) ? (
        // The withdrawal committed before its answer was lost: never "still active". Reload reads
        // the passes again, and the list showing the previous pass revoked settles it.
        <OutcomeLost
          error={revokeProblem}
          what="the withdrawal of your previous pass"
          testID="pass-revoke-outcome-lost"
        />
      ) : pass?.pendingRevoke && (!revokeProblem || keepsIntentAfterFailure(revokeProblem)) ? (
        <LiveRegion
          style={styles.pad}
          testID="pass-revoke-unconfirmed"
          // Not while the withdrawal is being sent again: its answer is announced instead.
          announcement={
            revoke.isProcessing
              ? null
              : sentences(UNCONFIRMED_LABEL, UNCONFIRMED_TEXT, offline ? null : 'Try again')
          }
          occurrence={revokeProblem}
        >
          <StatusBadge tone="warning" label={UNCONFIRMED_LABEL} />
          <Caption>
            We could not confirm the previous pass was withdrawn
            {revokeProblem ? ` (error code ${revokeProblem.code})` : ''}. Your new pass is ready.
          </Caption>
          <Button
            label="Try again"
            variant="secondary"
            busy={revoke.isProcessing}
            disabled={offline}
            onPress={() => void revokePrevious(pass)}
          />
        </LiveRegion>
      ) : revokeProblem ? (
        <LiveRegion
          style={styles.pad}
          testID="pass-revoke-problem"
          announcement={sentences(STILL_ACTIVE_LABEL, STILL_ACTIVE_TEXT)}
          occurrence={revokeProblem}
        >
          <StatusBadge tone="warning" label={STILL_ACTIVE_LABEL} />
          <Caption>
            Your new pass is ready, but the previous one could not be withdrawn (error code{' '}
            {revokeProblem.code}). Ask the front desk to revoke it.
          </Caption>
        </LiveRegion>
      ) : null}
    </View>
  );
}

const SAVE_PROBLEM_LABEL = 'New pass not saved';
const SAVE_PROBLEM_TEXT =
  'Your new pass could not be saved on this device, so your previous pass was kept and still works. Try again, or ask the front desk.';
const UNCONFIRMED_LABEL = 'Previous pass may still be active';
const UNCONFIRMED_TEXT =
  'We could not confirm the previous pass was withdrawn. Your new pass is ready.';
const STILL_ACTIVE_LABEL = 'Previous pass still active';
const STILL_ACTIVE_TEXT =
  'Your new pass is ready, but the previous one could not be withdrawn. Ask the front desk to revoke it.';
export const ISSUE_WITHHELD_LABEL = 'Pass issued, but its reference cannot be shown again';

/**
 * IDEMPOTENCY_SECRET_WITHHELD on an issue (§4.14, SPK-ENTRY-002): the earlier request issued a
 * pass whose reference was shown only in the answer that never arrived. It is not a failure, and
 * not a link to revoke from here: the pass is listed under "Other active passes", where it is
 * withdrawn, and the next "Get my pass" or "Replace" is a new request.
 */
function IssueWithheld({ error, hasPass }: { error: ApiError; hasPass: boolean }) {
  const styles = useStyles();
  const text = hasPass
    ? 'Your earlier request issued a new pass, but its reference is shown only once, in an answer that did not reach this device. The pass on this device still works. The new one is listed under "Other active passes": withdraw it there.'
    : 'Your earlier request issued a pass, but its reference is shown only once, in an answer that did not reach this device. It is listed under "Other active passes": withdraw it there, then get a new pass.';
  return (
    <LiveRegion
      style={styles.pad}
      testID="pass-issue-withheld"
      announcement={sentences(ISSUE_WITHHELD_LABEL, text)}
      occurrence={error}
    >
      <StatusBadge tone="warning" label={ISSUE_WITHHELD_LABEL} />
      <Caption>{text}</Caption>
      <Caption>
        {`Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Caption>
    </LiveRegion>
  );
}

/** The API's state of the stored pass, or why it cannot be told (SPK-UX-008). */
function PassStateLine({
  held,
  passes,
  offline,
  now,
}: {
  held: HeldPassState;
  passes: ApiQueryResult<'/me/passes'>;
  offline: boolean;
  now: Date;
}) {
  const styles = useStyles();
  const checked = passes.updatedAt ? formatAge(passes.updatedAt, now) : null;
  if (offline) {
    return (
      <View style={styles.pad}>
        <StatusBadge tone="warning" label="Shown from this device" />
        <Caption>
          You are offline. This is the pass stored on this device
          {held.kind === 'active' && checked ? `; it was active when checked ${checked}` : ''}. The
          desk checks it when scanned and may refuse it if it was revoked.
        </Caption>
      </View>
    );
  }
  if (held.kind === 'active') {
    return (
      <View style={styles.pad}>
        <StatusBadge tone="success" label="Active" testID="pass-state" />
        {checked ? <Caption>Checked {checked}.</Caption> : null}
      </View>
    );
  }
  if (held.kind === 'unlisted') {
    return (
      <View style={styles.pad}>
        <StatusBadge tone="warning" label="Not confirmed" testID="pass-state" />
        <Caption>
          Your passes do not include this one, so the app cannot confirm it is active. If the desk
          cannot accept it, replace it here.
        </Caption>
      </View>
    );
  }
  if (passes.error && presentationForError(passes.error) !== 'offline') {
    if (presentationForError(passes.error) === 'unavailable') {
      return (
        <Caption>
          Whether this pass is still active is not available to this account. If the desk cannot
          accept it, replace it here.
        </Caption>
      );
    }
    return (
      <View style={styles.pad} testID="pass-state-error">
        <Caption>Could not check whether this pass is still active.</Caption>
        <StateView variant="error" error={passes.error} onRetry={() => void passes.refetch()} />
      </View>
    );
  }
  return <StateView variant="loading" label="whether this pass is active" />;
}

/**
 * An active pass whose reference is not on this device: the holder may withdraw it
 * (`POST /v1/passes/{id}/revoke`, one intent per pass, with the listed revision, §4.9).
 */
function OtherPass({
  pass,
  zone,
  offline,
  onReload,
}: {
  pass: MyPass;
  zone: string;
  offline: boolean;
  onReload: () => void;
}) {
  const styles = useStyles();
  const [confirming, setConfirming] = useState(false);
  const withdraw = useApiCommand('post', '/passes/{id}/revoke', { invalidate: [MY_PASSES_KEY] });
  const submit = () =>
    void withdraw
      .submit({
        path: { id: pass.id },
        body: { reason: WITHDRAW_REASON, expectedRevision: pass.revision },
      })
      .catch(() => undefined);
  const error = withdraw.error;
  return (
    <View style={styles.other} testID={`pass-other-${pass.id}`}>
      <Text style={styles.body}>Pass issued {formatWhen(pass.issuedAt, zone)}</Text>
      {withdraw.status !== 'success' ? <StatusBadge tone="success" label="Active" /> : null}
      {withdraw.status === 'success' ? (
        <LiveRegion announcement="Withdrawn">
          <StatusBadge tone="neutral" label="Withdrawn" />
        </LiveRegion>
      ) : confirming ? (
        <View style={styles.confirm}>
          <Text style={styles.body}>
            Withdraw this pass? It stops working at the desk straight away.
          </Text>
          <Button
            label="Withdraw"
            busy={withdraw.isProcessing}
            disabled={offline}
            onPress={submit}
            testID={`pass-withdraw-confirm-${pass.id}`}
          />
          <Button label="Keep it" variant="secondary" onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <Button
          label="Withdraw this pass"
          variant="secondary"
          disabled={offline}
          accessibilityHint="Asks before withdrawing; the pass stops working"
          onPress={() => setConfirming(true)}
          testID={`pass-withdraw-${pass.id}`}
        />
      )}
      {error ? (
        <CommandError
          error={error}
          onRetry={submit}
          onReload={onReload}
          notFound={WITHDRAW_NOT_AVAILABLE}
          denied={WITHDRAW_NOT_AVAILABLE}
        />
      ) : null}
    </View>
  );
}

export function PassScreen() {
  return (
    <Screen>
      <RequireSession what="your facility pass">
        <PassContent />
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(({ colors, dark }) => ({
  hero: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.night,
    // A hairline keeps the pass's edge on a page that is itself dark (Legends mode).
    borderWidth: 1,
    borderColor: dark ? colors.nightLine : colors.night,
    alignItems: 'stretch',
  },
  heroLabel: { ...type.eyebrow, color: colors.nightMuted, textAlign: 'center' },
  reference: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    borderRadius: 28,
    backgroundColor: colors.background,
    alignItems: 'center',
  },
  referenceText: {
    ...type.title,
    fontSize: 34,
    lineHeight: 40,
    color: colors.text,
    letterSpacing: 2,
    textAlign: 'center',
  },
  referenceHint: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
  heroNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.nightRaised,
  },
  heroNoteText: { ...type.caption, ...fonts.semibold, color: colors.onNight, flex: 1 },
  pad: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  actions: { padding: spacing.lg, gap: spacing.sm },
  confirm: { gap: spacing.sm },
  other: {
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { ...type.body, color: colors.text },
}));
