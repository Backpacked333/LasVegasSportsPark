import { Injectable } from '@nestjs/common';
import type { ClosureImpact, PartyCommitment } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';

/** An event a closure affects, as a contributor sees it. */
export interface ImpactedEventRef {
  eventId: string;
  kind: string;
  scheduledStart: string;
  sourceType: string | null;
  sourceId: string | null;
  commitments: PartyCommitment[];
}

/** What one module adds to a closure preview from its own records. */
export interface ClosureImpactContribution {
  customers?: ClosureImpact['customers'];
  obligations?: ClosureImpact['obligations'];
  messages?: ClosureImpact['messages'];
  /**
   * SPK-SCHED-009 staff (R3-TRACE-A-06): the live assignments on the given events, from the
   * module that owns staff assignments (workforce: assignments whose `scheduling_event_id` is one
   * of the events, status proposed, offered or accepted). Ids, kind, role and status only. The
   * owner always returns it, `[]` when no live assignment is on the events: returning it is what
   * marks staff as identified. A contributor that does not own staff assignments leaves it out,
   * and while no contributor returns it the impact reports staff as not identified (`null`).
   */
  staff?: StaffAssignment[];
}

/** One live staff assignment on an affected event (`ClosureImpact.staff`). */
export type StaffAssignment = NonNullable<ClosureImpact['staff']>[number];

/** What `collect` returns: every section definite, except staff, which may be not identified. */
export interface CollectedImpact {
  customers: ClosureImpact['customers'];
  obligations: ClosureImpact['obligations'];
  messages: ClosureImpact['messages'];
  /** `null` = no contributor identified staff for these events (never read as "no staff"). */
  staff: StaffAssignment[] | null;
}

/** Reads through `db`, the preview's own executor (inside the closure transaction when applied). */
export type ClosureImpactContributor = (
  db: Db | Trx,
  organizationId: string,
  events: readonly ImpactedEventRef[],
) => Promise<ClosureImpactContribution>;

/**
 * Closure impact contributors (SPK-SCHED-009: a closure identifies affected games, programs,
 * rentals, staff, customers, financial obligations and messages; SPK-AT-009 "complete impact
 * preview"). Scheduling knows the events and their committed parties; the modules that own the
 * participation (enrollment, competition rosters), the staff assignments (workforce), the money
 * and the messages register a contributor in `onModuleInit` and answer from their own tables
 * (§4.2). The preview stays staff-only (`scheduling.manage_closures`) and carries ids and counts,
 * never names.
 */
@Injectable()
export class ClosureImpactContributors {
  private readonly contributors = new Map<string, ClosureImpactContributor>();

  register(name: string, contributor: ClosureImpactContributor): void {
    if (this.contributors.has(name)) {
      throw new Error(`closure impact contributor ${name} already registered`);
    }
    this.contributors.set(name, contributor);
  }

  async collect(
    db: Db | Trx,
    organizationId: string,
    events: readonly ImpactedEventRef[],
  ): Promise<CollectedImpact> {
    const customers = new Map<
      string,
      { personId: string; eventIds: Set<string>; via: Set<string> }
    >();
    const obligations = new Map<string, { type: string; id: string; eventIds: Set<string> }>();
    const messages = new Map<string, ClosureImpact['messages'][number]>();
    const staff = new Map<string, StaffAssignment>();
    // a contribution only names events of this closure (a contributor's slip never widens it)
    const eventIds = new Set(events.map((e) => e.eventId));
    // with no affected event there is no assignment on one; otherwise only the module that owns
    // staff assignments can say so (R3-TRACE-A-06: "not identified" is never reported as none)
    let staffIdentified = events.length === 0;
    if (events.length > 0) {
      for (const contributor of this.contributors.values()) {
        const part = await contributor(db, organizationId, events);
        for (const c of part.customers ?? []) {
          const entry = customers.get(c.personId) ?? {
            personId: c.personId,
            eventIds: new Set<string>(),
            via: new Set<string>(),
          };
          c.eventIds.forEach((id) => entry.eventIds.add(id));
          c.via.forEach((v) => entry.via.add(v));
          customers.set(c.personId, entry);
        }
        for (const o of part.obligations ?? []) {
          const key = `${o.type}:${o.id}`;
          const entry = obligations.get(key) ?? { type: o.type, id: o.id, eventIds: new Set() };
          o.eventIds.forEach((id) => entry.eventIds.add(id));
          obligations.set(key, entry);
        }
        for (const m of part.messages ?? []) messages.set(m.notificationId, m);
        if (part.staff !== undefined) staffIdentified = true;
        for (const a of part.staff ?? []) {
          if (eventIds.has(a.eventId)) staff.set(a.assignmentId, a);
        }
      }
    }
    const sorted = <T>(values: Iterable<T>) => [...values].sort();
    return {
      customers: [...customers.values()]
        .map((c) => ({
          personId: c.personId,
          eventIds: sorted(c.eventIds),
          via: sorted(c.via) as ClosureImpact['customers'][number]['via'],
        }))
        .sort((a, b) => a.personId.localeCompare(b.personId)),
      obligations: [...obligations.values()]
        .map((o) => ({ type: o.type, id: o.id, eventIds: sorted(o.eventIds) }))
        .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
      messages: [...messages.values()].sort((a, b) =>
        a.notificationId.localeCompare(b.notificationId),
      ),
      staff: staffIdentified
        ? [...staff.values()].sort(
            (a, b) =>
              a.eventId.localeCompare(b.eventId) || a.assignmentId.localeCompare(b.assignmentId),
          )
        : null,
    };
  }
}
