/**
 * SCR-S-22 Open a disputed-access review (SPK-IAM-005, DEC-004). Records the subject, the reason,
 * the parties, evidence references (references only, never files), the owning role and an
 * optional end of the review's effect. The review owner is chosen explicitly. Membership of a
 * household is not evidence. Validation runs before the command; the command carries an
 * idempotency key per unchanged input and the form keeps its input on failure.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, fieldErrorsOf } from '../../ui/CommandFeedback';
import { SelectField, TextAreaField, TextField } from '../../ui/FormFields';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { localInputToIso } from '../../ui/time';

export const REVIEW_OWNER_ROLES = [
  { value: 'support_operator', label: 'support_operator' },
  { value: 'general_manager', label: 'general_manager' },
  { value: 'system_administrator', label: 'system_administrator' },
] as const;
export type ReviewOwnerRole = (typeof REVIEW_OWNER_ROLES)[number]['value'];

interface PartyInput {
  personId: string;
  description: string;
}
interface EvidenceInput {
  type: string;
  reference: string;
  note: string;
}

export function OpenAccessReviewScreen() {
  const { online } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialSubject = params.get('subject') ?? '';
  const [subject, setSubject] = useState(isUuid(initialSubject) ? initialSubject : '');
  const [reason, setReason] = useState('');
  const [ownerRole, setOwnerRole] = useState('');
  const [until, setUntil] = useState('');
  const [parties, setParties] = useState<PartyInput[]>([]);
  const [evidence, setEvidence] = useState<EvidenceInput[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const openReview = useApiCommand('post', '/access-reviews');
  const apiErrors = fieldErrorsOf(openReview.error);

  const submit = () => {
    const problems: Record<string, string> = {};
    const s = referenceError(subject, true);
    if (s) problems['subject'] = s;
    if (!reason.trim()) problems['reason'] = 'Say what access is disputed and why.';
    if (!ownerRole) problems['ownerRole'] = 'Choose who owns the review.';
    parties.forEach((p, i) => {
      if (!p.description.trim()) problems[`party-${i}`] = 'Describe this party.';
      const pe = referenceError(p.personId, false);
      if (pe) problems[`party-person-${i}`] = pe;
    });
    evidence.forEach((e, i) => {
      if (!e.type.trim() || !e.reference.trim()) {
        problems[`evidence-${i}`] = 'Give the evidence type and its reference.';
      }
    });
    const effectiveTo = localInputToIso(until);
    if (until && !effectiveTo) problems['until'] = 'Enter a valid date and time.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void openReview
      .submit({
        body: {
          subjectPersonId: subject.trim().toLowerCase(),
          reason: reason.trim(),
          ownerRole: ownerRole as ReviewOwnerRole,
          parties: parties.map((p) => ({
            description: p.description.trim(),
            ...(p.personId.trim() ? { personId: p.personId.trim().toLowerCase() } : {}),
          })),
          evidence: evidence.map((e) => ({
            type: e.type.trim(),
            reference: e.reference.trim(),
            ...(e.note.trim() ? { note: e.note.trim() } : {}),
          })),
          ...(effectiveTo ? { effectiveTo } : {}),
        },
      })
      .then((review) => navigate(`/people/access-reviews/${review.id}`))
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="open-review-title">
      <h2 id="open-review-title">Open an access review</h2>
      <PeopleNav />
      <p>
        <Link to="/people/access-reviews">Back to access reviews</Link>
      </p>
      <StateView
        variant="pending-decision"
        subject="The guardian verification and disputed-access policy"
        decisions={['DEC-004']}
        owner="Operator/privacy owner"
      />
      <form
        noValidate
        className="form"
        aria-label="Open an access review"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <PersonReferenceField
          label="Person whose access is disputed"
          required
          value={subject}
          onChange={setSubject}
          error={errors['subject'] ?? apiErrors['subjectPersonId']}
        />
        <TextAreaField
          label="Reason"
          required
          value={reason}
          onChange={setReason}
          error={errors['reason'] ?? apiErrors['reason']}
          maxLength={2000}
        />
        <SelectField
          label="Review owner"
          required
          placeholder="Choose the owning role"
          options={REVIEW_OWNER_ROLES}
          value={ownerRole}
          onChange={setOwnerRole}
          error={errors['ownerRole']}
        />
        <TextField
          label="Review effect ends"
          type="datetime-local"
          hint="Optional. Leave empty to keep the review in effect until it is closed."
          value={until}
          onChange={setUntil}
          error={errors['until'] ?? apiErrors['effectiveTo']}
        />
        <fieldset className="fieldset">
          <legend>Parties</legend>
          {parties.map((p, i) => (
            <div key={i} className="form">
              <TextField
                label={`Party ${i + 1} description`}
                required
                value={p.description}
                onChange={(v) =>
                  setParties((list) => list.map((x, j) => (j === i ? { ...x, description: v } : x)))
                }
                error={errors[`party-${i}`]}
              />
              <PersonReferenceField
                label={`Party ${i + 1} person reference`}
                hint="Optional."
                value={p.personId}
                onChange={(v) =>
                  setParties((list) => list.map((x, j) => (j === i ? { ...x, personId: v } : x)))
                }
                error={errors[`party-person-${i}`]}
              />
              <Button
                variant="secondary"
                onClick={() => setParties((list) => list.filter((_, j) => j !== i))}
              >
                Remove party {i + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() => setParties((list) => [...list, { personId: '', description: '' }])}
          >
            Add a party
          </Button>
        </fieldset>
        <fieldset className="fieldset">
          <legend>Evidence references</legend>
          <p className="caption">
            References only (a document number, a court order reference, a case link), never the
            document itself.
          </p>
          {evidence.map((e, i) => (
            <div key={i} className="form">
              <TextField
                label={`Evidence ${i + 1} type`}
                required
                value={e.type}
                onChange={(v) =>
                  setEvidence((list) => list.map((x, j) => (j === i ? { ...x, type: v } : x)))
                }
                error={errors[`evidence-${i}`]}
              />
              <TextField
                label={`Evidence ${i + 1} reference`}
                required
                value={e.reference}
                onChange={(v) =>
                  setEvidence((list) => list.map((x, j) => (j === i ? { ...x, reference: v } : x)))
                }
              />
              <TextField
                label={`Evidence ${i + 1} note`}
                value={e.note}
                onChange={(v) =>
                  setEvidence((list) => list.map((x, j) => (j === i ? { ...x, note: v } : x)))
                }
              />
              <Button
                variant="secondary"
                onClick={() => setEvidence((list) => list.filter((_, j) => j !== i))}
              >
                Remove evidence {i + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() => setEvidence((list) => [...list, { type: '', reference: '', note: '' }])}
          >
            Add an evidence reference
          </Button>
        </fieldset>
        <Button type="submit" busy={openReview.isProcessing} disabled={!online}>
          Open review
        </Button>
      </form>
      {!online ? <p className="caption">Opening a review needs a connection.</p> : null}
      <CommandError error={openReview.error} onRetry={submit} />
    </section>
  );
}
