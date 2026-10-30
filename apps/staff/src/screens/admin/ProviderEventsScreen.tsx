/**
 * SCR-S-47 provider events (§4.12 inbox, §4.14, §5.2; SPK-UX-008, SPK-UX-009): the events the
 * provider inbox received (`GET /v1/provider-events`, K-08), newest first with the API's cursor,
 * filtered by provider, status, event type and received period. Each shows whether its signature
 * was verified, its state as text with a glyph, its attempts and last error; a payload is never
 * shown (it may carry customer data, §4.14). No provider is selected (§5.2, DEC-013): today the
 * events come from the deterministic test adapters. ACCESS_DENIED (core.view_provider_events:
 * finance operator, general manager, system administration, Proposed) is "not available to you".
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { InsightQueryBoundary } from '../../features/insight-admin/feedback';
import { SelectField, TextField } from '../../features/insight-admin/fields';
import {
  deviceTimeZone,
  formatInstant,
  localDateTimeToInstant,
} from '../../features/insight-admin/format';
import { PROVIDER_EVENT_BADGES } from '../../features/insight-admin/labels';
import { AdminNav } from '../../features/insight-admin/nav';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';

type ProviderEvent = Schema<'ProviderEvent'>;
type ProviderEventStatus = Schema<'ProviderEventStatus'>;

interface Filters {
  provider?: string;
  status?: ProviderEventStatus;
  eventType?: string;
  from?: string;
  to?: string;
}

function EventRow({ event }: { event: ProviderEvent }) {
  const badge = PROVIDER_EVENT_BADGES[event.status];
  return (
    <li aria-labelledby={`provider-event-${event.id}`}>
      <div className="row-text">
        <span className="row-title" id={`provider-event-${event.id}`}>
          {event.provider} · {event.eventType}
        </span>
        <span>
          <StatusBadge tone={badge.tone} label={badge.label} />{' '}
          <StatusBadge
            tone={event.signatureVerified ? 'success' : 'warning'}
            label={event.signatureVerified ? 'signature verified' : 'signature not verified'}
          />
        </span>
        <span className="caption">
          Provider event {event.providerEventId} · received {formatInstant(event.receivedAt)}
          {event.processedAt ? ` · processed ${formatInstant(event.processedAt)}` : ''} ·{' '}
          {event.attempts} attempt{event.attempts === 1 ? '' : 's'}
        </span>
        {event.lastError ? <span className="caption">Last error: {event.lastError}</span> : null}
        {event.status === 'dead' ? (
          <span className="caption">
            Its retries are exhausted: the owning queue reconciles it; nothing is retried
            automatically.
          </span>
        ) : null}
      </div>
    </li>
  );
}

function EventList({ filters }: { filters: Filters }) {
  const pages = useApiPages({
    path: '/provider-events',
    request: { query: { limit: 25, ...filters } },
  });
  return (
    <>
      <InsightQueryBoundary
        query={pages}
        label="provider events"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No provider events',
          description: 'No event matches these filters. Events appear as the inbox receives them.',
        }}
        deniedDescription="Reading provider events needs its own permission."
      >
        {(items) => (
          <ul className="list" aria-label="Provider events">
            {items.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </InsightQueryBoundary>
      <LoadMore pages={pages} label="provider events" />
    </>
  );
}

export function ProviderEventsScreen() {
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [eventType, setEventType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Filters>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const filters: Filters = {};
    if (provider.trim()) filters.provider = provider.trim().slice(0, 100);
    if (status) filters.status = status as ProviderEventStatus;
    if (eventType.trim()) filters.eventType = eventType.trim().slice(0, 200);
    const fromAt = from ? localDateTimeToInstant(from) : null;
    const toAt = to ? localDateTimeToInstant(to) : null;
    if (from && !fromAt) next.from = 'Enter a valid start.';
    if (to && !toAt) next.to = 'Enter a valid end.';
    if (fromAt && toAt && toAt <= fromAt) next.to = 'The end must be after the start.';
    if (fromAt) filters.from = fromAt;
    if (toAt) filters.to = toAt;
    setErrors(next);
    if (Object.keys(next).length === 0) setApplied(filters);
  };

  return (
    <section aria-labelledby="provider-events-title" className="ia-screen">
      <h2 id="provider-events-title">Provider events</h2>
      <AdminNav />
      <p className="caption">
        Events received from payment, messaging and other providers, as the inbox recorded them.
        Their payloads are never shown here (§4.14). No provider is selected yet, so these come from
        the test adapters (§5.2).
      </p>
      <form className="ia-form" onSubmit={submit} aria-label="Filter provider events" noValidate>
        <div className="ia-filters">
          <TextField label="Provider" value={provider} onChange={setProvider} />
          <SelectField
            label="Status"
            value={status}
            onChange={setStatus}
            placeholder="All statuses"
            options={Object.keys(PROVIDER_EVENT_BADGES).map((s) => ({ value: s, label: s }))}
          />
          <TextField label="Event type" value={eventType} onChange={setEventType} />
          <TextField
            label="Received from"
            type="datetime-local"
            value={from}
            onChange={setFrom}
            hint={`Your time zone (${deviceTimeZone()}).`}
            error={errors.from}
          />
          <TextField
            label="Received before"
            type="datetime-local"
            value={to}
            onChange={setTo}
            error={errors.to}
          />
        </div>
        <div>
          <Button type="submit">Show events</Button>
        </div>
      </form>
      <section className="ia-section" aria-labelledby="provider-events-list-title">
        <h3 id="provider-events-list-title">Events</h3>
        <EventList key={JSON.stringify(applied)} filters={applied} />
      </section>
    </section>
  );
}
