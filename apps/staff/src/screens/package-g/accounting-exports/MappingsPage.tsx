/**
 * SCR-S-57 account mappings (§3.16 Accounting "approved mappings"; SPK-PAY-011, DEC-022): each
 * ledger account the API exports needs an external account approved by someone other than the
 * person who proposed it (four eyes). Mappings by status and account
 * (`GET /v1/accounting-mappings`, paged); proposing one (`POST /v1/accounting-mappings`,
 * finance.manage_accounting_mappings); approving another person's proposal with the revision it
 * was read at (`POST .../approve`, finance.approve_accounting_mapping; the proposer is not offered
 * it and the API refuses it, FOUR_EYES_REQUIRED); withdrawing a proposal or retiring an approved
 * mapping (`POST .../retire`, never gated).
 *
 * No mapping is assumed: the page lists the ledger accounts that have no approved mapping (once
 * every approved mapping is loaded), and a refused preparation links here with the account to
 * propose (`?propose=<ledger account>`, an account code, never personal data).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import {
  LEDGER_ACCOUNTS,
  MAPPING_STATUS,
  ledgerAccountLabel,
} from '../../../features/pos-access-accounting/labels';
import { useMyPersonId } from '../../../features/pos-access-accounting/me';
import { ACCOUNTING_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import { formatInstant } from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { MAPPINGS_PREFIX } from './paths';

type Mapping = Schema<'AccountingMapping'>;
type LedgerAccount = Schema<'LedgerAccount'>;

const STATUS_FILTERS = (Object.keys(MAPPING_STATUS) as Schema<'AccountingMappingStatus'>[]).map(
  (s) => ({ value: s, label: MAPPING_STATUS[s].label }),
);
const MAPPING_COMMAND = { invalidate: [MAPPINGS_PREFIX] } as const;

function isLedgerAccount(value: string | null): value is LedgerAccount {
  return LEDGER_ACCOUNTS.some((a) => a.value === value);
}

export function MappingsPage() {
  const [params] = useSearchParams();
  const requested = params.get('propose');
  const [status, setStatus] = useState('');
  const [account, setAccount] = useState('');
  const mappings = useApiPages({
    path: '/accounting-mappings',
    request: {
      query: {
        ...(status ? { status: status as Schema<'AccountingMappingStatus'> } : {}),
        ...(account ? { ledgerAccount: account as LedgerAccount } : {}),
        limit: 50,
      },
    },
  });
  return (
    <section aria-labelledby="accounting-mappings-title">
      <h3 id="accounting-mappings-title">Account mappings</h3>
      <Coverage />
      <div className="rf-grid">
        <SelectField
          label="Show mappings"
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          placeholder="Every mapping"
        />
        <SelectField
          label="Ledger account"
          value={account}
          onChange={setAccount}
          options={LEDGER_ACCOUNTS}
          placeholder="Every account"
        />
      </div>
      <QueryBoundary
        query={mappings}
        label="account mappings"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No mappings',
          description: 'No mapping matches. Nothing is exported without an approved mapping.',
        }}
        unavailableOffline={['proposing and approving mappings']}
      >
        {(items) => (
          <ul className="list" aria-label="Account mappings">
            {items.map((m) => (
              <MappingRow key={m.id} mapping={m} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={mappings} label="mappings" />
      <ProposeMapping initialAccount={isLedgerAccount(requested) ? requested : ''} />
    </section>
  );
}

/** Accounts without an approved mapping, once every approved mapping is loaded (no guess). */
function Coverage() {
  const approved = useApiPages({
    path: '/accounting-mappings',
    request: { query: { status: 'approved', limit: 100 } },
  });
  if (approved.data === undefined || approved.hasNextPage) return null;
  const mapped = new Set(approved.data.map((m) => m.ledgerAccount));
  const missing = LEDGER_ACCOUNTS.filter((a) => !mapped.has(a.value));
  return missing.length === 0 ? (
    <p role="status">
      <StatusBadge tone="success" label="Every ledger account has an approved mapping" />
    </p>
  ) : (
    <section className="rf-panel" aria-labelledby="accounting-unmapped-title">
      <h4 id="accounting-unmapped-title">Ledger accounts without an approved mapping</h4>
      <p className="caption">
        A batch with entries on these accounts is not prepared until each has an approved mapping.
      </p>
      <ul aria-label="Unmapped ledger accounts">
        {missing.map((a) => (
          <li key={a.value}>{ledgerAccountLabel(a.value)}</li>
        ))}
      </ul>
    </section>
  );
}

function MappingRow({ mapping }: { mapping: Mapping }) {
  const offer = useOffer();
  const online = useOnline();
  const me = useMyPersonId();
  const queryClient = useQueryClient();
  const approve = useApiCommand('post', '/accounting-mappings/{id}/approve', MAPPING_COMMAND);
  const retire = useApiCommand('post', '/accounting-mappings/{id}/retire', MAPPING_COMMAND);
  const approveIntent = useIntentForm(approve);
  const proposedByMe = me !== null && mapping.proposedByPersonId === me;
  const canApprove =
    mapping.status === 'proposed' &&
    offer.capabilityOn('accounting') &&
    offer.allowed(ACCOUNTING_ACTIONS.approveMapping);
  const canRetire =
    mapping.status !== 'retired' && offer.allowed(ACCOUNTING_ACTIONS.manageMappings);
  return (
    <li>
      <div className="row-text">
        <span className="row-title">
          {ledgerAccountLabel(mapping.ledgerAccount)} to {mapping.externalAccountRef}
        </span>
        <StatusBadge {...MAPPING_STATUS[mapping.status]} />
        <span className="caption">
          Proposed by <PersonName id={mapping.proposedByPersonId} fallback="Staff" />
          {mapping.approvedByPersonId ? (
            <>
              {' '}
              · approved by <PersonName id={mapping.approvedByPersonId} fallback="Staff" /> on{' '}
              {formatInstant(mapping.approvedAt, 'UTC')}
            </>
          ) : null}
          {mapping.retireReason ? ` · retired: ${mapping.retireReason}` : ''}
        </span>
      </div>
      {canApprove ? (
        proposedByMe ? (
          <p className="caption">
            You proposed this mapping: another person approves it (four eyes).
          </p>
        ) : (
          <div>
            <Button
              busy={approve.isProcessing}
              disabled={!online || approveIntent.locked}
              onClick={() =>
                void approveIntent.send({
                  path: { id: mapping.id },
                  body: { expectedRevision: mapping.revision },
                })
              }
            >
              Approve the mapping of {mapping.ledgerAccount}
            </Button>
            <CommandError
              error={approve.error}
              onRetry={approveIntent.retry}
              onReload={() => {
                approveIntent.restart();
                void queryClient.invalidateQueries({ queryKey: MAPPINGS_PREFIX });
              }}
            />
          </div>
        )
      ) : null}
      {canRetire ? (
        <div>
          <ReasonAction
            label={
              mapping.status === 'proposed'
                ? `Withdraw the proposal for ${mapping.ledgerAccount}`
                : `Retire the mapping of ${mapping.ledgerAccount}`
            }
            confirmLabel={mapping.status === 'proposed' ? 'Withdraw the proposal' : 'Retire it'}
            reasonLabel="Reason"
            explanation={
              mapping.status === 'approved'
                ? 'Without an approved mapping, entries on this account are not exported.'
                : undefined
            }
            busy={retire.isProcessing}
            disabled={!online}
            onConfirm={async (reason) => {
              try {
                await retire.submit({
                  path: { id: mapping.id },
                  body: { reason, expectedRevision: mapping.revision },
                });
                return true;
              } catch {
                return false;
              }
            }}
          />
          <CommandError
            error={retire.error}
            onReload={() => void queryClient.invalidateQueries({ queryKey: MAPPINGS_PREFIX })}
          />
        </div>
      ) : null}
    </li>
  );
}

function ProposeMapping({ initialAccount }: { initialAccount: LedgerAccount | '' }) {
  const offer = useOffer();
  const online = useOnline();
  const [account, setAccount] = useState<string>(initialAccount);
  const [ref, setRef] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/accounting-mappings', MAPPING_COMMAND);
  const intent = useIntentForm(command);
  if (!offer.capabilityOn('accounting')) return null;
  if (!offer.allowed(ACCOUNTING_ACTIONS.manageMappings)) {
    return (
      <p className="caption">
        Proposing mappings needs the permission {ACCOUNTING_ACTIONS.manageMappings}.
      </p>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!isLedgerAccount(account) || !ref.trim()) return;
    const created = await intent.send({
      body: { ledgerAccount: account, externalAccountRef: ref.trim() },
    });
    if (created) {
      setRef('');
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Propose a mapping"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Propose a mapping</h4>
      <p>Another person approves it before any entry on the account is exported (four eyes).</p>
      <SelectField
        label="Ledger account"
        required
        value={account}
        onChange={setAccount}
        options={LEDGER_ACCOUNTS}
        placeholder="Choose a ledger account"
        error={touched && !isLedgerAccount(account) ? 'Choose a ledger account.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="External account"
        required
        hint="The account in the accounting system, as its owner names it."
        value={ref}
        onChange={setRef}
        error={touched && !ref.trim() ? 'Enter the external account.' : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Propose the mapping
      </Button>
      {command.data && !command.error ? (
        <p role="status">
          Mapping of {command.data.ledgerAccount} proposed. Another person approves it.
        </p>
      ) : null}
      <OfflineCaption action="proposing a mapping" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}
