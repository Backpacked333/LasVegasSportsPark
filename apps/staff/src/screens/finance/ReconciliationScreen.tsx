/**
 * SCR-S-38 Reconciliation (SPK-PAY-010, SPK-PAY-011, SPK-PAY-012, SPK-REPORT-002, §5.5): for a
 * period and currency (`GET /v1/finance/reconciliation-report`), orders, obligations, customer
 * receipts, refunds, credits, processor fees, disputes, settlements and cash each in their own
 * section, never netted; the operational subledger balances as posted (append-only, corrections
 * are reversing entries, nothing here edits a balance); payment volume is never shown as revenue.
 *
 * Commands (idempotency key per intent): record a processor settlement or cash drawer count
 * (`POST /v1/settlement-reconciliations`; a mismatch is a `discrepancy` raised to the finance
 * operator queue, unrelated discrepancies are never netted), and record a cash or external tender
 * against an obligation with evidence (`POST /v1/cash-tenders`; it bypasses no registration or
 * capacity check). The cash procedure is pending DEC-009, accounting export DEC-022. Period dates
 * are UTC calendar days, and the form says so. Unknown payment and refund outcomes open their
 * lists (`GET /v1/payments?status=unknown`, `GET /v1/refunds?status=unknown`, FIN-02); export
 * batches are SCR-S-57, used only when the `accounting` switch is on (DEC-016, DEC-081).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { useFacilities } from '../../features/registration-finance/facilities';
import {
  Facts,
  SelectField,
  TextArea,
  TextField,
} from '../../features/registration-finance/fields';
import {
  dateToInstant,
  formatInstant,
  formatMoney,
  localDayToInstant,
  parseMoneyInput,
} from '../../features/registration-finance/format';
import {
  LEDGER_ACCOUNT,
  SETTLEMENT_STATUS,
  TENDER_KIND,
} from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import {
  LockedNote,
  outcomePending,
  useSameRequest,
} from '../../features/registration-finance/sameRequest';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Report = Schema<'ReconciliationReport'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the period has no movement in any category. */
export function reportIsEmpty(report: Report): boolean {
  return (
    report.orders.count === 0 &&
    report.obligations.openCount === 0 &&
    report.obligations.settledCount === 0 &&
    report.receipts.count === 0 &&
    report.refunds.succeededMinor === 0 &&
    report.refunds.reservedMinor === 0 &&
    report.refunds.unknownCount === 0 &&
    report.credits.issuedMinor === 0 &&
    report.credits.redeemedMinor === 0 &&
    report.credits.pendingApprovalMinor === 0 &&
    report.processorFeesMinor === 0 &&
    report.disputes.count === 0 &&
    report.settlements.length === 0 &&
    report.cash.recordedMinor === 0
  );
}

function SettlementRow({ settlement }: { settlement: Schema<'SettlementReconciliation'> }) {
  return (
    <li>
      <div className="row-text">
        <span className="row-title">
          {settlement.kind === 'processor_settlement'
            ? `Processor settlement${settlement.provider ? ` (${settlement.provider})` : ''}`
            : 'Cash drawer'}
        </span>
        <span className="caption">
          {formatInstant(settlement.periodStart)} to {formatInstant(settlement.periodEnd)} ·
          expected {formatMoney(settlement.expectedMinor, settlement.currency)} · reported{' '}
          {formatMoney(settlement.reportedMinor, settlement.currency)} · difference{' '}
          {formatMoney(settlement.differenceMinor, settlement.currency)}
        </span>
      </div>
      <StatusBadge {...SETTLEMENT_STATUS[settlement.status]} />
    </li>
  );
}

function ReportView({ report }: { report: Report }) {
  const c = report.currency;
  return (
    <>
      <p className="caption">
        Each category is reported on its own and never netted. Payment volume is not revenue:
        revenue appears only as posted to the subledger (SPK-PAY-011).
      </p>
      <div className="rf-grid">
        <section className="rf-panel" aria-label="Orders">
          <h3>Orders</h3>
          <Facts
            label="Orders figures"
            items={[
              ['Orders', String(report.orders.count)],
              ['Order total', formatMoney(report.orders.totalMinor, c)],
              ['Paid orders', String(report.orders.paidCount)],
            ]}
          />
        </section>
        <section className="rf-panel" aria-label="Obligations">
          <h3>Obligations</h3>
          <Facts
            label="Obligations figures"
            items={[
              ['Open', String(report.obligations.openCount)],
              ['Open remaining', formatMoney(report.obligations.openRemainingMinor, c)],
              ['Settled', String(report.obligations.settledCount)],
            ]}
          />
        </section>
        <section className="rf-panel" aria-label="Customer receipts">
          <h3>Customer receipts</h3>
          <Facts
            label="Receipts figures"
            items={[
              ['Through the processor', formatMoney(report.receipts.processorMinor, c)],
              ['Cash and external tenders', formatMoney(report.receipts.cashMinor, c)],
              ['Receipts', String(report.receipts.count)],
              ['Excess held', formatMoney(report.receipts.excessMinor, c)],
            ]}
          />
        </section>
        <section className="rf-panel" aria-label="Refunds">
          <h3>Refunds</h3>
          <Facts
            label="Refunds figures"
            items={[
              ['Succeeded', formatMoney(report.refunds.succeededMinor, c)],
              ['Reserved, pending', formatMoney(report.refunds.reservedMinor, c)],
              ['Unknown outcomes', String(report.refunds.unknownCount)],
            ]}
          />
          {report.refunds.unknownCount > 0 ? (
            <Link to="/finance/credits">Open the refunds with an unknown result</Link>
          ) : null}
        </section>
        <section className="rf-panel" aria-label="Credits">
          <h3>Credits</h3>
          <Facts
            label="Credits figures"
            items={[
              ['Issued', formatMoney(report.credits.issuedMinor, c)],
              ['Redeemed', formatMoney(report.credits.redeemedMinor, c)],
              ['Pending approval', formatMoney(report.credits.pendingApprovalMinor, c)],
            ]}
          />
        </section>
        <section className="rf-panel" aria-label="Processor fees">
          <h3>Processor fees</h3>
          <p>{formatMoney(report.processorFeesMinor, c)}</p>
        </section>
        <section className="rf-panel" aria-label="Disputes">
          <h3>Disputes</h3>
          <p>{report.disputes.count}</p>
          <p className="caption">{report.disputes.note}</p>
        </section>
        <section className="rf-panel" aria-label="Cash">
          <h3>Cash</h3>
          <Facts
            label="Cash figures"
            items={[
              ['Recorded', formatMoney(report.cash.recordedMinor, c)],
              ['Not yet reconciled', formatMoney(report.cash.unreconciledMinor, c)],
            ]}
          />
        </section>
      </div>
      <section className="rf-panel" aria-labelledby="settlements-title">
        <h3 id="settlements-title">Settlements</h3>
        {report.settlements.length === 0 ? (
          <p>No settlement or cash drawer was reconciled in this period.</p>
        ) : (
          <ul className="list" aria-label="Settlements">
            {report.settlements.map((s) => (
              <SettlementRow key={s.id} settlement={s} />
            ))}
          </ul>
        )}
      </section>
      {report.exceptions.unknownPayments > 0 || report.exceptions.recoveryRequiredCheckouts > 0 ? (
        <section className="rf-panel" aria-labelledby="recon-exceptions-title">
          <h3 id="recon-exceptions-title">Recovery required</h3>
          <p>
            {report.exceptions.unknownPayments} unknown payment outcome(s) and{' '}
            {report.exceptions.recoveryRequiredCheckouts} checkout(s) needing recovery. Owner:
            finance operator queue.{' '}
            <Link to="/finance/payments?view=attempts">Open the payment attempts</Link> or{' '}
            <Link to="/finance/payments">the finance exceptions</Link>.
          </p>
        </section>
      ) : null}
      <section className="rf-panel" aria-labelledby="ledger-title">
        <h3 id="ledger-title">Subledger balances</h3>
        <p className="caption">
          Append-only: corrections are reversing or adjusting entries, and balances cannot be edited
          here (SPK-PAY-010).
        </p>
        <div className="rf-table-wrap">
          <table className="rf-table" aria-label="Subledger balances">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Debits</th>
                <th scope="col">Credits</th>
                <th scope="col">Balance (debit positive)</th>
              </tr>
            </thead>
            <tbody>
              {report.ledger.map((row) => (
                <tr key={row.accountCode}>
                  <td>{LEDGER_ACCOUNT[row.accountCode]}</td>
                  <td>{formatMoney(row.debitMinor, c)}</td>
                  <td>{formatMoney(row.creditMinor, c)}</td>
                  <td>{formatMoney(row.balanceMinor, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RecordSettlement() {
  const online = useOnline();
  const { facilities, timeZoneOf } = useFacilities();
  const [kind, setKind] = useState<'processor_settlement' | 'cash_drawer' | ''>('');
  const [provider, setProvider] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [currency, setCurrency] = useState('');
  const [reported, setReported] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const record = useApiCommand('post', '/settlement-reconciliations', {
    invalidate: [
      ['api', '/finance/reconciliation-report'],
      ['api', '/exceptions'],
    ],
  });
  const server = fieldErrorsOf(record.error);
  const same = useSameRequest(record.submit);
  const locked = outcomePending(record.error);
  // A cash drawer counts the facility's local days (SPK-SCHED-008): the API attaches every cash
  // tender recorded in [periodStart, periodEnd) to this count. A processor settlement is in UTC.
  const drawerZone = kind === 'cash_drawer' ? timeZoneOf(facilityId) : null;
  const dayClock =
    kind === 'cash_drawer'
      ? drawerZone
        ? `facility time, ${drawerZone}`
        : 'facility time'
      : 'UTC';
  return (
    <details className="rf-panel">
      <summary>Record a settlement or cash drawer count</summary>
      <form
        noValidate
        aria-label="Record a settlement or cash drawer count"
        onSubmit={(event) => {
          event.preventDefault();
          const errors: Record<string, string> = {};
          const code = currency.trim().toUpperCase();
          if (!kind) errors.kind = 'Choose what is being reconciled.';
          if (kind === 'processor_settlement' && !provider.trim())
            errors.provider = 'Name the processor.';
          if (kind === 'cash_drawer' && !facilityId.trim())
            errors.facilityId = 'Choose the facility.';
          if (kind === 'cash_drawer' && facilityId.trim() && !drawerZone)
            errors.facilityId =
              'The time zone of this facility is not known to you, so its days cannot be counted. Ask an administrator.';
          const periodStart =
            kind === 'cash_drawer'
              ? drawerZone
                ? localDayToInstant(from, drawerZone)
                : null
              : dateToInstant(from);
          const periodEnd =
            kind === 'cash_drawer'
              ? drawerZone
                ? localDayToInstant(to, drawerZone, true)
                : null
              : dateToInstant(to, true);
          if (!periodStart) errors.periodStart = 'Enter the first day.';
          if (!periodEnd) errors.periodEnd = 'Enter the last day.';
          if (periodStart && periodEnd && periodStart >= periodEnd)
            errors.periodEnd = 'The period must end after it starts.';
          if (!/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
          const reportedMinor = /^[A-Z]{3}$/.test(code)
            ? parseMoneyInput(reported, code, true)
            : null;
          if (reportedMinor === null) errors.reportedMinor = 'Enter the reported total.';
          setLocal(errors);
          if (
            !kind ||
            !periodStart ||
            !periodEnd ||
            reportedMinor === null ||
            Object.keys(errors).length > 0
          )
            return;
          same
            .send({
              body: {
                kind,
                periodStart,
                periodEnd,
                currency: code,
                reportedMinor,
                ...(kind === 'processor_settlement'
                  ? { provider: provider.trim() }
                  : { facilityId: facilityId.trim() }),
                ...(reference.trim() ? { externalReference: reference.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              },
            })
            .then(() => setReported(''))
            .catch(() => undefined);
        }}
      >
        <fieldset className="rf-plain" disabled={locked}>
          <div className="rf-grid">
            <SelectField
              label="What is reconciled"
              required
              value={kind}
              placeholder="Choose"
              onChange={(v) => setKind(v as 'processor_settlement' | 'cash_drawer' | '')}
              options={[
                { value: 'processor_settlement', label: 'Processor settlement' },
                { value: 'cash_drawer', label: 'Cash drawer' },
              ]}
              error={local.kind ?? server.kind}
            />
            {kind === 'processor_settlement' ? (
              <TextField
                label="Processor"
                required
                value={provider}
                onChange={setProvider}
                error={local.provider ?? server.provider}
              />
            ) : null}
            {kind === 'cash_drawer' ? (
              facilities.length > 0 ? (
                <SelectField
                  label="Facility"
                  required
                  value={facilityId}
                  placeholder="Choose a facility"
                  onChange={setFacilityId}
                  options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                  error={local.facilityId ?? server.facilityId}
                />
              ) : (
                <TextField
                  label="Facility reference"
                  required
                  value={facilityId}
                  onChange={setFacilityId}
                  error={local.facilityId ?? server.facilityId}
                />
              )
            ) : null}
            <TextField
              label={`First day (${dayClock})`}
              type="date"
              required
              value={from}
              onChange={setFrom}
              error={local.periodStart ?? server.periodStart}
            />
            <TextField
              label={`Last day (${dayClock})`}
              type="date"
              required
              value={to}
              onChange={setTo}
              error={local.periodEnd ?? server.periodEnd}
            />
            <TextField
              label="Settlement currency"
              required
              value={currency}
              onChange={setCurrency}
              error={local.currency ?? server.currency}
            />
            <TextField
              label="Reported total"
              inputMode="decimal"
              required
              value={reported}
              onChange={setReported}
              error={local.reportedMinor ?? server.reportedMinor}
            />
            <TextField label="External reference" value={reference} onChange={setReference} />
          </div>
          <TextArea label="Settlement notes" value={notes} onChange={setNotes} />
          <div className="rf-actions">
            <Button type="submit" busy={record.isProcessing} disabled={!online || locked}>
              Reconcile
            </Button>
          </div>
        </fieldset>
        <OfflineCaption action="recording a reconciliation" />
        {record.isProcessing ? <p role="status">Matching against the ledger…</p> : null}
        {record.data ? (
          <div role="status">
            <StatusBadge {...SETTLEMENT_STATUS[record.data.status]} /> Expected{' '}
            {formatMoney(record.data.expectedMinor, record.data.currency)}, reported{' '}
            {formatMoney(record.data.reportedMinor, record.data.currency)}, difference{' '}
            {formatMoney(record.data.differenceMinor, record.data.currency)}.
            {record.data.status === 'discrepancy'
              ? ' The discrepancy is in the finance operator queue; it is never netted against other differences.'
              : ''}
          </div>
        ) : null}
        <LockedNote
          error={record.error}
          onNewRequest={() => {
            record.reset();
            same.forget();
          }}
        />
        <CommandError error={record.error} onRetry={same.retry} />
      </form>
    </details>
  );
}

function RecordTender({ obligationId }: { obligationId: string }) {
  const online = useOnline();
  const { facilities } = useFacilities();
  const [obligation, setObligation] = useState(obligationId);
  const [facilityId, setFacilityId] = useState('');
  const [tenderKind, setTenderKind] = useState<Schema<'CashTenderKind'>>('cash');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const record = useApiCommand('post', '/cash-tenders', {
    invalidate: [
      ['api', '/finance/reconciliation-report'],
      ['api', '/obligations'],
      ['api', '/obligations/{id}'],
    ],
  });
  const server = fieldErrorsOf(record.error);
  const same = useSameRequest(record.submit);
  const locked = outcomePending(record.error);
  return (
    <details className="rf-panel" open={obligationId !== ''}>
      <summary>Record a cash or external tender</summary>
      <StateView
        variant="pending-decision"
        subject="The approved cash and external tender procedure"
        decisions={PENDING.refundsCreditsCash.ids.slice(0, 1)}
        owner={PENDING.refundsCreditsCash.owner}
      />
      <p className="caption">
        A tender needs evidence and the permission to record it, and never bypasses registration or
        capacity checks (SPK-PAY-012).
      </p>
      <form
        noValidate
        aria-label="Record a cash or external tender"
        onSubmit={(event) => {
          event.preventDefault();
          const errors: Record<string, string> = {};
          const code = currency.trim().toUpperCase();
          if (!UUID.test(obligation.trim()))
            errors.obligationId = 'Enter the obligation reference.';
          if (!facilityId.trim()) errors.facilityId = 'Choose the facility where it was received.';
          if (!/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
          const minor = /^[A-Z]{3}$/.test(code) ? parseMoneyInput(amount, code) : null;
          if (minor === null) errors.amountMinor = 'Enter a positive amount.';
          if (!reference.trim()) errors.reference = 'Enter the evidence reference.';
          setLocal(errors);
          if (minor === null || Object.keys(errors).length > 0) return;
          same
            .send({
              body: {
                obligationId: obligation.trim(),
                facilityId: facilityId.trim(),
                tenderKind,
                amountMinor: minor,
                currency: code,
                evidence: {
                  reference: reference.trim(),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                },
              },
            })
            .then(() => setAmount(''))
            .catch(() => undefined);
        }}
      >
        <fieldset className="rf-plain" disabled={locked}>
          <div className="rf-grid">
            <TextField
              label="Obligation reference"
              required
              value={obligation}
              onChange={setObligation}
              error={local.obligationId ?? server.obligationId}
            />
            {facilities.length > 0 ? (
              <SelectField
                label="Tender facility"
                required
                value={facilityId}
                placeholder="Choose a facility"
                onChange={setFacilityId}
                options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                error={local.facilityId ?? server.facilityId}
              />
            ) : (
              <TextField
                label="Tender facility reference"
                required
                value={facilityId}
                onChange={setFacilityId}
                error={local.facilityId ?? server.facilityId}
              />
            )}
            <SelectField
              label="Tender kind"
              value={tenderKind}
              onChange={(v) => setTenderKind(v as Schema<'CashTenderKind'>)}
              options={Object.entries(TENDER_KIND).map(([value, label]) => ({ value, label }))}
            />
            <TextField
              label="Tender amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={setAmount}
              error={local.amountMinor ?? server.amountMinor}
            />
            <TextField
              label="Tender currency"
              required
              value={currency}
              onChange={setCurrency}
              error={local.currency ?? server.currency}
            />
            <TextField
              label="Evidence reference"
              required
              value={reference}
              onChange={setReference}
              error={local.reference ?? server['evidence.reference']}
            />
          </div>
          <TextArea label="Evidence notes" value={notes} onChange={setNotes} />
          <div className="rf-actions">
            <Button type="submit" busy={record.isProcessing} disabled={!online || locked}>
              Record the tender
            </Button>
          </div>
        </fieldset>
        <OfflineCaption action="recording a tender" />
        {record.data ? (
          <p role="status">
            Tender recorded: {formatMoney(record.data.amountMinor, record.data.currency)}
            {record.data.receipt
              ? `; allocated ${formatMoney(record.data.receipt.allocatedMinor, record.data.currency)}, excess ${formatMoney(record.data.receipt.excessMinor, record.data.currency)}`
              : ''}
            {record.data.overpaymentCreditId
              ? '; the excess is held as a credit pending approval'
              : ''}
            . It is reconciled with the next cash drawer count.
          </p>
        ) : null}
        <LockedNote
          error={record.error}
          onNewRequest={() => {
            record.reset();
            same.forget();
          }}
        />
        <CommandError
          error={record.error}
          currency={currency.trim().toUpperCase() || null}
          onRetry={same.retry}
        />
      </form>
    </details>
  );
}

export function ReconciliationScreen() {
  const now = useNow();
  const [params] = useSearchParams();
  const obligationId = params.get('obligation') ?? '';
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [currency, setCurrency] = useState('');
  const code = currency.trim().toUpperCase();
  const fromInstant = dateToInstant(from);
  const toInstant = dateToInstant(to, true);
  const valid =
    fromInstant !== null &&
    toInstant !== null &&
    fromInstant < toInstant &&
    /^[A-Z]{3}$/.test(code);
  const report = useApiQuery({
    path: '/finance/reconciliation-report',
    request: { query: { from: fromInstant ?? '', to: toInstant ?? '', currency: code } },
    enabled: valid,
  });
  return (
    <section aria-labelledby="reconciliation-title">
      <h2 id="reconciliation-title">Reconciliation</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <div className="rf-grid">
        <TextField label="From (UTC date)" type="date" value={from} onChange={setFrom} />
        <TextField label="To (UTC date, inclusive)" type="date" value={to} onChange={setTo} />
        <TextField
          label="Report currency"
          hint="Three letters; amounts in other currencies are reported separately."
          value={currency}
          onChange={setCurrency}
        />
      </div>
      {valid ? (
        <QueryBoundary
          query={report}
          label="the reconciliation report"
          isEmpty={reportIsEmpty}
          empty={{
            title: 'No movements',
            description:
              'The period has no orders, receipts, refunds, credits, settlements or cash in this currency.',
          }}
          unavailableOffline={['recording settlements', 'recording tenders']}
        >
          {(data) => <ReportView report={data} />}
        </QueryBoundary>
      ) : (
        <p>
          Enter a period whose last day is not before its first, and a currency, to see the report.
        </p>
      )}
      <RecordSettlement />
      <RecordTender obligationId={obligationId} />
      <StateView
        variant="pending-decision"
        subject={PENDING.accounting.subject}
        decisions={PENDING.accounting.ids}
        owner={PENDING.accounting.owner}
      />
      <p className="caption">
        Export batches to an accounting system are a conditional screen (SCR-S-57, in the Finance
        navigation), used only when the organization turns that capability on (DEC-016, DEC-081).
      </p>
    </section>
  );
}
