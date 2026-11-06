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
 * - Participants and named people are found with the staff person search (`GET /v1/people`, as the
 *   viewer's role allows; names only) and added to the audience by their id; ids from a link stay
 *   accepted. Their names are shown through `GET /v1/person-names`. Team entries are named by
 *   record id (no staff team-entry search in this area).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
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
  formatInstant,
  humanize,
  idList,
  inputZoneHint,
  readZonedInput,
} from '../../features/operations/format';
import { NOTIFICATION_STATUS } from '../../features/operations/labels';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { PersonSearch } from '../../features/operations/PersonSearch';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { AudienceCount } from './AudienceCount';
import './communications.css';

type Kind = Schema<'NotificationKind'>;
type Category = Schema<'NotificationCategory'>;
type StaffRole = NonNullable<Schema<'Audience'>['staffRoles']>[number];

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
    <section aria-labelledby="compose-title" className="cm">
      <PageHeader
        eyebrow="Business · New message"
        title="Compose a message"
        titleId="compose-title"
      />
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
    // SPK-SCHED-008: a time that happens twice or never on a daylight-saving change is refused.
    const when = readZonedInput(scheduledFor, facility.timezone);
    if (when.error) next.scheduledFor = when.error;
    setProblems(next);
    if (Object.keys(next).length > 0 || !category) return;
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
          ...(when.iso ? { scheduledFor: when.iso } : {}),
        },
      })
      .then((notification) => navigate(detailPath(notification.id)))
      .catch(() => undefined);
  };

  // SPK-COMMS-006: the live count needs the audience and the category the message is sent in.
  const liveAudience = {
    staffRoles: roles,
    teamEntryIds: idList(teamEntries),
    subjectPersonIds: idList(subjects),
    personIds: idList(persons),
    facilityId: facility.facilityId,
  };
  const named =
    liveAudience.staffRoles.length +
    liveAudience.teamEntryIds.length +
    liveAudience.subjectPersonIds.length +
    liveAudience.personIds.length;
  const countRequest =
    named > 0 && category !== '' && online
      ? {
          kind,
          category,
          ...(facility.facilityId ? { facilityId: facility.facilityId } : {}),
          audience: liveAudience,
          protected: isProtected,
        }
      : null;

  const audienceParts = audienceSummary({
    roles,
    teamEntries: idList(teamEntries).length,
    subjects: idList(subjects).length,
    persons: idList(persons).length,
  });

  return (
    <div className="cm-layout">
      <form
        className="ops-form cm-form"
        aria-label="Compose a message"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <section className="cm-step" aria-labelledby="cm-step-who">
          <span className="cm-step-label" id="cm-step-who">
            <span className="cm-step-n" aria-hidden="true">
              1
            </span>
            Who should hear this?
          </span>
          <fieldset className="ops-fieldset cm-audience">
            <legend>Audience</legend>
            <p className="caption">
              Recipients are resolved from current permissions when you preview and again when you
              send. Contact details are never shown.
              {facility.facilityId ? ' Staff roles are limited to the selected facility.' : ''}
            </p>
            <div className="ops-row cm-pills" role="group" aria-label="Staff roles">
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
            <AddPeople
              onAdd={(as, id) =>
                as === 'participant'
                  ? setSubjects((prev) => appendId(prev, id))
                  : setPersons((prev) => appendId(prev, id))
              }
            />
            <div className="cm-ids">
              <TextAreaField
                label="Team entries (record ids, one per line)"
                value={teamEntries}
                onChange={setTeamEntries}
                rows={2}
                hint="Members of each team entry, and the guardians of child members."
                error={apiErrors['audience.teamEntryIds']}
              />
              <div>
                <TextAreaField
                  label="Participants (record ids, one per line)"
                  value={subjects}
                  onChange={setSubjects}
                  rows={2}
                  hint="Reaches the people who currently hold permission to receive messages about each participant."
                  error={apiErrors['audience.subjectPersonIds']}
                />
                <ChosenNames ids={idList(subjects)} label="Participants" />
              </div>
              <div>
                <TextAreaField
                  label="Named people (record ids, one per line)"
                  value={persons}
                  onChange={setPersons}
                  rows={2}
                  error={apiErrors['audience.personIds']}
                />
                <ChosenNames ids={idList(persons)} label="Named people" />
              </div>
            </div>
            {problems.audience || apiErrors.audience ? (
              <span className="error-text" role="alert">
                {problems.audience ?? apiErrors.audience}
              </span>
            ) : null}
          </fieldset>
        </section>

        <section className="cm-step" aria-labelledby="cm-step-what">
          <span className="cm-step-label" id="cm-step-what">
            <span className="cm-step-n" aria-hidden="true">
              2
            </span>
            Message
          </span>
          <div className="cm-two">
            <SelectField
              label="Kind of message"
              value={kind}
              onChange={(v) => setKind(v as Kind)}
              options={KINDS.map((k) => ({ value: k, label: humanize(k) }))}
            />
            <fieldset className="ops-fieldset cm-category" aria-describedby="category-hint">
              <legend>Category</legend>
              <span className="caption" id="category-hint">
                Essential operational notices and promotional messages are kept apart; recipients
                choose promotional channels separately.
              </span>
              <div className="cm-segment">
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
              </div>
              {problems.category ? (
                <span className="error-text" id="compose-category-error" role="alert">
                  {problems.category}
                </span>
              ) : null}
            </fieldset>
          </div>
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
              <TextAreaField
                label="After (new details)"
                value={after}
                onChange={setAfter}
                rows={2}
              />
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
        </section>

        <section className="cm-step" aria-labelledby="cm-step-how">
          <span className="cm-step-label" id="cm-step-how">
            <span className="cm-step-n" aria-hidden="true">
              3
            </span>
            How and when
          </span>
          <StateView
            variant="pending-decision"
            subject="Which channels each kind of message may use"
            decisions={['DEC-012', 'DEC-062']}
            owner="Operator/privacy owner"
          />
          <TextField
            label="Deliver no earlier than (optional)"
            type="datetime-local"
            value={scheduledFor}
            onChange={setScheduledFor}
            hint={`${inputZoneHint(facility.timezone)} A reminder that becomes obsolete before it is sent is suppressed.`}
            error={problems.scheduledFor ?? apiErrors.scheduledFor}
          />
          <div className="ops-actions cm-actions">
            <span className="caption">
              Nothing is sent yet: the next step shows who is reached and asks you to confirm.
            </span>
            <Button type="submit" busy={command.isProcessing} disabled={!online}>
              Preview recipients
            </Button>
            {!online ? (
              <span className="caption">
                Needs a connection. Your draft is kept on this screen.
              </span>
            ) : null}
          </div>
          {command.error && Object.keys(apiErrors).length === 0 ? (
            <CommandError error={command.error} onRetry={submit} />
          ) : null}
        </section>
      </form>
      <aside className="cm-side" aria-label="Live preview">
        <section className="card card-dark cm-reach" aria-labelledby="cm-reach-title">
          <span className="cm-reach-kicker" id="cm-reach-title">
            Audience so far
          </span>
          <span className="cm-reach-value" data-testid="audience-summary">
            {audienceParts.length === 0 ? 'Nobody yet' : audienceParts.join(' · ')}
          </span>
          <AudienceCount request={countRequest} />
          <ul className="cm-reach-list">
            <li>
              {category === ''
                ? 'Choose essential or promotional to see who may receive it.'
                : category === 'operational'
                  ? 'Essential operational notice: kept apart from promotional messages.'
                  : 'Promotional message: recipients choose promotional channels separately.'}
            </li>
            <li>
              {isProtected
                ? 'Participant-private: recipients are re-checked just before delivery.'
                : 'Counted from current permissions when you preview, and again at send.'}
            </li>
          </ul>
        </section>
        <section className="card cm-preview" aria-labelledby="cm-preview-title">
          <span className="label-caps" id="cm-preview-title">
            What recipients see
          </span>
          <div className="cm-bubble">
            <span className="cm-bubble-app" aria-hidden="true">
              <Icon name="sports_soccer" size={14} filled /> Sportspark · {humanize(kind)}
            </span>
            <span className="cm-bubble-title">{title.trim() || 'Your title appears here'}</span>
            <span className="cm-bubble-body">
              {body.trim() || 'Write the message; this preview updates as you type.'}
            </span>
            {kind === 'schedule_changed' && (before.trim() || after.trim()) ? (
              <span className="cm-bubble-change">
                <s>{before.trim() || 'Old details'}</s>
                <span>
                  <Icon name="arrow_forward" size={14} /> {after.trim() || 'New details'}
                </span>
              </span>
            ) : null}
          </div>
        </section>
        <RecentSends />
      </aside>
    </div>
  );
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the audience definition holds so far, in words (never contact details). */
function audienceSummary(a: {
  roles: readonly string[];
  teamEntries: number;
  subjects: number;
  persons: number;
}): string[] {
  const parts: string[] = [];
  if (a.roles.length > 0) parts.push(counted(a.roles.length, 'staff role', 'staff roles'));
  if (a.teamEntries > 0) parts.push(counted(a.teamEntries, 'team entry', 'team entries'));
  if (a.subjects > 0) parts.push(counted(a.subjects, 'participant', 'participants'));
  if (a.persons > 0) parts.push(counted(a.persons, 'named person', 'named people'));
  return parts;
}

/** The latest notices with their delivery status (`GET /v1/notifications`, newest first). */
function RecentSends() {
  const facility = useOperatingFacility();
  const list = useApiQuery({
    path: '/notifications',
    request: { query: { facilityId: facility.facilityId ?? undefined, limit: 5 } },
    enabled: !facility.loading,
  });
  return (
    <section className="card card-flush cm-recent" aria-labelledby="cm-recent-title">
      <div className="card-head">
        <h4 id="cm-recent-title">Recent sends</h4>
        <Link to="/communications">Delivery status</Link>
      </div>
      <div className="cm-recent-body">
        <QueryBoundary
          query={list}
          label="recent messages"
          isEmpty={(data) => data.items.length === 0}
          empty={{ title: 'Nothing sent yet', description: 'Sent messages appear here.' }}
        >
          {(data) => (
            <ul className="cm-recent-list" aria-label="Recent messages">
              {data.items.map((n) => (
                <li key={n.id}>
                  <Link to={`/communications/notifications/${n.id}`} className="row-title">
                    {n.title}
                  </Link>
                  <span className="caption">
                    {humanize(n.kind)} · {formatInstant(n.createdAt)}
                  </span>
                  <StatusBadge {...NOTIFICATION_STATUS[n.status]} />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

function appendId(list: string, id: string): string {
  const ids = idList(list);
  return ids.includes(id) ? list : [...ids, id].join('\n');
}

/** Find a person (names only) and add them as a participant or a named recipient. */
function AddPeople({ onAdd }: { onAdd: (as: 'participant' | 'person', id: string) => void }) {
  const [as, setAs] = useState<'participant' | 'person'>('participant');
  return (
    <div className="ops-section" role="group" aria-label="Add people to the audience">
      <fieldset className="ops-fieldset">
        <legend>Add a person found by name as</legend>
        {(
          [
            ['participant', 'A participant (reaches who receives messages about them)'],
            ['person', 'A named recipient'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="ops-check">
            <input
              type="radio"
              name="add-as"
              value={value}
              checked={as === value}
              onChange={() => setAs(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <PersonSearch
        label="Find a person to add"
        chooseLabel="Add"
        onChoose={(p) => onAdd(as, p.id)}
      />
    </div>
  );
}

/** Names of the people already in a list (never contact details, SPK-COMMS-006). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ChosenNames({ ids: all, label }: { ids: string[]; label: string }) {
  // Only well-formed ids are asked for; anything else is the API's validation answer at compose.
  const ids = all.filter((id) => UUID.test(id));
  const names = usePersonNames(ids);
  if (ids.length === 0) return null;
  return (
    <p className="caption" aria-label={`${label} chosen`}>
      {label}: {ids.map((id) => nameOf(names, id)).join('; ')}
    </p>
  );
}
