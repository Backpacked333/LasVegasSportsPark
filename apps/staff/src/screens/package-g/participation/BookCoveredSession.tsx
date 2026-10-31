/**
 * Book a session a membership includes or a session package covers, for its participant
 * (SCR-S-53 included sessions, ENR-12, SPK-COND-001; SCR-S-54 redemption, ENR-11, SPK-COND-002,
 * SPK-AT-020): `POST /v1/session-bookings` with `membershipEnrollmentId` or `packageEntitlementId`,
 * one idempotency key per booking intent.
 *
 * Only the offerings the entitlement names are offered (its programs' offerings read with
 * `GET /v1/programs/{id}/offerings`), and only their upcoming scheduled sessions
 * (`GET /v1/offerings/{id}/sessions`) in the offering's facility zone (SPK-SCHED-008). The API
 * decides the rest in one transaction: a session not covered answers ELIGIBILITY_FAILED, the last
 * credit used by someone else meanwhile answers RESOURCE_CONFLICT `PACKAGE_CREDITS_EXHAUSTED`
 * (at most one redemption succeeds, SPK-AT-020), a used-up period `MEMBERSHIP_SESSIONS_USED`; each
 * is shown with its code and "Reload". New bookings need the capability on (DEC-072, DEC-074).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { useApp, useNow } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { CommandProblem } from './CommandProblem';
import type { AppliesTo } from './definition';
import { formatRange } from './format';
import { OfferingName } from './names';

type SessionBooking = Schema<'SessionBooking'>;

function ProgramOfferings({
  programId,
  chosen,
  onChoose,
}: {
  programId: string;
  chosen: string;
  onChoose: (id: string) => void;
}) {
  const offerings = useApiQuery({
    path: '/programs/{id}/offerings',
    request: { path: { id: programId }, query: { limit: 200 } },
    staleTime: 60_000,
  });
  return (
    <QueryBoundary
      query={offerings}
      label="the program's offerings"
      isEmpty={(p) => p.items.length === 0}
      empty={{ title: 'No offerings', description: 'The program has no offerings to book.' }}
    >
      {(p) => (
        <>
          {p.items.map((o) => (
            <label key={o.id} className="choice">
              <input
                type="radio"
                name="covered-offering"
                checked={chosen === o.id}
                onChange={() => onChoose(o.id)}
              />
              {o.name}
            </label>
          ))}
        </>
      )}
    </QueryBoundary>
  );
}

function Sessions({
  offeringId,
  chosen,
  onChoose,
}: {
  offeringId: string;
  chosen: string;
  onChoose: (id: string) => void;
}) {
  const now = useNow();
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    staleTime: 5 * 60_000,
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
  });
  const zone = offering.data?.facility.timezone ?? null;
  const upcoming = (list: Schema<'OfferingSession'>[]) =>
    list
      .filter((s) => s.status === 'scheduled' && Date.parse(s.scheduledStart) > now.getTime())
      .sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart));
  return (
    <QueryBoundary
      query={sessions}
      label="sessions"
      isEmpty={(list) => upcoming(list).length === 0}
      empty={{
        title: 'No upcoming sessions',
        description: 'This offering has no session to book.',
      }}
    >
      {(list) => (
        <fieldset className="field fieldset">
          <legend>
            Session<span className="field-required"> (required)</span>
          </legend>
          {upcoming(list).map((s) => (
            <label key={s.id} className="choice">
              <input
                type="radio"
                name="covered-session"
                checked={chosen === s.id}
                onChange={() => onChoose(s.id)}
              />
              {s.title ? `${s.title}: ` : ''}
              {formatRange(s.scheduledStart, s.scheduledEnd, zone)}
            </label>
          ))}
        </fieldset>
      )}
    </QueryBoundary>
  );
}

export function BookCoveredSession({
  appliesTo,
  participantPersonId,
  basis,
  label,
  onBooked,
  onReload,
}: {
  appliesTo: AppliesTo;
  participantPersonId: string;
  basis: { packageEntitlementId: string } | { membershipEnrollmentId: string };
  /** e.g. "Book a session with a credit". */
  label: string;
  onBooked: (booking: SessionBooking) => void;
  onReload: () => void;
}) {
  const { online } = useApp();
  const [open, setOpen] = useState(false);
  const [offeringId, setOfferingId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const book = useApiCommand('post', '/session-bookings', {
    invalidate: [
      ['api', '/package-entitlements'],
      ['api', '/session-bookings'],
    ],
  });
  if (!open) {
    return (
      <div className="pg-actions">
        <Button variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
          {label}…
        </Button>
      </div>
    );
  }
  const submit = () => {
    if (!offeringId || !sessionId) {
      setProblem('Choose an offering and one of its sessions.');
      return;
    }
    setProblem(null);
    void book
      .submit({ body: { offeringId, sessionId, participantPersonId, ...basis } })
      .then((done) => {
        setOpen(false);
        setOfferingId('');
        setSessionId('');
        onBooked(done);
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="pg-form pg-panel"
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="field fieldset">
        <legend>
          Offering<span className="field-required"> (required)</span>
        </legend>
        {appliesTo.offeringIds.map((id) => (
          <label key={id} className="choice">
            <input
              type="radio"
              name="covered-offering"
              checked={offeringId === id}
              onChange={() => {
                setOfferingId(id);
                setSessionId('');
              }}
            />
            <OfferingName id={id} />
          </label>
        ))}
        {appliesTo.programIds.map((programId) => (
          <ProgramOfferings
            key={programId}
            programId={programId}
            chosen={offeringId}
            onChoose={(id) => {
              setOfferingId(id);
              setSessionId('');
            }}
          />
        ))}
      </fieldset>
      {offeringId ? (
        <Sessions offeringId={offeringId} chosen={sessionId} onChoose={setSessionId} />
      ) : null}
      {problem ? <p className="error-text">{problem}</p> : null}
      <div className="pg-actions">
        <Button type="submit" busy={book.isProcessing} disabled={!online}>
          Book the session
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {!online ? <p className="caption">Booking needs a connection.</p> : null}
      <CommandProblem
        error={book.error}
        onRetry={submit}
        onReload={() => {
          book.reset();
          onReload();
        }}
      />
    </form>
  );
}
