/**
 * SCR-S-47 Integrations and configuration (§5.1, §5.2, SPK-SCHED-008, DEC-013, DEC-018 to DEC-023;
 * SPK-UX-008, SPK-UX-009).
 *
 * - Provider connections: the six §5.2 provider-selection gates, each shown as waiting on its
 *   decision with its owner. No provider, account or evidence level is invented: until a provider
 *   is selected and approved the API runs against its test adapters, and the API publishes no
 *   integration register, so the §5.1 fields and the documented → tested → accepted → live
 *   evidence are shown as not available yet.
 * - API connection: `GET /v1/health` (version and database), "Check again" is the connection test.
 * - Facility settings: name, time zone (checked as an IANA name, SPK-SCHED-008) and local date as
 *   the Today feed returns them; the API has no organization or facility settings command, so they
 *   are read-only here.
 * - Policy versions and effective dates: `GET /v1/policy-versions` with their approvals.
 * Offline, everything is read-only with the age of what is shown.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import {
  ApiGap,
  CommandError,
  InsightQueryBoundary,
  PendingNote,
} from '../../features/insight-admin/feedback';
import { SelectField } from '../../features/insight-admin/fields';
import { formatInstant, isValidTimeZone, shortId } from '../../features/insight-admin/format';
import {
  DECISIONS,
  EVIDENCE_LEVELS,
  POLICY_BADGES,
  PROVIDER_GATES,
  REGISTER_FIELDS,
} from '../../features/insight-admin/labels';
import { useApp } from '../../providers/AppProviders';
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

function ProviderGates() {
  return (
    <section className="ia-section" aria-labelledby="providers-title">
      <h3 id="providers-title">Provider connections</h3>
      <p className="caption">
        No provider is selected. Until the technical lead and the account owner approve one (§5.2),
        the API runs against its test adapters only, and no production account exists.
      </p>
      <ul className="list" aria-label="Provider-selection gates">
        {PROVIDER_GATES.map((gate) => (
          <li key={gate.id} aria-labelledby={`gate-${gate.id}`}>
            <div className="row-text">
              <span className="row-title" id={`gate-${gate.id}`}>
                {gate.title}
              </span>
              <StatusBadge tone="pending" label="Waiting on a decision" />
              <span className="caption">
                Provider not selected: {gate.decision} (owner: {DECISIONS.providers.owner}; part of{' '}
                {DECISIONS.providers.ids.join(', ')}).
              </span>
              <span className="caption">
                Evidence ({EVIDENCE_LEVELS.join(' → ')}): not recorded until a provider is selected.
              </span>
            </div>
          </li>
        ))}
      </ul>
      <ApiGap title="Integration register">
        The API does not publish the §5.1 register ({REGISTER_FIELDS.join(', ').toLowerCase()}) or
        the evidence level of each capability, so they cannot be shown or tested from here.
      </ApiGap>
    </section>
  );
}

function FacilitySettings() {
  const { choices, loading, error, refetch } = useFacilityChoices();
  const me = useApiQuery({ path: '/me' });
  return (
    <section className="ia-section" aria-labelledby="facility-settings-title">
      <h3 id="facility-settings-title">Organization and facility settings</h3>
      {me.data?.principal.organizationId ? (
        <p className="caption">Organization {shortId(me.data.principal.organizationId)}</p>
      ) : null}
      {loading ? (
        <p role="progressbar" aria-busy="true" aria-label="Loading facility settings">
          Loading facility settings…
        </p>
      ) : error ? (
        <CommandError error={error} onRetry={refetch} />
      ) : choices.length === 0 ? (
        <p className="caption">No facility is listed for you.</p>
      ) : (
        <ul className="list" aria-label="Facility settings">
          {choices.map((facility) => {
            const valid = facility.timezone ? isValidTimeZone(facility.timezone) : false;
            return (
              <li key={facility.id}>
                <div className="row-text">
                  <span className="row-title">{facility.label}</span>
                  <span>
                    Time zone: {facility.timezone ?? 'not reported'}{' '}
                    <StatusBadge
                      tone={valid ? 'success' : 'warning'}
                      label={valid ? 'valid IANA time zone' : 'not a recognised IANA time zone'}
                    />
                  </span>
                  <span className="caption">
                    Local date {facility.localDate ?? 'not reported'}; facility-local times on every
                    screen use this zone (SPK-SCHED-008).
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ApiGap title="Editing organization and facility settings">
        The API has no command to change organization or facility settings, such as the facility
        time zone, so they are read-only here.
      </ApiGap>
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
      <PendingNote decisions={DECISIONS.providers.ids} owner={DECISIONS.providers.owner}>
        Every external provider and the ownership of every production account.
      </PendingNote>
      <ProviderGates />
      <ApiConnection />
      <FacilitySettings />
      <PolicyVersions />
    </section>
  );
}
