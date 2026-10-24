import type {
  MetricValue,
  PointInTime,
  Principal,
  ReportColumn,
  ReportKey,
  ReportParameters,
  ReportRow,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { ActionDefinition, Trx } from '../../../kernel';
import type { ReportingPolicy } from '../reporting.policy';

export interface FacilityRef {
  id: string;
  timezone: string;
  name: string;
}

/**
 * What a report computation receives. Organization scope comes from the principal (§4.8, G1);
 * facility scope is the requested facility after authorization (G2). `asOf` is the evaluation
 * instant: never after `now`; facts recorded after it are ignored where the source keeps the
 * instant it recorded them (SPK-REPORT-007).
 */
export interface ReportContext {
  organizationId: string;
  facility: FacilityRef | null;
  asOf: Date;
  now: Date;
  db: Db | Trx;
  policy: ReportingPolicy;
  /** For ports that take a principal: the system principal of the organization (authorization already done). */
  system: Principal;
}

export interface ReportComputation {
  values: MetricValue[];
  columns: ReportColumn[];
  rows: ReportRow[];
  disclosures: string[];
  scope: { from: string | null; to: string | null };
}

export interface ReportDefinition<K extends ReportKey = ReportKey> {
  key: K;
  title: string;
  requirementIds: readonly string[];
  viewAction: ActionDefinition;
  exportAction: ActionDefinition;
  /** Facility reports require `facilityId`; organization reports need organization-wide access. */
  scope: 'facility' | 'organization';
  pointInTime: PointInTime;
  /** What a reader must know about as-of evaluation for this report. */
  pointInTimeNote: string;
  compute(ctx: ReportContext, params: ReportParameters<K>): Promise<ReportComputation>;
}

export function column(
  key: string,
  label: string,
  type: ReportColumn['type'] = 'text',
): ReportColumn {
  return { key, label, type };
}
