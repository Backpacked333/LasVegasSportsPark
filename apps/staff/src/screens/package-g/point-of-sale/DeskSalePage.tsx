/**
 * Staff S 4a: the front desk sale at the tablet (rail › Sell, or "Take payment" on a household;
 * SPK-PAY-002, SPK-PAY-009, SPK-PAY-012, §4.9, §4.11). Route: `/finance/point-of-sale/desk`,
 * `?household=<id>` with a family chosen.
 *
 * - With a family chosen, "Owed by this family" comes first: their open fees and instalments
 *   (`GET /v1/obligations?debtorPersonId=`, each adult of the household), each with the child it
 *   names. Tapping a tile adds it; tapping again removes it. Products follow by kind: Drop-in
 *   (services), Snack bar (concessions), Gear (merchandise), priced by the API (`GET /v1/pos-products`).
 * - The family's credit is applied by itself against the fees and shown as a line
 *   (`POST /v1/credits/{id}/redeem`, at payment). Credits apply to fees and registrations only.
 * - Money is never optimistic: the buttons wait for the service and the cart is locked meanwhile.
 *   Products go through a register sale (`POST /v1/pos-sales`, lines, then one tender); fees are
 *   settled with a desk tender (`POST /v1/cash-tenders`, cash or the card terminal), which marks
 *   them paid in the family's app. Each command carries its own idempotency key.
 * - "Charge card": a card tender on the sale through the payment provider. Card details come from
 *   the provider's own entry (development builds pick a fake provider scenario; DEC-019 pending
 *   for release). A fee cannot be charged to a card from the desk (no such command): with fees in
 *   the cart, take them by cash or the card terminal. A saved "card on file" does not exist in the
 *   API: proposed.
 * - "Custom amount" is the register's open-amount line on the full sale page.
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { useKeyedCommands } from '../../../features/operations/commands';
import { useOperatingFacility } from '../../../features/operations/context';
import { CommandError } from '../../../features/operations/feedback';
import { formatMoney } from '../../../features/operations/format';
import { DevCardMethodPicker } from '../../../features/pos-access-accounting/dev';
import { PersonSearch } from '../../../features/operations/PersonSearch';
import { useApi, useNow } from '../../../providers/AppProviders';
import { Icon, type IconName } from '../../../ui/Icon';
import { DeskAvatar } from '../../arrival/desk/DeskAvatar';
import { POS_PATHS } from './paths';
import './desk-sale.css';

type Obligation = Schema<'Obligation'>;
type Product = Schema<'PosProduct'>;
type Person = Schema<'Person'>;

type Chip = 'owed' | 'service' | 'concession' | 'merchandise' | 'custom';
const CHIPS: { id: Chip; label: string }[] = [
  { id: 'owed', label: 'Owed by this family' },
  { id: 'service', label: 'Drop-in' },
  { id: 'concession', label: 'Snack bar' },
  { id: 'merchandise', label: 'Gear' },
  { id: 'custom', label: 'Custom amount' },
];
const KIND_ICON: Record<Product['kind'], IconName> = {
  service: 'confirmation_number',
  concession: 'local_drink',
  merchandise: 'checkroom',
};
const KIND_LABEL: Record<Product['kind'], string> = {
  service: 'Drop-in',
  concession: 'Snack bar',
  merchandise: 'Gear',
};
const WEEK = 7 * 86_400_000;

function owedMinor(o: Obligation): number {
  return o.totals.remainingMinor;
}

export function DeskSalePage() {
  const [params, setParams] = useSearchParams();
  const householdId = params.get('household');
  const facility = useOperatingFacility();
  const api = useApi();
  const now = useNow(60_000);
  const household = useApiQuery({
    path: '/households/{id}',
    request: { path: { id: householdId ?? '' } },
    enabled: householdId !== null,
  });
  const [members, setMembers] = useState<Person[] | null>(null);
  const memberKey = household.data?.members.map((m) => m.personId).join(',') ?? '';
  useEffect(() => {
    if (!memberKey) return;
    void Promise.all(
      memberKey.split(',').map((id) => api.get('/people/{id}', { path: { id } }).catch(() => null)),
    ).then((people) => setMembers(people.filter((p) => p !== null) as Person[]));
  }, [api, memberKey]);
  const adults = (members ?? []).filter((p) => p.kind === 'adult');
  const children = (members ?? []).filter((p) => p.kind === 'child');
  const payer = adults[0] ?? null;

  const obligations = useApiQuery({
    path: '/obligations',
    request: { query: { debtorPersonId: payer?.id ?? '', limit: 50 } },
    enabled: payer !== null,
  });
  const credits = useApiQuery({
    path: '/credits',
    request: { query: { ownerPersonId: payer?.id ?? '', limit: 20 } },
    enabled: payer !== null,
  });
  const products = useApiQuery({
    path: '/pos-products',
    request: { query: { facilityId: facility.facilityId ?? '', status: 'active', limit: 100 } },
    enabled: facility.facilityId !== null,
  });
  const registers = useApiQuery({
    path: '/pos-registers',
    request: { query: { facilityId: facility.facilityId ?? '', limit: 20 } },
    enabled: facility.facilityId !== null,
  });
  const openSession = registers.data?.items.find((r) => r.openSessionId)?.openSessionId ?? null;

  const owed = (obligations.data?.items ?? []).filter(
    (o) => o.status === 'open' && owedMinor(o) > 0,
  );
  const credit = (credits.data?.items ?? []).filter(
    (c) => c.status === 'active' && c.remainingMinor > 0 && c.permittedUses.includes('obligation'),
  );
  const creditMinor = credit.reduce((sum, c) => sum + c.remainingMinor, 0);

  const [chip, setChip] = useState<Chip>(householdId ? 'owed' : 'service');
  const [search, setSearch] = useState('');
  const [fees, setFees] = useState<string[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [token, setToken] = useState('');
  const [picking, setPicking] = useState(householdId === null);
  const [paid, setPaid] = useState<{ total: number; saleId: string | null; how: string } | null>(
    null,
  );
  const commands = useKeyedCommands({
    invalidate: [
      ['api', '/obligations'],
      ['api', '/credits'],
      ['api', '/people/{id}/money-summary'],
    ],
  });

  const chosenFees = owed.filter((o) => fees.includes(o.id));
  const productList = products.data?.items ?? [];
  const chosenProducts = productList.filter((p) => (qty[p.id] ?? 0) > 0);
  const feesMinor = chosenFees.reduce((s, o) => s + owedMinor(o), 0);
  const productsMinor = chosenProducts.reduce((s, p) => s + p.priceMinor * (qty[p.id] ?? 0), 0);
  const appliedCredit = Math.min(creditMinor, feesMinor);
  const totalMinor = feesMinor - appliedCredit + productsMinor;
  const currency = chosenProducts[0]?.currency ?? chosenFees[0]?.totals.currency ?? 'USD';
  const feesAfterCredit = feesMinor - appliedCredit;
  const busy = commands.anyPending;

  const visible = (() => {
    const term = search.trim().toLowerCase();
    const match = (text: string) => term === '' || text.toLowerCase().includes(term);
    if (chip === 'owed') return { fees: owed.filter((o) => match(o.description)), items: [] };
    if (chip === 'custom') return { fees: [], items: [] };
    return {
      fees: term ? owed.filter((o) => match(o.description)) : [],
      items: productList.filter((p) => p.kind === chip && match(p.name)),
    };
  })();

  const childOf = (o: Obligation): Person | null =>
    children.find((c) => new RegExp(`\\b${c.givenName}\\b`).test(o.description)) ?? null;

  const pay = async (how: 'cash' | 'terminal' | 'card') => {
    if (totalMinor <= 0 && feesMinor === 0) return;
    const facilityId = facility.facilityId;
    if (!facilityId) return;
    let saleId: string | null = null;
    // 1. Products: a register sale, its lines, then one tender for its total.
    if (chosenProducts.length > 0) {
      if (!openSession) return;
      const sale = await commands.run('sale', 'post', '/pos-sales', {
        body: {
          registerSessionId: openSession,
          ...(payer ? { customerPersonId: payer.id } : {}),
        },
      });
      if (!sale) return;
      let current = sale;
      for (const product of chosenProducts) {
        const next = await commands.run(`line|${product.id}`, 'post', '/pos-sales/{id}/lines', {
          path: { id: sale.id },
          body: {
            productId: product.id,
            quantity: qty[product.id] ?? 1,
            expectedRevision: current.revision,
          },
        });
        if (!next) return;
        current = next;
      }
      const body =
        how === 'cash'
          ? {
              kind: 'cash' as const,
              amountMinor: current.remainingMinor,
              expectedRevision: current.revision,
            }
          : how === 'terminal'
            ? {
                kind: 'external' as const,
                amountMinor: current.remainingMinor,
                expectedRevision: current.revision,
                evidence: { reference: 'Front desk card terminal' },
              }
            : {
                kind: 'card' as const,
                amountMinor: current.remainingMinor,
                paymentMethodToken: token,
                expectedRevision: current.revision,
              };
      const tendered = await commands.run('tender', 'post', '/pos-sales/{id}/tenders', {
        path: { id: sale.id },
        body,
      });
      if (!tendered) return;
      saleId = sale.id;
    }
    // 2. The family credit against the fees, oldest fee first.
    let left = appliedCredit;
    for (const o of chosenFees) {
      for (const c of credit) {
        if (left <= 0) break;
        const use = Math.min(left, owedMinor(o), c.remainingMinor);
        if (use <= 0) continue;
        const ok = await commands.run(`redeem|${o.id}|${c.id}`, 'post', '/credits/{id}/redeem', {
          path: { id: c.id },
          body: { obligationId: o.id, amountMinor: use },
        });
        if (!ok) return;
        left -= use;
      }
    }
    // 3. What the fees still owe: a desk tender each (cash or the card terminal).
    let creditLeft = appliedCredit;
    for (const o of chosenFees) {
      const fromCredit = Math.min(creditLeft, owedMinor(o));
      creditLeft -= fromCredit;
      const due = owedMinor(o) - fromCredit;
      if (due <= 0) continue;
      const ok = await commands.run(`fee|${o.id}`, 'post', '/cash-tenders', {
        body: {
          obligationId: o.id,
          facilityId,
          tenderKind: how === 'cash' ? 'cash' : 'external_terminal',
          amountMinor: due,
          currency: o.totals.currency,
          ...(payer ? { payerPersonId: payer.id } : {}),
          evidence: {
            reference: how === 'cash' ? 'Front desk cash' : 'Front desk card terminal',
          },
        },
      });
      if (!ok) return;
    }
    setPaid({
      total: totalMinor,
      saleId,
      how: how === 'cash' ? 'cash' : how === 'terminal' ? 'the card terminal' : 'card',
    });
    setFees([]);
    setQty({});
  };

  const errors = Object.entries({
    sale: commands.outcome('sale').error,
    tender: commands.outcome('tender').error,
    ...Object.fromEntries(
      [...chosenFees.map((o) => `fee|${o.id}`), ...chosenProducts.map((p) => `line|${p.id}`)].map(
        (k) => [k, commands.outcome(k).error],
      ),
    ),
  }).filter((e): e is [string, ApiError] => e[1] instanceof ApiError);

  const familyName = household.data?.name ?? null;
  const cardBlocked =
    feesAfterCredit > 0
      ? 'Fees are taken by cash or the card terminal at the desk.'
      : chosenProducts.length === 0
        ? null
        : !DevCardMethodPicker
          ? 'Card payments wait for the payment provider (DEC-019).'
          : !payer
            ? 'Choose the family to charge a card.'
            : !token
              ? 'Choose the card method below.'
              : null;
  const nothing = feesMinor === 0 && productsMinor === 0;
  const needsRegister = chosenProducts.length > 0 && !openSession;

  return (
    <section className="ds" aria-labelledby="ds-title">
      <h1 id="ds-title" className="ops-sr">
        Front desk sale
      </h1>
      <div className="ds-main">
        <div className="ds-top">
          <label className="ds-search">
            <Icon name="search" />
            <input
              aria-label="Search items, fees, programs"
              placeholder="Search items, fees, programs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button type="button" className="ds-scan" onClick={() => setPicking(true)}>
            <Icon name="qr_code_scanner" />
            Scan
          </button>
        </div>
        <div className="ds-chips" role="tablist" aria-label="What to sell">
          {CHIPS.filter((c) => c.id !== 'owed' || payer).map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={chip === c.id}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {chip === 'custom' ? (
          <div className="ds-note">
            <p>
              A custom amount is an open-amount line on the register&apos;s sale page: above your
              ceiling a second person approves it.
            </p>
            {openSession ? (
              <Link to={POS_PATHS.session(openSession)}>Open the register to start a sale</Link>
            ) : (
              <Link to={POS_PATHS.base}>Open a register first</Link>
            )}
          </div>
        ) : (
          <div className="ds-tiles">
            {visible.fees.map((o) => {
              const chosen = fees.includes(o.id);
              const child = childOf(o);
              const due = new Date(o.dueAt);
              const soon = due.getTime() - now.getTime() <= WEEK;
              return (
                <button
                  key={o.id}
                  type="button"
                  className="ds-tile"
                  aria-pressed={chosen}
                  disabled={busy}
                  onClick={() =>
                    setFees((prev) =>
                      prev.includes(o.id) ? prev.filter((id) => id !== o.id) : [...prev, o.id],
                    )
                  }
                >
                  <span className="ds-tile-kind">
                    {child ? (
                      <DeskAvatar
                        personId={child.id}
                        name={`${child.givenName} ${child.familyName}`}
                        size={26}
                      />
                    ) : (
                      <span className="ds-tile-icon">
                        <Icon name="receipt_long" size={18} />
                      </span>
                    )}
                    {child?.givenName ?? 'Fee'}
                  </span>
                  <b className="ds-tile-name">
                    {child
                      ? o.description.replace(new RegExp(` · ${child.givenName}$`), '')
                      : o.description}
                  </b>
                  <span className="ds-tile-meta" data-tone={soon ? 'warning' : undefined}>
                    {soon ? '▲ ' : ''}Due{' '}
                    {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
                      due,
                    )}
                  </span>
                  <b className="ds-tile-price">{formatMoney(owedMinor(o), o.totals.currency)}</b>
                  {chosen ? (
                    <span className="ds-tile-check" aria-hidden="true">
                      <Icon name="check" size={16} />
                    </span>
                  ) : null}
                </button>
              );
            })}
            {visible.items.map((p) => {
              const count = qty[p.id] ?? 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="ds-tile"
                  aria-pressed={count > 0}
                  aria-label={`${p.name}, ${formatMoney(p.priceMinor, p.currency)}${count > 0 ? `, ${count} in the cart` : ''}`}
                  disabled={busy}
                  onClick={() => setQty((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? 0) + 1 }))}
                >
                  <span className="ds-tile-kind">
                    <span className="ds-tile-icon">
                      <Icon name={KIND_ICON[p.kind]} size={18} />
                    </span>
                    {KIND_LABEL[p.kind]}
                  </span>
                  <b className="ds-tile-name">{p.name}</b>
                  <span className="ds-tile-meta">{p.sku}</span>
                  <b className="ds-tile-price">{formatMoney(p.priceMinor, p.currency)}</b>
                  {count > 0 ? (
                    <span className="ds-tile-count" aria-hidden="true">
                      ×{count}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {chip === 'owed' && payer && obligations.data && owed.length === 0 ? (
              <p className="caption">Nothing owed by this family.</p>
            ) : null}
            {chip !== 'owed' && products.data && visible.items.length === 0 ? (
              <p className="caption">No items here yet.</p>
            ) : null}
            {(chip === 'owed' && !obligations.data && payer) || (chip !== 'owed' && !products.data)
              ? [0, 1, 2].map((i) => (
                  <span key={i} className="ds-tile ds-skeleton" aria-hidden="true" />
                ))
              : null}
          </div>
        )}
      </div>
      <aside className="ds-cart" aria-label="Cart" aria-busy={busy || undefined}>
        <header className="ds-family">
          {picking || !payer ? (
            <div className="ds-picker">
              <PersonSearch
                label="Choose the family"
                chooseLabel="Choose"
                onChoose={(person) => {
                  void api
                    .get('/people/{id}/authority', { path: { id: person.id } })
                    .then((a) => {
                      const h = a.households[0];
                      if (h) {
                        setParams({ household: h.id });
                        setMembers(null);
                        setChip('owed');
                      }
                      setPicking(false);
                    })
                    .catch(() => setPicking(false));
                }}
              />
            </div>
          ) : (
            <>
              <DeskAvatar
                personId={payer.id}
                name={`${payer.givenName} ${payer.familyName}`}
                size={44}
              />
              <span className="ds-family-text">
                <b>{familyName}</b>
                <span className="caption">
                  {payer.givenName}
                  {creditMinor > 0 ? ` · ${formatMoney(creditMinor, currency)} credit` : ''}
                </span>
              </span>
              <button type="button" className="ds-text" onClick={() => setPicking(true)}>
                Change
              </button>
            </>
          )}
        </header>
        {paid ? (
          <div className="ds-paid" role="status">
            <Icon name="check_circle" size={40} />
            <b>
              Paid {formatMoney(paid.total, currency)} by {paid.how}
            </b>
            <span>
              Receipt sent. Fees paid here show as paid in the family&apos;s app.
              {paid.saleId ? (
                <>
                  {' '}
                  <Link to={POS_PATHS.receipt(paid.saleId)}>Open the receipt</Link>
                </>
              ) : null}
            </span>
            <button type="button" className="ds-text" onClick={() => setPaid(null)}>
              New sale
            </button>
          </div>
        ) : (
          <ul className="ds-lines" aria-label="In the cart">
            {chosenFees.map((o) => (
              <li key={o.id}>
                <span>{o.description}</span>
                <b>{formatMoney(owedMinor(o), o.totals.currency)}</b>
              </li>
            ))}
            {chosenProducts.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <span className="ds-stepper">
                  <button
                    type="button"
                    aria-label={`One less ${p.name}`}
                    disabled={busy}
                    onClick={() =>
                      setQty((prev) => ({ ...prev, [p.id]: Math.max(0, (prev[p.id] ?? 0) - 1) }))
                    }
                  >
                    −
                  </button>
                  <span>{qty[p.id]}</span>
                  <button
                    type="button"
                    aria-label={`One more ${p.name}`}
                    disabled={busy}
                    onClick={() => setQty((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? 0) + 1 }))}
                  >
                    +
                  </button>
                </span>
                <b>{formatMoney(p.priceMinor * (qty[p.id] ?? 0), p.currency)}</b>
              </li>
            ))}
            {appliedCredit > 0 ? (
              <li className="ds-credit">
                <span>Family credit</span>
                <b>−{formatMoney(appliedCredit, currency)}</b>
              </li>
            ) : null}
            {nothing ? <li className="caption">Tap an item or a fee to add it.</li> : null}
          </ul>
        )}
        {!paid ? (
          <footer className="ds-pay">
            <div className="ds-total">
              <span>Total</span>
              <b>{formatMoney(totalMinor, currency)}</b>
            </div>
            {needsRegister ? (
              <p className="caption">
                Items need an open register. <Link to={POS_PATHS.base}>Open one</Link>.
              </p>
            ) : null}
            <div className="ds-pay-row">
              <button
                type="button"
                className="ds-button ds-secondary"
                disabled={busy || nothing || needsRegister}
                onClick={() => void pay('cash')}
              >
                <Icon name="payments" />
                Cash
              </button>
              <button
                type="button"
                className="ds-button ds-secondary"
                disabled={busy || nothing || needsRegister}
                onClick={() => void pay('terminal')}
              >
                <Icon name="contactless" />
                Tap to pay
              </button>
            </div>
            {chosenProducts.length > 0 && feesAfterCredit === 0 && DevCardMethodPicker ? (
              <Suspense fallback={null}>
                <DevCardMethodPicker value={token} onChange={setToken} disabled={busy} />
              </Suspense>
            ) : null}
            <button
              type="button"
              className="ds-button ds-primary"
              disabled={busy || nothing || cardBlocked !== null || needsRegister}
              aria-busy={busy || undefined}
              onClick={() => void pay('card')}
            >
              {busy ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : (
                <Icon name="credit_card" />
              )}
              Charge card · {formatMoney(totalMinor, currency)}
            </button>
            {cardBlocked && !nothing ? <p className="caption">{cardBlocked}</p> : null}
            <p className="caption ds-proposed">◷ A saved card on file is proposed.</p>
            {errors.map(([key, error]) => (
              <CommandError key={key} error={error} onRetry={() => void commands.resend(key)} />
            ))}
          </footer>
        ) : null}
      </aside>
    </section>
  );
}
