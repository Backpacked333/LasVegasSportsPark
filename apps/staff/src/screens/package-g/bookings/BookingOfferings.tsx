/**
 * Rental or party offerings with their booking terms and definitions, read-only (SCR-S-51,
 * SCR-S-52; CAT-02, POL-040, SPK-COND-003): `GET /v1/offerings?kind=…&view=staff` in keyset pages
 * (catalog managers get every publication state; other staff the published ones), each offering's
 * approved booking terms (`GET /v1/policy-versions/{id}`) and its entitlement definition (what it
 * reserves, its staff, a party's length, guest limit and equipment).
 *
 * Terms and definitions are configured in Programs and camps (SCR-S-14) and the terms approved by
 * the finance operator; nothing is edited here, and no price, term or deposit is filled in. The
 * price is shown only as the catalog states it. Whether a request should reserve or take a deposit
 * before approval stays pending (DEC-029, DEC-030).
 */
import { Link } from 'react-router';
import { useApiPages } from '../../../api/useApiPages';
import { useApp } from '../../../providers/AppProviders';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import type { PackageGScreen } from '../registry';
import { DefinitionView } from '../participation/DefinitionView';
import { formatMoney } from '../participation/format';
import { BookingTermsView } from './BookingTermsView';
import { KIND_WORDS, type BookingKind } from './labels';

export function BookingOfferings({ kind, meta }: { kind: BookingKind; meta: PackageGScreen }) {
  const { facilityId } = useApp();
  const words = KIND_WORDS[kind];
  const pages = useApiPages({
    path: '/offerings',
    request: {
      query: { kind, view: 'staff', limit: 50, ...(facilityId ? { facilityId } : {}) },
    },
  });
  return (
    <section aria-labelledby={`${kind}-offerings-title`}>
      <h4 id={`${kind}-offerings-title`}>{words.title} offerings and terms</h4>
      <p className="caption">
        Read-only: terms and definitions are set up with the offering in Programs and camps
        (SCR-S-14), and booking terms are approved by the finance operator.
      </p>
      {meta.pending ? (
        <StateView
          variant="pending-decision"
          subject={meta.pending.subject}
          decisions={[...meta.pending.decisions]}
          owner={meta.pending.owner}
        />
      ) : null}
      <QueryBoundary
        query={pages}
        label={`${words.one} offerings`}
        isEmpty={(items) => items.length === 0}
        empty={{
          title: `No ${words.one} offerings`,
          description: `No ${words.one} offering is set up here yet (Programs and camps).`,
        }}
      >
        {(items) => (
          <ul className="list" aria-label={`${words.title} offerings`}>
            {items.map((offering) => (
              <li key={offering.id}>
                <article className="row-text" aria-labelledby={`offering-${offering.id}`}>
                  <h5 id={`offering-${offering.id}`} className="row-title">
                    {offering.name}
                  </h5>
                  <span className="pg-badges">
                    <StatusBadge tone="neutral" label={offering.publicationState} />
                  </span>
                  <span>
                    {offering.facility.name} ({offering.facility.timezone})
                  </span>
                  <span>
                    Price:{' '}
                    {offering.price
                      ? `${formatMoney(offering.price.basePriceMinor, offering.price.currency)} (as the catalog prices it)`
                      : 'Not priced'}
                  </span>
                  <BookingTermsView
                    policyVersionId={offering.bookingTermsPolicyVersionId}
                    timeZone={offering.facility.timezone}
                  />
                  <DefinitionView definitionId={offering.entitlementDefinitionId} />
                  <Link to={`/programs/offerings/${offering.id}`}>
                    Set up in Programs and camps
                  </Link>
                </article>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="offerings" />
    </section>
  );
}
