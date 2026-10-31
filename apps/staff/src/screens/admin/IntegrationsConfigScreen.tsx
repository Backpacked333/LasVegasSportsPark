/**
 * SCR-S-47 Integrations and configuration (§5.1, §5.2, SPK-SCHED-008, DEC-013, DEC-018 to DEC-023;
 * SPK-UX-008, SPK-UX-009).
 *
 * - Provider connections: the integration register (`GET /v1/admin/integrations`, K-09). Each
 *   §5.2 provider-selection gate is shown as waiting on the decision the API names, with its owner;
 *   its twelve §5.1 register fields are "not recorded" while the API returns them empty, and its
 *   documented → tested → accepted → live evidence level is shown only as the API reports it.
 *   The adapters the API runs behind each gate are listed with their kind (deterministic test
 *   adapters today), whether they may serve production, the §5.2 scenarios they reproduce and the
 *   queue that reconciles their outcomes. No provider, account or evidence is invented. No gate
 *   with adapters is the empty state "fakes only".
 * - API connection: `GET /v1/health` (version and database), "Check again" is the connection test.
 * - Organization and facility settings: `GET /v1/admin/settings` with each record's revision, the
 *   facility time zone checked as an IANA name (SPK-SCHED-008) and the facility's local date from
 *   that zone. Changing settings stays Proposed (no API command, DEC-013; addresses DEC-001), so
 *   they are read-only here.
 * - Capability switches and provider events have their own pages (linked).
 * - Policy versions and effective dates: `GET /v1/policy-versions` with their approvals.
 * Offline, everything is read-only with the age of what is shown.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import {
  ApiGap,
  CommandError,
  InsightQueryBoundary,
  PendingNote,
} from '../../features/insight-admin/feedback';
import { SelectField } from '../../features/insight-admin/fields';
import {
  formatInstant,
  formatScalar,
  isValidTimeZone,
  localDateOf,
} from '../../features/insight-admin/format';
import {
  ADAPTER_KIND_LABELS,
  DECISIONS,
  EVIDENCE_LEVELS,
  FACILITY_STATUS_BADGES,
  ORGANIZATION_STATUS_BADGES,
  POLICY_BADGES,
  REGISTER_FIELD_LABELS,
  SCENARIO_LABELS,
  decisionOwner,
  gateTitle,
  roleLabel,
} from '../../features/insight-admin/labels';
import { AdminNav } from '../../features/insight-admin/nav';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type PolicyVersion = Schema<'PolicyVersion'>;

const POLICY_KINDS: Schema<'PolicyKind'>[] = [
  'eligibility',
  'cancellation',
  'refund',
  'discount',
  'waitlist',
  'hold',
  'approval',
  'form',
  'overpayment',
  'installment',
];

function ApiConnection() {
  const { services } = useApp();
  const health = useApiQuery({ path: '/health', staleTime: 0 });
  return (
    <section className="ia-section" aria-labelledby="api-connection-title">
      <h3 id="api-connection-title">API connection</h3>
      <InsightQueryBoundary
        query={health}
        label="the API status"
        empty={{ title: 'Not available', description: '' }}
      >
        {(data) => (
          <>
            {health.error ? (
              // SCR-S-47: a failed re-check is a failure, never the earlier green result.
              <>
                <p>
                  <StatusBadge tone="danger" label="Connection test failed" />{' '}
                  {health.errorUpdatedAt
                    ? `at ${formatInstant(new Date(health.errorUpdatedAt).toISOString())}`
                    : ''}
                </p>
                <CommandError error={health.error} onRetry={() => void health.refetch()} />
                {health.updatedAt ? (
                  <p className="caption">
                    Last successful check {formatInstant(health.updatedAt.toISOString())}.
                  </p>
                ) : null}
              </>
            ) : (
              <dl className="ia-dl">
                <dt>API</dt>
                <dd>
                  <StatusBadge tone="success" label={`API ${data.status}`} /> version {data.version}
                </dd>
                <dt>Database</dt>
                <dd>
                  <StatusBadge
                    tone={data.database === 'ok' ? 'success' : 'danger'}
                    label={`database ${data.database}`}
                  />
                </dd>
                <dt>This dashboard</dt>
                <dd>version {services.config.appVersion}</dd>
              </dl>
            )}
            <Button
              variant="secondary"
              busy={health.isFetching}
              onClick={() => void health.refetch()}
            >
              {health.isFetching ? 'Checking connection' : 'Check again'}
            </Button>
          </>
        )}
      </InsightQueryBoundary>
    </section>
  );
}

type IntegrationGate = Schema<'IntegrationGate'>;

function AdapterRow({ adapter }: { adapter: Schema<'IntegrationAdapter'> }) {
  return (
    <li>
      <span className="row-title">
        {adapter.adapter.name} · {adapter.port}
      </span>{' '}
      <StatusBadge
        tone={adapter.adapter.kind === 'fake' ? 'info' : 'neutral'}
        label={ADAPTER_KIND_LABELS[adapter.adapter.kind]}
      />{' '}
      <StatusBadge
        tone={adapter.productionAllowed ? 'warning' : 'neutral'}
        label={adapter.productionAllowed ? 'may serve production' : 'never serves production'}
      />
      <span className="caption">
        {' '}
        {adapter.id}
        {adapter.scenarios.length > 0
          ? ` · reproduces ${adapter.scenarios.map((s) => SCENARIO_LABELS[s]).join(', ')}`
          : ''}
        {adapter.reconciliationOwner
          ? ` · outcomes reconciled by ${roleLabel(adapter.reconciliationOwner)}`
          : ''}
      </span>
    </li>
  );
}

function GateRow({ gate }: { gate: IntegrationGate }) {
  const title = gateTitle(gate.gate);
  const fields = Object.entries(REGISTER_FIELD_LABELS) as [
    keyof Schema<'IntegrationRegister'>,
    string,
  ][];
  const recorded = fields.filter(([key]) => gate.register[key] !== null).length;
  return (
    <li aria-labelledby={`gate-${gate.gate}`}>
      <div className="row-text">
        <span className="row-title" id={`gate-${gate.gate}`}>
          {title}
        </span>
        {gate.status === 'pending_decision' ? (
          <StatusBadge tone="pending" label="Waiting on a decision" />
        ) : (
          <StatusBadge tone="info" label={gate.status} />
        )}
        <span className="caption">
          Provider not selected: {gate.decisionRef} (owner: {decisionOwner(gate.decisionRef)}).
        </span>
        <span className="caption">
          Evidence ({EVIDENCE_LEVELS.join(' → ')}):{' '}
          {gate.evidenceLevel ?? 'not recorded until a provider is selected'}.
        </span>
        <details className="ia-definition">
          <summary>
            Register fields (§5.1): {recorded} of {fields.length} recorded
          </summary>
          <dl className="ia-dl">
            {fields.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{gate.register[key] ?? `Not recorded (pending ${gate.decisionRef})`}</dd>
              </div>
            ))}
          </dl>
        </details>
        {gate.adapters.length === 0 ? (
          <span className="caption">No adapter is registered behind this gate.</span>
        ) : (
          <ul aria-label={`Adapters behind ${title}`}>
            {gate.adapters.map((adapter) => (
              <AdapterRow key={adapter.id} adapter={adapter} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function ProviderGates() {
  const register = useApiQuery({ path: '/admin/integrations' });
  return (
    <section className="ia-section" aria-labelledby="providers-title">
      <h3 id="providers-title">Provider connections</h3>
      <InsightQueryBoundary
        query={register}
        label="the integration register"
        isEmpty={(data) => data.gates.length === 0}
        empty={{
          title: 'No providers configured',
          description: 'The API listed no provider-selection gate: it runs on test adapters only.',
        }}
        deniedDescription="Reading the integration register is for the general manager and system administration."
      >
        {(data) => {
          const live = data.gates.flatMap((g) => g.adapters).filter((a) => a.productionAllowed);
          return (
            <>
              <p className="caption" role="status">
                {live.length === 0
                  ? 'No provider is selected: the API runs against its test adapters only, and no production account exists (§5.2).'
                  : `${live.length} adapter${live.length === 1 ? '' : 's'} may serve production.`}
              </p>
              <ul className="list" aria-label="Provider-selection gates">
                {data.gates.map((gate) => (
                  <GateRow key={gate.gate} gate={gate} />
                ))}
              </ul>
            </>
          );
        }}
      </InsightQueryBoundary>
      <p className="caption">
        <Link to="/admin/provider-events">Provider events received by the inbox</Link>
      </p>
    </section>
  );
}

function SettingsValues({ settings, label }: { settings: Record<string, unknown>; label: string }) {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return <span className="caption">No {label} recorded.</span>;
  }
  return (
    <dl className="ia-dl" aria-label={label}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{formatScalar(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function FacilitySettingsRow({ facility }: { facility: Schema<'AdminFacilitySettings'> }) {
  const now = useNow(60_000);
  const valid = isValidTimeZone(facility.timezone);
  const status = FACILITY_STATUS_BADGES[facility.status];
  return (
    <li aria-labelledby={`facility-settings-${facility.id}`}>
      <div className="row-text">
        <span className="row-title" id={`facility-settings-${facility.id}`}>
          {facility.name}
        </span>
        <StatusBadge tone={status.tone} label={status.label} />
        <span>
          Time zone: {facility.timezone}{' '}
          <StatusBadge
            tone={valid ? 'success' : 'warning'}
            label={valid ? 'valid IANA time zone' : 'not a recognised IANA time zone'}
          />
        </span>
        <span className="caption">
          {valid
            ? `Local date ${localDateOf(now, facility.timezone)}; facility-local times on every screen use this zone (SPK-SCHED-008).`
            : 'Facility-local times cannot be shown until the time zone is a valid IANA name (SPK-SCHED-008).'}
        </span>
        <span className="caption">
          {facility.slug} · revision {facility.revision} · address{' '}
          {facility.address
            ? formatScalar(facility.address)
            : `not set (${DECISIONS.facilityInventory.ids.join(', ')})`}
        </span>
        <SettingsValues settings={facility.settings} label={`settings of ${facility.name}`} />
      </div>
    </li>
  );
}

function OrganizationSettings() {
  const settings = useApiQuery({ path: '/admin/settings' });
  return (
    <section className="ia-section" aria-labelledby="facility-settings-title">
      <h3 id="facility-settings-title">Organization and facility settings</h3>
      <InsightQueryBoundary
        query={settings}
        label="the organization and facility settings"
        empty={{ title: 'Not available', description: '' }}
        deniedDescription="Reading settings is for the general manager and system administration."
      >
        {(data) => {
          const org = data.organization;
          const status = ORGANIZATION_STATUS_BADGES[org.status];
          return (
            <>
              <dl className="ia-dl">
                <dt>Organization</dt>
                <dd>
                  {org.name} ({org.slug}) <StatusBadge tone={status.tone} label={status.label} /> ·
                  revision {org.revision}
                </dd>
                <dt>Organization settings</dt>
                <dd>
                  <SettingsValues settings={org.settings} label="organization settings" />
                </dd>
              </dl>
              {data.facilities.length === 0 ? (
                <p className="caption">No facility is configured for this organization.</p>
              ) : (
                <ul className="list" aria-label="Facility settings">
                  {data.facilities.map((facility) => (
                    <FacilitySettingsRow key={facility.id} facility={facility} />
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </InsightQueryBoundary>
      <ApiGap title="Editing organization and facility settings">
        Changing organization or facility settings, such as a facility time zone, is proposed and
        has no API command yet ({DECISIONS.providers.ids.join(', ')}); addresses wait on{' '}
        {DECISIONS.facilityInventory.ids.join(', ')}. They are read-only here.
      </ApiGap>
      <p className="caption">
        <Link to="/admin/capabilities">
          Capability switches (conditional capabilities, DEC-016)
        </Link>
      </p>
    </section>
  );
}

function PolicyApprovals({ policy }: { policy: PolicyVersion }) {
  const approvals = useApiQuery({
    path: '/policy-versions/{id}/approvals',
    request: { path: { id: policy.id } },
  });
  return (
    <InsightQueryBoundary
      query={approvals}
      label={`approvals of ${policy.title}`}
      isEmpty={(data) => data.length === 0}
      empty={{ title: 'No approvals recorded', description: 'This version has no approval yet.' }}
    >
      {(data) => (
        <ul aria-label={`Approvals of ${policy.title}`}>
          {data.map((approval) => (
            <li key={approval.id}>
              {approval.decision} {formatInstant(approval.occurredAt)}
              {approval.reason ? `: ${approval.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
    </InsightQueryBoundary>
  );
}

function PolicyRow({ policy }: { policy: PolicyVersion }) {
  const [open, setOpen] = useState(false);
  const badge = POLICY_BADGES[policy.approvalStatus];
  return (
    <li aria-labelledby={`policy-${policy.id}`}>
      <div className="row-text">
        <span className="row-title" id={`policy-${policy.id}`}>
          {policy.title} · {policy.key} version {policy.version}
        </span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span className="caption">
          {policy.kind} · effective {formatInstant(policy.effectiveFrom)}
          {policy.effectiveTo ? ` to ${formatInstant(policy.effectiveTo)}` : ', open-ended'}
          {policy.approvedAt ? ` · approved ${formatInstant(policy.approvedAt)}` : ''}
          {policy.retiredAt
            ? ` · retired ${formatInstant(policy.retiredAt)}${policy.retiredReason ? `: ${policy.retiredReason}` : ''}`
            : ''}
        </span>
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-label={`Approvals of ${policy.title} version ${policy.version}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide approvals' : 'Show approvals'}
        </Button>
        {open ? <PolicyApprovals policy={policy} /> : null}
      </div>
    </li>
  );
}

function PolicyVersions() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <section className="ia-section" aria-labelledby="policies-title">
      <h3 id="policies-title">Policy versions and effective dates</h3>
      <div className="ia-filters">
        <SelectField
          label="Kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setCursors([null]);
          }}
          placeholder="All kinds"
          options={POLICY_KINDS.map((k) => ({ value: k, label: k }))}
        />
        <SelectField
          label="Approval status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setCursors([null]);
          }}
          placeholder="All statuses"
          options={['draft', 'approved', 'retired'].map((s) => ({ value: s, label: s }))}
        />
      </div>
      {cursors.map((cursor, index) => (
        <PolicyPage
          key={`${kind}:${status}:${cursor ?? 'first'}`}
          kind={kind}
          status={status}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
        />
      ))}
    </section>
  );
}

function PolicyPage({
  kind,
  status,
  cursor,
  isLast,
  onMore,
}: {
  kind: string;
  status: string;
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const policies = useApiQuery({
    path: '/policy-versions',
    request: {
      query: {
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(kind ? { kind: kind as Schema<'PolicyKind'> } : {}),
        ...(status ? { approvalStatus: status as Schema<'PolicyApprovalStatus'> } : {}),
      },
    },
  });
  return (
    <InsightQueryBoundary
      query={policies}
      label="policy versions"
      isEmpty={(data) => data.items.length === 0 && cursor === null}
      empty={{
        title: 'No policy versions',
        description: 'Policy versions recorded for programs and offerings appear here.',
      }}
    >
      {(data) => (
        <>
          <ul className="list" aria-label="Policy versions">
            {data.items.map((policy) => (
              <PolicyRow key={policy.id} policy={policy} />
            ))}
          </ul>
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor as string)}>
              Show more policy versions
            </Button>
          ) : null}
        </>
      )}
    </InsightQueryBoundary>
  );
}

export function IntegrationsConfigScreen() {
  return (
    <section aria-labelledby="integrations-title" className="ia-screen">
      <h2 id="integrations-title">Integrations and configuration</h2>
      <AdminNav />
      <PendingNote decisions={DECISIONS.providers.ids} owner={DECISIONS.providers.owner}>
        Every external provider and the ownership of every production account.
      </PendingNote>
      <ProviderGates />
      <ApiConnection />
      <OrganizationSettings />
      <PolicyVersions />
    </section>
  );
}
