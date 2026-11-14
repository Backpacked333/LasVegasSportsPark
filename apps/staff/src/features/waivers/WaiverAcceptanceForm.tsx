/**
 * Recording a liability waiver acceptance at the desk (SPK-REG-011, proposed amendment PA-01;
 * SPK-REG-009). Two ways, and they are never mixed up:
 *
 * - "tablet": the signer is at the desk, reads the waiver here and accepts it. It is a digital
 *   acceptance by the named signer; staff assist and never sign (the API refuses a staff signer).
 * - "paper": staff hold a signed paper. It is recorded as a staff entry in the staff member's own
 *   name with the date written on the paper (`method: 'paper'`, `paperDatedOn`), and is shown
 *   everywhere as "recorded from paper", never as the customer's digital signature.
 *
 * The signer is the adult participant, or an adult holding `complete_forms` over the participant
 * (`GET /v1/people/{id}/authority`). The waiver is the approved version (`GET
 * /v1/policy-versions/{id}`); the command is `POST /v1/waiver-acceptances`.
 */
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../operations/feedback';
import { CheckboxField, SelectField, TextField } from '../operations/fields';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';

export const ACCEPT_WAIVER_ACTION = 'catalog.accept_waiver';
export const PERSON_WAIVERS_KEY = ['api', '/people/{id}/waivers'] as const;

/** Readable text of a policy version's content, when it carries any. */
export function waiverText(content: Record<string, unknown>): string | null {
  for (const key of ['text', 'body', 'summary', 'description']) {
    const value = content[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** The people who may sign for the participant: the adult themselves, or a `complete_forms` holder. */
export function useSigners(personId: string) {
  const subject = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: personId } },
  });
  const signers: { value: string; label: string }[] = [];
  if (subject.data?.kind === 'adult') {
    signers.push({
      value: personId,
      label: `${subject.data.givenName} ${subject.data.familyName} (the participant)`.trim(),
    });
  }
  const seen = new Set<string>();
  for (const g of authority.data?.grants ?? []) {
    if (
      g.subjectPersonId === personId &&
      g.permission === 'complete_forms' &&
      g.status === 'effective' &&
      !g.underReview &&
      !seen.has(g.actorPersonId)
    ) {
      seen.add(g.actorPersonId);
      signers.push({
        value: g.actorPersonId,
        label: `${g.actorDisplayName ?? 'An adult'} (${g.relationshipKind})`,
      });
    }
  }
  return {
    signers,
    error: authority.error ?? null,
    loaded: authority.data !== undefined && subject.data !== undefined,
  };
}

export function WaiverAcceptanceForm({
  personId,
  policyVersionId,
  mode,
  onRecorded,
  onCancel,
}: {
  personId: string;
  policyVersionId: string;
  mode: 'tablet' | 'paper';
  onRecorded: () => void;
  onCancel: () => void;
}) {
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: policyVersionId } },
  });
  const { signers, error: signersError, loaded } = useSigners(personId);
  const [signer, setSigner] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [paperDate, setPaperDate] = useState('');
  const record = useApiCommand('post', '/waiver-acceptances', {
    invalidate: [PERSON_WAIVERS_KEY],
  });

  const title = policy.data?.title ?? 'Liability waiver';
  const text = policy.data ? waiverText(policy.data.content) : null;
  const signerName = signers.find((s) => s.value === signer)?.label ?? 'The signer';
  const ready =
    policy.data !== undefined && signer !== '' && confirmed && (mode === 'tablet' || paperDate);

  const submit = () => {
    if (!ready || !policy.data) return;
    void record
      .submit({
        body:
          mode === 'paper'
            ? {
                subjectPersonId: personId,
                policyKey: policy.data.key,
                policyVersionId,
                method: 'paper',
                paperDatedOn: paperDate,
                signedByPersonId: signer,
              }
            : {
                subjectPersonId: personId,
                policyKey: policy.data.key,
                policyVersionId,
                method: 'digital',
                signedByPersonId: signer,
                evidence: { method: 'desk_tablet', signerPresent: true },
              },
      })
      .then(() => onRecorded())
      .catch(() => undefined);
  };

  return (
    <div
      className="waiver-tablet"
      role="group"
      aria-label={mode === 'paper' ? `Record a paper ${title}` : `Sign ${title} on this tablet`}
    >
      <h5>{title}</h5>
      {policy.error ? (
        <CommandError error={policy.error} subject="This waiver" />
      ) : mode === 'paper' ? (
        <p className="caption">
          Recorded as a staff entry in your name, with the date on the paper. It is shown as
          recorded from paper, never as the customer&apos;s digital signature.
        </p>
      ) : text ? (
        <p className="waiver-text">{text}</p>
      ) : (
        <p className="caption">
          {policy.data
            ? 'This waiver has no text to show here; hand the signer the approved waiver.'
            : 'Reading the waiver…'}
        </p>
      )}
      {signersError ? (
        <CommandError error={signersError} subject="Who may sign" />
      ) : signers.length === 0 && loaded ? (
        <StateView
          variant="unavailable"
          title="Nobody here may sign"
          description="No adult holds permission to complete forms for this participant. Their guardian has to sign."
        />
      ) : (
        <SelectField
          label={mode === 'paper' ? 'Who signed the paper' : 'Who is signing'}
          value={signer}
          onChange={setSigner}
          options={signers}
          placeholder="Choose the signer"
          hint="Only the adult participant or an adult who may complete forms for them. Staff never sign."
        />
      )}
      {mode === 'paper' ? (
        <TextField
          label="Date on the paper"
          type="date"
          value={paperDate}
          onChange={setPaperDate}
          required
          hint="The date written on the signed paper, not today's date unless it was signed today."
        />
      ) : null}
      <CheckboxField
        label={
          mode === 'paper'
            ? `I have the paper signed by ${signerName} in front of me`
            : `${signerName} read this waiver on this tablet and accepts it`
        }
        checked={confirmed}
        onChange={setConfirmed}
      />
      <div className="ops-actions">
        <Button busy={record.isProcessing} disabled={!ready} onClick={submit}>
          {mode === 'paper' ? 'Record paper waiver' : 'Record acceptance'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {record.error ? (
        <CommandError
          error={record.error}
          onRetry={() => void record.resend()}
          subject="This waiver acceptance"
        />
      ) : null}
    </div>
  );
}
