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
 */
import {
  formatAge,
  presentationForError,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery, type ApiQueryResult } from '../../api/useApiQuery';
import { useMe } from '../../features/today/queries';
import { Caption, Section, SectionQueryState } from '../../features/today/Section';
import { displayZone, formatWhen } from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { usePassStore, type StoredPass } from './pass-store';

type MyPass = Schema<'MyPass'>;

/** The reason recorded when the holder replaces their own pass (RevokePassRequest.reason). */
export const REPLACE_REASON = 'Replaced by the holder in the app';
/** The reason recorded when the holder withdraws a pass whose reference is not on this device. */
export const WITHDRAW_REASON = 'Withdrawn by the holder in the app: reference not on this device';

const MY_PASSES_KEY = ['api', '/me/passes'] as const;

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
          // The outcome is unknown or worth retrying: keep the pending revoke for "Try again".
          if (e.keepsIntent) return;
        }
      }
      const settled: StoredPass = { ...current, pendingRevoke: null };
      await store.save(accountKey, settled).catch(() => undefined);
      setStored({ loaded: true, pass: settled });
    },
    [accountKey, revoke, store],
  );

  const held = heldPassState(stored.pass?.passId, passes.data);

  const getPass = useCallback(async () => {
    if (!personId || !accountKey) return;
    // A pass the API already lists as revoked is not revoked again (nothing to withdraw).
    const previous = held.kind === 'revoked' ? null : stored.pass;
    setRevokeProblem(null);
    setSaveProblem(false);
    let issued;
    try {
      // One intent: a retry after a timeout reuses the key, so the API returns the same pass.
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
            <View style={styles.confirm} accessibilityLiveRegion="polite">
              <Text style={styles.body}>
                Replace this pass? The new pass works straight away and the current one stops
                working.
              </Text>
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
            </View>
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

      {issue.error ? (
        issue.error.isNotFound || issue.error.isPermissionRestriction ? (
          <StateView
            variant="unavailable"
            title="Pass not available"
            description="A pass cannot be issued to this account. The front desk can help."
          />
        ) : (
          <StateView variant="error" error={issue.error} onRetry={() => void getPass()} />
        )
      ) : null}
      {saveProblem ? (
        <View style={styles.pad} testID="pass-save-problem">
          <StatusBadge tone="warning" label="New pass not saved" />
          <Caption>
            Your new pass could not be saved on this device, so your previous pass was kept and
            still works. Try again, or ask the front desk.
          </Caption>
        </View>
      ) : null}
      {pass?.pendingRevoke && (!revokeProblem || revokeProblem.keepsIntent) ? (
        <View style={styles.pad} testID="pass-revoke-unconfirmed">
          <StatusBadge tone="warning" label="Previous pass may still be active" />
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
        </View>
      ) : revokeProblem ? (
        <View style={styles.pad} testID="pass-revoke-problem">
          <StatusBadge tone="warning" label="Previous pass still active" />
          <Caption>
            Your new pass is ready, but the previous one could not be withdrawn (error code{' '}
            {revokeProblem.code}). Ask the front desk to revoke it.
          </Caption>
        </View>
      ) : null}
    </View>
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
      <StatusBadge tone="success" label="Active" />
      {withdraw.status === 'success' ? (
        <View accessibilityLiveRegion="polite">
          <StatusBadge tone="neutral" label="Withdrawn" />
        </View>
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
        error.isNotFound || error.isPermissionRestriction ? (
          <StateView
            variant="unavailable"
            title="Pass not available"
            description="This pass is no longer available to withdraw from the app. The front desk can help."
          />
        ) : error.isStale ? (
          <StateView variant="error" error={error} onAction={onReload} />
        ) : (
          <StateView variant="error" error={error} onRetry={submit} />
        )
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

const styles = StyleSheet.create({
  reference: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    borderWidth: 2,
    borderColor: colors.text,
    borderRadius: 8,
    backgroundColor: colors.background,
  },
  referenceText: {
    ...type.title,
    fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
    color: colors.text,
    letterSpacing: 1,
  },
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
});
