/**
 * SCR-S-13 Standings and brackets, tournament pools (CMP-15; §3.16 Package G Tournaments: pools,
 * seeding, brackets; SPK-COMP-001, SPK-RESULT-003; DEC-016, DEC-078). A pool splits a division's
 * entries; its standings are computed from the official results among its entries with the rule
 * set's tiebreakers, and seed bracket nodes once final.
 *
 * Creating a pool and placing an entry are new commitments of the organization's `tournaments`
 * capability: while it is off they are not offered and the API answers ACCESS_DENIED
 * `CAPABILITY_DISABLED`, shown as "Tournaments turned off". Existing pools stay readable, an
 * entry can always be removed (with a reason) and a final pool table can still seed a bracket:
 * none of these are gated. Pool changes carry the pool's `expectedRevision`.
 *
 * The API cannot list the pools of a division, so a pool is opened from its own page (after it
 * is created) or by its reference (Proposed handling of an API gap).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  isRecordReference,
  parseWholeNumber,
} from '../../features/competition/fields';
import { shortRef } from '../../features/competition/format';
import { LeaguesNav, SeasonLinks } from '../../features/competition/nav';
import { useSeasonEntries } from '../../features/competition/names';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { SeedNode } from './SeedFromStandings';
import { StandingsTable } from './StandingsScreen';

type Pool = Schema<'Pool'>;

const POOL_KEYS = keys('/pools/{id}', '/pools/{id}/standings');
const STILL_AVAILABLE =
  'Existing pools stay readable, their entries can be removed and their final standings can still seed a bracket.';

function OpenPool() {
  const navigate = useNavigate();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="form"
      noValidate
      aria-label="Open a pool"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isRecordReference(reference)) {
          setError('Enter the pool reference shown on the pool’s page.');
          return;
        }
        setError(null);
        void navigate(`/leagues/pools/${reference.trim()}`);
      }}
    >
      <TextField
        label="Pool reference"
        value={reference}
        onChange={setReference}
        error={error}
        hint="The pools of a division cannot be listed yet; open a pool by its reference."
      />
      <Button type="submit" variant="secondary">
        Open the pool
      </Button>
    </form>
  );
}

function CreatePool({ divisionId }: { divisionId: string }) {
  const navigate = useNavigate();
  const create = useApiCommand('post', '/divisions/{id}/pools', { invalidate: POOL_KEYS });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!name.trim()) {
      setError('Name the pool.');
      return;
    }
    setError(null);
    void create
      .submit({ path: { id: divisionId }, body: { name: name.trim() } })
      .then((pool) => void navigate(`/leagues/pools/${pool.id}`))
      .catch(() => undefined);
  };
  return (
    <form
      className="form"
      noValidate
      aria-label="Create a pool"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField label="Pool name" required value={name} onChange={setName} error={error} />
      <CommandButton type="submit" busy={create.isProcessing}>
        Create the pool
      </CommandButton>
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

export function DivisionPoolsScreen() {
  const { divisionId = '' } = useParams();
  const permissions = usePermissions();
  const division = useApiQuery({ path: '/divisions/{id}', request: { path: { id: divisionId } } });
  return (
    <section aria-labelledby="division-pools-title">
      <h2 id="division-pools-title">
        Tournament pools{division.data ? `: ${division.data.name}` : ''}
      </h2>
      <LeaguesNav />
      {division.data ? <SeasonLinks seasonId={division.data.seasonId} /> : null}
      <QueryBoundary
        query={division}
        label="the division"
        empty={{ title: '', description: '' }}
        unavailableOffline={['creating pools']}
      >
        {(data) => (
          <CapabilityGate
            capability="tournaments"
            subject="Tournament pools"
            whenOff="notice"
            stillAvailable={STILL_AVAILABLE}
          >
            {permissions.isCapabilityEnabled('tournaments') === true ? (
              <section className="panel" aria-labelledby="create-pool-title">
                <h3 id="create-pool-title">New pool</h3>
                <CreatePool divisionId={data.id} />
              </section>
            ) : null}
            <section className="panel" aria-labelledby="open-pool-title">
              <h3 id="open-pool-title">Open a pool</h3>
              <OpenPool />
            </section>
          </CapabilityGate>
        )}
      </QueryBoundary>
    </section>
  );
}

function AddEntry({ pool }: { pool: Pool }) {
  const add = useApiCommand('post', '/pools/{id}/entries', { invalidate: POOL_KEYS });
  const reload = useRefetch(['/pools/{id}']);
  const { query: entries } = useSeasonEntries(pool.seasonId);
  const [teamEntryId, setTeamEntryId] = useState('');
  const [seed, setSeed] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inPool = new Set(pool.entries.map((e) => e.teamEntryId));
  const options = (entries.data ?? [])
    .filter(
      (e) =>
        e.divisionId === pool.divisionId &&
        (e.status === 'applied' || e.status === 'approved') &&
        !inPool.has(e.id),
    )
    .map((e) => ({ value: e.id, label: e.teamName }));
  const submit = () => {
    const next: Record<string, string> = {};
    if (!teamEntryId) next.teamEntryId = 'Choose the team entry.';
    const seedValue = seed.trim() ? parseWholeNumber(seed) : null;
    if (seed.trim() && (seedValue === null || seedValue < 1 || seedValue > 64))
      next.seed = 'Enter a seed from 1 to 64, or leave empty.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void add
      .submit({
        path: { id: pool.id },
        body: {
          teamEntryId,
          expectedRevision: pool.revision,
          ...(seedValue !== null ? { seed: seedValue } : {}),
        },
      })
      .then(() => {
        setTeamEntryId('');
        setSeed('');
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="form"
      noValidate
      aria-label="Place an entry in the pool"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SelectField
        label="Team entry"
        required
        value={teamEntryId}
        onChange={setTeamEntryId}
        options={options}
        error={errors.teamEntryId}
        hint={
          entries.error
            ? `The division's entries could not be loaded (${entries.error.code}).`
            : entries.data && options.length === 0
              ? 'Every applied or approved entry of the division is already in a pool.'
              : 'Applied or approved entries of this pool’s division.'
        }
      />
      <NumberField label="Seed" value={seed} onChange={setSeed} error={errors.seed} />
      <CommandButton type="submit" busy={add.isProcessing}>
        Place in the pool
      </CommandButton>
      {add.status === 'success' ? <SuccessNote>Entry placed in the pool</SuccessNote> : null}
      <CommandError
        error={add.error}
        onRetry={submit}
        onReload={() => {
          add.reset();
          reload();
        }}
      />
    </form>
  );
}

/** Unwinding: never gated by the capability (CMP-15). */
function RemoveEntry({ pool, entry }: { pool: Pool; entry: Pool['entries'][number] }) {
  const remove = useApiCommand('post', '/pools/{id}/entries/{teamEntryId}/remove', {
    invalidate: POOL_KEYS,
  });
  const reload = useRefetch(['/pools/{id}']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!reason.trim()) {
      setError('Give the reason for removing the entry.');
      return;
    }
    setError(null);
    void remove
      .submit({
        path: { id: pool.id, teamEntryId: entry.teamEntryId },
        body: { reason: reason.trim(), expectedRevision: pool.revision },
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-label={`Remove ${entry.teamName} from the pool`}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label={`Remove ${entry.teamName}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField label="Reason" required value={reason} onChange={setReason} error={error} />
      <div className="actions">
        <CommandButton type="submit" variant="secondary" busy={remove.isProcessing}>
          Remove from the pool
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it in the pool
        </Button>
      </div>
      <CommandError
        error={remove.error}
        onRetry={submit}
        onReload={() => {
          remove.reset();
          reload();
        }}
      />
    </form>
  );
}

function PoolStandings({ pool }: { pool: Pool }) {
  const standings = useApiQuery({
    path: '/pools/{id}/standings',
    request: { path: { id: pool.id } },
  });
  return (
    <section className="panel" aria-labelledby="pool-standings-title">
      <h3 id="pool-standings-title">Pool standings</h3>
      <p className="caption">
        Only official results between the pool’s entries count, ordered by the rule set’s
        tiebreakers.
      </p>
      <QueryBoundary
        query={standings}
        label="pool standings"
        empty={{ title: '', description: '' }}
      >
        {(data) => {
          const pending = data.pendingFixtureIds.length;
          const pendingNote =
            pending > 0 ? (
              <p role="note">
                <StatusBadge tone="warning" label="Not final" /> {pending}{' '}
                {pending === 1 ? 'fixture' : 'fixtures'} between pool entries
                {pending === 1 ? ' has' : ' have'} no official result yet; seeding a bracket waits
                for them.
              </p>
            ) : null;
          // SCR-S-13 "empty (no official results)": a table of entries on zero points is not a
          // standing, and is never called final (SPK-RESULT-003).
          if (data.sourceResultIds.length === 0) {
            return (
              <>
                <StateView
                  variant="empty"
                  title="No official results yet"
                  description={
                    pending > 0
                      ? 'The table appears once a fixture between pool entries has an official result.'
                      : data.rows.length < 2
                        ? 'The pool needs at least two entries and a fixture between them.'
                        : 'No fixture between pool entries exists yet. The table appears once one has an official result.'
                  }
                />
                {pendingNote}
              </>
            );
          }
          return (
            <>
              {pendingNote ?? (
                <p role="note">
                  <StatusBadge tone="success" label="Final" /> Every fixture between pool entries
                  has an official result.
                </p>
              )}
              <StandingsTable standings={data} caption="Pool standings" />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

function SeedFromPool({ pool }: { pool: Pool }) {
  const nodes = useApiQuery({
    path: '/seasons/{id}/bracket-nodes',
    request: { path: { id: pool.seasonId } },
  });
  const names = new Map(pool.entries.map((e) => [e.teamEntryId, e.teamName]));
  return (
    <section className="panel" aria-labelledby="seed-pool-title">
      <h3 id="seed-pool-title">Seed a bracket from this pool</h3>
      <QueryBoundary
        query={nodes}
        label="bracket nodes"
        isEmpty={(data) =>
          data.filter(
            (n) =>
              !n.published &&
              (n.sourceRule.home.kind === 'seed' || n.sourceRule.away.kind === 'seed'),
          ).length === 0
        }
        empty={{
          title: 'No node to seed',
          description: 'Unpublished bracket nodes with a seeded slot appear here.',
        }}
        unavailableOffline={['seeding bracket nodes']}
      >
        {(data) => (
          <ul className="list" aria-label="Bracket nodes to seed">
            {data
              .filter(
                (n) =>
                  !n.published &&
                  (n.sourceRule.home.kind === 'seed' || n.sourceRule.away.kind === 'seed'),
              )
              .map((node) => (
                <li key={node.id}>
                  <div className="row-text">
                    <span className="row-title">
                      {node.name ?? `Round ${node.round}, slot ${node.slot}`}
                    </span>
                    <span className="caption">
                      {node.homeTeamName ?? 'Home slot empty'} v{' '}
                      {node.awayTeamName ?? 'away slot empty'}
                    </span>
                  </div>
                  <SeedNode
                    node={node}
                    divisions={[]}
                    poolId={pool.id}
                    teamName={(id) => names.get(id) ?? `Entry ${shortRef(id)}`}
                  />
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function PoolScreen() {
  const { poolId = '' } = useParams();
  const permissions = usePermissions();
  const pool = useApiQuery({ path: '/pools/{id}', request: { path: { id: poolId } } });
  const division = useApiQuery({
    path: '/divisions/{id}',
    request: { path: { id: pool.data?.divisionId ?? '' } },
    enabled: !!pool.data,
  });
  return (
    <section aria-labelledby="pool-title">
      <h2 id="pool-title">{pool.data ? `Pool: ${pool.data.name}` : 'Pool'}</h2>
      <LeaguesNav />
      <QueryBoundary
        query={pool}
        label="the pool"
        empty={{ title: '', description: '' }}
        unavailableOffline={['placing and removing entries', 'seeding bracket nodes']}
      >
        {(data) => (
          <>
            <SeasonLinks seasonId={data.seasonId} />
            <p>
              <Link to={`/leagues/divisions/${data.divisionId}/pools`}>
                Pools of {division.data?.name ?? 'the division'}
              </Link>
              <span className="caption"> · Pool reference {data.id}</span>
            </p>
            <CapabilityGate
              capability="tournaments"
              subject="Tournament pools"
              whenOff="notice"
              stillAvailable={STILL_AVAILABLE}
            >
              <section className="panel" aria-labelledby="pool-entries-title">
                <h3 id="pool-entries-title">Entries</h3>
                {data.entries.length === 0 ? (
                  <p>No entry is in this pool yet.</p>
                ) : (
                  <ul className="list" aria-label="Pool entries">
                    {data.entries.map((entry) => (
                      <li key={entry.teamEntryId}>
                        <div className="row-text">
                          <span className="row-title">{entry.teamName}</span>
                          <span className="caption">
                            {entry.seed !== null ? `Seed ${entry.seed}` : 'No seed'}
                          </span>
                        </div>
                        <RemoveEntry pool={data} entry={entry} />
                      </li>
                    ))}
                  </ul>
                )}
                {permissions.isCapabilityEnabled('tournaments') === true ? (
                  <AddEntry pool={data} />
                ) : null}
              </section>
            </CapabilityGate>
            <PoolStandings pool={data} />
            <SeedFromPool pool={data} />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
