/**
 * SCR-S-19 Youth group placement (SPK-YOUTH-002 group size, space and staffing, and raising
 * commercial capacity never bypasses staffing; SPK-YOUTH-006 progression recommendations;
 * SPK-PLACE-003; SPK-UX-008). For one offering it shows each group's capacity pools side by side
 * (commercial, staffing, space) and the places available now, which is the smallest of them, with
 * the limiting constraint named. A staffing pool changes only through its staff count, with a
 * reason; a commercial or space pool through its capacity, with a reason; both carry
 * `expectedRevision`, and a capacity below what is committed is refused by the API.
 *
 * Not available yet, and shown as such: assigning an enrolled child to a group (the API has no
 * group membership command) and recording progression recommendations (no API; DEC-055 pending).
 * Children are listed by name only: no date of birth, contact or medical detail (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import {
  keys,
  PageButtons,
  PendingNote,
  SuccessNote,
  useCursorStack,
  useRefetch,
} from '../../features/competition/feedback';
import {
  NumberField,
  SelectField,
  TextAreaField,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatDateOnly, shortRef } from '../../features/competition/format';
import { CAPACITY_CONSTRAINT, humanizeCode } from '../../features/competition/labels';
import { TeamsNav } from '../../features/competition/nav';
import { PersonName } from '../../features/competition/names';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Pool = Schema<'CapacityPool'>;
type OfferingKind = Schema<'OfferingKind'>;

const YOUTH_KINDS: readonly { value: OfferingKind; label: string }[] = [
  { value: 'camp', label: 'Camp' },
  { value: 'term', label: 'Term' },
  { value: 'session', label: 'Session' },
  { value: 'trial', label: 'Trial' },
  { value: 'private_coaching', label: 'Private coaching' },
];

export interface PoolGroup {
  key: string;
  scopeType: Pool['scopeType'];
  scopeId: string;
  pools: Pool[];
  /** Places one more child could take now: the smallest availability across the group's pools. */
  available: number;
  limitedBy: Pool['constraintKind'] | null;
}

export function groupPools(pools: readonly Pool[]): PoolGroup[] {
  const groups = new Map<string, PoolGroup>();
  for (const pool of pools) {
    const key = `${pool.scopeType}:${pool.scopeId}`;
    const group =
      groups.get(key) ??
      ({
        key,
        scopeType: pool.scopeType,
        scopeId: pool.scopeId,
        pools: [],
        available: Number.POSITIVE_INFINITY,
        limitedBy: null,
      } satisfies PoolGroup);
    group.pools.push(pool);
    if (pool.status === 'active' && pool.available < group.available) {
      group.available = pool.available;
      group.limitedBy = pool.constraintKind;
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((g) =>
    Number.isFinite(g.available) ? g : { ...g, available: 0, limitedBy: null },
  );
}

function AdjustPool({ pool }: { pool: Pool }) {
  const adjust = useApiCommand('post', '/capacity-pools/{id}/adjust', {
    invalidate: keys('/capacity-pools'),
  });
  const reload = useRefetch(['/capacity-pools']);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const staffing = pool.constraintKind === 'staffing';
  const submit = () => {
    const next: Record<string, string> = {};
    const n = parseWholeNumber(value);
    if (n === null || n < 0)
      next.value = staffing ? 'Enter the staff count.' : 'Enter the capacity.';
    if (!reason.trim()) next.reason = 'Give the reason for the change.';
    setErrors(next);
    if (Object.keys(next).length > 0 || n === null) return;
    void adjust
      .submit({
        path: { id: pool.id },
        body: {
          expectedRevision: pool.revision,
          reason: reason.trim(),
          ...(staffing ? { staffCount: n } : { capacity: n }),
        },
      })
      .catch(() => undefined);
  };
  const label = staffing ? 'Change the staff count' : 'Change the capacity';
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-label={`${label}: ${CAPACITY_CONSTRAINT[pool.constraintKind]}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <NumberField
        label={staffing ? 'Staff count' : 'Capacity'}
        required
        value={value}
        onChange={setValue}
        error={errors.value}
        hint={
          staffing && pool.participantsPerStaff !== null
            ? `Capacity becomes the staff count × ${pool.participantsPerStaff} participants per staff member.`
            : 'It cannot drop below the places already committed or held.'
        }
      />
      <TextAreaField
        label="Reason"
        required
        value={reason}
        onChange={setReason}
        error={errors.reason}
      />
      <div className="actions">
        <CommandButton type="submit" busy={adjust.isProcessing}>
          Save
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {adjust.status === 'success' && adjust.data ? (
        <SuccessNote>{`Capacity ${adjust.data.capacity}, ${adjust.data.available} available`}</SuccessNote>
      ) : null}
      <CommandError
        error={adjust.error}
        onRetry={submit}
        onReload={() => {
          adjust.reset();
          reload();
        }}
      />
    </form>
  );
}

function GroupCard({ group }: { group: PoolGroup }) {
  const title =
    group.scopeType === 'camp_group'
      ? `Group ${shortRef(group.scopeId)}`
      : `${humanizeCode(group.scopeType)} ${shortRef(group.scopeId)}`;
  return (
    <li aria-labelledby={`group-${group.key}`}>
      <div className="row-text">
        <span className="row-title" id={`group-${group.key}`}>
          {title}
        </span>
        <span>
          <StatusBadge
            tone={group.available > 0 ? 'success' : 'warning'}
            label={`${group.available} ${group.available === 1 ? 'place' : 'places'} available now`}
          />
          {group.limitedBy ? (
            <span className="caption"> limited by: {CAPACITY_CONSTRAINT[group.limitedBy]}</span>
          ) : null}
        </span>
        <div className="table-scroll">
          <table className="data-table">
            <caption>Capacity of {title}</caption>
            <thead>
              <tr>
                <th scope="col">Constraint</th>
                <th scope="col">Capacity</th>
                <th scope="col">Committed</th>
                <th scope="col">Held</th>
                <th scope="col">Available</th>
                <th scope="col">Staffing</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {group.pools.map((pool) => (
                <tr key={pool.id}>
                  <th scope="row">
                    {CAPACITY_CONSTRAINT[pool.constraintKind]}
                    {pool.status === 'closed' ? ' (closed)' : ''}
                  </th>
                  <td>{pool.capacity}</td>
                  <td>{pool.committed}</td>
                  <td>{pool.held}</td>
                  <td>{pool.available}</td>
                  <td>
                    {pool.constraintKind === 'staffing'
                      ? `${pool.staffCount ?? 0} staff × ${pool.participantsPerStaff ?? 0} each`
                      : 'Not a staffing limit'}
                  </td>
                  <td>{pool.status === 'active' ? <AdjustPool pool={pool} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="caption">
          Raising the commercial capacity never raises the staffing or space limit: places available
          now is always the smallest of them.
        </span>
      </div>
    </li>
  );
}

function OfferingGroups({ offeringId }: { offeringId: string }) {
  const offering = useApiQuery({ path: '/offerings/{id}', request: { path: { id: offeringId } } });
  const pools = useApiQuery({ path: '/capacity-pools', request: { query: { offeringId } } });
  const pages = useCursorStack();
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: {
      query: {
        offeringId,
        status: 'confirmed',
        limit: 100,
        ...(pages.cursor ? { cursor: pages.cursor } : {}),
      },
    },
  });
  const units = offering.data?.staff?.capacityUnits ?? [];
  return (
    <>
      {offering.data ? (
        <section className="panel" aria-labelledby="config-title">
          <h3 id="config-title">{offering.data.name}</h3>
          <p className="caption">
            {formatDateOnly(offering.data.startsOn)} to {formatDateOnly(offering.data.endsOn)}
          </p>
          {units.length === 0 ? (
            <p>No group size or staffing requirement is configured for this offering.</p>
          ) : (
            <ul aria-label="Configured capacity">
              {units.map((unit) => (
                <li key={unit.unit}>
                  {humanizeCode(unit.unit)}: limit {unit.limit}
                  {unit.groupSize !== undefined ? `, groups of ${unit.groupSize}` : ''}
                  {unit.staffingRatio
                    ? `, ${unit.staffingRatio.participantsPerStaff} participants per staff member`
                    : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <section className="panel" aria-labelledby="groups-title">
        <h3 id="groups-title">Groups and capacity</h3>
        <QueryBoundary
          query={pools}
          label="capacity pools"
          isEmpty={(data) => data.length === 0}
          empty={{
            title: 'No capacity pools',
            description:
              'Pools are created from the offering’s configured capacity units. None exist for this offering yet.',
          }}
          unavailableOffline={['changing capacity or staffing']}
        >
          {(data) => (
            <ul className="list" aria-label="Groups">
              {groupPools(data).map((group) => (
                <GroupCard key={group.key} group={group} />
              ))}
            </ul>
          )}
        </QueryBoundary>
      </section>
      <section className="panel" aria-labelledby="children-title">
        <h3 id="children-title">Enrolled children</h3>
        <StateView
          variant="unavailable"
          title="Assigning a child to a group: not available yet"
          description="The API records no group membership yet, so children cannot be placed in a group from here."
        />
        <QueryBoundary
          query={enrollments}
          label="enrollments"
          isEmpty={(data) => data.items.length === 0 && pages.depth === 0}
          empty={{
            title: 'No unplaced children',
            description: 'Children with a confirmed enrollment in this offering appear here.',
          }}
        >
          {(data) => (
            <>
              <ul className="list" aria-label="Enrolled children">
                {data.items.map((enrollment) => (
                  <li key={enrollment.id}>
                    <div className="row-text">
                      <span className="row-title">
                        <PersonName personId={enrollment.participantPersonId} />
                      </span>
                      <span className="caption">
                        Enrollment {enrollment.status} · Group: not recorded
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <PageButtons
                what="enrolled children"
                depth={pages.depth}
                nextCursor={data.nextCursor}
                onNext={pages.next}
                onPrevious={pages.previous}
              />
            </>
          )}
        </QueryBoundary>
      </section>
      <section className="panel" aria-labelledby="progression-title">
        <h3 id="progression-title">Progression recommendations</h3>
        <PendingNote decision={PENDING.progression} />
        <p className="caption">
          A recommendation explains eligibility and suitability from approved information and never
          guarantees acceptance, availability or purchase. Recording one is not available yet: the
          API has no progression record.
        </p>
      </section>
    </>
  );
}

export function YouthGroupsScreen() {
  const { facilityId } = useApp();
  const [kind, setKind] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const offerings = useApiQuery({
    path: '/offerings',
    request: {
      query: {
        limit: 100,
        ...(kind ? { kind: kind as OfferingKind } : {}),
        ...(facilityId ? { facilityId } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="youth-title">
      <h2 id="youth-title">Youth group placement</h2>
      <TeamsNav />
      <PendingNote decision={PENDING.youthGroups} />
      <div className="actions">
        <SelectField
          label="Offering kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setOfferingId('');
          }}
          options={YOUTH_KINDS}
          placeholder="All kinds"
        />
        <SelectField
          label="Offering"
          value={offeringId}
          onChange={setOfferingId}
          options={(offerings.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
          hint={
            offerings.error
              ? `Offerings could not be loaded (${offerings.error.code}).`
              : offerings.data && offerings.data.items.length === 0
                ? 'No offering matches.'
                : offerings.data?.nextCursor
                  ? 'More offerings exist than are listed; choose an offering kind to narrow the list.'
                  : undefined
          }
        />
      </div>
      {offeringId ? (
        <OfferingGroups key={offeringId} offeringId={offeringId} />
      ) : (
        <p className="caption">Choose an offering to see its groups.</p>
      )}
    </section>
  );
}
