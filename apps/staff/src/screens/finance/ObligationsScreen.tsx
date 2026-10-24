/**
 * SCR-S-35 Obligations and orders, list (SPK-PAY-004, SPK-PAY-006, SPK-REG-003): obligations per
 * customer or per team (`GET /v1/obligations` with `debtorPersonId` or `teamEntryId`, or every
 * obligation for staff), each with its billing model and the four figures shown consistently.
 * Read-only: nothing here changes money. Team liability models and balance consequences are
 * pending DEC-008/DEC-073; the figures shown are the API's.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { SelectField, TextField } from '../../features/registration-finance/fields';
import { formatInstant } from '../../features/registration-finance/format';
import { OBLIGATION_MODE, OBLIGATION_STATUS } from '../../features/registration-finance/labels';
import { PersonName, TeamEntryName } from '../../features/registration-finance/names';
import { ObligationFigures } from '../../features/registration-finance/ObligationFigures';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type ObligationStatus = Schema<'ObligationStatus'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Debtor({ obligation }: { obligation: Schema<'Obligation'> }) {
  return obligation.debtor.kind === 'person' ? (
    <PersonName id={obligation.debtor.personId} fallback="Customer" />
  ) : (
    <TeamEntryName id={obligation.debtor.teamEntryId} />
  );
}

export function ObligationsScreen() {
  const [status, setStatus] = useState<ObligationStatus | ''>('open');
  const [debtor, setDebtor] = useState('');
  const [team, setTeam] = useState('');
  const debtorId = UUID.test(debtor.trim()) ? debtor.trim() : '';
  const teamId = UUID.test(team.trim()) ? team.trim() : '';
  const obligations = useApiQuery({
    path: '/obligations',
    request: {
      query: {
        limit: 200,
        ...(status ? { status } : {}),
        ...(debtorId ? { debtorPersonId: debtorId } : teamId ? { teamEntryId: teamId } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="obligations-title">
      <h2 id="obligations-title">Obligations and orders</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <div className="rf-grid">
        <SelectField
          label="Obligation status"
          value={status}
          placeholder="All statuses"
          onChange={(v) => setStatus(v as ObligationStatus | '')}
          options={Object.entries(OBLIGATION_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <TextField
          label="Customer reference"
          value={debtor}
          onChange={setDebtor}
          hint="A person reference narrows to one customer."
        />
        <TextField
          label="Team entry reference"
          value={team}
          onChange={setTeam}
          hint="A team entry reference narrows to one team."
        />
      </div>
      <p className="caption">
        Team liability and balance consequences are pending {PENDING.teamLiability.ids.join(', ')}{' '}
        (owner: {PENDING.teamLiability.owner}).
      </p>
      <QueryBoundary
        query={obligations}
        label="obligations"
        isEmpty={(page) => page.items.length === 0}
        empty={{ title: 'No obligations', description: 'No obligation matches these filters.' }}
      >
        {(page) => (
          <>
            <ul className="list" aria-label="Obligations">
              {page.items.map((obligation) => (
                <li key={obligation.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/finance/obligations/${obligation.id}`}>
                      {obligation.description}
                    </Link>
                    <span className="caption">
                      <Debtor obligation={obligation} /> · {OBLIGATION_MODE[obligation.mode]} · due{' '}
                      {formatInstant(obligation.dueAt)}
                    </span>
                    <ObligationFigures
                      totals={obligation.totals}
                      label={`Figures: ${obligation.description}`}
                    />
                  </div>
                  <StatusBadge {...OBLIGATION_STATUS[obligation.status]} />
                </li>
              ))}
            </ul>
            {page.items.length >= 200 ? (
              <StateView
                variant="empty"
                title="More obligations may exist"
                description="Only the first 200 are shown: narrow by status, customer or team."
              />
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
