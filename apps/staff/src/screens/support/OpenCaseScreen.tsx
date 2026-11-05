/**
 * SCR-S-49 Open a support case (SPK-SUPPORT-002). Category is required (validation failure:
 * "category missing"), the subject person comes from the person record when opened from there,
 * the facility is the one selected in the dashboard, and related records are references only.
 * The command carries an idempotency key per unchanged input; the form keeps its input on
 * failure and opens the new case on success.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, fieldErrorsOf } from '../../ui/CommandFeedback';
import { SelectField, TextAreaField, TextField } from '../../ui/FormFields';
import { isUuid } from '../../ui/RecordRef';
import { useFacilityDirectory } from '../today/useFacilityDirectory';
import {
  CASES_KEY,
  CASE_CATEGORIES,
  CASE_PRIORITIES,
  SLUG_PATTERN,
  type CaseCategory,
  type CasePriority,
} from './support';

export function OpenCaseScreen() {
  const { online, facilityId } = useApp();
  const facilities = useFacilityDirectory();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialSubject = params.get('subject') ?? '';
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<string>('normal');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState(isUuid(initialSubject) ? initialSubject : '');
  const [queue, setQueue] = useState('');
  const [relatedType, setRelatedType] = useState('');
  const [relatedId, setRelatedId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const open = useApiCommand('post', '/cases', { invalidate: [CASES_KEY] });
  const apiErrors = fieldErrorsOf(open.error);

  const submit = () => {
    const problems: Record<string, string> = {};
    if (!category) problems['category'] = 'Choose a category.';
    if (!title.trim()) problems['title'] = 'Give the case a title.';
    const s = referenceError(subject, false);
    if (s) problems['subject'] = s;
    if (queue && !SLUG_PATTERN.test(queue)) {
      problems['queue'] = 'Use lower-case letters, digits and underscores, starting with a letter.';
    }
    if ((relatedType && !relatedId.trim()) || (!relatedType && relatedId.trim())) {
      problems['related'] = 'Give both the record type and its reference, or neither.';
    } else if (relatedType && !SLUG_PATTERN.test(relatedType)) {
      problems['related'] = 'The record type is a lower-case name such as payment_attempt.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void open
      .submit({
        body: {
          category: category as CaseCategory,
          priority: priority as CasePriority,
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(subject.trim() ? { subjectPersonId: subject.trim().toLowerCase() } : {}),
          ...(facilityId ? { facilityId } : {}),
          ...(queue ? { ownerQueue: queue } : {}),
          relatedRecords: relatedType ? [{ type: relatedType, id: relatedId.trim() }] : [],
        },
      })
      .then((created) => navigate(`/admin/cases/${created.id}`))
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="open-case-title">
      <h2 id="open-case-title">Open a support case</h2>
      <p>
        <Link to="/admin/cases">Back to support cases</Link>
      </p>
      <form
        noValidate
        className="form"
        aria-label="Open a support case"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Category"
          required
          placeholder="Choose a category"
          options={CASE_CATEGORIES.map((c) => ({ value: c, label: c }))}
          value={category}
          onChange={setCategory}
          error={errors['category'] ?? apiErrors['category']}
        />
        <SelectField
          label="Priority"
          hint="The API records normal unless you choose otherwise."
          options={CASE_PRIORITIES.map((p) => ({ value: p, label: p }))}
          value={priority}
          onChange={setPriority}
        />
        <TextField
          label="Title"
          required
          value={title}
          onChange={setTitle}
          error={errors['title'] ?? apiErrors['title']}
        />
        <TextAreaField
          label="Description"
          value={description}
          onChange={setDescription}
          maxLength={5000}
        />
        <PersonReferenceField
          label="Customer (person reference)"
          hint="Optional. Opened from a person record, this is filled in."
          value={subject}
          onChange={setSubject}
          error={errors['subject'] ?? apiErrors['subjectPersonId']}
        />
        <p className="caption">
          Facility: {facilityId ? facilities.name(facilityId) : 'none (organization-wide case)'}.
          Change it with the facility switcher.
        </p>
        <TextField
          label="Owner queue"
          hint="Optional, for example support_operator."
          value={queue}
          onChange={setQueue}
          error={errors['queue'] ?? apiErrors['ownerQueue']}
        />
        <TextField
          label="Related record type"
          hint="Optional, for example payment_attempt."
          value={relatedType}
          onChange={setRelatedType}
          error={errors['related']}
        />
        <TextField label="Related record reference" value={relatedId} onChange={setRelatedId} />
        <Button type="submit" busy={open.isProcessing} disabled={!online}>
          Open case
        </Button>
      </form>
      {!online ? <p className="caption">Opening a case needs a connection.</p> : null}
      <CommandError error={open.error} onRetry={submit} />
    </section>
  );
}
