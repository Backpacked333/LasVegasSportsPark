/**
 * SCR-S-54 Session packages (Package G, conditional; SPK-COND-002, SPK-AT-020, ENR-11, §3.16
 * Session packages), in the Finance area with the Finance section navigation. Route:
 * `/finance/session-packages/*`.
 *
 * - Package offerings with their definitions as catalog exposes them (credits per purchase,
 *   eligible sessions, expiry: `none` only when the package chose it), read-only; the price only as
 *   the catalog states it.
 * - Session packages (`GET /v1/package-entitlements`, staff, facility-scoped, keyset pages with
 *   "Load more"), filtered by state, package offering and participant: whose it is (names only),
 *   credits left of the purchase, expiry in the offering's facility zone (SPK-SCHED-008), how it
 *   ended (exhausted, expired, revoked with its reason), and its redemption history.
 * - Reversal (`POST /v1/package-redemptions/{id}/reverse`, reason required, ungated): the credit is
 *   returned; a redemption already reversed answers REDEMPTION_ALREADY_REVERSED with "Reload".
 * - Redemption: book a covered session with one credit (`POST /v1/session-bookings` with
 *   `packageEntitlementId`, capability on); at most one of two concurrent redemptions of the last
 *   credit succeeds (SPK-AT-020) and the other is shown with its code.
 *
 * Behind `CapabilityGate` for `session_packages` (DEC-016, DEC-074) with `whenOff="notice"`:
 * packages stay listed and redemptions reversible while off; new redemptions are not offered.
 * Redemption and reversal terms stay pending POL-039 and POL-007.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Route, Routes } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { useApiQuery } from '../../../api/useApiQuery';
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { CommandSuccess } from '../../../ui/CommandFeedback';
import { Facts, SelectField, TextAreaField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { BookCoveredSession } from '../participation/BookCoveredSession';
import { CommandProblem } from '../participation/CommandProblem';
import { AppliesToView, DefinitionView } from '../participation/DefinitionView';
import { formatInstant, formatMoney, formatRange, plural } from '../participation/format';
import { personNameText, usePersonNames } from '../participation/names';
import '../participation/participation.css';
import {
  ACTIONS,
  NotAvailableToYou,
  useActionAllowed,
  useCapabilityOn,
} from '../participation/permission';
import { PersonPicker, type ChosenPerson } from '../participation/PersonPicker';
import {
  CREDIT_DISPOSITION,
  PACKAGE_STATUS,
  PACKAGE_STATUSES,
  type PackageEntitlement,
  type PackageStatus,
} from './labels';
import { SESSION_PACKAGES } from './meta';

type Redemption = PackageEntitlement['redemptions'][number];

const LIST_KEY = ['api', '/package-entitlements'] as const;

function PackageOfferings() {
  const { facilityId } = useApp();
  const pages = useApiPages({
    path: '/offerings',
    request: {
      query: { kind: 'package', view: 'staff', limit: 50, ...(facilityId ? { facilityId } : {}) },
    },
  });
  return (
    <section className="pg-panel" aria-labelledby="package-offerings-title">
      <h3 id="package-offerings-title">Package offerings</h3>
      <p className="caption">
        Read-only: credits, eligible sessions and expiry are set with the offering in Programs and
        camps (SCR-S-14).
      </p>
      <QueryBoundary
        query={pages}
        label="package offerings"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No package offerings',
          description: 'No session package is set up here yet.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Package offerings">
            {items.map((o) => (
              <li key={o.id}>
                <article className="row-text" aria-labelledby={`package-${o.id}`}>
                  <h4 id={`package-${o.id}`} className="row-title">
                    {o.name}
                  </h4>
                  <span>
                    <StatusBadge tone="neutral" label={o.publicationState} /> {o.facility.name}
                  </span>
                  <span>
                    Price:{' '}
                    {o.price
                      ? `${formatMoney(o.price.basePriceMinor, o.price.currency)} (as the catalog prices it)`
                      : 'Not priced'}
                  </span>
                  <DefinitionView definitionId={o.entitlementDefinitionId} />
                </article>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="package offerings" />
    </section>
  );
}

function SessionOfRedemption({ id, zone }: { id: string; zone: string | null }) {
  const booking = useApiQuery({
    path: '/session-bookings/{id}',
    request: { path: { id } },
    staleTime: 60_000,
  });
  if (booking.data) {
    const b = booking.data;
    return (
      <span>
        {formatRange(b.scheduledStart, b.scheduledEnd, zone)}, booking {b.status}
        {b.creditDisposition ? `; ${CREDIT_DISPOSITION[b.creditDisposition]}` : ''}
      </span>
    );
  }
  if (booking.error) return <span>Session booking not available ({booking.error.code})</span>;
  return <span>Loading the session…</span>;
}

function ReverseRedemption({
  redemption,
  entitlement,
  zone,
  onDone,
}: {
  redemption: Redemption;
  entitlement: PackageEntitlement;
  zone: string | null;
  onDone: (message: string) => void;
}) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reverse = useApiCommand('post', '/package-redemptions/{id}/reverse', {
    invalidate: [LIST_KEY],
  });
  const when = formatInstant(redemption.redeemedAt, zone);
  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={!online}
        aria-label={`Reverse the redemption of ${when}`}
        onClick={() => setOpen(true)}
      >
        Reverse…
      </Button>
    );
  }
  const send = () =>
    void reverse
      .submit({ path: { id: redemption.id }, body: { reason: reason.trim() } })
      .then((after) => {
        setOpen(false);
        onDone(`Credit returned: ${plural(after.remainingCredits, 'credit')} left`);
      })
      .catch(() => undefined);
  return (
    <form
      className="pg-form"
      noValidate
      aria-label={`Reverse the redemption of ${when}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required; the correction is audited.');
          return;
        }
        setReasonError(null);
        send();
      }}
    >
      <p>
        Reversing returns the credit to this package (
        {plural(entitlement.remainingCredits, 'credit')} left now). It is a correction and is
        audited.
      </p>
      <TextAreaField
        label="Reason for reversing"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
        maxLength={2000}
      />
      <div className="pg-actions">
        <Button type="submit" busy={reverse.isProcessing} disabled={!online}>
          Reverse the redemption
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandProblem
        error={reverse.error}
        onRetry={send}
        onReload={() => {
          reverse.reset();
          void queryClient.invalidateQueries({ queryKey: LIST_KEY });
        }}
      />
    </form>
  );
}

function Redemptions({
  entitlement,
  zone,
  canReverse,
  onDone,
}: {
  entitlement: PackageEntitlement;
  zone: string | null;
  canReverse: boolean;
  onDone: (message: string) => void;
}) {
  const reversed = new Set(
    entitlement.redemptions.filter((r) => r.kind === 'reversal').map((r) => r.reversesRedemptionId),
  );
  if (entitlement.redemptions.length === 0) return <p>No credit has been used.</p>;
  return (
    <ol className="pg-inline-list" aria-label="Redemptions">
      {entitlement.redemptions.map((r) => (
        <li key={r.id}>
          <span className="row-text">
            <span>
              <StatusBadge
                tone={r.kind === 'redeem' ? 'info' : 'neutral'}
                label={r.kind === 'redeem' ? 'redeemed' : 'reversal'}
              />{' '}
              {formatInstant(r.redeemedAt, zone)}
              {r.reason ? `: ${r.reason}` : ''}
            </span>
            <SessionOfRedemption id={r.sessionBookingId} zone={zone} />
            {r.kind === 'redeem' && reversed.has(r.id) ? (
              <span className="caption">Reversed; the credit was returned.</span>
            ) : null}
          </span>
          {r.kind === 'redeem' && !reversed.has(r.id) && canReverse ? (
            <ReverseRedemption
              redemption={r}
              entitlement={entitlement}
              zone={zone}
              onDone={onDone}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function EntitlementItem({
  entitlement,
  participant,
}: {
  entitlement: PackageEntitlement;
  participant: string;
}) {
  const queryClient = useQueryClient();
  const [showRedemptions, setShowRedemptions] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: entitlement.offeringId } },
    staleTime: 5 * 60_000,
  });
  const zone = offering.data?.facility.timezone ?? null;
  const facilityId = offering.data?.facilityId ?? null;
  const canReverse = useActionAllowed(ACTIONS.reverseRedemption, facilityId);
  const canBook = useActionAllowed(ACTIONS.bookSession, facilityId);
  const capabilityOn = useCapabilityOn('session_packages');
  const status = PACKAGE_STATUS[entitlement.status];
  const title = entitlement.offeringName ?? 'Session package';
  const redeemable =
    entitlement.status === 'active' && entitlement.remainingCredits > 0 && capabilityOn && canBook;
  return (
    <li>
      <article className="row-text" aria-labelledby={`entitlement-${entitlement.id}`}>
        <h4 id={`entitlement-${entitlement.id}`} className="row-title">
          {title}: {participant}
        </h4>
        <span className="pg-badges">
          <StatusBadge tone={status.tone} label={status.label} />
        </span>
        <CommandSuccess message={outcome} />
        <Facts
          label={`${title} for ${participant}`}
          items={[
            [
              'Credits',
              `${entitlement.remainingCredits} of ${entitlement.credits} left (${entitlement.redeemedCount} used)`,
            ],
            ['Eligible sessions', <AppliesToView key="applies" scope={entitlement.appliesTo} />],
            [
              'Expiry',
              entitlement.expiresAt
                ? formatInstant(entitlement.expiresAt, zone)
                : 'No expiry (the package chose none)',
            ],
            ['Issued', formatInstant(entitlement.issuedAt, zone)],
            ...(entitlement.expiredAt
              ? ([['Expired', formatInstant(entitlement.expiredAt, zone)]] as [string, string][])
              : []),
            ...(entitlement.revokedAt
              ? ([
                  [
                    'Revoked',
                    `${formatInstant(entitlement.revokedAt, zone)}${entitlement.revokedReason ? `: ${entitlement.revokedReason}` : ''}`,
                  ],
                ] as [string, string][])
              : []),
          ]}
        />
        <div className="pg-actions">
          <Button
            variant="secondary"
            aria-expanded={showRedemptions}
            onClick={() => setShowRedemptions((v) => !v)}
          >
            {showRedemptions ? 'Hide' : 'Show'} redemptions ({entitlement.redemptions.length})
          </Button>
        </div>
        {showRedemptions ? (
          <Redemptions
            entitlement={entitlement}
            zone={zone}
            canReverse={canReverse}
            onDone={setOutcome}
          />
        ) : null}
        {redeemable ? (
          <BookCoveredSession
            label="Book a session with a credit"
            appliesTo={entitlement.appliesTo}
            participantPersonId={entitlement.participantPersonId}
            basis={{ packageEntitlementId: entitlement.id }}
            onBooked={(b) => setOutcome(`Session booked (${b.status}); one credit used`)}
            onReload={() => void queryClient.invalidateQueries({ queryKey: LIST_KEY })}
          />
        ) : null}
      </article>
    </li>
  );
}

function Entitlements() {
  const { facilityId } = useApp();
  const [status, setStatus] = useState<PackageStatus | ''>('');
  const [offeringId, setOfferingId] = useState('');
  const [participant, setParticipant] = useState<ChosenPerson | null>(null);
  const allowed = useActionAllowed(ACTIONS.readPackage, facilityId);
  const offerings = useApiQuery({
    path: '/offerings',
    request: {
      query: { kind: 'package', view: 'staff', limit: 200, ...(facilityId ? { facilityId } : {}) },
    },
    enabled: allowed,
  });
  const pages = useApiPages({
    path: '/package-entitlements',
    enabled: allowed,
    request: {
      query: {
        limit: 50,
        ...(status ? { status } : {}),
        ...(offeringId ? { offeringId } : {}),
        ...(participant ? { participantPersonId: participant.id } : {}),
      },
    },
  });
  const names = usePersonNames((pages.data ?? []).map((e) => e.participantPersonId));
  if (!allowed) {
    return <NotAvailableToYou what="Reading session packages" action={ACTIONS.readPackage} />;
  }
  return (
    <section aria-labelledby="entitlements-title">
      <h3 id="entitlements-title">Session packages held</h3>
      <div className="pg-toolbar">
        <SelectField
          label="State"
          value={status}
          onChange={(v) => setStatus(v as PackageStatus | '')}
          placeholder="All states"
          options={PACKAGE_STATUSES.map((s) => ({ value: s, label: PACKAGE_STATUS[s].label }))}
        />
        <SelectField
          label="Package"
          value={offeringId}
          onChange={setOfferingId}
          placeholder="All packages"
          options={(offerings.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
        />
      </div>
      <PersonPicker label="Participant" value={participant} onChange={setParticipant} />
      <QueryBoundary
        query={pages}
        label="session packages"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No session packages',
          description:
            'No package matches these filters. A package is issued when its purchase is confirmed.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Session packages">
            {items.map((e) => (
              <EntitlementItem
                key={e.id}
                entitlement={e}
                participant={personNameText(names.get(e.participantPersonId), 'Participant')}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="session packages" />
    </section>
  );
}

function Overview() {
  const meta = SESSION_PACKAGES;
  return (
    <>
      {meta.pending ? (
        <StateView
          variant="pending-decision"
          subject={meta.pending.subject}
          decisions={[...meta.pending.decisions]}
        />
      ) : null}
      <Entitlements />
      <PackageOfferings />
    </>
  );
}

export function SessionPackagesScreen() {
  const meta = SESSION_PACKAGES;
  const headingId = `package-g-${meta.slug}`;
  return (
    <section aria-labelledby={headingId} data-testid={`package-g-${meta.slug}`}>
      <h2 id={headingId}>{meta.title}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <p className="caption">
        {meta.id}: {meta.purpose}
      </p>
      <CapabilityGate
        capability={meta.capability}
        subject={meta.title}
        whenOff="notice"
        stillAvailable="Packages already held stay listed and their redemptions can still be reversed. Using a credit for a new booking needs the switch on."
      >
        <Routes>
          <Route index element={<Overview />} />
          <Route
            path="*"
            element={<StateView variant="unavailable" title="Page not available" />}
          />
        </Routes>
      </CapabilityGate>
    </section>
  );
}
