/**
 * SCR-C-28 Standings and results, a tournament pool's table (CMP-15; SPK-RESULT-001,
 * SPK-RESULT-003, SPK-COMP-001 bracket progression; §3.16 Tournaments, DEC-016, DEC-078). Reads
 * the pool (`GET /v1/pools/{id}`: its entries and seeds) and its standings
 * (`GET /v1/pools/{id}/standings`): the pool's official results among its entries, ordered by the
 * season rule set, with every tiebreak explained and the games still without an official result
 * counted (bracket seeding waits for none). Reading a pool is never gated, so the pool reads are
 * not placed behind CapabilityGate: they keep their own SPK-UX-008 states whatever happens to
 * `GET /v1/me/permissions`. Only once that read answers that tournaments are turned off does the
 * screen say so, above what was already published (TournamentsOffNotice); while it loads, fails or
 * is offline nothing is said about the switch.
 *
 * The API does not yet name the pool a team plays in (no pool list for a division or an entry,
 * reported), so this screen opens from a route that carries the pool's id only (§4.14).
 *
 * States: loading; empty (no official results among the pool's teams yet); ready; permission
 * restriction (NOT_FOUND: not available); stale version (the table is recalculated: "Calculated
 * <time>", refetch on focus); offline (cached with age); turned off (notice, the table kept);
 * processing, success, partial completion and recovery: not applicable (read only).
 */
import { CAPABILITY_PRESENTATION, type Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, plural } from '../../features/teams/format';
import type { Workspace } from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import { TeamFrame } from '../../features/teams/TeamFrame';
import { Body, Section, Title } from '../../features/teams/ui';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { StandingsTable, TiebreakList } from './StandingsScreen';

type Pool = Schema<'Pool'>;
type PoolStandings = Schema<'PoolStandings'>;

/** Whether the table is final for seeding: every game between the pool's teams is official. */
export function poolProgressText(standings: PoolStandings): string {
  const pending = standings.pendingFixtureIds.length;
  return pending === 0
    ? 'Every game between the pool teams has an official result.'
    : `${plural(pending, 'game')} between the pool teams ${pending === 1 ? 'has' : 'have'} no official result yet, so the table can still change.`;
}

function PoolEntries({ pool, entryId }: { pool: Pool; entryId: string }) {
  return (
    <Section title="Teams in the pool">
      <View accessibilityRole="list">
        {pool.entries.map((e) => (
          <ListRow
            key={e.teamEntryId}
            title={e.teamEntryId === entryId ? `${e.teamName} (your team)` : e.teamName}
            detail={e.seed !== null ? `Seed ${e.seed}` : 'Not seeded'}
          />
        ))}
      </View>
    </Section>
  );
}

function PoolTable({ poolId, entryId }: { poolId: string; entryId: string }) {
  const standings = useApiQuery({
    path: '/pools/{id}/standings',
    request: { path: { id: poolId } },
  });
  const names = new Map<string, string>(
    (standings.data?.rows ?? []).map((r) => [r.teamEntryId, r.teamName]),
  );
  return (
    <>
      <Section title="Pool standings">
        <QueryBoundary
          query={standings}
          label="the pool standings"
          isEmpty={(s) => s.rows.length === 0 || s.sourceResultIds.length === 0}
          empty={{
            title: 'No official results yet',
            description:
              'The pool table appears once the league publishes official results between its teams. Provisional results are never counted.',
          }}
        >
          {(s) => (
            <View style={styles.group}>
              <StandingsTable standings={s} entryId={entryId} />
              <StatusBadge
                tone={s.pendingFixtureIds.length === 0 ? 'success' : 'pending'}
                label={
                  s.pendingFixtureIds.length === 0 ? 'Pool complete' : 'Pool games still to play'
                }
              />
              <Body>{poolProgressText(s)}</Body>
              <Body muted>
                {`Calculated ${formatInstant(s.computedAt)} from ${plural(s.sourceResultIds.length, 'official result')} with rule set version ${s.ruleSetVersion}. Provisional results are never counted.`}
              </Body>
            </View>
          )}
        </QueryBoundary>
      </Section>
      {standings.data ? (
        <TiebreakList explanations={standings.data.tiebreakExplanations} names={names} />
      ) : null}
    </>
  );
}

/**
 * The turned-off notice only (DEC-016, DEC-078): shown when `GET /v1/me/permissions` says
 * tournaments are off, and nothing otherwise (on, loading, failed or offline), so an unrelated read
 * never hides published pool tables.
 */
export function TournamentsOffNotice() {
  const tournaments = usePermissions().isCapabilityEnabled('tournaments');
  if (tournaments !== false) return null;
  const presentation = CAPABILITY_PRESENTATION.tournaments;
  return (
    <StateView
      variant="turned-off"
      subject={presentation.label}
      decisions={presentation.decisions}
      owner={presentation.owner}
      stillAvailable="Pool tables already published stay readable here."
    />
  );
}

function PoolContent({ workspace, poolId }: { workspace: Workspace; poolId: string }) {
  const pool = useApiQuery({ path: '/pools/{id}', request: { path: { id: poolId } } });
  const entryId = workspace.entry.id;
  return (
    <View>
      <TournamentsOffNotice />
      <QueryBoundary
        query={pool}
        label="the tournament pool"
        empty={{ title: 'No pool', description: 'This pool has nothing to show.' }}
      >
        {(p) => (
          <View>
            <Title>{`${p.name}: ${workspace.season.name}`}</Title>
            <PoolEntries pool={p} entryId={entryId} />
            <PoolTable poolId={poolId} entryId={entryId} />
          </View>
        )}
      </QueryBoundary>
    </View>
  );
}

export function PoolStandingsScreen({
  entryId,
  poolId,
}: {
  entryId: string | null;
  poolId: string | null;
}) {
  return (
    <TeamFrame entryId={poolId ? entryId : null} what="the pool standings">
      {(ws) => (poolId ? <PoolContent workspace={ws} poolId={poolId} /> : null)}
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/pools/[poolId].tsx. */
export function PoolStandingsRoute() {
  const params = useLocalSearchParams<{ entryId: string; poolId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Pool standings' }} />
      <PoolStandingsScreen entryId={idParam(params.entryId)} poolId={idParam(params.poolId)} />
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
