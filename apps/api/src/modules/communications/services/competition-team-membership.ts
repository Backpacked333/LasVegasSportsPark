import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, currentTransaction, type Clock, type Trx } from '../../../kernel';
import {
  ROSTER_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type RosterPort,
  type TeamEntryQueryPort,
} from '../../competition';
import type { TeamMembershipPort } from '../ports';
import { uniqueStrings } from '../communications.shared';

/** Team roles whose holders belong to a team audience with or without a roster row (COM-03). */
export const TEAM_AUDIENCE_ROLES = ['captain', 'co_captain'] as const;

/**
 * TEAM_MEMBERSHIP_PORT over the competition module's exported ports (§4.2: never its tables).
 * Membership is the effective roster at the clock (SPK-COMP-005): active, guest and substitute
 * rows whose effective window covers "now", plus the people holding the captain or co-captain role
 * on the entry at the clock with or without a roster row (COM-03, IF-15 `roleHolders`), so a
 * non-playing co-captain hears the team's notices. A player removed today, or a captain whose role
 * ended, is no longer a recipient of a team notice composed tomorrow, and a protected notice still
 * awaiting hand-off is re-checked against this same answer (SPK-COMMS-003). Reads go through the
 * caller's transaction when one is active so a roster change made earlier in the same command
 * counts.
 */
@Injectable()
export class CompetitionTeamMembership implements TeamMembershipPort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROSTER_PORT) private readonly roster: RosterPort,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
  ) {}

  async membersOf(organizationId: string, teamEntryId: string, trx?: Trx): Promise<string[]> {
    const at = this.clock.now();
    const reader = trx ?? currentTransaction();
    const members = await this.roster.effectiveRoster(organizationId, teamEntryId, at, reader);
    const holders = await this.entries.roleHolders(
      organizationId,
      teamEntryId,
      TEAM_AUDIENCE_ROLES,
      at,
      reader,
    );
    return uniqueStrings([
      ...members.map((m) => m.personId),
      ...holders.map((h) => h.personId),
    ]).sort();
  }

  async isMember(
    organizationId: string,
    teamEntryId: string,
    personId: string,
    trx?: Trx,
  ): Promise<boolean> {
    return (await this.membersOf(organizationId, teamEntryId, trx)).includes(personId);
  }

  async teamEntriesOf(organizationId: string, personId: string, trx?: Trx): Promise<string[]> {
    const entries = await this.entries.entriesOfPerson(
      organizationId,
      personId,
      this.clock.now(),
      trx ?? currentTransaction(),
    );
    return uniqueStrings(entries.map((e) => e.teamEntryId)).sort();
  }
}
