import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import { PRICING_PORT, type PricingPort } from '../../catalog';
import type { ExpectedAtSession, SessionRosterPort } from '../enrollment.ports';
import { attendsSessionSql } from './attended-sessions';

/**
 * SESSION_ROSTER_PORT (SPK-PAY-014, proposed amendment PA-03): who a session of an offering
 * expects. A confirmed registration attends every session unless it carries a day selection, in
 * which case it attends only the sessions selected; each participant comes with the add-ons
 * bought for that day (an add-on selected for the registration counts on every day attended).
 * Read-only, from enrollment's own records; add-on names come from catalog's port.
 */
@Injectable()
export class SessionRoster implements SessionRosterPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
  ) {}

  async expectedAtSession(
    organizationId: string,
    offeringId: string,
    sessionId: string,
    trx?: Trx,
  ): Promise<ExpectedAtSession[]> {
    const db = trx ?? executorFor(this.db);
    const enrollments = await db
      .selectFrom('enrollments')
      .select(['id', 'participant_person_id', 'basket_line_id'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .where('status', '=', 'confirmed')
      // The one rule of which sessions an enrollment attends (`attended-sessions.ts`).
      .where(attendsSessionSql(sessionId))
      .orderBy('participant_person_id')
      .orderBy('id')
      .execute();
    if (enrollments.length === 0) return [];
    const lineIds = enrollments.flatMap((e) => e.basket_line_id ?? []);
    const addonRows =
      lineIds.length > 0
        ? await db
            .selectFrom('basket_line_addons')
            .select(['basket_line_id', 'addon_id'])
            .where('organization_id', '=', organizationId)
            .where('basket_line_id', 'in', lineIds)
            .where((eb) => eb.or([eb('session_id', 'is', null), eb('session_id', '=', sessionId)]))
            .execute()
        : [];
    const addons =
      addonRows.length > 0
        ? (await this.pricing.offeringExtras(organizationId, offeringId, trx)).addons
        : [];
    return enrollments.map((enrollment) => {
      const chosen = new Set(
        addonRows
          .filter((row) => row.basket_line_id === enrollment.basket_line_id)
          .map((row) => row.addon_id),
      );
      return {
        participantPersonId: enrollment.participant_person_id,
        enrollmentId: enrollment.id,
        // In the catalog's own order of the add-ons, so the list reads the same every day.
        addons: addons
          .filter((addon) => chosen.has(addon.id))
          .map((addon) => ({ addonId: addon.id, code: addon.code, name: addon.name })),
      };
    });
  }
}
