/**
 * SCR-S-01 Today workspace, shell (SPK-UX-006). Reads `GET /v1/today` for the selected facility and
 * lists each issue with its title, severity, affected record, owner queue, age, deadline and next
 * permitted actions, as the API returns them. Sources the viewer may not read are reported as "not
 * available" (never hidden silently, never inferred). Acknowledge, resolve and close (SCR-S-02) and
 * the per-section layouts belong to the Today screen group.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { useApp } from '../../providers/AppProviders';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

type TodayItem = Schema<'TodayItem'>;
type Severity = TodayItem['severity'];

/** Staff labels use the machine state names (journeys.md section 3, rule 4). */
export const SEVERITY_BADGE: Record<Severity, { tone: StatusTone; label: string }> = {
  critical: { tone: 'danger', label: 'Severity: critical' },
  high: { tone: 'danger', label: 'Severity: high' },
  warning: { tone: 'warning', label: 'Severity: warning' },
  info: { tone: 'info', label: 'Severity: info' },
};

const SOURCE_STATUS: Record<'ok' | 'not_permitted' | 'unavailable', string> = {
  ok: 'Included',
  not_permitted: 'Not available to you',
  unavailable: 'Unavailable right now',
};

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

function TodayItemRow({ item, names }: { item: TodayItem; names: ReadonlyMap<string, string> }) {
  const severity = SEVERITY_BADGE[item.severity];
  return (
    <li data-testid={`today-item-${item.id}`}>
      <div className="row-text">
        <span className="row-title">{item.title}</span>
        <span className="caption">
          {item.affected ? `Affects ${item.affected.type}` : 'No linked record'} · Owner:{' '}
          {item.ownerQueue}
          {item.facilityId ? ` · ${facilityLabel(item.facilityId, names)}` : ''}
          {item.ageMinutes !== null ? ` · Open ${formatMinutes(item.ageMinutes)}` : ''}
          {item.deadlineAt ? ` · Due ${new Date(item.deadlineAt).toLocaleString()}` : ''}
        </span>
        <span>
          <StatusBadge tone={severity.tone} label={severity.label} />{' '}
          <StatusBadge tone="neutral" label={`Status: ${item.status}`} />
          {item.overdue ? (
            <>
              {' '}
              <StatusBadge tone="danger" label="Overdue" />
            </>
          ) : null}
        </span>
      </div>
      {item.nextActions.length > 0 ? (
        <span className="caption">Next: {item.nextActions.map((a) => a.label).join(', ')}</span>
      ) : null}
    </li>
  );
}

export function TodayScreen() {
  const { facilityId } = useApp();
  // Without a facility the request (and cache entry) is the one the facility switcher reads.
  const today = useApiQuery({
    path: '/today',
    request: facilityId ? { query: { facilityId } } : undefined,
  });
  return (
    <section aria-labelledby="today-title">
      <h2 id="today-title">Today</h2>
      <QueryBoundary
        query={today}
        label="today's issues"
        agePrefix="Evaluated"
        isEmpty={(feed) => feed.items.length === 0}
        empty={{
          title: 'No open issues',
          description: 'Nothing needs action in your scope right now.',
        }}
        unavailableOffline={['acknowledging and resolving issues']}
      >
        {(feed) => {
          const names = new Map(feed.facilities.map((f) => [f.facilityId, f.name]));
          return (
            <>
              <ul className="list" aria-label="Open issues">
                {feed.items.map((item) => (
                  <TodayItemRow key={item.id} item={item} names={names} />
                ))}
              </ul>
              <SourcesNote sources={feed.sources} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

function SourcesNote({ sources }: { sources: Schema<'TodaySource'>[] }) {
  const limited = sources.filter((s) => s.status !== 'ok');
  if (limited.length === 0) return null;
  return (
    <section aria-label="Issue sources not included">
      <h3>Not included</h3>
      <ul className="list">
        {limited.map((s) => (
          <li key={`${s.source}-${s.facilityId ?? 'all'}`}>
            <span>{s.source}</span>
            <StatusBadge
              tone={s.status === 'unavailable' ? 'warning' : 'neutral'}
              label={SOURCE_STATUS[s.status]}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
