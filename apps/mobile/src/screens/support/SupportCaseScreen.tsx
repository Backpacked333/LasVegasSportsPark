/**
 * SCR-C-38 one support request (SPK-SUPPORT-002, SUP-01): `GET /v1/me/cases/{id}` shows the
 * request's category, title, status in words, when it was sent, last updated and resolved. The
 * API shows a customer nothing else (no notes, owner, queue or history, §4.14). Someone else's
 * request, or an id that names nothing, is NOT_FOUND and shown as "not available" with no hint
 * that it exists (§4.10). The record re-reads on return to the app, so a status staff changed
 * meanwhile shows with its age (stale version, §4.15).
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { Body, Caption, Field, Section } from '../../features/money/ui';
import { useSignedIn } from '../../features/today/queries';
import { displayZone, formatWhen } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { CATEGORY_LABELS, caseStatus, caseStatusMeaning, isUuid } from './support-model';

function CaseContent({ caseId }: { caseId: string }) {
  const router = useRouter();
  const zone = displayZone(null);
  const read = useApiQuery({
    path: '/me/cases/{id}',
    request: { path: { id: caseId } },
    enabled: useSignedIn(),
    refetchOnWindowFocus: 'always',
  });
  return (
    <QueryBoundary query={read} label="your request" empty={{ title: '', description: '' }}>
      {(c) => (
        <View testID="support-case">
          <Section title={c.title}>
            <StatusBadge {...caseStatus(c.status)} testID="support-case-status" />
            <Body>{caseStatusMeaning(c.status)}</Body>
            <Field label="About" value={CATEGORY_LABELS[c.category]} />
            <Field label="Sent" value={formatWhen(c.createdAt, zone.zone)} />
            <Field label="Last updated" value={formatWhen(c.updatedAt, zone.zone)} />
            {c.resolvedAt ? (
              <Field label="Resolved" value={formatWhen(c.resolvedAt, zone.zone)} />
            ) : null}
            <Caption>
              Notes and internal details stay with the facility team. A request never replaces a
              change itself: refunds, transfers and permission changes are made as their own
              actions.
            </Caption>
          </Section>
          <View style={styles.pad}>
            <Button
              label="Back to support"
              variant="secondary"
              onPress={() => router.push('/support' as Href)}
            />
          </View>
        </View>
      )}
    </QueryBoundary>
  );
}

export function SupportCaseScreen({ caseId }: { caseId: string | null }) {
  return (
    <Screen>
      <RequireSession what="your support request">
        {caseId ? (
          <CaseContent caseId={caseId} />
        ) : (
          <StateView
            variant="unavailable"
            title="Link not available"
            description="This link does not open a request. Your requests are listed under Support."
          />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/support/[caseId].tsx (an opaque id only). */
export function SupportCaseRoute() {
  const { caseId } = useLocalSearchParams<{ caseId?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Support request' }} />
      <SupportCaseScreen caseId={isUuid(caseId) ? caseId : null} />
    </>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg },
});
