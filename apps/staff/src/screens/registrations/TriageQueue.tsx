/**
 * Needs a decision (handoff S 1c, S 3f; INTERACTIONS 1c rows 2 to 5; SPK-REG-002, SPK-REG-003,
 * SPK-REG-007, SPK-REG-008, §4.9):
 *
 * - Every application waiting for a person: the API keeps a failed evaluation in `submitted` and an
 *   eligible one that needs approval in `awaiting_review` (`GET /v1/applications`, keyset pages,
 *   each state in the API's order, failed evaluations first, with "Load more").
 * - "Why it needs you" writes each reason as a plain sentence with its glyph badge.
 * - Rows are selected with the checkbox or X; selected rows that share one reason get the night
 *   bulk bar: "Approve 3" decides them in one go, each command audited on its own record.
 * - J and K move, A approves, O offers the named alternative, D declines (not while typing or in a
 *   dialog). On a tablet the rail opens as a sheet.
 * - Approve is optimistic: the row leaves at once and a toast offers Undo for 5 s; the commands are
 *   sent once the window closes, so the family is told after it (an approval cannot be taken back
 *   in the API). A failure brings the row back and says what did not save, with Try again. An
 *   eligibility failure is approved as an exception: the override (with the reason) and the
 *   acceptance are two audited commands, each with the revision it saw.
 * - Over capacity (the offering's places are all taken): "Approve and over-fill by 1" raises the
 *   offering's capacity by one (`POST /v1/capacity-pools/{id}/adjust`, audited, with the reason)
 *   before accepting; "Waitlist" puts the participant on the waitlist (`POST /v1/waitlist-entries`)
 *   and declines the application with that reason.
 * - Decline asks for a reason the family sees (S 3f); the declines go after the same 5 s window.
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { asApiError, useIntentSend } from '../../api/useIntentSend';
import { useMediaQuery } from '../../layout/useMediaQuery';
import { useApi, useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { LoadMore } from '../../ui/LoadMore';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StateView } from '../../ui/StateView';
import { STATUS_GLYPHS } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import {
  DeclineDialog,
  type Alternative,
  type DeclineChoice,
  type DeclineTarget,
} from './DeclineDialog';
import { personName, useAvailability, useOfferings, usePeople } from './triage-data';
import {
  ageLabel,
  chipsOf,
  needsOverride,
  sharedReason,
  sharedWords,
  shortDate,
  waitingLabel,
  type DeclineReason,
  type ReasonChip,
} from './triage-model';
import { TriageRail } from './TriageRail';

type Application = Schema<'Application'>;
type Offering = Schema<'Offering'>;

export const QUEUE_INVALIDATE: readonly (readonly unknown[])[] = [
  ['api', '/applications'],
  ['api', '/offering-availability'],
  ['api', '/capacity-pools'],
  ['api', '/waitlist-entries'],
  ['api', '/waitlist-queue'],
];

type Plan = 'approve' | 'overfill' | 'waitlist';

interface DeclineState {
  targets: Application[];
  reason: DeclineReason;
}

/** Typing in a field or working in a dialog: the queue's keys stay out of the way. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[role="dialog"]')) return true;
  if (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return (
    target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type)
  );
}

export function useDecisionPages() {
  const submitted = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'submitted' } },
  });
  const awaiting = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'awaiting_review' } },
  });
  return { submitted, awaiting };
}

export function TriageQueue() {
  const { online } = useApp();
  const api = useApi();
  const now = useNow();
  const toast = useToast();
  const permissions = usePermissions();
  // Narrow (a phone, or a tablet in portrait): the rail opens over the page.
  const wide = !useMediaQuery('(max-width: 1099px)');
  const { submitted, awaiting } = useDecisionPages();
  const { send } = useIntentSend(QUEUE_INVALIDATE);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [decline, setDecline] = useState<DeclineState | null>(null);
  const [full, setFull] = useState<Application[] | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const all = useMemo(
    () => [...(submitted.data ?? []), ...(awaiting.data ?? [])],
    [submitted.data, awaiting.data],
  );
  const list = all.filter((a) => !hidden.has(a.id));
  const people = usePeople(all.map((a) => a.participantPersonId));
  // Each application's offering, and the alternatives the API names (offered on decline).
  const offeringIds = [
    ...all.map((a) => a.offeringId),
    ...all.flatMap((a) =>
      (a.eligibility?.alternatives ?? [])
        .map((x) => x.offeringId)
        .filter((id): id is string => !!id),
    ),
  ];
  const offerings = useOfferings(offeringIds);
  const places = useAvailability(offeringIds);
  const today = now.toISOString().slice(0, 10);
  const nameOf = (a: Application) => personName(people.get(a.participantPersonId)) ?? 'Participant';
  const chipsFor = (a: Application): ReasonChip[] => {
    const p = people.get(a.participantPersonId);
    return chipsOf(
      a,
      p ? { givenName: p.givenName, dateOfBirth: p.dateOfBirth } : null,
      offerings.get(a.offeringId)?.name ?? null,
    );
  };
  const alternativeOf = (a: Application): Alternative | null => {
    const alt = a.eligibility?.alternatives.find(
      (x) => x.kind === 'other_offering' && x.offeringId,
    );
    if (!alt?.offeringId) return null;
    const offering = offerings.get(alt.offeringId);
    const left = places.get(alt.offeringId)?.remaining ?? null;
    return offering ? { offeringId: alt.offeringId, name: offering.name, placesLeft: left } : null;
  };
  const mayDecide = (a: Application) => {
    const facility = offerings.get(a.offeringId)?.facilityId;
    return permissions.isPermitted('enrollment.review_application', facility) !== false;
  };
  const isFull = (a: Application) => {
    const p = places.get(a.offeringId);
    return !!p && (p.status === 'full' || (p.remaining !== null && p.remaining <= 0));
  };

  const focused = list.find((a) => a.id === focusId) ?? list[0] ?? null;
  const picked = list.filter((a) => selected.has(a.id));
  const shared = sharedReason(picked.map(chipsFor));

  const hide = (ids: readonly string[], on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** The commands of one approval, after the undo window. */
  const commit = useCallback(
    async (targets: readonly Application[], plan: Plan): Promise<void> => {
      for (const a of targets) {
        try {
          let revision = a.revision;
          const label = nameOf(a);
          if (plan === 'waitlist') {
            await send(`waitlist:${a.id}`, 'post', '/waitlist-entries', {
              body: {
                offeringId: a.offeringId,
                participantPersonId: a.participantPersonId,
                intent: a.intent,
                preferences: {},
              },
            });
            await send(`decline-full:${a.id}`, 'post', '/applications/{id}/decline', {
              path: { id: a.id },
              body: {
                expectedRevision: revision,
                reason: `The activity is full. ${label} is on the waitlist and will be offered the next place.`,
              },
            });
            continue;
          }
          if (needsOverride(a)) {
            const chip = chipsFor(a)[0];
            const overridden = await send(
              `override:${a.id}`,
              'post',
              '/applications/{id}/override-eligibility',
              {
                path: { id: a.id },
                body: {
                  expectedRevision: revision,
                  reason: `Approved as an exception: ${chip ? sharedWords(chip) : 'eligibility'} (${chip?.text ?? ''}).`,
                },
              },
              { refresh: false },
            );
            revision = overridden.revision;
          }
          if (plan === 'overfill') {
            const pools = await api.get('/capacity-pools', { query: { offeringId: a.offeringId } });
            const pool = pools.find((p) => p.scopeType === 'offering') ?? pools[0];
            if (pool) {
              await send(`overfill:${a.id}`, 'post', '/capacity-pools/{id}/adjust', {
                path: { id: pool.id },
                body: {
                  capacity: pool.capacity + 1,
                  expectedRevision: pool.revision,
                  reason: `Over-filled by 1 to approve ${label}.`,
                },
              });
            }
          }
          await send(`accept:${a.id}`, 'post', '/applications/{id}/accept', {
            path: { id: a.id },
            body: { expectedRevision: revision },
          });
        } catch (cause) {
          hide([a.id], false);
          toast.show({
            tone: 'error',
            message: `${nameOf(a)} was not approved: ${asApiError(cause).message}`,
            action: { label: 'Try again', onClick: () => void commit([a], plan) },
          });
        }
      }
    },
    // nameOf and chipsFor read the latest people and offerings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, send, toast, people, offerings],
  );

  const approve = (targets: readonly Application[], plan: Plan = 'approve') => {
    if (targets.length === 0 || !online) return;
    if (plan === 'approve' && targets.some(isFull)) {
      setFull([...targets]);
      return;
    }
    const ids = targets.map((a) => a.id);
    hide(ids, true);
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    const who = targets.length === 1 ? nameOf(targets[0]!) : `${targets.length} applications`;
    const verb =
      plan === 'waitlist'
        ? 'Waitlisted'
        : plan === 'overfill'
          ? 'Approved (over-filled by 1)'
          : 'Approved';
    toast.show({
      tone: 'success',
      message: `${verb} ${who}. ${targets.length === 1 ? 'The family is' : 'Families are'} told after 5 s.`,
      onUndo: () => hide(ids, false),
      onClose: (reason) => {
        if (reason !== 'undo') void commit(targets, plan);
      },
    });
  };

  const sendDeclines = (targets: readonly Application[], choice: DeclineChoice) => {
    const ids = targets.map((a) => a.id);
    hide(ids, true);
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    setDecline(null);
    toast.show({
      tone: 'neutral',
      message: `Declined ${targets.length === 1 ? nameOf(targets[0]!) : `${targets.length} applications`}. ${targets.length === 1 ? 'The family is' : 'Families are'} told after 5 s.`,
      onUndo: () => hide(ids, false),
      onClose: (reason) => {
        if (reason === 'undo') return;
        for (const a of targets) {
          void send(`decline:${a.id}`, 'post', '/applications/{id}/decline', {
            path: { id: a.id },
            body: { expectedRevision: a.revision, reason: choice.messages.get(a.id) ?? 'Declined' },
          }).catch((cause: unknown) => {
            hide([a.id], false);
            toast.show({
              tone: 'error',
              message: `${nameOf(a)} was not declined: ${asApiError(cause).message}`,
            });
          });
        }
      },
    });
  };

  const openDecline = (targets: readonly Application[], withAlternative = false) => {
    if (targets.length === 0 || !online) return;
    const chip = chipsFor(targets[0]!)[0];
    const reason: DeclineReason =
      chip?.code === 'below_minimum_age' || chip?.code === 'above_maximum_age' ? 'age' : 'level';
    setDecline({ targets: [...targets], reason: withAlternative ? 'level' : reason });
  };

  // Keyboard: J/K move, X select, A approve, O offer, D decline.
  const stateRef = useRef({ list, focused, picked, shared });
  stateRef.current = { list, focused, picked, shared };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (decline || full) return;
      const { list: rows, focused: f, picked: sel, shared: same } = stateRef.current;
      const key = e.key.toLowerCase();
      const index = f ? rows.findIndex((a) => a.id === f.id) : -1;
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))];
        if (next) {
          setFocusId(next.id);
          tableRef.current
            ?.querySelector<HTMLElement>(`[data-row="${next.id}"]`)
            ?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if (key === 'x' && f) {
        e.preventDefault();
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(f.id)) n.delete(f.id);
          else n.add(f.id);
          return n;
        });
      } else if (key === 'a') {
        e.preventDefault();
        if (sel.length > 0) {
          if (same && sel.every(mayDecide)) approve(sel);
        } else if (f && mayDecide(f)) approve([f]);
      } else if (key === 'o' && f && alternativeOf(f)) {
        e.preventDefault();
        openDecline([f], true);
      } else if (key === 'd') {
        e.preventDefault();
        if (sel.length > 0) openDecline(sel);
        else if (f) openDecline([f]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const loading = !submitted.data && !awaiting.data && !submitted.error && !awaiting.error;
  const error = submitted.error ?? awaiting.error;

  const rail = focused ? (
    <TriageRail
      key={focused.id}
      application={focused}
      person={people.get(focused.participantPersonId)}
      offering={offerings.get(focused.offeringId)}
      chips={chipsFor(focused)}
      alternative={alternativeOf(focused)}
      mayDecide={mayDecide(focused)}
      online={online}
      onApprove={() => approve([focused])}
      onOffer={() => openDecline([focused], true)}
      onDecline={() => openDecline([focused])}
    />
  ) : null;

  return (
    <div className="tri">
      <section className="card card-flush tri-main" aria-label="Applications needing a decision">
        {picked.length > 0 ? (
          <div className="tri-bulk" role="region" aria-label="Selected applications">
            <span className="tri-bulk-count">
              <span className="tri-check" data-on aria-hidden="true">
                ✓
              </span>
              {picked.length} selected
            </span>
            <span className="tri-bulk-why">
              {shared ? `· same reason: ${sharedWords(shared)}` : '· different reasons'}
            </span>
            <span className="tri-bulk-gap" />
            {shared ? (
              <Button
                className="tri-bulk-approve"
                disabled={!online || !picked.every(mayDecide)}
                onClick={() => approve(picked)}
              >
                Approve {picked.length}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              className="tri-bulk-other"
              disabled={!online || !picked.every(mayDecide)}
              onClick={() => openDecline(picked)}
            >
              Decline…
            </Button>
          </div>
        ) : null}
        {loading ? (
          <SkeletonGroup label="applications" className="tri-loading">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={52} radius={12} />
            ))}
          </SkeletonGroup>
        ) : error && list.length === 0 ? (
          <StateView variant="error" error={error} onRetry={() => void submitted.refetch()} />
        ) : list.length === 0 ? (
          <StateView
            variant="empty"
            title="Queue clear"
            description="No application is waiting for a decision."
          />
        ) : (
          <table className="tri-table" ref={tableRef}>
            <thead>
              <tr>
                <th scope="col" className="tri-col-check">
                  <span className="visually-hidden">Select</span>
                </th>
                <th scope="col">Participant</th>
                <th scope="col">Activity</th>
                <th scope="col">Why it needs you</th>
                <th scope="col" className="tri-col-wait">
                  Waiting
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const p = people.get(a.participantPersonId);
                const o: Offering | undefined = offerings.get(a.offeringId);
                const pl = places.get(a.offeringId);
                const name = nameOf(a);
                const chips = chipsFor(a);
                const isFocused = focused?.id === a.id;
                const age = ageLabel(p?.dateOfBirth, today);
                return (
                  <tr
                    key={a.id}
                    data-row={a.id}
                    data-focused={isFocused || undefined}
                    data-selected={selected.has(a.id) || undefined}
                    onClick={() => {
                      setFocusId(a.id);
                      if (!wide) setSheet(true);
                    }}
                  >
                    <td className="tri-col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={selected.has(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(a.id)) n.delete(a.id);
                            else n.add(a.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="tri-who"
                        aria-current={isFocused || undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusId(a.id);
                          if (!wide) setSheet(true);
                        }}
                      >
                        <Avatar
                          name={name}
                          personKey={a.participantPersonId}
                          size={32}
                          decorative
                        />
                        <span className="tri-who-text">
                          <b>{name}</b>
                          <span className="caption">{age ?? 'Age not on record'}</span>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className="tri-activity">
                        <b>{o?.name ?? 'Activity'}</b>
                        <span className="caption">
                          {o?.startsOn ? `Starts ${shortDate(o.startsOn)}` : ''}
                          {pl && pl.capacity !== null && pl.remaining !== null
                            ? `${o?.startsOn ? ' · ' : ''}${pl.capacity - pl.remaining} / ${pl.capacity}`
                            : ''}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="tri-chips">
                        {chips.map((c) => (
                          <span key={c.code + c.text} className="tri-chip" data-tone={c.tone}>
                            <span aria-hidden="true">{STATUS_GLYPHS[c.tone]}</span> {c.text}
                          </span>
                        ))}
                        {isFull(a) ? (
                          <span className="tri-chip" data-tone="neutral">
                            <span aria-hidden="true">{STATUS_GLYPHS.neutral}</span> Full
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="tri-col-wait">{waitingLabel(a.submittedAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <LoadMore pages={submitted} label="applications that failed eligibility" />
        <LoadMore pages={awaiting} label="applications awaiting review" />
        <div className="tri-keys" aria-label="Keyboard shortcuts">
          <span>
            <kbd>J</kbd>
            <kbd>K</kbd> move
          </span>
          <span>
            <kbd>X</kbd> select
          </span>
          <span>
            <kbd>A</kbd> approve
          </span>
          <span>
            <kbd>O</kbd> offer another
          </span>
          <span>
            <kbd>D</kbd> decline
          </span>
        </div>
      </section>
      {wide ? rail : null}
      {!wide && sheet && rail ? (
        <BottomSheet
          open
          onClose={() => setSheet(false)}
          title="Decision"
          titleId="tri-sheet-title"
          testId="decision-sheet"
        >
          {rail}
        </BottomSheet>
      ) : null}
      {decline ? (
        <DeclineDialog
          targets={decline.targets.map((a): DeclineTarget => ({
            applicationId: a.id,
            personId: a.participantPersonId,
            name: nameOf(a),
            givenName: people.get(a.participantPersonId)?.givenName ?? 'Your child',
            offeringName: offerings.get(a.offeringId)?.name ?? 'This activity',
          }))}
          alternative={alternativeOf(decline.targets[0]!)}
          initialReason={decline.reason}
          onCancel={() => setDecline(null)}
          onSend={(choice) => sendDeclines(decline.targets, choice)}
        />
      ) : null}
      {full ? (
        <Dialog
          labelledBy="full-title"
          onClose={() => setFull(null)}
          width={460}
          header={
            <h3 id="full-title">
              {offerings.get(full[0]!.offeringId)?.name ?? 'This activity'} is full
            </h3>
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setFull(null)}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const t = full;
                  setFull(null);
                  approve(t, 'waitlist');
                }}
              >
                Waitlist
              </Button>
              <Button
                onClick={() => {
                  const t = full;
                  setFull(null);
                  approve(t, 'overfill');
                }}
              >
                Approve and over-fill by {full.length}
              </Button>
            </>
          }
        >
          <p>
            Every place is taken. Over-filling raises the capacity by {full.length} with your name
            and the reason; Waitlist puts {full.length === 1 ? nameOf(full[0]!) : 'them'} next in
            line and tells the family.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
