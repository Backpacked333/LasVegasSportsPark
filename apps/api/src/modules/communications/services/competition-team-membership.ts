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

/**
 * TEAM_MEMBERSHIP_PORT over the competition module's exported ports (§4.2: never its tables).
 * Membership is the effective roster at the clock (SPK-COMP-005): active, guest and substitute
 * rows whose effective window covers "now". A player removed today is no longer a recipient of a
 * team notice composed tomorrow, and a protected notice still awaiting hand-off is re-checked
 * against this same answer (SPK-COMMS-003). Reads go through the caller's transaction when one is
 * active so a roster change made earlier in the same command counts.
 */
@Injectable()
export class CompetitionTeamMembership implements TeamMembershipPort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROSTER_PORT) private readonly roster: RosterPort,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
  ) {}

  async membersOf(organizationId: string, teamEntryId: string, trx?: Trx): Promise<string[]> {
    const members = await this.roster.effectiveRoster(
      organizationId,
      teamEntryId,
      this.clock.now(),
      trx ?? currentTransaction(),
    );
    return uniqueStrings(members.map((m) => m.personId)).sort();
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
