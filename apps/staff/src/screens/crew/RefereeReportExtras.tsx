/**
 * The referee match report's Phase 8 additions (staff redesign Phase 8 item 6; SPK-RESULT-001
 * result reporting, SPK-STAFF-005/006, SPK-FAC-002, SPK-DISC-005), used by SCR-W-05
 * (workspace/MatchReportScreen.tsx):
 *
 * - the match check: the score is prefilled from the coach's game log (`GET
 *   /v1/fixtures/{id}/game-logs`, competition migration 0475, readable by an accepted official);
 *   a score that differs from a coach's must be fixed or explained, and the explanation travels
 *   in the report's notes so the league sees why before it publishes;
 * - field and conduct chips: "Field damage" creates a field crew task for the pitch once the
 *   report is submitted (`POST /v1/maintenance-tasks`, facilities.report_issue, every staff role);
 *   "Injury" adds an injury incident to the report (the incident record the injury report, S 4d,
 *   follows up); the conduct chips are written into the notes;
 * - the payout line: the fee is submitted on Hours and fees once the match is completed (rates are
 *   DEC-011, pending; never "Paid").
 */
import type { Schema } from '@sportspark/api-client';
import { useId } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../../features/operations/format';
import { FEE_STATUS } from '../../features/operations/labels';
import { StatusBadge } from '../../ui/StatusBadge';
import './crew.css';

export type FixtureGameLogs = Schema<'FixtureGameLogs'>;

/** The coaches' scores of the fixture (empty when none was kept, or the read is refused). */
export function useCoachScores(fixtureId: string) {
  return useApiQuery({
    path: '/fixtures/{id}/game-logs',
    request: { path: { id: fixtureId } },
    staleTime: 30_000,
  });
}

/** Coaches whose score differs from the referee's (whole numbers only). */
export function mismatchedLogs(
  logs: FixtureGameLogs['logs'],
  homeScore: string,
  awayScore: string,
): FixtureGameLogs['logs'] {
  const h = /^\d{1,3}$/.test(homeScore.trim()) ? Number(homeScore.trim()) : null;
  const a = /^\d{1,3}$/.test(awayScore.trim()) ? Number(awayScore.trim()) : null;
  if (h === null || a === null) return [];
  return logs.filter((l) => l.homeScore !== h || l.awayScore !== a);
}

export function ScoreMatchCheck({
  logs,
  homeScore,
  awayScore,
  explanation,
  onExplain,
  error,
}: {
  logs: FixtureGameLogs['logs'];
  homeScore: string;
  awayScore: string;
  explanation: string;
  onExplain: (text: string) => void;
  error?: string;
}) {
  const id = useId();
  if (logs.length === 0) {
    return (
      <p className="crew-meta" data-testid="match-check">
        No coach kept a score of this game; your report is the only one.
      </p>
    );
  }
  const different = mismatchedLogs(logs, homeScore, awayScore);
  const coaches = logs.map((l) => `${l.teamName} ${l.homeScore}–${l.awayScore}`).join(' · ');
  if (different.length === 0) {
    return (
      <p className="crew-note" data-tone="success" data-testid="match-check">
        ✓ Matches the coach{logs.length > 1 ? 'es' : ''}: {coaches}
      </p>
    );
  }
  return (
    <div className="crew-body" data-testid="match-check">
      <p className="crew-note" data-tone="warning">
        ▲ The coach kept{' '}
        {different.map((l) => `${l.homeScore}–${l.awayScore} (${l.teamName})`).join(', ')}. Fix the
        score, or explain the difference.
      </p>
      <label className="crew-meta" htmlFor={id}>
        Why the scores differ
      </label>
      <textarea
        id={id}
        className="crew-textarea"
        value={explanation}
        maxLength={1000}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onExplain(e.target.value)}
      />
      {error ? (
        <span className="error-text" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const FIELD_CHIPS = ['Field damage', 'Injury'] as const;
export const CONDUCT_CHIPS = ['Good conduct', 'Dissent', 'Spectators', 'Coach behaviour'] as const;
export type ReportChip = (typeof FIELD_CHIPS)[number] | (typeof CONDUCT_CHIPS)[number];

export function ReportChips({
  selected,
  onToggle,
}: {
  selected: ReadonlySet<ReportChip>;
  onToggle: (chip: ReportChip) => void;
}) {
  const row = (title: string, chips: readonly ReportChip[]) => (
    <fieldset className="ops-fieldset">
      <legend>{title}</legend>
      <div className="issue-chips">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            className="issue-chip"
            aria-pressed={selected.has(chip)}
            onClick={() => onToggle(chip)}
          >
            {chip}
          </button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <>
      {row('Field', FIELD_CHIPS)}
      {selected.has('Field damage') ? (
        <p className="crew-meta">The field crew gets a task for this pitch when you submit.</p>
      ) : null}
      {row('Conduct', CONDUCT_CHIPS)}
    </>
  );
}

/** The notes line the conduct chips write ("Conduct: Dissent, Spectators."). */
export function conductNote(selected: ReadonlySet<ReportChip>): string | null {
  const conduct = CONDUCT_CHIPS.filter((c) => selected.has(c));
  return conduct.length > 0 ? `Conduct: ${conduct.join(', ')}.` : null;
}

export function PayoutLine({ fee }: { fee: Schema<'FeeSubmission'> | null }) {
  return (
    <p className="crew-meta" data-testid="payout-line">
      Payout:{' '}
      {fee ? (
        <>
          {formatMoney(fee.approvedAmountMinor ?? fee.submittedAmountMinor, fee.currency)}{' '}
          <StatusBadge
            tone={FEE_STATUS[fee.status].tone}
            label={FEE_STATUS[fee.status].label}
            size="sm"
          />
        </>
      ) : (
        <>
          submit your fee on <Link to="/workspace/fees">Hours and fees</Link> once the match is
          completed (rates are set by the facility).
        </>
      )}
    </p>
  );
}
