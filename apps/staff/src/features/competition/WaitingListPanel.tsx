/**
 * Team waiting list of a season (SPK-COMP-006, proposed amendment PA-10; capability
 * `team_waitlist`). Each list shows its order, the places of the division (placed, held by open
 * offers, free) and any open offer with its expiry. With `actions`, league staff offer a free
 * place to the waiting team they choose and withdraw an open offer; the order is always shown.
 * The rule values are proposals: how long an offer stands and whether offers follow the order
 * wait for decision DEC-104, which the panel names.
 *
 * The panel renders only while the capability is on; waiting entries recorded before a switch
 * was turned off stay visible in the entry list with their status.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandButton } from './CommandButton';
import { CommandError } from './CommandError';
import { keys, SuccessNote, useRefetch } from './feedback';
import { SelectField, TextAreaField } from './fields';
import { formatInstant } from './format';

type WaitingList = Schema<'WaitingList'>;
type WaitingEntry = Schema<'WaitingListEntry'>;

export const WAITING_KEYS = keys(
  '/team-entries',
  '/team-entries/{id}',
  '/divisions',
  '/seasons/{id}/waiting-list',
);

/** "2 of 8 places used, 1 offered, 5 free" in plain words; a division without a limit says so. */
export function placesText(list: WaitingList): string {
  if (!list.division) return 'Waiting for any division of the season.';
  if (list.capacity === null) return 'This division has no limit on teams.';
  const offered = list.openOffers ? `, ${list.openOffers} offered to waiting teams` : '';
  return `${list.placed ?? 0} of ${list.capacity} places used${offered}, ${list.freePlaces ?? 0} free.`;
}

function OfferActions({
  entry,
  list,
  divisions,
}: {
  entry: WaitingEntry;
  list: WaitingList;
  divisions: readonly { id: string; name: string }[];
}) {
  const offer = useApiCommand('post', '/team-entries/{id}/place-offers', {
    invalidate: WAITING_KEYS,
  });
  const withdraw = useApiCommand('post', '/team-entry-place-offers/{id}/withdraw', {
    invalidate: WAITING_KEYS,
  });
  const reload = useRefetch(['/seasons/{id}/waiting-list', '/team-entries']);
  const [divisionId, setDivisionId] = useState(list.division?.id ?? '');
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [divisionError, setDivisionError] = useState<string | null>(null);

  const doOffer = () => {
    if (!divisionId) {
      setDivisionError('Choose the division whose place is offered.');
      return;
    }
    setDivisionError(null);
    withdraw.reset();
    void offer
      .submit({
        path: { id: entry.teamEntryId },
        body: { expectedRevision: entry.revision, divisionId },
      })
      .catch(() => undefined);
  };
  const doWithdraw = () => {
    if (!entry.openOffer) return;
    if (!reason.trim()) {
      setReasonError('Give a reason for withdrawing the offer.');
      return;
    }
    setReasonError(null);
    offer.reset();
    void withdraw
      .submit({
        path: { id: entry.openOffer.id },
        body: { expectedRevision: entry.openOffer.revision, reason: reason.trim() },
      })
      .catch(() => undefined);
  };
  const onReload = () => {
    offer.reset();
    withdraw.reset();
    reload();
  };

  if (entry.openOffer) {
    return (
      <div className="form">
        {withdrawing ? (
          <form
            className="form"
            noValidate
            aria-label={`Withdraw the offer to ${entry.teamName}`}
            onSubmit={(event) => {
              event.preventDefault();
              doWithdraw();
            }}
          >
            <TextAreaField
              label="Reason"
              required
              value={reason}
              onChange={setReason}
              error={reasonError}
            />
            <CommandButton type="submit" variant="secondary" busy={withdraw.isProcessing}>
              Withdraw the offer
            </CommandButton>
          </form>
        ) : (
          <div className="actions">
            <CommandButton variant="secondary" busy={false} onClick={() => setWithdrawing(true)}>
              {`Withdraw the offer to ${entry.teamName}`}
            </CommandButton>
          </div>
        )}
        {withdraw.data ? (
          <SuccessNote>Offer withdrawn; the team keeps its place</SuccessNote>
        ) : null}
        <CommandError error={withdraw.error} onRetry={doWithdraw} onReload={onReload} />
      </div>
    );
  }
  const free = list.division ? list.freePlaces === null || list.freePlaces > 0 : true;
  return (
    <div className="form">
      {list.division ? null : (
        <SelectField
          label={`Division to offer ${entry.teamName}`}
          value={divisionId}
          onChange={setDivisionId}
          options={divisions.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="Choose a division"
          error={divisionError}
        />
      )}
      {free ? (
        <div className="actions">
          <CommandButton busy={offer.isProcessing} onClick={doOffer}>
            {`Offer a place to ${entry.teamName}`}
          </CommandButton>
        </div>
      ) : (
        <span className="caption">No free place to offer yet.</span>
      )}
      {offer.data ? (
        <SuccessNote>
          {`Place offered until ${formatInstant(offer.data.offer.expiresAt)}`}
        </SuccessNote>
      ) : null}
      <CommandError error={offer.error} onRetry={doOffer} onReload={onReload} />
    </div>
  );
}

function ListSection({
  list,
  actions,
  divisions,
}: {
  list: WaitingList;
  actions: boolean;
  divisions: readonly { id: string; name: string }[];
}) {
  const name = list.division ? list.division.name : 'Any division';
  return (
    <div className="form">
      <p>
        <strong>{name}</strong> <span className="caption">{placesText(list)}</span>
      </p>
      <ol className="list" aria-label={`Teams waiting for ${name}`}>
        {list.entries.map((entry) => (
          <li key={entry.teamEntryId}>
            <div className="row-text">
              <span className="row-title">
                {entry.position}. {entry.teamName}
              </span>
              <span className="caption">Waiting since {formatInstant(entry.waitingSince)}</span>
              {entry.openOffer ? (
                <span>
                  <StatusBadge
                    tone="info"
                    label={`Place offered in ${entry.openOffer.divisionName}`}
                  />{' '}
                  <span className="caption">
                    Offer expires {formatInstant(entry.openOffer.expiresAt)}. The place is held
                    until the captain answers or the offer expires.
                  </span>
                </span>
              ) : null}
            </div>
            {actions ? <OfferActions entry={entry} list={list} divisions={divisions} /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WaitingListPanel({
  seasonId,
  seasonName,
  actions = false,
}: {
  seasonId: string;
  /** Names the season in the heading where several seasons are listed. */
  seasonName?: string;
  actions?: boolean;
}) {
  const permissions = usePermissions();
  const enabled = permissions.isCapabilityEnabled('team_waitlist') === true;
  const lists = useApiQuery({
    path: '/seasons/{id}/waiting-list',
    request: { path: { id: seasonId } },
    enabled,
  });
  if (!enabled) return null;
  const titleId = `waiting-list-${seasonId}`;
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h3 id={titleId}>{seasonName ? `Waiting list of ${seasonName}` : 'Waiting list'}</h3>
      <QueryBoundary
        query={lists}
        label="waiting list"
        isEmpty={(data) => data.lists.every((list) => list.entries.length === 0)}
        empty={{
          title: 'No team is waiting',
          description:
            'A team that meets a full division waits here in order, holds no place and owes nothing.',
        }}
        unavailableOffline={actions ? ['offering a place or withdrawing an offer'] : undefined}
      >
        {(data) => (
          <>
            <p className="caption">
              Teams wait in the order shown, hold no place and owe nothing. You choose which waiting
              team is offered a free place; an offer stands for {data.offerHours} hours. Proposed
              rule, pending decision DEC-104.
            </p>
            {data.lists
              .filter((list) => list.entries.length > 0)
              .map((list) => (
                <ListSection
                  key={list.division?.id ?? 'season'}
                  list={list}
                  actions={actions}
                  divisions={data.lists.flatMap((l) => (l.division ? [l.division] : []))}
                />
              ))}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
