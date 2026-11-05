/**
 * SCR-S-20 Person record (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002, §4.14).
 * A scoped record staff open without customer credentials: the person and contact points from
 * `GET /v1/people/{id}`, then the scoped customer timeline from `GET /v1/customers/{id}/timeline`
 * (registration, participation, orders, payments, refunds, credits, schedule changes, messages
 * and support cases), older entries page by page. A child is shown as the API minimizes it; the
 * timeline names no one outside the person's scope. Timeline sources the viewer may not read are
 * listed as not available (field-level restriction), never hidden silently. A protected NOT_FOUND
 * shows "not available" without saying whether the person exists.
 *
 * - Contact points: "Make primary" and "Remove" (`POST /v1/people/{id}/contact-points/{cp}/
 *   make-primary` and `/remove`), each with the person's expected revision and an idempotency key
 *   per intent, offered to roles holding `identity.add_contact_point` while online; removing asks
 *   for confirmation; the API refuses removing the only verified contact of a person with an
 *   account (VALIDATION_FAILED `LAST_VERIFIED_CONTACT`), shown with that reason; STALE_REVISION
 *   offers "Reload". A child's contacts are kept, not shown, so none is offered.
 * - Account and claims (`GET /v1/people/{id}/authority`, `identity.read_authority`): whether an
 *   active login account represents the person, and each claim with its effective status, expiry
 *   and masked recipient, so a staff-entered person shows as claimable or claimed (SPK-IAM-002).
 * - Times are facility-local where the entry names a facility (`GET /v1/facilities`).
 * - Audit history of the person (`GET /v1/audit-records`) for roles that may read the audit log.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { PeopleNav } from '../../features/people/PeopleNav';
import { displayName, formatMoney, KEPT_NOT_SHOWN } from '../../features/people/people';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RecordRef, isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { AuditHistory } from '../today/AuditHistory';
import { useFacilityDirectory } from '../today/useFacilityDirectory';

type PersonDetail = Schema<'PersonDetail'>;
type ContactPoint = PersonDetail['contactPoints'][number];
type CustomerTimeline = Schema<'CustomerTimeline'>;
type PersonAuthority = Schema<'PersonAuthority'>;

export const PERSON_KEY = ['api', '/people/{id}'] as const;
export const AUTHORITY_KEY = ['api', '/people/{id}/authority'] as const;
export const CONTACT_POINT_ACTION = 'identity.add_contact_point';
export const READ_AUTHORITY_ACTION = 'identity.read_authority';

export const TIMELINE_PAGE_SIZE = 50;

const SOURCE_STATUS: Record<'ok' | 'not_permitted' | 'unavailable', string> = {
  ok: 'Included',
  not_permitted: 'Not available to you',
  unavailable: 'Unavailable right now',
};

function lastVerifiedRefusal(error: { code: string; details: unknown } | null): boolean {
  if (!error || error.code !== 'VALIDATION_FAILED') return false;
  const details = error.details as { code?: unknown } | null | undefined;
  return details?.code === 'LAST_VERIFIED_CONTACT';
}

/** Make primary and remove, each one intent with its own idempotency key (§4.9). */
function ContactPointActions({
  person,
  contact,
  onDone,
}: {
  person: PersonDetail;
  contact: ContactPoint;
  /** The outcome, shown above the list (a removed row leaves the list on the next read). */
  onDone: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const setSuccess = onDone;
  const path = { id: person.id, contactPointId: contact.id };
  const makePrimary = useApiCommand(
    'post',
    '/people/{id}/contact-points/{contactPointId}/make-primary',
    { invalidate: [PERSON_KEY] },
  );
  const remove = useApiCommand('post', '/people/{id}/contact-points/{contactPointId}/remove', {
    invalidate: [PERSON_KEY],
  });
  const reload = () => {
    makePrimary.reset();
    remove.reset();
    void queryClient.invalidateQueries({ queryKey: PERSON_KEY });
  };
  const doMakePrimary = () => {
    setSuccess(null);
    void makePrimary
      .submit({ path, body: { expectedRevision: person.revision } })
      .then((cp) => setSuccess(`Now the primary ${cp.kind}.`))
      .catch(() => undefined);
  };
  const doRemove = () => {
    setSuccess(null);
    void remove
      .submit({ path, body: { expectedRevision: person.revision } })
      .then(() => {
        setConfirming(false);
        setSuccess('Contact point removed.');
      })
      .catch(() => undefined);
  };
  const busy = makePrimary.isProcessing || remove.isProcessing;
  const label = `${contact.kind} ${contact.value}`;
  return (
    <div className="form">
      <div className="actions-row">
        {!contact.isPrimary ? (
          <Button
            variant="secondary"
            busy={makePrimary.isProcessing}
            disabled={busy}
            aria-label={`Make primary: ${label}`}
            onClick={doMakePrimary}
          >
            Make primary
          </Button>
        ) : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              busy={remove.isProcessing}
              disabled={busy}
              aria-label={`Confirm removing ${label}`}
              onClick={doRemove}
            >
              Confirm removal
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`Remove: ${label}`}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        )}
      </div>
      {confirming ? (
        <p className="caption">
          Removing {label} deletes it from the record; the audit record keeps a masked copy.
        </p>
      ) : null}
      <CommandError error={makePrimary.error} onRetry={doMakePrimary} onReload={reload} />
      {lastVerifiedRefusal(remove.error) ? (
        <p className="error-text" role="alert">
          This is the only verified contact of a person with an account, so it stays. Verify another
          contact first (code LAST_VERIFIED_CONTACT).
        </p>
      ) : (
        <CommandError error={remove.error} onRetry={doRemove} onReload={reload} />
      )}
    </div>
  );
}

function PersonFacts({ person }: { person: PersonDetail }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const child = person.kind === 'child';
  const [contactOutcome, setContactOutcome] = useState<string | null>(null);
  const canChangeContacts =
    online && person.status !== 'merged' && permissions.isPermitted(CONTACT_POINT_ACTION) === true;
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
        <CommandSuccess message={contactOutcome} />
        {!online && !child ? (
          <p className="caption">Offline: contact points cannot be changed until you reconnect.</p>
        ) : null}
        {child ? (
          <p>{KEPT_NOT_SHOWN}.</p>
        ) : person.contactPoints.length === 0 ? (
          <p>No contact points are recorded.</p>
        ) : (
          <ul className="list" aria-label="Contact points">
            {person.contactPoints.map((c) => (
              <li key={c.id}>
                <div className="row-text">
                  <span>
                    {c.kind}: {c.value}
                  </span>
                  {canChangeContacts ? (
                    <ContactPointActions person={person} contact={c} onDone={setContactOutcome} />
                  ) : null}
                </div>
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

const CLAIM_TONE = {
  pending: 'pending',
  accepted: 'success',
  revoked: 'neutral',
  expired: 'neutral',
} as const;

function AccountAndClaims({ authority }: { authority: PersonAuthority }) {
  return (
    <>
      <p>
        <StatusBadge
          tone={authority.accountLinked ? 'success' : 'neutral'}
          label={authority.accountLinked ? 'Account: linked' : 'Account: none'}
        />{' '}
        {authority.accountLinked
          ? 'An active login account represents this person.'
          : 'No login account represents this person; a staff-entered record can be claimed.'}
      </p>
      {authority.claims.length === 0 ? (
        <p className="caption">No claim has been issued for this person.</p>
      ) : (
        <ul className="list" aria-label="Claims">
          {authority.claims.map((c) => (
            <li key={c.id}>
              <div className="row-text">
                <span className="row-title">Claim: {c.kind}</span>
                <span className="caption">
                  issued {formatDateTime(c.createdAt)} · open until {formatDateTime(c.expiresAt)}
                  {c.recipientHint ? ` · sent to ${c.recipientHint}` : ''}
                </span>
              </div>
              <StatusBadge
                tone={CLAIM_TONE[c.effectiveStatus]}
                label={`Claim status: ${c.effectiveStatus}`}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AccountSection({ personId }: { personId: string }) {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted(READ_AUTHORITY_ACTION);
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: personId } },
    enabled: permitted !== false,
  });
  return (
    <section className="panel" aria-labelledby="account-title">
      <h3 id="account-title">Account and claims</h3>
      {permitted === false ? (
        <p className="caption">The account and claims of a person are not available to you.</p>
      ) : (
        <QueryBoundary
          query={authority}
          label="the account and claims"
          empty={{ title: '', description: '' }}
        >
          {(data) => <AccountAndClaims authority={data} />}
        </QueryBoundary>
      )}
    </section>
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
          <AccountSection personId={personId} />
          <CustomerTimelineSection personId={personId} />
          <AuditHistory targetType="person" targetId={personId} />
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
