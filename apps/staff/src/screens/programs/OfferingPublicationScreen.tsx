/**
 * SCR-S-15 Offering publication (SPK-CAT-004, SPK-PAY-002): validate the required configuration
 * and publish; open registration as its own action; pause registration while existing
 * participation is preserved; close and archive. Each command carries `expectedRevision` and an
 * idempotency key per intent (§4.9). Schedule publication is a distinct action in Schedule
 * (SCR-S-05), so the publication state and the registration state are shown apart from it.
 *
 * The configuration checklist only says what is set: the API validates again on publish and its
 * report (`VALIDATION_FAILED` with `details.problems`) is the authority. The commands offered per
 * state follow the OfferingPublicationMachine; the API answers INVALID_TRANSITION or ACCESS_DENIED
 * when a command is not allowed. Prices and taxes are pending DEC-007.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { useFacilities } from '../../features/registration-finance/facilities';
import { TextArea } from '../../features/registration-finance/fields';
import { formatInstant } from '../../features/registration-finance/format';
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

interface CheckItem {
  label: string;
  set: boolean;
  detail: string;
}

/** What is configured, for the reader; the API's publication report decides. */
export function configurationChecklist(
  offering: Offering,
  priceRules: readonly Schema<'PriceRule'>[] | undefined,
  now: Date,
): CheckItem[] {
  const staff = offering.staff;
  const current = (priceRules ?? []).some(
    (rule) => rule.effectiveTo === null || new Date(rule.effectiveTo) > now,
  );
  return [
    {
      label: 'Registration window',
      set: offering.registrationOpensAt !== null && offering.registrationClosesAt !== null,
      detail: 'Opening and closing times',
    },
    {
      label: 'Capacity units',
      set: (staff?.capacityUnits.length ?? 0) > 0,
      detail: 'At least one unit, with group size and staffing for camp groups',
    },
    {
      label: 'Eligibility policy',
      set: offering.eligibilityPolicyVersionId !== null,
      detail: 'An approved eligibility policy version',
    },
    {
      label: 'Participation entitlement',
      set: offering.entitlementDefinitionId !== null,
      detail: 'An active entitlement definition',
    },
    {
      label: 'Cancellation policy',
      set: offering.cancellationPolicyVersionId !== null,
      detail: 'An approved cancellation policy version',
    },
    {
      label: 'Required forms',
      set: true,
      detail: `${offering.requiredFormPolicyVersionIds.length} approved form version(s)`,
    },
    {
      label: 'Responsible manager',
      set: (staff?.responsibleManagerPersonId ?? null) !== null,
      detail: 'An active person',
    },
    {
      label: 'Price rule',
      set: priceRules === undefined ? false : current,
      detail:
        priceRules === undefined ? 'Price rules not available' : 'A current or future version',
    },
  ];
}

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

function Commands({ offering }: { offering: Offering }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<PublicationCommand | null>(null);
  const invalidate = [
    ['api', '/offerings/{id}'],
    ['api', '/programs/{id}/offerings'],
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
  const rules = useApiQuery({
    path: '/offerings/{id}/price-rules',
    request: { path: { id: offeringId } },
    enabled: offering.data?.staff !== undefined && offering.data?.staff !== null,
  });
  return (
    <section aria-labelledby="offering-title">
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
          const zone = timeZoneOf(data.facilityId);
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
              <section className="rf-panel" aria-labelledby="checklist-title">
                <h3 id="checklist-title">Required configuration</h3>
                <p className="caption">
                  What is set now. Publishing validates again on the server; its report is the
                  authority (for example an unapproved policy or an inactive manager).
                </p>
                <ul className="list" aria-label="Configuration checklist">
                  {configurationChecklist(data, rules.data, now).map((item) => (
                    <li key={item.label}>
                      <div className="row-text">
                        <span className="row-title">{item.label}</span>
                        <span className="caption">{item.detail}</span>
                      </div>
                      <StatusBadge
                        tone={item.set ? 'success' : 'warning'}
                        label={item.set ? 'Set' : 'Not set'}
                      />
                    </li>
                  ))}
                </ul>
                <StateView
                  variant="pending-decision"
                  subject="Operator approval of the prices, taxes and fees entered here"
                  decisions={PENDING.pricesAndTaxes.ids}
                  owner={PENDING.pricesAndTaxes.owner}
                />
              </section>
              <Commands offering={data} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
