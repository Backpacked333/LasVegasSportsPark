import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../../../kernel';

/** A commitment of a party held in another module's records (never in `event_commitments`). */
export interface HeldCommitment {
  /** The registered source, for example `workforce.assignments`. */
  source: string;
  /** The owning module's record id. */
  id: string;
  /** The interval the party is held for (the owner includes any turnaround it requires). */
  start: Date;
  end: Date;
}

/**
 * A module that holds commitments of parties outside scheduling's tables registers a source here,
 * so scheduling's conflict detection and its post-lock re-check see those commitments too
 * (SPK-SCHED-004 "official overlap", "assigned coach overlap"; SPK-STAFF-003). The source reads
 * its own tables through the transaction it is given; scheduling never reads them (§4.2).
 */
export interface PartyCommitmentSource {
  id: string;
  /** Party types the source holds commitments for (for example `person`). */
  partyTypes: readonly string[];
  /**
   * Commitments of the party whose held interval overlaps `range`, leaving out those that belong
   * to `ignoreEventIds` (an event moving or being replaced together with its own commitments).
   */
  held(
    trx: Trx,
    organizationId: string,
    partyType: string,
    partyId: string,
    range: { start: Date; end: Date },
    ignoreEventIds: readonly string[],
  ): Promise<Array<{ id: string; start: Date; end: Date }>>;
}

/**
 * Registry of external party commitment sources (exported by SchedulingModule, filled by the
 * owning modules in `onModuleInit`). Commands for a covered party take the party's advisory lock
 * (`lockParty`) before they read, so a scheduling reservation and the other module's write for the
 * same party are serialized: the one that runs second sees the first (§4.7, application-level
 * guarantee across two modules' tables; no single exclusion constraint spans them).
 */
@Injectable()
export class PartyCommitmentSources {
  private readonly sources = new Map<string, PartyCommitmentSource>();

  register(source: PartyCommitmentSource): void {
    this.sources.set(source.id, source);
  }

  covers(partyType: string): boolean {
    for (const source of this.sources.values()) {
      if (source.partyTypes.includes(partyType)) return true;
    }
    return false;
  }

  async held(
    trx: Trx,
    organizationId: string,
    partyType: string,
    partyId: string,
    range: { start: Date; end: Date },
    ignoreEventIds: readonly string[],
  ): Promise<HeldCommitment[]> {
    const out: HeldCommitment[] = [];
    for (const source of this.sources.values()) {
      if (!source.partyTypes.includes(partyType)) continue;
      for (const held of await source.held(
        trx,
        organizationId,
        partyType,
        partyId,
        range,
        ignoreEventIds,
      )) {
        out.push({ source: source.id, ...held });
      }
    }
    return out;
  }
}

/** The advisory lock key scheduling uses per committed party (SPK-SCHED-004). */
export function partyLockKey(organizationId: string, partyType: string, partyId: string): string {
  return `scheduling.party:${organizationId}:${partyType}:${partyId}`;
}

/** Takes the party's transaction-scoped advisory lock (the one `EventWriter.reserve` takes). */
export async function lockParty(
  trx: Trx,
  organizationId: string,
  partyType: string,
  partyId: string,
): Promise<void> {
  const key = partyLockKey(organizationId, partyType, partyId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}
