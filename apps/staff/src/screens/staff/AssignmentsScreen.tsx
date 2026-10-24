/**
 * SCR-S-33 Assignment management and replacement, list view (SPK-STAFF-002, SPK-STAFF-003,
 * SPK-STAFF-004, SPK-READY-001, SPK-AT-012, SPK-REPORT-002).
 *
 * - Uncovered required slots for the facility's next seven days come from the uncovered
 *   assignments report (`GET /v1/reports/uncovered-assignments`): proposed and offered never count
 *   as covering (SPK-STAFF-002), and the labels say so.
 * - Assignments (`GET /v1/assignments`) show all six states including "Proposed".
 * - Proposing (`POST /v1/assignments`) lets the API check qualification, availability, overlaps
 *   and turnaround (SPK-STAFF-003); its refusal is shown with its code and message. There is no
 *   person search in the API, so the person is named by their record id.
 * - The client never decides who may manage assignments: ACCESS_DENIED renders as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, STAFF_TABS } from '../../features/operations/AreaTabs';
import { nameOf, useOperatingFacility, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  CheckboxField,
  SelectField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import {
  addDays,
  formatInstant,
  formatRange,
  humanize,
  localDate,
} from '../../features/operations/format';
import { ASSIGNMENT_STATUS } from '../../features/operations/labels';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Assignment = Schema<'Assignment'>;
type AssignmentStatus = Schema<'AssignmentStatus'>;
type ReportRow = Schema<'ReportRow'>;

const STATUSES: readonly AssignmentStatus[] = [
  'proposed',
  'offered',
  'accepted',
  'declined',
  'withdrawn',
  'completed',
];

export function AssignmentsScreen() {
  const facility = useOperatingFacility();
  const [proposal, setProposal] = useState<ProposalSeed | null>(null);
  return (
    <section aria-labelledby="assignments-title">
      <h2 id="assignments-title">Assignments and replacement</h2>
      <AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />
      {facility.facilityId ? (
        <UncoveredSlots
          facilityId={facility.facilityId}
          today={facility.localDate}
          timezone={facility.timezone}
          onPropose={setProposal}
        />
      ) : (
        <p className="caption">
          Choose a facility in the header to see its uncovered required slots.
        </p>
      )}
      <div className="ops-actions">
        <Button variant="secondary" onClick={() => setProposal(proposal ? null : {})}>
          {proposal ? 'Close the proposal form' : 'Propose an assignment'}
        </Button>
      </div>
      {proposal ? <ProposeForm key={JSON.stringify(proposal)} seed={proposal} /> : null}
      <AssignmentList />
    </section>
  );
}

interface ProposalSeed {
  targetType?: string;
  targetId?: string;
  kind?: string;
  role?: string;
}

function UncoveredSlots({
  facilityId,
  today,
  timezone,
  onPropose,
}: {
  facilityId: string;
  today: string | null;
  timezone: string | null;
  onPropose: (seed: ProposalSeed) => void;
}) {
  const now = useNow(60_000);
  const from = today ?? localDate(now, timezone);
  const report = useApiQuery({
    path: '/reports/uncovered-assignments',
    request: { query: { facilityId, from, to: addDays(from, 7) } },
  });
  const text = (row: ReportRow, key: string) => {
    const v = row[key];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  };
  const count = (row: ReportRow, key: string) =>
    typeof row[key] === 'number' ? (row[key] as number) : 0;
  return (
    <section className="ops-section" aria-labelledby="uncovered-title">
      <h3 id="uncovered-title">Uncovered required slots (next seven days)</h3>
      <QueryBoundary
        query={report}
        label="uncovered slots"
        isEmpty={(data) => data.rows.every((r) => count(r, 'uncovered') === 0)}
        empty={{
          title: 'Nothing uncovered',
          description:
            'Every required official and coach slot in the next seven days has an accepted assignment.',
        }}
      >
        {(data) => (
          <ul className="list" aria-label="Uncovered slots">
            {data.rows
              .filter((r) => count(r, 'uncovered') > 0)
              .map((row) => (
                <li key={`${text(row, 'requirementId')}-${text(row, 'role')}`}>
                  <div className="row-text">
                    <span className="row-title">{text(row, 'title')}</span>
                    <span className="caption">
                      {text(row, 'start')
                        ? formatInstant(text(row, 'start'), data.scope.timezone ?? timezone)
                        : ''}{' '}
                      · {humanize(text(row, 'role'))}
                    </span>
                    <StatusBadge tone="danger" label={`${count(row, 'uncovered')} uncovered`} />
                    <span className="caption">
                      {count(row, 'required')} required, {count(row, 'accepted')} accepted; offered{' '}
                      {count(row, 'offered')} and proposed {count(row, 'proposed')} do not cover.
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    aria-label={`Propose someone for ${text(row, 'title')}, ${humanize(text(row, 'role'))}`}
                    onClick={() =>
                      onPropose({
                        targetType: text(row, 'targetType'),
                        targetId: text(row, 'targetId'),
                        kind: text(row, 'kind'),
                        role: text(row, 'role'),
                      })
                    }
                  >
                    Propose someone
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

function AssignmentList() {
  const [status, setStatus] = useState<AssignmentStatus | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const now = useNow(60_000);
  const from = useMemo(() => new Date(now.getTime() - 86_400_000).toISOString(), [now]);
  const list = useApiQuery({
    path: '/assignments',
    request: { query: { status: status || undefined, from, limit: 50, cursor } },
  });
  const names = usePersonNames(
    useMemo(() => (list.data?.items ?? []).map((a) => a.personId), [list.data]),
  );
  return (
    <section className="ops-section" aria-labelledby="assignment-list-title">
      <h3 id="assignment-list-title">Assignments from yesterday on</h3>
      <SelectField
        label="Show"
        value={status}
        onChange={(v) => {
          setStatus(v as AssignmentStatus | '');
          setCursor(undefined);
        }}
        placeholder="Every state"
        options={STATUSES.map((s) => ({ value: s, label: ASSIGNMENT_STATUS[s].label }))}
      />
      <QueryBoundary
        query={list}
        label="assignments"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No assignments',
          description: 'Assignments you propose or offer appear here.',
        }}
        unavailableOffline={['proposing, offering and withdrawing assignments']}
      >
        {(data) => (
          <>
            <ul className="list" aria-label="Assignments">
              {data.items.map((a) => (
                <AssignmentRow key={a.id} assignment={a} name={nameOf(names, a.personId)} />
              ))}
            </ul>
            <div className="ops-actions">
              {cursor ? (
                <Button variant="secondary" onClick={() => setCursor(undefined)}>
                  Back to the first page
                </Button>
              ) : null}
              {data.nextCursor ? (
                <Button variant="secondary" onClick={() => setCursor(data.nextCursor ?? undefined)}>
                  Next page
                </Button>
              ) : null}
            </div>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

function AssignmentRow({ assignment: a, name }: { assignment: Assignment; name: string }) {
  const badge = ASSIGNMENT_STATUS[a.status];
  return (
    <li>
      <div className="row-text">
        <Link to={`/staff/assignments/${a.id}`} className="row-title">
          {a.targetTitle}: {humanize(a.role)} {a.slot > 1 ? `(slot ${a.slot})` : ''}
        </Link>
        <span className="caption">
          {formatRange(a.scheduledStart, a.scheduledEnd)} · {name} · {humanize(a.engagement)}
        </span>
        <StatusBadge tone={badge.tone} label={badge.label} />
      </div>
    </li>
  );
}

const KIND_OPTIONS = ['official', 'coach', 'supervisor', 'organizer'].map((v) => ({
  value: v,
  label: humanize(v),
}));
const TARGET_OPTIONS = ['fixture', 'event', 'session'].map((v) => ({
  value: v,
  label: humanize(v),
}));
const ENGAGEMENT_OPTIONS = ['regular', 'temporary', 'substitute'].map((v) => ({
  value: v,
  label: humanize(v),
}));

function ProposeForm({ seed }: { seed: ProposalSeed }) {
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState(seed.kind ?? '');
  const [targetType, setTargetType] = useState(seed.targetType ?? '');
  const [targetId, setTargetId] = useState(seed.targetId ?? '');
  const [offeringId, setOfferingId] = useState('');
  const [role, setRole] = useState(seed.role ?? '');
  const [engagement, setEngagement] = useState('regular');
  const [turnaround, setTurnaround] = useState('');
  const [offer, setOffer] = useState(true);
  const [missing, setMissing] = useState<Record<string, string>>({});
  const requirement = useApiQuery({
    path: '/assignment-requirements',
    request: { query: { targetType: (targetType || 'session') as 'session', targetId } },
    enabled: targetType === 'session' && targetId.length > 0,
  });
  const sessionOffering =
    requirement.data?.find((r) => r.offeringId)?.offeringId ?? (offeringId || null);
  const command = useApiCommand('post', '/assignments', { invalidate: [['api', '/assignments']] });
  const apiErrors = fieldErrorsOf(command.error);

  const submit = () => {
    const next: Record<string, string> = {};
    if (!personId.trim()) next.personId = 'Name the person by their record id.';
    if (!kind) next.kind = 'Choose the kind of assignment.';
    if (!targetType) next.targetType = 'Choose what the assignment is for.';
    if (!targetId.trim()) next.targetId = 'Name the fixture, event or session.';
    if (!role.trim()) next.role = 'Name the role.';
    if (targetType === 'session' && !sessionOffering)
      next.offeringId = 'A session needs its offering.';
    setMissing(next);
    if (Object.keys(next).length > 0) return;
    void command
      .submit({
        body: {
          personId: personId.trim(),
          kind: kind as Assignment['kind'],
          targetType: targetType as Assignment['targetType'],
          targetId: targetId.trim(),
          ...(targetType === 'session' && sessionOffering ? { offeringId: sessionOffering } : {}),
          role: role.trim(),
          engagement: engagement as Assignment['engagement'],
          ...(turnaround.trim() ? { turnaroundMinutes: Number(turnaround) } : {}),
          offer,
        },
      })
      .catch(() => undefined);
  };

  const outcome = command.data;
  return (
    <section className="ops-section" aria-labelledby="propose-title">
      <h3 id="propose-title">Propose an assignment</h3>
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Person (record id)"
          value={personId}
          onChange={setPersonId}
          required
          hint="The service has no person search yet: copy the id from the person's record."
          error={missing.personId ?? apiErrors.personId}
        />
        <SelectField
          label="Kind"
          value={kind}
          onChange={setKind}
          options={KIND_OPTIONS}
          placeholder="Choose a kind"
          error={missing.kind ?? apiErrors.kind}
        />
        <SelectField
          label="For"
          value={targetType}
          onChange={setTargetType}
          options={TARGET_OPTIONS}
          placeholder="Choose a target"
          error={missing.targetType ?? apiErrors.targetType}
        />
        <TextField
          label="Fixture, event or session (record id)"
          value={targetId}
          onChange={setTargetId}
          required
          error={missing.targetId ?? apiErrors.targetId}
        />
        {targetType === 'session' && !requirement.data?.some((r) => r.offeringId) ? (
          <TextField
            label="Offering (record id)"
            value={offeringId}
            onChange={setOfferingId}
            error={missing.offeringId ?? apiErrors.offeringId}
          />
        ) : null}
        <TextField
          label="Role"
          value={role}
          onChange={setRole}
          required
          hint="For example referee or assistant_coach."
          error={missing.role ?? apiErrors.role}
        />
        <SelectField
          label="Engagement"
          value={engagement}
          onChange={setEngagement}
          options={ENGAGEMENT_OPTIONS}
          hint="Temporary and substitute work receives time-bounded access (SPK-STAFF-004)."
        />
        <TextField
          label="Turnaround minutes (optional)"
          value={turnaround}
          onChange={setTurnaround}
          inputMode="numeric"
          hint="Leave empty to apply the configured turnaround."
          error={apiErrors.turnaroundMinutes}
        />
        <CheckboxField label="Offer it to the person now" checked={offer} onChange={setOffer} />
        <div className="ops-actions">
          <Button type="submit" busy={command.isProcessing}>
            {offer ? 'Propose and offer' : 'Propose'}
          </Button>
        </div>
      </form>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} />
      ) : null}
      {outcome ? (
        <CommandSuccess label={ASSIGNMENT_STATUS[outcome.assignment.status].label}>
          <Link to={`/staff/assignments/${outcome.assignment.id}`}>Manage this assignment</Link>
          {outcome.uncovered ? <UncoveredNotice notice={outcome.uncovered} /> : null}
        </CommandSuccess>
      ) : null}
    </section>
  );
}

export function UncoveredNotice({
  notice,
}: {
  notice: NonNullable<Schema<'UncoveredAssignmentNotice'>>;
}) {
  return (
    <StateView
      variant="unavailable"
      title="Slot uncovered: escalated"
      description={`The ${humanize(notice.role).toLowerCase()} slot ${notice.slot} from ${formatInstant(notice.startsAt)} has no accepted assignment. It is raised in the Today workspace for replacement.`}
    />
  );
}
