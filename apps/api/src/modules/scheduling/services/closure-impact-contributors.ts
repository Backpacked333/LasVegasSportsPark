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
 * participation (enrollment, competition rosters), the money and the messages register a
 * contributor in `onModuleInit` and answer from their own tables (§4.2). The preview stays
 * staff-only (`scheduling.manage_closures`) and carries ids and counts, never names.
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
  ): Promise<Required<ClosureImpactContribution>> {
    const customers = new Map<
      string,
      { personId: string; eventIds: Set<string>; via: Set<string> }
    >();
    const obligations = new Map<string, { type: string; id: string; eventIds: Set<string> }>();
    const messages = new Map<string, ClosureImpact['messages'][number]>();
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
    };
  }
}
