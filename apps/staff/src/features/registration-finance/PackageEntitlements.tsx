/**
 * Session packages for staff (ENR-11, SPK-COND-002, SPK-AT-020; Package G capability
 * `session_packages`, DEC-016, DEC-074): the API's facility-scoped list
 * (`GET /v1/package-entitlements`, keyset pages with "Load more") with credits, redeemed and
 * remaining counts, expiry, status and the redemption history, and the staff correction "Reverse"
 * (`POST /v1/package-redemptions/{id}/reverse`, reason required, one idempotency key per intent)
 * that returns a redeemed credit. Used on SCR-S-27 (an enrollment and the enrollment lookup); the
 * SCR-S-54 screen may reuse it.
 *
 * Reads and reversals are never turned off by the API, so the list sits under `CapabilityNotice`:
 * it always renders, and with the switch off existing packages stay listed and a redemption can
 * still be reversed. Expiry and credit-return values are the package definition's
 * (POL-039); nothing is computed here. Only names and opaque references are shown (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { CapabilityNotice } from './CapabilityNotice';
import { CommandError } from './CommandError';
import { Facts, TextArea } from './fields';
import { formatInstant, shortRef } from './format';
import { PACKAGE_STATUS } from './labels';
import { PersonName } from './names';
import { OfflineCaption, useOnline } from './offline';

type Entitlement = Schema<'PackageEntitlement'>;
type Redemption = Entitlement['redemptions'][number];

export const PACKAGES_KEY = ['api', '/package-entitlements'] as const;

/** A redemption is reversible while no later reversal names it. */
export function reversedIds(entitlement: Entitlement): Set<string> {
  return new Set(
    entitlement.redemptions
      .filter((r) => r.kind === 'reversal' && r.reversesRedemptionId)
      .map((r) => r.reversesRedemptionId as string),
  );
}

function ReverseRedemption({
  redemption,
  label,
  onClose,
}: {
  redemption: Redemption;
  label: string;
  onClose: () => void;
}) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reverse = useApiCommand('post', '/package-redemptions/{id}/reverse', {
    invalidate: [PACKAGES_KEY],
  });
  const reload = () => {
    reverse.reset();
    void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
  };
  return (
    <form
      noValidate
      aria-label={`Reverse ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required and is audited.');
          return;
        }
        setReasonError(null);
        reverse
          .submit({ path: { id: redemption.id }, body: { reason: reason.trim() } })
          .catch(() => undefined);
      }}
    >
      <p className="caption">
        Reversing returns the credit to the package. The booking it paid for is not changed here.
      </p>
      <TextArea
        label="Reason for reversing"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
      />
      <div className="rf-actions">
        <Button
          type="submit"
          busy={reverse.isProcessing}
          disabled={!online || reverse.isProcessing}
        >
          Reverse the redemption
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Keep it
        </Button>
      </div>
      <OfflineCaption action="reversing a redemption" />
      {reverse.status === 'success' && reverse.data ? (
        <p role="status">
          Reversed: {reverse.data.remainingCredits} of {reverse.data.credits} credits remain.
        </p>
      ) : null}
      <CommandError error={reverse.error} onReload={reload} />
    </form>
  );
}

function RedemptionRow({
  redemption,
  reversed,
  zone,
}: {
  redemption: Redemption;
  reversed: boolean;
  zone: string;
}) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const label = `the redemption of ${formatInstant(redemption.redeemedAt, zone)}`;
  return (
    <li>
      <div className="row-text">
        <span>
          <StatusBadge
            tone={redemption.kind === 'reversal' ? 'info' : reversed ? 'neutral' : 'success'}
            label={
              redemption.kind === 'reversal'
                ? 'Reversal: credit returned'
                : reversed
                  ? 'Redeemed, later reversed'
                  : 'Redeemed'
            }
          />{' '}
          {formatInstant(redemption.redeemedAt, zone)}
        </span>
        <span className="caption">
          Session booking {shortRef(redemption.sessionBookingId)}
          {redemption.reason ? ` · ${redemption.reason}` : ''}
        </span>
      </div>
      {redemption.kind === 'redeem' && !reversed ? (
        open ? (
          <ReverseRedemption redemption={redemption} label={label} onClose={() => setOpen(false)} />
        ) : (
          <Button
            variant="secondary"
            disabled={!online}
            aria-label={`Reverse ${label}`}
            onClick={() => setOpen(true)}
          >
            Reverse…
          </Button>
        )
      ) : null}
    </li>
  );
}

/**
 * SPK-SCHED-008: package times in the facility's zone. A list for one enrollment is given its
 * offering's zone; otherwise each package reads its own offering (`GET /v1/offerings/{id}`, the
 * cache the offering name shares) and, until that answers or when it cannot, shows UTC, named.
 */
function usePackageZone(offeringId: string, given: string | null | undefined): string {
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: !given,
    staleTime: 5 * 60_000,
  });
  return given || offering.data?.facility?.timezone || 'UTC';
}

function EntitlementCard({
  entitlement,
  enrollmentId,
  zone: givenZone,
}: {
  entitlement: Entitlement;
  enrollmentId?: string;
  zone: string | null | undefined;
}) {
  const zone = usePackageZone(entitlement.offeringId, givenZone);
  const reversed = reversedIds(entitlement);
  return (
    <li aria-labelledby={`package-${entitlement.id}`}>
      <div className="row-text">
        <span className="row-title" id={`package-${entitlement.id}`}>
          <PersonName id={entitlement.participantPersonId} fallback="Participant" />:{' '}
          {entitlement.offeringName ?? `Offering ${shortRef(entitlement.offeringId)}`}
        </span>
        <span>
          <StatusBadge {...PACKAGE_STATUS[entitlement.status]} />
          {entitlement.enrollmentId === enrollmentId ? (
            <span className="caption"> · bought with this enrollment</span>
          ) : null}
        </span>
        <Facts
          label={`Package ${shortRef(entitlement.id)}`}
          items={[
            ['Credits', String(entitlement.credits)],
            ['Redeemed', String(entitlement.redeemedCount)],
            ['Remaining', String(entitlement.remainingCredits)],
            [
              'Expires',
              entitlement.expiresAt
                ? formatInstant(entitlement.expiresAt, zone)
                : 'No expiry in the package definition',
            ],
            ['Issued', formatInstant(entitlement.issuedAt, zone)],
            [
              'Purchase',
              <Link key="purchase" to={`/registrations/enrollments/${entitlement.enrollmentId}`}>
                Enrollment {shortRef(entitlement.enrollmentId)}
              </Link>,
            ],
          ]}
        />
        {entitlement.revokedAt ? (
          <span className="caption">
            Revoked {formatInstant(entitlement.revokedAt, zone)}
            {entitlement.revokedReason ? `: ${entitlement.revokedReason}` : ''}
          </span>
        ) : null}
        {entitlement.redemptions.length === 0 ? (
          <span className="caption">No redemptions yet.</span>
        ) : (
          <ul aria-label="Redemption history">
            {entitlement.redemptions.map((r) => (
              <RedemptionRow key={r.id} redemption={r} reversed={reversed.has(r.id)} zone={zone} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export interface PackageFilter {
  participantPersonId?: string;
  offeringId?: string;
  status?: Schema<'PackageEntitlementStatus'>;
}

/** The staff list for a participant or an offering, behind the `session_packages` notice. */
export function PackageEntitlementList({
  filter,
  enrollmentId,
  zone,
  title = 'Session packages',
}: {
  filter: PackageFilter;
  enrollmentId?: string;
  /** The facility zone of every package listed; leave out to resolve it per package. */
  zone?: string | null;
  title?: string;
}) {
  const packages = useApiPages({
    path: '/package-entitlements',
    request: { query: { limit: 50, ...filter } },
  });
  return (
    <section className="rf-panel" aria-labelledby="packages-title">
      <h3 id="packages-title">{title}</h3>
      <CapabilityNotice
        capability="session_packages"
        stillAvailable="Existing packages stay listed, and a redemption can still be reversed: reads and reversals are never turned off."
      >
        <QueryBoundary
          query={packages}
          label="session packages"
          isEmpty={(items) => items.length === 0}
          empty={{ title: 'No session packages', description: 'No package matches.' }}
          unavailableOffline={['reversing a redemption']}
        >
          {(items) => (
            <ul className="list" aria-label="Session packages">
              {items.map((e) => (
                <EntitlementCard
                  key={e.id}
                  entitlement={e}
                  enrollmentId={enrollmentId}
                  zone={zone}
                />
              ))}
            </ul>
          )}
        </QueryBoundary>
        <LoadMore pages={packages} label="session packages" />
      </CapabilityNotice>
    </section>
  );
}
