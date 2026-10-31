/**
 * SCR-S-56 access policies of a device (§3.16 Access hardware "access policy, revocation";
 * SPK-ENTRY-002, SPK-COND-004): drafts, the active one and retired ones
 * (`GET /v1/access-devices/{id}/policies`), with four eyes: a draft is written by one person
 * (`POST /v1/access-devices/{id}/policies`, entry.draft_access_policy) and approved by another
 * (`POST /v1/access-policies/{id}/approve`, entry.approve_access_policy, with its revision), which
 * retires the previous policy and synchronizes the device. Its author is not offered the approval
 * and is told why; the API refuses it anyway (author_cannot_approve). Withdrawing a draft or
 * retiring the active policy (`POST /v1/access-policies/{id}/retire`, never gated) sends the
 * device deny-all when nothing replaces it.
 *
 * Only active passes are ever admitted; the schedule is weekly windows in the facility's local
 * time (SPK-SCHED-008), with no window assumed. A window's problems are reported on the control
 * that has them (days, from, to; SPK-UX-009). A retirement refused as stale offers Reload, and the
 * next attempt sends the revision just read (§4.9). Each policy's audit history is read when asked
 * (`GET /v1/audit-records?targetType=access_policy&targetId=`, itself audited, §4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { AuditTrail } from '../../../features/pos-access-accounting/AuditTrail';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import {
  HOLDER_KINDS,
  POLICY_STATUS,
  WEEKDAYS,
} from '../../../features/pos-access-accounting/labels';
import { useMyPersonId } from '../../../features/pos-access-accounting/me';
import { ACCESS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import { formatInstant, shortRef } from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { useNow } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { CheckboxGroup, TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { DEVICES_QUERY_PREFIX } from './paths';

type Device = Schema<'AccessDevice'>;
type Policy = Schema<'AccessPolicy'>;
type Window = Schema<'AccessScheduleWindow'>;

const POLICIES_PREFIX = ['api', '/access-devices/{id}/policies'] as const;
const POLICY_COMMAND = { invalidate: [POLICIES_PREFIX, DEVICES_QUERY_PREFIX] } as const;
const DAY_LABEL = new Map(WEEKDAYS.map((d) => [d.value, d.label]));
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** "Monday, Tuesday: 06:00 to 22:00" (facility-local wall-clock times). */
function windowText(w: Window): string {
  return `${w.days.map((d) => DAY_LABEL.get(d) ?? d).join(', ')}: ${w.from} to ${w.to}`;
}

/** The facility zone's short name ("PDT"), for "facility time" captions. */
function zoneName(zone: string | null, at: Date): string {
  if (!zone) return 'the facility time zone (not loaded)';
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? zone
    );
  } catch {
    return zone;
  }
}

export function Policies({ device, zone }: { device: Device; zone: string | null }) {
  const offer = useOffer();
  const policies = useApiQuery({
    path: '/access-devices/{id}/policies',
    request: { path: { id: device.id } },
  });
  const active = device.status === 'active';
  return (
    <section aria-labelledby="access-policies-title">
      <h4 id="access-policies-title">Access policies</h4>
      <p className="caption">
        Only active passes are admitted. Schedule times are local to the facility (
        {zone ?? 'zone not loaded'}).
      </p>
      <QueryBoundary
        query={policies}
        label="access policies"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No policies',
          description: 'The device admits nobody (deny-all) until a policy is approved.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Access policies">
            {items.map((p) => (
              <PolicyRow key={p.id} policy={p} device={device} zone={zone} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      {active &&
      offer.capabilityOn('access_hardware') &&
      offer.allowed(ACCESS_ACTIONS.draftPolicy, device.facilityId) ? (
        <DraftPolicy device={device} zone={zone} />
      ) : null}
    </section>
  );
}

function PolicyRow({
  policy,
  device,
  zone,
}: {
  policy: Policy;
  device: Device;
  zone: string | null;
}) {
  const offer = useOffer();
  const online = useOnline();
  const me = useMyPersonId();
  const queryClient = useQueryClient();
  const approve = useApiCommand('post', '/access-policies/{id}/approve', POLICY_COMMAND);
  const retire = useApiCommand('post', '/access-policies/{id}/retire', POLICY_COMMAND);
  const approveIntent = useIntentForm(approve);
  const isAuthor = me !== null && policy.authoredByPersonId === me;
  const canApprove =
    policy.status === 'draft' &&
    offer.capabilityOn('access_hardware') &&
    offer.allowed(ACCESS_ACTIONS.approvePolicy, device.facilityId);
  const canRetire =
    policy.status !== 'retired' && offer.allowed(ACCESS_ACTIONS.retirePolicy, device.facilityId);
  return (
    <li>
      <div className="row-text">
        <span className="row-title">Policy {shortRef(policy.id)}</span>
        <StatusBadge {...POLICY_STATUS[policy.status]} />
        <span>
          Admits{' '}
          {policy.allowedHolderKinds
            .map((k) => HOLDER_KINDS.find((h) => h.value === k)?.label.toLowerCase() ?? k)
            .join(' and ')}{' '}
          ({policy.allowedPassStatuses.join(', ')} only)
        </span>
        <ul aria-label={`Schedule of policy ${shortRef(policy.id)}`}>
          {policy.schedule.map((w, i) => (
            <li key={i}>{windowText(w)}</li>
          ))}
        </ul>
        <span className="caption">
          Drafted by <PersonName id={policy.authoredByPersonId} fallback="Staff" />
          {policy.approvedByPersonId ? (
            <>
              {' '}
              · approved by <PersonName id={policy.approvedByPersonId} fallback="Staff" /> on{' '}
              {formatInstant(policy.approvedAt, zone)}
            </>
          ) : null}
          {policy.retiredAt ? ` · retired: ${policy.retiredReason ?? 'no reason stated'}` : ''}
        </span>
      </div>
      {canApprove ? (
        isAuthor ? (
          <p className="caption">
            You drafted this policy: another person approves it (four eyes).
          </p>
        ) : (
          <div>
            <Button
              busy={approve.isProcessing}
              disabled={!online || approveIntent.locked}
              onClick={() =>
                void approveIntent.send({
                  path: { id: policy.id },
                  body: { expectedRevision: policy.revision },
                })
              }
            >
              Approve policy {shortRef(policy.id)}
            </Button>
            <CommandError
              error={approve.error}
              onRetry={approveIntent.retry}
              onReload={() => {
                approveIntent.restart();
                void queryClient.invalidateQueries({ queryKey: POLICIES_PREFIX });
              }}
            />
          </div>
        )
      ) : null}
      {canRetire ? (
        <div>
          <ReasonAction
            label={
              policy.status === 'draft'
                ? `Withdraw draft ${shortRef(policy.id)}`
                : `Retire policy ${shortRef(policy.id)}`
            }
            confirmLabel={policy.status === 'draft' ? 'Withdraw the draft' : 'Retire the policy'}
            reasonLabel="Reason"
            explanation={
              policy.status === 'active'
                ? 'Without an approved replacement the device is sent deny-all and admits nobody.'
                : 'The draft is withdrawn; nothing changes on the device.'
            }
            busy={retire.isProcessing}
            disabled={!online}
            onConfirm={async (reason) => {
              try {
                await retire.submit({
                  path: { id: policy.id },
                  body: { reason, expectedRevision: policy.revision },
                });
                return true;
              } catch {
                return false;
              }
            }}
          />
          <CommandError
            error={retire.error}
            onReload={() => {
              retire.reset();
              void queryClient.invalidateQueries({ queryKey: POLICIES_PREFIX });
            }}
          />
        </div>
      ) : null}
      <AuditTrail
        targetType="access_policy"
        targetId={policy.id}
        subject={`policy ${shortRef(policy.id)}`}
        zone={zone}
      />
    </li>
  );
}

interface WindowDraft {
  days: string[];
  from: string;
  to: string;
}

interface WindowErrors {
  days: string | null;
  from: string | null;
  to: string | null;
}

/** Each problem on the control that has it; the order of the times is reported on "to". */
function windowErrors(w: WindowDraft): WindowErrors {
  const fromValid = LOCAL_TIME.test(w.from);
  const toValid = LOCAL_TIME.test(w.to);
  return {
    days: w.days.length === 0 ? 'Choose at least one day.' : null,
    from: fromValid ? null : 'Enter the start as HH:MM.',
    to: !toValid
      ? 'Enter the end as HH:MM.'
      : fromValid && w.from >= w.to
        ? 'The window ends after it starts.'
        : null,
  };
}

function windowValid(w: WindowDraft): boolean {
  const e = windowErrors(w);
  return e.days === null && e.from === null && e.to === null;
}

function DraftPolicy({ device, zone }: { device: Device; zone: string | null }) {
  const online = useOnline();
  const now = useNow();
  const [holders, setHolders] = useState<string[]>([]);
  const [windows, setWindows] = useState<WindowDraft[]>([{ days: [], from: '', to: '' }]);
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/access-devices/{id}/policies', POLICY_COMMAND);
  const intent = useIntentForm(command);
  const update = (index: number, change: Partial<WindowDraft>) =>
    setWindows((ws) => ws.map((w, i) => (i === index ? { ...w, ...change } : w)));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (holders.length === 0 || !windows.every(windowValid)) return;
    const created = await intent.send({
      path: { id: device.id },
      body: {
        allowedHolderKinds: holders as ('person' | 'household')[],
        schedule: windows.map((w) => ({
          days: w.days as Window['days'],
          from: w.from,
          to: w.to,
        })),
      },
    });
    if (created) {
      setHolders([]);
      setWindows([{ days: [], from: '', to: '' }]);
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Draft an access policy"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Draft an access policy</h4>
      <p>
        Another person approves the draft (four eyes); approving it retires the policy in force and
        synchronizes the device. Times are {zoneName(zone, now)}.
      </p>
      <CheckboxGroup
        legend="Admit holders of"
        options={HOLDER_KINDS}
        value={holders}
        onChange={setHolders}
        error={touched && holders.length === 0 ? 'Choose who the device admits.' : null}
        disabled={intent.locked}
      />
      {windows.map((w, i) => {
        const errors = touched ? windowErrors(w) : null;
        return (
          <fieldset key={i} className="fieldset" aria-label={`Window ${i + 1}`}>
            <legend>Window {i + 1}</legend>
            <CheckboxGroup
              legend={`Days of window ${i + 1}`}
              options={WEEKDAYS}
              value={w.days}
              onChange={(days) => update(i, { days })}
              error={errors?.days ?? null}
              disabled={intent.locked}
            />
            <TextField
              label={`Window ${i + 1} from`}
              hint="HH:MM, 24-hour, facility time."
              value={w.from}
              onChange={(from) => update(i, { from })}
              error={errors?.from ?? null}
              disabled={intent.locked}
            />
            <TextField
              label={`Window ${i + 1} to`}
              hint="HH:MM, 24-hour; 24:00 ends the day."
              value={w.to}
              onChange={(to) => update(i, { to })}
              error={errors?.to ?? null}
              disabled={intent.locked}
            />
            {windows.length > 1 ? (
              <Button
                variant="secondary"
                disabled={intent.locked}
                onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
              >
                Remove window {i + 1}
              </Button>
            ) : null}
          </fieldset>
        );
      })}
      <div className="actions-row">
        <Button
          variant="secondary"
          disabled={intent.locked || windows.length >= 28}
          onClick={() => setWindows((ws) => [...ws, { days: [], from: '', to: '' }])}
        >
          Add a window
        </Button>
        <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
          Save the draft
        </Button>
      </div>
      {command.data && !command.error ? (
        <p role="status">
          Draft {shortRef(command.data.id)} saved. Another person approves it before the device uses
          it.
        </p>
      ) : null}
      <OfflineCaption action="drafting a policy" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}
