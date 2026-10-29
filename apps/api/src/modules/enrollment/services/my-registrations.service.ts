import { Inject, Injectable } from '@nestjs/common';
import type {
  Application,
  Basket,
  ListMyApplicationsQuery,
  ListMyBasketsQuery,
  ListMyTrialParticipationsQuery,
  ListMyWaitlistEntriesQuery,
  MyWaitlistEntry,
  Page,
  Principal,
  TrialParticipation,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { CLOCK, DATABASE, type Clock } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import {
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  keysetPage,
  organizationOf,
  redactApplication,
  redactWaitlistEntry,
  toApplication,
  toTrialParticipation,
} from '../enrollment.shared';
import { BasketsService } from './baskets.service';
import { CustomerScope } from './customer-scope';
import { WaitlistService } from './waitlist.service';

/**
 * A person's own registration lists (ENR-01; SPK-REG-001, SPK-REG-004, SPK-REG-008, SPK-YOUTH-003,
 * SPK-UX-001): an interrupted registration is found again from the server, never from ids kept on
 * the device. Each list is a keyset page, newest first (created_at desc, id desc), over the people
 * the caller may read (CustomerScope), with the same payer redaction as the single reads
 * (SPK-AT-004). Baskets are the caller's own household baskets.
 */
@Injectable()
export class MyRegistrationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly scope: CustomerScope,
    private readonly baskets: BasketsService,
    private readonly waitlist: WaitlistService,
  ) {}

  async listBaskets(principal: Principal, query: ListMyBasketsQuery): Promise<Page<Basket>> {
    const organizationId = organizationOf(principal);
    const owners = await this.scope.selfIds(principal);
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('baskets')
      .selectAll()
      .select(cursorAt('baskets').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('owner_person_id', 'in', owners)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('baskets', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Basket[] = [];
    for (const row of page.rows) items.push(await this.baskets.view(this.db, organizationId, row));
    return { items, nextCursor: page.nextCursor };
  }

  async listWaitlistEntries(
    principal: Principal,
    query: ListMyWaitlistEntriesQuery,
  ): Promise<Page<MyWaitlistEntry>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.scope.subjectIds(principal, EnrollmentActions.readWaitlist);
    if (subjects.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('waitlist_entries')
      .selectAll()
      .select(cursorAt('waitlist_entries').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', subjects)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('waitlist_entries', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const names = new Map<string, string | null>();
    const items: MyWaitlistEntry[] = [];
    for (const row of page.rows) {
      if (!names.has(row.offering_id)) {
        const snapshot = await this.offerings.getOffering(
          organizationId,
          row.offering_id,
          this.clock.now(),
        );
        names.set(row.offering_id, snapshot?.offering.name ?? null);
      }
      const entry = redactWaitlistEntry(
        principal,
        await this.waitlist.view(this.db, organizationId, row),
        row.requested_by_person_id,
      );
      const open = entry.offers.find((o) => o.status === 'offered');
      items.push({
        ...entry,
        offeringName: names.get(row.offering_id) ?? null,
        openOffer: open ? { id: open.id, status: open.status, expiresAt: open.expiresAt } : null,
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  async listApplications(
    principal: Principal,
    query: ListMyApplicationsQuery,
  ): Promise<Page<Application>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.scope.subjectIds(principal, EnrollmentActions.readApplication);
    if (subjects.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('applications')
      .selectAll()
      .select(cursorAt('applications').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', subjects)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('applications', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return {
      items: page.rows.map((row) => redactApplication(principal, toApplication(row))),
      nextCursor: page.nextCursor,
    };
  }

  async listTrialParticipations(
    principal: Principal,
    query: ListMyTrialParticipationsQuery,
  ): Promise<Page<TrialParticipation>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.scope.subjectIds(principal, EnrollmentActions.readTrial);
    if (subjects.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('trial_participations')
      .selectAll()
      .select(cursorAt('trial_participations').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', subjects)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('trial_participations', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map(toTrialParticipation), nextCursor: page.nextCursor };
  }
}
