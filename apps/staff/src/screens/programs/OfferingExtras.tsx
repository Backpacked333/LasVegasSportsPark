/**
 * Parts of SCR-S-14 offering setup for two proposed amendments, each shown only while its
 * capability is on (the setup screen is unchanged with them off):
 *
 * - **Price tiers** (SPK-PAY-014, PA-03, `price_tiers_addons`, pending DEC-097): rows of the new
 *   price rule form. A tier names what the participant attends (every session, or days the
 *   customer chooses) and its price; tiers are written with the rule and never edited
 *   (SPK-PAY-002), so a change is a new price rule version.
 * - **Add-ons** (SPK-PAY-014): created and retired; a price change is a retirement and a new
 *   add-on, so a purchase keeps its basis.
 * - **Uniform** (SPK-REG-012, PA-07, `uniforms`, pending DEC-101): the kit an offering requires
 *   or offers, its sizes, an optional price and the returning-participant rule; one at a time.
 *
 * Amounts are entered in the currency's own units and sent as integer minor units. Nothing here
 * invents a tier, an add-on, a price or a rule: only what staff enter is sent.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { CheckboxField, SelectField, TextField } from '../../features/registration-finance/fields';
import {
  formatInstant,
  formatMoney,
  localToInstant,
  parseMoneyInput,
} from '../../features/registration-finance/format';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { CommandButton } from '../../ui/CommandButton';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Offering = Schema<'Offering'>;
type PriceRule = Schema<'PriceRule'>;
type TierBody = NonNullable<Schema<'CreatePriceRuleRequest'>['tiers']>[number];

/** A lower-case code from a name: "Full week" becomes "full_week". */
export function codeOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

// ---------------------------------------------------------------------------------------------
// Price tiers (rows of the price rule form)
// ---------------------------------------------------------------------------------------------

export interface TierRow {
  name: string;
  attendance: 'all_sessions' | 'chosen_sessions';
  min: string;
  max: string;
  price: string;
  memberPrice: string;
  until: string;
}

export const EMPTY_TIER: TierRow = {
  name: '',
  attendance: 'all_sessions',
  min: '',
  max: '',
  price: '',
  memberPrice: '',
  until: '',
};

/** The tiers of the request, or the first problem of each row (keyed `tiers.<index>`). */
export function tiersOf(
  rows: readonly TierRow[],
  currency: string,
  zone: string | null,
  memberAllowed: boolean,
): { tiers: TierBody[]; errors: Record<string, string> } {
  const tiers: TierBody[] = [];
  const errors: Record<string, string> = {};
  const validCurrency = /^[A-Z]{3}$/.test(currency);
  rows.forEach((row, i) => {
    const key = `tiers.${i}`;
    const code = codeOf(row.name);
    const price = validCurrency ? parseMoneyInput(row.price, currency, true) : null;
    const member =
      memberAllowed && row.memberPrice.trim() !== ''
        ? validCurrency
          ? parseMoneyInput(row.memberPrice, currency, true)
          : null
        : undefined;
    const min = /^\d+$/.test(row.min.trim()) ? Number(row.min.trim()) : null;
    const max =
      row.max.trim() === ''
        ? undefined
        : /^\d+$/.test(row.max.trim())
          ? Number(row.max.trim())
          : null;
    const until = row.until ? localToInstant(row.until, zone) : undefined;
    if (!code) errors[key] = 'Enter the name of the tier.';
    else if (tiers.some((t) => t.code === code)) errors[key] = 'Each tier needs its own name.';
    else if (price === null) errors[key] = 'Enter the price of the tier, for example 190.00.';
    else if (member === null) errors[key] = 'Enter the member price, or leave it empty.';
    else if (row.attendance === 'chosen_sessions' && (min === null || min < 1))
      errors[key] = 'Enter the fewest days the customer chooses.';
    else if (
      row.attendance === 'chosen_sessions' &&
      (max === null || (max !== undefined && min !== null && max < min))
    )
      errors[key] = 'The most days is a number, at least the fewest, or empty.';
    else if (row.until && !until) errors[key] = 'Enter a date and time, or leave it empty.';
    else {
      tiers.push({
        code,
        name: row.name.trim(),
        attendance: row.attendance,
        priceMinor: price,
        ...(row.attendance === 'chosen_sessions' && min !== null
          ? { minSessions: min, ...(max !== undefined && max !== null ? { maxSessions: max } : {}) }
          : {}),
        ...(member !== undefined ? { memberPriceMinor: member } : {}),
        ...(until ? { availableUntil: until } : {}),
      });
    }
  });
  return { tiers, errors };
}

export function TierEditor({
  rows,
  onChange,
  errors,
  memberAllowed,
  zoneLabel,
}: {
  rows: readonly TierRow[];
  onChange: (rows: TierRow[]) => void;
  errors: Record<string, string | undefined>;
  memberAllowed: boolean;
  zoneLabel: string;
}) {
  const update = (i: number, patch: Partial<TierRow>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <>
      <p className="caption">
        Price tiers: a tier names what the participant attends and its price, and exactly one tier
        applies to a registration. With tiers, the base price is used only while tiers are turned
        off. Proposed, pending {PENDING.priceTiersAddons.ids.join(', ')} (owner:{' '}
        {PENDING.priceTiersAddons.owner}).
      </p>
      <ul className="list" aria-label="Price tiers">
        {rows.map((row, i) => (
          <li key={i}>
            <div className="rf-grid">
              <TextField
                label={`Tier ${i + 1} name`}
                value={row.name}
                onChange={(v) => update(i, { name: v })}
                error={errors[`tiers.${i}`]}
              />
              <SelectField
                label={`Tier ${i + 1} attends`}
                value={row.attendance}
                onChange={(v) => update(i, { attendance: v as TierRow['attendance'] })}
                options={[
                  { value: 'all_sessions', label: 'Every session' },
                  { value: 'chosen_sessions', label: 'Days the customer chooses' },
                ]}
              />
              {row.attendance === 'chosen_sessions' ? (
                <>
                  <TextField
                    label={`Tier ${i + 1} fewest days`}
                    inputMode="numeric"
                    value={row.min}
                    onChange={(v) => update(i, { min: v })}
                  />
                  <TextField
                    label={`Tier ${i + 1} most days`}
                    inputMode="numeric"
                    hint="Leave empty for no upper limit."
                    value={row.max}
                    onChange={(v) => update(i, { max: v })}
                  />
                </>
              ) : null}
              <TextField
                label={`Tier ${i + 1} price`}
                inputMode="decimal"
                value={row.price}
                onChange={(v) => update(i, { price: v })}
              />
              {memberAllowed ? (
                <TextField
                  label={`Tier ${i + 1} member price`}
                  inputMode="decimal"
                  hint="Optional; for holders of the membership chosen above."
                  value={row.memberPrice}
                  onChange={(v) => update(i, { memberPrice: v })}
                />
              ) : null}
              <TextField
                label={`Tier ${i + 1} can be bought until (${zoneLabel})`}
                type="datetime-local"
                value={row.until}
                onChange={(v) => update(i, { until: v })}
              />
            </div>
            <Button
              variant="secondary"
              aria-label={`Remove tier ${i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

function daysOf(tier: PriceRule['tiers'][number]): string {
  if (tier.attendance === 'all_sessions') return 'every session';
  const min = tier.minSessions ?? 1;
  if (tier.maxSessions === null) return `${min} or more chosen days`;
  if (tier.maxSessions === min) return min === 1 ? '1 chosen day' : `${min} chosen days`;
  return `${min} to ${tier.maxSessions} chosen days`;
}

/** The tiers of a listed price rule version, as the API stored them. */
export function RuleTiers({ rule, zone }: { rule: PriceRule; zone: string | null }) {
  return (
    <>
      {rule.tiers.map((tier) => (
        <span className="caption" key={tier.id}>
          Tier {tier.name}: {formatMoney(tier.priceMinor, rule.currency)}
          {rule.pricingBasis === 'per_session' ? ' per session' : ''}, {daysOf(tier)}
          {tier.memberPriceMinor !== null
            ? `, member price ${formatMoney(tier.memberPriceMinor, rule.currency)}`
            : ''}
          {tier.availableUntil ? `, until ${formatInstant(tier.availableUntil, zone)}` : ''}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Add-ons
// ---------------------------------------------------------------------------------------------

const EXTRA_STATUS = {
  active: { tone: 'success', label: 'active' },
  retired: { tone: 'neutral', label: 'retired' },
} as const;

export function OfferingAddons({ offering }: { offering: Offering }) {
  const addons = useApiQuery({
    path: '/offerings/{id}/addons',
    request: { path: { id: offering.id } },
  });
  const create = useApiCommand('post', '/offerings/{id}/addons', {
    invalidate: [['api', '/offerings/{id}/addons']],
  });
  const retire = useApiCommand('post', '/offering-addons/{id}/retire', {
    invalidate: [['api', '/offerings/{id}/addons']],
  });
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(offering.price?.currency ?? '');
  const [selection, setSelection] = useState<'per_registration' | 'per_session'>(
    'per_registration',
  );
  const [capacity, setCapacity] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = fieldErrorsOf(create.error);
  const submit = () => {
    const errors: Record<string, string> = {};
    const code = currency.trim().toUpperCase();
    if (!codeOf(name)) errors.name = 'Enter the name of the add-on.';
    if (!/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
    const priceMinor = /^[A-Z]{3}$/.test(code) ? parseMoneyInput(price, code, true) : null;
    if (priceMinor === null) errors.priceMinor = 'Enter the price, for example 9.00.';
    const places =
      capacity.trim() === ''
        ? undefined
        : /^\d+$/.test(capacity.trim())
          ? Number(capacity.trim())
          : null;
    if (places === null) errors.capacity = 'Enter a whole number, or leave it empty for no limit.';
    setLocal(errors);
    if (Object.keys(errors).length > 0 || priceMinor === null || places === null) return;
    create
      .submit({
        path: { id: offering.id },
        body: {
          code: codeOf(name),
          name: name.trim(),
          priceMinor,
          currency: code,
          selection,
          ...(places !== undefined ? { capacity: places } : {}),
        },
      })
      .then(() => {
        setName('');
        setPrice('');
        setCapacity('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="rf-panel" aria-labelledby="addons-title">
      <h3 id="addons-title">Add-ons</h3>
      <p className="caption">
        Optional extras with their own price, such as lunch or early drop-off: chosen once for the
        registration or for each day, with an optional capacity of their own. Each is its own line
        on the quote and the receipt. A price is never edited: retire the add-on and add it again
        (SPK-PAY-002). Proposed, pending {PENDING.priceTiersAddons.ids.join(', ')} (owner:{' '}
        {PENDING.priceTiersAddons.owner}).
      </p>
      <QueryBoundary
        query={addons}
        label="add-ons"
        isEmpty={(list) => list.length === 0}
        empty={{ title: 'No add-ons', description: 'Add the first add-on below.' }}
      >
        {(list) => (
          <ul className="list" aria-label="Add-ons">
            {list.map((addon) => (
              <li key={addon.id}>
                <div className="row-text">
                  <span className="row-title">
                    {addon.name}: {formatMoney(addon.priceMinor, addon.currency)}
                    {addon.selection === 'per_session' ? ' each day' : ''}
                  </span>
                  <span className="caption">
                    {addon.selection === 'per_session'
                      ? 'Chosen for each day'
                      : 'Chosen once for the registration'}
                    {addon.capacity !== null
                      ? ` · ${addon.capacity} place(s)${
                          addon.selection === 'per_session' ? ' each day' : ''
                        }`
                      : ' · no limit'}
                  </span>
                  <StatusBadge {...EXTRA_STATUS[addon.status]} />
                </div>
                {addon.status === 'active' ? (
                  <CommandButton
                    variant="secondary"
                    busy={retire.isProcessing}
                    aria-label={`Retire ${addon.name}`}
                    onClick={() => {
                      retire
                        .submit({
                          path: { id: addon.id },
                          body: { expectedRevision: addon.revision },
                        })
                        .catch(() => undefined);
                    }}
                  >
                    Retire
                  </CommandButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <CommandError error={retire.error} />
      <form
        noValidate
        aria-label="New add-on"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="rf-grid">
          <TextField
            label="Add-on name"
            required
            value={name}
            onChange={setName}
            error={local.name ?? server.name ?? server.code}
          />
          <TextField
            label="Add-on price"
            inputMode="decimal"
            required
            value={price}
            onChange={setPrice}
            error={local.priceMinor ?? server.priceMinor}
          />
          <TextField
            label="Add-on currency"
            required
            value={currency}
            onChange={setCurrency}
            error={local.currency ?? server.currency}
          />
          <SelectField
            label="Add-on is chosen"
            value={selection}
            onChange={(v) => setSelection(v as typeof selection)}
            options={[
              { value: 'per_registration', label: 'Once for the registration' },
              { value: 'per_session', label: 'For each day' },
            ]}
            error={server.selection}
          />
          <TextField
            label="Add-on capacity"
            inputMode="numeric"
            hint="Places in all, or for each day when chosen for each day. Empty: no limit."
            value={capacity}
            onChange={setCapacity}
            error={local.capacity ?? server.capacity}
          />
        </div>
        <div className="rf-actions">
          <CommandButton type="submit" busy={create.isProcessing}>
            Add the add-on
          </CommandButton>
        </div>
        <CommandError error={create.error} />
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Uniform
// ---------------------------------------------------------------------------------------------

export function OfferingUniform({ offering }: { offering: Offering }) {
  const uniforms = useApiQuery({
    path: '/offerings/{id}/uniforms',
    request: { path: { id: offering.id } },
  });
  const create = useApiCommand('post', '/offerings/{id}/uniforms', {
    invalidate: [['api', '/offerings/{id}/uniforms']],
  });
  const retire = useApiCommand('post', '/offering-uniforms/{id}/retire', {
    invalidate: [['api', '/offerings/{id}/uniforms']],
  });
  const [name, setName] = useState('');
  const [itemKey, setItemKey] = useState('');
  const [sizes, setSizes] = useState('');
  const [required, setRequired] = useState(false);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(offering.price?.currency ?? '');
  const [returningFree, setReturningFree] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = fieldErrorsOf(create.error);
  const hasActive = (uniforms.data ?? []).some((u) => u.status === 'active');
  const submit = () => {
    const errors: Record<string, string> = {};
    const sizeList = [
      ...new Set(
        sizes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const key = itemKey.trim().toLowerCase();
    if (!name.trim()) errors.name = 'Enter the name of the uniform.';
    if (!/^[a-z0-9_-]+$/.test(key))
      errors.itemKey = 'Enter a reference of lower-case letters, digits and hyphens.';
    if (sizeList.length === 0) errors.sizes = 'Enter at least one size, separated by commas.';
    const code = currency.trim().toUpperCase();
    const priced = price.trim() !== '';
    const priceMinor =
      priced && /^[A-Z]{3}$/.test(code) ? parseMoneyInput(price, code, true) : null;
    if (priced && !/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
    else if (priced && priceMinor === null)
      errors.priceMinor = 'Enter the price, for example 25.00.';
    setLocal(errors);
    if (Object.keys(errors).length > 0) return;
    create
      .submit({
        path: { id: offering.id },
        body: {
          itemKey: key,
          name: name.trim(),
          sizes: sizeList,
          requirement: required ? 'required' : 'optional',
          returningHolderFree: returningFree,
          ...(priced && priceMinor !== null ? { priceMinor, currency: code } : {}),
        },
      })
      .then(() => {
        setName('');
        setItemKey('');
        setSizes('');
        setPrice('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="rf-panel" aria-labelledby="uniform-title">
      <h3 id="uniform-title">Uniform</h3>
      <p className="caption">
        The kit this offering requires or offers. The customer chooses a size when registering; a
        priced uniform is its own line on the quote. Stock is not counted. Proposed, pending{' '}
        {PENDING.uniforms.ids.join(', ')} (owner: {PENDING.uniforms.owner}).
      </p>
      <p>
        <Link to={`/programs/offerings/${offering.id}/uniforms`}>
          Uniforms ordered and hand-over
        </Link>
      </p>
      <QueryBoundary
        query={uniforms}
        label="the uniform"
        isEmpty={(list) => list.length === 0}
        empty={{ title: 'No uniform', description: 'Set the uniform of this offering below.' }}
      >
        {(list) => (
          <ul className="list" aria-label="Uniforms">
            {list.map((uniform) => (
              <li key={uniform.id}>
                <div className="row-text">
                  <span className="row-title">
                    {uniform.name}:{' '}
                    {uniform.priceMinor !== null && uniform.currency
                      ? formatMoney(uniform.priceMinor, uniform.currency)
                      : 'not charged'}
                  </span>
                  <span className="caption">
                    {uniform.requirement === 'required' ? 'Required' : 'Optional'} · sizes{' '}
                    {uniform.sizes.join(', ')} · reference {uniform.itemKey}
                    {uniform.returningHolderFree
                      ? ' · a participant who already holds it is not charged again'
                      : ''}
                  </span>
                  <StatusBadge {...EXTRA_STATUS[uniform.status]} />
                </div>
                {uniform.status === 'active' ? (
                  <CommandButton
                    variant="secondary"
                    busy={retire.isProcessing}
                    aria-label={`Retire ${uniform.name}`}
                    onClick={() => {
                      retire
                        .submit({
                          path: { id: uniform.id },
                          body: { expectedRevision: uniform.revision },
                        })
                        .catch(() => undefined);
                    }}
                  >
                    Retire
                  </CommandButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <CommandError error={retire.error} />
      {hasActive ? (
        <p className="caption">
          One uniform at a time: retire the current one before setting another.
        </p>
      ) : (
        <form
          noValidate
          aria-label="Set the uniform"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="rf-grid">
            <TextField
              label="Uniform name"
              required
              value={name}
              onChange={setName}
              error={local.name ?? server.name}
            />
            <TextField
              label="Kit reference"
              required
              hint="The same reference on another offering is the same kit: a participant who was handed it holds the current uniform."
              value={itemKey}
              onChange={setItemKey}
              error={local.itemKey ?? server.itemKey}
            />
            <TextField
              label="Sizes"
              required
              hint="Separated by commas, in the order to show them."
              value={sizes}
              onChange={setSizes}
              error={local.sizes ?? server.sizes}
            />
            <TextField
              label="Uniform price"
              inputMode="decimal"
              hint="Leave empty for a uniform that is not charged."
              value={price}
              onChange={setPrice}
              error={local.priceMinor ?? server.priceMinor}
            />
            <TextField
              label="Uniform currency"
              value={currency}
              onChange={setCurrency}
              error={local.currency ?? server.currency}
            />
          </div>
          <CheckboxField
            label="Required: the customer must choose a size"
            checked={required}
            onChange={setRequired}
          />
          <CheckboxField
            label="A participant who already holds this uniform is not charged again"
            checked={returningFree}
            onChange={setReturningFree}
          />
          <div className="rf-actions">
            <CommandButton type="submit" busy={create.isProcessing}>
              Set the uniform
            </CommandButton>
          </div>
          <CommandError error={create.error} />
        </form>
      )}
    </section>
  );
}
