/**
 * SCR-S-15 Offering publication (SPK-CAT-004, SPK-PAY-002): validate the required configuration
 * and publish; open registration as its own action; pause registration while existing
 * participation is preserved; close and archive. Each command carries `expectedRevision` and an
 * idempotency key per intent (§4.9). Schedule publication is a distinct action in Schedule
 * (SCR-S-05), so the publication state and the registration state are shown apart from it.
 *
 * The "Publication check" is the API's dry run (`GET /v1/offerings/{id}/publication-check`,
 * CAT-01): what publishing would report, without publishing or recording anything. It is re-read
 * after every command, and publishing validates again on the server (its VALIDATION_FAILED report
 * stays the authority). A `capability_disabled` problem (a conditional offering kind whose switch
 * is off, DEC-016) is shown as "turned off", not as missing configuration. The commands offered per
 * state follow the OfferingPublicationMachine; the API answers INVALID_TRANSITION or ACCESS_DENIED
 * when a command is not allowed. Prices and taxes are pending DEC-007.
 */
import {
  CAPABILITY_PRESENTATION,
  type ApiError,
  type CapabilityId,
  type Schema,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { useFacilities } from '../../features/registration-finance/facilities';
import { TextArea } from '../../features/registration-finance/fields';
import { formatInstant, humanize } from '../../features/registration-finance/format';
import {
  PUBLICATION_COMMANDS,
  PUBLICATION_STATE,
  type PublicationCommand,
} from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { OfferingHeader } from './OfferingSetupScreen';

type Offering = Schema<'Offering'>;

/** Registration as its own state, apart from publication (SPK-CAT-004). */
export function registrationState(offering: Offering, now: Date): string {
  switch (offering.publicationState) {
    case 'draft':
    case 'published': {
      return 'Registration not open';
    }
    case 'registration_paused':
      return 'Registration paused: existing participation is kept';
    case 'registration_open': {
      const opens = offering.registrationOpensAt ? new Date(offering.registrationOpensAt) : null;
      const closes = offering.registrationClosesAt ? new Date(offering.registrationClosesAt) : null;
      if (opens && now < opens) return 'Registration opened, window not started yet';
      if (closes && now >= closes) return 'Registration opened, window has ended';
      return 'Registration open';
    }
    case 'closed':
      return 'Registration closed';
    case 'archived':
      return 'Archived';
  }
}

/** The offering kinds a capability switch governs (CAT-02; catalog's OFFERING_KIND_CAPABILITY). */
const KIND_CAPABILITY: Partial<Record<Offering['kind'], CapabilityId>> = {
  membership: 'memberships',
  package: 'session_packages',
  rental: 'rentals',
  party: 'parties',
  pickup: 'pickup_sessions',
};

const CHECK_KEY = ['api', '/offerings/{id}/publication-check'] as const;

/**
 * SPK-CAT-004 dry run: the API's publication report for the offering as it is now. Nothing here
 * decides publishability; "Ready to publish" is shown only when the API says `publishable`.
 */
function PublicationCheckPanel({ offering }: { offering: Offering }) {
  const check = useApiQuery({
    path: '/offerings/{id}/publication-check',
    request: { path: { id: offering.id } },
  });
  return (
    <section className="rf-panel" aria-labelledby="checklist-title">
      <h3 id="checklist-title">Publication check</h3>
      <p className="caption">
        The server checks the offering as publishing would, without publishing or recording
        anything. Publishing checks again, and its report is the authority.
      </p>
      <QueryBoundary
        query={check}
        label="the publication check"
        empty={{ title: '', description: '' }}
      >
        {(data) => {
          const turnedOff = data.problems.filter((p) => p.code === 'capability_disabled');
          const missing = data.problems.filter((p) => p.code !== 'capability_disabled');
          const capability = KIND_CAPABILITY[offering.kind];
          const presentation = capability ? CAPABILITY_PRESENTATION[capability] : null;
          return (
            <>
              <p>
                <StatusBadge
                  tone={data.publishable ? 'success' : 'warning'}
                  label={data.publishable ? 'Ready to publish' : 'Not ready to publish'}
                />{' '}
                <span className="caption">
                  Checked against revision {data.revision} in state{' '}
                  {PUBLICATION_STATE[data.publicationState].label}.
                </span>
              </p>
              {turnedOff.length > 0 ? (
                <StateView
                  variant="turned-off"
                  subject={presentation?.label ?? 'This kind of offering'}
                  decisions={presentation?.decisions ?? ['DEC-016']}
                  owner={presentation?.owner}
                  stillAvailable={turnedOff.map((p) => p.message).join(' ')}
                />
              ) : null}
              {missing.length > 0 ? (
                <ul className="list" aria-label="Publication check problems">
                  {missing.map((problem, i) => (
                    <li key={`${problem.code}-${problem.field}-${i}`}>
                      <div className="row-text">
                        <span className="row-title">{problem.message}</span>
                        <span className="caption">
                          {humanize(problem.code)} · {humanize(problem.field)}
                        </span>
                      </div>
                      <StatusBadge tone="warning" label="Missing" />
                    </li>
                  ))}
                </ul>
              ) : null}
              {!data.publishable && data.problems.length === 0 ? (
                <p>
                  The configuration is complete, but an offering in state{' '}
                  {PUBLICATION_STATE[data.publicationState].label} cannot be published again.
                </p>
              ) : null}
              {data.publishable ? (
                <p>Nothing is missing: publishing would succeed if nothing changes first.</p>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
      <StateView
        variant="pending-decision"
        subject="Operator approval of the prices, taxes and fees entered here"
        decisions={PENDING.pricesAndTaxes.ids}
        owner={PENDING.pricesAndTaxes.owner}
      />
    </section>
  );
}

function Commands({ offering }: { offering: Offering }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<PublicationCommand | null>(null);
  const invalidate = [
    ['api', '/offerings/{id}'],
    ['api', '/programs/{id}/offerings'],
    CHECK_KEY,
  ] as const;
  const commands = {
    publish: useApiCommand('post', '/offerings/{id}/publish', { invalidate }),
    'registration/open': useApiCommand('post', '/offerings/{id}/registration/open', { invalidate }),
    'registration/pause': useApiCommand('post', '/offerings/{id}/registration/pause', {
      invalidate,
    }),
    'registration/resume': useApiCommand('post', '/offerings/{id}/registration/resume', {
      invalidate,
    }),
    close: useApiCommand('post', '/offerings/{id}/close', { invalidate }),
    archive: useApiCommand('post', '/offerings/{id}/archive', { invalidate }),
  } satisfies Record<PublicationCommand, unknown>;
  const revision = offering.staff?.revision ?? 1;
  const run = (name: PublicationCommand) => {
    setLast(name);
    for (const [key, command] of Object.entries(commands)) {
      if (key !== name && command.status !== 'idle') command.reset();
    }
    commands[name]
      .submit({
        path: { id: offering.id },
        body: { expectedRevision: revision, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      })
      .then(() => setReason(''))
      .catch(() => undefined);
  };
  const reload = () => {
    if (last) commands[last].reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/offerings/{id}'] });
    void queryClient.invalidateQueries({ queryKey: CHECK_KEY });
  };
  const available = PUBLICATION_COMMANDS[offering.publicationState];
  const active = last ? commands[last] : null;
  const error: ApiError | null = active?.error ?? null;
  return (
    <section className="rf-panel" aria-labelledby="publication-commands-title">
      <h3 id="publication-commands-title">Publication and registration commands</h3>
      {available.length === 0 ? (
        <p>An archived offering has no further publication commands.</p>
      ) : (
        <>
          <TextArea
            label="Reason or note (recorded with the change)"
            value={reason}
            onChange={setReason}
          />
          <div className="rf-actions">
            {available.map(({ command, label }) => (
              <Button
                key={command}
                variant={
                  command === 'publish' || command === 'registration/open' ? 'primary' : 'secondary'
                }
                busy={commands[command].isProcessing}
                disabled={!online}
                onClick={() => run(command)}
              >
                {label}
              </Button>
            ))}
          </div>
          {offering.publicationState === 'registration_open' ? (
            <p className="caption">
              Pausing stops new registrations only: existing participation is preserved.
            </p>
          ) : null}
        </>
      )}
      <OfflineCaption action="changing publication or registration" />
      {active?.status === 'success' && active.data ? (
        <p role="status">
          Done: the offering is now {PUBLICATION_STATE[active.data.publicationState].label}.
        </p>
      ) : null}
      {active?.isProcessing ? <p role="status">Validating and saving…</p> : null}
      <CommandError error={error} onReload={reload} />
    </section>
  );
}

export function OfferingPublicationScreen() {
  const { offeringId = '' } = useParams();
  const now = useNow();
  const { timeZoneOf } = useFacilities();
  const offering = useApiQuery({ path: '/offerings/{id}', request: { path: { id: offeringId } } });
  return (
    <section aria-labelledby="offering-title">
      {/* SPK-UX-009: the region keeps its name in every state. */}
      <h2 id="offering-title">Offering publication and registration</h2>
      <QueryBoundary
        query={offering}
        label="the offering"
        empty={{ title: '', description: '' }}
        unavailableOffline={['publishing', 'opening, pausing or closing registration']}
      >
        {(data) => {
          if (data.staff === null) {
            return (
              <StateView
                variant="unavailable"
                title="Publication not available"
                description="The staff details of this offering are not available to you."
              />
            );
          }
          // SPK-SCHED-008: the offering names its facility's zone; the directory is the fallback.
          const zone = data.facility?.timezone ?? timeZoneOf(data.facilityId);
          return (
            <>
              <OfferingHeader offering={data} />
              <p>
                <Link to={`/programs/offerings/${data.id}`}>Offering setup (SCR-S-14)</Link>
              </p>
              <section className="rf-panel" aria-labelledby="states-title">
                <h3 id="states-title">Current state</h3>
                <ul className="list" aria-label="Publication and registration state">
                  <li>
                    <span>Publication</span>
                    <StatusBadge {...PUBLICATION_STATE[data.publicationState]} />
                  </li>
                  <li>
                    <span>Registration</span>
                    <StatusBadge
                      tone={data.publicationState === 'registration_open' ? 'success' : 'neutral'}
                      label={registrationState(data, now)}
                    />
                  </li>
                  <li>
                    <span>Schedule</span>
                    <span>
                      Published separately in <Link to="/schedule">Schedule</Link> (SCR-S-05)
                    </span>
                  </li>
                </ul>
                <p className="caption">
                  Window: {formatInstant(data.registrationOpensAt, zone)} to{' '}
                  {formatInstant(data.registrationClosesAt, zone)}. Published{' '}
                  {formatInstant(data.staff.publishedAt, zone)}.
                </p>
              </section>
              <PublicationCheckPanel offering={data} />
              <Commands offering={data} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
