/**
 * SCR-S-26 Waitlist management (SPK-REG-008, SPK-AT-006): for one offering, each entry with its
 * participant, priority basis and rank, position, preferences, status and offer history, beside
 * the capacity pools (capacity, committed, held, available). Staff may remove an entry with a
 * reason (an open offer is declined and its place released by the API).
 *
 * - "Offer the place" (`POST /v1/waitlist-entries/{id}/offer`, ENR-04) asks the API to offer a
 *   free place to a waiting entry, with a reason and `expectedRevision`; the capacity constraints
 *   still decide. Only the next entry in the API's priority order can be offered
 *   (`NOT_NEXT_IN_QUEUE` names who is), and without a free place the answer is
 *   CAPACITY_UNAVAILABLE ("offer without capacity"). The offer holds its place until the API's
 *   expiry; the service also offers released places on its own.
 * - Late payments never displace a valid offer: the API keeps the offer's hold (SPK-AT-006).
 * - The priority basis and offer expiry policy are pending DEC-006; only the API's values show.
 * - Times are in the offering facility's zone (SPK-SCHED-008).
 * - The list is `GET /v1/waitlist-entries?offeringId=`; route parameters are opaque ids only.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { SelectField, TextArea } from '../../features/registration-finance/fields';
import { formatInstant, humanize } from '../../features/registration-finance/format';
import {
  CAPACITY_UNIT,
  REGISTRATION_INTENT,
  WAITLIST_ENTRY_STATUS,
  WAITLIST_OFFER_STATUS,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfferingPicker } from '../../features/registration-finance/OfferingPicker';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { STATUS_GLYPHS, StatusBadge } from '../../ui/StatusBadge';
import { StateView } from '../../ui/StateView';
import { PageHeader } from '../../ui/Page';
import { CapacityMeter } from '../../features/grow/Grow';
import { useNow } from '../../providers/AppProviders';
import './registrations.css';

type Entry = Schema<'WaitlistEntry'>;
type EntryStatus = Schema<'WaitlistEntryStatus'>;

const WAITLIST_KEY = ['api', '/waitlist-entries'] as const;

/** Waiting entries by position, then offered, then the rest by when they joined. */
export function orderEntries(entries: readonly Entry[]): Entry[] {
  const rank = (e: Entry) => (e.status === 'offered' ? 0 : e.status === 'waiting' ? 1 : 2);
  return [...entries].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
      a.queuedAt.localeCompare(b.queuedAt),
  );
}

function preferenceText(preferences: Record<string, unknown>): string {
  const entries = Object.entries(preferences);
  if (entries.length === 0) return 'None stated';
  return entries
    .map(
      ([key, value]) =>
        `${humanize(key)}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    )
    .join('; ');
}

/** VALIDATION_FAILED `NOT_NEXT_IN_QUEUE`: the entry the API would offer first, if it says. */
function notNextOf(error: ApiError | null): { next: string | null } | null {
  if (!error || error.code !== 'VALIDATION_FAILED') return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  if (!details || details['code'] !== 'NOT_NEXT_IN_QUEUE') return null;
  const next = details['nextWaitlistEntryId'];
  return { next: typeof next === 'string' ? next : null };
}

function OfferPlace({
  entry,
  entries,
  zone,
  onDone,
}: {
  entry: Entry;
  entries: readonly Entry[];
  zone: string | null;
  onDone: () => void;
}) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const offer = useApiCommand('post', '/waitlist-entries/{id}/offer', {
    invalidate: [WAITLIST_KEY, ['api', '/capacity-pools']],
  });
  const reload = () => {
    offer.reset();
    void queryClient.invalidateQueries({ queryKey: WAITLIST_KEY });
    void queryClient.invalidateQueries({ queryKey: ['api', '/capacity-pools'] });
  };
  const notNext = notNextOf(offer.error);
  const nextEntry = notNext?.next ? entries.find((e) => e.id === notNext.next) : undefined;
  const made = offer.data?.offers.find((o) => o.status === 'offered') ?? null;
  return (
    <form
      noValidate
      aria-label="Offer the place"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required and is audited.');
          return;
        }
        setReasonError(null);
        offer
          .submit({
            path: { id: entry.id },
            body: { reason: reason.trim(), expectedRevision: entry.revision },
          })
          .catch(() => undefined);
      }}
    >
      <p className="caption">
        The API offers a free place to the next waiting entry in priority order and holds it until
        the offer expires. The expiry comes from the waitlist policy, pending{' '}
        {PENDING.waitlistOfferExpiry.ids.join(', ')} (owner: {PENDING.waitlistOfferExpiry.owner}).
      </p>
      <TextArea
        label="Reason for offering the place"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
      />
      <div className="rf-actions">
        <Button type="submit" busy={offer.isProcessing} disabled={!online || offer.isProcessing}>
          Offer the place
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Do not offer
        </Button>
      </div>
      <OfflineCaption action="offering a place" />
      {offer.status === 'success' && offer.data ? (
        <p role="status">
          Offered.{' '}
          {made
            ? `The place is held until ${formatInstant(made.expiresAt, zone)} (the API's expiry).`
            : `The entry is now ${WAITLIST_ENTRY_STATUS[offer.data.status].label}.`}
        </p>
      ) : null}
      {notNext ? (
        <section className="state" aria-live="polite" data-testid="state-validation">
          <StatusBadge tone="warning" label="Not next in the queue" />
          <p>
            Another waiting entry is offered the next place first
            {nextEntry ? (
              <>
                {': '}
                <PersonName id={nextEntry.participantPersonId} fallback="Participant" />
                {nextEntry.position !== null ? ` (position ${nextEntry.position})` : ''}
              </>
            ) : null}
            . Nothing was offered.
          </p>
          <p className="caption">Error code: {offer.error?.code}</p>
          <Button onClick={reload}>Reload</Button>
        </section>
      ) : (
        <CommandError error={offer.error} onReload={reload} />
      )}
    </form>
  );
}

/** "4h 48m left" (or "Expired") from now to the offer's expiry. */
export function timeLeft(expiresAt: string, now: Date): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return 'Expired';
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  return hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
}

/**
 * An open offer with its live expiry: the time left is written and the bar repeats it (the API's
 * expiry decides; nothing here expires an offer).
 */
function OfferLive({ offer, zone }: { offer: Entry['offers'][number]; zone: string | null }) {
  const now = useNow(30_000);
  const start = new Date(offer.offeredAt).getTime();
  const end = new Date(offer.expiresAt).getTime();
  const used =
    end > start ? Math.min(100, Math.max(0, ((now.getTime() - start) / (end - start)) * 100)) : 100;
  const left = timeLeft(offer.expiresAt, now);
  return (
    <div className="offer-live" data-expired={left === 'Expired'}>
      <span className="offer-live-head">
        <span>
          <b>Offer out</b> until {formatInstant(offer.expiresAt, zone)}
        </span>
        <span className="offer-live-left">◷ {left}</span>
      </span>
      <span className="offer-live-bar" aria-hidden="true">
        <span style={{ width: `${100 - Math.round(used)}%` }} />
      </span>
    </div>
  );
}

function EntryCard({
  entry,
  entries,
  zone,
}: {
  entry: Entry;
  entries: readonly Entry[];
  zone: string | null;
}) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<'remove' | 'offer' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const remove = useApiCommand('post', '/waitlist-entries/{id}/remove', {
    invalidate: [WAITLIST_KEY, ['api', '/capacity-pools']],
  });
  const live = entry.status === 'waiting' || entry.status === 'offered';
  const reload = () => {
    remove.reset();
    void queryClient.invalidateQueries({ queryKey: WAITLIST_KEY });
  };
  return (
    <li aria-labelledby={`entry-${entry.id}`} className="entry" data-status={entry.status}>
      <span className="entry-position" aria-hidden="true">
        {entry.position !== null
          ? entry.position
          : STATUS_GLYPHS[WAITLIST_ENTRY_STATUS[entry.status].tone]}
      </span>
      <div className="row-text">
        <span className="row-title" id={`entry-${entry.id}`}>
          {entry.position !== null ? `${entry.position}. ` : ''}
          <PersonName id={entry.participantPersonId} fallback="Participant" />
        </span>
        <span className="caption">
          {REGISTRATION_INTENT[entry.intent]} · priority basis {humanize(entry.priorityBasis)} (rank{' '}
          {entry.priorityRank}) · joined {formatInstant(entry.joinedAt, zone)}
        </span>
        <span className="caption">Preferences: {preferenceText(entry.preferences)}</span>
        <span className="actions-row">
          <StatusBadge {...WAITLIST_ENTRY_STATUS[entry.status]} />
        </span>
        {entry.offers
          .filter((offer) => offer.status === 'offered')
          .map((offer) => (
            <OfferLive key={offer.id} offer={offer} zone={zone} />
          ))}
        {entry.offers.length > 0 ? (
          <ul aria-label="Offer history">
            {entry.offers.map((offer) => (
              <li key={offer.id}>
                <StatusBadge {...WAITLIST_OFFER_STATUS[offer.status]} />{' '}
                <span className="caption">
                  offered {formatInstant(offer.offeredAt, zone)}, expires{' '}
                  {formatInstant(offer.expiresAt, zone)}
                  {offer.acceptedAt ? `, accepted ${formatInstant(offer.acceptedAt, zone)}` : ''}
                  {offer.declinedAt ? `, declined ${formatInstant(offer.declinedAt, zone)}` : ''}
                  {offer.expiredAt ? `, expired ${formatInstant(offer.expiredAt, zone)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="caption">No offers yet.</span>
        )}
      </div>
      {live ? (
        open === 'remove' ? (
          <form
            noValidate
            aria-label="Remove from the waitlist"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) {
                setReasonError('A reason is required and is audited.');
                return;
              }
              setReasonError(null);
              remove
                .submit({
                  path: { id: entry.id },
                  body: { reason: reason.trim(), expectedRevision: entry.revision },
                })
                .catch(() => undefined);
            }}
          >
            <TextArea
              label="Reason for removing"
              required
              value={reason}
              onChange={setReason}
              error={reasonError}
            />
            {entry.status === 'offered' ? (
              <p className="caption">The open offer is declined and its place released.</p>
            ) : null}
            <div className="rf-actions">
              <Button type="submit" busy={remove.isProcessing} disabled={!online}>
                Remove from the waitlist
              </Button>
              <Button variant="secondary" onClick={() => setOpen(null)}>
                Keep on the waitlist
              </Button>
            </div>
          </form>
        ) : open === 'offer' ? (
          <OfferPlace entry={entry} entries={entries} zone={zone} onDone={() => setOpen(null)} />
        ) : (
          <div className="rf-actions">
            {entry.status === 'waiting' ? (
              <Button
                disabled={!online}
                onClick={() => setOpen('offer')}
                aria-describedby={`entry-${entry.id}`}
              >
                Offer the place…
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={!online}
              onClick={() => setOpen('remove')}
              aria-describedby={`entry-${entry.id}`}
            >
              Remove…
            </Button>
          </div>
        )
      ) : null}
      <CommandError error={remove.error} onReload={reload} />
    </li>
  );
}

function OfferingWaitlist({ offeringId }: { offeringId: string }) {
  const [status, setStatus] = useState<EntryStatus | ''>('');
  // SPK-SCHED-008: the offering names its facility and that facility's zone.
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    staleTime: 5 * 60_000,
  });
  const zone = offering.data?.facility?.timezone ?? null;
  const pools = useApiQuery({ path: '/capacity-pools', request: { query: { offeringId } } });
  const entries = useApiQuery({
    path: '/waitlist-entries',
    request: { query: { offeringId, ...(status ? { status } : {}) } },
  });
  return (
    <>
      <div className="waitlist-head">
        <h3>
          <OfferingName id={offeringId} />
        </h3>
      </div>
      <div className="split">
        <div className="split-main">
          <section className="card card-flush queue-card" aria-labelledby="entries-title">
            <div className="card-head">
              <h4 id="entries-title">Queue</h4>
              {entries.data ? (
                <span className="queue-count">
                  {entries.data.filter((e) => e.status === 'waiting').length} waiting ·{' '}
                  {entries.data.filter((e) => e.status === 'offered').length} offers out
                </span>
              ) : null}
            </div>
            <div className="queue-note">
              <SelectField
                label="Entries"
                value={status}
                placeholder="All statuses"
                onChange={(v) => setStatus(v as EntryStatus | '')}
                options={Object.entries(WAITLIST_ENTRY_STATUS).map(([value, badge]) => ({
                  value,
                  label: badge.label,
                }))}
              />
            </div>
            <QueryBoundary
              query={entries}
              label="the waitlist"
              isEmpty={(list) => list.length === 0}
              empty={{
                title: 'No waitlist',
                description: 'Nobody is on the waitlist for this offering.',
              }}
              unavailableOffline={['offering places', 'removing entries']}
            >
              {(list) => (
                <ul className="list approvals waitlist-entries" aria-label="Waitlist entries">
                  {orderEntries(list).map((entry) => (
                    <EntryCard key={entry.id} entry={entry} entries={list} zone={zone} />
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </section>
          <OfflineCaption action="offering places or removing entries" />
        </div>
        <aside className="split-side" aria-label="Capacity and policy">
          <section className="card" aria-labelledby="pools-title">
            <h4 id="pools-title">Capacity</h4>
            <QueryBoundary
              query={pools}
              label="capacity"
              isEmpty={(list) => list.length === 0}
              empty={{
                title: 'No capacity pools',
                description: 'This offering has no capacity pools yet.',
              }}
            >
              {(list) => (
                <ul className="list pool-list" aria-label="Capacity pools">
                  {list.map((pool) => (
                    <li key={pool.id}>
                      <span className="pool-head">
                        <span className="row-title">
                          {CAPACITY_UNIT[pool.unit]} ({pool.constraintKind})
                        </span>
                        <StatusBadge
                          tone={pool.available > 0 ? 'success' : 'warning'}
                          label={pool.available > 0 ? `${pool.available} available` : 'Full'}
                        />
                      </span>
                      <CapacityMeter
                        capacity={pool.capacity}
                        committed={pool.committed}
                        held={pool.held}
                        note=" "
                      />
                      <span className="caption">
                        Capacity {pool.capacity} · committed {pool.committed} · held {pool.held} ·
                        available {pool.available}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </section>
          <section className="card">
            <h4>Waitlist policy</h4>
            <p className="caption">
              Priority basis and offer expiry come from the waitlist policy, pending{' '}
              {PENDING.waitlistPolicy.ids.join(', ')} (owner: {PENDING.waitlistPolicy.owner}). A
              late payment never displaces a valid offer.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

export function WaitlistScreen() {
  const { offeringId } = useParams();
  const navigate = useNavigate();
  const [choice, setChoice] = useState('');
  return (
    <section aria-labelledby="waitlist-title" className="grow">
      <PageHeader
        eyebrow="Grow · Registrations · Waitlists and live offers"
        title="Waitlist management"
        titleId="waitlist-title"
      />
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <OfferingPicker
        label="Waitlist of"
        value={choice}
        onChange={(id) => {
          setChoice(id);
          if (id) navigate(`/registrations/waitlists/${id}`);
        }}
      />
      {offeringId ? (
        <OfferingWaitlist key={offeringId} offeringId={offeringId} />
      ) : (
        <StateView
          variant="empty"
          title="Choose an offering"
          description="Choose a program and an offering to see its waitlist."
        />
      )}
    </section>
  );
}
