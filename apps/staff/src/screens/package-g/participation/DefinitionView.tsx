/**
 * An entitlement definition as catalog exposes it (CAT-02, `GET /v1/entitlement-definitions/{id}`;
 * staff read `catalog.read_catalog`), read-only on the Package G screens SCR-S-51 to SCR-S-54.
 * Definitions are configured with the offering in Programs and camps (SCR-S-14); these screens never
 * edit one. What a membership includes, how many credits a package holds, when it expires, what a
 * rental or party reserves and which staff it needs are shown exactly as the definition states;
 * an unreadable scope says so and nothing is assumed (SPK-COND-001 to SPK-COND-003).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../../api/useApiQuery';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import {
  includedSessionsText,
  membershipBenefit,
  packageCredits,
  partyPackage,
  rentalResource,
  staffingText,
  type AppliesTo,
  type StaffingRequirement,
} from './definition';
import { formatDate, plural } from './format';
import { AssetName, JoinedList, OfferingName, ProgramName, ResourceName } from './names';

type Definition = Schema<'EntitlementDefinition'>;

export function AppliesToView({ scope }: { scope: AppliesTo }) {
  const items = [
    ...scope.offeringIds.map((id) => <OfferingName key={`o-${id}`} id={id} />),
    ...scope.programIds.map((id) => (
      <span key={`p-${id}`}>
        every offering of <ProgramName id={id} />
      </span>
    )),
  ];
  return <JoinedList>{items}</JoinedList>;
}

function StaffingList({ staffing }: { staffing: StaffingRequirement[] }) {
  if (staffing.length === 0) return <span>No staff required by the definition</span>;
  return (
    <ul className="pg-inline-list">
      {staffing.map((s, index) => (
        <li key={index}>{staffingText(s)}</li>
      ))}
    </ul>
  );
}

function ResourcesText({ count, ids }: { count: number; ids: string[] }) {
  return (
    <span>
      {count === ids.length ? `All ${plural(ids.length, 'resource')}: ` : `${count} of `}
      <JoinedList>
        {ids.map((id) => (
          <ResourceName key={id} id={id} />
        ))}
      </JoinedList>
      {count === ids.length ? '' : ' (reserved together)'}
    </span>
  );
}

function Unreadable({ kind }: { kind: string }) {
  return (
    <p>
      <StatusBadge tone="warning" label="Definition not readable" /> The {kind} definition does not
      have the shape catalog requires, so nothing is assumed about it. Correct it in Programs and
      camps (SCR-S-14).
    </p>
  );
}

export function DefinitionBody({ definition }: { definition: Definition }) {
  const label = `What “${definition.name}” grants`;
  switch (definition.kind) {
    case 'membership_benefit': {
      const benefit = membershipBenefit(definition.scope);
      if (!benefit) return <Unreadable kind="membership" />;
      const a = benefit.attendance;
      return (
        <Facts
          label={label}
          items={[
            [
              'Attendance included',
              a.mode === 'none' ? (
                'No sessions (the membership books nothing by itself)'
              ) : a.mode === 'unlimited' ? (
                <span>
                  Unlimited sessions of <AppliesToView scope={a.appliesTo} />
                </span>
              ) : (
                <span>
                  {includedSessionsText(a.limit)} of <AppliesToView scope={a.appliesTo} />
                </span>
              ),
            ],
            [
              'Term',
              benefit.term.kind === 'offering_dates'
                ? "The membership offering's dates"
                : `${plural(benefit.term.lengthDays, 'day')} from confirmation`,
            ],
            [
              'Renewal notice',
              benefit.renewalNoticeLeadDays === null
                ? 'None (the definition sends no renewal notice)'
                : `${plural(benefit.renewalNoticeLeadDays, 'day')} before the term ends`,
            ],
            ['Definition status', definition.status],
          ]}
        />
      );
    }
    case 'package_credits': {
      const credits = packageCredits(definition.scope);
      if (!credits) return <Unreadable kind="session package" />;
      const e = credits.expiry;
      return (
        <Facts
          label={label}
          items={[
            ['Credits per purchase', String(credits.credits)],
            ['Eligible sessions', <AppliesToView key="applies" scope={credits.appliesTo} />],
            [
              'Expiry',
              e.kind === 'none'
                ? 'No expiry (chosen by the package)'
                : e.kind === 'days_after_issue'
                  ? `${plural(e.days, 'day')} after the package is issued`
                  : `At the end of ${formatDate(e.date)} (facility time)`,
            ],
            ['Definition status', definition.status],
          ]}
        />
      );
    }
    case 'rental_resource': {
      const rental = rentalResource(definition.scope);
      if (!rental) return <Unreadable kind="rental" />;
      return (
        <Facts
          label={label}
          items={[
            [
              'Reserves',
              <ResourcesText
                key="res"
                count={rental.resources.count}
                ids={rental.resources.resourceIds}
              />,
            ],
            ['Mandatory staff', <StaffingList key="staff" staffing={rental.staffing} />],
            ['Definition status', definition.status],
          ]}
        />
      );
    }
    case 'party_package': {
      const party = partyPackage(definition.scope);
      if (!party) return <Unreadable kind="party package" />;
      return (
        <Facts
          label={label}
          items={[
            ['Length', `${party.durationMinutes} minutes`],
            ['Guest limit', String(party.guestLimit)],
            [
              'Reserves',
              <ResourcesText
                key="res"
                count={party.resources.count}
                ids={party.resources.resourceIds}
              />,
            ],
            [
              'Equipment',
              party.equipmentAssetIds.length === 0 ? (
                'None'
              ) : (
                <JoinedList key="eq">
                  {party.equipmentAssetIds.map((id) => (
                    <AssetName key={id} id={id} />
                  ))}
                </JoinedList>
              ),
            ],
            ['Mandatory staff (host)', <StaffingList key="staff" staffing={party.staffing} />],
            ['Definition status', definition.status],
          ]}
        />
      );
    }
    default:
      return (
        <p>
          This offering grants a {definition.kind.replaceAll('_', ' ')} entitlement, not a Package G
          one.
        </p>
      );
  }
}

/** Reads and shows one definition; "not available" when the viewer may not read the catalog. */
export function DefinitionView({ definitionId }: { definitionId: string | null }) {
  const definition = useApiQuery({
    path: '/entitlement-definitions/{id}',
    request: { path: { id: definitionId ?? '' } },
    enabled: definitionId !== null,
    staleTime: 5 * 60_000,
  });
  if (definitionId === null) {
    return (
      <p>
        <StatusBadge tone="warning" label="No entitlement definition" /> The offering names no
        definition, so what it grants is not stated (SCR-S-14).
      </p>
    );
  }
  return (
    <QueryBoundary
      query={definition}
      label="the entitlement definition"
      empty={{ title: '', description: '' }}
    >
      {(data) => <DefinitionBody definition={data} />}
    </QueryBoundary>
  );
}
