/**
 * Waitlist offers (handoff S 2c; INTERACTIONS 2c; SPK-REG-008, §4.9): every offer in flight with its
 * status and time left, the next family in line, and what staff can do about it.
 *
 * - Reads `GET /v1/waitlist-queue` (the staff queue across offerings, enrollment.manage_waitlist:
 *   program, league and general managers; the front desk is refused and told so): offers in flight
 *   (`status=offered`), the ones settled lately (accepted, passed, ran out) and who waits next per
 *   offering (`status=waiting`, by position).
 * - An offer with less than 2 hours left turns amber and suggests a call. The API does not record
 *   whether a family opened the offer, so "not opened" is not claimed: the row says the time left.
 * - Withdraw (confirm): the offer ends and its place returns, through the staff command that takes
 *   the family off the list (`POST /v1/waitlist-entries/{id}/remove`, with the reason); the place
 *   then goes to the next family by the queue's own rule.
 * - Offer to next: a passed or lapsed offer's place goes to the next family
 *   (`POST /v1/waitlist-entries/{id}/offer`, the same order and checks as the queue).
 * - Call family: shows the payer's phone (`GET /v1/people/{id}` contact points) and notes "Called
 *   8:52" on the row. **Proposed:** a contact log is not in the API; the note is kept on this
 *   device only.
 * - Extend (+12 h / +24 h): **Pending decision DEC-006** (offer expiry and priority); the API has
 *   no command to move an offer's expiry, so the choices are shown and disabled.
 * - "Offer the next family by itself": **Pending decision 4** (auto-offer); a read-only proposed
 *   setting. Today the queue already offers a freed place by itself (capacity release), and a
 *   passed offer is handed on with Offer to next.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { asApiError, useIntentSend } from '../../api/useIntentSend';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StateView } from '../../ui/StateView';
import { STATUS_GLYPHS, type StatusTone } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { personName, usePeople } from './triage-data';
import { QUEUE_INVALIDATE } from './TriageQueue';
import { runningOut, shareLeft, shortDate, timeLeftLabel } from './triage-model';

type Item = Schema<'WaitlistQueueItem'>;

const CALLS_KEY = 'sportspark.waitlist.calls';

function readCalls(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CALLS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function clockOf(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function lastOffer(item: Item) {
  return [...item.offers].sort((a, b) => Date.parse(b.offeredAt) - Date.parse(a.offeredAt))[0];
}

interface Row {
  item: Item;
  offer: Item['offers'][number];
  state: 'offered' | 'accepted' | 'passed' | 'ran_out';
}

/** The median of the accept times of the settled offers listed, and the share of each outcome. */
export function offerStats(rows: readonly Row[]) {
  const settled = rows.filter((r) => r.state !== 'offered');
  const accepted = settled.filter((r) => r.state === 'accepted' && r.offer.acceptedAt);
  const times = accepted
    .map((r) => Date.parse(r.offer.acceptedAt!) - Date.parse(r.offer.offeredAt))
    .sort((a, b) => a - b);
  const median =
    times.length === 0
      ? null
      : times.length % 2
        ? times[(times.length - 1) / 2]!
        : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2;
  const pct = (n: number) => (settled.length ? Math.round((n / settled.length) * 100) : 0);
  return {
    median,
    settled: settled.length,
    accepted: pct(accepted.length),
    passed: pct(settled.filter((r) => r.state === 'passed').length),
    ranOut: pct(settled.filter((r) => r.state === 'ran_out').length),
  };
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${minutes % 60} m` : `${minutes} m`;
}

export function WaitlistOffersTab() {
  const { online } = useApp();
  const now = useNow(30_000);
  const toast = useToast();
  const { send } = useIntentSend(QUEUE_INVALIDATE);
  const offered = useApiPages({
    path: '/waitlist-queue',
    request: { query: { status: 'offered', limit: 100 } },
  });
  const accepted = useApiPages({
    path: '/waitlist-queue',
    request: { query: { status: 'accepted', limit: 20 } },
  });
  const lapsed = useApiPages({
    path: '/waitlist-queue',
    request: { query: { status: 'waiting', limit: 200 } },
  });
  const [calls, setCalls] = useState<Record<string, string>>(readCalls);
  const [calling, setCalling] = useState<Item | null>(null);
  const [withdrawing, setWithdrawing] = useState<Item | null>(null);
  const [extendFor, setExtendFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const item of offered.data ?? []) {
      const offer = item.offers.find((o) => o.status === 'offered') ?? lastOffer(item);
      if (offer) out.push({ item, offer, state: 'offered' });
    }
    for (const item of accepted.data ?? []) {
      const offer = item.offers.find((o) => o.status === 'accepted');
      if (offer) out.push({ item, offer, state: 'accepted' });
    }
    // A family back in line after an offer that was passed or ran out (the queue requeues them).
    for (const item of lapsed.data ?? []) {
      const offer = lastOffer(item);
      if (offer && (offer.status === 'declined' || offer.status === 'expired')) {
        out.push({ item, offer, state: offer.status === 'declined' ? 'passed' : 'ran_out' });
      }
    }
    return out;
  }, [offered.data, accepted.data, lapsed.data]);

  /** The next family waiting per offering (lowest position), never the row's own family. */
  const nextOf = (item: Item): Item | undefined =>
    (lapsed.data ?? [])
      .filter((w) => w.offeringId === item.offeringId && w.id !== item.id && w.position !== null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

  const people = usePeople([
    ...rows.map((r) => r.item.participantPersonId),
    ...rows.map((r) => r.item.payerPersonId).filter((x): x is string => !!x),
    ...rows.map((r) => nextOf(r.item)?.participantPersonId).filter((x): x is string => !!x),
  ]);
  const nameOf = (id: string | undefined | null) =>
    (id ? personName(people.get(id)) : null) ?? 'Family';

  const denied = offered.error?.isPermissionRestriction || offered.error?.isNotFound;
  if (denied) {
    return (
      <StateView
        variant="unavailable"
        title="Waitlist offers are not available to you"
        description="Program, league and general managers manage offers across activities (enrollment.manage_waitlist). Each activity's waitlist stays readable on its page."
      />
    );
  }
  const loading = !offered.data && !offered.error;
  const stats = offerStats(rows);

  const offerNext = async (row: Row) => {
    const next = nextOf(row.item);
    if (!next) return;
    setBusy(row.item.id);
    try {
      await send(`offer:${next.id}`, 'post', '/waitlist-entries/{id}/offer', {
        path: { id: next.id },
        body: {
          expectedRevision: next.revision,
          reason: `The place passed by ${nameOf(row.item.participantPersonId)} goes to the next family.`,
        },
      });
      toast.show({
        tone: 'success',
        message: `Offered to ${nameOf(next.participantPersonId)} for 24 h.`,
      });
    } catch (cause) {
      toast.show({ tone: 'error', message: `No offer was sent: ${asApiError(cause).message}` });
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (item: Item) => {
    setBusy(item.id);
    try {
      await send(`remove:${item.id}`, 'post', '/waitlist-entries/{id}/remove', {
        path: { id: item.id },
        body: {
          expectedRevision: item.revision,
          reason: 'Offer withdrawn by staff; the place returns to the queue.',
        },
      });
      setWithdrawing(null);
      toast.show({ tone: 'success', message: 'Offer withdrawn. The place returns to the queue.' });
    } catch (cause) {
      toast.show({ tone: 'error', message: `Not withdrawn: ${asApiError(cause).message}` });
    } finally {
      setBusy(null);
    }
  };

  const logCall = (item: Item) => {
    const next = { ...calls, [item.id]: now.toISOString() };
    setCalls(next);
    try {
      localStorage.setItem(CALLS_KEY, JSON.stringify(next));
    } catch {
      // Browser storage blocked: the note lasts for the page.
    }
    setCalling(null);
  };

  return (
    <div className="wl">
      <section className="card card-flush wl-card" aria-label="Offers in flight">
        {loading ? (
          <SkeletonGroup label="waitlist offers" className="tri-loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={60} radius={12} />
            ))}
          </SkeletonGroup>
        ) : offered.error ? (
          <StateView variant="error" error={offered.error} onRetry={() => void offered.refetch()} />
        ) : rows.length === 0 ? (
          <StateView
            variant="empty"
            title="No offers in flight"
            description="When a place frees up, the first family in line gets an offer and it shows here."
          />
        ) : (
          <table className="wl-table">
            <thead>
              <tr>
                <th scope="col">Activity · place</th>
                <th scope="col">Offered to</th>
                <th scope="col">Status</th>
                <th scope="col">Time left</th>
                <th scope="col">Next in line</th>
                <th scope="col" className="wl-actions-col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { item, offer, state } = row;
                const late = state === 'offered' && runningOut(offer.expiresAt, now);
                const next = nextOf(item);
                const status: { tone: StatusTone; text: string } =
                  state === 'offered'
                    ? late
                      ? { tone: 'warning', text: 'Running out' }
                      : { tone: 'info', text: `Offered · ${clockOf(offer.offeredAt)}` }
                    : state === 'accepted'
                      ? { tone: 'success', text: 'Accepted' }
                      : state === 'passed'
                        ? { tone: 'neutral', text: 'Passed' }
                        : { tone: 'neutral', text: 'Ran out' };
                const called = calls[item.id];
                return (
                  <tr key={`${item.id}-${offer.id}`} data-late={late || undefined}>
                    <td>
                      <span className="wl-activity">
                        <b>{item.offering?.name ?? 'Activity'}</b>
                        <span className="caption">
                          {item.offering?.startsOn
                            ? `Starts ${shortDate(item.offering.startsOn)} · `
                            : ''}
                          {offer.quantity} place{offer.quantity === 1 ? '' : 's'}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="wl-who">
                        <Avatar
                          name={nameOf(item.participantPersonId)}
                          personKey={item.participantPersonId}
                          size={30}
                          decorative
                        />
                        <span className="wl-who-text">
                          <b>{nameOf(item.participantPersonId)}</b>
                          <span className="caption">
                            {item.payerPersonId && people.get(item.payerPersonId)
                              ? `by ${nameOf(item.payerPersonId)}`
                              : `${item.offerCount} offer${item.offerCount === 1 ? '' : 's'}`}
                            {called ? ` · Called ${clockOf(called)}` : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="tri-chip" data-tone={status.tone}>
                        <span aria-hidden="true">{STATUS_GLYPHS[status.tone]}</span> {status.text}
                      </span>
                    </td>
                    <td>
                      {state === 'offered' ? (
                        <span className="wl-left" data-late={late || undefined}>
                          <b>{timeLeftLabel(offer.expiresAt, now)}</b>
                          <span
                            className="wl-bar"
                            role="img"
                            aria-label={`${Math.round(shareLeft(offer.offeredAt, offer.expiresAt, now) * 100)}% of the time left`}
                          >
                            <i
                              style={{
                                width: `${shareLeft(offer.offeredAt, offer.expiresAt, now) * 100}%`,
                              }}
                            />
                          </span>
                        </span>
                      ) : state === 'accepted' && offer.acceptedAt ? (
                        <span className="caption">Done {clockOf(offer.acceptedAt)}</span>
                      ) : (
                        <span className="caption">
                          {state === 'passed' ? 'Passed' : 'Ran out'}{' '}
                          {clockOf(offer.declinedAt ?? offer.expiredAt ?? offer.expiresAt)}
                        </span>
                      )}
                    </td>
                    <td>
                      {state === 'accepted'
                        ? '—'
                        : next
                          ? nameOf(next.participantPersonId)
                          : 'Nobody waiting'}
                    </td>
                    <td className="wl-actions">
                      {state === 'offered' ? (
                        <>
                          {late ? (
                            <Button className="button-sm" onClick={() => setCalling(item)}>
                              Call family
                            </Button>
                          ) : null}
                          <span className="wl-menu">
                            <Button
                              variant="secondary"
                              className="button-sm"
                              aria-expanded={extendFor === item.id}
                              onClick={() => setExtendFor(extendFor === item.id ? null : item.id)}
                            >
                              Extend
                            </Button>
                            {extendFor === item.id ? (
                              <span
                                className="wl-menu-list"
                                role="menu"
                                aria-label="Extend the offer"
                              >
                                <button type="button" role="menuitem" disabled>
                                  +12 h
                                </button>
                                <button type="button" role="menuitem" disabled>
                                  +24 h
                                </button>
                                <span className="proposed-tag">
                                  ◷ Pending decision DEC-006: offer expiry is not changeable yet
                                </span>
                              </span>
                            ) : null}
                          </span>
                          {!late ? (
                            <Button
                              variant="secondary"
                              className="button-sm"
                              disabled={!online}
                              onClick={() => setWithdrawing(item)}
                            >
                              Withdraw
                            </Button>
                          ) : null}
                        </>
                      ) : state !== 'accepted' && next ? (
                        <Button
                          className="button-sm"
                          busy={busy === item.id}
                          disabled={!online}
                          onClick={() => void offerNext(row)}
                        >
                          Offer to next
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <div className="wl-cards">
        <section className="card wl-setting" aria-labelledby="auto-offer-title">
          <span className="wl-icon" aria-hidden="true">
            <Icon name="autorenew" size={22} />
          </span>
          <span className="wl-setting-text">
            <b id="auto-offer-title">Offer the next family by itself</b>
            <span className="caption">
              When an offer is passed or runs out, send it to #2 with the same 24 h window.
            </span>
            <span className="proposed-tag">◷ Proposed · pending decision 4 · admins set it</span>
          </span>
          <span
            className="wl-switch"
            role="switch"
            aria-checked="false"
            aria-disabled="true"
            aria-labelledby="auto-offer-title"
          >
            <i />
          </span>
        </section>
        <section className="card wl-setting" aria-labelledby="median-title">
          <span className="wl-icon" data-tone="info" aria-hidden="true">
            <Icon name="trending_up" size={22} />
          </span>
          <span className="wl-setting-text">
            <b id="median-title">
              Median time to accept:{' '}
              {stats.median === null ? 'not enough offers yet' : duration(stats.median)}
            </b>
            <span className="caption">
              {stats.settled > 0
                ? `${stats.accepted}% of the offers listed accepted · ${stats.passed}% passed · ${stats.ranOut}% ran out`
                : 'From the offers settled and listed here.'}
            </span>
          </span>
        </section>
      </div>
      {calling ? (
        <CallDialog
          item={calling}
          name={nameOf(calling.participantPersonId)}
          onClose={() => setCalling(null)}
          onLogged={() => logCall(calling)}
        />
      ) : null}
      {withdrawing ? (
        <Dialog
          labelledBy="withdraw-title"
          onClose={() => setWithdrawing(null)}
          locked={busy === withdrawing.id}
          width={460}
          header={<h3 id="withdraw-title">Withdraw this offer?</h3>}
          footer={
            <>
              <Button variant="secondary" onClick={() => setWithdrawing(null)}>
                Keep it
              </Button>
              <Button
                className="button-danger"
                busy={busy === withdrawing.id}
                onClick={() => void withdraw(withdrawing)}
              >
                Withdraw offer
              </Button>
            </>
          }
        >
          <p>
            The offer to {nameOf(withdrawing.participantPersonId)} ends now and{' '}
            {nameOf(withdrawing.participantPersonId)} leaves the waitlist of{' '}
            {withdrawing.offering?.name ?? 'this activity'}. The place goes back and the next family
            in line is offered it.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function CallDialog({
  item,
  name,
  onClose,
  onLogged,
}: {
  item: Item;
  name: string;
  onClose: () => void;
  onLogged: () => void;
}) {
  const who = item.payerPersonId ?? item.participantPersonId;
  const read = useApiQuery({ path: '/people/{id}', request: { path: { id: who } } });
  const person = read.data;
  const phone =
    person?.contactPoints.find((c) => c.kind === 'phone' && c.isPrimary) ??
    person?.contactPoints.find((c) => c.kind === 'phone');
  return (
    <Dialog
      labelledBy="call-title"
      onClose={onClose}
      width={420}
      header={<h3 id="call-title">Call about {name}’s place</h3>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onLogged}>Log the call</Button>
        </>
      }
    >
      {read.error ? (
        <p>The phone number could not be read. Open the family’s record to find it.</p>
      ) : !person ? (
        <p className="caption">Finding the number…</p>
      ) : phone ? (
        <p className="wl-phone">
          {person.givenName} {person.familyName}: <a href={`tel:${phone.value}`}>{phone.value}</a>
        </p>
      ) : (
        <p>No phone number is on record for {person.givenName}.</p>
      )}
      <span className="proposed-tag">◷ Proposed: the call note is kept on this device only</span>
    </Dialog>
  );
}
