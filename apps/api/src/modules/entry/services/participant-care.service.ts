import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type ParticipantCareFlags,
  type ParticipantCareFlagsQuery,
  type ParticipantCareNotes,
  type ParticipantCareNotesQuery,
  type Principal,
} from '@sportspark/contracts';
import { CLOCK, UnitOfWork, type Clock } from '../../../kernel';
import { CareNotesService } from '../../identity';
import { EntryActions } from '../entry.actions';
import { organizationOf } from '../entry.shared';
import { ActivityResolver, type ResolvedActivity } from './activity-resolver';
import { ReleasesService } from './releases.service';
import { StaffScope } from './staff-scope';

type ActivityQuery = Pick<ParticipantCareFlagsQuery, 'activityType' | 'activityId' | 'offeringId'>;

/**
 * Care notes on the coach's attendance tiles (staff S 2d; SPK-ENTRY-004 actionable information,
 * §1.7 operational notes only, never a diagnosis; §4.14 protected and audited; SPK-UX-007).
 *
 * - The assigned coach or official of the activity (an accepted assignment, StaffScope) reads, for
 *   the people taking part in it only: which ones have a note, by kind (`/attendance/care-flags`,
 *   no text, nothing audited) and, one person at a time, the notes' text
 *   (`/attendance/care-notes`, one audit record per person whose notes were shown, through
 *   identity's `readForArrivalIn`).
 * - Desk staff reach the same reads when their role may read care notes at the facility
 *   (`identity.read_care_notes`); anyone else is refused.
 * - Proposed policy: assigned coaches reading the care notes of their own session's participants
 *   (identity's care-note readers are the desk and managers); see apps/staff/README.md.
 */
@Injectable()
export class ParticipantCareService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly resolver: ActivityResolver,
    private readonly scope: StaffScope,
    private readonly careNotes: CareNotesService,
    private readonly releases: ReleasesService,
  ) {}

  async flags(
    principal: Principal,
    query: ParticipantCareFlagsQuery,
  ): Promise<ParticipantCareFlags> {
    const organizationId = organizationOf(principal);
    const activity = await this.authorize(principal, query);
    return this.uow.run(async ({ trx }) => {
      const taking: string[] = [];
      for (const personId of new Set(query.personIds)) {
        if (await this.releases.takesPart(trx, organizationId, personId, activity)) {
          taking.push(personId);
        }
      }
      const kinds = await this.careNotes.kindsIn(trx, organizationId, taking);
      return {
        items: taking
          .filter((id) => kinds.has(id))
          .map((personId) => ({ personId, kinds: kinds.get(personId) ?? [] })),
      };
    });
  }

  async notes(
    principal: Principal,
    query: ParticipantCareNotesQuery,
    correlationId: string | null,
  ): Promise<ParticipantCareNotes> {
    const organizationId = organizationOf(principal);
    const activity = await this.authorize(principal, query);
    return this.uow.run(async ({ trx }) => {
      if (!(await this.releases.takesPart(trx, organizationId, query.personId, activity))) {
        throw errors.protectedNotFound('person');
      }
      const notes = await this.careNotes.readForArrivalIn(
        trx,
        principal,
        [query.personId],
        {
          via: 'entry.attendance_care_notes',
          facilityId: activity.facilityId,
          referenceType: activity.detail.type,
          referenceId: activity.detail.id,
        },
        correlationId,
      );
      return {
        personId: query.personId,
        notes: notes.get(query.personId) ?? [],
        readAt: this.clock.now().toISOString(),
      };
    });
  }

  /** The assigned coach or official, or desk staff whose role may read care notes there. */
  private async authorize(principal: Principal, query: ActivityQuery): Promise<ResolvedActivity> {
    const organizationId = organizationOf(principal);
    const ref =
      query.activityType === 'session'
        ? query.offeringId
          ? { type: 'session' as const, offeringId: query.offeringId, sessionId: query.activityId }
          : null
        : { type: 'event' as const, eventId: query.activityId };
    if (!ref) throw errors.validation('offeringId is required for a session activity.');
    const activity = await this.resolver.resolve(organizationId, ref);
    const authority = await this.scope.requireForActivity(
      principal,
      EntryActions.readAttendance,
      EntryActions.readAssignedAttendance,
      activity,
    );
    if (
      authority === 'desk' &&
      !(await this.careNotes.mayReadAtFacility(principal, activity.facilityId))
    ) {
      throw errors.accessDenied('Care notes are not shown to your role.', {
        action: 'identity.read_care_notes',
      });
    }
    return activity;
  }
}
