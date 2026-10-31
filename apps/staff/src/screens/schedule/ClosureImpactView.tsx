/**
 * SCR-S-06 closure impact as the API computes it (SPK-SCHED-009, SPK-AT-009), shared by the preview
 * before a closure is created (`GET /v1/closure-impact`) and the closure's own impact
 * (`GET /v1/closures/{id}`): the affected games, programs, rentals and other events with the teams,
 * people and equipment committed to them, the owning records, and the customers, financial
 * obligations and unsent messages the closure touches.
 *
 * Customers are listed by id in the impact; their names are read on request through
 * `GET /v1/person-names` (names only, §4.14), and a person the viewer may not view reads "Name not
 * available". Obligations are identified only: any financial adjustment is the policy-governed
 * resolution that is still pending (POL-041, DEC-009); this view never proposes an amount.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { namesOf } from '../../features/schedule-facilities/inventory';
import { EVENT_KIND_LABEL, eventBadge } from '../../features/schedule-facilities/labels';
import { usePersonNames } from '../../features/schedule-facilities/person-names';
import { formatRange } from '../../features/schedule-facilities/time';

export type ClosureImpact = Schema<'ClosureImpact'>;
export type AffectedEvent = ClosureImpact['affectedEvents'][number];

const VIA_LABEL: Record<ClosureImpact['customers'][number]['via'][number], string> = {
  commitment: 'committed to the event',
  enrollment: 'enrolled',
  booking: 'booked',
  roster: 'on a rostered team',
};

function words(code: string): string {
  return code.replace(/_/g, ' ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ImpactSummary({ impact, caption }: { impact: ClosureImpact; caption: string }) {
  const s = impact.summary;
  const rows: [string, string][] = [
    ['Games', String(s.games)],
    ['Programs', String(s.programs)],
    ['Rentals', String(s.rentals)],
    ['Other events', String(s.other)],
    ['Teams', String(s.teams)],
    ['People committed (staff, officials, coaches, participants)', String(s.people)],
    ['Equipment', String(s.equipment)],
    ['Owning records (fixtures, sessions, rentals)', String(impact.sourceRecords.length)],
    ['Customers', String(s.customers)],
    ['Financial obligations', String(s.obligations)],
    ['Messages not yet sent', String(s.messages)],
  ];
  return (
    <table className="facts-table">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function commitmentSummary(e: AffectedEvent): string {
  const count = (t: string) => e.commitments.filter((c) => c.partyType === t).length;
  const parts = [
    count('team') ? `${count('team')} team${count('team') === 1 ? '' : 's'}` : null,
    count('person') ? `${count('person')} ${count('person') === 1 ? 'person' : 'people'}` : null,
    count('equipment') ? `${count('equipment')} equipment` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no commitments';
}

export function AffectedEventList({
  impact,
  names,
  timeZone,
  canceled = new Set(),
  unresolved = new Set(),
}: {
  impact: ClosureImpact;
  names: ReadonlyMap<string, string>;
  timeZone: string;
  canceled?: ReadonlySet<string>;
  unresolved?: ReadonlySet<string>;
}) {
  if (impact.affectedEvents.length === 0) {
    return (
      <StateView
        variant="empty"
        title="Nothing is affected"
        description="No booked event overlaps this closure."
      />
    );
  }
  return (
    <ul className="list" aria-label="Affected events">
      {impact.affectedEvents.map((e) => {
        const eb = eventBadge(e.status);
        return (
          <li key={e.eventId}>
            <div className="row-text">
              <span className="row-title">{e.title}</span>
              <span className="caption">
                {EVENT_KIND_LABEL[e.kind]} ·{' '}
                {formatRange(e.scheduledStart, e.scheduledEnd, timeZone)} on{' '}
                {namesOf(e.resourceIds, names)} · {commitmentSummary(e)}
                {e.sourceType ? ` · from a ${words(e.sourceType)}` : ''}
              </span>
            </div>
            <StatusBadge tone={eb.tone} label={eb.label} />
            {canceled.has(e.eventId) ? (
              <StatusBadge tone="neutral" label="Canceled by this closure" />
            ) : null}
            {unresolved.has(e.eventId) ? (
              <StatusBadge tone="warning" label="Awaiting resolution" />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function eventTitles(impact: ClosureImpact, ids: readonly string[]): string {
  const titles = new Map(impact.affectedEvents.map((e) => [e.eventId, e.title]));
  return ids.map((id) => titles.get(id) ?? 'an event not listed').join(', ');
}

function CustomerNames({ impact }: { impact: ClosureImpact }) {
  const names = usePersonNames(impact.customers.map((c) => c.personId));
  return (
    <ul className="list" aria-label="Affected customers">
      {impact.customers.map((c) => {
        const entry = names.get(c.personId) ?? { state: 'loading' as const };
        return (
          <li key={c.personId}>
            <div className="row-text">
              <span className="row-title">
                {entry.state === 'ready'
                  ? entry.name.displayName
                  : entry.state === 'loading'
                    ? 'Loading name…'
                    : 'Name not available'}
              </span>
              <span className="caption">
                {c.via.map((v) => VIA_LABEL[v]).join(', ')} · {eventTitles(impact, c.eventIds)}
              </span>
              {entry.state === 'error' ? (
                <span className="caption">
                  The name could not be loaded ({entry.error.code}).{' '}
                  <Button variant="secondary" onClick={entry.retry}>
                    Try again
                  </Button>
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Customers, financial obligations and unsent messages (SPK-SCHED-009). */
export function ImpactParties({ impact }: { impact: ClosureImpact }) {
  const [showNames, setShowNames] = useState(false);
  return (
    <section aria-labelledby="impact-parties-title">
      <h5 id="impact-parties-title">Customers, obligations and messages</h5>
      <h6>Customers</h6>
      {impact.customers.length === 0 ? (
        <p>No customer takes part in the affected events.</p>
      ) : (
        <>
          <p>
            {plural(impact.customers.length, 'customer takes', 'customers take')} part in the
            affected events (participants, bookers and rostered players).
          </p>
          {showNames ? (
            <CustomerNames impact={impact} />
          ) : (
            <Button variant="secondary" onClick={() => setShowNames(true)}>
              Show the {plural(impact.customers.length, 'customer', 'customers')}
            </Button>
          )}
        </>
      )}
      <h6>Financial obligations</h6>
      {impact.obligations.length === 0 ? (
        <p>No financial obligation is tied to the affected events.</p>
      ) : (
        <ul className="list" aria-label="Affected financial obligations">
          {impact.obligations.map((o) => (
            <li key={`${o.type}:${o.id}`}>
              <div className="row-text">
                <span className="row-title">{words(o.type)}</span>
                <span className="caption">For {eventTitles(impact, o.eventIds)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {impact.obligations.length > 0 ? (
        <StateView
          variant="pending-decision"
          subject="A financial adjustment for these obligations"
          decisions={['POL-041', 'DEC-009']}
          owner="Operations; Finance"
        />
      ) : null}
      <h6>Messages not yet sent</h6>
      {impact.messages.length === 0 ? (
        <p>No unsent notice about the affected events is waiting.</p>
      ) : (
        <>
          <p className="caption">
            These notices are waiting to be sent; the closure or its resolution may supersede them.
          </p>
          <ul className="list" aria-label="Unsent messages about affected events">
            {impact.messages.map((m) => (
              <li key={m.notificationId}>
                <div className="row-text">
                  <span className="row-title">{words(m.kind)}</span>
                  <span className="caption">
                    About {eventTitles(impact, [m.eventId])} · status {m.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
