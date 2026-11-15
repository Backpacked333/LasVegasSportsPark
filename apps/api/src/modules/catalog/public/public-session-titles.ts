import { PUBLIC_PUBLICATION_STATES } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';
import type { PublicEventRef, PublicEventTitle } from '../../scheduling';

/**
 * Titles catalog vouches for on the public schedule (SPK-SCHED-010, proposed amendment PA-06,
 * ADR-005): a session of an offering that is in the public catalog shows that offering's name.
 * The name is catalog content staff published for anyone to read (`GET /v1/offerings` without
 * sign-in lists it); the title stored on the schedule event is never used, because a person may
 * have typed a name into it. A session of an offering that is not public (a draft, an archived or
 * unlisted one) gets no title here, so the schedule shows its kind in words.
 */
export async function publicSessionTitles(
  db: Db | Trx,
  organizationId: string,
  events: readonly PublicEventRef[],
): Promise<Map<string, PublicEventTitle>> {
  const out = new Map<string, PublicEventTitle>();
  const eventIds = events.map((event) => event.eventId);
  if (eventIds.length === 0) return out;
  const rows = await db
    .selectFrom('offering_sessions')
    .innerJoin('offerings', (join) =>
      join
        .onRef('offerings.organization_id', '=', 'offering_sessions.organization_id')
        .onRef('offerings.id', '=', 'offering_sessions.offering_id'),
    )
    .select(['offering_sessions.scheduling_event_id as eventId', 'offerings.name as name'])
    .where('offering_sessions.organization_id', '=', organizationId)
    .where('offering_sessions.scheduling_event_id', 'in', eventIds)
    .where('offering_sessions.status', '<>', 'canceled')
    .where('offerings.publication_state', 'in', [...PUBLIC_PUBLICATION_STATES])
    .execute();
  for (const row of rows) {
    if (row.eventId) out.set(row.eventId, { title: row.name, score: null });
  }
  return out;
}
