/**
 * SCR-C-13 Required forms and acknowledgments (SPK-IAM-003, SPK-REG-009, POL-037,
 * MISSING_ACKNOWLEDGMENT; journeys A4, C2). For every participant of a basket (or of a waitlist
 * offer), lists the required form versions with their wording, and records each signature with
 * `POST /v1/acknowledgments`.
 *
 * Signer rules: the signed-in customer signs as themselves; the API records them as the signer
 * (the app never sends another signer). An adult signs their own forms; a guardian holding
 * `complete_forms` signs for a child; a child never signs for themselves; staff never sign on a
 * guardian's behalf (staff are not users of this app). Whether the account may sign comes from
 * the API's authorities and is checked again by the API (PARTICIPANT_AUTHORITY_REQUIRED). The
 * wording version is the policy version id; a superseded version is re-presented after reload.
 *
 * States: loading; empty (no forms required); ready; validation failure (agreement not ticked,
 * version no longer approved); permission restriction (no forms permission for this child);
 * stale (wording superseded: reload); offline (answers kept, signing disabled); processing
 * (signing); success (signed, with date); partial completion per participant.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import {
  formWording,
  useFormsStatus,
  type FormRequirement,
} from '../../features/registration/forms';
import { formatInstant } from '../../features/registration/format';
import { useMe, useParticipantNames } from '../../features/registration/participants';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { Body, ButtonRow, ChoiceRow, Section } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type PolicyVersion = Schema<'PolicyVersion'>;

export interface FormsSource {
  basketId?: string;
  waitlistEntryId?: string;
}

/** The requirements of the source, or `undefined` while they load. */
function useRequirements(source: FormsSource) {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: source.basketId ?? '' } },
    enabled: signedIn && source.basketId !== undefined,
  });
  const entry = useApiQuery({
    path: '/waitlist-entries/{id}',
    request: { path: { id: source.waitlistEntryId ?? '' } },
    enabled: signedIn && source.waitlistEntryId !== undefined,
  });
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: entry.data?.offeringId ?? '' } },
    enabled: entry.data !== undefined,
  });
  if (source.basketId) {
    return {
      query: basket,
      requirements: basket.data?.lines.map((l): FormRequirement => ({
        participantPersonId: l.participantPersonId,
        policyVersionIds: l.policies.requiredFormPolicyVersionIds,
      })),
    };
  }
  const requirements =
    entry.data && offering.data
      ? [
          {
            participantPersonId: entry.data.participantPersonId,
            policyVersionIds: offering.data.requiredFormPolicyVersionIds,
          },
        ]
      : undefined;
  return { query: entry.data ? offering : entry, requirements };
}

function FormCard({
  policy,
  policyVersionId,
  participantPersonId,
  participantName,
  canSign,
  signedAt,
  offline,
  onSigned,
}: {
  policy: PolicyVersion | undefined;
  policyVersionId: string;
  participantPersonId: string;
  participantName: string;
  canSign: boolean;
  signedAt: string | null;
  offline: boolean;
  onSigned: () => void;
}) {
  const { services } = useApp();
  const [agreed, setAgreed] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const sign = useApiCommand('post', '/acknowledgments', {
    invalidate: [['api', '/acknowledgments']],
  });
  const title = policy?.title ?? 'Required form';

  const submit = async () => {
    setFailure(null);
    try {
      await sign.submit({
        body: {
          subjectPersonId: participantPersonId,
          policyVersionId,
          evidence: { channel: 'customer_app', appVersion: services.config.appVersion },
        },
      });
      onSigned();
    } catch (error) {
      const apiError = error as ApiError;
      // Already signed (by this or another permitted signer): the record is what counts.
      if (apiError.code === 'RESOURCE_CONFLICT') onSigned();
      else setFailure(apiError);
    }
  };

  return (
    <View style={styles.card} testID={`form-${policyVersionId}-${participantPersonId}`}>
      <Body>{policy ? `${title} (version ${policy.version})` : title}</Body>
      {signedAt ? (
        <StatusBadge tone="success" label={`Signed on ${formatInstant(signedAt)}`} />
      ) : canSign ? (
        <StatusBadge tone="pending" label="Needs your signature" />
      ) : (
        <StatusBadge tone="neutral" label="Needs a guardian who can complete forms" />
      )}
      {policy ? (
        formWording(policy.content).map((paragraph, i) => (
          <Body key={`${policyVersionId}-${i}`}>{paragraph}</Body>
        ))
      ) : (
        <Body muted>Loading the wording…</Body>
      )}
      {!signedAt && canSign && policy ? (
        <>
          <ChoiceRow
            label={
              participantName === 'You'
                ? `I have read "${title}" and agree`
                : `I have read "${title}" and agree for ${participantName}`
            }
            checked={agreed}
            onToggle={() => setAgreed((v) => !v)}
            testID={`agree-${policyVersionId}-${participantPersonId}`}
          />
          <Button
            label={
              participantName === 'You'
                ? `Sign "${title}"`
                : `Sign "${title}" for ${participantName}`
            }
            onPress={() => void submit()}
            disabled={!agreed || offline}
            busy={sign.isProcessing}
          />
          {offline ? <Body muted>Signing needs a connection. Your answer is kept.</Body> : null}
        </>
      ) : null}
      {!signedAt && !canSign ? (
        <Body muted>
          {`Your account cannot sign forms for ${participantName}. A guardian with permission to complete forms must sign.`}
        </Body>
      ) : null}
      <CommandError error={failure} onRetry={() => void submit()} onReload={onSigned} />
    </View>
  );
}

function FormsContent({ source }: { source: FormsSource }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const me = useMe();
  const { query, requirements } = useRequirements(source);
  const status = useFormsStatus(requirements ?? [], requirements !== undefined);
  const ids = [...new Set((requirements ?? []).flatMap((r) => r.policyVersionIds))];
  const policies = useApiRecords('/policy-versions/{id}', ids, requirements !== undefined);
  const participants = [...new Set((requirements ?? []).map((r) => r.participantPersonId))];
  const names = useParticipantNames(participants);

  if (query.error && !query.data) {
    return <CommandError error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (requirements === undefined || me.isPending) {
    return <StateView variant="loading" label="required forms" />;
  }
  const selfId = me.data?.person?.id ?? null;
  const canSignFor = (personId: string) =>
    personId === selfId
      ? me.data?.person?.kind === 'adult'
      : (me.data?.authorities ?? []).some(
          (a) => a.subjectPersonId === personId && a.permissions.includes('complete_forms'),
        );
  const byParticipant = new Map<string, string[]>();
  for (const r of requirements) {
    const list = byParticipant.get(r.participantPersonId) ?? [];
    r.policyVersionIds.forEach((id) => (list.includes(id) ? null : list.push(id)));
    byParticipant.set(r.participantPersonId, list);
  }
  const groups = [...byParticipant.entries()].filter(([, list]) => list.length > 0);
  if (groups.length === 0) {
    return (
      <StateView
        variant="empty"
        title="No forms required"
        description="Nothing needs to be signed for this registration."
      />
    );
  }
  const signed = status.total - status.outstanding;
  const back = source.basketId
    ? () => router.push(registrationRoutes.basket(source.basketId as string))
    : () => router.push(registrationRoutes.waitlist(source.waitlistEntryId as string));

  return (
    <View>
      <Section title="Required forms">
        <StatusBadge
          tone={status.outstanding === 0 && !status.loading ? 'success' : 'pending'}
          label={
            status.loading
              ? 'Checking which forms are signed'
              : status.outstanding === 0
                ? 'All required forms are signed'
                : `${signed} of ${status.total} forms signed`
          }
          testID="forms-summary"
        />
        <Body muted>
          You sign as yourself. A guardian signs for a child; staff never sign for you.
        </Body>
      </Section>
      {groups.map(([personId, list]) => {
        const name = names(personId);
        return (
          <Section key={personId} title={name === 'You' ? 'Your forms' : `Forms for ${name}`}>
            {status.error(personId) ? (
              <CommandError error={status.error(personId)} onRetry={status.refetch} />
            ) : null}
            {list.map((policyVersionId) => {
              const ack = status.acknowledgment(personId, policyVersionId);
              return (
                <FormCard
                  key={policyVersionId}
                  policy={policies[policyVersionId]?.data}
                  policyVersionId={policyVersionId}
                  participantPersonId={personId}
                  participantName={name}
                  canSign={canSignFor(personId)}
                  signedAt={ack?.signedAt ?? null}
                  offline={offline}
                  onSigned={status.refetch}
                />
              );
            })}
          </Section>
        );
      })}
      <ButtonRow>
        <Button
          label={source.basketId ? 'Back to your basket' : 'Back to the waitlist offer'}
          variant={status.outstanding === 0 ? 'primary' : 'secondary'}
          onPress={back}
        />
      </ButtonRow>
    </View>
  );
}

export function RequiredFormsScreen(props: FormsSource) {
  return (
    <Screen>
      <RequireSession what="required forms">
        {props.basketId || props.waitlistEntryId ? (
          <FormsContent source={props} />
        ) : (
          <StateView variant="unavailable" />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/forms.tsx (`?basketId=` or `?waitlistEntryId=`). */
export function RequiredFormsRoute() {
  const params = useLocalSearchParams<{ basketId?: string; waitlistEntryId?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Required forms' }} />
      <RequiredFormsScreen
        basketId={param(params.basketId)}
        waitlistEntryId={param(params.waitlistEntryId)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
