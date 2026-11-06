/**
 * Recent form of each team ("last 5") derived only from official results (SPK-RESULT-001): the
 * season's official result revisions (`GET /v1/seasons/{id}/result-revisions?status=official`)
 * joined to the season's fixtures (`GET /v1/seasons/{id}/fixtures`) for the two sides and the
 * date. A forfeit counts against the forfeiting side; otherwise the score decides (equal scores
 * are a draw, whatever a shootout decided, because the standings count a shootout under the rule
 * set and the form only shows the match result). Nothing is shown for a team when the reads do
 * not answer, and `partial` says when a read was cut at its page limit.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';

type Revision = Schema<'ResultRevision'>;
type SeasonFixture = Schema<'SeasonFixture'>;

export type FormOutcome = 'W' | 'D' | 'L';

/** The API's page limit (`PageRequestSchema`, at most 200). */
const READ_LIMIT = 200;
export const FORM_LENGTH = 5;

export const OUTCOME_WORD: Record<FormOutcome, string> = { W: 'won', D: 'drew', L: 'lost' };

export interface SeasonForm {
  /** Oldest first, at most FORM_LENGTH; undefined while unknown. */
  of(teamEntryId: string): readonly FormOutcome[] | undefined;
  ready: boolean;
  partial: boolean;
}

function outcomeFor(
  entryId: string,
  revision: Revision,
  fixture: SeasonFixture,
): FormOutcome | null {
  if (revision.forfeitingEntryId) return revision.forfeitingEntryId === entryId ? 'L' : 'W';
  if (revision.homeScore === null || revision.awayScore === null) return null;
  const mine = entryId === fixture.homeEntryId ? revision.homeScore : revision.awayScore;
  const theirs = entryId === fixture.homeEntryId ? revision.awayScore : revision.homeScore;
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
}

/** Pure part, tested on its own. */
export function deriveForm(
  revisions: readonly Revision[],
  fixtures: readonly SeasonFixture[],
): Map<string, FormOutcome[]> {
  const byFixture = new Map(fixtures.map((f) => [f.id, f]));
  const played = revisions
    .filter((r) => r.status === 'official')
    .map((r) => ({ r, f: byFixture.get(r.fixtureId) }))
    .filter((x): x is { r: Revision; f: SeasonFixture } => !!x.f && x.f.awayEntryId !== null)
    .sort((a, b) =>
      (a.f.scheduledStart ?? a.r.publishedAt ?? a.r.createdAt).localeCompare(
        b.f.scheduledStart ?? b.r.publishedAt ?? b.r.createdAt,
      ),
    );
  const form = new Map<string, FormOutcome[]>();
  for (const { r, f } of played) {
    for (const entryId of [f.homeEntryId, f.awayEntryId as string]) {
      const outcome = outcomeFor(entryId, r, f);
      if (!outcome) continue;
      form.set(entryId, [...(form.get(entryId) ?? []), outcome].slice(-FORM_LENGTH));
    }
  }
  return form;
}

export function useSeasonForm(seasonId: string, divisionId?: string): SeasonForm {
  const revisions = useApiQuery({
    path: '/seasons/{id}/result-revisions',
    request: { path: { id: seasonId }, query: { status: 'official', limit: READ_LIMIT } },
    enabled: !!seasonId,
    staleTime: 60_000,
  });
  const fixtures = useApiQuery({
    path: '/seasons/{id}/fixtures',
    request: {
      path: { id: seasonId },
      query: { limit: READ_LIMIT, ...(divisionId ? { divisionId } : {}) },
    },
    enabled: !!seasonId,
    staleTime: 60_000,
  });
  const revisionItems = revisions.data?.items;
  const fixtureItems = fixtures.data?.items;
  const form = useMemo(
    () => (revisionItems && fixtureItems ? deriveForm(revisionItems, fixtureItems) : null),
    [revisionItems, fixtureItems],
  );
  return {
    of: (id) => (form ? (form.get(id) ?? []) : undefined),
    ready: form !== null,
    partial: !!revisions.data?.nextCursor || !!fixtures.data?.nextCursor,
  };
}
