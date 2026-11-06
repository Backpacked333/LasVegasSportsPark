/**
 * The composer's live recipient count (SPK-COMMS-006 while composing; SPK-COMMS-003, SPK-COMMS-007):
 * `POST /v1/notification-audience-counts` resolves the audience being defined from current
 * permissions and answers how many people it reaches and how each channel would reach them
 * (opted out, off by the policy default, no provider). No name, id or contact detail comes back:
 * names appear only in the recipient preview of a composed message. The channel defaults are an
 * engineering placeholder until the operator approves channel use (DEC-012, DEC-062), and the rail
 * says so. The count is re-read shortly after the definition stops changing; nothing is counted
 * until the audience names someone and the message's category is known.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useApi } from '../../providers/AppProviders';

type Body = Schema<'AudienceCountRequest'>;
type Count = Schema<'AudienceCount'>;

const CHANNEL: Record<Count['channels'][number]['channel'], string> = {
  in_app: 'In-app',
  push: 'Push',
  email: 'Email',
  sms: 'SMS',
};

const DEBOUNCE_MS = 400;

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

export function AudienceCount({ request }: { request: Body | null }) {
  const api = useApi();
  const key = request ? JSON.stringify(request) : null;
  const debounced = useDebounced(key, DEBOUNCE_MS);
  const query = useQuery<Count, ApiError>({
    queryKey: ['audience-count', debounced],
    enabled: debounced !== null,
    retry: false,
    staleTime: 30_000,
    queryFn: () =>
      api.post('/notification-audience-counts', {
        body: JSON.parse(debounced as string) as Body,
        // A read sent as POST: the key goes with it but the route stores no outcome.
        intent: api.newIntent(),
      }) as Promise<Count>,
  });
  if (key === null) return null;
  if (query.error) {
    return (
      <p className="caption cm-count-state" data-testid="audience-count-unavailable">
        {query.error.code === 'ACCESS_DENIED'
          ? 'Counting recipients is not available to you.'
          : 'The recipient count could not be read; the preview counts them again.'}
      </p>
    );
  }
  if (!query.data || debounced !== key) {
    return (
      <p className="caption cm-count-state" aria-live="polite">
        Counting recipients…
      </p>
    );
  }
  const count = query.data;
  return (
    <div className="cm-count" data-testid="audience-count" aria-live="polite">
      <span className="cm-count-value">
        {count.count} {count.count === 1 ? 'recipient' : 'recipients'} now
      </span>
      <ul className="cm-count-channels" aria-label="Recipients by channel">
        {count.channels.map((c) => (
          <li key={c.channel}>
            <span className="cm-count-channel">{CHANNEL[c.channel]}</span>{' '}
            <span>{c.reachable}</span>
            {c.optedOut > 0 ? <span className="caption"> · {c.optedOut} opted out</span> : null}
            {c.offByDefault > 0 ? (
              <span className="caption"> · {c.offByDefault} off by default</span>
            ) : null}
            {c.noProvider > 0 ? (
              <span className="caption"> · {c.noProvider} without a provider</span>
            ) : null}
          </li>
        ))}
      </ul>
      {count.unreachable > 0 ? (
        <p className="caption">{count.unreachable} would not be reached on any channel.</p>
      ) : null}
      <p className="caption">
        Channel defaults are pending the operator&apos;s approval (
        {count.pendingDecisions.join(', ')}). Names appear in the preview, never before.
      </p>
    </div>
  );
}
