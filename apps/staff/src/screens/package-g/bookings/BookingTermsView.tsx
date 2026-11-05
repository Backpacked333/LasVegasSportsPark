/**
 * The approved booking terms of a rental or party offering (CAT-02 `booking_terms` content;
 * POL-040, POL-005), read-only on SCR-S-51 and SCR-S-52: confirmation mode, deposit, setup and
 * cleanup, access conditions and host responsibilities, exactly as the approved version states
 * them (`GET /v1/policy-versions/{id}`). Terms are drafted in the catalog and approved by the
 * finance operator; these screens never edit them and never fill in a missing value: an absent
 * setup or cleanup is the reserved resources' own buffer, as the API applies it.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../../api/useApiQuery';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { formatInstant } from '../participation/format';

type PolicyVersion = Schema<'PolicyVersion'>;

export interface BookingTermsContent {
  confirmationMode: 'instant' | 'request';
  installmentPolicyKey: string | null;
  setupMinutes: number | null;
  cleanupMinutes: number | null;
  accessConditions: string | null;
  hostResponsibilities: string | null;
}

/** The content of a `booking_terms` version, or null when it does not have that shape. */
export function bookingTermsContent(version: PolicyVersion): BookingTermsContent | null {
  if (version.kind !== 'booking_terms') return null;
  const c = version.content as Record<string, unknown>;
  const mode = c.confirmationMode;
  if (mode !== 'instant' && mode !== 'request') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  return {
    confirmationMode: mode,
    installmentPolicyKey: str(c.installmentPolicyKey),
    setupMinutes: int(c.setupMinutes),
    cleanupMinutes: int(c.cleanupMinutes),
    accessConditions: str(c.accessConditions),
    hostResponsibilities: str(c.hostResponsibilities),
  };
}

export const CONFIRMATION_WORDS: Record<'instant' | 'request', string> = {
  instant: 'Confirmed at once: the booking is reserved and held for payment.',
  request:
    'By request: nothing is reserved until staff approve; approval reserves the time and starts the hold.',
};

export function depositText(key: string | null): string {
  return key === null
    ? 'No deposit: charged in full at checkout.'
    : `Deposit: the first installment of the approved installment policy “${key}”.`;
}

export function TermsFacts({
  version,
  timeZone,
}: {
  version: PolicyVersion;
  timeZone: string | null;
}) {
  const content = bookingTermsContent(version);
  if (!content) {
    return (
      <p>
        <StatusBadge tone="warning" label="Terms not readable" /> This version is not booking terms
        the catalog accepts; nothing is assumed about it.
      </p>
    );
  }
  const buffer = (minutes: number | null) =>
    minutes === null ? "The reserved resources' own buffer" : `${minutes} minutes`;
  return (
    <Facts
      label={`Booking terms “${version.title}”`}
      items={[
        ['Confirmation', CONFIRMATION_WORDS[content.confirmationMode]],
        ['Deposit', depositText(content.installmentPolicyKey)],
        ['Setup before', buffer(content.setupMinutes)],
        ['Cleanup after', buffer(content.cleanupMinutes)],
        ['Access conditions', content.accessConditions ?? 'None stated'],
        ['Host responsibilities', content.hostResponsibilities ?? 'None stated'],
        [
          'Version',
          `${version.key} version ${version.version}, ${version.approvalStatus}, effective ${formatInstant(version.effectiveFrom, timeZone)}${version.effectiveTo ? ` to ${formatInstant(version.effectiveTo, timeZone)}` : ''}`,
        ],
      ]}
    />
  );
}

export function BookingTermsView({
  policyVersionId,
  timeZone,
}: {
  policyVersionId: string | null;
  timeZone: string | null;
}) {
  const version = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: policyVersionId ?? '' } },
    enabled: policyVersionId !== null,
    staleTime: 5 * 60_000,
  });
  if (policyVersionId === null) {
    return (
      <p>
        <StatusBadge tone="warning" label="No approved booking terms" /> Not bookable until the
        finance operator approves its booking terms (POL-040).
      </p>
    );
  }
  return (
    <QueryBoundary query={version} label="the booking terms" empty={{ title: '', description: '' }}>
      {(data) => <TermsFacts version={data} timeZone={timeZone} />}
    </QueryBoundary>
  );
}
