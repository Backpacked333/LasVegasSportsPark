import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/**
 * Reporting actions (specification §3.20 SPK-REPORT-001..007; roles from the proposed permission
 * matrix, docs/package-a/permission-matrix.md section C.14, **Proposed**). Viewing a report and
 * exporting it are separate actions: an export is checked independently of the right to view
 * (SPK-REPORT-007), so a role may read a report on screen yet be refused its export. Customers
 * hold no reporting action. Every report is computed over the principal's organization only, and
 * facility-scoped staff only see the facilities they are scoped to (metric dictionary G1, G2).
 */
const OPERATIONS_VIEWERS: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];

export const ReportingActions = defineActions({
  viewOperationsReports: {
    id: 'reporting.view_operations_reports',
    description:
      'Daily schedule, expected arrivals, attendance, match readiness, uncovered assignments, maintenance restrictions, communication failures',
    staffRoles: OPERATIONS_VIEWERS,
    requirements: ['SPK-REPORT-002'],
  },
  viewDemandReports: {
    id: 'reporting.view_demand_reports',
    description:
      'Waitlist demand, registration funnel, enrollment and roster completeness, demand by day, time, age band, format and program',
    staffRoles: ['league_manager', 'program_manager', 'general_manager', 'system_administrator'],
    requirements: ['SPK-REPORT-002', 'SPK-REPORT-006'],
  },
  viewFinancialReports: {
    id: 'reporting.view_financial_reports',
    description:
      'Outstanding obligations, payment and refund reconciliation, economics with an explicit allocation method',
    staffRoles: ['finance_operator', 'general_manager'],
    requirements: ['SPK-REPORT-002', 'SPK-REPORT-004'],
  },
  viewUtilization: {
    id: 'reporting.view_utilization',
    description:
      'Reserved, available, observed and closed hours without double counting; disclosed weighting',
    staffRoles: ['scheduler', 'finance_operator', 'facilities_operator', 'general_manager'],
    requirements: ['SPK-REPORT-003'],
  },
  viewRetention: {
    id: 'reporting.view_retention',
    description:
      'Renewal by cohort: adult teams, individual players, youth participants, households, rental customers',
    staffRoles: ['league_manager', 'program_manager', 'general_manager'],
    requirements: ['SPK-REPORT-005'],
  },
  exportOperational: {
    id: 'reporting.export_operational',
    description:
      'Export an operational, demand, utilization or retention report run (independent check, audited, expiring)',
    staffRoles: [
      'league_manager',
      'program_manager',
      'scheduler',
      'general_manager',
      'system_administrator',
    ],
    requirements: ['SPK-REPORT-007', '§4.14'],
  },
  exportFinancial: {
    id: 'reporting.export_financial',
    description: 'Export a financial report run (independent check, audited, expiring)',
    staffRoles: ['finance_operator', 'general_manager'],
    requirements: ['SPK-REPORT-007', '§4.14'],
  },
  readMetricDefinitions: {
    id: 'reporting.read_metric_definitions',
    description: 'Read metric definitions (business question, grain, numerator and denominator …)',
    staffRoles: [...OPERATIONS_VIEWERS, 'finance_operator'],
    requirements: ['SPK-REPORT-001'],
  },
  manageCostInputs: {
    id: 'reporting.manage_cost_inputs',
    description: 'Record or withdraw agreed cost inputs for contribution margin',
    staffRoles: ['finance_operator', 'general_manager'],
    requirements: ['SPK-REPORT-004'],
  },
  readCostInputs: {
    id: 'reporting.read_cost_inputs',
    description: 'Read agreed cost inputs',
    staffRoles: ['finance_operator', 'general_manager'],
    requirements: ['SPK-REPORT-004'],
  },
});
