/**
 * SCR-S-55 one register session (§3.16 POS, POL-018): its opening float, expected cash (float plus
 * settled cash tenders minus cash returns, as the API computes it), starting a sale in it
 * (`POST /v1/pos-sales`, optionally naming the customer; a card tender needs one) and closing it
 * with the counted cash and the revision it was read at (`POST /v1/pos-register-sessions/{id}/close`,
 * never gated). A counted amount that differs from the expected one is recorded and raised for
 * finance (`finance.pos_register_variance`): no tolerance is approved (POL-018), so every
 * difference is reported, never absorbed. Times are in the facility's zone (SPK-SCHED-008).
 *
 * The API lists no sales of a session: a sale is reached from the page that started it or by its
 * reference, and closing answers SESSION_HAS_OPEN_SALES with how many are still open.
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import {
  PersonReferenceField,
  referenceError,
} from '../../../features/people/PersonReferenceField';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useFacilityDirectory } from '../../../features/pos-access-accounting/facilities';
import {
  LinkNotAvailable,
  MoneyField,
  ReferenceJump,
  useRecordParam,
} from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { POS_SESSION_STATUS } from '../../../features/pos-access-accounting/labels';
import { POS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import {
  formatInstant,
  formatMoney,
  parseMoneyInput,
  shortRef,
} from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { POS_PATHS } from './paths';

type Session = Schema<'PosRegisterSession'>;

export function SessionPage() {
  const sessionId = useRecordParam('sessionId');
  if (!sessionId) return <LinkNotAvailable />;
  return <SessionView sessionId={sessionId} />;
}

function SessionView({ sessionId }: { sessionId: string }) {
  const directory = useFacilityDirectory();
  const session = useApiQuery({
    path: '/pos-register-sessions/{id}',
    request: { path: { id: sessionId } },
  });
  return (
    <section aria-labelledby="pos-session-title">
      <h3 id="pos-session-title">Register session {shortRef(sessionId)}</h3>
      <QueryBoundary
        query={session}
        label="the register session"
        empty={{ title: '', description: '' }}
        unavailableOffline={['selling', 'closing the session']}
      >
        {(data) => {
          const zone = directory.timeZoneOf(data.facilityId);
          return (
            <>
              <StatusBadge {...POS_SESSION_STATUS[data.status]} />
              <Facts
                label="Register session"
                items={[
                  ['Facility', directory.nameOf(data.facilityId)],
                  ['Register', <code key="r">{shortRef(data.registerId)}</code>],
                  ['Business date', formatBusinessDate(data.businessDate)],
                  ['Currency', data.currency],
                  ['Opening float', formatMoney(data.openingFloatMinor, data.currency)],
                  ['Opened by', <PersonName key="o" id={data.openedByPersonId} fallback="Staff" />],
                  ['Opened at', formatInstant(data.openedAt, zone)],
                  ['Expected cash', formatMoney(data.expectedCashMinor, data.currency)],
                  ...(data.status === 'closed'
                    ? ([
                        ['Counted cash', formatMoney(data.countedCashMinor, data.currency)],
                        ['Difference', <Variance key="v" session={data} />],
                        [
                          'Closed by',
                          <PersonName key="c" id={data.closedByPersonId} fallback="Staff" />,
                        ],
                        ['Closed at', formatInstant(data.closedAt, zone)],
                      ] as [string, ReactNode][])
                    : []),
                ]}
              />
              {data.status === 'open' ? (
                <>
                  <StartSale session={data} />
                  <ReferenceJump
                    label="Sale reference"
                    buttonLabel="Open the sale"
                    to={(id) => POS_PATHS.sale(id)}
                  />
                  <CloseSession session={data} onReload={() => void session.refetch()} />
                </>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

/** "20261024" (the facility-local opening date the API records) as a calendar date. */
function formatBusinessDate(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return value;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function Variance({ session }: { session: Session }) {
  const variance = session.varianceMinor;
  if (variance === null) return <span>Not recorded</span>;
  if (variance === 0) return <StatusBadge tone="success" label="none: counted cash matches" />;
  return (
    <StatusBadge
      tone="warning"
      label={`${variance > 0 ? 'over' : 'short'} by ${formatMoney(Math.abs(variance), session.currency)}: raised for finance`}
    />
  );
}

function StartSale({ session }: { session: Session }) {
  const offer = useOffer();
  const online = useOnline();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-sales');
  const intent = useIntentForm(command);
  if (!offer.capabilityOn('point_of_sale')) return null;
  if (!offer.allowed(POS_ACTIONS.operateRegister, session.facilityId)) {
    return <p className="caption">Selling needs the permission {POS_ACTIONS.operateRegister}.</p>;
  }
  const customerError = referenceError(customer, false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (customerError) return;
    const sale = await intent.send({
      body: {
        registerSessionId: session.id,
        ...(customer.trim() ? { customerPersonId: customer.trim() } : {}),
      },
    });
    if (sale) navigate(POS_PATHS.sale(sale.id));
  };
  return (
    <form
      className="rf-panel"
      aria-label="Start a sale"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Start a sale</h4>
      <PersonReferenceField
        label="Customer reference"
        hint="Optional. A card tender needs the customer named (the payer of a card payment)."
        value={customer}
        onChange={setCustomer}
        error={touched ? customerError : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Start the sale
      </Button>
      <OfflineCaption action="selling" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}

function CloseSession({ session, onReload }: { session: Session; onReload: () => void }) {
  const offer = useOffer();
  const online = useOnline();
  const [counted, setCounted] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-register-sessions/{id}/close', {
    invalidate: [
      ['api', '/pos-register-sessions/{id}'],
      ['api', '/pos-registers'],
    ],
  });
  const intent = useIntentForm(command);
  if (!offer.allowed(POS_ACTIONS.operateRegister, session.facilityId)) return null;
  const countedMinor = parseMoneyInput(counted, session.currency, true);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (countedMinor === null) return;
    await intent.send({
      path: { id: session.id },
      body: { countedCashMinor: countedMinor, expectedRevision: session.revision },
    });
  };
  return (
    <form
      className="rf-panel"
      aria-label="Close the session"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Close the session</h4>
      <p>
        Count the drawer and enter what is there. Any difference from the expected cash is recorded
        and raised for finance; no tolerance is approved (POL-018).
      </p>
      <MoneyField
        label="Counted cash"
        currency={session.currency}
        required
        value={counted}
        onChange={setCounted}
        error={
          touched && countedMinor === null
            ? `Enter the counted amount in ${session.currency}.`
            : null
        }
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Close with this count
      </Button>
      {command.data ? (
        <p role="status">
          Session closed.{' '}
          {command.data.varianceMinor === 0
            ? 'The counted cash matches the expected cash.'
            : `A difference of ${formatMoney(Math.abs(command.data.varianceMinor ?? 0), command.data.currency)} (${(command.data.varianceMinor ?? 0) > 0 ? 'over' : 'short'}) was raised for finance to review.`}
        </p>
      ) : null}
      <OfflineCaption action="closing the session" />
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          onReload();
        }}
        currency={session.currency}
      />
    </form>
  );
}
