/**
 * SCR-S-53 Memberships (Package G, conditional; SPK-COND-001, ENR-12, §3.16 Memberships), in the
 * Finance area with the Finance section navigation. Route: `/finance/memberships/*`:
 *
 * - `/finance/memberships`: membership offerings with what each includes (read-only, as catalog
 *   exposes the definition) and the members of the chosen offering;
 * - `/finance/memberships/<enrollmentId>`: one member with suspensions, included-session booking,
 *   renewal and the link to cancellation (SCR-S-27).
 *
 * Behind `CapabilityGate` for `memberships` (DEC-016, DEC-072) with `whenOff="notice"`: existing
 * memberships stay readable and suspensions keep working while off; renewals and included-session
 * bookings are not offered. A membership never implies unlimited attendance unless its definition
 * says so (SPK-COND-001). Member pricing and entitlement terms stay pending (POL-038, DEC-007).
 */
import { Route, Routes } from 'react-router';
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { StateView } from '../../../ui/StateView';
import '../participation/participation.css';
import { MembershipDetail } from './MembershipDetail';
import { MembershipOfferings } from './MembershipOfferings';
import { MEMBERSHIPS } from './meta';

function Overview() {
  const pending = MEMBERSHIPS.pending;
  return (
    <>
      {pending ? (
        <StateView
          variant="pending-decision"
          subject={pending.subject}
          decisions={[...pending.decisions]}
          owner={pending.owner}
        />
      ) : null}
      <MembershipOfferings />
    </>
  );
}

export function MembershipsScreen() {
  const meta = MEMBERSHIPS;
  const headingId = `package-g-${meta.slug}`;
  return (
    <section aria-labelledby={headingId} data-testid={`package-g-${meta.slug}`}>
      <h2 id={headingId}>{meta.title}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <p className="caption">
        {meta.id}: {meta.purpose}
      </p>
      <CapabilityGate
        capability={meta.capability}
        subject={meta.title}
        whenOff="notice"
        stillAvailable="Existing memberships stay readable and suspensions can still be recorded and ended. Renewals and included-session bookings need the switch on."
      >
        <Routes>
          <Route index element={<Overview />} />
          <Route path=":enrollmentId" element={<MembershipDetail />} />
          <Route
            path="*"
            element={<StateView variant="unavailable" title="Page not available" />}
          />
        </Routes>
      </CapabilityGate>
    </section>
  );
}
