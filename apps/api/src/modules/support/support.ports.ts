import type { CaseCategory, CasePriority, RecordReference } from '@sportspark/db';
import type { Trx } from '../../kernel';

/**
 * Port other modules consume (README "Ports"): open a support case from inside their own
 * transaction when their workflow needs a human owner (an escalation, an unresolvable follow-up).
 * The case is attributed to the system principal of the organization. One live case exists per
 * origin record, so a replayed handler never opens a second one.
 */
export interface SystemCaseInput {
  organizationId: string;
  category: CaseCategory;
  priority: CasePriority;
  title: string;
  facilityId?: string | null;
  subjectPersonId?: string | null;
  ownerQueue?: string | null;
  relatedRecords?: RecordReference[];
  origin?: { type: 'access_review' | 'operational_exception'; id: string } | null;
  correlationId?: string | null;
  /** Label for the system actor recorded on the case (`<module>.<purpose>`). */
  actorLabel: string;
}

export interface SupportCasesPort {
  openSystemCase(
    trx: Trx,
    input: SystemCaseInput,
  ): Promise<{ caseId: string; deduplicated: boolean }>;
}

export const SUPPORT_CASES_PORT = Symbol('SUPPORT_CASES_PORT');
