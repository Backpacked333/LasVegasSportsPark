/**
 * An eligibility result as the API evaluated it (SPK-REG-002): the outcome, the policy version and
 * reference date it used, each reason with its severity (glyph and text, SPK-UX-009), source and
 * required action, the permitted alternatives, and any staff override with its reason and actor.
 */
import type { Schema } from '@sportspark/api-client';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDate, formatInstant, humanize, shortRef } from './format';
import { severityBadge } from './labels';

export function EligibilityView({
  result,
  override,
  label,
}: {
  result: Schema<'EligibilityResult'> | null;
  override?: Schema<'EligibilityOverride'> | null;
  label: string;
}) {
  if (!result) {
    return (
      <p className="caption">
        <StatusBadge tone="pending" label="Eligibility not evaluated" />
      </p>
    );
  }
  return (
    <div className="row-text" aria-label={label} role="group">
      <span>
        <StatusBadge
          tone={result.eligible ? 'success' : 'danger'}
          label={
            result.eligible
              ? result.overridden
                ? 'Eligible by staff override'
                : 'Eligible'
              : 'Not eligible'
          }
        />{' '}
        <span className="caption">
          Policy {result.policyVersionId ? shortRef(result.policyVersionId) : 'none'}; reference
          date {formatDate(result.referenceDate)}; evaluated {formatInstant(result.evaluatedAt)}
        </span>
      </span>
      {result.reasons.length > 0 ? (
        <ul aria-label={`${label}: reasons`}>
          {result.reasons.map((reason, i) => (
            <li key={`${reason.code}-${i}`}>
              <StatusBadge {...severityBadge(reason.severity)} /> {reason.message}{' '}
              <span className="caption">
                (source {humanize(reason.source.type)}; required action{' '}
                {humanize(reason.requiredAction)})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.alternatives.length > 0 ? (
        <ul aria-label={`${label}: permitted alternatives`}>
          {result.alternatives.map((alternative, i) => (
            <li key={`${alternative.kind}-${i}`}>
              {alternative.message} <span className="caption">({humanize(alternative.kind)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {override ? (
        <p className="caption">
          Overridden by {override.actorLabel} on {formatInstant(override.overriddenAt)}: “
          {override.reason}”. Original reasons kept: {override.originalReasons.length}.
        </p>
      ) : null}
    </div>
  );
}
