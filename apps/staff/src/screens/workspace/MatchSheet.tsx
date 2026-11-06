/**
 * SCR-W-03 player list for the assigned official (SPK-UX-007, SPK-STAFF-002, SPK-STAFF-005,
 * §4.14; CMP-06 `GET /v1/fixtures/{id}/match-sheet`).
 *
 * The match sheet is field-limited: names, jersey numbers, playing status and team roles from the
 * effective roster at kickoff, never dates of birth, contacts, eligibility reasons, suspension
 * details or guardian data. The API serves it to an accepted official, league staff and captains
 * (a captain's view has names and numbers only); anyone else, including an official who has not
 * accepted, sees it as not available. Nothing from it is logged or put in a route.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { humanize } from '../../features/operations/format';
import { QueryBoundary } from '../../ui/QueryBoundary';

export type MatchSheet = Schema<'MatchSheet'>;

export function useMatchSheet(fixtureId: string, enabled = true) {
  return useApiQuery({
    path: '/fixtures/{id}/match-sheet',
    request: { path: { id: fixtureId } },
    enabled,
  });
}

type Player = MatchSheet['sides'][number]['players'][number];

function playerExtras(p: Player): { roles: string[]; status: string[] } {
  const roles = p.roles.filter((r) => r !== 'member').map(humanize);
  const status = p.playingStatus && p.playingStatus !== 'active' ? [humanize(p.playingStatus)] : [];
  return { roles, status };
}

/** "#7 Jo Park (Captain, Guest)": the row's accessible name, in one phrase. */
function playerLabel(p: Player): string {
  const number = p.jerseyNumber !== null ? `#${p.jerseyNumber} ` : '';
  const { roles, status } = playerExtras(p);
  const extra = [...roles, ...status];
  return `${number}${p.displayName}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
}

export function MatchSheetPlayers({ fixtureId }: { fixtureId: string }) {
  const sheet = useMatchSheet(fixtureId);
  return (
    <section className="ops-section ws-sheet" aria-labelledby="match-sheet-title">
      <h4 id="match-sheet-title">Players</h4>
      <QueryBoundary
        query={sheet}
        label="the player list"
        agePrefix="Player list as of"
        isEmpty={(s) => s.sides.every((side) => side.players.length === 0)}
        empty={{
          title: 'No players listed',
          description: 'Neither roster lists a player for this fixture yet.',
        }}
      >
        {(s) => (
          <>
            {s.sides.map((side) => (
              <div key={side.entryId} className="ws-sheet-side">
                <h5>{side.teamName}</h5>
                {side.players.length === 0 ? (
                  <p className="caption">No player listed.</p>
                ) : (
                  <ul className="ws-roster" aria-label={`Players: ${side.teamName}`}>
                    {side.players.map((p, index) => {
                      const { roles, status } = playerExtras(p);
                      return (
                        <li
                          key={p.personId ?? `${side.entryId}-${index}`}
                          aria-label={playerLabel(p)}
                          data-status={status.length > 0 ? 'flagged' : undefined}
                        >
                          <span className="ws-jersey" aria-hidden="true">
                            {p.jerseyNumber ?? '–'}
                          </span>
                          <span className="ws-roster-name" aria-hidden="true">
                            {p.displayName}
                            {roles.length > 0 ? (
                              <span className="caption"> {roles.join(', ')}</span>
                            ) : null}
                          </span>
                          {status.length > 0 ? (
                            <span className="ws-roster-status" aria-hidden="true">
                              ▲ {status.join(', ')}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
            <p className="caption">
              From the effective rosters; names and numbers only. Eligibility and suspension details
              stay with the league manager.
            </p>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
