/**
 * SCR-S-53 Memberships, overview (SPK-COND-001, ENR-12): membership offerings with what each
 * includes as its definition states it (attendance: none, so many sessions per period, or unlimited
 * only when chosen; the term; the renewal notice), read-only, and the members of the chosen
 * offering (`GET /v1/enrollments?offeringId=`, keyset pages with "Load more") with their state in
 * the machine's words and names only (§4.14). The chosen offering is an opaque id in the URL
 * (`?offering=`), never a name.
 *
 * Member pricing is not built (POL-038, DEC-007 pending): the price is shown only as the catalog
 * states it, never adjusted.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiPages } from '../../../api/useApiPages';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { SelectField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { isUuid } from '../../../ui/RecordRef';
import { StatusBadge } from '../../../ui/StatusBadge';
import { DefinitionView } from '../participation/DefinitionView';
import { formatInstant, formatMoney } from '../participation/format';
import { personNameText, usePersonNames } from '../participation/names';
import { ENROLLMENT_STATUS, ENROLLMENT_STATUSES } from './labels';

type EnrollmentStatus = Schema<'EnrollmentStatus'>;
type Offering = Schema<'OfferingListItem'>;

function Members({ offering }: { offering: Offering }) {
  const [status, setStatus] = useState<EnrollmentStatus | ''>('');
  const pages = useApiPages({
    path: '/enrollments',
    request: { query: { offeringId: offering.id, limit: 50, ...(status ? { status } : {}) } },
  });
  const names = usePersonNames((pages.data ?? []).map((e) => e.participantPersonId));
  return (
    <section className="pg-panel" aria-labelledby="members-title">
      <h3 id="members-title">Members of {offering.name}</h3>
      <div className="pg-toolbar">
        <SelectField
          label="Membership state"
          value={status}
          onChange={(v) => setStatus(v as EnrollmentStatus | '')}
          placeholder="All states"
          options={ENROLLMENT_STATUSES.map((s) => ({
            value: s,
            label: ENROLLMENT_STATUS[s].label,
          }))}
        />
      </div>
      <QueryBoundary
        query={pages}
        label="members"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No members',
          description: status
            ? `No membership of this offering is ${ENROLLMENT_STATUS[status].label}.`
            : 'No one holds this membership yet.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label={`Members of ${offering.name}`}>
            {items.map((e) => {
              const name = personNameText(names.get(e.participantPersonId), 'Member');
              const badge = ENROLLMENT_STATUS[e.status];
              return (
                <li key={e.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/finance/memberships/${e.id}`}>
                      {name}
                    </Link>
                    <span className="caption">
                      {e.confirmedAt
                        ? `Confirmed ${formatInstant(e.confirmedAt, offering.facility.timezone)}`
                        : 'Not confirmed'}
                    </span>
                  </div>
                  <StatusBadge tone={badge.tone} label={badge.label} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="members" />
    </section>
  );
}

export function MembershipOfferings() {
  const { facilityId } = useApp();
  const [params, setParams] = useSearchParams();
  const chosenId = params.get('offering');
  const pages = useApiPages({
    path: '/offerings',
    request: {
      query: {
        kind: 'membership',
        view: 'staff',
        limit: 50,
        ...(facilityId ? { facilityId } : {}),
      },
    },
  });
  const chosen =
    chosenId && isUuid(chosenId) ? (pages.data ?? []).find((o) => o.id === chosenId) : undefined;
  return (
    <>
      <section aria-labelledby="membership-offerings-title">
        <h3 id="membership-offerings-title">Membership offerings</h3>
        <p className="caption">
          Read-only: what a membership includes, its term and renewal notice are set with the
          offering in Programs and camps (SCR-S-14).
        </p>
        <QueryBoundary
          query={pages}
          label="membership offerings"
          isEmpty={(items) => items.length === 0}
          empty={{
            title: 'No membership offerings',
            description: 'No membership is set up here yet.',
          }}
        >
          {(items) => (
            <ul className="list" aria-label="Membership offerings">
              {items.map((o) => (
                <li key={o.id}>
                  <article className="row-text" aria-labelledby={`membership-${o.id}`}>
                    <h4 id={`membership-${o.id}`} className="row-title">
                      {o.name}
                    </h4>
                    <span>
                      <StatusBadge tone="neutral" label={o.publicationState} /> {o.facility.name}
                    </span>
                    <span>
                      Price:{' '}
                      {o.price
                        ? `${formatMoney(o.price.basePriceMinor, o.price.currency)} (as the catalog prices it; member pricing is not built, DEC-007)`
                        : 'Not priced'}
                    </span>
                    <DefinitionView definitionId={o.entitlementDefinitionId} />
                    <div className="pg-actions">
                      <Button
                        variant="secondary"
                        aria-pressed={chosen?.id === o.id}
                        onClick={() => setParams({ offering: o.id })}
                      >
                        Show members of {o.name}
                      </Button>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
        <LoadMore pages={pages} label="membership offerings" />
      </section>
      {chosen ? <Members key={chosen.id} offering={chosen} /> : null}
    </>
  );
}
