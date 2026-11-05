import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CalendarFeed,
  type CalendarFeedCreated,
  type CreateCalendarFeedInput,
  type Principal,
  type RevokeCalendarFeedInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  API_PREFIX,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  type AuthorityLookupPort,
  type PersonDirectoryPort,
} from '../../identity';
import { renderIcs, type IcsEvent } from '../calendar/ics';
import { CommunicationsActions } from '../communications.actions';
import {
  CalendarFeedCreated as CalendarFeedCreatedEvent,
  CalendarFeedRevoked,
} from '../communications.events';
import { COMMUNICATIONS_POLICY, type CommunicationsPolicy } from '../communications.policy';
import {
  organizationOf,
  personOf,
  toCalendarFeed,
  uniqueStrings,
  type CalendarFeedRow,
} from '../communications.shared';
import { TEAM_MEMBERSHIP_PORT, type TeamMembershipPort } from '../ports';
import { CalendarEntriesService } from './calendar-entries.service';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Private calendar feeds (SPK-COMMS-008): a revocable authorization identified by a random token
 * whose hash alone is stored. Every fetch re-checks that the owner still holds `view` over each
 * person in scope (SPK-IAM-006: revocation affects private feed retrieval); a revoked or unknown
 * token is not found. Entries carry the scheduling event id as their stable UID.
 */
@Injectable()
export class CalendarFeedsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    @Inject(TEAM_MEMBERSHIP_PORT) private readonly teams: TeamMembershipPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly entries: CalendarEntriesService,
  ) {}

  async create(
    principal: Principal,
    input: CreateCalendarFeedInput,
    correlationId: string | null,
  ): Promise<CalendarFeedCreated> {
    const organizationId = organizationOf(principal);
    const ownerId = personOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorizeOwner(principal, organizationId, ownerId);
      const subjects = uniqueStrings(input.subjectPersonIds).filter((id) => id !== ownerId);
      for (const subject of subjects) {
        // Including someone else requires `view` over them; otherwise their existence stays hidden.
        await this.authorization.require(principal, CommunicationsActions.includeInCalendarFeed, {
          type: 'person',
          id: subject,
          organizationId,
          subjectPersonIds: [subject],
          protected: true,
        });
      }
      const token = randomBytes(32).toString('base64url');
      const id = newId();
      await trx
        .insertInto('calendar_feeds')
        .values({
          id,
          organization_id: organizationId,
          person_id: ownerId,
          label: input.label ?? null,
          token_hash: hashToken(token),
          scope: json({ subjectPersonIds: subjects }),
          created_by: json(snapshotActor(principal)),
          last_accessed_at: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageCalendarFeeds.id,
        targetType: 'calendar_feed',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { subjects: subjects.length }, // never the token
      });
      await this.outbox.enqueue(trx, CalendarFeedCreatedEvent, {
        organizationId,
        aggregateType: 'calendar_feed',
        aggregateId: id,
        payload: { feedId: id, personId: ownerId, subjectCount: subjects.length },
        correlationId,
      });
      const row = await this.loadOwned(trx, organizationId, ownerId, id);
      return {
        ...toCalendarFeed(row),
        token,
        path: `/${API_PREFIX}/calendar-feeds/${token}.ics`,
      };
    });
  }

  async listMine(principal: Principal): Promise<{ feeds: CalendarFeed[] }> {
    const organizationId = organizationOf(principal);
    const ownerId = personOf(principal);
    await this.authorizeOwner(principal, organizationId, ownerId);
    const rows = await this.uow
      .reader()
      .selectFrom('calendar_feeds')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', ownerId)
      .orderBy('created_at', 'desc')
      .execute();
    return { feeds: rows.map(toCalendarFeed) };
  }

  async revoke(
    principal: Principal,
    id: string,
    input: RevokeCalendarFeedInput,
    correlationId: string | null,
  ): Promise<CalendarFeed> {
    const organizationId = organizationOf(principal);
    const ownerId = personOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadOwned(trx, organizationId, ownerId, id, true);
      await this.authorizeOwner(principal, organizationId, ownerId);
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.revoked_at !== null)
        throw errors.invalidTransition('CalendarFeed', 'revoked', 'revoke');
      const now = this.clock.now();
      await trx
        .updateTable('calendar_feeds')
        .set({
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason ?? null,
          revision: row.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'communications.revoke_calendar_feed',
        targetType: 'calendar_feed',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, CalendarFeedRevoked, {
        organizationId,
        aggregateType: 'calendar_feed',
        aggregateId: id,
        payload: { feedId: id, personId: ownerId },
        correlationId,
      });
      return toCalendarFeed(await this.loadOwned(trx, organizationId, ownerId, id));
    });
  }

  /** Token-authorized fetch: unknown or revoked tokens are not found; scope is re-checked now. */
  async fetch(token: string): Promise<{ feedId: string; body: string }> {
    const row = await this.db
      .selectFrom('calendar_feeds')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row || row.revoked_at !== null) throw errors.protectedNotFound('calendar_feed');
    const organizationId = row.organization_id;
    const owner = await this.persons.findPerson(organizationId, row.person_id);
    if (!owner || owner.status !== 'active') throw errors.protectedNotFound('calendar_feed');
    const scope = toCalendarFeed(row).scope;
    const personIds = [row.person_id];
    for (const subject of scope.subjectPersonIds) {
      if (subject === row.person_id) continue;
      const allowed = await this.authority.hasPermission(
        organizationId,
        row.person_id,
        subject,
        'view',
      );
      if (allowed) personIds.push(subject);
    }
    const teamEntryIds: string[] = [];
    for (const personId of personIds) {
      teamEntryIds.push(...(await this.teams.teamEntriesOf(organizationId, personId)));
    }
    const now = this.clock.now();
    const entries = await this.entries.entriesFor(this.db, organizationId, {
      personIds,
      teamEntryIds: uniqueStrings(teamEntryIds),
      from: new Date(now.getTime() - this.policy.feedPastDays * DAY_MS),
      to: new Date(now.getTime() + this.policy.feedFutureDays * DAY_MS),
    });
    const events: IcsEvent[] = entries.map((entry) => {
      const resources = (entry.resources as Array<{ name?: unknown }>)
        .map((r) => (typeof r.name === 'string' ? r.name : null))
        .filter((n): n is string => n !== null);
      return {
        uid: entry.event_id,
        summary: entry.title,
        start: new Date(entry.scheduled_start),
        end: new Date(entry.scheduled_end),
        status: entry.status === 'canceled' ? 'CANCELLED' : 'CONFIRMED',
        sequence: entry.sequence,
        location: resources.length > 0 ? resources.join(', ') : null,
        description: `${entry.kind} (${entry.timezone})`,
        lastModified: new Date(entry.updated_at),
      };
    });
    const body = renderIcs({
      productId: this.policy.calendarProductId,
      name: row.label ?? 'Sportspark activities',
      now,
      events,
    });
    await this.uow.run(({ trx }) =>
      trx
        .updateTable('calendar_feeds')
        .set({ last_accessed_at: now, access_count: sql`access_count + 1` })
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .execute(),
    );
    return { feedId: row.id, body };
  }

  // -------------------------------------------------------------------------------------------
  private async authorizeOwner(
    principal: Principal,
    organizationId: string,
    ownerId: string,
  ): Promise<void> {
    await this.authorization.require(principal, CommunicationsActions.manageCalendarFeeds, {
      type: 'calendar_feed',
      organizationId,
      subjectPersonIds: [ownerId],
      protected: true,
    });
  }

  private async loadOwned(
    db: Db | Trx,
    organizationId: string,
    ownerId: string,
    id: string,
    forUpdate = false,
  ): Promise<CalendarFeedRow> {
    let q = db
      .selectFrom('calendar_feeds')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', ownerId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw errors.protectedNotFound('calendar_feed');
    return row;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
