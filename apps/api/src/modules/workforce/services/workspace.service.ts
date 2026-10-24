import { Inject, Injectable } from '@nestjs/common';
import {
  AssignmentMachine,
  errors,
  type MyAssignments,
  type MyAssignmentsQuery,
  type Principal,
  type WorkspaceAssignment,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, CLOCK, DATABASE, type Clock } from '../../../kernel';
import { WorkforceActions } from '../workforce.actions';
import { iso, organizationOf, toAssignment, type AssignmentRow } from '../workforce.shared';
import { FeesService } from './fees.service';
import { TargetResolver, type TargetParticipant } from './target-resolver';

/** Assignments the workspace shows by default: the recent past (fees, reports) and the future. */
const DEFAULT_LOOKBACK_DAYS = 30;

/** Participant information is shown only while the person is (or was) actually assigned. */
const PARTICIPANTS_VISIBLE: ReadonlySet<string> = new Set(['offered', 'accepted', 'completed']);

/**
 * Coach and referee workspace (SPK-UX-007): the caller's own assignments, the activity's
 * practical details, the competing teams' names for fixtures (no dates of birth, contacts or
 * payment data, §4.14), the fee record, and the commands available now. It exposes nothing about
 * activities the person is not assigned to.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly targets: TargetResolver,
    private readonly fees: FeesService,
  ) {}

  async myAssignments(principal: Principal, query: MyAssignmentsQuery): Promise<MyAssignments> {
    const organizationId = organizationOf(principal);
    const personId = principal.personId;
    if (!personId) throw errors.validation('The account is not linked to a person.');
    await this.authorization.require(principal, WorkforceActions.viewAssignments, {
      type: 'assignment',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const now = this.clock.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
    let q = this.db
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('scheduled_end', '>', from)
      .orderBy('scheduled_start')
      .orderBy('id');
    if (query.to) q = q.where('scheduled_start', '<', new Date(query.to));
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    const fees = await this.fees.forAssignments(
      this.db,
      organizationId,
      rows.map((r) => r.id),
    );
    const participantsByFixture = new Map<string, TargetParticipant[]>();
    const items: WorkspaceAssignment[] = [];
    for (const row of rows) {
      let participants: TargetParticipant[] = [];
      if (row.fixture_id && PARTICIPANTS_VISIBLE.has(row.status)) {
        const cached = participantsByFixture.get(row.fixture_id);
        participants = cached ?? (await this.targets.participants(organizationId, row.fixture_id));
        participantsByFixture.set(row.fixture_id, participants);
      }
      const fee = fees.get(row.id) ?? null;
      items.push({
        assignment: toAssignment(row, now),
        activity: {
          targetType: row.target_type,
          targetId: row.target_id,
          title: row.target_title,
          facilityId: row.facility_id,
          scheduledStart: iso(row.scheduled_start),
          scheduledEnd: iso(row.scheduled_end),
          participants,
        },
        fee,
        availableActions: this.actionsFor(row, fee !== null && fee.status !== 'rejected', now),
      });
    }
    return { evaluatedAt: now.toISOString(), items };
  }

  private actionsFor(row: AssignmentRow, hasLiveFee: boolean, now: Date): string[] {
    const actions: string[] = [];
    const ended = now.getTime() >= new Date(row.scheduled_end).getTime();
    if (!ended && AssignmentMachine.can(row.status, 'accept')) actions.push('accept');
    if (AssignmentMachine.can(row.status, 'decline')) actions.push('decline');
    if (!ended && row.status === 'accepted') actions.push('withdraw');
    if (row.status === 'completed' && !hasLiveFee) actions.push('submit_fee');
    return actions;
  }
}
