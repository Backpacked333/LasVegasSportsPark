/**
 * Enrollment by age, required-form completion and waitlist counts of offerings (SCR-S-14
 * programs overview and readiness rail; SPK-REG-005, SPK-REG-008, SPK-CAT-001) from
 * `GET /v1/offering-enrollment-summaries` (counts only, at most 100 offerings a request). Ages are
 * whole years on each offering's eligibility reference date: the approved youth age bands are
 * pending DEC-003, so no band is invented here. A refusal leaves the summaries unknown, never zero.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDate } from '../../features/registration-finance/format';

export type EnrollmentSummary = Schema<'OfferingEnrollmentSummary'>;

const CHUNK = 100;

export function useEnrollmentSummaries(offeringIds: readonly string[]): {
  /** Null while loading or when the summaries are not available to the viewer. */
  byOffering: Map<string, EnrollmentSummary> | null;
  unavailable: boolean;
} {
  const first = offeringIds.slice(0, CHUNK);
  const second = offeringIds.slice(CHUNK, 2 * CHUNK);
  const a = useApiQuery({
    path: '/offering-enrollment-summaries',
    request: { query: { offeringIds: first.join(',') } },
    enabled: first.length > 0,
  });
  const b = useApiQuery({
    path: '/offering-enrollment-summaries',
    request: { query: { offeringIds: second.join(',') } },
    enabled: second.length > 0,
  });
  const aData = a.data;
  const bData = b.data;
  const byOffering = useMemo(() => {
    if (first.length > 0 && !aData) return null;
    if (second.length > 0 && !bData) return null;
    const map = new Map<string, EnrollmentSummary>();
    for (const item of [...(aData?.items ?? []), ...(bData?.items ?? [])]) {
      map.set(item.offeringId, item);
    }
    return map;
  }, [aData, bData, first.length, second.length]);
  return { byOffering, unavailable: a.error !== null || b.error !== null };
}

export interface SummaryTotals {
  confirmed: number;
  pending: number;
  waiting: number;
  offered: number;
  participants: number;
  participantsComplete: number;
  /** Participants whose offering requires at least one form. */
  formParticipants: number;
  ages: { ageYears: number | null; count: number }[];
}

/** Totals over the summaries of several offerings (one program). */
export function totalsOf(summaries: readonly EnrollmentSummary[]): SummaryTotals {
  const ages = new Map<number | null, number>();
  const totals: SummaryTotals = {
    confirmed: 0,
    pending: 0,
    waiting: 0,
    offered: 0,
    participants: 0,
    participantsComplete: 0,
    formParticipants: 0,
    ages: [],
  };
  for (const s of summaries) {
    totals.confirmed += s.enrolled.confirmed;
    totals.pending += s.enrolled.pending;
    totals.waiting += s.waitlist.waiting;
    totals.offered += s.waitlist.offered;
    totals.participants += s.forms.participantCount;
    if (s.forms.requiredFormCount > 0) {
      totals.formParticipants += s.forms.participantCount;
      totals.participantsComplete += s.forms.participantsComplete;
    }
    for (const g of s.byAge)
      ages.set(g.ageYears, (ages.get(g.ageYears) ?? 0) + g.confirmed + g.pending);
  }
  totals.ages = [...ages.entries()]
    .sort(([x], [y]) => (x === null ? 1 : y === null ? -1 : x - y))
    .map(([ageYears, count]) => ({ ageYears, count }));
  return totals;
}

export const ageLabel = (ageYears: number | null) =>
  ageYears === null ? 'Age not recorded' : `Age ${ageYears}`;

export function waitlistText(waiting: number, offered: number): string {
  if (waiting === 0 && offered === 0) return 'No waitlist';
  const parts = [`${waiting} waiting`];
  if (offered > 0) parts.push(`${offered} ${offered === 1 ? 'offer' : 'offers'} open`);
  return parts.join(' · ');
}

const SEGMENT_TONES = [
  'var(--pitch)',
  'var(--kind-program)',
  'var(--kind-rental)',
  'var(--kind-party)',
];

/**
 * One offering's enrolled participants split by age (confirmed and pending), as a stacked bar with
 * the counts written out beside it (SPK-UX-009: never colour alone).
 */
export function AgeSplit({ summary }: { summary: EnrollmentSummary }) {
  const groups = summary.byAge.map((g) => ({ ...g, count: g.confirmed + g.pending }));
  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total === 0) return <span className="caption">Nobody enrolled yet.</span>;
  const text = groups.map((g) => `${ageLabel(g.ageYears)}: ${g.count}`).join(', ');
  return (
    <div className="age-split">
      <span className="age-bar" aria-hidden="true">
        {groups.map((g, i) => (
          <span
            key={String(g.ageYears)}
            style={{
              width: `${(g.count / total) * 100}%`,
              background:
                g.ageYears === null ? 'var(--faint)' : SEGMENT_TONES[i % SEGMENT_TONES.length],
            }}
          />
        ))}
      </span>
      <span className="caption">
        {text} (ages on {formatDate(summary.referenceDate)})
      </span>
    </div>
  );
}
