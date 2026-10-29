/**
 * SCR-C-39 Verified link landing (SPK-UX-001 "Verified links into relevant activities and
 * operations", §4.13 "Safe deep-link destinations", §6.2 "Deep links", "Notification opened after
 * its event changes", SPK-AT-027, DEC-061).
 *
 * Every link from outside the app arrives here (src/links/native-intent). The landing validates it
 * against the closed list in src/links/link-targets and then either moves to the target screen
 * (invitation, the open invitations, claim, inbox, account, family, preferences), keeping any
 * token in memory only, or
 * shows the target in its current state (an operation, read now from `GET /v1/operations/{id}`).
 * A link never performs an action: the person confirms on the target screen.
 *
 * States: loading (resolving an operation); empty (target no longer exists: not available);
 * ready (redirect to the target screen, or the operation); validation failure (malformed link:
 * "Link not available"); permission restriction (target in another household: NOT_FOUND, shown as
 * not available with no hint it exists); stale version (the event changed since the link was
 * sent: the current state is shown); offline (cannot resolve, the link is kept, "Try again");
 * processing: not applicable; success: not applicable; partial completion: not permitted; recovery
 * required: not applicable, "Update required" covers the app when the API says the build is no
 * longer supported (UpdateGate, SPK-AT-027).
 */
import type { Schema } from '@sportspark/api-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { holdLinkSecret } from '../../links/link-secrets';
import { resolveLinkParams, type LinkResolution, type LinkTarget } from '../../links/link-targets';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { formatDateTime } from '../account/components/account-data';
import { Paragraph } from '../account/components/forms';

type Operation = Schema<'Operation'>;

/** journeys.md section 3 operation vocabulary: "Processing", "Done", "Failed", "Needs attention". */
export function operationStatus(status: Operation['status']): StatusBadgeProps {
  switch (status) {
    case 'pending':
    case 'running':
      return { tone: 'pending', label: 'Processing' };
    case 'succeeded':
      return { tone: 'success', label: 'Done' };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    case 'recovery_required':
    case 'compensated':
      return { tone: 'warning', label: 'Needs attention' };
  }
}

/** The in-app route for a redirect target; `null` for targets shown on the landing itself. */
export function routeForTarget(target: LinkTarget): string | null {
  switch (target.to) {
    case 'invitation':
      return `/invitations/${target.id}?type=family`;
    case 'team-invitation':
      return `/invitations/${target.id}?type=team`;
    case 'invitations':
      return '/invitations';
    case 'claim':
      return '/onboarding';
    case 'inbox':
      return '/inbox';
    case 'account':
      return '/account';
    case 'family':
      return '/family';
    case 'preferences':
      return '/preferences';
    case 'operation':
      return null;
  }
}

/** Moves a link's token into memory before navigating, so no route carries it. */
export function holdSecretOf(target: LinkTarget): void {
  if (target.to === 'invitation' || target.to === 'team-invitation') {
    holdLinkSecret(target.to, target.token, target.id);
  } else if (target.to === 'claim') {
    holdLinkSecret('claim', target.token);
  }
}

/** Route entry: reads the query and hands navigation to the landing. */
export function LinkLandingRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const router = useRouter();
  const resolution = useMemo(() => resolveLinkParams(params), [params]);
  return <LinkLanding resolution={resolution} navigate={(href) => router.replace(href)} />;
}

export function LinkLanding({
  resolution,
  navigate,
}: {
  resolution: LinkResolution;
  navigate: (href: string) => void;
}) {
  const route = resolution.kind === 'target' ? routeForTarget(resolution.target) : null;
  // One redirect per landing, however often the parent re-renders.
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current || resolution.kind !== 'target' || route === null) return;
    redirected.current = true;
    holdSecretOf(resolution.target);
    navigate(route);
  }, [resolution, route, navigate]);

  if (resolution.kind !== 'target') {
    return (
      <Screen>
        <StateView
          variant="unavailable"
          title="Link not available"
          description={
            resolution.kind === 'malformed'
              ? 'This link is incomplete or damaged. Open it again from the message you received.'
              : 'This link does not open anything in the app. It may be out of date.'
          }
          actionLabel="Go to Home"
          onAction={() => navigate('/')}
        />
      </Screen>
    );
  }
  if (resolution.target.to === 'operation') {
    return (
      <Screen>
        <RequireSession what="this request">
          <OperationLanding operationId={resolution.target.id} navigate={navigate} />
        </RequireSession>
      </Screen>
    );
  }
  return (
    <Screen>
      <StateView variant="loading" label="the link" />
    </Screen>
  );
}

function OperationLanding({
  operationId,
  navigate,
}: {
  operationId: string;
  navigate: (href: string) => void;
}) {
  // Re-read while it is still processing; the interval is a display setting, not a policy.
  const [polling, setPolling] = useState(false);
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: operationId } },
    staleTime: 0,
    refetchInterval: polling ? 5_000 : false,
  });
  const status = operation.data?.status;
  useEffect(() => {
    setPolling(status === 'pending' || status === 'running');
  }, [status]);
  return (
    <QueryBoundary
      query={operation}
      label="the request"
      empty={{ title: 'Nothing to show', description: '' }}
    >
      {(op) => <OperationState operation={op} navigate={navigate} />}
    </QueryBoundary>
  );
}

function OperationState({
  operation,
  navigate,
}: {
  operation: Operation;
  navigate: (href: string) => void;
}) {
  const status = operationStatus(operation.status);
  return (
    <View style={styles.body}>
      <ListRow
        title="Request status"
        detail={`Last changed ${formatDateTime(operation.updatedAt)}`}
        status={status}
        testID="operation-status"
      />
      <Paragraph>This is the current state. It may have changed since the link was sent.</Paragraph>
      {operation.status === 'failed' && operation.error ? (
        <>
          <Paragraph>{operation.error.message}</Paragraph>
          <Paragraph muted>
            {`Error code: ${operation.error.code}${operation.correlationId ? `. Reference: ${operation.correlationId}` : ''}`}
          </Paragraph>
          {/* An operation's error carries no next action, so the recovery is to contact support
              with the reference (SPK-UX-008). */}
          <View style={styles.actions}>
            <Button label="Contact support" onPress={() => navigate('/support')} />
          </View>
        </>
      ) : null}
      {operation.status === 'recovery_required' ? (
        <Paragraph>The facility is resolving this. Do not repeat it.</Paragraph>
      ) : null}
      {operation.status === 'compensated' ? (
        <Paragraph>
          This request was not completed and was reversed. Check your account before trying again.
        </Paragraph>
      ) : null}
      <View style={styles.actions}>
        <Button label="Open the inbox" variant="secondary" onPress={() => navigate('/inbox')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingTop: spacing.md },
  actions: { paddingHorizontal: spacing.lg },
});
