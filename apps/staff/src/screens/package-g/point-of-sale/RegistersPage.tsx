/**
 * SCR-S-55 registers and their sessions (§3.16 POS, POL-018): the registers of a facility
 * (`GET /v1/pos-registers`, paged), each with its open session; creating a register
 * (`POST /v1/pos-registers`, finance.manage_pos_registers), retiring one without an open session
 * with the revision it was read at (`POST /v1/pos-registers/{id}/retire`, never gated;
 * REGISTER_SESSION_OPEN is explained, STALE_REVISION answers "Reload") and opening a session with its opening float
 * (`POST /v1/pos-registers/{id}/sessions`, finance.operate_register). The opening currency is
 * never assumed: it is typed, or taken from the facility's products when they share one.
 * Offline, commands are disabled and say so; nothing is queued (§4.15: no new payments offline).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import {
  FacilityField,
  useFacilityChoice,
  useFacilityDirectory,
  type FacilityDirectory,
} from '../../../features/pos-access-accounting/facilities';
import { MoneyField, ReferenceJump } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { POS_LIFECYCLE } from '../../../features/pos-access-accounting/labels';
import { POS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import { parseMoneyInput } from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { POS_PATHS } from './paths';

type Register = Schema<'PosRegister'>;

const STATUS_FILTERS = [
  { value: 'active', label: 'Active registers' },
  { value: 'retired', label: 'Retired registers' },
] as const;

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

export function RegistersPage() {
  const directory = useFacilityDirectory();
  const { facilityId, setFacilityId } = useFacilityChoice(directory);
  const [status, setStatus] = useState<string>('active');
  const registers = useApiPages({
    path: '/pos-registers',
    request: {
      query: compact({ facilityId, status: status || undefined, limit: 50 }) as {
        facilityId?: string;
        status?: Schema<'PosLifecycleStatus'>;
        limit: number;
      },
    },
  });
  return (
    <section aria-labelledby="pos-registers-title">
      <h3 id="pos-registers-title">Registers and sales</h3>
      <div className="rf-grid">
        <FacilityField
          directory={directory}
          label="Registers at"
          value={facilityId}
          onChange={setFacilityId}
          allowAll
        />
        <SelectField
          label="Show"
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          placeholder="Every register"
        />
      </div>
      <QueryBoundary
        query={registers}
        label="registers"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No registers',
          description:
            'No register matches. A register is created at a facility before sessions and sales.',
        }}
        unavailableOffline={['opening and closing sessions', 'selling']}
      >
        {(items) => (
          <ul className="list" aria-label="Registers">
            {items.map((register) => (
              <RegisterRow key={register.id} register={register} directory={directory} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={registers} label="registers" />
      <ReferenceJump
        label="Sale reference"
        buttonLabel="Open the sale"
        to={(id) => POS_PATHS.sale(id)}
      />
      <CreateRegister directory={directory} facilityId={facilityId} />
    </section>
  );
}

function RegisterRow({
  register,
  directory,
}: {
  register: Register;
  directory: FacilityDirectory;
}) {
  const offer = useOffer();
  const online = useOnline();
  const queryClient = useQueryClient();
  const retire = useApiCommand('post', '/pos-registers/{id}/retire', {
    invalidate: [['api', '/pos-registers']],
  });
  const canOpen =
    register.status === 'active' &&
    register.openSessionId === null &&
    offer.capabilityOn('point_of_sale') &&
    offer.allowed(POS_ACTIONS.operateRegister, register.facilityId);
  const canRetire =
    register.status === 'active' &&
    register.openSessionId === null &&
    offer.allowed(POS_ACTIONS.manageRegisters, register.facilityId);
  return (
    <li>
      <div className="row-text">
        <span className="row-title">
          {register.name} ({register.code})
        </span>
        <span>{directory.nameOf(register.facilityId)}</span>
        <StatusBadge {...POS_LIFECYCLE[register.status]} />
        {register.openSessionId ? (
          <Link to={POS_PATHS.session(register.openSessionId)}>
            Go to the open session of {register.name}
          </Link>
        ) : (
          <span className="caption">No open session</span>
        )}
        {register.retireReason ? (
          <span className="caption">Retired: {register.retireReason}</span>
        ) : null}
      </div>
      {canOpen ? <OpenSessionForm register={register} disabled={!online} /> : null}
      {canRetire ? (
        <div>
          <ReasonAction
            label={`Retire register ${register.code}`}
            confirmLabel="Retire the register"
            reasonLabel="Reason for retiring"
            explanation="A retired register opens no new session; its sessions and sales stay readable."
            busy={retire.isProcessing}
            disabled={!online}
            onConfirm={async (reason) => {
              try {
                await retire.submit({
                  path: { id: register.id },
                  body: { reason, expectedRevision: register.revision },
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
              void queryClient.invalidateQueries({ queryKey: ['api', '/pos-registers'] });
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

function OpenSessionForm({ register, disabled }: { register: Register; disabled: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // The register facility's active products: their currencies are the only source of a session
  // currency the client does not ask for (never a default of its own).
  const products = useApiPages({
    path: '/pos-products',
    request: { query: { facilityId: register.facilityId, status: 'active', limit: 100 } },
    enabled: open,
  });
  const currencies = useMemo(
    () => [...new Set((products.data ?? []).map((p) => p.currency))].sort(),
    [products.data],
  );
  const [typedCurrency, setTypedCurrency] = useState<string | null>(null);
  const [float, setFloat] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-registers/{id}/sessions', {
    invalidate: [['api', '/pos-registers']],
  });
  const intent = useIntentForm(command);
  // One currency on the facility's products is the API's answer; otherwise staff type it.
  const prefill = currencies.length === 1 ? (currencies[0] ?? '') : '';
  const shownCurrency = typedCurrency ?? prefill;
  const currency = shownCurrency.trim().toUpperCase();
  const currencyValid = /^[A-Z]{3}$/.test(currency);
  const floatMinor = currencyValid ? parseMoneyInput(float, currency, true) : null;
  if (!open) {
    return (
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        Open a session on {register.code}
      </Button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!currencyValid || floatMinor === null) return;
    const session = await intent.send({
      path: { id: register.id },
      body: { currency, openingFloatMinor: floatMinor },
    });
    if (session) navigate(POS_PATHS.session(session.id));
  };
  const locked = intent.locked || command.isProcessing;
  return (
    <form
      className="panel"
      aria-label={`Open a session on ${register.code}`}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <TextField
        label="Currency of the cash drawer"
        required
        hint={
          currencies.length > 0
            ? `ISO 4217 code. This facility's products are priced in ${currencies.join(', ')}.`
            : 'ISO 4217 code, as priced on the products sold here.'
        }
        value={shownCurrency}
        onChange={setTypedCurrency}
        error={touched && !currencyValid ? 'Enter a three-letter currency code.' : null}
        disabled={locked}
      />
      <MoneyField
        label="Opening float"
        currency={currencyValid ? currency : null}
        required
        value={float}
        onChange={setFloat}
        hint="The cash counted into the drawer before the first sale."
        error={
          touched && floatMinor === null
            ? `Enter the counted amount in ${currencyValid ? currency : 'the currency'}.`
            : null
        }
        disabled={locked}
      />
      <div className="actions-row">
        <Button type="submit" busy={command.isProcessing} disabled={disabled || intent.locked}>
          Open the session
        </Button>
        <Button variant="secondary" disabled={command.isProcessing} onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
      <OfflineCaption action="opening a session" />
      <CommandError error={command.error} onRetry={intent.retry} currency={currency} />
    </form>
  );
}

function CreateRegister({
  directory,
  facilityId,
}: {
  directory: FacilityDirectory;
  facilityId: string | null;
}) {
  const offer = useOffer();
  const online = useOnline();
  const [facility, setFacility] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-registers', {
    invalidate: [['api', '/pos-registers']],
  });
  const intent = useIntentForm(command);
  const target = facility ?? facilityId;
  if (!offer.capabilityOn('point_of_sale')) return null;
  if (!offer.allowed(POS_ACTIONS.manageRegisters, target)) {
    return (
      <p className="caption">
        Creating registers needs the permission {POS_ACTIONS.manageRegisters}.
      </p>
    );
  }
  const codeValid = /^[A-Z0-9]{2,8}$/.test(code.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!target || !codeValid || !name.trim()) return;
    const created = await intent.send({
      body: { facilityId: target, code: code.trim(), name: name.trim() },
    });
    if (created) {
      setCode('');
      setName('');
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Create a register"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Create a register</h4>
      <FacilityField
        directory={directory}
        value={target}
        onChange={setFacility}
        required
        disabled={intent.locked}
      />
      {touched && !target ? (
        <p className="error-text">Choose the register&apos;s facility.</p>
      ) : null}
      <TextField
        label="Register code"
        required
        hint="2 to 8 upper-case letters or digits, unique at the facility."
        value={code}
        onChange={(v) => setCode(v.toUpperCase())}
        error={touched && !codeValid ? 'Enter 2 to 8 upper-case letters or digits.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Register name"
        required
        value={name}
        onChange={setName}
        error={touched && !name.trim() ? 'Enter a name.' : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Create the register
      </Button>
      {command.data && !command.error ? (
        <p role="status">
          Register {command.data.code} created at {directory.nameOf(command.data.facilityId)}.
        </p>
      ) : null}
      <OfflineCaption action="creating a register" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}
