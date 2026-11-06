/**
 * Organization default currency (SPK-PAY-001; core setting, migration 0018). Read from
 * `GET /v1/organization`; a system administrator sets it with
 * `POST /v1/admin/settings/default-currency` (expected revision and a reason, §4.9). It starts
 * empty: no currency is assumed until an administrator records one.
 */
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { TextField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

export const SET_CURRENCY_ACTION = 'core.set_default_currency';
const ORGANIZATION_KEY = ['api', '/organization'] as const;

export function DefaultCurrencyCard() {
  const organization = useApiQuery({ path: '/organization' });
  const permissions = usePermissions();
  const canSet = permissions.isPermitted(SET_CURRENCY_ACTION) === true;
  return (
    <section className="card card-flush adm-card" aria-labelledby="adm-currency-title">
      <div className="card-head">
        <h3 id="adm-currency-title">Default currency</h3>
      </div>
      <div className="adm-body">
        <QueryBoundary
          query={organization}
          label="organization settings"
          empty={{ title: '', description: '' }}
          unavailableOffline={['setting the default currency']}
        >
          {(org) => (
            <>
              <p className="actions-row">
                {org.defaultCurrency ? (
                  <StatusBadge tone="success" label={`Default currency: ${org.defaultCurrency}`} />
                ) : (
                  <StatusBadge tone="pending" label="No default currency set" />
                )}
              </p>
              <p className="caption">
                Used where a screen has no money records to take a currency from. Prices and
                payments always keep their own currency.
              </p>
              {canSet ? (
                <CurrencyForm current={org.defaultCurrency} revision={org.revision} />
              ) : null}
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

function CurrencyForm({ current, revision }: { current: string | null; revision: number }) {
  const { online } = useApp();
  const [currency, setCurrency] = useState(current ?? '');
  const [reason, setReason] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const set = useApiCommand('post', '/admin/settings/default-currency', {
    invalidate: [ORGANIZATION_KEY],
  });
  const code = currency.trim().toUpperCase();
  const codeError =
    code !== '' && !/^[A-Z]{3}$/.test(code)
      ? 'Use a three-letter code, for example USD.'
      : undefined;
  const valid = /^[A-Z]{3}$/.test(code) && reason.trim() !== '' && code !== current;
  const submit = () => {
    setSuccess(null);
    void set
      .submit({ body: { currency: code, expectedRevision: revision, reason: reason.trim() } })
      .then(() => {
        setSuccess(`Default currency set to ${code}.`);
        setReason('');
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="form"
      aria-label="Set the default currency"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) submit();
      }}
    >
      <TextField
        label="Currency code"
        required
        value={currency}
        onChange={setCurrency}
        error={codeError}
        hint="ISO 4217 code, three capital letters."
      />
      <TextField label="Reason" required value={reason} onChange={setReason} />
      <div className="actions-row">
        <Button type="submit" disabled={!valid || !online} busy={set.isProcessing}>
          Save default currency
        </Button>
      </div>
      <CommandSuccess message={success} />
      <CommandError error={set.error} onRetry={submit} onReload={() => set.reset()} />
    </form>
  );
}
