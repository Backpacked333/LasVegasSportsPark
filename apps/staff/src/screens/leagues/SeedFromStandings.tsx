/**
 * SCR-S-13 seeding a bracket node from final standings (`POST /v1/bracket-nodes/{id}/seed-from-
 * standings`, CMP-10, CMP-15; SPK-COMP-001 bracket progression, SPK-RESULT-003). Only a slot whose
 * source is a seed takes an entry from a table, and only an unpublished node is seeded. The staff
 * member names the table (a division's standings or a tournament pool's) and the rank for each
 * slot; nothing is preselected. The API refuses tables that are not final (fixtures without an
 * official result) and ranks that are an unresolved tie, naming the tied entries: both are shown
 * as such, never as a changed record. The command carries `expectedRevision` and one idempotency
 * key per intent. Seeding from an existing pool is never gated by the tournaments capability.
 */
import { type ApiError, type Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  NumberField,
  SelectField,
  TextField,
  isRecordReference,
  parseWholeNumber,
  type Option,
} from '../../features/competition/fields';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type BracketNode = Schema<'BracketNode'>;
type Slot = 'home' | 'away';

const SEED_KEYS = keys('/seasons/{id}/bracket-nodes');

/** STANDINGS_NOT_FINAL and UNRESOLVED_TIE are refusals about the table, not a stale record. */
function SeedRefusal({
  error,
  teamName,
}: {
  error: ApiError;
  teamName: (teamEntryId: string) => string;
}) {
  const details = (error.details ?? {}) as {
    code?: unknown;
    pendingFixtureIds?: unknown;
    tiedEntryIds?: unknown;
    rank?: unknown;
  };
  if (error.code !== 'INVALID_TRANSITION') return null;
  if (details.code === 'STANDINGS_NOT_FINAL') {
    const pending = Array.isArray(details.pendingFixtureIds) ? details.pendingFixtureIds.length : 0;
    return (
      <section className="state" aria-live="polite" data-testid="seed-not-final">
        <StatusBadge tone="warning" label="Standings not final" />
        <p>
          {pending > 0
            ? `${pending} ${pending === 1 ? 'fixture has' : 'fixtures have'} no official result yet. Seed the node once every result of the table is official.`
            : error.message}
        </p>
        <p className="caption">Error code: {error.code} (STANDINGS_NOT_FINAL)</p>
      </section>
    );
  }
  if (details.code === 'UNRESOLVED_TIE') {
    const tied = Array.isArray(details.tiedEntryIds)
      ? details.tiedEntryIds.filter((id): id is string => typeof id === 'string')
      : [];
    return (
      <section className="state" aria-live="polite" data-testid="seed-unresolved-tie">
        <StatusBadge tone="warning" label="Unresolved tie" />
        <p>
          {typeof details.rank === 'number' ? `Rank ${details.rank} ` : 'This rank '}
          is an unresolved tie; the league decides it before seeding.
        </p>
        {tied.length > 0 ? (
          <ul aria-label="Tied entries">
            {tied.map((id) => (
              <li key={id}>{teamName(id)}</li>
            ))}
          </ul>
        ) : null}
        <p className="caption">Error code: {error.code} (UNRESOLVED_TIE)</p>
      </section>
    );
  }
  return null;
}

export function SeedFromStandings({
  node,
  divisions,
  poolId,
  teamName,
}: {
  node: BracketNode;
  /** The season's divisions, to seed from a division's standings. */
  divisions: readonly Option[];
  /** Seed from this pool's standings (the pool screen); otherwise a division or a pool reference. */
  poolId?: string;
  teamName: (teamEntryId: string) => string;
}) {
  const seed = useApiCommand('post', '/bracket-nodes/{id}/seed-from-standings', {
    invalidate: SEED_KEYS,
  });
  const reload = useRefetch(['/seasons/{id}/bracket-nodes']);
  const slots = (['home', 'away'] as const).filter((slot) => node.sourceRule[slot].kind === 'seed');
  const [source, setSource] = useState<'' | 'division' | 'pool'>(poolId ? 'pool' : '');
  const [divisionId, setDivisionId] = useState('');
  const [poolRef, setPoolRef] = useState(poolId ?? '');
  const [ranks, setRanks] = useState<Record<Slot, string>>({ home: '', away: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (slots.length === 0) return null;

  const submit = () => {
    const next: Record<string, string> = {};
    if (!source) next.source = 'Choose the standings to seed from.';
    if (source === 'division' && !divisionId) next.divisionId = 'Choose the division.';
    if (source === 'pool' && !isRecordReference(poolRef))
      next.poolRef = 'Enter the pool reference shown on the pool’s page.';
    const chosen: { slot: Slot; rank: number }[] = [];
    for (const slot of slots) {
      const text = ranks[slot].trim();
      if (!text) continue;
      const rank = parseWholeNumber(text);
      if (rank === null || rank < 1 || rank > 64) next[slot] = 'Enter a rank from 1 to 64.';
      else chosen.push({ slot, rank });
    }
    if (chosen.length === 0 && !next.home && !next.away)
      next.ranks = 'Give the rank for at least one seeded slot.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const table = source === 'division' ? { divisionId } : { poolId: poolRef.trim() };
    void seed
      .submit({
        path: { id: node.id },
        body: {
          expectedRevision: node.revision,
          sources: chosen.map((c) => ({ ...table, rank: c.rank, slot: c.slot })),
        },
      })
      .catch(() => undefined);
  };

  const label = node.name ?? `round ${node.round}, slot ${node.slot}`;
  const tableRefusal = seed.error ? <SeedRefusal error={seed.error} teamName={teamName} /> : null;
  const isTableRefusal =
    seed.error?.code === 'INVALID_TRANSITION' &&
    ['STANDINGS_NOT_FINAL', 'UNRESOLVED_TIE'].includes(
      String((seed.error.details as { code?: unknown } | undefined)?.code),
    );
  return (
    <form
      className="form"
      noValidate
      aria-label={`Seed ${label} from standings`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {poolId ? (
        <p className="caption">From this pool’s standings.</p>
      ) : (
        <SelectField
          label="Standings to seed from"
          required
          value={source}
          onChange={(v) => setSource(v as '' | 'division' | 'pool')}
          options={[
            { value: 'division', label: 'A division’s standings' },
            { value: 'pool', label: 'A tournament pool’s standings' },
          ]}
          error={errors.source}
        />
      )}
      {source === 'division' && !poolId ? (
        <SelectField
          label="Division"
          required
          value={divisionId}
          onChange={setDivisionId}
          options={divisions}
          error={errors.divisionId}
        />
      ) : null}
      {source === 'pool' && !poolId ? (
        <TextField
          label="Pool reference"
          required
          value={poolRef}
          onChange={setPoolRef}
          error={errors.poolRef}
          hint="Pools of a division cannot be listed yet; the reference is on the pool’s page."
        />
      ) : null}
      <div className="field-grid">
        {slots.map((slot) => {
          const rule = node.sourceRule[slot];
          return (
            <NumberField
              key={slot}
              label={`Rank for the ${slot} slot (${rule.kind === 'seed' ? `seed ${rule.seed}` : slot})`}
              value={ranks[slot]}
              onChange={(v) => setRanks((r) => ({ ...r, [slot]: v }))}
              error={errors[slot]}
              hint="Leave empty to keep this slot as it is."
            />
          );
        })}
      </div>
      {errors.ranks ? (
        <p className="error-text" role="alert">
          {errors.ranks}
        </p>
      ) : null}
      <div className="actions">
        <CommandButton type="submit" busy={seed.isProcessing}>
          Seed from standings
        </CommandButton>
      </div>
      {seed.status === 'success' && seed.data ? (
        <SuccessNote>
          {`Seeded: ${seed.data.homeTeamName ?? 'home slot empty'} v ${
            seed.data.awayTeamName ?? 'away slot empty'
          }`}
        </SuccessNote>
      ) : null}
      {tableRefusal}
      {isTableRefusal ? null : (
        <CommandError
          error={seed.error}
          onRetry={submit}
          onReload={() => {
            seed.reset();
            reload();
          }}
        />
      )}
    </form>
  );
}

/** The toggle that opens the seeding form for one unpublished node. */
export function SeedNode(props: Parameters<typeof SeedFromStandings>[0]) {
  const [open, setOpen] = useState(false);
  const seeded = (['home', 'away'] as const).some(
    (slot) => props.node.sourceRule[slot].kind === 'seed',
  );
  if (!seeded || props.node.published) return null;
  const label = props.node.name ?? `round ${props.node.round}, slot ${props.node.slot}`;
  return (
    <div>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`Seed ${label} from standings`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Close seeding' : 'Seed from standings'}
      </Button>
      {open ? <SeedFromStandings {...props} /> : null}
    </div>
  );
}
