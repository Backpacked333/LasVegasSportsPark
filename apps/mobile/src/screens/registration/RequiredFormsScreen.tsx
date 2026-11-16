/**
 * SCR-C-13 Required forms and acknowledgments (SPK-IAM-003, SPK-REG-009, POL-037,
 * MISSING_ACKNOWLEDGMENT; journeys A4, C2). For every participant of a basket (or of a waitlist
 * offer), lists the required form versions, and records each signature with
 * `POST /v1/acknowledgments`. The Forms step of registering (PA-11, ADR-008): each form is a card
 * with its status and a "Read and sign" button that opens a `Sheet` with the wording, the
 * agreement and the Sign button; signing closes it. From a waitlist offer the steps are not shown.
 *
 * Signer rules: the signed-in customer signs as themselves; the API records them as the signer
 * (the app never sends another signer). An adult signs their own forms; a guardian holding
 * `complete_forms` signs for a child; a child never signs for themselves; staff never sign on a
 * guardian's behalf (staff are not users of this app). Whether the account may sign comes from
 * the API's authorities and is checked again by the API (PARTICIPANT_AUTHORITY_REQUIRED). The
 * wording version is the policy version id; a superseded version is re-presented after reload.
 *
 * Required waivers (SPK-REG-011, proposed amendment PA-01; DEC-095 pending), only while the
 * organization has turned liability waivers on: each offering's required waiver families
 * (`GET /v1/offerings/{id}/required-waivers`) are shown per participant with the API's judgement
 * (`GET /v1/people/{id}/waivers`: accepted, lapsed, not accepted yet) and accepted here with
 * `POST /v1/waiver-acceptances`. A waiver the front desk recorded from paper reads "Recorded from
 * paper", never as a signature. With the switch off nothing of this is shown or asked for.
 *
 * States: loading; empty (no forms required); ready; validation failure (agreement not ticked,
 * version no longer approved); permission restriction (no forms permission for this child);
 * stale (wording superseded: reload); offline (answers kept, signing disabled); processing
 * (signing); success (signed, with date); partial completion per participant.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
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
import { useApiRecords, type RecordState } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { RegistrationSteps } from '../../features/registration/steps';
import { WaiverCard } from '../../features/waivers/WaiverCard';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { ChoiceCard } from '../../ui/ChoiceList';
import { Section } from '../../ui/Section';
import { Sheet } from '../../ui/Sheet';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

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
      waiverTargets: (basket.data?.lines ?? []).map((l): WaiverTarget => ({
        participantPersonId: l.participantPersonId,
        offeringId: l.offeringId,
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
  return {
    query: entry.data ? offering : entry,
    requirements,
    waiverTargets: entry.data
      ? [{ participantPersonId: entry.data.participantPersonId, offeringId: entry.data.offeringId }]
      : [],
  };
}

/** A participant and the offering they register for, whose required waivers are shown. */
interface WaiverTarget {
  participantPersonId: string;
  offeringId: string;
}

/**
 * The waivers the offerings require of each participant (SPK-REG-011, proposed). Rendered only
 * while liability waivers are turned on. When no offering requires one, `whenNone` is shown.
 */
function RequiredWaivers({
  targets,
  selfId,
  nameOf,
  canSignFor,
  offline,
  whenNone = null,
}: {
  targets: readonly WaiverTarget[];
  selfId: string | null;
  nameOf: (personId: string) => string;
  canSignFor: (personId: string) => boolean;
  offline: boolean;
  whenNone?: ReactNode;
}) {
  const offerings = useApiRecords(
    '/offerings/{id}/required-waivers',
    targets.map((t) => t.offeringId),
  );
  const keysOf = new Map<string, string[]>();
  for (const target of targets) {
    const keys = keysOf.get(target.participantPersonId) ?? [];
    for (const waiver of offerings[target.offeringId]?.data?.waivers ?? []) {
      if (!keys.includes(waiver.policyKey)) keys.push(waiver.policyKey);
    }
    keysOf.set(target.participantPersonId, keys);
  }
  const participants = [...keysOf.entries()].filter(([, keys]) => keys.length > 0);
  const people = useApiRecords(
    '/people/{id}/waivers',
    participants.map(([personId]) => personId),
  );
  if (participants.length === 0) {
    const loading = Object.values(offerings).some((o) => o.loading);
    return loading ? <StateView variant="loading" label="required waivers" /> : <>{whenNone}</>;
  }
  return (
    <>
      {participants.map(([personId, keys]) => {
        const name = nameOf(personId);
        const read = people[personId];
        return (
          <Section
            key={personId}
            title={name === 'You' ? 'Your waivers' : `Waivers for ${name}`}
            testID={`required-waivers-${personId}`}
          >
            {read?.error ? (
              <QueryErrorView
                error={read.error}
                onRetry={read.refetch}
                unavailable={{
                  title: 'Waiver not available to you',
                  description:
                    'A guardian with permission to complete forms must accept it, or bring a signed paper to the front desk.',
                }}
              />
            ) : !read?.data ? (
              <Text variant="caption" tone="muted">
                Checking the waiver…
              </Text>
            ) : (
              keys.map((policyKey) => {
                const waiver = read.data?.waivers.find((w) => w.policyKey === policyKey);
                if (!waiver) return null;
                const signedBy = waiver.acceptance?.signedByPersonId ?? null;
                return (
                  <WaiverCard
                    key={policyKey}
                    personId={personId}
                    personName={name}
                    waiver={waiver}
                    signerName={
                      signedBy === selfId ? 'you' : signedBy === personId ? name : 'another adult'
                    }
                    canAccept={canSignFor(personId)}
                    offline={offline}
                    onAccepted={read.refetch}
                  />
                );
              })
            )}
          </Section>
        );
      })}
    </>
  );
}

function FormCard({
  policy: record,
  policyVersionId,
  participantPersonId,
  participantName,
  canSign,
  signedAt,
  offline,
  onSigned,
}: {
  /** The policy version's read: wording, loading or its error (SPK-UX-008). */
  policy: RecordState<PolicyVersion> | undefined;
  policyVersionId: string;
  participantPersonId: string;
  participantName: string;
  canSign: boolean;
  signedAt: string | null;
  offline: boolean;
  onSigned: () => void;
}) {
  const styles = useStyles();
  const { services } = useApp();
  const policy = record?.data;
  const [agreed, setAgreed] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const sign = useApiCommand('post', '/acknowledgments', {
    invalidate: [['api', '/acknowledgments']],
  });
  const title = policy?.title ?? 'Required form';
  const forSelf = participantName === 'You';
  const agreeLabel = forSelf
    ? `I have read "${title}" and agree`
    : `I have read "${title}" and agree for ${participantName}`;

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
      setOpen(false);
      onSigned();
    } catch (error) {
      const apiError = error as ApiError;
      // Already signed (by this or another permitted signer): the record is what counts.
      if (apiError.code === 'RESOURCE_CONFLICT') {
        setOpen(false);
        onSigned();
      } else setFailure(apiError);
    }
  };

  return (
    <View style={styles.card} testID={`form-${policyVersionId}-${participantPersonId}`}>
      <Text variant="headline">{policy ? `${title} (version ${policy.version})` : title}</Text>
      {signedAt ? (
        <StatusBadge tone="success" label={`Signed on ${formatInstant(signedAt)}`} />
      ) : canSign ? (
        <StatusBadge tone="pending" label="Needs your signature" />
      ) : (
        <StatusBadge tone="neutral" label="Needs a guardian who can complete forms" />
      )}
      {policy ? null : record?.error ? (
        <QueryErrorView
          error={record.error}
          onRetry={record.refetch}
          unavailable={{
            title: 'Form wording not available',
            description: 'Ask the front desk about this form.',
          }}
        />
      ) : (
        <Text variant="caption" tone="muted">
          Loading the wording…
        </Text>
      )}
      {!signedAt && canSign && policy ? (
        <View ref={trigger} collapsable={false}>
          <Button
            label={
              forSelf
                ? `Read and sign "${title}"`
                : `Read and sign "${title}" for ${participantName}`
            }
            variant={agreed ? 'primary' : 'secondary'}
            onPress={() => setOpen(true)}
            accessibilityHint="Opens the wording to read, then sign"
          />
        </View>
      ) : null}
      {!signedAt && !canSign ? (
        <Text variant="caption" tone="muted">
          {`Your account cannot sign forms for ${participantName}. A guardian with permission to complete forms must sign.`}
        </Text>
      ) : null}
      {policy && !signedAt && canSign ? (
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          returnFocusTo={trigger}
          footer={
            <>
              <Button
                label={forSelf ? `Sign "${title}"` : `Sign "${title}" for ${participantName}`}
                onPress={() => void submit()}
                disabled={!agreed || offline}
                busy={sign.isProcessing}
                size="lg"
                block
              />
              {offline ? (
                <Text variant="caption" tone="muted">
                  Signing needs a connection. Your answer is kept.
                </Text>
              ) : null}
            </>
          }
        >
          <Text variant="caption" tone="muted">{`Version ${policy.version}`}</Text>
          {formWording(policy.content).map((paragraph, i) => (
            <Text key={`${policyVersionId}-${i}`} variant="body">
              {paragraph}
            </Text>
          ))}
          <ChoiceCard
            option={{ value: 'agree', label: agreeLabel }}
            mode="multiple"
            checked={agreed}
            onPress={() => setAgreed((v) => !v)}
            accessibilityLabel={agreeLabel}
            testID={`agree-${policyVersionId}-${participantPersonId}`}
          />
          <CommandError error={failure} onRetry={() => void submit()} onReload={onSigned} />
        </Sheet>
      ) : null}
    </View>
  );
}

function FormsContent({ source }: { source: FormsSource }) {
  const styles = useStyles();
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const me = useMe();
  const permissions = usePermissions();
  // SPK-REG-011 (proposed): nothing about waivers is shown or asked for while the switch is off.
  const waiversOn = permissions.isCapabilityEnabled('liability_waivers') === true;
  const { query, requirements, waiverTargets } = useRequirements(source);
  const status = useFormsStatus(requirements ?? [], requirements !== undefined);
  const ids = [...new Set((requirements ?? []).flatMap((r) => r.policyVersionIds))];
  const policies = useApiRecords('/policy-versions/{id}', ids, requirements !== undefined);
  const participants = [...new Set((requirements ?? []).map((r) => r.participantPersonId))];
  const names = useParticipantNames(participants);
  const waiverNames = useParticipantNames(waiverTargets.map((t) => t.participantPersonId));

  if (query.error && !query.data) {
    return <QueryErrorView error={query.error} onRetry={() => void query.refetch()} />;
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
  const requiredWaivers = (whenNone?: ReactNode) =>
    waiversOn ? (
      <RequiredWaivers
        targets={waiverTargets}
        selfId={selfId}
        nameOf={waiverNames}
        canSignFor={canSignFor}
        offline={offline}
        whenNone={whenNone}
      />
    ) : (
      (whenNone ?? null)
    );
  if (groups.length === 0) {
    return requiredWaivers(
      <StateView
        variant="empty"
        title="No forms required"
        description="Nothing needs to be signed for this registration."
      />,
    );
  }
  const signed = status.total - status.outstanding;
  const back = source.basketId
    ? () => router.push(registrationRoutes.basket(source.basketId as string))
    : () => router.push(registrationRoutes.waitlist(source.waitlistEntryId as string));

  return (
    <View>
      {source.basketId ? <RegistrationSteps step="Forms" /> : null}
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
        <Text variant="caption" tone="muted">
          You sign as yourself. A guardian signs for a child; staff never sign for you.
        </Text>
      </Section>
      {groups.map(([personId, list]) => {
        const name = names(personId);
        return (
          <Section key={personId} title={name === 'You' ? 'Your forms' : `Forms for ${name}`}>
            {status.error(personId) ? (
              <QueryErrorView error={status.error(personId) as ApiError} onRetry={status.refetch} />
            ) : null}
            {list.map((policyVersionId) => {
              const ack = status.acknowledgment(personId, policyVersionId);
              return (
                <FormCard
                  key={policyVersionId}
                  policy={policies[policyVersionId]}
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
      {requiredWaivers()}
      <View style={styles.actions}>
        <Button
          label={source.basketId ? 'Back to your cart' : 'Back to the waitlist offer'}
          variant={status.outstanding === 0 ? 'primary' : 'secondary'}
          onPress={back}
        />
      </View>
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

const useStyles = makeStyles(({ colors }) => ({
  card: {
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  actions: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.lg },
}));
