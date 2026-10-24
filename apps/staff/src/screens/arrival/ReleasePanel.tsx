/**
 * Supervised release, shared by SCR-S-30 (front desk) and SCR-W-09 (the assigned coach)
 * (SPK-ENTRY-007, SPK-COND-004, §4.15, SPK-AT-016, DEC-005, DEC-034, DEC-075).
 *
 * - Current pickup authority is verified by the API at the moment of release
 *   (`POST /v1/releases`); the dashboard never decides it and never shows cached authority (the
 *   pass scan's `holderMayCollect` is not displayed). Schedule visibility and payment permission
 *   do not establish pickup authority; the API's denial reason says so.
 * - The record shows child, collecting person, verification outcome, staff actor, time,
 *   restriction or escalation, and release outcome. One child at a time: partial completion is
 *   per child (one released, one escalated).
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
import { formatInstant } from '../../features/operations/format';
import { VERIFICATION_OUTCOME } from '../../features/operations/labels';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary, type QueryLike } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type PassScan = Schema<'PassScan'>;
type RecordedRelease = Schema<'RecordedRelease'>;

type Collector =
  { kind: 'person'; personId: string; name: string } | { kind: 'description'; description: string };

export interface ReleasePanelProps {
  facilityId: string;
  timezone: string | null;
  /** The assigned session (SCR-W-09): children come from its attendance. */
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
  // Names of everyone identified by a pass scan in this panel (collectors included).
  const [knownNames, setKnownNames] = useState<ReadonlyMap<string, string>>(new Map());
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
    }
    for (const p of scanned?.people ?? []) if (p.kind === 'child') ids.add(p.personId);
    return [...ids];
  }, [activity, attendance.data, onSite.data, scanned]);
  const names = usePersonNames(candidateIds);
  const childName = (id: string) => knownNames.get(id) ?? nameOf(names, id);
  const collectorLabel = (r: RecordedRelease['release']) =>
    r.collectorPersonId
      ? (knownNames.get(r.collectorPersonId) ?? 'the identified collector')
      : (r.collectorDescription ?? 'the described collector');
  // Only children: a person record the viewer can read with kind "child", or a scanned dependent.
  const children = candidateIds.filter((id) => {
    const scannedPerson = scanned?.people.find((p) => p.personId === id);
    if (scannedPerson) return scannedPerson.kind === 'child';
    const entry = names.get(id);
    return entry?.status === 'loading' || (entry?.status === 'ok' && entry.kind === 'child');
  });
  const awaiting = children.filter((id) => !released.includes(id));

  return (
    <div className="ops-release">
      <CollectorIdentification
        facilityId={facilityId}
        collector={collector}
        onCollector={(c, scan) => {
          setCollector(c);
          setScanned(scan);
          if (scan) {
            setKnownNames((prev) => {
              const next = new Map(prev);
              for (const p of scan.people)
                next.set(p.personId, `${p.givenName} ${p.familyName}`.trim());
              return next;
            });
          }
        }}
      />
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
          activity={activity}
          childPersonId={childId}
          childName={childName(childId)}
          collector={collector}
          timezone={timezone}
          commands={commands}
          onReleased={() => {
            // Released: the child leaves the waiting list; the record stays below.
            setReleased((prev) => [...prev, childId]);
            setChildId(null);
          }}
        />
      ) : null}
      <ReleaseOutcomes
        ids={children}
        childName={childName}
        collectorLabel={collectorLabel}
        commands={commands}
        timezone={timezone}
      />
    </div>
  );
}

function CollectorIdentification({
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
          Identify the adult collecting the child. Their authority is checked when you release.
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
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (description.trim())
            onCollector({ kind: 'description', description: description.trim() }, scan);
        }}
      >
        <TextField
          label="Or describe a collector without a pass"
          value={description}
          onChange={setDescription}
          hint="Without a verified record, current pickup authority cannot be established online; the release will be denied or escalated."
        />
        <div className="ops-actions">
          <Button type="submit" variant="secondary" disabled={!description.trim()}>
            Use this description
          </Button>
        </div>
      </form>
    </section>
  );
}

function ReleaseForm({
  facilityId,
  activity,
  childPersonId,
  childName,
  collector,
  commands,
  onReleased,
}: {
  facilityId: string;
  activity?: ActivityRef;
  childPersonId: string;
  childName: string;
  collector: Collector | null;
  timezone: string | null;
  commands: ReturnType<typeof useKeyedCommands>;
  onReleased: () => void;
}) {
  const now = useNow();
  const [withhold, setWithhold] = useState(false);
  const [restrictionNotes, setRestrictionNotes] = useState('');
  const [escalate, setEscalate] = useState(false);
  const [escalationNotes, setEscalationNotes] = useState('');
  const [problems, setProblems] = useState<{ collector?: string; restriction?: string }>({});
  const key = `release|${childPersonId}`;
  const outcome = commands.outcome(key);
  const apiErrors = fieldErrorsOf(outcome.error);

  const submit = async () => {
    const next: typeof problems = {};
    if (!collector)
      next.collector = 'Identify the collecting person: scan their pass or describe them.';
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
    if (result?.release.outcome === 'released') onReleased();
  };

  return (
    <section className="ops-section" aria-labelledby="release-form-title">
      <h3 id="release-form-title">Release {childName}</h3>
      <p className="caption">
        Checked against current pickup authority at {formatInstant(now.toISOString())} when you
        confirm.
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
