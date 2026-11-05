import type {
  AssetKind,
  AssetStatus,
  EvidenceReference,
  FacilityOperatingStatus,
  MaintenanceSeverity,
  MaintenanceTask,
  Principal,
  Restriction,
} from '@sportspark/contracts';
import type { Trx } from '../../kernel';

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

/** One asset as a booking sees it (FAC-02, IF-33). */
export interface AssetDirectoryEntry {
  id: string;
  facilityId: string;
  kind: AssetKind;
  name: string;
  /**
   * The asset's lifecycle status: `restricted` means an approved, unreleased restriction names the
   * asset (now or later), not that it is unavailable at every time.
   */
  status: AssetStatus;
  /**
   * Without `intervals`: in service and named by no active restriction at the clock instant (the
   * conservative answer when the caller does not say when). With `intervals`
   * (R4-OPS-MODULES-05, SPK-FAC-003): in service, or restricted only by restrictions, and named by
   * no approved or active restriction overlapping any of the intervals.
   */
  usable: boolean;
}

/** R4-OPS-MODULES-05 (SPK-FAC-003, SPK-COND-003): when the booking needs the equipment. */
export interface AssetDirectoryOptions {
  /** The booking's occurrences, each `[start, end)` with start before end. */
  intervals?: readonly { start: Date | string; end: Date | string }[];
}

/**
 * Asset directory for booking equipment (FAC-02, IF-33): reads through the passed or active
 * transaction; unknown or other-organization ids are omitted, so a booking naming an omitted or
 * unusable asset is refused. A booking passes its intervals so `usable` answers for the times it
 * reserves (a restriction affects availability for its approved interval, SPK-FAC-003).
 * FacilitiesModule registers ASSET_DIRECTORY_IMPL (`AssetDirectoryService`); without it every asset
 * reads as unknown (the conservative default: no equipment can be booked).
 */
export interface AssetDirectoryPort {
  describe(
    organizationId: string,
    assetIds: readonly string[],
    trx?: Trx,
    options?: AssetDirectoryOptions,
  ): Promise<Map<string, AssetDirectoryEntry>>;
}
export const ASSET_DIRECTORY_PORT = Symbol('ASSET_DIRECTORY_PORT');
export const ASSET_DIRECTORY_IMPL = Symbol('ASSET_DIRECTORY_IMPL');

/** The declared default: no asset is known. */
export const noAssetDirectory: AssetDirectoryPort = {
  describe: async () => new Map(),
};
