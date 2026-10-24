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
 * - "Replace pass" issues a new pass, then revokes the old one (`POST /v1/passes/{id}/revoke`
 *   with reason and expected revision), so the person is never left without a pass.
 * - The API offers the holder no read of a pass, so the app cannot tell whether staff revoked it;
 *   the screen says so instead of claiming the pass is valid.
 * - The scannable symbol depends on the desk scanners, which are DEC-023 (Technical lead/account
 *   owners): until then the reference is shown as text, and that is labelled as pending.
 */
import { formatAge, type ApiError } from '@sportspark/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
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

/** The reason recorded when the holder replaces their own pass (RevokePassRequest.reason). */
export const REPLACE_REASON = 'Replaced by the holder in the app';

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
  const accountKey = session.session?.accountId ?? 'account';
  const [stored, setStored] = useState<{ loaded: boolean; pass: StoredPass | null }>({
    loaded: false,
    pass: null,
  });
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [revokeProblem, setRevokeProblem] = useState<ApiError | null>(null);
  const issue = useApiCommand('post', '/passes');
  const revoke = useApiCommand('post', '/passes/{id}/revoke');

  useEffect(() => {
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

  const getPass = useCallback(async () => {
    if (!personId) return;
    const previous = stored.pass;
    setRevokeProblem(null);
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
    };
    await store.save(accountKey, next).catch(() => undefined);
    setStored({ loaded: true, pass: next });
    setConfirmReplace(false);
    if (previous && previous.passId !== next.passId) {
      try {
        await revoke.submit({
          path: { id: previous.passId },
          body: { reason: REPLACE_REASON, expectedRevision: previous.revision },
        });
      } catch (error) {
        const e = error as ApiError;
        if (!ALREADY_WITHDRAWN.has(e.code)) setRevokeProblem(e);
      }
    }
  }, [personId, stored.pass, issue, revoke, store, accountKey]);

  if (!stored.loaded) return <StateView variant="loading" label="your pass" />;

  const pass = stored.pass;
  const zone = displayZone(null);
  const unlinked = me.data !== undefined && !personId;

  return (
    <View testID="pass-content">
      {pass ? (
        <Section title="Your facility pass" testID="pass-ready">
          <View
            style={styles.reference}
            accessible
            accessibilityLabel="Facility pass reference. Show this screen at the front desk."
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
          {offline ? (
            <View style={styles.pad}>
              <StatusBadge tone="warning" label="Shown from this device" />
              <Caption>
                You are offline. This is the pass stored on this device; the desk checks it when
                scanned and may refuse it if it was revoked.
              </Caption>
            </View>
          ) : (
            <Caption>
              This app cannot check whether the pass is still active. If the desk cannot accept it,
              replace it here.
            </Caption>
          )}
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
          {pass && !confirmReplace ? (
            <Button
              label="Replace pass"
              variant="secondary"
              disabled={offline}
              onPress={() => setConfirmReplace(true)}
              accessibilityHint="Asks before replacing; the current pass stops working"
              testID="pass-replace"
            />
          ) : null}
          {pass && confirmReplace ? (
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
      {revokeProblem ? (
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
  body: { ...type.body, color: colors.text },
});
