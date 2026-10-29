import type { StaffRole } from '@sportspark/contracts';
import type { CaseCategory, CasePriority } from '@sportspark/db';

/**
 * Support policy values the specification leaves to operators (§6.6). The mechanisms are
 * implemented; the values below are engineering proposals pending the operator decisions noted
 * per field (docs/package-a/decision-register.md), configurable through the SUPPORT_POLICY token.
 */
export interface SupportPolicy {
  /**
   * Case service levels by priority, in minutes from opening (proposed: urgent 4 h, high 1 day,
   * normal 3 days, low 7 days). Pending the support service-level decision (§5.11, §6.6
   * "Support and operations ownership").
   */
  caseDueMinutes: Record<CasePriority, number>;
  /**
   * Staff roles that see every exception queue in the Today workspace and exception lists
   * (oversight). Other staff see the queues their roles own (SPK-UX-006 "within the viewer's
   * scope"). Proposed: general manager, system administrator, support operator.
   */
  oversightRoles: readonly StaffRole[];
  /** Readiness evaluations with only warnings or unknown evidence are shown as `info` items. */
  showUnconfirmedReadiness: boolean;
  /** Upper bound of records each timeline source reads per person (one page, newest first). */
  timelineSourceLimit: number;
  /** Upper bound of fixtures and events evaluated per facility for the Today workspace. */
  todayEventLimit: number;
  /** Priority given to a case opened by an escalated disputed-access review (SPK-IAM-005). */
  accessEscalationPriority: CasePriority;
  /**
   * Minutes after a helper request (for example a refund from a case) is recorded `requested`
   * before support treats its outcome as lost: the action becomes `unknown`, the support operation
   * `recovery_required`, and the owning module's queue gets an exception (§4.7 invariant 12,
   * §4.11). Proposed: 15 minutes, longer than a provider call's timeout; pending the §6.6 support
   * and operations ownership decisions.
   */
  helperOutcomeGraceMinutes: number;
  /**
   * SUP-01: the queue a customer's own support request is routed to, by category (a staff-role
   * queue or a configured exception queue). Proposed: every category to `support_operator`, the
   * queue that triages and reassigns; routing by category is pending DEC-015 (support coverage).
   */
  customerRequestQueues: Record<CaseCategory, string>;
  /** SUP-01: the priority (and so the service level) of a customer's request. Proposed: normal. */
  customerRequestPriority: CasePriority;
}

export const DEFAULT_SUPPORT_POLICY: SupportPolicy = {
  caseDueMinutes: { urgent: 4 * 60, high: 24 * 60, normal: 3 * 24 * 60, low: 7 * 24 * 60 },
  oversightRoles: ['general_manager', 'system_administrator', 'support_operator'],
  showUnconfirmedReadiness: true,
  timelineSourceLimit: 200,
  todayEventLimit: 200,
  accessEscalationPriority: 'high',
  helperOutcomeGraceMinutes: 15,
  customerRequestQueues: {
    access: 'support_operator',
    registration: 'support_operator',
    payment: 'support_operator',
    schedule: 'support_operator',
    team: 'support_operator',
    facility: 'support_operator',
    other: 'support_operator',
  },
  customerRequestPriority: 'normal',
};

export const SUPPORT_POLICY = Symbol('SUPPORT_POLICY');
