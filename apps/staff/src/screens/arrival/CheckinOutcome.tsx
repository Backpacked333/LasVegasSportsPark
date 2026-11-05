/**
 * A session check-in as the API evaluated it (SPK-ENTRY-004): "Checked in to <session>" or held,
 * with each actionable issue (severity as text, message, next action) and "Check again" for a
 * held one. Shared by the pass scan selection and the person lookup of SCR-S-28.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { humanize } from '../../features/operations/format';
import { CHECKIN_STATUS, ISSUE_SEVERITY } from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type SessionCheckin = Schema<'SessionCheckin'>;

export function CheckinOutcome({
  checkin,
  title,
  onRecheck,
  busy,
}: {
  checkin: SessionCheckin;
  title: string;
  onRecheck?: () => void;
  busy?: boolean;
}) {
  const badge = CHECKIN_STATUS[checkin.status];
  const issues = useMemo(() => checkin.issues, [checkin.issues]);
  return (
    <div className="ops-section" data-testid="checkin-outcome">
      <StatusBadge
        tone={badge.tone}
        label={
          checkin.status === 'admitted' ? `Checked in to ${title}` : `${badge.label}: ${title}`
        }
      />
      {issues.length > 0 ? (
        <ul className="ops-history" aria-label={`Arrival checks for ${title}`}>
          {issues.map((issue) => {
            const severity = ISSUE_SEVERITY[issue.severity];
            return (
              <li key={`${issue.code}-${issue.reference?.id ?? ''}`}>
                <StatusBadge tone={severity.tone} label={severity.label} /> {issue.message}{' '}
                <span className="caption">Next: {humanize(issue.nextAction)}.</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {checkin.status === 'held' && onRecheck ? (
        <div className="ops-actions">
          <Button variant="secondary" busy={busy} onClick={onRecheck}>
            Check again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
