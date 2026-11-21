/**
 * "7 resolved today · Median time to act: 6 min" (S 1a). Exceptions of the facility resolved
 * (or resolved and closed) since the start of the facility day, from `GET /v1/exceptions`, plus
 * the issues resolved on this device that the API has not closed yet (an offer waiting to be
 * accepted). The median is from opening to resolution. Hidden when the viewer may not read the
 * exception queues (§4.10: never a zero for a list the viewer cannot read).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { Flash } from '../../ui/Flash';
import { Icon } from '../../ui/Icon';
import { useTodayLocal } from './today-local';
import { median, MINUTE } from './today-model';

function resolvedSince(
  items: readonly Schema<'OperationalException'>[],
  start: number,
): Array<{ minutes: number }> {
  return items
    .filter((e) => e.resolvedAt && new Date(e.resolvedAt).getTime() >= start)
    .map((e) => ({
      minutes: Math.max(
        0,
        Math.round((new Date(e.resolvedAt!).getTime() - new Date(e.openedAt).getTime()) / MINUTE),
      ),
    }));
}

export function ResolvedToday({
  facilityId,
  window,
}: {
  facilityId: string;
  window: { start: string; end: string };
}) {
  const local = useTodayLocal();
  const resolved = useApiQuery({
    path: '/exceptions',
    request: { query: { status: 'resolved', facilityId, limit: 200 } },
    refetchInterval: 60_000,
  });
  const closed = useApiQuery({
    path: '/exceptions',
    request: { query: { status: 'closed', facilityId, limit: 200 } },
    refetchInterval: 60_000,
  });
  if (resolved.error || closed.error) return null;
  if (!resolved.data || !closed.data) return null;
  const start = new Date(window.start).getTime();
  const done = [
    ...resolvedSince(resolved.data.items, start),
    ...resolvedSince(closed.data.items, start),
  ];
  const count = done.length + local.resolvedHere;
  const typical = median(done.map((d) => d.minutes));
  return (
    <section className="card resolved-today" aria-label="Resolved today">
      <span className="resolved-icon" aria-hidden="true">
        <Icon name="task_alt" size={22} />
      </span>
      <span className="resolved-text">
        <b>
          <Flash value={count}>{count}</Flash> resolved today
        </b>
        <span className="caption">
          {typical !== null ? `Median time to act: ${typical} min` : 'Nothing timed yet today'}
        </span>
      </span>
    </section>
  );
}
