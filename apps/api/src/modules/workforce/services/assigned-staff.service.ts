import { Inject, Injectable } from '@nestjs/common';
import {
  type AssignedStaff,
  type AssignedStaffQuery,
  type AssignmentTargetType,
  type Principal,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, DATABASE, executorFor, type Trx } from '../../../kernel';
import { PeopleService } from '../../identity';
import { WorkforceActions } from '../workforce.actions';
import { COVERING_STATUSES, organizationOf } from '../workforce.shared';
import { notOfRetiredRequirement } from './coverage.service';

/** One assigned person as other modules read them (accepted or completed only). */
export interface AssignedPerson {
  assignmentId: string;
  targetId: string;
  personId: string;
  displayName: string;
  kind: AssignedStaff['items'][number]['staff'][number]['kind'];
  role: string;
  slot: number;
  status: 'accepted' | 'completed';
  facilityId: string;
}

/**
 * Who is assigned to an activity (SPK-STAFF-002: only accepted or completed assignments count as
 * assigned; proposed and offered never do; WRK-02: assignments of a retired requirement are left
 * out). Serves the arrival screen's "coach for this session" (`GET /v1/assigned-staff`) and other
 * modules through {@link assignedTo}. Staff read it where they may view assignments: a facility
 * whose assignments the viewer may not see is left out, never named.
 */
@Injectable()
export class AssignedStaffService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly authorization: AuthorizationService,
    private readonly people: PeopleService,
  ) {}

  /** `GET /v1/assigned-staff?targetType=session&targetIds=…`. */
  async list(principal: Principal, query: AssignedStaffQuery): Promise<AssignedStaff> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, WorkforceActions.viewAssignments, {
      type: 'assignment',
      id: null,
      organizationId,
    });
    const rows = await this.assignedTo(organizationId, query.targetType, query.targetIds);
    const allowed = new Map<string, boolean>();
    for (const facilityId of new Set(rows.map((r) => r.facilityId))) {
      const decision = await this.authorization.decide(
        principal,
        WorkforceActions.viewAssignments,
        { type: 'assignment', id: null, organizationId, facilityId },
      );
      allowed.set(facilityId, decision.allowed);
    }
    const visible = rows.filter((r) => allowed.get(r.facilityId));
    return {
      targetType: query.targetType,
      items: [...new Set(query.targetIds)].map((targetId) => ({
        targetId,
        staff: visible
          .filter((r) => r.targetId === targetId)
          .map(({ facilityId: _facility, targetId: _target, ...person }) => person),
      })),
    };
  }

  /** Exported read (no authorization: the caller decides who sees it). */
  async assignedTo(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetIds: readonly string[],
    trx?: Trx,
  ): Promise<AssignedPerson[]> {
    if (targetIds.length === 0) return [];
    const db = trx ?? executorFor(this.db);
    const rows = await db
      .selectFrom('assignments as a')
      .select([
        'a.id',
        'a.target_id',
        'a.person_id',
        'a.kind',
        'a.role',
        'a.slot',
        'a.status',
        'a.facility_id',
      ])
      .where('a.organization_id', '=', organizationId)
      .where('a.target_type', '=', targetType)
      .where('a.target_id', 'in', [...targetIds])
      .where('a.status', 'in', [...COVERING_STATUSES])
      .where(notOfRetiredRequirement('a'))
      .orderBy('a.target_id')
      .orderBy('a.kind')
      .orderBy('a.role')
      .orderBy('a.slot')
      .execute();
    const names = await this.people.displayNames(
      organizationId,
      rows.map((r) => r.person_id),
      trx,
    );
    return rows.map((r) => ({
      assignmentId: r.id,
      targetId: r.target_id,
      personId: r.person_id,
      displayName: names.get(r.person_id)?.displayName ?? 'Unknown person',
      kind: r.kind,
      role: r.role,
      slot: r.slot,
      status: r.status as 'accepted' | 'completed',
      facilityId: r.facility_id,
    }));
  }
}
