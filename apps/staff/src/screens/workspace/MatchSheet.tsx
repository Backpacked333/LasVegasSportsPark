/**
 * SCR-W-03 player list for the assigned official (SPK-UX-007, SPK-STAFF-002, SPK-STAFF-005,
 * §4.14; CMP-06 `GET /v1/fixtures/{id}/match-sheet`).
 *
 * The match sheet is field-limited: names, jersey numbers, playing status and team roles from the
 * effective roster at kickoff, never dates of birth, contacts, eligibility reasons, suspension
 * details or guardian data. The API serves it to an accepted official, league staff and captains
 * (a captain's view has names and numbers only); anyone else, including an official who has not
 * accepted, sees it as not available. Nothing from it is logged or put in a route.
 *
 * Player check-in (fixture attendance, SPK-UX-007, SPK-STAFF-005): when the sheet says the viewer
 * may record it (`canRecordAttendance`: league staff or the accepted official, while the fixture
 * is scheduled), each player row has "Here" and "Absent" toggle buttons (`aria-pressed`, glyph
 * plus text); pressing the current state again clears it. Each press is
 * `POST /v1/fixtures/{id}/attendance` with its own idempotency key; the sheet is read again
 * afterwards, so the marks shown are always the API's. RSVP is not attendance (SPK-CAP-003).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/operations/feedback';
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

type MarkState = 'present' | 'absent' | 'cleared';

/** Here / Absent toggles for one player (keyboard buttons, never colour alone). */
function CheckIn({
  player,
  label,
  busy,
  onMark,
}: {
  player: Player;
  label: string;
  busy: boolean;
  onMark: (state: MarkState) => void;
}) {
  const toggle = (state: 'present' | 'absent') =>
    onMark(player.attendance === state ? 'cleared' : state);
  return (
    <span className="ws-checkin" role="group" aria-label={`Check-in: ${label}`}>
      <button
        type="button"
        className="ws-checkin-btn"
        data-state="present"
        aria-pressed={player.attendance === 'present'}
        disabled={busy}
        onClick={() => toggle('present')}
      >
        <span aria-hidden="true">✓</span> Here
      </button>
      <button
        type="button"
        className="ws-checkin-btn"
        data-state="absent"
        aria-pressed={player.attendance === 'absent'}
        disabled={busy}
        onClick={() => toggle('absent')}
      >
        <span aria-hidden="true">✕</span> Absent
      </button>
    </span>
  );
}

export function MatchSheetPlayers({ fixtureId }: { fixtureId: string }) {
  const sheet = useMatchSheet(fixtureId);
  const mark = useApiCommand('post', '/fixtures/{id}/attendance', {
    invalidate: [
      ['api', '/fixtures/{id}/match-sheet'],
      ['api', '/fixtures/{id}/attendance'],
    ],
  });
  const [pending, setPending] = useState<{
    teamEntryId: string;
    personId: string;
    state: MarkState;
  } | null>(null);
  const send = (body: { teamEntryId: string; personId: string; state: MarkState }) => {
    setPending(body);
    void mark.submit({ path: { id: fixtureId }, body }).catch(() => undefined);
  };
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
                <h5>
                  {side.teamName}
                  <span className="caption">
                    {' '}
                    · {side.presentCount} of {side.players.length} checked in
                  </span>
                </h5>
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
                          {s.canRecordAttendance && p.personId ? (
                            <CheckIn
                              player={p}
                              label={playerLabel(p)}
                              busy={
                                mark.isProcessing &&
                                pending?.personId === p.personId &&
                                pending.teamEntryId === side.entryId
                              }
                              onMark={(state) =>
                                send({
                                  teamEntryId: side.entryId,
                                  personId: p.personId as string,
                                  state,
                                })
                              }
                            />
                          ) : p.attendance ? (
                            <span className="ws-roster-status">
                              {p.attendance === 'present' ? '✓ Here' : '✕ Absent'}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
            {mark.error ? (
              <CommandError
                error={mark.error}
                onRetry={() => (pending ? send(pending) : undefined)}
              />
            ) : null}
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
