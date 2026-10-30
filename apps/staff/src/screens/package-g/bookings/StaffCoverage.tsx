/**
 * Who staffs a rental or party (SCR-S-51, SCR-S-52; SPK-COND-003, SPK-STAFF-002, SPK-UX-006). A
 * booking declares its staff requirements on each occurrence's scheduling event, so the workforce
 * reads for that event answer what the booking needs and who accepted:
 *
 * - `GET /v1/assignment-requirements?targetType=event&targetId=<eventId>`: each role with its
 *   required count and the slots still uncovered. Proposed and offered assignments never count as
 *   covered (SPK-STAFF-002); only accepted (or completed) ones do, as the API computes it.
 * - `GET /v1/assignments?targetType=event&targetId=<eventId>`: the accepted assignees, named
 *   through `GET /v1/person-names` (names only).
 *
 * Shown only when the API's permission read allows `workforce.view_assignments` at the booking's
 * facility ("Not available to you" otherwise); a refused read reads "not available" (§4.10). A
 * weekly rental can have many occurrences: the first few are read, the rest on request.
 */
import type { Schema } from '@sportspark/api-client';
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { Button } from '../../../ui/Button';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { formatRange, plural } from '../participation/format';
import { personNameText, usePersonNames } from '../participation/names';
import { ACTIONS, NotAvailableToYou, useActionAllowed } from '../participation/permission';
import type { Booking } from './labels';

type Requirement = Schema<'AssignmentRequirement'>;
type Assignment = Schema<'StaffAssignment'>;

/** Occurrences whose coverage is read without asking. */
export const COVERAGE_FIRST_SHOWN = 3;

const KIND_WORDS: Record<Requirement['kind'], string> = {
  official: 'Official',
  coach: 'Coach',
  supervisor: 'Supervisor',
  organizer: 'Organizer',
};

/** An assignment that holds its slot (SPK-STAFF-002). */
const HOLDS_SLOT: ReadonlySet<Assignment['status']> = new Set(['accepted', 'completed']);

function roleWords(role: string): string {
  return role.replaceAll('_', ' ');
}

function RequirementRow({
  requirement: r,
  assignees,
  assigneesError,
}: {
  requirement: Requirement;
  assignees: readonly { personId: string; slot: number; name: string }[] | null;
  assigneesError: string | null;
}) {
  const uncovered = r.coverage.uncoveredSlots;
  return (
    <li>
      <span className="row-text">
        <span>
          {KIND_WORDS[r.kind]}: {r.requiredCount} {roleWords(r.role)}{' '}
          {uncovered.length > 0 ? (
            <StatusBadge tone="danger" label={`${plural(uncovered.length, 'slot')} uncovered`} />
          ) : (
            <StatusBadge tone="success" label="Covered" />
          )}
        </span>
        <span className="caption">
          {r.coverage.accepted} accepted. Offered {r.coverage.offered} and proposed{' '}
          {r.coverage.proposed} do not count as covered.
          {uncovered.length > 0 ? ` Uncovered: slot ${uncovered.join(', slot ')}.` : ''}
        </span>
        {assigneesError ? (
          <span className="caption">{assigneesError}</span>
        ) : assignees === null ? null : assignees.length > 0 ? (
          <span>Accepted: {assignees.map((a) => `${a.name} (slot ${a.slot})`).join(', ')}</span>
        ) : (
          <span>Nobody has accepted yet.</span>
        )}
      </span>
    </li>
  );
}

function EventCoverage({
  eventId,
  start,
  end,
  timeZone,
}: {
  eventId: string;
  start: string;
  end: string;
  timeZone: string | null;
}) {
  const requirements = useApiQuery({
    path: '/assignment-requirements',
    request: { query: { targetType: 'event', targetId: eventId } },
  });
  const assignments = useApiQuery({
    path: '/assignments',
    request: { query: { targetType: 'event', targetId: eventId, limit: 200 } },
  });
  const holding = (assignments.data?.items ?? []).filter((a) => HOLDS_SLOT.has(a.status));
  const names = usePersonNames(holding.map((a) => a.personId));
  const when = formatRange(start, end, timeZone);
  let assigneesError: string | null = null;
  if (assignments.error) {
    assigneesError =
      presentationForError(assignments.error) === 'unavailable'
        ? 'Who accepted is not available.'
        : `Who accepted could not load (${assignments.error.code}).`;
  }
  const assigneesOf = (role: string) =>
    assignments.data
      ? holding
          .filter((a) => a.role === role)
          .sort((a, b) => a.slot - b.slot)
          .map((a) => ({
            personId: a.personId,
            slot: a.slot,
            name: personNameText(names.get(a.personId), 'Staff member'),
          }))
      : null;
  return (
    <article className="row-text" aria-label={`Staff for ${when}`}>
      <span className="row-title">{when}</span>
      <QueryBoundary
        query={requirements}
        label="the staff requirements"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No staff required',
          description: 'No staff requirement is declared for this occurrence.',
        }}
      >
        {(list) => (
          <ul className="pg-inline-list" aria-label="Staff requirements">
            {list.map((r) => (
              <RequirementRow
                key={r.id}
                requirement={r}
                assignees={assigneesOf(r.role)}
                assigneesError={assigneesError}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </article>
  );
}

export function StaffCoverage({ booking }: { booking: Booking }) {
  const allowed = useActionAllowed(ACTIONS.viewAssignments, booking.facilityId);
  const [showAll, setShowAll] = useState(false);
  const reserved = booking.occurrences.flatMap((o) =>
    o.eventId ? [{ eventId: o.eventId, start: o.start, end: o.end }] : [],
  );
  if (reserved.length === 0) {
    return <p className="caption">Staff are assigned once the booking is reserved.</p>;
  }
  if (!allowed) {
    return <NotAvailableToYou what="Staff coverage" action={ACTIONS.viewAssignments} />;
  }
  const shown = showAll ? reserved : reserved.slice(0, COVERAGE_FIRST_SHOWN);
  return (
    <section className="pg-panel" aria-labelledby={`coverage-${booking.id}`}>
      <h5 id={`coverage-${booking.id}`}>Staff coverage</h5>
      <ul className="list" aria-label="Staff coverage by occurrence">
        {shown.map((o) => (
          <li key={o.eventId}>
            <EventCoverage
              eventId={o.eventId}
              start={o.start}
              end={o.end}
              timeZone={booking.timezone}
            />
          </li>
        ))}
      </ul>
      {reserved.length > shown.length ? (
        <div className="pg-actions">
          <Button variant="secondary" onClick={() => setShowAll(true)}>
            Show the staff of all {plural(reserved.length, 'occurrence')}
          </Button>
        </div>
      ) : null}
      <Link to="/staff">Assign or replace staff in Staff assignments and coverage</Link>
    </section>
  );
}
