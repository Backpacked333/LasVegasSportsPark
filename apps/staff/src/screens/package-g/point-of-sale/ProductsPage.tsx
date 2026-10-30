/**
 * SCR-S-55 products (§3.16 POS "products, prices, approved taxes"; SPK-PAY-001, SPK-PAY-002,
 * SPK-PAY-012): the products of a facility or of every facility (`GET /v1/pos-products`, paged),
 * creating one (`POST /v1/pos-products`), changing its name, price or charges for later sales with
 * the revision it was read at (`PATCH /v1/pos-products/{id}`, STALE_REVISION answers "Reload"),
 * and retiring it (`POST /v1/pos-products/{id}/retire`, never gated; past sales keep their
 * snapshot). Prices are integer minor units with their currency, typed by staff and never derived.
 *
 * Taxes and fees are keys of catalog `tax_fee` policies; only approved versions apply, at sale time
 * (DEC-057). The keys offered are the approved ones the API lists
 * (`GET /v1/policy-versions?kind=tax_fee&approvalStatus=approved`); none approved means products
 * sell without charges, which the page says, rather than assuming a rate.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import {
  FacilityField,
  useFacilityChoice,
  useFacilityDirectory,
  type FacilityDirectory,
} from '../../../features/pos-access-accounting/facilities';
import { MoneyField } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { POS_LIFECYCLE, POS_PRODUCT_KIND } from '../../../features/pos-access-accounting/labels';
import { POS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import {
  formatMoney,
  minorDigits,
  parseMoneyInput,
} from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { CheckboxGroup, SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';

type Product = Schema<'PosProduct'>;

const KIND_OPTIONS = (Object.keys(POS_PRODUCT_KIND) as Schema<'PosProductKind'>[]).map((k) => ({
  value: k,
  label: POS_PRODUCT_KIND[k],
}));

const STATUS_FILTERS = [
  { value: 'active', label: 'Active products' },
  { value: 'retired', label: 'Retired products' },
] as const;

/** Minor units as the text a staff member would type ("12.50" for 1250 USD). */
function minorToInput(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(minor);
  const abs = Math.abs(minor);
  return `${Math.floor(abs / 10 ** digits)}.${String(abs % 10 ** digits).padStart(digits, '0')}`;
}

/** Approved tax and fee policy keys (DEC-057), as the catalog lists them. */
function useApprovedCharges() {
  const versions = useApiPages({
    path: '/policy-versions',
    request: { query: { kind: 'tax_fee', approvalStatus: 'approved', limit: 100 } },
  });
  const options = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const v of versions.data ?? []) {
      if (!byKey.has(v.key)) byKey.set(v.key, `${v.title} (${v.key})`);
    }
    return [...byKey].map(([value, label]) => ({ value, label }));
  }, [versions.data]);
  return { versions, options };
}

function ChargeChoice({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
}) {
  const { versions, options } = useApprovedCharges();
  if (versions.data === undefined) {
    if (versions.error) {
      return (
        <p className="caption">
          Approved taxes and fees could not be listed ({versions.error.code}). The product keeps the
          charges it has; the API applies only approved versions at sale time (DEC-057).
        </p>
      );
    }
    return <p className="caption">Loading the approved taxes and fees…</p>;
  }
  // Keys on the product that are no longer approved stay listed so they can be removed.
  const all = [
    ...options,
    ...value
      .filter((key) => !options.some((o) => o.value === key))
      .map((key) => ({ value: key, label: `${key} (no approved version listed)` })),
  ];
  if (all.length === 0) {
    return (
      <p className="caption" data-testid="no-approved-charges">
        No tax or fee is approved (DEC-057): products sell without charges until finance approves
        one.
      </p>
    );
  }
  return (
    <CheckboxGroup
      legend="Taxes and fees"
      hint="Only the approved version in effect at sale time applies (DEC-057)."
      options={all}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

export function ProductsPage() {
  const directory = useFacilityDirectory();
  const { facilityId, setFacilityId } = useFacilityChoice(directory);
  const [status, setStatus] = useState<string>('active');
  const products = useApiPages({
    path: '/pos-products',
    request: {
      query: {
        ...(facilityId ? { facilityId } : {}),
        ...(status ? { status: status as Schema<'PosLifecycleStatus'> } : {}),
        limit: 50,
      },
    },
  });
  return (
    <section aria-labelledby="pos-products-title">
      <h3 id="pos-products-title">Products</h3>
      <p className="caption">
        Merchandise, concessions and services only: registrations, memberships, packages and
        bookings are never sold at a register (SPK-PAY-012).
      </p>
      <div className="rf-grid">
        <FacilityField
          directory={directory}
          label="Products sold at"
          value={facilityId}
          onChange={setFacilityId}
          allowAll
        />
        <SelectField
          label="Show"
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          placeholder="Every product"
        />
      </div>
      <QueryBoundary
        query={products}
        label="products"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No products',
          description: 'No product matches. Nothing can be sold until a product is created.',
        }}
        unavailableOffline={['changing products']}
      >
        {(items) => (
          <ul className="list" aria-label="Products">
            {items.map((product) => (
              <ProductRow key={product.id} product={product} directory={directory} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={products} label="products" />
      <CreateProduct directory={directory} facilityId={facilityId} />
    </section>
  );
}

function ProductRow({ product, directory }: { product: Product; directory: FacilityDirectory }) {
  const offer = useOffer();
  const online = useOnline();
  const [editing, setEditing] = useState(false);
  const retire = useApiCommand('post', '/pos-products/{id}/retire', {
    invalidate: [['api', '/pos-products']],
  });
  const manage = offer.allowed(POS_ACTIONS.manageProducts, product.facilityId);
  const active = product.status === 'active';
  return (
    <li>
      <div className="row-text">
        <span className="row-title">
          {product.name} ({product.sku})
        </span>
        <span>
          {POS_PRODUCT_KIND[product.kind]} · {formatMoney(product.priceMinor, product.currency)} ·{' '}
          {product.facilityId ? directory.nameOf(product.facilityId) : 'Every facility'}
        </span>
        <span className="caption">
          {product.chargePolicyKeys.length > 0
            ? `Taxes and fees: ${product.chargePolicyKeys.join(', ')}`
            : 'No taxes or fees'}
        </span>
        <StatusBadge {...POS_LIFECYCLE[product.status]} />
        {product.retireReason ? (
          <span className="caption">Retired: {product.retireReason}</span>
        ) : null}
      </div>
      {active && manage && offer.capabilityOn('point_of_sale') ? (
        editing ? (
          <EditProduct product={product} onDone={() => setEditing(false)} />
        ) : (
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={!online}>
            Change {product.sku}
          </Button>
        )
      ) : null}
      {active && manage ? (
        <div>
          <ReasonAction
            label={`Retire ${product.sku}`}
            confirmLabel="Retire the product"
            reasonLabel="Reason for retiring"
            explanation="A retired product is not sold again; past sales keep what they sold."
            busy={retire.isProcessing}
            disabled={!online}
            onConfirm={async (reason) => {
              try {
                await retire.submit({ path: { id: product.id }, body: { reason } });
                return true;
              } catch {
                return false;
              }
            }}
          />
          <CommandError error={retire.error} />
        </div>
      ) : null}
    </li>
  );
}

function EditProduct({ product, onDone }: { product: Product; onDone: () => void }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState(minorToInput(product.priceMinor, product.currency));
  const [keys, setKeys] = useState<string[]>([...product.chargePolicyKeys]);
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('patch', '/pos-products/{id}', {
    invalidate: [['api', '/pos-products']],
  });
  const intent = useIntentForm(command);
  const priceMinor = parseMoneyInput(price, product.currency, true);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!name.trim() || priceMinor === null) return;
    const changed = {
      ...(name.trim() !== product.name ? { name: name.trim() } : {}),
      ...(priceMinor !== product.priceMinor ? { priceMinor } : {}),
      ...(keys.join(',') !== product.chargePolicyKeys.join(',') ? { chargePolicyKeys: keys } : {}),
    };
    if (Object.keys(changed).length === 0) {
      onDone();
      return;
    }
    const updated = await intent.send({
      path: { id: product.id },
      body: { ...changed, expectedRevision: product.revision },
    });
    if (updated) onDone();
  };
  return (
    <form
      className="panel"
      aria-label={`Change ${product.sku}`}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <p className="caption">
        Changes apply to later sales; sales already made keep their price and charges.
      </p>
      <TextField
        label="Name"
        required
        value={name}
        onChange={setName}
        error={touched && !name.trim() ? 'Enter a name.' : null}
        disabled={intent.locked}
      />
      <MoneyField
        label="Price"
        currency={product.currency}
        required
        value={price}
        onChange={setPrice}
        error={touched && priceMinor === null ? `Enter an amount in ${product.currency}.` : null}
        disabled={intent.locked}
      />
      <ChargeChoice value={keys} onChange={setKeys} disabled={intent.locked} />
      <div className="actions-row">
        <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
          Save the change
        </Button>
        <Button variant="secondary" disabled={command.isProcessing} onClick={onDone}>
          Keep it as it is
        </Button>
      </div>
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          void queryClient.invalidateQueries({ queryKey: ['api', '/pos-products'] });
          onDone();
        }}
        currency={product.currency}
      />
    </form>
  );
}

function CreateProduct({
  directory,
  facilityId,
}: {
  directory: FacilityDirectory;
  facilityId: string | null;
}) {
  const offer = useOffer();
  const online = useOnline();
  const [facility, setFacility] = useState<string | null>(null);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [currency, setCurrency] = useState('');
  const [price, setPrice] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-products', {
    invalidate: [['api', '/pos-products']],
  });
  const intent = useIntentForm(command);
  const target = facility === null ? facilityId : facility || null;
  if (!offer.capabilityOn('point_of_sale')) return null;
  if (!offer.allowed(POS_ACTIONS.manageProducts, target)) {
    return (
      <p className="caption">
        Creating products needs the permission {POS_ACTIONS.manageProducts}.
      </p>
    );
  }
  const code = currency.trim().toUpperCase();
  const currencyValid = /^[A-Z]{3}$/.test(code);
  const skuValid = /^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(sku.trim());
  const priceMinor = currencyValid ? parseMoneyInput(price, code, true) : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!skuValid || !name.trim() || !kind || !currencyValid || priceMinor === null) return;
    const created = await intent.send({
      body: {
        ...(target ? { facilityId: target } : {}),
        sku: sku.trim(),
        name: name.trim(),
        kind: kind as Schema<'PosProductKind'>,
        priceMinor,
        currency: code,
        chargePolicyKeys: keys,
      },
    });
    if (created) {
      setSku('');
      setName('');
      setPrice('');
      setKeys([]);
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Create a product"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Create a product</h4>
      <FacilityField
        directory={directory}
        label="Sold at"
        value={target}
        onChange={setFacility}
        allowAll
        disabled={intent.locked}
      />
      <TextField
        label="SKU"
        required
        hint="Upper-case letters, digits, - and _; unique in the organization."
        value={sku}
        onChange={(v) => setSku(v.toUpperCase())}
        error={touched && !skuValid ? 'Enter a SKU of upper-case letters, digits, - or _.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Name"
        required
        value={name}
        onChange={setName}
        error={touched && !name.trim() ? 'Enter a name.' : null}
        disabled={intent.locked}
      />
      <SelectField
        label="Kind"
        required
        value={kind}
        onChange={setKind}
        options={KIND_OPTIONS}
        placeholder="Choose a kind"
        error={touched && !kind ? 'Choose what the product is.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Currency"
        required
        hint="ISO 4217 code of the price."
        value={currency}
        onChange={(v) => setCurrency(v.toUpperCase())}
        error={touched && !currencyValid ? 'Enter a three-letter currency code.' : null}
        disabled={intent.locked}
      />
      <MoneyField
        label="Price"
        currency={currencyValid ? code : null}
        required
        hint={currencyValid ? undefined : 'Enter the currency first.'}
        value={price}
        onChange={setPrice}
        error={touched && priceMinor === null ? 'Enter the price.' : null}
        disabled={intent.locked}
      />
      <ChargeChoice value={keys} onChange={setKeys} disabled={intent.locked} />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Create the product
      </Button>
      {command.data && !command.error ? (
        <p role="status">
          Product {command.data.sku} created at{' '}
          {formatMoney(command.data.priceMinor, command.data.currency)}.
        </p>
      ) : null}
      <OfflineCaption action="creating a product" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}
