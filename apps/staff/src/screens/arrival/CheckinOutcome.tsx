/**
 * A session check-in as the API evaluated it (SPK-ENTRY-004), as the desk's one big answer: a band
 * that reads "Cleared" (admitted) or "Not cleared" (held), glyph and word, never colour alone
 * (SPK-UX-009), then "Checked in to <session>" or held with each actionable issue (severity as
 * text, message, next action) and "Check again" for a held one. Shared by the pass scan selection
 * and the person lookup of SCR-S-28.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { formatClock, humanize } from '../../features/operations/format';
import { CHECKIN_STATUS, ISSUE_SEVERITY } from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { WaiverActions } from './WaiverActions';

type SessionCheckin = Schema<'SessionCheckin'>;

const VERDICT: Record<SessionCheckin['status'], { glyph: string; word: string }> = {
  admitted: { glyph: '✓', word: 'Cleared' },
  held: { glyph: '✕', word: 'Not cleared' },
  withdrawn: { glyph: '●', word: 'Withdrawn' },
};

export function CheckinOutcome({
  checkin,
  title,
  timezone,
  onRecheck,
  busy,
}: {
  checkin: SessionCheckin;
  title: string;
  /** The facility zone the evaluation time is shown in (SPK-SCHED-008). */
  timezone?: string | null;
  onRecheck?: () => void;
  busy?: boolean;
}) {
  const badge = CHECKIN_STATUS[checkin.status];
  const issues = useMemo(() => checkin.issues, [checkin.issues]);
  const verdict = VERDICT[checkin.status];
  return (
    <div className="verdict" data-verdict={checkin.status} data-testid="checkin-outcome">
      <div className="verdict-band">
        <span className="verdict-word">
          <span aria-hidden="true">{verdict.glyph} </span>
          {verdict.word}
        </span>
        <span className="verdict-meta">Evaluated {formatClock(checkin.evaluatedAt, timezone)}</span>
      </div>
      <div className="verdict-body">
        <StatusBadge
          tone={badge.tone}
          label={
            checkin.status === 'admitted' ? `Checked in to ${title}` : `${badge.label}: ${title}`
          }
        />
        {issues.length > 0 ? (
          <ul className="verdict-issues" aria-label={`Arrival checks for ${title}`}>
            {issues.map((issue) => {
              const severity = ISSUE_SEVERITY[issue.severity];
              return (
                <li
                  key={`${issue.code}-${issue.reference?.id ?? ''}`}
                  data-severity={issue.severity}
                >
                  <StatusBadge tone={severity.tone} label={severity.label} />
                  <span className="verdict-issue-text">
                    {issue.message}{' '}
                    <span className="caption">Next: {humanize(issue.nextAction)}.</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <WaiverActions checkin={checkin} onRecheck={onRecheck} />
        {checkin.status === 'held' && onRecheck ? (
          <div className="ops-actions">
            <Button variant="secondary" busy={busy} onClick={onRecheck}>
              Check again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
