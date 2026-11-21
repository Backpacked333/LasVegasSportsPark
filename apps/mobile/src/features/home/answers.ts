/**
 * "Is Maya going?" (redesign handoff 1b row 3, 1i row 3, 3a; SPK-CAP-003, CMP-04, §4.9): one
 * answer per person per game, shared by Home and Game day, written optimistically with Undo.
 *
 * - `POST /v1/fixtures/{id}/availability` with `personId` (a guardian holding `register` answers
 *   for a child: **Proposed**, DEC-090) and `state` `available` (Going), `tentative` (Maybe:
 *   **Proposed**, DEC-064) or `unavailable` (Not going), from the answer's revision
 *   (`expectedRevision`, CMP-04). One idempotency key per intent (`useApiCommand`).
 * - The new answer shows at once with "Saved: Maya is going. The coach can see it." and Undo for
 *   5 s (`ui/optimistic`); a failure puts the previous answer back and says it did not save, with
 *   Try again. Undo sends the previous answer (or "no answer") as a new intent.
 * - After a save the game reads are refreshed (`/me/fixtures`, `/fixtures/{id}`), so the other
 *   screen shows the same answer.
 * - Answers close at kickoff (the API refuses after it); the control is disabled with "Answers
 *   closed at kickoff". Offline, it is disabled with "Answering needs a connection." (nothing is
 *   queued: RSVP is not attendance).
 */
import type { Schema } from '@sportspark/api-client';
import { useRef, useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useOptimisticWrite } from '../../ui/optimistic';
import type { RsvpState } from '../today/status';

type FixtureDetail = Schema<'FixtureDetail'>;
type AvailabilitySummary = Schema<'AvailabilitySummary'>;

export type Answer = 'available' | 'tentative' | 'unavailable';

export const ANSWER_WORDS: Readonly<Record<Answer, string>> = {
  available: 'Going',
  tentative: 'Maybe',
  unavailable: 'Not going',
};

/** "Maya is going", "you're a maybe". */
export function answerSentence(name: string, self: boolean, state: Answer): string {
  const subject = self ? "You're" : `${name} is`;
  switch (state) {
    case 'available':
      return `${subject} going`;
    case 'tentative':
      return `${subject} a maybe`;
    default:
      return `${subject} not going`;
  }
}

export interface AnswerCounts {
  going: number;
  maybe: number;
  notGoing: number;
  noAnswer: number;
  answered: number;
  total: number;
}

/** The side's counts with one person's answer moved from `from` to `to` (optimistic display). */
export function answerCounts(
  summary: AvailabilitySummary,
  from: RsvpState | null,
  to: RsvpState | null,
): AnswerCounts {
  const counts = {
    available: summary.available,
    tentative: summary.tentative,
    unavailable: summary.unavailable,
    no_response: summary.noResponse,
  };
  if (from !== to) {
    const a = from ?? 'no_response';
    const b = to ?? 'no_response';
    counts[a] = Math.max(0, counts[a] - 1);
    counts[b] += 1;
  }
  const answered = counts.available + counts.tentative + counts.unavailable;
  return {
    going: counts.available,
    maybe: counts.tentative,
    notGoing: counts.unavailable,
    noAnswer: counts.no_response,
    answered,
    total: answered + counts.no_response,
  };
}

/** The side of the fixture a person plays on, from the teams the viewer can see. */
export function sideOf(
  fixture: FixtureDetail,
  teamEntryIds: readonly string[],
): FixtureDetail['home'] | null {
  if (teamEntryIds.includes(fixture.home.entryId)) return fixture.home;
  if (fixture.away && teamEntryIds.includes(fixture.away.entryId)) return fixture.away;
  return null;
}

export function recordedAnswer(
  fixture: FixtureDetail,
  personId: string,
  selfId: string | null,
): { state: RsvpState | null; revision: number | null } {
  const listed = (fixture.responses ?? []).find((r) => r.personId === personId);
  if (listed) return { state: listed.state, revision: listed.revision };
  if (personId === selfId) return { state: fixture.myResponse ?? null, revision: null };
  return { state: null, revision: null };
}

export function useGameAnswer({
  fixture,
  personId,
  personName,
  self,
  selfId,
}: {
  fixture: FixtureDetail;
  personId: string;
  personName: string;
  self: boolean;
  selfId: string | null;
}) {
  const recorded = recordedAnswer(fixture, personId, selfId);
  const [override, setOverride] = useState<{ state: RsvpState | null } | null>(null);
  const revision = useRef<number | null>(recorded.revision);
  if (override === null) revision.current = recorded.revision ?? revision.current;
  const command = useApiCommand('post', '/fixtures/{id}/availability', {
    invalidate: [
      ['api', '/me/fixtures'],
      ['api', '/fixtures/{id}'],
    ],
  });
  const run = useOptimisticWrite();
  const shown = override ? override.state : recorded.state;

  const send = async (state: RsvpState) => {
    const answer = await command.submit({
      path: { id: fixture.id },
      body: {
        personId,
        state,
        ...(revision.current !== null ? { expectedRevision: revision.current } : {}),
      },
    });
    revision.current = answer.revision;
  };

  const answer = (state: Answer) => {
    const previous = shown;
    if (previous === state) return;
    run({
      apply: () => setOverride({ state }),
      revert: () => setOverride({ state: previous }),
      commit: () => send(state),
      undo: () => send(previous ?? 'no_response'),
      success: `Saved: ${answerSentence(personName, self, state)}. The coach can see it.`,
      failure: `${self ? 'Your' : `${personName}'s`} answer didn't save.`,
      undoFailure: `Undo didn't save. ${answerSentence(personName, self, state)}.`,
    });
  };

  return { shown, recorded: recorded.state, answer, busy: command.isProcessing };
}
