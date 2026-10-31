import { Injectable } from '@nestjs/common';
import { newId, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { json, type CalendarEntriesTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../../kernel';
import type { EventChanged } from '../../scheduling';

export type CalendarEntryRow = Selectable<CalendarEntriesTable>;
type EventChangedPayload = EventPayload<typeof EventChanged>;

/**
 * This module's own projection of scheduled events (SPK-COMMS-008 stable identities). It is built
 * only from `scheduling.event_changed`: the scheduling module remains the sole writer of its tables
 * (§4.2) and this read model is what private calendar feeds serve. `sequence` increases on every
 * change so subscribed calendars update or remove the right entry; replays are idempotent because
 * the last source event id is recorded, and reordering is tolerated: each change carries the full
 * snapshot and the event's revision, so a change older than the one last applied (a late retry,
 * another worker's order) is ignored instead of rolling the entry back with a higher SEQUENCE
 * (§4.11, §4.12, §4.6, SPK-COMMS-008). The revision is exact; ordering by outbox event id (UUID v7,
 * creation time) remains only for changes without a revision and for equal revisions.
 */
@Injectable()
export class CalendarEntriesService {
  async upsertFromEventChange(trx: Trx, event: DomainEvent<EventChangedPayload>): Promise<void> {
    await this.applyEventChange(trx, event);
  }

  /**
   * Applies one `scheduling.event_changed` to the projection: `applied`, `replayed` (this very event
   * was the last one applied) or `stale` (a newer change of the event was already applied).
   */
  async applyEventChange(
    trx: Trx,
    event: DomainEvent<EventChangedPayload>,
  ): Promise<'applied' | 'replayed' | 'stale'> {
    const payload = event.payload;
    const details = payload.after ?? payload.before;
    if (!details) return 'applied';
    const status = payload.after ? payload.after.status : 'canceled';
    const existing = await trx
      .selectFrom('calendar_entries')
      .select(['id', 'last_source_event_id', 'sequence', 'source_revision'])
      .where('organization_id', '=', event.organizationId)
      .where('event_id', '=', payload.eventId)
      .forUpdate()
      .executeTakeFirst();
    const values = {
      facility_id: details.facilityId,
      title: details.title,
      kind: details.kind,
      scheduled_start: new Date(details.scheduledStart),
      scheduled_end: new Date(details.scheduledEnd),
      timezone: details.timezone,
      resources: json(details.resources),
      status,
      last_change: payload.change,
      last_source_event_id: event.id,
    };
    const incoming = payload.revision ?? null;
    let entryId: string;
    if (existing) {
      if (existing.last_source_event_id === event.id) return 'replayed'; // already applied
      const held = existing.source_revision;
      if (incoming !== null && held !== null && incoming !== held) {
        // the event's revision orders its changes exactly, whatever the instance clocks
        if (incoming < held) return 'stale';
      } else if (existing.last_source_event_id > event.id) {
        // Outbox event ids are UUID v7, ordered by creation time: an id lower than the one last
        // applied is an older change delivered late; the entry already holds a newer snapshot.
        return 'stale';
      }
      entryId = existing.id;
      await trx
        .updateTable('calendar_entries')
        .set({ ...values, source_revision: incoming ?? held, sequence: existing.sequence + 1 })
        .where('id', '=', entryId)
        .execute();
    } else {
      entryId = newId();
      await trx
        .insertInto('calendar_entries')
        .values({
          id: entryId,
          organization_id: event.organizationId,
          event_id: payload.eventId,
          ...values,
          source_revision: incoming,
        })
        .execute();
    }
    await trx
      .deleteFrom('calendar_entry_parties')
      .where('organization_id', '=', event.organizationId)
      .where('entry_id', '=', entryId)
      .execute();
    const seen = new Set<string>();
    const parties = payload.commitments
      .filter((c) => c.partyType === 'team' || c.partyType === 'person')
      .filter((c) => {
        const key = `${c.partyType}:${c.partyId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (parties.length > 0) {
      await trx
        .insertInto('calendar_entry_parties')
        .values(
          parties.map((c) => ({
            organization_id: event.organizationId,
            entry_id: entryId,
            party_type: c.partyType as 'team' | 'person',
            party_id: c.partyId,
            role: 'participant',
          })),
        )
        .execute();
    }
    return 'applied';
  }

  /** Published and canceled entries any of the people or teams is committed to, within the window. */
  async entriesFor(
    db: Db | Trx,
    organizationId: string,
    query: { personIds: string[]; teamEntryIds: string[]; from: Date; to: Date },
  ): Promise<CalendarEntryRow[]> {
    if (query.personIds.length === 0 && query.teamEntryIds.length === 0) return [];
    return db
      .selectFrom('calendar_entries as e')
      .selectAll('e')
      .where('e.organization_id', '=', organizationId)
      .where('e.status', 'in', ['published', 'canceled'])
      .where('e.scheduled_end', '>=', query.from)
      .where('e.scheduled_start', '<=', query.to)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('calendar_entry_parties as p')
            .select('p.entry_id')
            .whereRef('p.organization_id', '=', 'e.organization_id')
            .whereRef('p.entry_id', '=', 'e.id')
            .where((inner) =>
              inner.or([
                ...(query.personIds.length > 0
                  ? [
                      inner.and([
                        inner('p.party_type', '=', 'person'),
                        inner('p.party_id', 'in', query.personIds),
                      ]),
                    ]
                  : []),
                ...(query.teamEntryIds.length > 0
                  ? [
                      inner.and([
                        inner('p.party_type', '=', 'team'),
                        inner('p.party_id', 'in', query.teamEntryIds),
                      ]),
                    ]
                  : []),
              ]),
            ),
        ),
      )
      .orderBy('e.scheduled_start')
      .orderBy('e.id')
      .execute();
  }
}
