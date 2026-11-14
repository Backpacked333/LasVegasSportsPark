/**
 * One liability waiver of one person (SPK-REG-011, proposed amendment PA-01; SPK-REG-009):
 * whether it is accepted, lapsed or not accepted yet, how the acceptance on record was given, the
 * wording on request, and accepting it (`POST /v1/waiver-acceptances`).
 *
 * The signed-in person accepts as themselves, for themselves or for a child they may complete
 * forms for; the app never sends another signer and never records a paper waiver (that is a
 * front-desk entry, and it is shown here as "recorded from paper", never as a signature). Whether
 * the account may accept is decided by the API and checked again on every request.
 */
import type { ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { makeStyles, spacing } from '../../ui/theme';
import { CommandError } from '../registration/CommandError';
import { formWording } from '../registration/forms';
import { Body, ChoiceRow } from '../registration/ui';
import {
  PERSON_WAIVERS_KEY,
  WAIVER_STATUS,
  acceptanceDetail,
  formatCalendarDate,
  waiverReason,
  type PersonWaiver,
} from './waivers';

export interface WaiverCardProps {
  personId: string;
  /** "You", or the participant's given name. */
  personName: string;
  waiver: PersonWaiver;
  /** The display name of the person who accepted the acceptance on record ("you" for the account). */
  signerName: string;
  /** Whether this account may accept for the person (an adult themselves, or `complete_forms`). */
  canAccept: boolean;
  offline: boolean;
  onAccepted?: () => void;
}

export function WaiverCard({
  personId,
  personName,
  waiver,
  signerName,
  canAccept,
  offline,
  onAccepted,
}: WaiverCardProps) {
  const styles = useStyles();
  const { services } = useApp();
  const [showWording, setShowWording] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const version = waiver.currentVersion;
  const needsAccepting = waiver.status !== 'current' && version !== null;
  const wordingWanted = showWording || (needsAccepting && canAccept);
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: version?.policyVersionId ?? '' } },
    enabled: version !== null && wordingWanted,
  });
  const accept = useApiCommand('post', '/waiver-acceptances', {
    invalidate: [PERSON_WAIVERS_KEY, ['api', '/acknowledgments']],
  });
  const status = WAIVER_STATUS[waiver.status];
  const reason = waiverReason(waiver);
  const wording = policy.data ? formWording(policy.data.content) : [];
  const forWhom = personName === 'You' ? '' : ` for ${personName}`;
  const testKey = `${waiver.policyKey}-${personId}`;

  const submit = async () => {
    setFailure(null);
    try {
      await accept.submit({
        body: {
          subjectPersonId: personId,
          policyKey: waiver.policyKey,
          policyVersionId: version?.policyVersionId,
          method: 'digital',
          evidence: { channel: 'customer_app', appVersion: services.config.appVersion },
        },
      });
      setAgreed(false);
      onAccepted?.();
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  return (
    <View style={styles.card} testID={`waiver-${testKey}`}>
      <Body>{version ? `${waiver.title} (version ${version.version})` : waiver.title}</Body>
      <StatusBadge tone={status.tone} label={status.label} testID={`waiver-status-${testKey}`} />
      {reason ? <Body muted>{reason}</Body> : null}
      {waiver.acceptance ? (
        <Body muted>{acceptanceDetail(waiver.acceptance, signerName)}</Body>
      ) : null}
      {waiver.validUntil ? (
        <Body muted>{`Counts until ${formatCalendarDate(waiver.validUntil)}.`}</Body>
      ) : null}
      {version && !(needsAccepting && canAccept) ? (
        <Button
          label={showWording ? 'Hide wording' : 'Show wording'}
          variant="secondary"
          onPress={() => setShowWording((v) => !v)}
          accessibilityHint="The wording of the version in force"
        />
      ) : null}
      {wordingWanted ? (
        policy.data ? (
          <View testID={`waiver-wording-${testKey}`}>
            {wording.map((paragraph, index) => (
              <Body key={index}>{paragraph}</Body>
            ))}
          </View>
        ) : policy.error ? (
          <Body muted>{`The wording could not be loaded (${policy.error.code}).`}</Body>
        ) : (
          <Body muted>Loading the wording…</Body>
        )
      ) : null}
      {needsAccepting && canAccept && policy.data ? (
        <>
          <ChoiceRow
            label={`I have read "${waiver.title}" and accept it${forWhom}`}
            checked={agreed}
            onToggle={() => setAgreed((v) => !v)}
            testID={`waiver-agree-${testKey}`}
          />
          <Button
            label={`Accept "${waiver.title}"${forWhom}`}
            onPress={() => void submit()}
            disabled={!agreed || offline}
            busy={accept.isProcessing}
          />
          {offline ? <Body muted>Accepting needs a connection. Your answer is kept.</Body> : null}
        </>
      ) : null}
      {needsAccepting && !canAccept ? (
        <Body muted>
          {`Your account cannot accept this${forWhom}. A guardian with permission to complete forms must accept it, or bring a signed paper to the front desk.`}
        </Body>
      ) : null}
      <CommandError error={failure} onRetry={() => void submit()} onReload={onAccepted} />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
}));
