import type {
  EvidenceReference,
  FacilityOperatingStatus,
  MaintenanceSeverity,
  MaintenanceTask,
  Principal,
  Restriction,
} from '@sportspark/contracts';

/**
 * Ports other modules call (README "Ports"). Every method takes the acting principal and
 * authorizes against the real target; organization scope always comes from the principal.
 */

export interface ReportIssueInput {
  facilityId: string;
  assetId?: string | null;
  resourceId?: string | null;
  issue: string;
  severity: MaintenanceSeverity;
  evidence?: EvidenceReference[];
  dueAt?: string | null;
  requiresInspection?: boolean;
  reason?: string;
  correlationId?: string | null;
}

/** Used by support, entry and automation to raise maintenance issues from their own workflows (SPK-FAC-002). */
export interface MaintenanceReportPort {
  reportIssue(principal: Principal, input: ReportIssueInput): Promise<MaintenanceTask>;
}
export const MAINTENANCE_REPORT_PORT = Symbol('MAINTENANCE_REPORT_PORT');

/** Used by reporting and the Today workspace: which spaces are in service right now and why not (SPK-FAC-003). */
export interface OperatingStatusPort {
  operatingStatus(
    principal: Principal,
    facilityId: string,
    at?: Date | string,
  ): Promise<FacilityOperatingStatus>;
  /** Active restrictions overlapping an interval for a resource (reporting, communications). */
  activeRestrictions(
    principal: Principal,
    facilityId: string,
    interval: { start: string; end: string },
    resourceId?: string | null,
  ): Promise<Restriction[]>;
}
export const OPERATING_STATUS_PORT = Symbol('OPERATING_STATUS_PORT');
