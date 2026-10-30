/**
 * SCR-S-47 configuration: the organization's capability switches (§1.6 conditional capabilities,
 * §6.5 Package G; K-12, DEC-016 and DEC-072 to DEC-082; SPK-UX-008, SPK-UX-009, SPK-UX-010).
 *
 * - Every switch from `GET /v1/admin/capabilities`, on or off as text with a glyph (never colour
 *   alone), how it is enforced (`commands` or recorded only), the decisions that may turn it on or
 *   off (DEC-016 and the capability's own record, `applicabilityReferences`, owner Product owner),
 *   the decisions that only shape it, and its last change (decision, reason, who, when, revision).
 *   Every switch starts off; "Never changed" says so instead of inventing a history.
 * - Turning one on or off (`POST /v1/admin/capabilities/{capability}/enable|disable`) is offered
 *   only when `GET /v1/me/permissions` lists `core.manage_capabilities` (system administrators);
 *   the API still decides, and its ACCESS_DENIED is shown with its message. The form names one of
 *   the capability's applicability decisions (none preselected) and a reason; it sends the switch's
 *   revision as `expectedRevision` once it has one, and one Idempotency-Key per intent (reused on
 *   retry). NOT_AN_APPLICABILITY_DECISION, STALE_REVISION and INVALID_TRANSITION (already in that
 *   state) are shown with the API's code; the last two offer "Reload".
 * - A change re-reads `GET /v1/me/permissions` so every gated screen follows the new switch.
 * - The audit history of each switch is read on request (`GET /v1/audit-records`, itself audited).
 * Offline, the switches stay readable with their age and changes are disabled (§4.15).
 */
import {
  CAPABILITY_PRESENTATION,
  PERMISSIONS_QUERY_PREFIX,
  isCapabilityId,
  turnedOffLabel,
  type Schema,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AuditTrail } from '../../features/insight-admin/audit';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  PendingNote,
  detailCodeOf,
} from '../../features/insight-admin/feedback';
import { RadioGroup, TextField } from '../../features/insight-admin/fields';
import { formatInstant } from '../../features/insight-admin/format';
import { DECISIONS, ENFORCEMENT_LABELS } from '../../features/insight-admin/labels';
import { AdminNav } from '../../features/insight-admin/nav';
import { personText, useDisplayNames, type DisplayNames } from '../../features/insight-admin/names';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type Capability = Schema<'Capability'>;

const CAPABILITIES_KEY = ['api', '/admin/capabilities'] as const;
const MANAGE_ACTION = 'core.manage_capabilities';

export function capabilityLabel(capability: string): string {
  return isCapabilityId(capability) ? CAPABILITY_PRESENTATION[capability].label : capability;
}

function ownerOf(capability: string): string {
  return isCapabilityId(capability)
    ? CAPABILITY_PRESENTATION[capability].owner
    : DECISIONS.capabilities.owner;
}

function ChangeCapability({
  capability,
  onDone,
  onCancel,
}: {
  capability: Capability;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const label = capabilityLabel(capability.capability);
  const turningOn = !capability.enabled;
  const invalidate = [CAPABILITIES_KEY, PERMISSIONS_QUERY_PREFIX] as const;
  const enable = useApiCommand('post', '/admin/capabilities/{capability}/enable', { invalidate });
  const disable = useApiCommand('post', '/admin/capabilities/{capability}/disable', {
    invalidate,
  });
  const command = turningOn ? enable : disable;
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const build = () => {
    const next: Record<string, string> = {};
    if (!decision) next.decision = 'Choose the decision that settles this.';
    if (!reason.trim()) next.reason = 'Enter the reason for this change.';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      decisionReference: decision,
      reason: reason.trim(),
      // A switch that was never changed has no revision yet; the state machine still refuses a
      // second "turn on" (INVALID_TRANSITION), so nothing is applied twice.
      ...(capability.revision !== null ? { expectedRevision: capability.revision } : {}),
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void command
      .submit({ path: { capability: capability.capability }, body })
      .then((changed) =>
        onDone(
          `${label} turned ${changed.enabled ? 'on' : 'off'} (${changed.decisionReference ?? decision})`,
        ),
      )
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const reload = () => {
    command.reset();
    void queryClient.invalidateQueries({ queryKey: CAPABILITIES_KEY });
  };
  const notApplicable = detailCodeOf(command.error) === 'NOT_AN_APPLICABILITY_DECISION';
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`${turningOn ? 'Turn on' : 'Turn off'} ${label}`}
      noValidate
    >
      <RadioGroup
        legend="Decision that settles this"
        name={`decision-${capability.capability}`}
        required
        value={decision}
        onChange={setDecision}
        options={capability.applicabilityReferences.map((ref) => ({
          value: ref,
          label: ref,
          description:
            ref === 'DEC-016'
              ? 'Conditional capability applicability (all capabilities)'
              : `The decision record of ${label.toLowerCase()}`,
        }))}
        hint={`Only these decisions can turn ${label.toLowerCase()} on or off. Name the one whose recorded answer this change follows.`}
        error={errors.decision}
      />
      <TextField
        label="Reason"
        required
        value={reason}
        onChange={setReason}
        hint="Recorded with the change, in its history and in the audit."
        error={errors.reason}
      />
      <div className="ia-actions">
        <Button type="submit" busy={command.isProcessing} disabled={!online}>
          {turningOn ? `Turn on ${label}` : `Turn off ${label}`}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Keep it {turningOn ? 'off' : 'on'}
        </Button>
      </div>
      {!online ? <p className="caption">Changing a switch needs a connection.</p> : null}
      {notApplicable ? (
        <p className="caption">
          Only {capability.applicabilityReferences.join(' or ')} can turn {label.toLowerCase()} on
          or off.
        </p>
      ) : null}
      <CommandError
        error={command.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
        onReload={reload}
      />
    </form>
  );
}

function ManageNote({ capability }: { capability: Capability }) {
  const permissions = usePermissions();
  const allowed = permissions.isPermitted(MANAGE_ACTION);
  if (allowed === false) {
    return (
      <p className="caption">
        Not available to you: only a system administrator turns a switch on or off.
      </p>
    );
  }
  if (allowed === undefined && permissions.query.error) {
    return (
      <CommandError
        error={permissions.query.error}
        onRetry={() => void permissions.query.refetch()}
      />
    );
  }
  if (allowed === undefined) {
    return (
      <p className="caption" aria-busy="true">
        Checking whether you may change {capabilityLabel(capability.capability).toLowerCase()}…
      </p>
    );
  }
  return null;
}

function CapabilityRow({ capability, names }: { capability: Capability; names: DisplayNames }) {
  const permissions = usePermissions();
  const canManage = permissions.isPermitted(MANAGE_ACTION) === true;
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const label = capabilityLabel(capability.capability);
  const own = capability.applicabilityReferences.filter((ref) => ref !== 'DEC-016');
  return (
    <li aria-labelledby={`capability-${capability.capability}`}>
      <div className="row-text">
        <span className="row-title" id={`capability-${capability.capability}`}>
          {label}
        </span>
        <StatusBadge
          tone={capability.enabled ? 'success' : 'neutral'}
          label={capability.enabled ? `${label} turned on` : turnedOffLabel(label)}
        />
        <span>{capability.description}</span>
        <span className="caption">{ENFORCEMENT_LABELS[capability.enforcement]}</span>
        <span className="caption">
          Decided by DEC-016
          {own.length > 0
            ? ` and its own decision ${own.join(', ')}`
            : ' (it has no own record)'}{' '}
          (owner: {ownerOf(capability.capability)}).
          {capability.relatedDecisions.length > 0
            ? ` Shaped by ${capability.relatedDecisions.join(', ')}, which never turn it on.`
            : ''}
        </span>
        <span className="caption">Checked by: {capability.owningModules.join(', ')}</span>
        {capability.changedAt ? (
          <span className="caption">
            Last change {formatInstant(capability.changedAt)} naming{' '}
            {capability.decisionReference ?? 'no decision'} by{' '}
            {personText(names, capability.changedByPersonId)}
            {capability.reason ? `: ${capability.reason}` : ''} · revision {capability.revision}
          </span>
        ) : (
          <span className="caption">Never changed: off since the start, as every switch is.</span>
        )}
      </div>
      <CommandSuccess message={success} />
      {canManage ? (
        open ? (
          <ChangeCapability
            key={capability.revision ?? 0}
            capability={capability}
            onCancel={() => setOpen(false)}
            onDone={(message) => {
              setOpen(false);
              setSuccess(message);
            }}
          />
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setSuccess(null);
              setOpen(true);
            }}
          >
            {capability.enabled ? `Turn off ${label}` : `Turn on ${label}`}
          </Button>
        )
      ) : (
        <ManageNote capability={capability} />
      )}
      <AuditTrail targetType="capability" targetId={capability.capability} subject={label} />
    </li>
  );
}

function CapabilityList({ items }: { items: Capability[] }) {
  const names = useDisplayNames(items.map((c) => c.changedByPersonId));
  const on = items.filter((c) => c.enabled).length;
  return (
    <>
      <p className="caption" role="status">
        {on} of {items.length} switches turned on.
      </p>
      <ul className="list" aria-label="Capability switches">
        {items.map((capability) => (
          <CapabilityRow key={capability.capability} capability={capability} names={names} />
        ))}
      </ul>
    </>
  );
}

export function CapabilitiesScreen() {
  const capabilities = useApiQuery({ path: '/admin/capabilities' });
  return (
    <section aria-labelledby="capabilities-title" className="ia-screen">
      <h2 id="capabilities-title">Capability switches</h2>
      <AdminNav />
      <PendingNote decisions={DECISIONS.capabilities.ids} owner={DECISIONS.capabilities.owner}>
        Which conditional capabilities the complex uses, and when each is turned on, is not decided.
        Every switch starts off; a system administrator turns one on only by naming the decision
        that settled it.
      </PendingNote>
      <InsightQueryBoundary
        query={capabilities}
        label="the capability switches"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No capability switches',
          description: 'The API listed no conditional capability for this organization.',
        }}
        unavailableOffline={['turning a capability on or off']}
        deniedDescription="Reading the capability switches is for the general manager and system administration."
      >
        {(data) => <CapabilityList items={data.items} />}
      </InsightQueryBoundary>
    </section>
  );
}
