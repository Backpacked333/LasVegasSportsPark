// "Updated 4 minutes ago" for every list and record (SPK-UX-008 stale version, §4.15).
import { formatAge } from '@sportspark/api-client';

export function LastUpdated({
  at,
  now,
  prefix = 'Updated',
}: {
  at: Date | null;
  now: Date;
  prefix?: string;
}) {
  if (!at) return null;
  return (
    <p className="caption" data-testid="last-updated">
      {prefix} {formatAge(at, now)}
    </p>
  );
}
