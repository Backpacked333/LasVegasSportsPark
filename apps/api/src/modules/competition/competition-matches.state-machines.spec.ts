import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StateMachine } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  AppealMachine,
  DecisionMachine,
  DisputeMachine,
  IncidentMachine,
  ResultMachine,
  SuspensionMachine,
} from './competition-matches.state-machines';

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../../../../packages/db/migrations/0450_competition_matches.sql'),
  'utf8',
);

/** The states the `status` check constraint of a table lists in migration 0450. */
function checkedStates(table: string): string[] {
  const body = MIGRATION.slice(MIGRATION.indexOf(`create table ${table} (`));
  const match = /\bstatus text not null default '[a-z_]+' check \(status in \(([^)]*)\)\)/.exec(
    body,
  );
  if (!match) throw new Error(`no status check on ${table}`);
  return (match[1] as string)
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .sort();
}

const sorted = <S extends string, E extends string>(machine: StateMachine<S, E>) =>
  [...machine.states].sort();

/** §4.6: every command names its allowed source state; terminal states never move again. */
describe('competition part 2 state machines (§4.6)', () => {
  it('the database check constraints list exactly the machine states', () => {
    expect(checkedStates('result_revisions')).toEqual(sorted(ResultMachine));
    expect(checkedStates('suspensions')).toEqual(sorted(SuspensionMachine));
    expect(checkedStates('disputes')).toEqual(sorted(DisputeMachine));
    expect(checkedStates('appeals')).toEqual(sorted(AppealMachine));
    expect(checkedStates('incidents')).toEqual(sorted(IncidentMachine));
    expect(checkedStates('disciplinary_decisions')).toEqual(sorted(DecisionMachine));
  });

  it('Result (SPK-RESULT-001): draft → submitted → official → superseded; returned for correction from submitted only', () => {
    expect(ResultMachine.next('draft', 'submit')).toBe('submitted');
    expect(ResultMachine.next('submitted', 'return_for_correction')).toBe('draft');
    expect(ResultMachine.next('submitted', 'publish')).toBe('official');
    expect(ResultMachine.next('official', 'supersede')).toBe('superseded');
    expect(ResultMachine.can('draft', 'publish')).toBe(false);
    expect(ResultMachine.can('official', 'return_for_correction')).toBe(false);
    expect(ResultMachine.eventsFrom('superseded')).toEqual([]);
    expect(() => ResultMachine.next('superseded', 'publish')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('Suspension (SPK-DISC-002): proposed → active → served; overturned from proposed or active', () => {
    expect(SuspensionMachine.next('proposed', 'approve')).toBe('active');
    expect(SuspensionMachine.next('active', 'complete')).toBe('served');
    expect(SuspensionMachine.next('proposed', 'overturn')).toBe('overturned');
    expect(SuspensionMachine.next('active', 'overturn')).toBe('overturned');
    expect(SuspensionMachine.can('proposed', 'complete')).toBe(false);
    for (const terminal of ['served', 'overturned'] as const) {
      expect(SuspensionMachine.isTerminal(terminal)).toBe(true);
      expect(SuspensionMachine.eventsFrom(terminal)).toEqual([]);
    }
  });

  it('Dispute (SPK-RESULT-005) and Appeal: reviewed, decided or withdrawn exactly once', () => {
    expect(DisputeMachine.next('submitted', 'review')).toBe('under_review');
    expect(DisputeMachine.next('under_review', 'decide')).toBe('decided');
    expect(DisputeMachine.next('submitted', 'withdraw')).toBe('withdrawn');
    expect(DisputeMachine.can('under_review', 'review')).toBe(false);
    expect(DisputeMachine.eventsFrom('decided')).toEqual([]);
    expect(AppealMachine.next('submitted', 'review')).toBe('under_review');
    expect(AppealMachine.next('under_review', 'grant')).toBe('granted');
    expect(AppealMachine.next('under_review', 'deny')).toBe('denied');
    expect(AppealMachine.next('submitted', 'withdraw')).toBe('withdrawn');
    for (const terminal of ['granted', 'denied', 'withdrawn'] as const) {
      expect(AppealMachine.eventsFrom(terminal)).toEqual([]);
    }
  });

  it('Incident (SPK-DISC-001) and DisciplinaryDecision (SPK-DISC-003)', () => {
    expect(IncidentMachine.next('open', 'review')).toBe('under_review');
    expect(IncidentMachine.next('under_review', 'close')).toBe('closed');
    expect(IncidentMachine.next('open', 'close')).toBe('closed');
    expect(IncidentMachine.can('closed', 'review')).toBe(false);
    expect(DecisionMachine.next('issued', 'overturn')).toBe('overturned');
    expect(DecisionMachine.eventsFrom('overturned')).toEqual([]);
  });
});
