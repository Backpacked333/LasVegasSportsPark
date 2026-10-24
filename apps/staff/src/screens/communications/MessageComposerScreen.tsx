/**
 * SCR-S-39 Message composer and audience preview, step 1: compose (SPK-COMMS-001,
 * SPK-COMMS-003, SPK-COMMS-005, SPK-COMMS-006, SPK-COMMS-007, SPK-AT-017, DEC-012, DEC-062,
 * POL-024).
 *
 * - The audience is a definition (staff roles in the facility, team entries, people whose
 *   receive-messages holders are addressed, named people), never a list of contact details; the
 *   API resolves it from current permissions at preview and again at send (SPK-COMMS-003).
 * - Essential operational notices and promotional messages are chosen explicitly
 *   (SPK-COMMS-007). A schedule change carries the old and new practical details (SPK-COMMS-005).
 * - Which channels a kind of message may use is the communication policy (DEC-012, DEC-062,
 *   pending): the API decides and its refusal is shown.
 * - Composing creates the notice (`POST /v1/notifications`) without sending it; the preview and
 *   the confirmation are step 2 (NotificationScreen). Offline, the draft stays on screen.
 * - The API has no audience picker (people, team entries), so they are named by record id.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { AreaTabs, COMMUNICATIONS_TABS } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { CommandError } from '../../features/operations/feedback';
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import {
  humanize,
  idList,
  inputZoneHint,
  instantFromZonedInput,
} from '../../features/operations/format';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';

type Kind = Schema<'NotificationKind'>;
type Category = Schema<'NotificationCategory'>;
type StaffRole = Schema<'Audience'>['staffRoles'][number];

const KINDS: readonly Kind[] = [
  'staff_broadcast',
  'schedule_changed',
  'schedule_published',
  'cancellation',
  'registration_outcome',
  'team_invitation',
  'placement',
  'waitlist_offer',
  'payment_attention',
  'assignment_offer',
  'result_published',
  'renewal_opportunity',
  'youth_feedback',
];

const STAFF_ROLES: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'coach',
  'official',
];

export interface ComposerDefaults {
  /** People whose receive-messages holders (and adult selves) are addressed. */
  subjectPersonIds?: string[];
  teamEntryIds?: string[];
  subject?: { type: string; id: string };
}

export function MessageComposerScreen() {
  return (
    <section aria-labelledby="compose-title">
      <h2 id="compose-title">Compose a message</h2>
      <AreaTabs label="Communications screens" tabs={COMMUNICATIONS_TABS} />
      <Composer />
    </section>
  );
}

export function Composer({
  defaults = {},
  detailPath = (id: string) => `/communications/notifications/${id}`,
}: {
  defaults?: ComposerDefaults;
  detailPath?: (id: string) => string;
}) {
  const { online } = useApp();
  const facility = useOperatingFacility();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('staff_broadcast');
  const [category, setCategory] = useState<Category | ''>('');
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [teamEntries, setTeamEntries] = useState((defaults.teamEntryIds ?? []).join('\n'));
  const [subjects, setSubjects] = useState((defaults.subjectPersonIds ?? []).join('\n'));
  const [persons, setPersons] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [isProtected, setProtected] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const command = useApiCommand('post', '/notifications', {
    invalidate: [['api', '/notifications']],
  });
  const apiErrors = fieldErrorsOf(command.error);

  const submit = () => {
    const audience = {
      staffRoles: roles,
      teamEntryIds: idList(teamEntries),
      subjectPersonIds: idList(subjects),
      personIds: idList(persons),
      facilityId: facility.facilityId,
    };
    const next: Record<string, string> = {};
    if (!category) next.category = 'Choose essential or promotional.';
    if (!title.trim()) next.title = 'A title is required.';
    if (!body.trim()) next.body = 'A message is required.';
    if (
      audience.staffRoles.length +
        audience.teamEntryIds.length +
        audience.subjectPersonIds.length +
        audience.personIds.length ===
      0
    ) {
      next.audience = 'Choose at least one staff role, team entry or person.';
    }
    if (kind === 'schedule_changed' && (!before.trim() || !after.trim())) {
      next.details = 'A schedule change shows the old and the new practical details.';
    }
    setProblems(next);
    if (Object.keys(next).length > 0 || !category) return;
    const when = instantFromZonedInput(scheduledFor, facility.timezone);
    void command
      .submit({
        body: {
          kind,
          category,
          ...(facility.facilityId ? { facilityId: facility.facilityId } : {}),
          ...(defaults.subject ? { subject: defaults.subject } : {}),
          audience,
          title: title.trim(),
          body: body.trim(),
          ...(before.trim() ? { detailsBefore: { summary: before.trim() } } : {}),
          ...(after.trim() ? { detailsAfter: { summary: after.trim() } } : {}),
          protected: isProtected,
          ...(when ? { scheduledFor: when } : {}),
        },
      })
      .then((notification) => navigate(detailPath(notification.id)))
      .catch(() => undefined);
  };

  return (
    <form
      className="ops-form"
      aria-label="Compose a message"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <StateView
        variant="pending-decision"
        subject="Which channels each kind of message may use"
        decisions={['DEC-012', 'DEC-062']}
        owner="Operator/privacy owner"
      />
      <SelectField
        label="Kind of message"
        value={kind}
        onChange={(v) => setKind(v as Kind)}
        options={KINDS.map((k) => ({ value: k, label: humanize(k) }))}
      />
      <fieldset className="ops-fieldset" aria-describedby="category-hint">
        <legend>Category</legend>
        <span className="caption" id="category-hint">
          Essential operational notices and promotional messages are kept apart; recipients choose
          promotional channels separately.
        </span>
        {(
          [
            ['operational', 'Essential operational notice'],
            ['promotional', 'Promotional message'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="ops-check">
            <input
              type="radio"
              name="category"
              value={value}
              checked={category === value}
              onChange={() => setCategory(value)}
            />
            {label}
          </label>
        ))}
        {problems.category ? (
          <span className="error-text" id="compose-category-error" role="alert">
            {problems.category}
          </span>
        ) : null}
      </fieldset>
      <fieldset className="ops-fieldset">
        <legend>Audience</legend>
        <p className="caption">
          Recipients are resolved from current permissions when you preview and again when you send.
          Contact details are never shown.
          {facility.facilityId ? ' Staff roles are limited to the selected facility.' : ''}
        </p>
        <div className="ops-row" role="group" aria-label="Staff roles">
          {STAFF_ROLES.map((role) => (
            <CheckboxField
              key={role}
              label={humanize(role)}
              checked={roles.includes(role)}
              onChange={(checked) =>
                setRoles((prev) => (checked ? [...prev, role] : prev.filter((r) => r !== role)))
              }
            />
          ))}
        </div>
        <TextAreaField
          label="Team entries (record ids, one per line)"
          value={teamEntries}
          onChange={setTeamEntries}
          rows={2}
          hint="Members of each team entry, and the guardians of child members."
          error={apiErrors['audience.teamEntryIds']}
        />
        <TextAreaField
          label="Participants (record ids, one per line)"
          value={subjects}
          onChange={setSubjects}
          rows={2}
          hint="Reaches the people who currently hold permission to receive messages about each participant."
          error={apiErrors['audience.subjectPersonIds']}
        />
        <TextAreaField
          label="Named people (record ids, one per line)"
          value={persons}
          onChange={setPersons}
          rows={2}
          error={apiErrors['audience.personIds']}
        />
        {problems.audience || apiErrors.audience ? (
          <span className="error-text" role="alert">
            {problems.audience ?? apiErrors.audience}
          </span>
        ) : null}
      </fieldset>
      <TextField
        label="Title"
        value={title}
        onChange={setTitle}
        required
        error={problems.title ?? apiErrors.title}
      />
      <TextAreaField
        label="Message"
        value={body}
        onChange={setBody}
        required
        rows={6}
        error={problems.body ?? apiErrors.body}
      />
      {kind === 'schedule_changed' ? (
        <fieldset className="ops-fieldset">
          <legend>Practical details</legend>
          <TextAreaField
            label="Before (old details)"
            value={before}
            onChange={setBefore}
            rows={2}
          />
          <TextAreaField label="After (new details)" value={after} onChange={setAfter} rows={2} />
          {problems.details ? (
            <span className="error-text" id="compose-details-error" role="alert">
              {problems.details}
            </span>
          ) : null}
        </fieldset>
      ) : null}
      <CheckboxField
        label="Contains participant-private information"
        checked={isProtected}
        onChange={setProtected}
        hint="Recipients are re-checked just before delivery; anyone who lost access is excluded."
      />
      <TextField
        label="Deliver no earlier than (optional)"
        type="datetime-local"
        value={scheduledFor}
        onChange={setScheduledFor}
        hint={`${inputZoneHint(facility.timezone)} A reminder that becomes obsolete before it is sent is suppressed.`}
        error={apiErrors.scheduledFor}
      />
      <div className="ops-actions">
        <Button type="submit" busy={command.isProcessing} disabled={!online}>
          Preview recipients
        </Button>
        {!online ? (
          <span className="caption">Needs a connection. Your draft is kept on this screen.</span>
        ) : null}
      </div>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} />
      ) : null}
    </form>
  );
}
