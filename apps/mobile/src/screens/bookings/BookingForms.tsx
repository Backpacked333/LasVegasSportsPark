/**
 * The forms a rental or party requires of its booker, signed before booking (Package G booking
 * flow, as SCR-C-13 does for a basket; SPK-REG-009, POL-037, MISSING_ACKNOWLEDGMENT). The offering
 * names its required form versions (`requiredFormPolicyVersionIds`); each one's wording is read
 * from `GET /v1/policy-versions/{id}`, whether the booker has signed it from
 * `GET /v1/acknowledgments?subjectPersonId=` (the API's record), and a signature is recorded with
 * `POST /v1/acknowledgments` for the signed-in person (the API records them as the signer; one
 * idempotency key per form). The API checks the forms again when the booking is sent.
 *
 * States per form: loading; ready (wording, agreement checkbox, "Sign"); signed (with its date);
 * error with the code and "Try again"; not available; offline (signing needs a connection);
 * processing.
 */
import type { ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { useApiRecords, type RecordState } from '../../features/money/records';
import { Body, ButtonRow, Caption, ChoiceRow, Section } from '../../features/money/ui';
import { formatInstantIn } from '../../features/package-g/time';
import type { PolicyVersion } from '../../features/package-g/booking-model';
import { formWording, useFormsStatus } from '../../features/registration/forms';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

function FormRow({
  policyVersionId,
  version,
  selfId,
  signedAt,
  zone,
  onSigned,
}: {
  policyVersionId: string;
  version: RecordState<PolicyVersion> | undefined;
  selfId: string;
  signedAt: string | null;
  zone: string;
  onSigned: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [agreed, setAgreed] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const sign = useApiCommand('post', '/acknowledgments', {
    invalidate: [['api', '/acknowledgments']],
  });
  if (!version || version.loading) return <StateView variant="loading" label="a required form" />;
  if (!version.data) {
    return version.error ? (
      <QueryErrorView error={version.error} onRetry={version.refetch} />
    ) : (
      <StateView variant="unavailable" />
    );
  }
  const title = version.data.title;
  const submit = async () => {
    setFailure(null);
    try {
      await sign.submit({ body: { subjectPersonId: selfId, policyVersionId } });
      onSigned();
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <View testID={`booking-form-${policyVersionId}`}>
      <Body>{title}</Body>
      {formWording(version.data.content).map((text) => (
        <Caption key={text}>{text}</Caption>
      ))}
      {signedAt ? (
        <StatusBadge tone="success" label={`Signed ${formatInstantIn(signedAt, zone)}`} />
      ) : (
        <>
          <ChoiceRow
            mode="checkbox"
            label={`I have read and agree to ${title}`}
            checked={agreed}
            onPress={() => setAgreed(!agreed)}
          />
          {failure ? (
            <CommandFailure
              error={failure}
              what="the signature"
              onRetry={() => void submit()}
              onReload={() => {
                setFailure(null);
                sign.reset();
                version.refetch();
              }}
            />
          ) : null}
          <ButtonRow>
            <Button
              label={`Sign ${title}`}
              onPress={() => void submit()}
              disabled={!agreed || offline}
              busy={sign.isProcessing}
            />
          </ButtonRow>
        </>
      )}
    </View>
  );
}

export function BookingForms({
  policyVersionIds,
  zone,
}: {
  policyVersionIds: readonly string[];
  /** The facility zone signature dates are shown in. */
  zone: string;
}) {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const selfId = me.data?.person?.id ?? null;
  const forms = useFormsStatus(
    selfId ? [{ participantPersonId: selfId, policyVersionIds }] : [],
    selfId !== null,
  );
  const versions = useApiRecords('/policy-versions/{id}', policyVersionIds);
  if (policyVersionIds.length === 0) return null;
  let body;
  if (me.data === undefined) {
    body = me.error ? (
      <QueryErrorView error={me.error} onRetry={() => void me.refetch()} />
    ) : (
      <StateView variant="loading" label="your forms" />
    );
  } else if (selfId === null) {
    body = (
      <StateView
        variant="unavailable"
        title="Finish setting up your account"
        description="Forms are signed by the person booking. Finish account setup first."
      />
    );
  } else if (!forms.known(selfId)) {
    const error = forms.error(selfId);
    body = error ? (
      <QueryErrorView error={error} onRetry={forms.refetch} />
    ) : (
      <StateView variant="loading" label="whether your forms are signed" />
    );
  } else {
    body = policyVersionIds.map((id) => (
      <FormRow
        key={id}
        policyVersionId={id}
        version={versions[id]}
        selfId={selfId}
        signedAt={forms.acknowledgment(selfId, id)?.signedAt ?? null}
        zone={zone}
        onSigned={forms.refetch}
      />
    ));
  }
  return (
    <Section title="Required forms" testID="booking-forms">
      <Caption>These forms must be signed before you book.</Caption>
      {body}
    </Section>
  );
}
