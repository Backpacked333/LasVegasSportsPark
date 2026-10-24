/**
 * SCR-S-49 Support cases, the queue (SPK-SUPPORT-001, SPK-SUPPORT-002, SPK-SUPPORT-003). Lists
 * `GET /v1/cases` for the selected facility, filtered by status, category and "assigned to me",
 * page by page. Each case shows owner, category, priority, status (machine names, never colour
 * alone), due time and overdue. Cases outside the viewer's scope are never listed by the API;
 * ACCESS_DENIED is shown as not available.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CheckboxGroup, SelectField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { useFacilityDirectory } from '../today/useFacilityDirectory';
import {
  CASE_CATEGORIES,
  CASE_PRIORITY_TONE,
  CASE_STATUSES,
  CASE_STATUS_TONE,
  type CaseCategory,
  type CaseStatus,
} from './support';

export const CASES_PAGE_SIZE = 25;

interface Filters {
  status: string;
  category: string;
  mine: boolean;
}

function CasesPage({
  filters,
  cursor,
  isLast,
  onMore,
}: {
  filters: Filters;
  cursor: string | undefined;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const { facilityId } = useApp();
  const facilities = useFacilityDirectory();
  const me = useApiQuery({ path: '/me' });
  const myPersonId = me.data?.principal.personId ?? null;
  const cases = useApiQuery({
    path: '/cases',
    request: {
      query: {
        limit: CASES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(filters.status ? { status: filters.status as CaseStatus } : {}),
        ...(filters.category ? { category: filters.category as CaseCategory } : {}),
        ...(facilityId ? { facilityId } : {}),
        ...(filters.mine && myPersonId ? { ownerPersonId: myPersonId } : {}),
      },
    },
    enabled: !filters.mine || myPersonId !== null,
  });
  return (
    <QueryBoundary
      query={cases}
      label="support cases"
      empty={{ title: '', description: '' }}
      unavailableOffline={['opening and changing cases']}
    >
      {(page) => (
        <>
          {page.items.length === 0 && cursor === undefined ? (
            <p>No cases match. Open cases in your scope appear here.</p>
          ) : (
            <ul className="list" aria-label={cursor ? 'More support cases' : 'Support cases'}>
              {page.items.map((c) => (
                <li key={c.id}>
                  <div className="row-text">
                    <Link to={`/admin/cases/${c.id}`} className="row-title">
                      {c.title}
                    </Link>
                    <span className="caption">
                      {c.category} · owner {c.owner.queue ?? 'no queue'}
                      {c.owner.personId ? ' (assigned)' : ' (unassigned)'}
                      {c.facilityId ? ` · ${facilities.name(c.facilityId)}` : ''}
                      {c.dueAt
                        ? ` · due ${formatDateTime(c.dueAt, facilities.timezone(c.facilityId))}`
                        : ''}
                    </span>
                  </div>
                  <span className="actions-row">
                    <StatusBadge tone={CASE_STATUS_TONE[c.status]} label={`Status: ${c.status}`} />
                    <StatusBadge
                      tone={CASE_PRIORITY_TONE[c.priority]}
                      label={`Priority: ${c.priority}`}
                    />
                    {c.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {isLast && page.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(page.nextCursor as string)}>
              Show more cases
            </Button>
          ) : null}
        </>
      )}
    </QueryBoundary>
  );
}

export function SupportCasesScreen() {
  const [filters, setFilters] = useState<Filters>({ status: '', category: '', mine: false });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setCursors([undefined]);
  };
  return (
    <section aria-labelledby="cases-title">
      <h2 id="cases-title">Support cases</h2>
      <p>
        <Link to="/admin">Administration</Link> · <Link to="/admin/cases/new">Open a case</Link>
      </p>
      <p className="caption">
        Staff help customers with their own permissions, never with customer credentials. A note is
        history only: refunds, permission changes and transfers are their own commands.
      </p>
      <div className="actions-row" role="group" aria-label="Filter cases">
        <SelectField
          label="Status"
          placeholder="Any status"
          options={CASE_STATUSES.map((s) => ({ value: s, label: s }))}
          value={filters.status}
          onChange={(status) => update({ status })}
        />
        <SelectField
          label="Category"
          placeholder="Any category"
          options={CASE_CATEGORIES.map((c) => ({ value: c, label: c }))}
          value={filters.category}
          onChange={(category) => update({ category })}
        />
        <CheckboxGroup
          legend="Owner"
          options={[{ value: 'mine', label: 'Assigned to me' }]}
          value={filters.mine ? ['mine'] : []}
          onChange={(v) => update({ mine: v.includes('mine') })}
        />
      </div>
      {cursors.map((cursor, i) => (
        <CasesPage
          key={`${cursor ?? 'first'}-${filters.status}-${filters.category}-${filters.mine}`}
          filters={filters}
          cursor={cursor}
          isLast={i === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
        />
      ))}
    </section>
  );
}
