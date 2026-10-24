/**
 * SCR-S-07 Resource inventory and configurations (SPK-SCHED-001, SPK-SCHED-002, SPK-SCHED-003;
 * DEC-001 pending). The facility's pitches, subdivisions, rooms and other spaces with dimensions,
 * compatible formats, setup and cleanup buffers, required equipment and staffing constraints; the
 * whole-space and subdivision relationships; the conflict units the API derives (a whole pitch
 * occupies every subdivision's unit); physical arrangements (configurations); operating hours.
 *
 * Commands: `POST /v1/resources`, `PATCH /v1/resources/{id}` (`expectedRevision`),
 * `POST /v1/resource-configurations`, `PATCH /v1/resource-configurations/{id}`,
 * `POST /v1/operating-hours`, `DELETE /v1/operating-hours/{id}`, each with an idempotency key per
 * intent. A failed save keeps the form input. The actual inventory of the complex is DEC-001
 * (Operations): the screen shows what has been entered, never an assumed layout.
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  FacilityGate,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import {
  orderedInventory,
  resourceNames,
  sharesSpace,
} from '../../features/schedule-facilities/inventory';
import {
  RESOURCE_BADGE,
  RESOURCE_KIND_LABEL,
  WEEKDAY_LABEL,
} from '../../features/schedule-facilities/labels';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';

type Resource = Schema<'Resource'>;
type ResourceKind = Resource['kind'];
type ResourceStatus = Resource['status'];

const INVENTORY_KEYS = [
  ['api', '/resources'],
  ['api', '/conflict-units'],
  ['api', '/resource-configurations'],
] as const;

const LOCAL_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function minutesOrNull(text: string): number | null | 'invalid' {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : 'invalid';
}

function listFromText(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "length: 100" per line into a record (values kept as text unless numeric). */
function recordFromLines(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (!key) continue;
    out[key] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

function linesFromRecord(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ResourceEditor({ resource, onDone }: { resource: Resource; onDone: () => void }) {
  const { online } = useApp();
  const [name, setName] = useState(resource.name);
  const [formats, setFormats] = useState(resource.compatibleFormats.join(', '));
  const [setup, setSetup] = useState(String(resource.defaultSetupMinutes));
  const [cleanup, setCleanup] = useState(String(resource.defaultCleanupMinutes));
  const [status, setStatus] = useState<ResourceStatus>(resource.status);
  const [equipment, setEquipment] = useState(resource.requiredEquipment.map(show).join(', '));
  const [dimensions, setDimensions] = useState(linesFromRecord(resource.dimensions));
  const save = useApiCommand('patch', '/resources/{id}', { invalidate: INVENTORY_KEYS });
  const setupMinutes = minutesOrNull(setup);
  const cleanupMinutes = minutesOrNull(cleanup);
  const problem = !name.trim()
    ? 'Enter a name.'
    : setupMinutes === 'invalid' ||
        cleanupMinutes === 'invalid' ||
        setupMinutes === null ||
        cleanupMinutes === null
      ? 'Buffers are whole minutes from 0 to 1440.'
      : null;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (problem || typeof setupMinutes !== 'number' || typeof cleanupMinutes !== 'number') return;
    void save
      .submit({
        path: { id: resource.id },
        body: {
          expectedRevision: resource.revision,
          name: name.trim(),
          compatibleFormats: listFromText(formats),
          defaultSetupMinutes: setupMinutes,
          defaultCleanupMinutes: cleanupMinutes,
          status,
          requiredEquipment: listFromText(equipment),
          dimensions: recordFromLines(dimensions),
        },
      })
      .then(onDone)
      .catch(() => undefined);
  };
  const id = `edit-${resource.id}`;
  return (
    <form className="form" onSubmit={submit} aria-label={`Edit ${resource.name}`} noValidate>
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        id={`${id}-name`}
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor={`${id}-formats`}>Compatible formats (comma separated)</label>
      <input id={`${id}-formats`} value={formats} onChange={(e) => setFormats(e.target.value)} />
      <label htmlFor={`${id}-setup`}>Default setup minutes</label>
      <input
        id={`${id}-setup`}
        inputMode="numeric"
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
      />
      <label htmlFor={`${id}-cleanup`}>Default cleanup minutes</label>
      <input
        id={`${id}-cleanup`}
        inputMode="numeric"
        value={cleanup}
        onChange={(e) => setCleanup(e.target.value)}
      />
      <label htmlFor={`${id}-status`}>Inventory status</label>
      <select
        id={`${id}-status`}
        value={status}
        onChange={(e) => setStatus(e.target.value as ResourceStatus)}
      >
        <option value="active">active</option>
        <option value="restricted">restricted</option>
        <option value="closed">closed</option>
      </select>
      <label htmlFor={`${id}-equipment`}>Required equipment (comma separated)</label>
      <input
        id={`${id}-equipment`}
        value={equipment}
        onChange={(e) => setEquipment(e.target.value)}
      />
      <label htmlFor={`${id}-dimensions`}>
        Dimensions or supported configurations (one "name: value" per line)
      </label>
      <textarea
        id={`${id}-dimensions`}
        rows={3}
        value={dimensions}
        onChange={(e) => setDimensions(e.target.value)}
      />
      {problem ? <span className="error-text">{problem}</span> : null}
      <span className="field-row">
        <Button type="submit" busy={save.isProcessing} disabled={!online || problem !== null}>
          Save
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </span>
      {save.error ? (
        <CommandError error={save.error} onRetry={() => submit()} action="Saving the space" />
      ) : null}
    </form>
  );
}

function ResourceCard({
  resource,
  depth,
  all,
  units,
}: {
  resource: Resource;
  depth: number;
  all: readonly Resource[];
  units: ReadonlyMap<string, string>;
}) {
  const [editing, setEditing] = useState(false);
  const names = resourceNames(all);
  const sharing = all.filter((r) => sharesSpace(r, resource));
  const badge = RESOURCE_BADGE[resource.status];
  const headingId = `inventory-${resource.id}`;
  return (
    <li style={{ marginInlineStart: `${depth * 24}px` }} aria-labelledby={headingId}>
      <div className="row-text">
        <span className="row-title" id={headingId}>
          {resource.name}
        </span>
        <span className="caption">
          {RESOURCE_KIND_LABEL[resource.kind]}
          {resource.parentResourceId
            ? `, inside ${names.get(resource.parentResourceId) ?? 'its whole space'}`
            : ''}
          {' · '}Formats: {resource.compatibleFormats.join(', ') || 'none listed'}
          {' · '}Setup {resource.defaultSetupMinutes} min, cleanup {resource.defaultCleanupMinutes}{' '}
          min
        </span>
        <span className="caption">
          Dimensions:{' '}
          {Object.keys(resource.dimensions).length
            ? Object.entries(resource.dimensions)
                .map(([k, v]) => `${k} ${show(v)}`)
                .join(', ')
            : 'not recorded'}
          {' · '}Required equipment: {resource.requiredEquipment.map(show).join(', ') || 'none'}
          {' · '}Staffing constraints:{' '}
          {Object.keys(resource.staffingConstraints).length
            ? Object.entries(resource.staffingConstraints)
                .map(([k, v]) => `${k} ${show(v)}`)
                .join(', ')
            : 'none'}
        </span>
        <span className="caption">
          Conflict units:{' '}
          {resource.conflictUnitIds.map((u) => units.get(u) ?? 'unnamed unit').join(', ') || 'none'}
          {sharing.length
            ? ` · Conflicts with ${sharing.map((r) => r.name).join(', ')}`
            : ' · Conflicts with no other space'}
        </span>
      </div>
      <StatusBadge tone={badge.tone} label={`Inventory status: ${badge.label}`} />
      {editing ? (
        <ResourceEditor resource={resource} onDone={() => setEditing(false)} />
      ) : (
        <Button
          variant="secondary"
          aria-label={`Edit ${resource.name}`}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      )}
    </li>
  );
}

function NewResourceForm({
  facility,
  resources,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
}) {
  const { online } = useApp();
  const [kind, setKind] = useState<'' | ResourceKind>('');
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [formats, setFormats] = useState('');
  const [setup, setSetup] = useState('');
  const [cleanup, setCleanup] = useState('');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/resources', { invalidate: INVENTORY_KEYS });
  const setupMinutes = minutesOrNull(setup);
  const cleanupMinutes = minutesOrNull(cleanup);
  const parents = resources.filter((r) => r.kind !== 'subdivision');
  const problems = [
    !kind ? 'Choose the kind of space.' : null,
    !name.trim() ? 'Enter a name.' : null,
    kind === 'subdivision' && !parent
      ? 'A subdivision must be inside a whole space: choose it.'
      : null,
    setupMinutes === 'invalid' || cleanupMinutes === 'invalid'
      ? 'Buffers are whole minutes from 0 to 1440.'
      : null,
  ].filter((p): p is string => p !== null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (problems.length > 0 || !kind) return;
    void create
      .submit({
        body: {
          facilityId: facility.id,
          kind,
          name: name.trim(),
          ...(parent ? { parentResourceId: parent } : {}),
          ...(formats.trim() ? { compatibleFormats: listFromText(formats) } : {}),
          ...(typeof setupMinutes === 'number' ? { defaultSetupMinutes: setupMinutes } : {}),
          ...(typeof cleanupMinutes === 'number' ? { defaultCleanupMinutes: cleanupMinutes } : {}),
        },
      })
      .then(() => {
        setName('');
        setParent('');
        setFormats('');
        setSetup('');
        setCleanup('');
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-resource-title" noValidate>
      <h4 id="new-resource-title">Add a space</h4>
      <label htmlFor="new-resource-kind">Kind</label>
      <select
        id="new-resource-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as '' | ResourceKind)}
      >
        <option value="">Choose…</option>
        {(Object.keys(RESOURCE_KIND_LABEL) as ResourceKind[]).map((k) => (
          <option key={k} value={k}>
            {RESOURCE_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <label htmlFor="new-resource-name">Name</label>
      <input
        id="new-resource-name"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="new-resource-parent">Inside (whole space)</label>
      <select id="new-resource-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">{kind === 'subdivision' ? 'Choose…' : 'Not part of another space'}</option>
        {parents.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <label htmlFor="new-resource-formats">Compatible formats (comma separated)</label>
      <input
        id="new-resource-formats"
        value={formats}
        onChange={(e) => setFormats(e.target.value)}
      />
      <label htmlFor="new-resource-setup">Default setup minutes</label>
      <input
        id="new-resource-setup"
        inputMode="numeric"
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
      />
      <label htmlFor="new-resource-cleanup">Default cleanup minutes</label>
      <input
        id="new-resource-cleanup"
        inputMode="numeric"
        value={cleanup}
        onChange={(e) => setCleanup(e.target.value)}
      />
      {attempted && problems.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {problems.map((p) => (
            <li key={p} className="error-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="submit" busy={create.isProcessing} disabled={!online}>
        Add space
      </Button>
      {create.error ? (
        <CommandError error={create.error} onRetry={() => submit()} action="Adding a space" />
      ) : null}
    </form>
  );
}

function Configurations({
  facility,
  resources,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
}) {
  const { online } = useApp();
  const configurations = useApiQuery({
    path: '/resource-configurations',
    request: { query: { facilityId: facility.id } },
  });
  const names = resourceNames(resources);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/resource-configurations', { invalidate: INVENTORY_KEYS });
  const toggle = useApiCommand('patch', '/resource-configurations/{id}', {
    invalidate: INVENTORY_KEYS,
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (!name.trim() || members.length === 0) return;
    void create
      .submit({ body: { facilityId: facility.id, name: name.trim(), memberResourceIds: members } })
      .then(() => {
        setName('');
        setMembers([]);
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="configurations-title">
      <h4 id="configurations-title">Physical arrangements</h4>
      <p className="caption">
        An arrangement lists the spaces that may be used at the same time, for example a full pitch,
        or two halves.
      </p>
      <QueryBoundary
        query={configurations}
        label="arrangements"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No arrangements',
          description: 'Add one below to say which spaces can run together.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Arrangements">
            {list.map((c) => (
              <li key={c.id}>
                <div className="row-text">
                  <span className="row-title">{c.name}</span>
                  <span className="caption">
                    {c.memberResourceIds.map((id) => names.get(id) ?? 'a space').join(' + ')}
                    {c.description ? ` · ${c.description}` : ''}
                  </span>
                </div>
                <StatusBadge
                  tone={c.active ? 'success' : 'neutral'}
                  label={c.active ? 'active' : 'inactive'}
                />
                <Button
                  variant="secondary"
                  disabled={!online}
                  busy={toggle.isProcessing}
                  aria-label={`${c.active ? 'Deactivate' : 'Activate'} ${c.name}`}
                  onClick={() =>
                    void toggle
                      .submit({
                        path: { id: c.id },
                        body: { expectedRevision: c.revision, active: !c.active },
                      })
                      .catch(() => undefined)
                  }
                >
                  {c.active ? 'Deactivate' : 'Activate'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      {toggle.error ? (
        <CommandError error={toggle.error} action="Changing the arrangement" />
      ) : null}
      <form className="form" onSubmit={submit} aria-label="Add an arrangement" noValidate>
        <label htmlFor="configuration-name">Arrangement name</label>
        <input
          id="configuration-name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <ResourceChecklist
          legend="Spaces used together"
          resources={resources}
          value={members}
          onChange={setMembers}
          error={attempted && members.length === 0 ? 'Choose at least one space.' : null}
        />
        {attempted && !name.trim() ? <span className="error-text">Enter a name.</span> : null}
        <Button type="submit" busy={create.isProcessing} disabled={!online}>
          Add arrangement
        </Button>
        {create.error ? (
          <CommandError
            error={create.error}
            onRetry={() => submit()}
            action="Adding an arrangement"
          />
        ) : null}
      </form>
    </section>
  );
}

function OperatingHours({
  facility,
  resources,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
}) {
  const { online } = useApp();
  const hours = useApiQuery({
    path: '/operating-hours',
    request: { query: { facilityId: facility.id } },
  });
  const names = resourceNames(resources);
  const [resourceId, setResourceId] = useState('');
  const [weekday, setWeekday] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [attempted, setAttempted] = useState(false);
  const add = useApiCommand('post', '/operating-hours', {
    invalidate: [['api', '/operating-hours']],
  });
  const remove = useApiCommand('delete', '/operating-hours/{id}', {
    invalidate: [['api', '/operating-hours']],
  });
  const problem =
    weekday === ''
      ? 'Choose a day.'
      : !LOCAL_TIME.test(opensAt) || !LOCAL_TIME.test(closesAt)
        ? 'Enter opening and closing times as HH:MM (24:00 allowed for closing).'
        : opensAt >= closesAt
          ? 'Opening must be before closing.'
          : null;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (problem) return;
    void add
      .submit({
        body: {
          facilityId: facility.id,
          ...(resourceId ? { resourceId } : {}),
          weekday: Number(weekday),
          opensAt,
          closesAt,
        },
      })
      .then(() => setAttempted(false))
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="hours-title">
      <h4 id="hours-title">Operating hours ({facility.timezone})</h4>
      <QueryBoundary
        query={hours}
        label="operating hours"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No operating hours',
          description: 'Without hours, no opening window is checked.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Operating hours">
            {[...list]
              .sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt))
              .map((h) => {
                const label = `${WEEKDAY_LABEL[h.weekday] ?? h.weekday} ${h.opensAt} to ${h.closesAt}, ${h.resourceId ? (names.get(h.resourceId) ?? 'a space') : 'whole facility'}`;
                return (
                  <li key={h.id}>
                    <span>{label}</span>
                    <Button
                      variant="secondary"
                      disabled={!online}
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        void remove.submit({ path: { id: h.id } }).catch(() => undefined)
                      }
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
          </ul>
        )}
      </QueryBoundary>
      {remove.error ? <CommandError error={remove.error} action="Removing the window" /> : null}
      <form className="form" onSubmit={submit} aria-label="Add operating hours" noValidate>
        <label htmlFor="hours-scope">Applies to</label>
        <select id="hours-scope" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
          <option value="">Whole facility</option>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <label htmlFor="hours-day">Day</label>
        <select id="hours-day" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
          <option value="">Choose…</option>
          {WEEKDAY_LABEL.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
        <label htmlFor="hours-opens">Opens (HH:MM)</label>
        <input
          id="hours-opens"
          value={opensAt}
          placeholder="08:00"
          onChange={(e) => setOpensAt(e.target.value)}
        />
        <label htmlFor="hours-closes">Closes (HH:MM)</label>
        <input
          id="hours-closes"
          value={closesAt}
          placeholder="22:00"
          onChange={(e) => setClosesAt(e.target.value)}
        />
        {attempted && problem ? <span className="error-text">{problem}</span> : null}
        <Button type="submit" busy={add.isProcessing} disabled={!online}>
          Add hours
        </Button>
        {add.error ? (
          <CommandError
            error={add.error}
            onRetry={() => submit()}
            action="Adding operating hours"
          />
        ) : null}
      </form>
    </section>
  );
}

function Inventory({ facility }: { facility: FacilityContext }) {
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.id } },
  });
  const units = useApiQuery({
    path: '/conflict-units',
    request: { query: { facilityId: facility.id } },
  });
  const unitNames = new Map((units.data ?? []).map((u) => [u.id, u.name]));
  return (
    <div>
      <StateView
        variant="pending-decision"
        subject="Confirmation of the actual facilities, spaces, subdivisions and hours"
        decisions={['DEC-001']}
        owner="Operations"
      />
      <p className="caption">What is shown here is what has been entered, not an assumed layout.</p>
      <QueryBoundary
        query={resources}
        label="the resource inventory"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No spaces yet',
          description:
            'This is the first setup: add the facility’s pitches, their subdivisions and other spaces below.',
        }}
        unavailableOffline={['adding or editing spaces']}
      >
        {(list) => (
          <ul className="list" aria-label="Spaces">
            {orderedInventory(list).map(({ resource, depth }) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                depth={depth}
                all={list}
                units={unitNames}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <NewResourceForm facility={facility} resources={resources.data ?? []} />
      <Configurations facility={facility} resources={resources.data ?? []} />
      <OperatingHours facility={facility} resources={resources.data ?? []} />
    </div>
  );
}

export function ResourceInventoryScreen() {
  return (
    <section aria-labelledby="inventory-title">
      <h3 id="inventory-title">Resource inventory</h3>
      <FacilityGate purpose="see its spaces">
        {(facility) => <Inventory facility={facility} />}
      </FacilityGate>
    </section>
  );
}
