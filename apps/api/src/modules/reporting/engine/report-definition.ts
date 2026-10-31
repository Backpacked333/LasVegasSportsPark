import type {
  MetricValue,
  PointInTime,
  Principal,
  ReportColumn,
  ReportConsistency,
  ReportKey,
  ReportParameters,
  ReportRow,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { ActionDefinition, Trx } from '../../../kernel';
import type { ReportingPolicy } from '../reporting.policy';
import type { ReportingSettingName } from '../reporting.settings';

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
 *
 * REP-03: a `snapshot` report computes inside one read-only repeatable-read transaction: `db` is
 * that transaction and `trx` is handed to every port, so every source is read from one snapshot.
 * An `owner_reads` report computes outside a transaction (`trx` null) because the owning module's
 * query service reads through its own connection.
 */
export interface ReportContext {
  organizationId: string;
  facility: FacilityRef | null;
  asOf: Date;
  now: Date;
  db: Db | Trx;
  /** The snapshot transaction passed to ports; null for an `owner_reads` report. */
  trx: Trx | null;
  policy: ReportingPolicy;
  /** Local `HH:MM` at which a reported day starts (`00:00` unless configured, DEC-001). */
  dayStart: string;
  /** For ports that take a principal: the system principal of the organization (authorization already done). */
  system: Principal;
}

export interface ReportComputation {
  values: MetricValue[];
  columns: ReportColumn[];
  rows: ReportRow[];
  disclosures: string[];
  scope: { from: string | null; to: string | null };
  /** The settings this evaluation used, when they depend on the parameters (else the definition's). */
  settings?: readonly ReportingSettingName[];
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
  /** REP-03: one snapshot (default) or the owning module's own reads (named in the response). */
  consistency?: ReportConsistency;
  /** The module settings the report uses (named in every response, REP-03). */
  settings?: readonly ReportingSettingName[];
  compute(ctx: ReportContext, params: ReportParameters<K>): Promise<ReportComputation>;
}

export function column(
  key: string,
  label: string,
  type: ReportColumn['type'] = 'text',
): ReportColumn {
  return { key, label, type };
}
