/**
 * SCR-S-48 Authority matrix (§5.6 "maintain an authority matrix for each record category and
 * scope"; §4.7 invariant 11; DEC-014; SPK-UX-008). Resolves the authoritative system (legacy or
 * Sportspark) for every §5.3 record category at a scope and instant (`GET /v1/authority-matrix`) and
 * lists the assignments behind it (`GET /v1/authority-assignments`). A category with two answers
 * at one scope is shown as a conflict, never resolved by the client. Assigning or transferring
 * authority is a migration-owner decision (DEC-014, DEC-068) and is not offered on this screen.
 */
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import { InsightQueryBoundary, PendingNote } from '../../features/insight-admin/feedback';
import { SelectField } from '../../features/insight-admin/fields';
import { formatInstant, shortId } from '../../features/insight-admin/format';
import {
  AUTHORITY_BASIS_BADGES,
  DECISIONS,
  ENTITY_TYPE_LABELS,
} from '../../features/insight-admin/labels';
import { MigrationNav } from '../../features/insight-admin/nav';
import { StatusBadge } from '../../ui/StatusBadge';

function scopeLabel(
  scope: { kind: string; facilityId?: string; programId?: string; competitionId?: string } | null,
  facilityName: (id: string) => string,
): string {
  if (!scope) return 'no assignment';
  switch (scope.kind) {
    case 'organization':
      return 'organization';
    case 'facility':
      return `facility ${facilityName(scope.facilityId ?? '')}`;
    case 'program':
      return `program ${shortId(scope.programId ?? '')}`;
    case 'competition':
      return `competition ${shortId(scope.competitionId ?? '')}`;
    default:
      return scope.kind;
  }
}

function Assignments({ facilityName }: { facilityName: (id: string) => string }) {
  const assignments = useApiQuery({
    path: '/authority-assignments',
    request: { query: { limit: 200 } },
  });
  return (
    <section className="ia-section" aria-labelledby="assignments-title">
      <h3 id="assignments-title">Assignments</h3>
      <InsightQueryBoundary
        query={assignments}
        label="authority assignments"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No authority assignments',
          description:
            'Without an assignment Sportspark is the authoritative system for every category.',
        }}
      >
        {(data) => (
          <ul className="list" aria-label="Authority assignments">
            {data.items.map((a) => (
              <li key={a.id}>
                <div className="row-text">
                  <span className="row-title">
                    {ENTITY_TYPE_LABELS[a.recordCategory]}: {a.authoritativeSystem}
                  </span>
                  <span className="caption">
                    Scope {scopeLabel(a.scope, facilityName)} · from{' '}
                    {formatInstant(a.effectiveFrom)}
                    {a.effectiveTo ? ` to ${formatInstant(a.effectiveTo)}` : ', open-ended'} ·
                    approved by {a.approvedBy.actorLabel}
                  </span>
                  <span className="caption">Reason: {a.reason}</span>
                  {a.endedAt ? (
                    <span className="caption">
                      Ended {formatInstant(a.endedAt)}
                      {a.endReason ? `: ${a.endReason}` : ''}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </InsightQueryBoundary>
    </section>
  );
}

export function AuthorityMatrixScreen() {
  const { choices } = useFacilityChoices();
  const [facilityId, setFacilityId] = useState('');
  const facilityName = (id: string) =>
    choices.find((c) => c.id === id)?.label ?? `Facility ${shortId(id)}`;
  const matrix = useApiQuery({
    path: '/authority-matrix',
    request: { query: facilityId ? { facilityId } : {} },
  });
  return (
    <section aria-labelledby="authority-title" className="ia-screen">
      <h2 id="authority-title">Authority matrix</h2>
      <MigrationNav />
      <PendingNote decisions={DECISIONS.migrationScope.ids} owner={DECISIONS.migrationScope.owner}>
        Which system writes each record category during transition.
      </PendingNote>
      <SelectField
        label="Scope"
        value={facilityId}
        onChange={setFacilityId}
        placeholder="Organization"
        options={choices.map((c) => ({ value: c.id, label: c.label }))}
        hint="The most specific assignment in effect wins; a synchronized copy never becomes a second writer."
      />
      <InsightQueryBoundary
        query={matrix}
        label="the authority matrix"
        isEmpty={(data) => data.entries.length === 0}
        empty={{ title: 'No categories', description: 'The API returned no record categories.' }}
      >
        {(data) => (
          <div
            className="ia-table-wrap"
            role="region"
            aria-label="Authority matrix table"
            tabIndex={0}
          >
            <table className="ia-table">
              <caption>
                Authoritative system per record category as of {formatInstant(data.at)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Records</th>
                  <th scope="col">Authoritative system</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Effective</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => {
                  const basis = AUTHORITY_BASIS_BADGES[entry.basis];
                  return (
                    <tr key={entry.recordCategory}>
                      <th scope="row">{ENTITY_TYPE_LABELS[entry.recordCategory]}</th>
                      <td>
                        {entry.basis === 'conflict'
                          ? 'two answers: writes refused'
                          : entry.authoritativeSystem}
                      </td>
                      <td>
                        <StatusBadge tone={basis.tone} label={basis.label} />
                      </td>
                      <td>{scopeLabel(entry.scope, facilityName)}</td>
                      <td>
                        {entry.effectiveFrom
                          ? `${formatInstant(entry.effectiveFrom)}${entry.effectiveTo ? ` to ${formatInstant(entry.effectiveTo)}` : ''}`
                          : 'none'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </InsightQueryBoundary>
      <Assignments facilityName={facilityName} />
    </section>
  );
}
