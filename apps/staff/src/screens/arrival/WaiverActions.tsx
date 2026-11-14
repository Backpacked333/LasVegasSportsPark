/**
 * What the desk can do about a missing required form on a held check-in (SPK-ENTRY-004
 * `missing_acknowledgment`, SPK-REG-009, §4.4 Acknowledgment). Forms and acknowledgments belong to
 * the catalog module; this screen only uses its commands.
 *
 * - "Sign on this tablet": the signer is present at the desk and reads the form here. The form is
 *   the approved policy version (`GET /v1/policy-versions/{id}`). The signer is the adult
 *   participant or an adult holding `complete_forms` over the participant, from
 *   `GET /v1/people/{id}/authority`; staff record that named signer
 *   (`POST /v1/acknowledgments` with `signedByPersonId`) and never sign themselves (SPK-REG-009:
 *   the API refuses a staff signer). Then the check-in is evaluated again ("Check again").
 * - "Send a form link": not offered. No messaging channel is approved (DEC-012, DEC-062), so the
 *   pending decision is shown instead.
 * - "Override with reason": not offered. Admitting without a required form needs an approved
 *   policy, and none is recorded; the issue stays blocking (SPK-ENTRY-004).
 *
 * A required liability waiver (SPK-REG-011, proposed amendment PA-01; issues `waiver_missing` and
 * `waiver_lapsed`, present only while the organization has turned liability waivers on) gets its
 * own group, on a held and on an admitted check-in alike:
 *
 * - "Sign on this tablet": a digital acceptance by the named signer (staff never sign).
 * - "Record paper waiver": a staff entry in the staff member's name with the date on the paper;
 *   never shown as the customer's digital signature (SPK-REG-009).
 * - "Override with reason": only for a waiver that blocks. The approved waiver names the roles
 *   that may override; the API refuses any other role, and that refusal is shown.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import { CheckboxField, SelectField, TextAreaField } from '../../features/operations/fields';
import {
  ACCEPT_WAIVER_ACTION,
  WaiverAcceptanceForm,
} from '../../features/waivers/WaiverAcceptanceForm';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';

type SessionCheckin = Schema<'SessionCheckin'>;

const RECORD_ACKNOWLEDGMENT = 'catalog.record_acknowledgment';
const OVERRIDE_WAIVER = 'catalog.override_waiver';

export interface WaiverIssue {
  code: 'waiver_missing' | 'waiver_lapsed';
  /** The waiver version in force, the one that would be accepted. */
  policyVersionId: string;
  blocking: boolean;
}

/** The required waivers a check-in found missing or lapsed (SPK-REG-011, proposed). */
export function waiverIssues(checkin: SessionCheckin): WaiverIssue[] {
  const out: WaiverIssue[] = [];
  for (const issue of checkin.issues) {
    if (issue.code !== 'waiver_missing' && issue.code !== 'waiver_lapsed') continue;
    if (issue.reference?.type !== 'policy_version') continue;
    out.push({
      code: issue.code,
      policyVersionId: issue.reference.id,
      blocking: issue.severity === 'blocking',
    });
  }
  return out;
}

/** The policy versions a held check-in is missing an acknowledgment of. */
export function missingForms(checkin: SessionCheckin): string[] {
  return checkin.issues
    .filter((i) => i.code === 'missing_acknowledgment' && i.reference?.type === 'policy_version')
    .map((i) => i.reference!.id);
}

/** Readable text of a policy version's content, when it carries any. */
function formText(content: Record<string, unknown>): string | null {
  for (const key of ['text', 'body', 'summary', 'description']) {
    const value = content[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function TabletSigning({
  personId,
  policyVersionId,
  onSigned,
  onCancel,
}: {
  personId: string;
  policyVersionId: string;
  onSigned: () => void;
  onCancel: () => void;
}) {
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: policyVersionId } },
  });
  const subject = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: personId } },
  });
  const [signer, setSigner] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const record = useApiCommand('post', '/acknowledgments');

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
  const title = policy.data?.title ?? 'Required form';
  const text = policy.data ? formText(policy.data.content) : null;
  const signerName = signers.find((s) => s.value === signer)?.label ?? 'The signer';

  const submit = () => {
    if (!signer || !confirmed) return;
    void record
      .submit({
        body: {
          subjectPersonId: personId,
          policyVersionId,
          signedByPersonId: signer,
          evidence: { method: 'desk_tablet', signerPresent: true },
        },
      })
      .then(() => onSigned())
      .catch(() => undefined);
  };

  return (
    <div className="waiver-tablet" role="group" aria-label={`Sign ${title} on this tablet`}>
      <h5>{title}</h5>
      {policy.error ? (
        <CommandError error={policy.error} subject="This form" />
      ) : text ? (
        <p className="waiver-text">{text}</p>
      ) : (
        <p className="caption">
          {policy.data
            ? 'This form has no text to show here; hand the signer the approved form.'
            : 'Reading the form…'}
        </p>
      )}
      {authority.error ? (
        <CommandError error={authority.error} subject="Who may sign" />
      ) : signers.length === 0 && authority.data && subject.data ? (
        <StateView
          variant="unavailable"
          title="Nobody here may sign"
          description="No adult holds permission to complete forms for this participant. Their guardian has to sign."
        />
      ) : (
        <SelectField
          label="Who is signing"
          value={signer}
          onChange={setSigner}
          options={signers}
          placeholder="Choose the signer"
          hint="Only the adult participant or an adult who may complete forms for them. Staff never sign."
        />
      )}
      <CheckboxField
        label={`${signerName} read this form on this tablet and accepts it`}
        checked={confirmed}
        onChange={setConfirmed}
      />
      <div className="ops-actions">
        <Button busy={record.isProcessing} disabled={!signer || !confirmed} onClick={submit}>
          Record signature
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {record.error ? (
        <CommandError
          error={record.error}
          onRetry={() => void record.resend()}
          subject="This signature"
        />
      ) : null}
    </div>
  );
}

/** Records that a permitted role lets the participant in although the waiver rule blocks. */
function WaiverOverrideForm({
  checkin,
  policyVersionId,
  onRecorded,
  onCancel,
}: {
  checkin: SessionCheckin;
  policyVersionId: string;
  onRecorded: () => void;
  onCancel: () => void;
}) {
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: policyVersionId } },
  });
  const [reason, setReason] = useState('');
  const record = useApiCommand('post', '/waiver-overrides');
  const activity =
    checkin.activity.type === 'session' && checkin.activity.sessionId
      ? ({ type: 'offering_session', id: checkin.activity.sessionId } as const)
      : ({
          type: 'scheduling_event',
          id: checkin.activity.eventId ?? checkin.activity.id,
        } as const);
  const ready = policy.data !== undefined && reason.trim().length > 0;
  const submit = () => {
    if (!ready || !policy.data) return;
    void record
      .submit({
        body: {
          personId: checkin.personId,
          policyKey: policy.data.key,
          activity,
          reason: reason.trim(),
        },
      })
      .then(() => onRecorded())
      .catch(() => undefined);
  };
  return (
    <div className="waiver-tablet" role="group" aria-label="Override the waiver for this activity">
      <TextAreaField
        label="Why is this participant let in without a current waiver?"
        value={reason}
        onChange={setReason}
        required
        rows={2}
        hint="Kept with your name on the person's record. It covers this activity only, and the waiver stays missing until it is accepted."
      />
      <div className="ops-actions">
        <Button busy={record.isProcessing} disabled={!ready} onClick={submit}>
          Record override
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {record.error ? (
        <CommandError
          error={record.error}
          onRetry={() => void record.resend()}
          subject="This override"
        />
      ) : null}
    </div>
  );
}

function WaiverIssueActions({
  checkin,
  onRecheck,
}: {
  checkin: SessionCheckin;
  onRecheck?: () => void;
}) {
  const { online } = useApp();
  const permissions = usePermissions();
  const issues = waiverIssues(checkin);
  const [open, setOpen] = useState<{
    policyVersionId: string;
    mode: 'tablet' | 'paper' | 'override';
  } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  if (checkin.status === 'withdrawn' || issues.length === 0) return null;
  const mayAccept = permissions.isPermitted(ACCEPT_WAIVER_ACTION) === true;
  const mayOverride = permissions.isPermitted(OVERRIDE_WAIVER) === true;
  const done = (message: string) => {
    setOpen(null);
    setOutcome(message);
    // Only a held check-in is evaluated again; an admitted one keeps its record.
    if (checkin.status === 'held') onRecheck?.();
  };
  return (
    <div className="waiver-actions" role="group" aria-label="Liability waiver">
      {open?.mode === 'override' ? (
        <WaiverOverrideForm
          checkin={checkin}
          policyVersionId={open.policyVersionId}
          onCancel={() => setOpen(null)}
          onRecorded={() => done('Override recorded')}
        />
      ) : open ? (
        <WaiverAcceptanceForm
          personId={checkin.personId}
          policyVersionId={open.policyVersionId}
          mode={open.mode}
          onCancel={() => setOpen(null)}
          onRecorded={() =>
            done(open.mode === 'paper' ? 'Paper waiver recorded' : 'Waiver acceptance recorded')
          }
        />
      ) : outcome ? null : (
        issues.map((issue) => (
          <div className="ops-actions" key={`${issue.code}-${issue.policyVersionId}`}>
            <Button
              variant="secondary"
              disabled={!online || !mayAccept}
              onClick={() => setOpen({ policyVersionId: issue.policyVersionId, mode: 'tablet' })}
            >
              Sign waiver on this tablet
            </Button>
            <Button
              variant="secondary"
              disabled={!online || !mayAccept}
              onClick={() => setOpen({ policyVersionId: issue.policyVersionId, mode: 'paper' })}
            >
              Record paper waiver
            </Button>
            {issue.blocking ? (
              <Button
                variant="secondary"
                disabled={!online || !mayOverride}
                onClick={() =>
                  setOpen({ policyVersionId: issue.policyVersionId, mode: 'override' })
                }
              >
                Override with reason
              </Button>
            ) : null}
          </div>
        ))
      )}
      {outcome ? <CommandSuccess label={outcome} /> : null}
      {!mayAccept ? (
        <p className="caption">Recording a waiver is not available to your role.</p>
      ) : null}
      <p className="caption">
        Proposed rule (DEC-095 pending): whether a missing waiver warns or blocks, and who may
        override a block, is what the approved waiver says. A paper waiver is always recorded as a
        staff entry with the date on the paper.
      </p>
    </div>
  );
}

export function WaiverActions(props: { checkin: SessionCheckin; onRecheck?: () => void }) {
  return (
    <>
      <MissingFormActions {...props} />
      <WaiverIssueActions {...props} />
    </>
  );
}

function MissingFormActions({
  checkin,
  onRecheck,
}: {
  checkin: SessionCheckin;
  onRecheck?: () => void;
}) {
  const { online } = useApp();
  const permissions = usePermissions();
  const forms = missingForms(checkin);
  const [signing, setSigning] = useState<string | null>(null);
  const [signed, setSigned] = useState<string[]>([]);
  if (checkin.status !== 'held' || forms.length === 0) return null;
  const mayRecord = permissions.isPermitted(RECORD_ACKNOWLEDGMENT) === true;
  return (
    <div className="waiver-actions" role="group" aria-label="Missing form">
      {signing ? (
        <TabletSigning
          personId={checkin.personId}
          policyVersionId={signing}
          onCancel={() => setSigning(null)}
          onSigned={() => {
            setSigned((s) => [...s, signing]);
            setSigning(null);
            onRecheck?.();
          }}
        />
      ) : (
        <div className="ops-actions">
          {forms
            .filter((f) => !signed.includes(f))
            .map((f, i) => (
              <Button
                key={f}
                variant="secondary"
                disabled={!online || !mayRecord}
                onClick={() => setSigning(f)}
              >
                {forms.length > 1 ? `Sign form ${i + 1} on this tablet` : 'Sign on this tablet'}
              </Button>
            ))}
        </div>
      )}
      {signed.length > 0 ? <CommandSuccess label="Signature recorded; checked again" /> : null}
      {!mayRecord ? (
        <p className="caption">Recording a signature is not available to your role.</p>
      ) : null}
      <p className="caption">
        Sending a form link waits on the messaging channel decision (DEC-012, DEC-062). No override
        is offered: admitting without a required form needs an approved policy, and none is
        recorded.
      </p>
    </div>
  );
}
