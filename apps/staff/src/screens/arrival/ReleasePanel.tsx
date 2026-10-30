/**
 * Supervised release, shared by SCR-S-30 (front desk) and SCR-W-09 (the assigned coach)
 * (SPK-ENTRY-007, SPK-COND-004, §4.15, SPK-AT-016, DEC-005, DEC-034, DEC-075).
 *
 * - Current pickup authority is verified by the API at the moment of release
 *   (`POST /v1/releases`); the dashboard never decides it and never shows cached authority (the
 *   pass scan's `holderMayCollect` is not displayed). Schedule visibility and payment permission
 *   do not establish pickup authority; the API's denial reason says so.
 * - For a session (the coach's own, or one the desk chooses) the collecting adult is identified
 *   first with the collector check (`POST /v1/releases/collector-checks`, ENT-02): read-only, it
 *   records nothing and names the collector only when their pass is active, they hold `collect`
 *   over this child now and the child takes part in the session. Every other answer is the same
 *   "not confirmed" with no name, so the check reveals nothing about the pass or its holder
 *   (§4.10, §4.14). The release then re-checks authority and the record names the grant it relied
 *   on (`authorityGrantId`, staff readers only).
 * - Children on site without a session (desk only): the collector is identified by the desk pass
 *   scan, and authority is checked when the release is recorded.
 * - The record shows child, collecting person, verification outcome, staff actor, time,
 *   restriction or escalation, and release outcome. One child at a time: partial completion is
 *   per child (one released, one escalated). A record stays listed after the release closes the
 *   child's visit (the child is no longer on site), with the name known when it was recorded.
 * - Every time (collector check, confirmation, record) is in the facility zone (SPK-SCHED-008).
 * - An adult without the collect grant is denied, or escalated when staff choose the escalation
 *   (the procedure itself is DEC-005, pending).
 * - Offline, release is unavailable: the manual outage procedure is DEC-034 (pending) and cached
 *   authority is never asserted.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { attendanceQuery, type ActivityRef } from '../../features/operations/activity';
import { useKeyedCommands } from '../../features/operations/commands';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  CheckboxField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import { formatInstant, shortRef } from '../../features/operations/format';
import { VERIFICATION_OUTCOME } from '../../features/operations/labels';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary, type QueryLike } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type PassScan = Schema<'PassScan'>;
type RecordedRelease = Schema<'RecordedRelease'>;
type CollectorCheck = Schema<'CollectorCheck'>;

type Collector =
  | { kind: 'person'; personId: string; name: string; checkedAt?: string }
  | { kind: 'description'; description: string };

export interface ReleasePanelProps {
  facilityId: string;
  timezone: string | null;
  /** The session children are released from (SCR-W-09, or chosen at the desk). */
  activity?: ActivityRef;
}

export function ReleasePanel({ facilityId, timezone, activity }: ReleasePanelProps) {
  const { online } = useApp();
  if (!online) {
    return (
      <div className="ops-section" data-testid="release-offline">
        <StatusBadge tone="warning" label="Release needs a connection" />
        <p>
          Supervised release needs an online check of current pickup authority. Authority cached on
          this device is never used.
        </p>
        <StateView
          variant="pending-decision"
          subject="A manual outage procedure for supervised release"
          decisions={['DEC-005', 'DEC-034']}
          owner="Operations"
        />
      </div>
    );
  }
  return <OnlineRelease facilityId={facilityId} timezone={timezone} activity={activity} />;
}

function OnlineRelease({ facilityId, timezone, activity }: ReleasePanelProps) {
  const [collector, setCollector] = useState<Collector | null>(null);
  const [scanned, setScanned] = useState<PassScan | null>(null);
  const [childId, setChildId] = useState<string | null>(null);
  const [released, setReleased] = useState<string[]>([]);
  // Children with a release record from this panel (any outcome), kept after they leave the list.
  const [recorded, setRecorded] = useState<string[]>([]);
  // Names of everyone identified in this panel (scanned people, checked collectors).
  const [knownNames, setKnownNames] = useState<ReadonlyMap<string, string>>(new Map());
  const remember = (entries: readonly (readonly [string, string])[]) =>
    setKnownNames((prev) => {
      const next = new Map(prev);
      for (const [id, name] of entries) next.set(id, name);
      return next;
    });
  const commands = useKeyedCommands({
    invalidate: [
      ['api', '/visits'],
      ['api', '/attendance'],
    ],
  });

  const onSite = useApiQuery({
    path: '/visits',
    request: { query: { facilityId, status: 'on_site', limit: 200 } },
    enabled: !activity,
  });
  const attendance = useApiQuery({
    path: '/attendance',
    request: {
      query: activity ? attendanceQuery(activity) : { activityType: 'event', activityId: '' },
    },
    enabled: !!activity,
  });
  const source = (activity ? attendance : onSite) as QueryLike<unknown>;

  // ENT-01: the session's attendance names its people; anyone else is named by the names read.
  const attendanceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of attendance.data?.people ?? [])
      if (p.displayName) map.set(p.personId, p.displayName);
    return map;
  }, [attendance.data]);

  const candidateIds = useMemo(() => {
    const ids = new Set<string>();
    if (activity) {
      for (const p of attendance.data?.people ?? []) {
        if (p.effectiveState === 'present' || p.effectiveState === 'late') ids.add(p.personId);
      }
    } else {
      for (const v of onSite.data?.items ?? []) {
        if (v.personId && v.visitorCategory === 'participant') ids.add(v.personId);
      }
      // A scanned household child is a candidate at the desk only when on site.
      for (const p of scanned?.people ?? []) {
        if (p.kind === 'child' && p.onSite) ids.add(p.personId);
      }
    }
    return [...ids];
  }, [activity, attendance.data, onSite.data, scanned]);
  const names = usePersonNames(candidateIds);
  const childName = (id: string) =>
    knownNames.get(id) ?? attendanceNames.get(id) ?? nameOf(names, id);
  const collectorLabel = (r: RecordedRelease['release']) =>
    r.collectorPersonId
      ? (knownNames.get(r.collectorPersonId) ?? 'the identified collector')
      : (r.collectorDescription ?? 'the described collector');
  // Only children: a person the names read gives with kind "child", or a scanned dependent. In a
  // session every present or late person comes from its own attendance: keep them even when the
  // kind is not readable (the collector check says when someone is not a child).
  const children = candidateIds.filter((id) => {
    const scannedPerson = scanned?.people.find((p) => p.personId === id);
    if (scannedPerson) return scannedPerson.kind === 'child';
    const entry = names.get(id);
    if (activity && (entry?.status === 'unavailable' || entry?.status === 'error')) return true;
    return entry?.status === 'loading' || (entry?.status === 'ok' && entry.kind === 'child');
  });
  const awaiting = children.filter((id) => !released.includes(id));
  const withRecords = [...new Set([...children, ...recorded])];

  return (
    <div className="ops-release">
      {activity ? null : (
        <CollectorByPassScan
          facilityId={facilityId}
          collector={collector}
          onCollector={(c, scan) => {
            setCollector(c);
            setScanned(scan);
            if (scan) {
              remember(
                scan.people.map((p) => [p.personId, `${p.givenName} ${p.familyName}`.trim()]),
              );
            }
          }}
        />
      )}
      <section className="ops-section" aria-labelledby="awaiting-title">
        <h3 id="awaiting-title">Children awaiting release</h3>
        <QueryBoundary
          query={source}
          label="children awaiting release"
          isEmpty={() => awaiting.length === 0}
          empty={{
            title: 'No children awaiting release',
            description: activity
              ? 'No child is recorded present or late in this session.'
              : 'No child participant is recorded on site at this facility.',
          }}
          unavailableOffline={['supervised release']}
        >
          {() => (
            <fieldset className="ops-fieldset">
              <legend>Choose the child being collected</legend>
              {awaiting.map((id) => (
                <label key={id} className="ops-check">
                  <input
                    type="radio"
                    name="release-child"
                    value={id}
                    checked={childId === id}
                    onChange={() => setChildId(id)}
                  />
                  {childName(id)}
                </label>
              ))}
            </fieldset>
          )}
        </QueryBoundary>
      </section>
      {childId ? (
        <ReleaseForm
          key={childId}
          facilityId={facilityId}
          timezone={timezone}
          activity={activity}
          childPersonId={childId}
          childName={childName(childId)}
          deskCollector={collector}
          onChecked={(c) => remember([[c.personId, c.displayName]])}
          commands={commands}
          onRecorded={(outcome) => {
            // The record stays below even once the departure closes the visit and the on-site
            // read no longer lists the child; the name is kept as it was shown.
            remember([[childId, childName(childId)]]);
            setRecorded((prev) => (prev.includes(childId) ? prev : [...prev, childId]));
            if (outcome === 'released') {
              // Released: the child leaves the waiting list.
              setReleased((prev) => [...prev, childId]);
              setChildId(null);
            }
          }}
        />
      ) : null}
      <ReleaseOutcomes
        ids={withRecords}
        childName={childName}
        collectorLabel={collectorLabel}
        commands={commands}
        timezone={timezone}
      />
    </div>
  );
}

/** Desk only, children on site without a session: identify the collector by the pass scan. */
function CollectorByPassScan({
  facilityId,
  collector,
  onCollector,
}: {
  facilityId: string;
  collector: Collector | null;
  onCollector: (collector: Collector | null, scan: PassScan | null) => void;
}) {
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [scan, setScan] = useState<PassScan | null>(null);
  const scanCommand = useApiCommand('post', '/passes/scan');
  const adults = scan?.people.filter((p) => p.kind === 'adult') ?? [];

  const openPass = () =>
    void scanCommand
      .submit({ body: { reference: reference.trim(), facilityId } })
      .then((result) => {
        setScan(result);
        setReference('');
        const holder = result.people.find((p) => p.relation === 'holder' && p.kind === 'adult');
        onCollector(
          holder
            ? {
                kind: 'person',
                personId: holder.personId,
                name: `${holder.givenName} ${holder.familyName}`.trim(),
              }
            : null,
          result,
        );
      })
      .catch(() => undefined);

  return (
    <section className="ops-section" aria-labelledby="collector-title">
      <h3 id="collector-title">Collecting person</h3>
      {collector ? (
        <p data-testid="collector">
          Collecting:{' '}
          <strong>{collector.kind === 'person' ? collector.name : collector.description}</strong>
          {collector.kind === 'description'
            ? ' (no verified record: authority cannot be confirmed online)'
            : ''}
        </p>
      ) : (
        <p className="caption">
          Identify the adult collecting the child. Their authority is checked when you release. To
          check authority before releasing, release from the child&rsquo;s session.
        </p>
      )}
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reference.trim()) openPass();
        }}
      >
        <TextField
          label="Collecting person's pass reference"
          value={reference}
          onChange={setReference}
          hint="Scan the pass of the adult who is collecting."
          error={scanCommand.error?.isNotFound ? 'Pass not recognised.' : undefined}
        />
        <div className="ops-actions">
          <Button
            type="submit"
            variant="secondary"
            busy={scanCommand.isProcessing}
            disabled={!reference.trim()}
          >
            Identify by pass
          </Button>
        </div>
      </form>
      {scanCommand.error && !scanCommand.error.isNotFound ? (
        <CommandError error={scanCommand.error} onRetry={openPass} subject="This pass" />
      ) : null}
      {adults.length > 1 ? (
        <fieldset className="ops-fieldset">
          <legend>Which adult on this pass is collecting?</legend>
          {adults.map((p) => {
            const name = `${p.givenName} ${p.familyName}`.trim();
            return (
              <label key={p.personId} className="ops-check">
                <input
                  type="radio"
                  name="collector-adult"
                  checked={collector?.kind === 'person' && collector.personId === p.personId}
                  onChange={() => onCollector({ kind: 'person', personId: p.personId, name }, scan)}
                />
                {name}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <DescribeCollector
        value={description}
        onChange={setDescription}
        onUse={(d) => onCollector({ kind: 'description', description: d }, scan)}
      />
    </section>
  );
}

function DescribeCollector({
  value,
  onChange,
  onUse,
}: {
  value: string;
  onChange: (value: string) => void;
  onUse: (description: string) => void;
}) {
  return (
    <form
      className="ops-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onUse(value.trim());
      }}
    >
      <TextField
        label="Or describe a collector without a pass"
        value={value}
        onChange={onChange}
        hint="Without a verified record, current pickup authority cannot be established online; the release will be denied or escalated."
      />
      <div className="ops-actions">
        <Button type="submit" variant="secondary" disabled={!value.trim()}>
          Use this description
        </Button>
      </div>
    </form>
  );
}

/**
 * ENT-02 (SPK-ENTRY-007, SPK-AT-016): identify the collecting adult for this child and session by
 * their pass before anything is recorded. The pass reference travels in the body only.
 */
function CollectorCheckStep({
  activity,
  childPersonId,
  childName,
  collector,
  timezone,
  onCollector,
}: {
  activity: ActivityRef;
  childPersonId: string;
  childName: string;
  collector: Collector | null;
  timezone: string | null;
  onCollector: (collector: Collector | null, check: CollectorCheck | null) => void;
}) {
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const check = useApiCommand('post', '/releases/collector-checks');
  const result = check.data;
  const runCheck = () =>
    void check
      .submit({
        body: { activity, participantPersonId: childPersonId, passReference: reference.trim() },
      })
      .then((r) => {
        setReference('');
        onCollector(
          r.mayCollect && r.collector
            ? {
                kind: 'person',
                personId: r.collector.personId,
                name: r.collector.displayName,
                checkedAt: r.checkedAt,
              }
            : null,
          r,
        );
      })
      .catch(() => undefined);
  return (
    <div className="ops-section" role="group" aria-label={`Collecting person for ${childName}`}>
      <h4>Collecting person</h4>
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reference.trim()) runCheck();
        }}
      >
        <TextField
          label="Collecting person's pass reference"
          value={reference}
          onChange={setReference}
          hint="Scan the pass of the adult who is collecting. Checking records nothing."
        />
        <div className="ops-actions">
          <Button
            type="submit"
            variant="secondary"
            busy={check.isProcessing}
            disabled={!reference.trim()}
          >
            Check the collector
          </Button>
        </div>
      </form>
      {check.error ? (
        <CommandError error={check.error} onRetry={runCheck} subject="This check" />
      ) : null}
      {result ? (
        <div data-testid="collector-check" role="status">
          {result.mayCollect && result.collector ? (
            <StatusBadge tone="success" label={`May collect: ${result.collector.displayName}`} />
          ) : (
            <StatusBadge tone="danger" label={`Not confirmed to collect ${childName}`} />
          )}
          <p className="caption">
            Checked {formatInstant(result.checkedAt, timezone)}.{' '}
            {result.mayCollect
              ? ''
              : 'This pass does not show current pickup authority for this child in this session. Record the release to deny or escalate it.'}
          </p>
          {result.restrictions.length > 0 ? (
            <ul className="ops-history" aria-label="Collector check notes">
              {result.restrictions.map((r) => (
                <li key={r.code}>{r.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {collector?.kind === 'description' ? (
        <p data-testid="collector">
          Collecting: <strong>{collector.description}</strong> (no verified record: authority cannot
          be confirmed online)
        </p>
      ) : null}
      <DescribeCollector
        value={description}
        onChange={setDescription}
        onUse={(d) => onCollector({ kind: 'description', description: d }, null)}
      />
    </div>
  );
}

function ReleaseForm({
  facilityId,
  timezone,
  activity,
  childPersonId,
  childName,
  deskCollector,
  onChecked,
  commands,
  onRecorded,
}: {
  facilityId: string;
  timezone: string | null;
  activity?: ActivityRef;
  childPersonId: string;
  childName: string;
  /** Desk without a session: the collector identified by the pass scan above. */
  deskCollector: Collector | null;
  onChecked: (collector: { personId: string; displayName: string }) => void;
  commands: ReturnType<typeof useKeyedCommands>;
  /** A release record was written (released, or not released: denied, withheld, escalated). */
  onRecorded: (outcome: RecordedRelease['release']['outcome']) => void;
}) {
  const now = useNow();
  const [checked, setChecked] = useState<Collector | null>(null);
  const [checkAnswered, setCheckAnswered] = useState(false);
  const [withhold, setWithhold] = useState(false);
  const [restrictionNotes, setRestrictionNotes] = useState('');
  const [escalate, setEscalate] = useState(false);
  const [escalationNotes, setEscalationNotes] = useState('');
  const [problems, setProblems] = useState<{ collector?: string; restriction?: string }>({});
  const collector = activity ? checked : deskCollector;
  const key = `release|${childPersonId}`;
  const outcome = commands.outcome(key);
  const apiErrors = fieldErrorsOf(outcome.error);

  const submit = async () => {
    const next: typeof problems = {};
    if (!collector) {
      next.collector =
        activity && checkAnswered
          ? 'The checked pass does not confirm a collector. Describe the collecting person to record a denial or escalation.'
          : activity
            ? 'Identify the collecting person: check their pass or describe them.'
            : 'Identify the collecting person: scan their pass or describe them.';
    }
    if (withhold && !restrictionNotes.trim()) next.restriction = 'Say why the release is withheld.';
    setProblems(next);
    if (!collector || Object.keys(next).length > 0) return;
    const result = (await commands.run(key, 'post', '/releases', {
      body: {
        facilityId,
        childPersonId,
        collector:
          collector.kind === 'person'
            ? { personId: collector.personId }
            : { description: collector.description },
        ...(activity ? { activity } : {}),
        decision: withhold ? 'withhold' : 'release',
        escalate,
        // The API default: the child's open visit is closed together with a release.
        recordDeparture: true,
        ...(restrictionNotes.trim() ? { restrictionNotes: restrictionNotes.trim() } : {}),
        ...(escalate && escalationNotes.trim() ? { escalationNotes: escalationNotes.trim() } : {}),
      },
    })) as RecordedRelease | undefined;
    if (result) onRecorded(result.release.outcome);
  };

  return (
    <section className="ops-section" aria-labelledby="release-form-title">
      <h3 id="release-form-title">Release {childName}</h3>
      {activity ? (
        <CollectorCheckStep
          activity={activity}
          childPersonId={childPersonId}
          childName={childName}
          collector={checked}
          timezone={timezone}
          onCollector={(c, check) => {
            setChecked(c);
            setCheckAnswered(check !== null);
            if (c?.kind === 'person') onChecked({ personId: c.personId, displayName: c.name });
            setProblems((p) => ({ ...p, collector: undefined }));
          }}
        />
      ) : null}
      <p className="caption">
        {collector?.kind === 'person' && collector.checkedAt
          ? `Collector confirmed at ${formatInstant(collector.checkedAt, timezone)}; pickup authority is checked again when you confirm.`
          : `Checked against current pickup authority at ${formatInstant(now.toISOString(), timezone)} when you confirm.`}
      </p>
      {problems.collector ? (
        <p className="error-text" role="alert">
          <span aria-hidden="true">✕ </span>
          {problems.collector}
        </p>
      ) : null}
      <CheckboxField
        label="Withhold the release (a restriction or concern)"
        checked={withhold}
        onChange={setWithhold}
      />
      {withhold ? (
        <TextAreaField
          label="Restriction or concern"
          value={restrictionNotes}
          onChange={setRestrictionNotes}
          required
          error={problems.restriction ?? apiErrors.restrictionNotes}
        />
      ) : null}
      <CheckboxField
        label="If the collector is not authorised, escalate under the pickup procedure"
        checked={escalate}
        onChange={setEscalate}
        hint="The pickup procedure is pending (DEC-005, Operations); without escalation a denial is recorded and raised for follow-up."
      />
      {escalate ? (
        <TextAreaField
          label="Escalation notes"
          value={escalationNotes}
          onChange={setEscalationNotes}
        />
      ) : null}
      <div className="ops-actions">
        <Button busy={outcome.status === 'pending'} onClick={() => void submit()}>
          Check authority and release
        </Button>
      </div>
      {outcome.status === 'error' && outcome.error ? (
        <CommandError error={outcome.error} onRetry={() => void submit()} subject="This child" />
      ) : null}
    </section>
  );
}

function ReleaseOutcomes({
  ids,
  childName,
  collectorLabel,
  commands,
  timezone,
}: {
  ids: readonly string[];
  childName: (id: string) => string;
  collectorLabel: (r: RecordedRelease['release']) => string;
  commands: ReturnType<typeof useKeyedCommands>;
  timezone: string | null;
}) {
  const results = ids
    .map((id) => ({
      id,
      data: commands.outcome(`release|${id}`).data as RecordedRelease | undefined,
    }))
    .filter((r): r is { id: string; data: RecordedRelease } => r.data !== undefined);
  if (results.length === 0) return null;
  return (
    <section className="ops-section" aria-labelledby="release-outcomes-title">
      <h3 id="release-outcomes-title">Release records</h3>
      <ul className="list" aria-label="Release records">
        {results.map(({ id, data }) => (
          <ReleaseRecordView
            key={data.release.id}
            name={childName(id)}
            collector={collectorLabel(data.release)}
            recorded={data}
            timezone={timezone}
          />
        ))}
      </ul>
    </section>
  );
}

function ReleaseRecordView({
  name,
  collector,
  recorded,
  timezone,
}: {
  name: string;
  collector: string;
  recorded: RecordedRelease;
  timezone: string | null;
}) {
  const r = recorded.release;
  const verification = VERIFICATION_OUTCOME[r.verificationOutcome];
  const withheld = r.verificationOutcome === 'verified' && r.outcome === 'not_released';
  return (
    <li aria-label={`Release record for ${name}`}>
      <div className="row-text">
        <span className="row-title">{name}</span>
        {r.outcome === 'released' ? (
          <CommandSuccess label={`Released to ${collector}`} />
        ) : (
          <StatusBadge
            tone="danger"
            label={withheld ? 'Release withheld' : `Not released to ${collector}`}
          />
        )}
        <StatusBadge tone={verification.tone} label={verification.label} />
        {r.authorityGrantId ? (
          <span className="caption" data-testid="authority-grant">
            Authority relied on: collect permission, grant {shortRef(r.authorityGrantId)}.
          </span>
        ) : null}
        {r.denialReason ? <span>{r.denialReason}</span> : null}
        {r.collectorPermissions.length > 0 ? (
          <span className="caption">
            Permissions the collector holds now: {r.collectorPermissions.join(', ')}. Only collect
            authorises a release.
          </span>
        ) : null}
        {r.restrictionNotes ? (
          <span className="caption">Restriction: {r.restrictionNotes}</span>
        ) : null}
        {r.escalationNotes ? (
          <span className="caption">Escalation: {r.escalationNotes}</span>
        ) : null}
        {r.escalationExceptionId ? (
          <span className="caption">Raised for follow-up in the Today workspace.</span>
        ) : null}
        <span className="caption">
          Checked {formatInstant(r.authorityCheckedAt, timezone)} by {r.staffActor.actorLabel}
          {recorded.departure ? '; departure recorded' : ''}.
        </span>
      </div>
    </li>
  );
}
