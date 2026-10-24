/**
 * SCR-S-14 one program: its definition (edited with `expectedRevision`, §4.9), its dated
 * offerings in every publication state (`GET /v1/programs/{id}/offerings`), and "new draft
 * offering" with every SPK-CAT-001 field (SPK-CAT-002 kinds). Program status moves follow the
 * ProgramMachine (draft to active or archived, active to archived); the API refuses others.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { useFacilities } from '../../features/registration-finance/facilities';
import { SelectField } from '../../features/registration-finance/fields';
import { formatDate } from '../../features/registration-finance/format';
import {
  OFFERING_KIND,
  PROGRAM_STATUS,
  PUBLICATION_STATE,
} from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { OfferingForm } from './OfferingForm';
import { ProgramForm, ageBandText } from './ProgramsScreen';

type ProgramStatus = Schema<'ProgramStatus'>;
type PublicationState = Schema<'PublicationState'>;

/** ProgramMachine: the statuses a program may move to from its current one (or stay in). */
const PROGRAM_NEXT: Record<ProgramStatus, readonly ProgramStatus[]> = {
  draft: ['draft', 'active', 'archived'],
  active: ['active', 'archived'],
  archived: ['archived'],
};

function EditProgram({ program }: { program: Schema<'Program'> }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  // Both the list and the detail (key ['api', '/programs/{id}', ...]) are refetched, so the next
  // save carries the new revision.
  const update = useApiCommand('patch', '/programs/{id}', {
    invalidate: [
      ['api', '/programs'],
      ['api', '/programs/{id}'],
    ],
  });
  const reload = () => {
    update.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/programs/{id}'] });
  };
  return (
    <details className="rf-panel">
      <summary>Edit program definition</summary>
      <ProgramForm
        initial={program}
        submitLabel="Save program"
        busy={update.isProcessing}
        disabled={!online || program.status === 'archived'}
        serverErrors={fieldErrorsOf(update.error)}
        statusOptions={PROGRAM_NEXT[program.status]}
        onSubmit={(input) => {
          update
            .submit({
              path: { id: program.id },
              body: {
                expectedRevision: program.revision,
                name: input.name.trim(),
                activityType: input.activityType.trim(),
                description: input.description.trim() || null,
                format: input.format.trim() || null,
                ageBand: input.ageBand,
                ...(input.status !== program.status ? { status: input.status } : {}),
              },
            })
            .catch(() => undefined);
        }}
      />
      <OfflineCaption action="saving the program" />
      {update.status === 'success' ? (
        <p role="status">Program saved (revision {update.data?.revision}).</p>
      ) : null}
      <CommandError error={update.error} onReload={reload} />
    </details>
  );
}

function NewOffering({ programId }: { programId: string }) {
  const navigate = useNavigate();
  const online = useOnline();
  const create = useApiCommand('post', '/offerings', {
    invalidate: [['api', '/programs/{id}/offerings']],
  });
  return (
    <section className="rf-panel" aria-labelledby="new-offering-title">
      <h3 id="new-offering-title">New draft offering</h3>
      <p className="caption">
        A new offering is a draft: nothing is visible to customers until it is published and
        registration is opened (SPK-CAT-004).
      </p>
      <OfferingForm
        mode="create"
        programId={programId}
        initial={null}
        busy={create.isProcessing}
        disabled={!online}
        serverErrors={fieldErrorsOf(create.error)}
        onCreate={(body) => {
          create
            .submit({ body })
            .then((offering) => navigate(`/programs/offerings/${offering.id}`))
            .catch(() => undefined);
        }}
      />
      <OfflineCaption action="creating an offering" />
      <CommandError error={create.error} />
    </section>
  );
}

export function ProgramScreen() {
  const { programId = '' } = useParams();
  const { nameOf } = useFacilities();
  const [state, setState] = useState<'' | PublicationState>('');
  const program = useApiQuery({ path: '/programs/{id}', request: { path: { id: programId } } });
  const offerings = useApiQuery({
    path: '/programs/{id}/offerings',
    request: {
      path: { id: programId },
      query: { limit: 200, ...(state ? { publicationState: state } : {}) },
    },
    enabled: program.data !== undefined,
  });
  return (
    <section aria-labelledby="program-title">
      <p>
        <Link to="/programs">All programs</Link>
      </p>
      <QueryBoundary
        query={program}
        label="the program"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the program', 'creating offerings']}
      >
        {(data) => (
          <>
            <h2 id="program-title">{data.name}</h2>
            <p>
              <StatusBadge {...PROGRAM_STATUS[data.status]} />{' '}
              <span className="caption">
                {data.activityType}
                {data.format ? ` · ${data.format}` : ''} · {ageBandText(data.ageBand)} · revision{' '}
                {data.revision}
              </span>
            </p>
            {data.description ? <p>{data.description}</p> : null}
            <EditProgram program={data} />
            <section className="rf-panel" aria-labelledby="offerings-title">
              <h3 id="offerings-title">Offerings</h3>
              <SelectField
                label="Publication state"
                value={state}
                placeholder="All states"
                onChange={(v) => setState(v as '' | PublicationState)}
                options={Object.entries(PUBLICATION_STATE).map(([value, badge]) => ({
                  value,
                  label: badge.label,
                }))}
              />
              <QueryBoundary
                query={offerings}
                label="offerings"
                isEmpty={(page) => page.items.length === 0}
                empty={{
                  title: 'No offerings',
                  description:
                    'This program has no dated offerings in this state. Create a draft offering below.',
                }}
              >
                {(page) => (
                  <ul className="list" aria-label="Offerings">
                    {page.items.map((offering) => (
                      <li key={offering.id}>
                        <div className="row-text">
                          <Link className="row-title" to={`/programs/offerings/${offering.id}`}>
                            {offering.name}
                          </Link>
                          <span className="caption">
                            {OFFERING_KIND[offering.kind]} · {nameOf(offering.facilityId)} ·{' '}
                            {formatDate(offering.startsOn)} to {formatDate(offering.endsOn)}
                          </span>
                        </div>
                        <StatusBadge {...PUBLICATION_STATE[offering.publicationState]} />
                      </li>
                    ))}
                  </ul>
                )}
              </QueryBoundary>
            </section>
            {data.status !== 'archived' ? <NewOffering programId={data.id} /> : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
