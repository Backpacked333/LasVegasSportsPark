/**
 * SCR-S-53 Memberships, one member (SPK-COND-001, ENR-12, SPK-REG-010): the membership enrollment
 * (`GET /v1/enrollments/{id}`, intent `membership`; another record or one the viewer may not see
 * reads "not available", §4.10) with what it includes as its definition states it, and:
 *
 * - Suspend for a period (`POST /v1/enrollments/{id}/membership-suspensions`: start required, end
 *   optional, reason required; times entered in the facility's zone, SPK-SCHED-008) and end a
 *   suspension (`POST /v1/membership-suspensions/{id}/end` with its `expectedRevision`). Never
 *   gated by the switch. An overlapping period answers RESOURCE_CONFLICT `SUSPENSION_OVERLAP`.
 * - Book a session the membership includes (`POST /v1/session-bookings` with
 *   `membershipEnrollmentId`); the API decides term, suspension and the period's limit.
 * - Renew (`POST /v1/enrollments/{id}/renew`): the chosen membership offering (none preselected) is
 *   added to a basket; nothing is charged until checkout, which continues in assisted registration
 *   where an unknown payment outcome is recovered, never shown as paid.
 * - Sessions booked with the membership: the member's session bookings
 *   (`GET /v1/session-bookings?participantPersonId=`, `enrollment.read_session_booking`) that name
 *   this membership, each in its own offering's facility zone, with what a cancellation did with
 *   the session. The client lists them and counts nothing against the period's limit; the API
 *   applies the limit when a session is booked (MEMBERSHIP_SESSIONS_USED).
 * - Cancel or transfer: SCR-S-27, with its previewed consequence.
 *
 * The API has no staff read of a membership's term dates, its usage per period or earlier
 * suspensions (only the customer's `GET /v1/me/memberships`), so this page lists the suspensions
 * recorded here and says what it cannot show. Renewal and bookings need the `memberships` switch
 * (DEC-016, DEC-072); member pricing is not built (POL-038, DEC-007).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import {
  emptyLocal,
  LocalDateTimeField,
  toInstant,
  type LocalDateTime,
} from '../../../features/schedule-facilities/LocalDateTimeField';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { CommandSuccess } from '../../../ui/CommandFeedback';
import { Facts, SelectField, TextAreaField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { isUuid } from '../../../ui/RecordRef';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { BookCoveredSession } from '../participation/BookCoveredSession';
import { CommandProblem, validationPath } from '../participation/CommandProblem';
import { membershipBenefit } from '../participation/definition';
import { DefinitionBody } from '../participation/DefinitionView';
import { formatInstant, formatMoney, formatRange } from '../participation/format';
import { OfferingName, PersonNameView } from '../participation/names';
import {
  ACTIONS,
  NotAvailableToYou,
  useActionAllowed,
  useCapabilityOn,
} from '../participation/permission';
import { CREDIT_DISPOSITION } from '../session-packages/labels';
import { ENROLLMENT_STATUS, SESSION_BOOKING_STATUS, SUSPENSION_STATUS } from './labels';

type Enrollment = Schema<'Enrollment'>;
type Suspension = Schema<'MembershipSuspension'>;
type SessionBooking = Schema<'SessionBooking'>;

const ENROLLMENT_KEY = ['api', '/enrollments/{id}'] as const;

function EndSuspension({
  suspension,
  zone,
  onEnded,
}: {
  suspension: Suspension;
  zone: string | null;
  onEnded: (ended: Suspension) => void;
}) {
  const { online } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const end = useApiCommand('post', '/membership-suspensions/{id}/end');
  const label = `the suspension from ${formatInstant(suspension.from, zone)}`;
  if (suspension.status !== 'active') return null;
  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={!online}
        aria-label={`End ${label}`}
        onClick={() => setOpen(true)}
      >
        End suspension…
      </Button>
    );
  }
  const send = () =>
    void end
      .submit({
        path: { id: suspension.id },
        body: { reason: reason.trim(), expectedRevision: suspension.revision },
      })
      .then((ended) => {
        setOpen(false);
        onEnded(ended);
      })
      .catch(() => undefined);
  return (
    <form
      className="pg-form"
      noValidate
      aria-label={`End ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required; it is audited.');
          return;
        }
        setReasonError(null);
        send();
      }}
    >
      <TextAreaField
        label="Reason for ending the suspension"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
        maxLength={2000}
      />
      <div className="pg-actions">
        <Button type="submit" busy={end.isProcessing} disabled={!online}>
          End the suspension
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandProblem error={end.error} onRetry={send} />
    </form>
  );
}

function Suspensions({ enrollment, zone }: { enrollment: Enrollment; zone: string | null }) {
  const { online } = useApp();
  const [recorded, setRecorded] = useState<Suspension[]>([]);
  const [from, setFrom] = useState<LocalDateTime>(emptyLocal());
  const [until, setUntil] = useState<LocalDateTime>(emptyLocal());
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const suspend = useApiCommand('post', '/enrollments/{id}/membership-suspensions');
  const allowed = useActionAllowed(ACTIONS.manageSuspension, enrollment.offering?.facilityId);
  const shownZone = zone ?? 'UTC';
  if (!allowed) {
    return <NotAvailableToYou what="Suspending memberships" action={ACTIONS.manageSuspension} />;
  }
  const upsert = (s: Suspension) =>
    setRecorded((list) => [...list.filter((x) => x.id !== s.id), s]);
  const serverPath = validationPath(suspend.error);
  const submit = () => {
    setAttempted(true);
    const errors: Record<string, string> = {};
    const start = toInstant(from, shownZone);
    const end = until.date || until.time ? toInstant(until, shownZone) : null;
    // The date fields show their own problems (missing, nonexistent or repeated local times).
    if (!start.ok) errors.from = start.message;
    if (end && !end.ok) errors.untilField = end.message;
    if (start.ok && end?.ok && Date.parse(end.instant) <= Date.parse(start.instant)) {
      errors.until = 'The suspension ends after it starts.';
    }
    if (!reason.trim()) errors.reason = 'A reason is required; it is audited.';
    setLocal(errors);
    if (Object.keys(errors).length > 0 || !start.ok) return;
    void suspend
      .submit({
        path: { id: enrollment.id },
        body: {
          from: start.instant,
          ...(end?.ok ? { until: end.instant } : {}),
          reason: reason.trim(),
        },
      })
      .then((created) => {
        upsert(created);
        setFrom(emptyLocal());
        setUntil(emptyLocal());
        setReason('');
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <>
      <p className="caption">
        Suspensions recorded before this page was opened cannot be listed here: the API has no staff
        read of a membership&apos;s suspensions.
      </p>
      {recorded.length > 0 ? (
        <ul className="list" aria-label="Suspensions recorded here">
          {recorded.map((s) => (
            <li key={s.id}>
              <div className="row-text">
                <span>
                  <StatusBadge {...SUSPENSION_STATUS[s.status]} /> From{' '}
                  {formatInstant(s.from, zone)}
                  {s.until ? ` until ${formatInstant(s.until, zone)}` : ' until ended'}
                </span>
                <span className="caption">
                  {s.reason}
                  {s.endedAt
                    ? `. Ended ${formatInstant(s.endedAt, zone)}: ${s.endedReason ?? ''}`
                    : ''}
                </span>
              </div>
              <EndSuspension suspension={s} zone={zone} onEnded={upsert} />
            </li>
          ))}
        </ul>
      ) : null}
      {enrollment.status === 'confirmed' ? (
        <form
          className="pg-form"
          noValidate
          aria-label="Suspend the membership"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {zone ? null : (
            <p className="caption">
              The facility time zone is not known: times are entered in UTC.
            </p>
          )}
          <LocalDateTimeField
            label="Suspended from"
            value={from}
            onChange={setFrom}
            timeZone={shownZone}
            required
            showErrors={attempted}
          />
          <LocalDateTimeField
            label="Suspended until (optional; leave empty until ended)"
            value={until}
            onChange={setUntil}
            timeZone={shownZone}
            // Optional, but once either part is filled both are needed: say so after a submit.
            showErrors={attempted && (until.date !== '' || until.time !== '')}
          />
          {local.until || serverPath === 'until' ? (
            <p className="error-text">{local.until ?? suspend.error?.message}</p>
          ) : null}
          <TextAreaField
            label="Reason for suspending"
            required
            value={reason}
            onChange={setReason}
            error={local.reason ?? null}
            maxLength={2000}
          />
          <div className="pg-actions">
            <Button type="submit" busy={suspend.isProcessing} disabled={!online}>
              Suspend the membership
            </Button>
          </div>
          {!online ? <p className="caption">Suspending needs a connection.</p> : null}
          <CommandProblem error={suspend.error} onRetry={submit} />
        </form>
      ) : (
        <p>Only a confirmed membership can be suspended.</p>
      )}
    </>
  );
}

function BookedSession({ booking }: { booking: SessionBooking }) {
  // Each session in its own offering's facility zone (the membership may cover other facilities).
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: booking.offeringId } },
    staleTime: 5 * 60_000,
  });
  const status = SESSION_BOOKING_STATUS[booking.status];
  return (
    <li>
      <span className="row-text">
        <span>
          <StatusBadge tone={status.tone} label={status.label} />{' '}
          <OfferingName id={booking.offeringId} />:{' '}
          {formatRange(
            booking.scheduledStart,
            booking.scheduledEnd,
            offering.data?.facility.timezone ?? null,
          )}
        </span>
        {booking.creditDisposition ? (
          <span className="caption">{CREDIT_DISPOSITION[booking.creditDisposition]}</span>
        ) : null}
      </span>
    </li>
  );
}

function SessionsBooked({ enrollment }: { enrollment: Enrollment }) {
  const allowed = useActionAllowed(ACTIONS.readSessionBooking, enrollment.offering?.facilityId);
  const bookings = useApiQuery({
    path: '/session-bookings',
    request: { query: { participantPersonId: enrollment.participantPersonId } },
    enabled: allowed,
  });
  if (!allowed) {
    return (
      <NotAvailableToYou what="Reading session bookings" action={ACTIONS.readSessionBooking} />
    );
  }
  const own = (list: readonly SessionBooking[]) =>
    list.filter((b) => b.membershipEnrollmentId === enrollment.id);
  return (
    <QueryBoundary
      query={bookings}
      label="the sessions booked with this membership"
      isEmpty={(list) => own(list).length === 0}
      empty={{
        title: 'No session booked with this membership',
        description: 'Sessions booked with the membership are listed here.',
      }}
    >
      {(list) => (
        <ul className="list" aria-label="Sessions booked with this membership">
          {own(list).map((b) => (
            <BookedSession key={b.id} booking={b} />
          ))}
        </ul>
      )}
    </QueryBoundary>
  );
}

function Renewal({ enrollment, onDone }: { enrollment: Enrollment; onDone: (m: string) => void }) {
  const { online } = useApp();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const renew = useApiCommand('post', '/enrollments/{id}/renew');
  const offerings = useApiQuery({
    path: '/offerings',
    request: { query: { kind: 'membership', view: 'staff', limit: 200 } },
  });
  const allowed = useActionAllowed(ACTIONS.renewMembership, enrollment.offering?.facilityId);
  if (!allowed) {
    return <NotAvailableToYou what="Renewing memberships" action={ACTIONS.renewMembership} />;
  }
  if (enrollment.status !== 'confirmed') return <p>Only a confirmed membership can be renewed.</p>;
  const basket = renew.status === 'success' ? renew.data : undefined;
  if (basket) {
    return (
      <div role="group" aria-label="Renewal added">
        <p role="status">
          Renewal added to a basket. Nothing is charged until checkout; the renewal starts only when
          the checkout confirms payment.
        </p>
        <Link to={`/registrations/assisted/${basket.id}`}>
          Continue to checkout in assisted registration
        </Link>
      </div>
    );
  }
  const send = () => {
    if (!target) {
      setError('Choose the membership offering the renewal buys.');
      return;
    }
    setError(null);
    void renew
      .submit({ path: { id: enrollment.id }, body: { targetOfferingId: target } })
      .then(() => onDone('Renewal added to a basket'))
      .catch(() => undefined);
  };
  return (
    <form
      className="pg-form"
      noValidate
      aria-label="Renew the membership"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <QueryBoundary
        query={offerings}
        label="membership offerings"
        isEmpty={(p) => p.items.length === 0}
        empty={{ title: 'No membership offering', description: 'There is nothing to renew into.' }}
      >
        {(p) => (
          <SelectField
            label="Renew into"
            required
            value={target}
            onChange={setTarget}
            placeholder="Choose a membership offering"
            options={p.items.map((o) => ({
              value: o.id,
              label: `${o.name} (${o.publicationState})`,
            }))}
            error={
              error ??
              (validationPath(renew.error) === 'targetOfferingId' ? renew.error?.message : null)
            }
          />
        )}
      </QueryBoundary>
      <div className="pg-actions">
        <Button type="submit" busy={renew.isProcessing} disabled={!online}>
          Add the renewal to a basket
        </Button>
      </div>
      {!online ? <p className="caption">Renewing needs a connection.</p> : null}
      <CommandProblem error={renew.error} onRetry={send} />
    </form>
  );
}

function Detail({ enrollment }: { enrollment: Enrollment }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  const zone = enrollment.offering?.timezone ?? null;
  const capabilityOn = useCapabilityOn('memberships');
  const canBook = useActionAllowed(ACTIONS.bookSession, enrollment.offering?.facilityId);
  const definition = useApiQuery({
    path: '/entitlement-definitions/{id}',
    request: { path: { id: enrollment.entitlementDefinitionId ?? '' } },
    enabled: enrollment.entitlementDefinitionId !== null,
    staleTime: 5 * 60_000,
  });
  const benefit = definition.data ? membershipBenefit(definition.data.scope) : null;
  const badge = ENROLLMENT_STATUS[enrollment.status];
  return (
    <article aria-labelledby="member-title">
      <h3 id="member-title">
        <PersonNameView id={enrollment.participantPersonId} fallback="Member" />:{' '}
        {enrollment.offering?.name ?? 'Membership'}
      </h3>
      <CommandSuccess message={outcome} />
      <p>
        <StatusBadge tone={badge.tone} label={badge.label} />
      </p>
      <Facts
        label="Membership"
        items={[
          [
            'Member',
            <PersonNameView key="m" id={enrollment.participantPersonId} fallback="Member" />,
          ],
          [
            'Payer',
            enrollment.payerPersonId ? (
              <PersonNameView key="p" id={enrollment.payerPersonId} fallback="Payer" />
            ) : (
              'None'
            ),
          ],
          ['Confirmed', formatInstant(enrollment.confirmedAt, zone)],
          [
            'Price recorded',
            enrollment.price
              ? formatMoney(enrollment.price.basePriceMinor, enrollment.price.currency)
              : 'Not priced',
          ],
          [
            'Registered by',
            `${enrollment.registeredBy.actorLabel} (${enrollment.registeredBy.kind})`,
          ],
          ['Time zone', zone ?? 'Not known: times are shown in UTC'],
          ['Revision', String(enrollment.revision)],
        ]}
      />
      <p className="caption">
        The term dates, the count used against each period&apos;s limit and earlier suspensions are
        not readable from the staff API (only the customer&apos;s own view has them), so they are
        not shown here; the sessions booked with the membership are listed below.
      </p>
      <section className="pg-panel" aria-labelledby="member-includes">
        <h4 id="member-includes">What it includes</h4>
        {enrollment.entitlementDefinitionId === null ? (
          <p>The membership names no definition, so what it includes is not stated.</p>
        ) : (
          <QueryBoundary
            query={definition}
            label="what the membership includes"
            empty={{ title: '', description: '' }}
          >
            {(d) => <DefinitionBody definition={d} />}
          </QueryBoundary>
        )}
        {benefit &&
        benefit.attendance.mode !== 'none' &&
        enrollment.status === 'confirmed' &&
        capabilityOn &&
        canBook ? (
          <BookCoveredSession
            label="Book an included session"
            appliesTo={benefit.attendance.appliesTo}
            participantPersonId={enrollment.participantPersonId}
            basis={{ membershipEnrollmentId: enrollment.id }}
            onBooked={(b) => setOutcome(`Included session booked (${b.status})`)}
            onReload={() => void queryClient.invalidateQueries({ queryKey: ENROLLMENT_KEY })}
          />
        ) : null}
      </section>
      <section className="pg-panel" aria-labelledby="member-sessions">
        <h4 id="member-sessions">Sessions booked with the membership</h4>
        <SessionsBooked enrollment={enrollment} />
      </section>
      <section className="pg-panel" aria-labelledby="member-suspensions">
        <h4 id="member-suspensions">Suspensions</h4>
        <Suspensions enrollment={enrollment} zone={zone} />
      </section>
      <section className="pg-panel" aria-labelledby="member-renewal">
        <h4 id="member-renewal">Renewal</h4>
        {capabilityOn ? (
          <Renewal enrollment={enrollment} onDone={setOutcome} />
        ) : (
          <p>Renewals are not taken while memberships are turned off.</p>
        )}
      </section>
      <section className="pg-panel" aria-labelledby="member-cancel">
        <h4 id="member-cancel">Cancel or transfer</h4>
        <p>
          Canceling shows its financial consequence first and needs the customer&apos;s acceptance:{' '}
          <Link to={`/registrations/enrollments/${enrollment.id}`}>
            cancel or transfer this membership (SCR-S-27)
          </Link>
          .
        </p>
      </section>
    </article>
  );
}

export function MembershipDetail() {
  const { enrollmentId = '' } = useParams();
  const valid = isUuid(enrollmentId);
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId } },
    enabled: valid,
  });
  const back = <Link to="/finance/memberships">All memberships</Link>;
  if (!valid) {
    return (
      <>
        {back}
        <StateView variant="unavailable" title="Link not available" />
      </>
    );
  }
  return (
    <>
      {back}
      <QueryBoundary
        query={enrollment}
        label="the membership"
        empty={{ title: '', description: '' }}
        unavailableOffline={['suspending', 'renewing', 'booking']}
      >
        {(data) =>
          data.intent === 'membership' ? (
            <Detail enrollment={data} />
          ) : (
            <StateView
              variant="unavailable"
              title="Not a membership"
              description="This enrollment is not a membership."
            />
          )
        }
      </QueryBoundary>
    </>
  );
}
