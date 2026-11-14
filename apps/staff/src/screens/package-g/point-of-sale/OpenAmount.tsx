/**
 * SCR-S-55 open-amount lines at the register (SPK-PAY-016, proposed amendment PA-08; capability
 * `open_amount_lines`, DEC-102 pending; §3.16 POS, §4.9):
 *
 * - OtherAmountForm: a line that is not a product: what it is for, an amount and a reason category
 *   of the approved list (`POST /v1/pos-sales/{id}/lines`). The categories and the viewer's own
 *   ceiling come from `GET /v1/pos-open-amount-rules`; while the facility has approved no policy
 *   the API applies its proposed default and the form says so, naming the decision. An amount
 *   above the ceiling can be entered: the form says, before it is sent, that the sale will then
 *   wait for a second person.
 * - OpenAmountApprovals: the approval step. While an open sale holds a line above the ceiling of
 *   the person who entered it, the page says the sale cannot take a tender, who approves (the
 *   approving roles the API names, never the person who entered the line) and, to a permitted
 *   second person, offers the approval with its reason
 *   (`POST /v1/pos-sales/{id}/lines/{lineId}/approval`). The line can be removed instead.
 * - OpenAmountLineText / RemoveOpenAmountLine: how such a line reads on the sale and its ticket.
 * - SessionOpenAmountLines: the session's open-amount lines apart from its product sales
 *   (`GET /v1/pos-register-sessions/{id}/open-amount-lines`), for review.
 *
 * Nothing here is shown while the switch is off, except the facts of a line that already exists
 * (the API keeps reads, removal, tenders and returns available, DEC-016).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../../api/permissions';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { useApiQuery } from '../../../api/useApiQuery';
import { roleLabel } from '../../../features/insight-admin/labels';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { MoneyField } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { POS_SALE_STATUS } from '../../../features/pos-access-accounting/labels';
import { useMyPersonId } from '../../../features/pos-access-accounting/me';
import { POS_ACTIONS } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import {
  formatInstant,
  formatMoney,
  parseMoneyInput,
} from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { POS_PATHS, SALE_QUERY_PREFIX } from './paths';

type Sale = Schema<'PosSale'>;
type Line = Schema<'PosSaleLine'>;

/** The decision record the open values wait on (categories, ceilings, who enters and approves). */
const DECISION = 'DEC-102';
const SALE_COMMAND = { invalidate: [SALE_QUERY_PREFIX] } as const;

/** Session lines are keyed by their sale line (module level: a stable `keyOf`). */
const sessionLineKey = (item: Schema<'PosSessionOpenAmountLine'>) => item.lineId;

/**
 * What the viewer is offered. Strict on the switch: while the permission read has not answered,
 * or says off, nothing of this feature is offered (a new capability is never shown by default).
 */
export function useOpenAmountOffer(facilityId: string) {
  const permissions = usePermissions();
  const on = permissions.isCapabilityEnabled('open_amount_lines') === true;
  return {
    on,
    mayEnter: on && permissions.isPermitted(POS_ACTIONS.enterOpenAmount, facilityId) === true,
    mayApprove: on && permissions.isPermitted(POS_ACTIONS.approveOpenAmount, facilityId) === true,
  };
}

/** The open-amount lines of an open sale that still wait for their second approval. */
export function linesAwaitingApproval(sale: Sale): Line[] {
  if (sale.status !== 'open') return [];
  return sale.lines.filter(
    (l) => l.openAmount?.approvalRequired === true && !l.openAmount.approval,
  );
}

function approverWords(roles: readonly string[] | undefined): string {
  if (!roles || roles.length === 0) return 'a person permitted to approve open amounts';
  const names = roles.map((r) => roleLabel(r).toLowerCase());
  return `a ${names.join(' or a ')}`;
}

// ---------------------------------------------------------------------------------------------
// Entering a line
// ---------------------------------------------------------------------------------------------

export function OtherAmountForm({ sale, onReload }: { sale: Sale; onReload: () => void }) {
  const online = useOnline();
  const rules = useApiQuery({
    path: '/pos-open-amount-rules',
    request: { query: { facilityId: sale.facilityId } },
  });
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-sales/{id}/lines', SALE_COMMAND);
  const intent = useIntentForm(command);
  const c = sale.currency;
  const amountMinor = parseMoneyInput(amount, c);
  const data = rules.data;
  const ceiling = data?.ceilingMinor ?? null;
  const otherCurrency =
    data && data.currency !== null && data.currency !== c ? data.currency : null;
  const above = amountMinor !== null && ceiling !== null && amountMinor > ceiling;
  const descriptionError = !description.trim()
    ? 'Describe what the amount is for.'
    : description.trim().length > 200
      ? 'Use 200 characters or fewer.'
      : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (descriptionError || amountMinor === null || !category) return;
    const updated = await intent.send({
      path: { id: sale.id },
      body: {
        description: description.trim(),
        amountMinor,
        reasonCategory: category,
        expectedRevision: sale.revision,
      },
    });
    if (updated) {
      setDescription('');
      setAmount('');
      setCategory('');
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Other amount"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Other amount</h4>
      <p className="caption">
        For something that is not a product: a damage fee, a lost key, a one-off service. The reason
        category decides where it is booked and which approved taxes apply. A discount or a refund
        is never entered here.
      </p>
      {data === undefined && rules.error ? (
        <StateView variant="error" error={rules.error} onRetry={() => void rules.refetch()} />
      ) : otherCurrency ? (
        <p className="error-text">
          The approved ceilings are stated in {otherCurrency} and this sale is in {c}: no other
          amount can be added to it.
        </p>
      ) : (
        <>
          {data?.basis === 'proposed_default' ? (
            <p className="caption" data-testid="open-amount-proposed">
              Proposed values: the categories and your ceiling below are defaults until the facility
              approves its own ({DECISION}).
            </p>
          ) : null}
          <TextField
            label="What it is for"
            required
            hint="Shown on the receipt and in the register report. Up to 200 characters."
            value={description}
            onChange={setDescription}
            error={touched ? descriptionError : null}
            disabled={intent.locked}
          />
          <SelectField
            label="Reason category"
            required
            value={category}
            onChange={setCategory}
            options={(data?.categories ?? []).map((k) => ({ value: k.code, label: k.label }))}
            placeholder={data === undefined ? 'Loading categories…' : 'Choose a category'}
            error={touched && !category ? 'Choose a reason category.' : null}
            disabled={intent.locked}
          />
          <MoneyField
            label="Amount"
            currency={c}
            required
            value={amount}
            onChange={setAmount}
            hint={
              ceiling === null
                ? 'A positive amount, before taxes.'
                : `A positive amount, before taxes. Your ceiling is ${formatMoney(ceiling, c)}: above it a second person approves.`
            }
            error={touched && amountMinor === null ? `Enter a positive amount in ${c}.` : null}
            disabled={intent.locked}
          />
          {above ? (
            <p role="status" data-testid="open-amount-above">
              <StatusBadge tone="warning" label="Above your ceiling" /> This amount is above your
              ceiling of {formatMoney(ceiling, c)}. It can be added, but the sale cannot take a
              tender or finish until {approverWords(data?.approverRoles)} other than you approves
              the line.
            </p>
          ) : null}
          <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
            Add the amount to the sale
          </Button>
        </>
      )}
      <OfflineCaption action="adding an amount" />
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          onReload();
        }}
        currency={c}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// The approval step
// ---------------------------------------------------------------------------------------------

export function OpenAmountApprovals({ sale, onReload }: { sale: Sale; onReload: () => void }) {
  const awaiting = linesAwaitingApproval(sale);
  // Nothing is read or shown for a sale without such a line.
  if (awaiting.length === 0) return null;
  return <ApprovalStep sale={sale} awaiting={awaiting} onReload={onReload} />;
}

function ApprovalStep({
  sale,
  awaiting,
  onReload,
}: {
  sale: Sale;
  awaiting: Line[];
  onReload: () => void;
}) {
  const offer = useOpenAmountOffer(sale.facilityId);
  const me = useMyPersonId();
  const rules = useApiQuery({
    path: '/pos-open-amount-rules',
    request: { query: { facilityId: sale.facilityId } },
    enabled: offer.on,
  });
  return (
    <section
      className="rf-panel"
      aria-label="Second approval needed"
      data-testid="open-amount-approval"
    >
      <h4>Second approval needed</h4>
      <p>
        <StatusBadge tone="warning" label="The sale cannot take a tender yet" />
      </p>
      <p>
        {awaiting.length === 1 ? 'A line' : `${awaiting.length} lines`} on this sale{' '}
        {awaiting.length === 1 ? 'is' : 'are'} above the ceiling of the person who entered{' '}
        {awaiting.length === 1 ? 'it' : 'them'}. The sale cannot take a tender or finish before{' '}
        {approverWords(rules.data?.approverRoles)} approves each one. The person who entered a line
        never approves it. A line can also be removed from the ticket.
      </p>
      <ul className="list" aria-label="Lines waiting for a second approval">
        {awaiting.map((line) => (
          <li key={line.id}>
            <ApproveLine sale={sale} line={line} me={me} offer={offer} onReload={onReload} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApproveLine({
  sale,
  line,
  me,
  offer,
  onReload,
}: {
  sale: Sale;
  line: Line;
  me: string | null;
  offer: ReturnType<typeof useOpenAmountOffer>;
  onReload: () => void;
}) {
  const online = useOnline();
  const command = useApiCommand('post', '/pos-sales/{id}/lines/{lineId}/approval', SALE_COMMAND);
  const open = line.openAmount;
  if (!open) return null;
  const c = sale.currency;
  const mine = me !== null && me === open.enteredByPersonId;
  return (
    <div>
      <p>
        <strong>{open.description}</strong> · {line.name} · {formatMoney(line.unitPriceMinor, c)}{' '}
        <span className="caption">
          Ceiling {formatMoney(open.ceilingMinor, c)}. Entered by{' '}
          <PersonName id={open.enteredByPersonId} fallback="Staff" />.
        </span>
      </p>
      {!offer.on ? (
        <p className="caption">
          Open-amount lines are turned off: this line cannot be approved now. Remove it from the
          ticket to finish the sale.
        </p>
      ) : mine ? (
        <p className="caption">
          You entered this line: another person approves it. Ask them to open this sale.
        </p>
      ) : offer.mayApprove ? (
        <ReasonAction
          label={`Approve: ${open.description}`}
          confirmLabel="Approve the line"
          reasonLabel="Reason for approving"
          explanation="Your approval is recorded with your name, the time and this reason. It cannot be changed afterwards."
          busy={command.isProcessing}
          disabled={!online}
          onConfirm={async (reason) => {
            try {
              await command.submit({
                path: { id: sale.id, lineId: line.id },
                body: { reason, expectedRevision: sale.revision },
              });
              return true;
            } catch {
              return false;
            }
          }}
        />
      ) : (
        <p className="caption">
          Approving needs the permission {POS_ACTIONS.approveOpenAmount}, which your role does not
          include.
        </p>
      )}
      <CommandError
        error={command.error}
        onReload={() => {
          command.reset();
          onReload();
        }}
        currency={c}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// How a line reads
// ---------------------------------------------------------------------------------------------

/** The description, category and approval facts of an open-amount line, for a table cell. */
export function OpenAmountLineText({ line, zone }: { line: Line; zone: string | null }) {
  const open = line.openAmount;
  if (!open) return null;
  return (
    <>
      {open.description} · Other amount: {line.name}
      <span className="caption">
        {' '}
        Books to {open.revenueCategory}. Entered by{' '}
        <PersonName id={open.enteredByPersonId} fallback="Staff" />.
        {open.approval ? (
          <>
            {' '}
            Approved by <PersonName id={open.approval.approvedByPersonId} fallback="Staff" />,{' '}
            {formatInstant(open.approval.approvedAt, zone)}: {open.approval.reason}
          </>
        ) : open.approvalRequired ? (
          ' Waiting for a second approval.'
        ) : null}
      </span>
    </>
  );
}

/** An open-amount line is one unit: the ticket offers its removal only (never − and +). */
export function RemoveOpenAmountLine({
  sale,
  line,
  onReload,
}: {
  sale: Sale;
  line: Line;
  onReload: () => void;
}) {
  const online = useOnline();
  const command = useApiCommand('post', '/pos-sales/{id}/lines/{lineId}/quantity', SALE_COMMAND);
  const intent = useIntentForm(command);
  const label = line.openAmount?.description ?? line.name;
  return (
    <span className="pos-stepper">
      <button
        type="button"
        className="pos-step"
        aria-label={`Remove ${label}`}
        disabled={!online || intent.locked || command.isProcessing}
        onClick={() =>
          void intent.send({
            path: { id: sale.id, lineId: line.id },
            body: { quantity: 0, expectedRevision: sale.revision },
          })
        }
      >
        −
      </button>
      {command.error ? (
        <span className="pos-step-error">
          <CommandError
            error={command.error}
            onRetry={intent.retry}
            onReload={() => {
              intent.restart();
              onReload();
            }}
            currency={sale.currency}
          />
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The register session's open-amount lines
// ---------------------------------------------------------------------------------------------

export function SessionOpenAmountLines({
  sessionId,
  zone,
}: {
  sessionId: string;
  zone: string | null;
}) {
  const lines = useApiPages({
    path: '/pos-register-sessions/{id}/open-amount-lines',
    request: { path: { id: sessionId }, query: { limit: 50 } },
    keyOf: sessionLineKey,
  });
  return (
    <section aria-labelledby="pos-session-open-amounts">
      <h4 id="pos-session-open-amounts">Other amounts in this session</h4>
      <p className="caption">
        Lines that are not products, listed apart so they can be reviewed: what each was for, its
        category, who entered it and who approved it. Removed lines are not listed.
      </p>
      <QueryBoundary
        query={lines}
        label="the other amounts of this session"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No other amount in this session',
          description: 'Every line of this session is a product.',
        }}
      >
        {(items) => (
          <div className="rf-table-wrap">
            <table className="rf-table" aria-label="Other amounts in this session">
              <thead>
                <tr>
                  <th scope="col">Sale</th>
                  <th scope="col">What it was for</th>
                  <th scope="col">Category</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Entered by</th>
                  <th scope="col">Second approval</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.lineId}>
                    <td>
                      <Link to={POS_PATHS.sale(item.saleId)}>Sale {item.saleNumber}</Link>{' '}
                      <StatusBadge {...POS_SALE_STATUS[item.saleStatus]} />
                    </td>
                    <td>
                      {item.description}
                      {item.returnedQuantity > 0 ? (
                        <span className="caption"> Returned.</span>
                      ) : null}
                    </td>
                    <td>
                      {item.reasonLabel}
                      <span className="caption"> Books to {item.revenueCategory}.</span>
                    </td>
                    <td>
                      {formatMoney(item.lineTotalMinor, item.currency)}
                      {item.chargesMinor > 0 ? (
                        <span className="caption">
                          {' '}
                          {formatMoney(item.amountMinor, item.currency)} before taxes and fees.
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <PersonName id={item.enteredByPersonId} fallback="Staff" />
                      <span className="caption"> {formatInstant(item.enteredAt, zone)}</span>
                    </td>
                    <td>
                      {item.approval ? (
                        <>
                          <PersonName id={item.approval.approvedByPersonId} fallback="Staff" />
                          <span className="caption">
                            {' '}
                            {formatInstant(item.approval.approvedAt, zone)}: {item.approval.reason}
                          </span>
                        </>
                      ) : item.approvalRequired ? (
                        <StatusBadge tone="warning" label="waiting for a second approval" />
                      ) : (
                        `Not needed: within the ceiling of ${formatMoney(item.ceilingMinor, item.currency)}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
      <LoadMore pages={lines} label="other amounts" />
    </section>
  );
}
