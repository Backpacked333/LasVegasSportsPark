/**
 * SCR-S-14 offering setup: the offering's configuration (`PATCH /v1/offerings/{id}` with
 * `expectedRevision`, §4.9), its sessions (add, cancel with a reason), its price rule versions
 * (SPK-PAY-001: an effective rule is never edited, a change is a new version; amounts are integer
 * minor units with a currency), and "copy as draft" (SPK-CAT-003: payments, attendance,
 * enrollments, results and permissions are never copied). Publication is SCR-S-15.
 *
 * Staff details come only from the API's staff view (`staff` is null for other readers), so a
 * viewer without it sees the offering as not available for setup. Session times and the price
 * effective dates are wall-clock time in the facility's zone when the API states it
 * (SPK-SCHED-008). Taxes and fees are whatever finance enters: approved values are pending DEC-007.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { useFacilities } from '../../features/registration-finance/facilities';
import {
  CheckboxField,
  Facts,
  SelectField,
  TextArea,
  TextField,
} from '../../features/registration-finance/fields';
import {
  formatDate,
  formatInstant,
  formatMoney,
  localToInstant,
  parseMoneyInput,
} from '../../features/registration-finance/format';
import {
  CAPACITY_UNIT,
  EDITABLE_PUBLICATION_STATES,
  OFFERING_KIND,
  PUBLICATION_STATE,
  SESSION_STATUS,
} from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { OfferingForm } from './OfferingForm';

type Offering = Schema<'Offering'>;
type ChargeLine = Schema<'ChargeLine'>;

const OFFERING_KEY = ['api', '/offerings/{id}'] as const;

function EditOffering({ offering }: { offering: Offering }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const { ready } = useFacilities();
  const update = useApiCommand('patch', '/offerings/{id}', {
    invalidate: [OFFERING_KEY, ['api', '/programs/{id}/offerings']],
  });
  const editable = EDITABLE_PUBLICATION_STATES.includes(offering.publicationState);
  const reload = () => {
    update.reset();
    void queryClient.invalidateQueries({ queryKey: OFFERING_KEY });
  };
  return (
    <section className="rf-panel" aria-labelledby="offering-config-title">
      <h3 id="offering-config-title">Configuration</h3>
      {offering.publicationState !== 'draft' && editable ? (
        <p className="caption">
          This offering is {PUBLICATION_STATE[offering.publicationState].label}: changes must keep
          its required configuration, and the API refuses a change that would remove it.
        </p>
      ) : null}
      {editable && !ready ? <StateView variant="loading" label="the facility time zone" /> : null}
      {editable && ready ? (
        <OfferingForm
          mode="edit"
          programId={offering.programId}
          initial={offering}
          busy={update.isProcessing}
          disabled={!online}
          serverErrors={fieldErrorsOf(update.error)}
          onUpdate={(body) => {
            update.submit({ path: { id: offering.id }, body }).catch(() => undefined);
          }}
        />
      ) : null}
      {!editable ? (
        <p>
          A {PUBLICATION_STATE[offering.publicationState].label} offering can no longer be edited.
          Copy it as a new draft instead.
        </p>
      ) : null}
      <OfflineCaption action="saving the offering" />
      {update.status === 'success' ? (
        <p role="status">Offering saved (revision {update.data?.staff?.revision}).</p>
      ) : null}
      <CommandError error={update.error} onReload={reload} />
    </section>
  );
}

function SessionRow({
  session,
  zone,
}: {
  session: Schema<'OfferingSession'>;
  zone: string | null;
}) {
  const online = useOnline();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const cancel = useApiCommand('post', '/sessions/{id}/cancel', {
    invalidate: [['api', '/offerings/{id}/sessions']],
  });
  const title = session.title ?? `Session ${session.sequence}`;
  return (
    <li>
      <div className="row-text">
        <span className="row-title">{title}</span>
        <span className="caption">
          {formatInstant(session.scheduledStart, zone)} to{' '}
          {formatInstant(session.scheduledEnd, zone)}
        </span>
        {session.cancelReason ? (
          <span className="caption">Canceled: {session.cancelReason}</span>
        ) : null}
        <StatusBadge {...SESSION_STATUS[session.status]} />
      </div>
      {session.status === 'scheduled' ? (
        open ? (
          <form
            noValidate
            aria-label={`Cancel ${title}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (reason.trim() === '') return;
              cancel
                .submit({
                  path: { id: session.id },
                  body: { reason: reason.trim(), expectedRevision: session.revision },
                })
                .catch(() => undefined);
            }}
          >
            <TextArea
              label={`Reason for canceling ${title}`}
              required
              value={reason}
              onChange={setReason}
              error={fieldErrorsOf(cancel.error).reason}
            />
            <div className="rf-actions">
              <Button
                type="submit"
                busy={cancel.isProcessing}
                disabled={!online || reason.trim() === ''}
              >
                Cancel the session
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Keep the session
              </Button>
            </div>
            <CommandError error={cancel.error} />
          </form>
        ) : (
          <Button variant="secondary" aria-label={`Cancel ${title}`} onClick={() => setOpen(true)}>
            Cancel…
          </Button>
        )
      ) : null}
    </li>
  );
}

function Sessions({ offering, zone }: { offering: Offering; zone: string | null }) {
  const online = useOnline();
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offering.id } },
  });
  const add = useApiCommand('post', '/offerings/{id}/sessions', {
    invalidate: [['api', '/offerings/{id}/sessions']],
  });
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = fieldErrorsOf(add.error);
  const zoneLabel = zone
    ? `facility time, ${zone}`
    : 'UTC: the facility time zone is not available';
  return (
    <section className="rf-panel" aria-labelledby="sessions-title">
      <h3 id="sessions-title">Sessions</h3>
      <QueryBoundary
        query={sessions}
        label="sessions"
        isEmpty={(list) => list.length === 0}
        empty={{ title: 'No sessions', description: 'Add the sessions of this offering below.' }}
      >
        {(list) => (
          <ul className="list" aria-label="Sessions">
            {list.map((session) => (
              <SessionRow key={session.id} session={session} zone={zone} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <form
        noValidate
        aria-label="Add a session"
        onSubmit={(event) => {
          event.preventDefault();
          const errors: Record<string, string> = {};
          const scheduledStart = localToInstant(start, zone);
          const scheduledEnd = localToInstant(end, zone);
          if (!scheduledStart) errors.scheduledStart = 'Enter the start date and time.';
          if (!scheduledEnd) errors.scheduledEnd = 'Enter the end date and time.';
          if (scheduledStart && scheduledEnd && scheduledStart >= scheduledEnd) {
            errors.scheduledEnd = 'The session must end after it starts.';
          }
          setLocal(errors);
          if (!scheduledStart || !scheduledEnd || Object.keys(errors).length > 0) return;
          add
            .submit({
              path: { id: offering.id },
              body: {
                scheduledStart,
                scheduledEnd,
                ...(title.trim() ? { title: title.trim() } : {}),
              },
            })
            .then(() => {
              setTitle('');
              setStart('');
              setEnd('');
            })
            .catch(() => undefined);
        }}
      >
        <div className="rf-grid">
          <TextField label="Session title" value={title} onChange={setTitle} error={server.title} />
          <TextField
            label={`Session starts (${zoneLabel})`}
            type="datetime-local"
            required
            value={start}
            onChange={setStart}
            error={local.scheduledStart ?? server.scheduledStart}
          />
          <TextField
            label={`Session ends (${zoneLabel})`}
            type="datetime-local"
            required
            value={end}
            onChange={setEnd}
            error={local.scheduledEnd ?? server.scheduledEnd}
          />
        </div>
        <div className="rf-actions">
          <Button type="submit" busy={add.isProcessing} disabled={!online}>
            Add session
          </Button>
        </div>
        <OfflineCaption action="adding a session" />
        <CommandError error={add.error} />
      </form>
    </section>
  );
}

interface ChargeRow {
  code: string;
  label: string;
  kind: 'tax' | 'fee';
  basis: 'basisPoints' | 'amount';
  value: string;
  inclusive: boolean;
}

function PriceRules({ offering, zone }: { offering: Offering; zone: string | null }) {
  const online = useOnline();
  const rules = useApiQuery({
    path: '/offerings/{id}/price-rules',
    request: { path: { id: offering.id } },
  });
  const create = useApiCommand('post', '/offerings/{id}/price-rules', {
    invalidate: [['api', '/offerings/{id}/price-rules'], OFFERING_KEY],
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('');
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = fieldErrorsOf(create.error);
  const zoneLabel = zone ? `facility time, ${zone}` : 'UTC';
  const updateCharge = (i: number, patch: Partial<ChargeRow>) =>
    setCharges((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const submit = () => {
    const errors: Record<string, string> = {};
    const code = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
    const base = /^[A-Z]{3}$/.test(code) ? parseMoneyInput(price, code, true) : null;
    if (base === null) errors.basePriceMinor = 'Enter the base price, for example 125.00.';
    const effectiveFrom = localToInstant(from, zone);
    const effectiveTo = to ? localToInstant(to, zone) : undefined;
    if (!effectiveFrom) errors.effectiveFrom = 'Enter when this price takes effect.';
    if (to && !effectiveTo) errors.effectiveTo = 'Enter a date and time, or leave empty.';
    const chargeLines: ChargeLine[] = [];
    charges.forEach((row, i) => {
      if (!row.code.trim() || !row.label.trim())
        errors[`chargeLines.${i}`] = 'Enter a code and a label.';
      const amount =
        row.basis === 'basisPoints'
          ? /^\d+$/.test(row.value.trim())
            ? Number(row.value.trim())
            : null
          : /^[A-Z]{3}$/.test(code)
            ? parseMoneyInput(row.value, code, true)
            : null;
      if (amount === null) errors[`chargeLines.${i}`] = 'Enter the rate or the amount.';
      if (amount !== null && row.code.trim() && row.label.trim()) {
        chargeLines.push({
          code: row.code.trim(),
          label: row.label.trim(),
          kind: row.kind,
          inclusive: row.inclusive,
          ...(row.basis === 'basisPoints' ? { basisPoints: amount } : { amountMinor: amount }),
        });
      }
    });
    setLocal(errors);
    if (Object.keys(errors).length > 0 || base === null || !effectiveFrom) return;
    create
      .submit({
        path: { id: offering.id },
        body: {
          effectiveFrom,
          ...(effectiveTo ? { effectiveTo } : {}),
          basePriceMinor: base,
          currency: code,
          chargeLines,
        },
      })
      .catch(() => undefined);
  };

  return (
    <section className="rf-panel" aria-labelledby="price-rules-title">
      <h3 id="price-rules-title">Price and obligations</h3>
      <p className="caption">
        Prices are versioned: an effective rule is never edited, a change is a new version, and
        historical purchases keep their price basis (SPK-PAY-001, SPK-PAY-002). Approved taxes, fees
        and rounding are pending {PENDING.pricesAndTaxes.ids.join(', ')} (owner:{' '}
        {PENDING.pricesAndTaxes.owner}); only what finance enters here is applied.
      </p>
      <QueryBoundary
        query={rules}
        label="price rules"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No price rule',
          description:
            'Publication needs a current or future price rule. Add the first version below.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Price rule versions">
            {[...list]
              .sort((a, b) => b.version - a.version)
              .map((rule) => (
                <li key={rule.id}>
                  <div className="row-text">
                    <span className="row-title">
                      Version {rule.version}: {formatMoney(rule.basePriceMinor, rule.currency)}
                    </span>
                    <span className="caption">
                      Effective {formatInstant(rule.effectiveFrom, zone)}
                      {rule.effectiveTo
                        ? ` until ${formatInstant(rule.effectiveTo, zone)}`
                        : ', no end'}
                    </span>
                    {rule.chargeLines.map((line) => (
                      <span className="caption" key={line.code}>
                        {line.kind === 'tax' ? 'Tax' : 'Fee'} {line.label}:{' '}
                        {line.basisPoints !== undefined
                          ? `${(line.basisPoints / 100).toFixed(2)}%`
                          : formatMoney(line.amountMinor ?? null, rule.currency)}
                        {line.inclusive ? ' (included in the price)' : ' (added)'}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
      <form
        noValidate
        aria-label="New price rule version"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="rf-grid">
          <TextField
            label="Base price"
            inputMode="decimal"
            required
            value={price}
            onChange={setPrice}
            error={local.basePriceMinor ?? server.basePriceMinor}
          />
          <TextField
            label="Currency"
            required
            hint="Three letters, for example the code your finance team uses."
            value={currency}
            onChange={setCurrency}
            error={local.currency ?? server.currency}
          />
          <TextField
            label={`Effective from (${zoneLabel})`}
            type="datetime-local"
            required
            value={from}
            onChange={setFrom}
            error={local.effectiveFrom ?? server.effectiveFrom}
          />
          <TextField
            label={`Effective until (${zoneLabel})`}
            type="datetime-local"
            value={to}
            onChange={setTo}
            error={local.effectiveTo ?? server.effectiveTo}
          />
        </div>
        <ul className="list" aria-label="Taxes and fees">
          {charges.map((row, i) => (
            <li key={i}>
              <div className="rf-grid">
                <TextField
                  label={`Charge ${i + 1} code`}
                  value={row.code}
                  onChange={(v) => updateCharge(i, { code: v })}
                  error={local[`chargeLines.${i}`]}
                />
                <TextField
                  label={`Charge ${i + 1} label`}
                  value={row.label}
                  onChange={(v) => updateCharge(i, { label: v })}
                />
                <SelectField
                  label={`Charge ${i + 1} kind`}
                  value={row.kind}
                  onChange={(v) => updateCharge(i, { kind: v as 'tax' | 'fee' })}
                  options={[
                    { value: 'tax', label: 'Tax' },
                    { value: 'fee', label: 'Fee' },
                  ]}
                />
                <SelectField
                  label={`Charge ${i + 1} basis`}
                  value={row.basis}
                  onChange={(v) => updateCharge(i, { basis: v as ChargeRow['basis'] })}
                  options={[
                    { value: 'basisPoints', label: 'Rate in basis points' },
                    { value: 'amount', label: 'Fixed amount' },
                  ]}
                />
                <TextField
                  label={`Charge ${i + 1} rate or amount`}
                  value={row.value}
                  onChange={(v) => updateCharge(i, { value: v })}
                />
                <CheckboxField
                  label={`Charge ${i + 1} is included in the price`}
                  checked={row.inclusive}
                  onChange={(v) => updateCharge(i, { inclusive: v })}
                />
              </div>
              <Button
                variant="secondary"
                aria-label={`Remove charge ${i + 1}`}
                onClick={() => setCharges((rows) => rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="rf-actions">
          <Button
            variant="secondary"
            onClick={() =>
              setCharges((rows) => [
                ...rows,
                {
                  code: '',
                  label: '',
                  kind: 'tax',
                  basis: 'basisPoints',
                  value: '',
                  inclusive: false,
                },
              ])
            }
          >
            Add a tax or fee
          </Button>
          <Button type="submit" busy={create.isProcessing} disabled={!online}>
            Create price rule version
          </Button>
        </div>
        <OfflineCaption action="creating a price rule" />
        <CommandError error={create.error} />
      </form>
    </section>
  );
}

function CopyOffering({ offering }: { offering: Offering }) {
  const online = useOnline();
  const navigate = useNavigate();
  const copy = useApiCommand('post', '/offerings/{id}/copy', {
    invalidate: [['api', '/programs/{id}/offerings']],
  });
  const [name, setName] = useState(`${offering.name} (copy)`);
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [copySessions, setCopySessions] = useState(false);
  const server = fieldErrorsOf(copy.error);
  return (
    <details className="rf-panel">
      <summary>Copy as a new draft</summary>
      <p className="caption">
        The copy is a draft. Payments, attendance, enrollments, results and permissions are never
        copied (SPK-CAT-003).
      </p>
      <form
        noValidate
        aria-label="Copy as a new draft"
        onSubmit={(event) => {
          event.preventDefault();
          copy
            .submit({
              path: { id: offering.id },
              body: {
                copySessions,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(startsOn ? { startsOn } : {}),
                ...(endsOn ? { endsOn } : {}),
              },
            })
            .then((created) => navigate(`/programs/offerings/${created.id}`))
            .catch(() => undefined);
        }}
      >
        <div className="rf-grid">
          <TextField label="Name of the copy" value={name} onChange={setName} error={server.name} />
          <TextField
            label="New first date"
            type="date"
            value={startsOn}
            onChange={setStartsOn}
            error={server.startsOn}
          />
          <TextField
            label="New last date"
            type="date"
            value={endsOn}
            onChange={setEndsOn}
            error={server.endsOn}
          />
        </div>
        <CheckboxField
          label="Copy the sessions, shifted to the new dates"
          checked={copySessions}
          onChange={setCopySessions}
        />
        <div className="rf-actions">
          <Button type="submit" busy={copy.isProcessing} disabled={!online}>
            Create the copy
          </Button>
        </div>
        <OfflineCaption action="copying the offering" />
        <CommandError error={copy.error} />
      </form>
    </details>
  );
}

export function OfferingHeader({ offering }: { offering: Offering }) {
  const { nameOf } = useFacilities();
  return (
    <>
      <p>
        <Link to={`/programs/${offering.programId}`}>Back to the program</Link>
      </p>
      <h3>{offering.name}</h3>
      <p>
        <StatusBadge {...PUBLICATION_STATE[offering.publicationState]} />{' '}
        <span className="caption">
          {OFFERING_KIND[offering.kind]} · {nameOf(offering.facilityId)} ·{' '}
          {formatDate(offering.startsOn)} to {formatDate(offering.endsOn)}
        </span>
      </p>
    </>
  );
}

export function OfferingSetupScreen() {
  const { offeringId = '' } = useParams();
  const { timeZoneOf } = useFacilities();
  const offering = useApiQuery({ path: '/offerings/{id}', request: { path: { id: offeringId } } });
  return (
    <section aria-labelledby="offering-title">
      {/* SPK-UX-009: the region keeps its name in every state. */}
      <h2 id="offering-title">Offering setup</h2>
      <QueryBoundary
        query={offering}
        label="the offering"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the offering', 'adding sessions', 'creating prices']}
      >
        {(data) =>
          data.staff === null ? (
            <StateView
              variant="unavailable"
              title="Setup not available"
              description="The staff details of this offering are not available to you."
            />
          ) : (
            <>
              <OfferingHeader offering={data} />
              <nav aria-label="Offering pages" className="rf-actions">
                <Link to={`/programs/offerings/${data.id}/publication`}>
                  Publication and registration (SCR-S-15)
                </Link>
                <Link to={`/registrations/waitlists/${data.id}`}>Waitlist (SCR-S-26)</Link>
                <Link to={`/registrations/enrollments?offering=${data.id}`}>
                  Enrollments (SCR-S-27)
                </Link>
              </nav>
              <Facts
                label="Offering summary"
                items={[
                  [
                    'Capacity',
                    data.staff.capacityUnits.length > 0
                      ? data.staff.capacityUnits
                          .map((u) => `${CAPACITY_UNIT[u.unit]}: ${u.limit}`)
                          .join(', ')
                      : 'Not set',
                  ],
                  ['Required forms', String(data.requiredFormPolicyVersionIds.length)],
                  [
                    'Current price',
                    data.price
                      ? formatMoney(data.price.basePriceMinor, data.price.currency)
                      : 'No price rule',
                  ],
                  ['Revision', String(data.staff.revision)],
                  [
                    'Copied from',
                    data.staff.copiedFromOfferingId ? (
                      <Link to={`/programs/offerings/${data.staff.copiedFromOfferingId}`}>
                        the original offering
                      </Link>
                    ) : (
                      'Not a copy'
                    ),
                  ],
                ]}
              />
              <EditOffering offering={data} />
              <Sessions offering={data} zone={timeZoneOf(data.facilityId)} />
              <PriceRules offering={data} zone={timeZoneOf(data.facilityId)} />
              <CopyOffering offering={data} />
            </>
          )
        }
      </QueryBoundary>
    </section>
  );
}
