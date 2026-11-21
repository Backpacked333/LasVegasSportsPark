/**
 * Staff S 4c: the household record (rail › People, or any name; SPK-IAM-001, SPK-SUPPORT-001,
 * §4.10, §4.14). Everything the desk is asked about on one page: money, forms, each child's
 * activities and flags, who may pick up, and what happened recently.
 *
 * - The household and its members: `GET /v1/households/{id}`; each person `GET /v1/people/{id}`.
 *   `/people/{id}/household` opens the household a person belongs to (`GET /v1/people/{id}/authority`).
 * - Balance and credit: the adults' money summaries (`GET /v1/people/{id}/money-summary`, protected)
 *   and credits (`GET /v1/credits`). Forms: each child's waivers (`GET /v1/people/{id}/waivers`):
 *   missing, lapsed or ending within 30 days needs attention. Visits in the last 30 days from the
 *   facility's visit records (the API has no per-person attendance rate).
 * - Each child: activities (`GET /v1/enrollments`), care notes as flags (`GET /v1/people/{id}/
 *   care-notes`, audited, only for a role that may read them), and who may pick up (the adults
 *   holding `collect`, from the child's authority).
 * - The log is the family's own timeline (`GET /v1/customers/{personId}/timeline`), the same one
 *   they see as receipts and messages.
 * - Each tile opens its detail. "Take payment" opens the front desk sale (S 4a) with this family
 *   chosen. "Add a staff note" needs a staff note on a household, which the API does not have:
 *   shown as proposed.
 */
import { apiQueryKey, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router';
import { usePermissions } from '../../../api/permissions';
import { useApiQuery } from '../../../api/useApiQuery';
import { useOperatingFacility } from '../../../features/operations/context';
import { formatMoney } from '../../../features/operations/format';
import { useApi, useNow } from '../../../providers/AppProviders';
import { Icon } from '../../../ui/Icon';
import { StateView } from '../../../ui/StateView';
import { DeskAvatar } from '../../arrival/desk/DeskAvatar';
import { ageOn, deskClock } from '../../arrival/desk/deskModel';
import './household.css';

type Person = Schema<'Person'>;
type PersonWaivers = Schema<'PersonWaivers'>;

const THIRTY_DAYS = 30 * 86_400_000;

/** `/people/:personId/household`: the household the person belongs to. */
export function PersonHouseholdRedirect() {
  const { personId = '' } = useParams();
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: personId } },
  });
  if (authority.data) {
    const household = authority.data.households[0];
    return household ? (
      <Navigate to={`/people/households/${household.id}`} replace />
    ) : (
      <section className="hh">
        <StateView
          variant="empty"
          title="Not in a household"
          description="This person is not in a household yet. Their own record has their details."
        />
        <Link to={`/people/${personId}`}>Open the person&apos;s record</Link>
      </section>
    );
  }
  return (
    <section className="hh">
      {authority.error ? (
        <StateView
          variant="error"
          error={authority.error}
          onRetry={() => void authority.refetch()}
        />
      ) : (
        <div className="hh-skeleton" aria-busy="true">
          Opening the household…
        </div>
      )}
    </section>
  );
}

export function HouseholdRecordScreen() {
  const { householdId = '' } = useParams();
  const household = useApiQuery({
    path: '/households/{id}',
    request: { path: { id: householdId } },
  });
  if (!household.data) {
    return (
      <section className="hh" aria-labelledby="hh-title">
        <h1 id="hh-title" className="ops-sr">
          Household
        </h1>
        {household.error ? (
          <StateView
            variant="error"
            error={household.error}
            onRetry={() => void household.refetch()}
          />
        ) : (
          <HouseholdSkeleton />
        )}
      </section>
    );
  }
  return <Household household={household.data} />;
}

/** The lead adult's primary phone and email, as staff read them on the person record. */
function contacts(person: Person | null): string[] {
  const points = (
    person as
      (Person & { contactPoints?: { kind: string; value: string; isPrimary: boolean }[] }) | null
  )?.contactPoints;
  if (!points) return [];
  const phone = points.find((c) => c.kind === 'phone' && c.isPrimary)?.value;
  const email = points.find((c) => c.kind === 'email' && c.isPrimary)?.value;
  const us = phone?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return [
    ...(phone ? [us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone] : []),
    ...(email ? [email] : []),
  ];
}

function HouseholdSkeleton() {
  return (
    <div className="hh-skeleton-layout" aria-busy="true" aria-label="Loading the household">
      <div className="hh-skeleton hh-skeleton-head" />
      <div className="hh-tiles">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="hh-skeleton hh-skeleton-tile" />
        ))}
      </div>
      <div className="hh-columns">
        {[0, 1, 2].map((i) => (
          <div key={i} className="hh-skeleton hh-skeleton-column" />
        ))}
      </div>
    </div>
  );
}

/** Each member's person record, read in one go (`GET /v1/people/{id}`, the same cache entries). */
function useMembers(ids: readonly string[]): Person[] {
  const api = useApi();
  const reads = useQueries({
    queries: ids.map((id) => ({
      queryKey: apiQueryKey('/people/{id}', { path: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.request('get', '/people/{id}', { path: { id }, signal }),
    })),
  });
  return reads.flatMap((r) => (r.data ? [r.data.data as Person] : []));
}

function Household({ household }: { household: Schema<'Household'> }) {
  const loaded = useMembers(household.members.map((m) => m.personId));
  const adults = loaded.filter((p) => p.kind === 'adult');
  const children = loaded.filter((p) => p.kind === 'child');
  const lead = adults[0] ?? null;
  return (
    <section className="hh" aria-labelledby="hh-title">
      <header className="hh-head">
        <span className="hh-faces" aria-hidden="true">
          {loaded.slice(0, 4).map((p) => (
            <DeskAvatar
              key={p.id}
              personId={p.id}
              name={`${p.givenName} ${p.familyName}`}
              size={60}
              ring
            />
          ))}
        </span>
        <span className="hh-title-block">
          <h1 id="hh-title">{household.name}</h1>
          <span className="caption">
            Member since {household.createdAt.slice(0, 4)} · {household.members.length}{' '}
            {household.members.length === 1 ? 'person' : 'people'}
            {contacts(lead).map((c) => ` · ${c}`)}
          </span>
        </span>
        <span className="hh-actions">
          <Link className="hh-button hh-button-secondary" to="/communications">
            <Icon name="mail" />
            Message
          </Link>
          <Link
            className="hh-button hh-button-primary"
            to={`/finance/point-of-sale/desk?household=${household.id}`}
          >
            <Icon name="point_of_sale" />
            Take payment
          </Link>
        </span>
      </header>
      <div className="hh-tiles">
        <MoneyTiles adults={adults} />
        <FormsTile children={children} />
        <VisitsTile people={loaded} />
      </div>
      <div className="hh-columns">
        {children.map((child) => (
          <ChildColumn key={child.id} child={child} />
        ))}
        <ActivityLog person={lead} />
      </div>
    </section>
  );
}

function MoneyTiles({ adults }: { adults: Person[] }) {
  const lead = adults[0];
  const money = useApiQuery({
    path: '/people/{id}/money-summary',
    request: { path: { id: lead?.id ?? '' } },
    enabled: lead !== undefined,
  });
  const credits = useApiQuery({
    path: '/credits',
    request: { query: { ownerPersonId: lead?.id ?? '', limit: 10 } },
    enabled: lead !== undefined,
  });
  const balance = money.data?.accountBalance[0];
  const available = money.data?.creditsAvailable[0];
  const latestCredit =
    credits.data?.items.find((c) => c.status === 'active') ?? credits.data?.items[0];
  const unavailable = money.error?.isPermissionRestriction || money.error?.isNotFound;
  return (
    <>
      <Link className="hh-tile" to={lead ? `/finance/obligations?debtor=${lead.id}` : '/finance'}>
        <span className="caption">Balance</span>
        <b className="hh-figure">
          {money.data
            ? balance
              ? formatMoney(balance.amountMinor, balance.currency)
              : formatMoney(0, 'USD')
            : unavailable
              ? 'Not available'
              : '…'}
        </b>
        <span className="caption">
          {money.data
            ? `${money.data.openObligations} open ${money.data.openObligations === 1 ? 'fee' : 'fees'}${
                money.data.pastDueObligations > 0
                  ? ` · ${money.data.pastDueObligations} past due`
                  : ''
              }`
            : ' '}
        </span>
      </Link>
      <Link className="hh-tile" to="/finance/credits">
        <span className="caption">Credit</span>
        <b className="hh-figure hh-figure-good">
          {money.data
            ? available
              ? formatMoney(available.amountMinor, available.currency)
              : formatMoney(0, 'USD')
            : unavailable
              ? 'Not available'
              : '…'}
        </b>
        <span className="caption">{latestCredit?.reason ?? ' '}</span>
      </Link>
    </>
  );
}

function FormsTile({ children }: { children: Person[] }) {
  const now = useNow(3_600_000);
  const first = children[0];
  const second = children[1];
  const a = useWaivers(first?.id);
  const b = useWaivers(second?.id);
  const needs: string[] = [];
  for (const [child, data] of [
    [first, a.data],
    [second, b.data],
  ] as const) {
    if (!child || !data) continue;
    for (const w of data.waivers) {
      if (w.status !== 'current') {
        needs.push(
          `${child.givenName}'s ${w.title.toLowerCase()} is ${w.status === 'missing' ? 'not signed' : 'expired'}`,
        );
      } else if (w.validUntil && new Date(w.validUntil).getTime() - now.getTime() <= THIRTY_DAYS) {
        const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
          new Date(w.validUntil),
        );
        needs.push(`${child.givenName}'s waiver ends ${day}`);
      }
    }
  }
  const known = (!first || a.data !== undefined) && (!second || b.data !== undefined);
  return (
    <Link
      className="hh-tile"
      data-tone={needs.length > 0 ? 'warning' : undefined}
      to={first ? `/people/${first.id}` : '/people'}
    >
      <span className="caption">Forms</span>
      <b className="hh-figure">
        {!known ? '…' : needs.length > 0 ? `▲ ${needs.length}` : '✓ All signed'}
      </b>
      <span className="caption">{needs[0] ?? (known ? 'Every waiver is current' : ' ')}</span>
    </Link>
  );
}

function useWaivers(personId: string | undefined) {
  return useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: personId ?? '' } },
    enabled: personId !== undefined,
  }) as { data: PersonWaivers | undefined };
}

function VisitsTile({ people }: { people: Person[] }) {
  const facility = useOperatingFacility();
  const now = useNow(3_600_000);
  const child = people.find((p) => p.kind === 'child');
  const visits = useApiQuery({
    path: '/visits',
    request: {
      query: { facilityId: facility.facilityId ?? '', personId: child?.id ?? '', limit: 100 },
    },
    enabled: facility.facilityId !== null && child !== undefined,
  });
  const recent = (visits.data?.items ?? []).filter(
    (v) => now.getTime() - new Date(v.arrivedAt).getTime() <= THIRTY_DAYS,
  );
  return (
    <Link className="hh-tile" to="/arrival/attendance">
      <span className="caption">Visits, 30 days</span>
      <b className="hh-figure">{visits.data ? recent.length : visits.error ? '–' : '…'}</b>
      <span className="caption">
        {child ? `${child.givenName}'s arrivals at this facility` : 'No child in this household'}
      </span>
    </Link>
  );
}

function ChildColumn({ child }: { child: Person }) {
  const now = useNow(3_600_000);
  const permissions = usePermissions();
  const mayReadCare = permissions.isPermitted('identity.read_care_notes') === true;
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { participantPersonId: child.id, limit: 20 } },
  });
  const care = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: child.id } },
    enabled: mayReadCare,
  });
  const waivers = useWaivers(child.id);
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: child.id } },
  });
  const age = ageOn(child.dateOfBirth, now);
  const active = (enrollments.data?.items ?? []).filter(
    (e) => e.status !== 'canceled' && e.status !== 'transferred',
  );
  const allergy = care.data?.notes.find((n) => n.kind === 'allergy');
  const cleared = waivers.data?.waivers.every((w) => w.status === 'current');
  const pickup = [
    ...new Set(
      (authority.data?.grants ?? [])
        .filter((g) => g.permission === 'collect' && g.status === 'effective' && !g.underReview)
        .map((g) =>
          g.relationshipKind === 'guardian'
            ? (g.actorDisplayName ?? 'A guardian')
            : `${g.actorDisplayName ?? 'An adult'} (${g.relationshipKind.replace(/_/g, ' ')})`,
        ),
    ),
  ];
  const name = `${child.givenName} ${child.familyName}`;
  return (
    <section className="hh-card hh-child" aria-label={name}>
      <header className="hh-child-head">
        <DeskAvatar personId={child.id} name={name} size={44} />
        <span>
          <Link to={`/people/${child.id}`} className="hh-child-name">
            {child.givenName}
            {age !== null ? ` · ${age}` : ''}
          </Link>
          <span className="caption">
            {enrollments.data
              ? `${active.length} ${active.length === 1 ? 'activity' : 'activities'}`
              : ' '}
          </span>
        </span>
        {allergy ? (
          <span className="hh-flag" data-tone="danger" title={allergy.body}>
            ✕ {allergy.body.split(/[.;]/)[0]} allergy
          </span>
        ) : cleared ? (
          <span className="hh-flag" data-tone="success">
            ✓ Cleared
          </span>
        ) : null}
      </header>
      <ul className="hh-activities" aria-label={`${child.givenName}'s activities`}>
        {active.map((e) => (
          <li key={e.id}>
            <b>{e.offering?.name ?? 'An activity'}</b>
            <span className="caption">
              {e.status === 'confirmed' ? 'confirmed' : e.status.replace(/_/g, ' ')}
              {e.price ? ` · ${formatMoney(e.price.basePriceMinor, e.price.currency)}` : ''}
            </span>
          </li>
        ))}
        {enrollments.data && active.length === 0 ? (
          <li className="caption">No current activity.</li>
        ) : null}
      </ul>
      <div className="hh-pickup">
        <span className="caption">Pickup allowed</span>
        <span>
          {authority.data
            ? pickup.length > 0
              ? pickup.join(', ')
              : 'Nobody holds pickup permission'
            : authority.error
              ? 'Not available'
              : '…'}
        </span>
      </div>
    </section>
  );
}

function ActivityLog({ person }: { person: Person | null }) {
  const timeline = useApiQuery({
    path: '/customers/{personId}/timeline',
    request: { path: { personId: person?.id ?? '' }, query: { limit: 12 } },
    enabled: person !== null,
  });
  const facility = useOperatingFacility();
  const now = useNow(60_000);
  const today = now.toDateString();
  return (
    <section className="hh-card hh-log" aria-labelledby="hh-log-title">
      <h2 id="hh-log-title">Activity log</h2>
      {timeline.data ? (
        timeline.data.entries.length === 0 ? (
          <p className="caption">Nothing recorded yet.</p>
        ) : (
          <ol className="hh-log-list">
            {timeline.data.entries.map((e) => {
              const at = new Date(e.occurredAt);
              return (
                <li key={e.id}>
                  <span className="hh-log-time">
                    {at.toDateString() === today
                      ? deskClock(e.occurredAt, facility.timezone)
                      : new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          ...(facility.timezone ? { timeZone: facility.timezone } : {}),
                        }).format(at)}
                  </span>
                  <span>
                    {e.title}
                    {e.amount ? ` · ${formatMoney(e.amount.amountMinor, e.amount.currency)}` : ''}
                  </span>
                </li>
              );
            })}
          </ol>
        )
      ) : timeline.error ? (
        <p className="caption">
          {timeline.error.isPermissionRestriction
            ? 'The family timeline is not available to your role.'
            : `The log could not load. Code ${timeline.error.code}.`}
        </p>
      ) : (
        <div className="hh-skeleton hh-skeleton-tile" aria-busy="true" />
      )}
      <button
        type="button"
        className="hh-note"
        disabled
        title="Staff notes on a household are proposed."
      >
        Add a staff note <span className="hh-proposed">◷ Proposed</span>
      </button>
    </section>
  );
}
