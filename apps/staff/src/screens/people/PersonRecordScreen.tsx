/**
 * SCR-S-20 Person record (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002, §4.14).
 * A scoped record staff open without customer credentials: the person and contact points from
 * `GET /v1/people/{id}`, then the scoped customer timeline from `GET /v1/customers/{id}/timeline`
 * (registration, participation, orders, payments, refunds, credits, schedule changes, messages
 * and support cases), older entries page by page. A child is shown as the API minimizes it; the
 * timeline names no one outside the person's scope. Timeline sources the viewer may not read are
 * listed as not available (field-level restriction), never hidden silently. A protected NOT_FOUND
 * shows "not available" without saying whether the person exists.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { PeopleNav } from '../../features/people/PeopleNav';
import { displayName, formatMoney, KEPT_NOT_SHOWN } from '../../features/people/people';
import { Button } from '../../ui/Button';
import { Facts } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RecordRef, isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { useFacilityDirectory } from '../today/useFacilityDirectory';

type PersonDetail = Schema<'PersonDetail'>;
type CustomerTimeline = Schema<'CustomerTimeline'>;

export const TIMELINE_PAGE_SIZE = 50;

const SOURCE_STATUS: Record<'ok' | 'not_permitted' | 'unavailable', string> = {
  ok: 'Included',
  not_permitted: 'Not available to you',
  unavailable: 'Unavailable right now',
};

function PersonFacts({ person }: { person: PersonDetail }) {
  const child = person.kind === 'child';
  return (
    <>
      <span className="actions-row">
        <StatusBadge
          tone={person.status === 'active' ? 'success' : 'neutral'}
          label={`Status: ${person.status}`}
        />
        <StatusBadge tone="info" label={`Kind: ${person.kind}`} />
      </span>
      {person.mergedIntoPersonId ? (
        <p>
          This record was merged. Its history now belongs to{' '}
          <Link to={`/people/${person.mergedIntoPersonId}`}>the surviving record</Link>.
        </p>
      ) : null}
      <Facts
        label="Person"
        items={
          child
            ? [
                // §4.14: a child's record is shown by given name only.
                ['Given name', person.givenName],
                ['Family name, date of birth and contacts', KEPT_NOT_SHOWN],
                ['Reference', <code key="ref">{person.id}</code>],
                ['Revision', String(person.revision)],
              ]
            : [
                ['Given name', person.givenName],
                ['Family name', person.familyName],
                ['Date of birth', person.dateOfBirth ?? 'Not recorded'],
                ['Reference', <code key="ref">{person.id}</code>],
                ['Revision', String(person.revision)],
              ]
        }
      />
      <section aria-labelledby="contacts-title">
        <h3 id="contacts-title">Contact points</h3>
        {child ? (
          <p>{KEPT_NOT_SHOWN}.</p>
        ) : person.contactPoints.length === 0 ? (
          <p>No contact points are recorded.</p>
        ) : (
          <ul className="list" aria-label="Contact points">
            {person.contactPoints.map((c) => (
              <li key={c.id}>
                <span>
                  {c.kind}: {c.value}
                </span>
                <span className="actions-row">
                  {c.isPrimary ? <StatusBadge tone="info" label="Primary" /> : null}
                  <StatusBadge
                    tone={c.verifiedAt ? 'success' : 'neutral'}
                    label={c.verifiedAt ? 'Verified' : 'Not verified'}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TimelinePage({
  personId,
  cursor,
  onOlder,
  isLast,
}: {
  personId: string;
  cursor: string | undefined;
  onOlder: (cursor: string) => void;
  isLast: boolean;
}) {
  const facilities = useFacilityDirectory();
  const page = useApiQuery({
    path: '/customers/{personId}/timeline',
    request: {
      path: { personId },
      query: { limit: TIMELINE_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    },
  });
  return (
    <QueryBoundary
      query={page}
      label="the customer timeline"
      empty={{ title: '', description: '' }}
      unavailableOffline={[]}
    >
      {(data: CustomerTimeline) => (
        <>
          {cursor === undefined ? <TimelineScope timeline={data} /> : null}
          {data.entries.length === 0 && cursor === undefined ? (
            <p>Nothing in this person’s scope has happened yet.</p>
          ) : (
            <ol className="list" aria-label={cursor ? 'Older timeline entries' : 'Timeline'}>
              {data.entries.map((e) => (
                <li key={e.id}>
                  <div className="row-text">
                    <span className="row-title">{e.title}</span>
                    <span className="caption">
                      {formatDateTime(e.occurredAt, facilities.timezone(e.facilityId))} ·{' '}
                      {e.category} · {e.kind}
                      {e.amount ? ` · ${formatMoney(e.amount.amountMinor, e.amount.currency)}` : ''}
                    </span>
                    <span className="caption">
                      <RecordRef type={e.record.type} id={e.record.id} />
                    </span>
                  </div>
                  {e.status ? <StatusBadge tone="neutral" label={`Status: ${e.status}`} /> : null}
                </li>
              ))}
            </ol>
          )}
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onOlder(data.nextCursor as string)}>
              Show older entries
            </Button>
          ) : null}
        </>
      )}
    </QueryBoundary>
  );
}

function TimelineScope({ timeline }: { timeline: CustomerTimeline }) {
  const limited = timeline.sources.filter((s) => s.status !== 'ok');
  return (
    <>
      {timeline.person.minimized ? (
        <p className="caption">
          This is a child’s record: it is shown by given name only, without date of birth or
          contacts.
        </p>
      ) : null}
      {timeline.scope.dependents.length > 0 ? (
        <section aria-labelledby="dependents-title">
          <h4 id="dependents-title">Also covers</h4>
          <ul className="list" aria-label="People in this timeline’s scope">
            {timeline.scope.dependents.map((d) => (
              <li key={d.id}>
                <Link to={`/people/${d.id}`}>{d.displayName}</Link>
                <span className="caption">
                  {d.kind} · status {d.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {limited.length > 0 ? (
        <section aria-label="Timeline sources not included">
          <h4>Not included</h4>
          <ul className="list">
            {limited.map((s) => (
              <li key={s.source}>
                <span>{s.source}</span>
                <StatusBadge
                  tone={s.status === 'unavailable' ? 'warning' : 'neutral'}
                  label={SOURCE_STATUS[s.status]}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function CustomerTimelineSection({ personId }: { personId: string }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  return (
    <section className="panel" aria-labelledby="timeline-title">
      <h3 id="timeline-title">Customer timeline</h3>
      {cursors.map((cursor, i) => (
        <TimelinePage
          key={cursor ?? 'first'}
          personId={personId}
          cursor={cursor}
          isLast={i === cursors.length - 1}
          onOlder={(next) => setCursors((list) => [...list, next])}
        />
      ))}
    </section>
  );
}

function PersonRecord({ personId }: { personId: string }) {
  const person = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  return (
    <QueryBoundary
      query={person}
      label="the person"
      empty={{ title: '', description: '' }}
      unavailableOffline={['changing this person’s record']}
    >
      {(data) => (
        <>
          <h3>{displayName(data)}</h3>
          <PersonFacts person={data} />
          <nav aria-label="Work with this person">
            <ul className="subnav">
              <li>
                <Link to={`/people/${personId}/relationships`}>
                  Household, relationships and grants
                </Link>
              </li>
              <li>
                <Link to={`/people/access-reviews/new?subject=${personId}`}>
                  Open an access review
                </Link>
              </li>
              <li>
                <Link to={`/people/duplicates?personA=${personId}`}>Check for a duplicate</Link>
              </li>
              <li>
                <Link to={`/admin/cases/new?subject=${personId}`}>Open a support case</Link>
              </li>
            </ul>
          </nav>
          <CustomerTimelineSection personId={personId} />
        </>
      )}
    </QueryBoundary>
  );
}

export function PersonRecordScreen() {
  const { personId = '' } = useParams();
  return (
    <section aria-labelledby="person-title">
      <h2 id="person-title">Person record</h2>
      <PeopleNav />
      {isUuid(personId) ? (
        <PersonRecord personId={personId} />
      ) : (
        <StateView variant="unavailable" />
      )}
    </section>
  );
}
