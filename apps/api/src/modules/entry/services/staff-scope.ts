import { Inject, Injectable } from '@nestjs/common';
import { errors, type AssignmentTargetType, type Principal } from '@sportspark/contracts';
import { AuthorizationService, type ActionDefinition, type Trx } from '../../../kernel';
import { ASSIGNMENT_COVERAGE_PORT, type AssignmentCoveragePort } from '../../workforce';
import { DESK_ROLES } from '../entry.actions';
import { organizationOf } from '../entry.shared';
import type { ResolvedActivity } from './activity-resolver';

export type ActivityAuthority = 'desk' | 'assigned';

/**
 * Activity-scoped authority (§2.1, SPK-UX-007). Desk roles act on any activity inside their
 * facility scope. A coach or official acts only on an activity they hold an accepted (or
 * completed) workforce assignment for: the session itself, its scheduling event, or the fixture
 * the event schedules. Assignment facts are read through workforce's ASSIGNMENT_COVERAGE_PORT,
 * never its tables (§4.2).
 */
@Injectable()
export class StaffScope {
  constructor(
    private readonly authorization: AuthorizationService,
    @Inject(ASSIGNMENT_COVERAGE_PORT) private readonly coverage: AssignmentCoveragePort,
  ) {}

  async requireForActivity(
    principal: Principal,
    desk: ActionDefinition,
    assigned: ActionDefinition,
    activity: ResolvedActivity,
    trx?: Trx,
  ): Promise<ActivityAuthority> {
    const organizationId = organizationOf(principal);
    const target = {
      type: 'activity',
      id: activity.detail.id,
      organizationId,
      facilityId: activity.facilityId,
    };
    const deskDecision = await this.authorization.decide(principal, desk, target);
    if (deskDecision.allowed) return 'desk';
    const fieldDecision = await this.authorization.decide(principal, assigned, target);
    if (fieldDecision.allowed) {
      if (
        principal.personId &&
        (await this.isAssigned(organizationId, activity, principal.personId, trx))
      ) {
        return 'assigned';
      }
      throw errors.accessDenied('You are not assigned to this activity.', {
        action: assigned.id,
        code: 'not_assigned',
      });
    }
    // Neither applies: the desk action produces the standard denial (facility scope, role, …).
    await this.authorization.require(principal, desk, target);
    return 'desk';
  }

  /** Whether the person holds an accepted (or completed) assignment covering the activity. */
  async isAssigned(
    organizationId: string,
    activity: ResolvedActivity,
    personId: string,
    trx?: Trx,
  ): Promise<boolean> {
    const targets: Array<[AssignmentTargetType, string]> = [];
    if (activity.detail.type === 'session' && activity.detail.sessionId) {
      targets.push(['session', activity.detail.sessionId]);
    }
    if (activity.schedulingEventId) targets.push(['event', activity.schedulingEventId]);
    if (activity.fixtureId) targets.push(['fixture', activity.fixtureId]);
    for (const [type, id] of targets) {
      const people = await this.coverage.acceptedAssignees(
        organizationId,
        type,
        id,
        undefined,
        trx,
      );
      if (people.includes(personId)) return true;
    }
    return false;
  }

  hasDeskRole(principal: Principal): boolean {
    return (
      principal.kind === 'system' ||
      (principal.kind === 'staff' && principal.staffRoles.some((r) => DESK_ROLES.includes(r)))
    );
  }
}
