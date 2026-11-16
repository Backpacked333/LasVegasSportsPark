import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import type { TeamPlayerCommitments, TeamPlayerCommitmentsPort } from '../../competition';

/**
 * What the players of a team entry hold with this module (SPK-COMP-006, QA M-5), registered as
 * competition's TEAM_PLAYER_COMMITMENTS_IMPL. A read: it writes nothing and names nobody.
 *
 * - `confirmedRegistrations`: confirmed `join_team` enrollments whose basket line names the entry,
 *   or (when the line names none) whose application does: the same rule `EnrollmentsService` uses
 *   to place a confirmed player on the roster. A team entry belongs to one season, so these are
 *   the registrations made for that season's offering.
 * - `uniformOrders`: uniform orders recorded for the entry that are not canceled (ordered, paid
 *   or handed over).
 */
@Injectable()
export class TeamPlayerCommitmentsReader implements TeamPlayerCommitmentsPort {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async commitmentsOfEntry(
    organizationId: string,
    teamEntryId: string,
    trx?: Trx,
  ): Promise<TeamPlayerCommitments> {
    const db = trx ?? executorFor(this.db);
    const registrations = await db
      .selectFrom('enrollments as e')
      .leftJoin('basket_lines as l', (join) =>
        join
          .onRef('l.organization_id', '=', 'e.organization_id')
          .onRef('l.id', '=', 'e.basket_line_id'),
      )
      .leftJoin('applications as a', (join) =>
        join
          .onRef('a.organization_id', '=', 'e.organization_id')
          .onRef('a.id', '=', 'e.source_application_id'),
      )
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('e.organization_id', '=', organizationId)
      .where('e.intent', '=', 'join_team')
      .where('e.status', '=', 'confirmed')
      .where((eb) =>
        eb.or([
          eb('l.team_entry_id', '=', teamEntryId),
          eb.and([eb('l.team_entry_id', 'is', null), eb('a.team_entry_id', '=', teamEntryId)]),
        ]),
      )
      .executeTakeFirstOrThrow();
    const uniforms = await db
      .selectFrom('uniform_orders')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', '=', teamEntryId)
      .where('status', '<>', 'canceled')
      .executeTakeFirstOrThrow();
    return {
      confirmedRegistrations: Number(registrations.n),
      uniformOrders: Number(uniforms.n),
    };
  }
}
