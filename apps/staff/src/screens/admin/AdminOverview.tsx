/**
 * Administration at a glance (SCR-S-46, SCR-S-47; SPK-UX-005, SPK-UX-008): read-only previews of
 * the screens the Administration area links, each from the API that owns the record, each with its
 * own loading, empty, offline and not-available state:
 *
 * - accounts and roles: active staff memberships (`GET /v1/staff-memberships`, newest first) with
 *   the display name the API returns, roles and facility scope;
 * - capability switches (`GET /v1/admin/capabilities`): on or off as the API reports, written out;
 *   switching stays on the capability screen, where it needs a reason and decision (DEC-016);
 * - integrations (`GET /v1/admin/integrations`): each §5.2 provider gate with its decision and
 *   evidence level.
 *
 * Nothing here changes anything; every row opens the screen that does.
 */
import { CAPABILITY_PRESENTATION, type CapabilityId } from '@sportspark/api-client';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import { gateTitle, roleLabel } from '../../features/insight-admin/labels';
import { Icon, type IconName } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { useNow } from '../../providers/AppProviders';
import './admin.css';
import { AccessSummaryLine, INVITE_ACTION, lastSeenText } from './StaffAccessPanels';

const GATE_ICON: Record<string, IconName> = {
  identity: 'fingerprint',
  payments: 'credit_card',
  messaging: 'sms',
  hosting: 'cloud',
  accounting: 'account_balance',
  hardware: 'qr_code_scanner',
  assistant: 'star_shine',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** A stable avatar tint per person (decorative; the name is always written). */
function tint(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 5;
  return h;
}

function capabilityLabel(id: string): string {
  return (
    CAPABILITY_PRESENTATION[id as CapabilityId]?.label ??
    id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

function AccountsCard() {
  const memberships = useApiPages({
    path: '/staff-memberships',
    request: { query: { status: 'active', limit: 8 } },
  });
  const { choices } = useFacilityChoices();
  const facility = (id: string) => choices.find((c) => c.id === id)?.label ?? 'a facility';
  const now = useNow();
  return (
    <section className="card card-flush adm-card" aria-labelledby="adm-accounts-title">
      <div className="card-head">
        <h3 id="adm-accounts-title">Accounts and roles</h3>
        <AccessSummaryLine />
        <Link to="/admin/accounts" className="adm-head-link">
          Manage <Icon name="chevron_right" size={18} />
        </Link>
      </div>
      <div className="adm-body">
        <QueryBoundary
          query={memberships}
          label="staff memberships"
          isEmpty={(items) => items.length === 0}
          empty={{
            title: 'No staff roles assigned',
            description: 'Assign the first administrator on the accounts screen.',
          }}
        >
          {(items) => (
            <ul className="adm-people" aria-label="Active staff roles">
              {items.map((m) => (
                <li key={m.id}>
                  <span className="adm-avatar" data-tint={tint(m.personId)} aria-hidden="true">
                    {initials(m.personDisplayName ?? '') || <Icon name="person" size={16} />}
                  </span>
                  <span className="row-text">
                    <span className="row-title">{m.personDisplayName ?? 'Name not available'}</span>
                    <span className="caption">
                      {m.facilityIds.length === 0
                        ? 'Whole organization'
                        : m.facilityIds.map(facility).join(', ')}
                    </span>
                  </span>
                  <span className="adm-roles">
                    {m.roles.map((r) => (
                      <span key={r} className="adm-role">
                        {roleLabel(r)}
                      </span>
                    ))}
                  </span>
                  <span className="adm-seen caption">{lastSeenText(m.lastSeenAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
        {memberships.hasNextPage ? (
          <Link to="/admin/accounts" className="adm-more">
            More staff on the accounts screen
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function CapabilitiesCard() {
  const capabilities = useApiQuery({ path: '/admin/capabilities' });
  return (
    <section className="card card-flush adm-card" aria-labelledby="adm-caps-title">
      <div className="card-head">
        <h3 id="adm-caps-title">Capabilities</h3>
        <Link to="/admin/capabilities" className="adm-head-link">
          Switches <Icon name="chevron_right" size={18} />
        </Link>
      </div>
      <div className="adm-body">
        <QueryBoundary
          query={capabilities}
          label="capability switches"
          isEmpty={(data) => data.items.length === 0}
          empty={{ title: 'No capabilities', description: 'The API reports no switches.' }}
        >
          {(data) => (
            <ul className="adm-switches" aria-label="Capability switches">
              {data.items.map((c) => (
                <li key={c.capability}>
                  <span className="row-text">
                    <span className="row-title">{capabilityLabel(c.capability)}</span>
                    <span className="caption">{c.description}</span>
                  </span>
                  <span className="adm-switch" data-on={c.enabled} aria-hidden="true">
                    <span />
                  </span>
                  <StatusBadge
                    tone={c.enabled ? 'success' : 'neutral'}
                    label={c.enabled ? 'On' : 'Off'}
                  />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

function IntegrationsCard() {
  const register = useApiQuery({ path: '/admin/integrations' });
  return (
    <section className="card card-flush adm-card" aria-labelledby="adm-int-title">
      <div className="card-head">
        <h3 id="adm-int-title">Integrations</h3>
        <Link to="/admin/integrations" className="adm-head-link">
          Register <Icon name="chevron_right" size={18} />
        </Link>
      </div>
      <div className="adm-body">
        <QueryBoundary
          query={register}
          label="integration register"
          isEmpty={(data) => data.gates.length === 0}
          empty={{ title: 'No provider gates', description: 'The register lists no providers.' }}
        >
          {(data) => (
            <ul className="adm-gates" aria-label="Provider gates">
              {data.gates.map((g) => (
                <li key={g.gate}>
                  <span className="adm-gate-icon" aria-hidden="true">
                    <Icon name={GATE_ICON[g.gate] ?? 'link'} size={19} />
                  </span>
                  <span className="row-text">
                    <span className="row-title">{gateTitle(g.gate)}</span>
                    <span className="caption">
                      {g.adapters.length} adapter{g.adapters.length === 1 ? '' : 's'}
                      {g.evidenceLevel ? ` · evidence ${g.evidenceLevel}` : ''}
                    </span>
                  </span>
                  {/* The register's only status: the provider is not chosen (§5.2). */}
                  <StatusBadge tone="pending" label={`Waiting on ${g.decisionRef}`} />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

/** The design's "Invite staff" action, for roles holding identity.manage_staff_invitation. */
function InviteStaffLink() {
  const permissions = usePermissions();
  if (permissions.isPermitted(INVITE_ACTION) !== true) return null;
  return (
    <Link to="/admin/accounts#invite-staff" className="button button-primary adm-invite">
      <Icon name="person_add" size={18} /> Invite staff
    </Link>
  );
}

export function AdminOverview() {
  return (
    <div className="split adm-overview">
      <div className="split-main">
        <InviteStaffLink />
        <AccountsCard />
        <IntegrationsCard />
      </div>
      <div className="split-side">
        <CapabilitiesCard />
      </div>
    </div>
  );
}
