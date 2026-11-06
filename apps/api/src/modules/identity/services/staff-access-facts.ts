import type { StaffAccessReviewSummary } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';

export interface StaffAccessFacts {
  lastSeenAt: string | null;
  lastAccessReview: StaffAccessReviewSummary | null;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/**
 * Migration 0181 (§2.1, §4.14): for each staff person, when their active login account last
 * authenticated (accounts.last_login_at, touched by the principal resolver at most hourly) and
 * their latest staff access review. One read each for the whole page.
 */
export async function staffAccessFactsOf(
  db: Db | Trx,
  organizationId: string,
  personIds: readonly string[],
): Promise<Map<string, StaffAccessFacts>> {
  const out = new Map<string, StaffAccessFacts>();
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return out;
  const seen = await db
    .selectFrom('accounts')
    .select(['person_id', 'last_login_at'])
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'active')
    .where('person_id', 'in', ids)
    .execute();
  const reviews = await db
    .selectFrom('staff_access_reviews')
    .select([
      'id',
      'person_id',
      'outcome',
      'reviewed_at',
      'reviewed_by_person_id',
      'next_review_due_at',
    ])
    .distinctOn('person_id')
    .where('organization_id', '=', organizationId)
    .where('person_id', 'in', ids)
    .orderBy('person_id')
    .orderBy('reviewed_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  for (const id of ids) {
    const account = seen.find((s) => s.person_id === id);
    const review = reviews.find((r) => r.person_id === id);
    out.set(id, {
      lastSeenAt: iso(account?.last_login_at ?? null),
      lastAccessReview: review
        ? {
            reviewId: review.id,
            outcome: review.outcome,
            reviewedAt: iso(review.reviewed_at)!,
            reviewedByPersonId: review.reviewed_by_person_id,
            nextReviewDueAt: iso(review.next_review_due_at)!,
          }
        : null,
    });
  }
  return out;
}
