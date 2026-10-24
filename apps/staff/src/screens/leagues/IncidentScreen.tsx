/**
 * SCR-S-12 Disputes and discipline, part 3: one restricted incident (SPK-DISC-001, SPK-DISC-004
 * sensitive narratives restricted, SPK-DISC-005 operational facts, never diagnosis; SPK-UX-008).
 * The narrative is hidden until the viewer chooses to show it, with a warning that it must not be
 * copied into public results, team views or exports; it is never put in a URL or a log. Review
 * and closure follow IncidentMachine with `expectedRevision`. A viewer without discipline
 * authority gets "not available" (protected NOT_FOUND or ACCESS_DENIED).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { TextAreaField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import { INCIDENT_KIND, INCIDENT_STATUS, humanizeCode } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { PersonName } from '../../features/competition/names';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Incident = Schema<'Incident'>;

function RestrictedNarrative({ narrative }: { narrative: string | null }) {
  const [shown, setShown] = useState(false);
  if (!narrative) return <p className="caption">No narrative was recorded.</p>;
  return (
    <section className="restricted" aria-labelledby="narrative-title">
      <h3 id="narrative-title">
        <StatusBadge tone="warning" label="Restricted narrative" />
      </h3>
      <p className="caption">
        Operational facts only. Do not copy it into public results, team views, messages or exports.
      </p>
      <Button
        variant="secondary"
        aria-expanded={shown}
        aria-controls="incident-narrative"
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Hide the narrative' : 'Show the restricted narrative'}
      </Button>
      {shown ? (
        <p id="incident-narrative" data-testid="incident-narrative">
          {narrative}
        </p>
      ) : null}
    </section>
  );
}

function IncidentActions({ incident }: { incident: Incident }) {
  const update = useApiCommand('patch', '/incidents/{id}', {
    invalidate: keys('/incidents', '/incidents/{id}'),
  });
  const reload = useRefetch(['/incidents/{id}']);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [last, setLast] = useState<'review' | 'close'>('review');
  const send = (action: 'review' | 'close') => {
    setLast(action);
    void update
      .submit({
        path: { id: incident.id },
        body: {
          action,
          expectedRevision: incident.revision,
          ...(action === 'close' && note.trim() ? { closureNote: note.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };
  if (incident.status === 'closed') return null;
  return (
    <div className="form">
      <div className="actions">
        {incident.status === 'open' ? (
          <CommandButton
            variant="secondary"
            busy={update.isProcessing && last === 'review'}
            onClick={() => send('review')}
          >
            Start review
          </CommandButton>
        ) : null}
        <Button variant="secondary" onClick={() => setClosing((c) => !c)}>
          Close the incident
        </Button>
      </div>
      {closing ? (
        <form
          className="form"
          noValidate
          aria-label="Close the incident"
          onSubmit={(event) => {
            event.preventDefault();
            send('close');
          }}
        >
          <TextAreaField label="Closure note" value={note} onChange={setNote} />
          <CommandButton type="submit" busy={update.isProcessing && last === 'close'}>
            Close
          </CommandButton>
        </form>
      ) : null}
      {update.status === 'success' && update.data ? (
        <SuccessNote>{`Incident ${update.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={update.error}
        onRetry={() => send(last)}
        onReload={() => {
          update.reset();
          reload();
        }}
      />
    </div>
  );
}

export function IncidentScreen() {
  const { incidentId = '' } = useParams();
  const incident = useApiQuery({ path: '/incidents/{id}', request: { path: { id: incidentId } } });
  return (
    <section aria-labelledby="incident-title">
      <h2 id="incident-title">{incident.data ? INCIDENT_KIND[incident.data.kind] : 'Incident'}</h2>
      <LeaguesNav />
      <p>
        <Link to="/leagues/discipline">Back to discipline</Link>
      </p>
      <QueryBoundary
        query={incident}
        label="the incident"
        empty={{ title: '', description: '' }}
        unavailableOffline={['reviewing and closing incidents']}
      >
        {(data) => {
          const badge = INCIDENT_STATUS[data.status];
          return (
            <>
              <p>
                <StatusBadge tone={badge.tone} label={`Incident ${badge.label}`} />
              </p>
              <p>{data.summary}</p>
              <dl className="facets" aria-label="Incident facts">
                <div>
                  <dt>Severity</dt>
                  <dd>{humanizeCode(data.severity)}</dd>
                </div>
                <div>
                  <dt>Occurred</dt>
                  <dd>
                    {formatInstant(data.occurredAt)}
                    {data.minute !== null ? `, minute ${data.minute}` : ''}
                  </dd>
                </div>
                {data.cardKind ? (
                  <div>
                    <dt>Card</dt>
                    <dd>{humanizeCode(data.cardKind)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Subject</dt>
                  <dd>
                    {data.subjectPersonId ? (
                      <PersonName personId={data.subjectPersonId} />
                    ) : (
                      'None named'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Reported by</dt>
                  <dd>{data.reportedBy.actorLabel}</dd>
                </div>
                {data.fixtureId ? (
                  <div>
                    <dt>Fixture</dt>
                    <dd>
                      <Link to={`/leagues/fixtures/${data.fixtureId}`}>
                        Fixture {shortRef(data.fixtureId)}
                      </Link>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <RestrictedNarrative narrative={data.narrative} />
              {data.evidence.length > 0 ? (
                <ul aria-label="Evidence references">
                  {data.evidence.map((e, index) => (
                    <li key={index}>
                      {humanizeCode(e.kind)}: {e.reference}
                      {e.description ? ` (${e.description})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              {data.closureNote ? <p>Closure note: {data.closureNote}</p> : null}
              <IncidentActions incident={data} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
