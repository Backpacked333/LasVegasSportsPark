/**
 * SCR-S-26 Waitlist management (SPK-REG-008, SPK-AT-006): for one offering, each entry with its
 * participant, priority basis and rank, position, preferences, status and offer history, beside
 * the capacity pools (capacity, committed, held, available). Staff may remove an entry with a
 * reason (an open offer is declined and its place released by the API).
 *
 * - Offers are issued by the service when a place is released, in priority order, each holding a
 *   defined place until its server-owned expiry; the API has no command to issue one by hand, so
 *   "issue an offer" is shown as not available rather than imitated.
 * - Late payments never displace a valid offer: the API keeps the offer's hold (SPK-AT-006).
 * - The priority basis and offer expiry policy are pending DEC-006; only the API's values show.
 * - The list is `GET /v1/waitlist-entries?offeringId=`; route parameters are opaque ids only.
 */
import type { Schema } from '@sportspark/api-client';
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
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

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

function EntryCard({ entry }: { entry: Entry }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
    <li aria-labelledby={`entry-${entry.id}`}>
      <div className="row-text">
        <span className="row-title" id={`entry-${entry.id}`}>
          {entry.position !== null ? `${entry.position}. ` : ''}
          <PersonName id={entry.participantPersonId} fallback="Participant" />
        </span>
        <span className="caption">
          {REGISTRATION_INTENT[entry.intent]} · priority basis {humanize(entry.priorityBasis)} (rank{' '}
          {entry.priorityRank}) · joined {formatInstant(entry.joinedAt)}
        </span>
        <span className="caption">Preferences: {preferenceText(entry.preferences)}</span>
        <StatusBadge {...WAITLIST_ENTRY_STATUS[entry.status]} />
        {entry.offers.length > 0 ? (
          <ul aria-label="Offer history">
            {entry.offers.map((offer) => (
              <li key={offer.id}>
                <StatusBadge {...WAITLIST_OFFER_STATUS[offer.status]} />{' '}
                <span className="caption">
                  offered {formatInstant(offer.offeredAt)}, expires {formatInstant(offer.expiresAt)}
                  {offer.acceptedAt ? `, accepted ${formatInstant(offer.acceptedAt)}` : ''}
                  {offer.declinedAt ? `, declined ${formatInstant(offer.declinedAt)}` : ''}
                  {offer.expiredAt ? `, expired ${formatInstant(offer.expiredAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="caption">No offers yet.</span>
        )}
      </div>
      {live ? (
        open ? (
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
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Keep on the waitlist
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
            Remove…
          </Button>
        )
      ) : null}
      <CommandError error={remove.error} onReload={reload} />
    </li>
  );
}

function OfferingWaitlist({ offeringId }: { offeringId: string }) {
  const [status, setStatus] = useState<EntryStatus | ''>('');
  const pools = useApiQuery({ path: '/capacity-pools', request: { query: { offeringId } } });
  const entries = useApiQuery({
    path: '/waitlist-entries',
    request: { query: { offeringId, ...(status ? { status } : {}) } },
  });
  return (
    <>
      <h3>
        <OfferingName id={offeringId} />
      </h3>
      <section className="rf-panel" aria-labelledby="pools-title">
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
            <ul className="list" aria-label="Capacity pools">
              {list.map((pool) => (
                <li key={pool.id}>
                  <div className="row-text">
                    <span className="row-title">
                      {CAPACITY_UNIT[pool.unit]} ({pool.constraintKind})
                    </span>
                    <span className="caption">
                      Capacity {pool.capacity} · committed {pool.committed} · held {pool.held} ·
                      available {pool.available}
                    </span>
                  </div>
                  <StatusBadge
                    tone={pool.available > 0 ? 'success' : 'warning'}
                    label={pool.available > 0 ? `${pool.available} available` : 'Full'}
                  />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </section>
      <StateView
        variant="unavailable"
        title="Issuing an offer by hand is not available"
        description="The service offers a released place to the next waiting entry in priority order, holding it until the offer expires. The API has no command for staff to issue an offer."
      />
      <p className="caption">
        Priority basis and offer expiry come from the waitlist policy, pending{' '}
        {PENDING.waitlistPolicy.ids.join(', ')} (owner: {PENDING.waitlistPolicy.owner}). A late
        payment never displaces a valid offer.
      </p>
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
      <QueryBoundary
        query={entries}
        label="the waitlist"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No waitlist',
          description: 'Nobody is on the waitlist for this offering.',
        }}
        unavailableOffline={['removing entries']}
      >
        {(list) => (
          <ul className="list" aria-label="Waitlist entries">
            {orderEntries(list).map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <OfflineCaption action="removing entries" />
    </>
  );
}

export function WaitlistScreen() {
  const { offeringId } = useParams();
  const navigate = useNavigate();
  const [choice, setChoice] = useState('');
  return (
    <section aria-labelledby="waitlist-title">
      <h2 id="waitlist-title">Waitlist management</h2>
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
        <p>Choose a program and an offering to see its waitlist.</p>
      )}
    </section>
  );
}
