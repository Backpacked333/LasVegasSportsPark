import type { ColumnType, Generated } from 'kysely';
import type { GeneratedTimestamp, Json, MinorUnits, NullableTimestamp, Timestamp } from './core';

/**
 * Reporting module tables and read-only views (migration 1300, specification §3.20
 * SPK-REPORT-001..007). The module writes only its four tables; the `reporting_*_v` views expose
 * other modules' records for reading and are typed so that the application can never insert or
 * update through them (the database refuses that too, with an INSTEAD OF trigger).
 */

/** A read-only view column. */
type V<T> = ColumnType<T, never, never>;
/** A stored generated column: readable, never written by the application. */
type GeneratedColumn<T> = ColumnType<T, never, never>;
/** A `date` column written as `YYYY-MM-DD` (read it with an explicit `::text` cast). */
export type ReportingDate = ColumnType<string, string, string>;

export type MetricCurrencyBasis = 'none' | 'minor_units';
export type MetricFreshnessClass = 'F1' | 'F2' | 'F3';
export type MetricUnit = 'count' | 'hours' | 'ratio' | 'minor_units' | 'minutes';
export type MetricDefinitionStatus = 'active' | 'superseded';
export interface MetricDefinitionsTable {
  id: string;
  organization_id: string;
  metric_key: string;
  version: number;
  name: string;
  report_keys: string[];
  business_question: string;
  grain: string;
  numerator: string;
  denominator: string;
  time_basis: string;
  exclusions: string[];
  dimensions: string[];
  currency: MetricCurrencyBasis;
  freshness: MetricFreshnessClass;
  access_scope: string;
  unit: MetricUnit;
  requirement_ids: string[];
  pending_decisions: Generated<string[]>;
  definition_hash: string;
  status: Generated<MetricDefinitionStatus>;
  recorded_at: Timestamp;
  superseded_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PointInTimeSupport = 'full' | 'partial' | 'none';
export interface ReportRunsTable {
  id: string;
  organization_id: string;
  facility_id: string | null;
  report_key: string;
  parameters: Json<Record<string, unknown>>;
  reproducible_as_of: Timestamp;
  produced_at: Timestamp;
  point_in_time: PointInTimeSupport;
  access_action: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_account_id: string | null;
  requested_by_person_id: string | null;
  row_count: number;
  result: Json<Record<string, unknown>>;
  result_digest: string;
  reproduces_run_id: string | null;
  reproduction_matched: boolean | null;
  correlation_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ReportRunMetricsTable {
  organization_id: string;
  report_run_id: string;
  metric_definition_id: string;
}

export type ExportFormat = 'csv' | 'json';
export type ExportStatusValue = 'ready' | 'downloaded' | 'expired' | 'revoked';
export type ExportAuthorizedAction = 'reporting.export_operational' | 'reporting.export_financial';
export interface ExportsTable {
  id: string;
  organization_id: string;
  report_run_id: string;
  report_key: string;
  format: ExportFormat;
  authorized_action: ExportAuthorizedAction;
  requested_by: Json<Record<string, unknown>>;
  requested_by_account_id: string;
  requested_by_person_id: string | null;
  requested_at: Timestamp;
  expires_at: Timestamp;
  download_token_hash: string;
  row_count: number;
  content_digest: string;
  status: Generated<ExportStatusValue>;
  downloaded_at: NullableTimestamp;
  downloaded_by: Json<Record<string, unknown>> | null;
  expired_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revoke_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CostInputBasis = 'per_activity_hour';
export type CostInputStatus = 'active' | 'withdrawn';
export interface CostInputsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string | null;
  scope_id: GeneratedColumn<string>;
  basis: CostInputBasis;
  amount_minor: MinorUnits;
  currency: string;
  effective_from: ReportingDate;
  effective_to: ReportingDate | null;
  effective: GeneratedColumn<string>;
  description: string;
  approval_reference: string;
  approved_by: Json<Record<string, unknown>>;
  approved_by_person_id: string | null;
  recorded_at: Timestamp;
  status: Generated<CostInputStatus>;
  withdrawn_at: NullableTimestamp;
  withdrawn_by: Json<Record<string, unknown>> | null;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// Read-only views over other modules' records
// ---------------------------------------------------------------------------------------------

export interface ReportingPersonsView {
  person_id: V<string>;
  organization_id: V<string>;
  person_kind: V<'adult' | 'child'>;
  person_status: V<string>;
  canonical_person_id: V<string>;
}

export interface ReportingHouseholdMembersView {
  organization_id: V<string>;
  household_id: V<string>;
  person_id: V<string>;
}

export interface ReportingEventsView {
  event_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  kind: V<string>;
  title: V<string>;
  format: V<string | null>;
  status: V<'draft' | 'published' | 'canceled'>;
  scheduled_start: V<Date>;
  scheduled_end: V<Date>;
  setup_minutes: V<number>;
  cleanup_minutes: V<number>;
  timezone: V<string>;
  source_type: V<string | null>;
  source_id: V<string | null>;
  published_revision: V<number | null>;
  canceled_at: V<Date | null>;
  resource_count: V<number>;
}

export interface ReportingConflictUnitsView {
  conflict_unit_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  unit_name: V<string>;
}

export interface ReportingResourceUnitsView {
  resource_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_name: V<string>;
  resource_kind: V<string>;
  parent_resource_id: V<string | null>;
  resource_status: V<string>;
  conflict_unit_id: V<string>;
}

export interface ReportingOperatingHoursView {
  window_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_id: V<string | null>;
  weekday: V<number>;
  opens_at: V<string>;
  closes_at: V<string>;
}

export interface ReportingClosuresView {
  closure_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_id: V<string | null>;
  starts_at: V<Date>;
  ends_at: V<Date>;
  source: V<string>;
  status: V<'pending' | 'active' | 'lifted' | 'withdrawn'>;
  applied_at: V<Date | null>;
  lifted_at: V<Date | null>;
}

/**
 * A space's recorded status changes (migration 1302): the scheduling module's audit records of
 * `scheduling.resource_updated` that set a status, stamped with the injected clock. A space is
 * created active, so its status at an instant is the last change recorded by then.
 */
export interface ReportingResourceStatusChangesView {
  change_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_id: V<string>;
  status: V<string>;
  changed_at: V<Date>;
}

export interface ReportingReservedUnitsView {
  reservation_unit_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  conflict_unit_id: V<string>;
  reservation_id: V<string>;
  resource_id: V<string>;
  event_id: V<string>;
  event_kind: V<string>;
  event_format: V<string | null>;
  event_status: V<string>;
  source_type: V<string | null>;
  source_id: V<string | null>;
  occupied_start: V<Date>;
  occupied_end: V<Date>;
  scheduled_start: V<Date>;
  scheduled_end: V<Date>;
  setup_minutes: V<number>;
  cleanup_minutes: V<number>;
  reservation_status: V<'active' | 'released'>;
  released_at: V<Date | null>;
}

export interface ReportingOfferingsView {
  offering_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  program_id: V<string>;
  offering_name: V<string>;
  offering_kind: V<string>;
  format: V<string | null>;
  starts_on: V<string>;
  ends_on: V<string>;
  publication_state: V<string>;
  program_name: V<string | null>;
  program_format: V<string | null>;
  program_age_band: V<Record<string, unknown> | null>;
}

export interface ReportingSessionsView {
  session_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  facility_id: V<string>;
  offering_kind: V<string>;
  sequence: V<number>;
  scheduled_start: V<Date>;
  scheduled_end: V<Date>;
  scheduling_event_id: V<string | null>;
  status: V<'scheduled' | 'canceled' | 'completed'>;
}

export interface ReportingRequiredFormsView {
  organization_id: V<string>;
  offering_id: V<string>;
  policy_version_id: V<string>;
}

export interface ReportingAcknowledgmentsView {
  acknowledgment_id: V<string>;
  organization_id: V<string>;
  subject_person_id: V<string>;
  policy_version_id: V<string>;
  status: V<'active' | 'withdrawn'>;
  signed_at: V<Date>;
  withdrawn_at: V<Date | null>;
}

export interface ReportingEnrollmentsView {
  enrollment_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  participant_person_id: V<string>;
  canonical_person_id: V<string>;
  person_kind: V<'adult' | 'child'>;
  intent: V<string>;
  status: V<'pending' | 'confirmed' | 'canceled' | 'transferred' | 'completed'>;
  payer_person_id: V<string | null>;
  source_application_id: V<string | null>;
  confirmed_at: V<Date | null>;
  canceled_at: V<Date | null>;
  transferred_at: V<Date | null>;
  completed_at: V<Date | null>;
}

export interface ReportingSessionBookingsView {
  booking_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  session_id: V<string>;
  participant_person_id: V<string>;
  canonical_person_id: V<string>;
  person_kind: V<'adult' | 'child'>;
  kind: V<string>;
  status: V<'pending' | 'confirmed' | 'canceled' | 'expired'>;
  payer_person_id: V<string | null>;
  scheduled_start: V<Date>;
  scheduled_end: V<Date>;
  confirmed_at: V<Date | null>;
  canceled_at: V<Date | null>;
  expired_at: V<Date | null>;
}

export interface ReportingApplicationsView {
  application_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  intent: V<string>;
  status: V<string>;
  requires_approval: V<boolean>;
  submitted_at: V<Date | null>;
  decided_at: V<Date | null>;
  withdrawn_at: V<Date | null>;
}

export interface ReportingCapacityPoolsView {
  pool_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string | null>;
  scope_type: V<string>;
  unit: V<string>;
  constraint_kind: V<string>;
  capacity: V<number>;
  committed: V<number>;
  held: V<number>;
  status: V<'active' | 'closed'>;
}

export interface ReportingHoldsView {
  hold_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string | null>;
  status: V<'active' | 'committed' | 'released' | 'expired'>;
  quantity: V<number>;
  owner_kind: V<string>;
  acquired_at: V<Date>;
  committed_at: V<Date | null>;
  released_at: V<Date | null>;
  expired_at: V<Date | null>;
}

export interface ReportingWaitlistEntriesView {
  waitlist_entry_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  intent: V<string>;
  status: V<string>;
  joined_at: V<Date>;
  withdrawn_at: V<Date | null>;
  removed_at: V<Date | null>;
  accepted_enrollment_id: V<string | null>;
}

export interface ReportingWaitlistOffersView {
  waitlist_offer_id: V<string>;
  organization_id: V<string>;
  offering_id: V<string>;
  status: V<'offered' | 'accepted' | 'expired' | 'declined'>;
  offered_at: V<Date>;
  expires_at: V<Date>;
  accepted_at: V<Date | null>;
  declined_at: V<Date | null>;
  expired_at: V<Date | null>;
}

export interface ReportingSeasonsView {
  season_id: V<string>;
  organization_id: V<string>;
  competition_id: V<string>;
  season_name: V<string>;
  starts_on: V<string>;
  ends_on: V<string>;
  status: V<string>;
  registration_offering_ref: V<string | null>;
}

export interface ReportingTeamEntriesView {
  team_entry_id: V<string>;
  organization_id: V<string>;
  season_id: V<string>;
  division_id: V<string>;
  team_id: V<string>;
  facility_id: V<string | null>;
  status: V<'applied' | 'approved' | 'withdrawn' | 'rejected'>;
  approved_at: V<Date | null>;
  season_status: V<string>;
  season_starts_on: V<string>;
  season_ends_on: V<string>;
  roster_min: V<number | null>;
}

export interface ReportingRosterMembershipsView {
  roster_membership_id: V<string>;
  organization_id: V<string>;
  team_entry_id: V<string>;
  person_id: V<string>;
  canonical_person_id: V<string>;
  person_kind: V<'adult' | 'child'>;
  status: V<string>;
  effective_from: V<Date>;
  effective_to: V<Date | null>;
}

export interface ReportingFixturesView {
  fixture_id: V<string>;
  organization_id: V<string>;
  season_id: V<string>;
  division_id: V<string>;
  facility_id: V<string | null>;
  status: V<string>;
  scheduling_event_id: V<string | null>;
  scheduled_start: V<Date | null>;
  scheduled_end: V<Date | null>;
  home_entry_id: V<string>;
  away_entry_id: V<string>;
}

export interface ReportingAssignmentRequirementsView {
  requirement_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  target_type: V<'fixture' | 'event' | 'session'>;
  target_id: V<string>;
  kind: V<string>;
  role: V<string>;
  required_count: V<number>;
  must_be_accepted: V<boolean>;
  target_start: V<Date | null>;
  target_title: V<string | null>;
}

export interface ReportingAttendanceView {
  observation_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  person_id: V<string>;
  activity_type: V<'session' | 'event'>;
  activity_id: V<string>;
  offering_id: V<string | null>;
  scheduling_event_id: V<string | null>;
  observed_state: V<'present' | 'absent' | 'late' | 'left_early'>;
  observed_at: V<Date>;
  received_at: V<Date>;
  source: V<'online' | 'offline_sync'>;
  corrects_observation_id: V<string | null>;
  flags: V<string[]>;
}

export interface ReportingSessionCheckinsView {
  checkin_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  person_id: V<string>;
  activity_type: V<'session' | 'event'>;
  activity_id: V<string>;
  scheduling_event_id: V<string | null>;
  status: V<'held' | 'admitted' | 'withdrawn'>;
  checked_in_at: V<Date>;
  admitted_at: V<Date | null>;
  withdrawn_at: V<Date | null>;
}

export interface ReportingVisitsView {
  visit_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  visitor_category: V<string>;
  party_size: V<number>;
  status: V<'on_site' | 'departed' | 'voided'>;
  arrived_at: V<Date>;
  received_at: V<Date>;
  departed_at: V<Date | null>;
  voided_at: V<Date | null>;
}

export interface ReportingObligationsView {
  obligation_id: V<string>;
  organization_id: V<string>;
  debtor_kind: V<string>;
  mode: V<string>;
  source_kind: V<string>;
  amount_minor: V<number>;
  allocated_minor: V<number>;
  currency: V<string>;
  due_at: V<Date>;
  status: V<'open' | 'settled' | 'written_off' | 'canceled'>;
  settled_at: V<Date | null>;
  written_off_at: V<Date | null>;
  canceled_at: V<Date | null>;
}

export interface ReportingInstallmentsView {
  installment_id: V<string>;
  organization_id: V<string>;
  plan_id: V<string>;
  amount_minor: V<number>;
  currency: V<string>;
  due_at: V<Date>;
  status: V<'scheduled' | 'paid' | 'failed' | 'canceled'>;
  paid_at: V<Date | null>;
  failed_at: V<Date | null>;
  extension_count: V<number>;
}

export interface ReportingCreditsView {
  credit_id: V<string>;
  organization_id: V<string>;
  original_minor: V<number>;
  remaining_minor: V<number>;
  currency: V<string>;
  source_kind: V<string>;
  status: V<string>;
  expires_at: V<Date | null>;
}

export interface ReportingPaymentAttemptsView {
  payment_attempt_id: V<string>;
  organization_id: V<string>;
  purpose: V<string>;
  order_id: V<string | null>;
  amount_minor: V<number>;
  currency: V<string>;
  provider: V<string>;
  status: V<string>;
  processor_fee_minor: V<number | null>;
  submitted_at: V<Date | null>;
  unknown_since: V<Date | null>;
  resolved_at: V<Date | null>;
}

export interface ReportingRefundAttemptsView {
  refund_attempt_id: V<string>;
  organization_id: V<string>;
  payment_attempt_id: V<string>;
  order_id: V<string | null>;
  amount_minor: V<number>;
  currency: V<string>;
  purpose: V<string>;
  provider: V<string>;
  status: V<string>;
  reservation_status: V<string>;
  submitted_at: V<Date | null>;
  unknown_since: V<Date | null>;
  resolved_at: V<Date | null>;
}

export interface ReportingReceiptsView {
  receipt_id: V<string>;
  organization_id: V<string>;
  source_kind: V<string>;
  amount_minor: V<number>;
  excess_minor: V<number>;
  currency: V<string>;
  order_id: V<string | null>;
  received_at: V<Date>;
}

export interface ReportingSettlementsView {
  settlement_id: V<string>;
  organization_id: V<string>;
  kind: V<string>;
  provider: V<string | null>;
  facility_id: V<string | null>;
  period_start: V<Date>;
  period_end: V<Date>;
  currency: V<string>;
  expected_minor: V<number>;
  reported_minor: V<number>;
  difference_minor: V<number>;
  status: V<'balanced' | 'discrepancy'>;
  performed_at: V<Date>;
}

export interface ReportingOrderLinesView {
  order_line_id: V<string>;
  organization_id: V<string>;
  order_id: V<string>;
  offering_id: V<string>;
  enrollment_id: V<string | null>;
  participant_person_id: V<string>;
  total_minor: V<number>;
  currency: V<string>;
  payer_person_id: V<string>;
  payment_status: V<string>;
  fulfillment_status: V<string>;
  paid_at: V<Date | null>;
  fulfilled_at: V<Date | null>;
  canceled_at: V<Date | null>;
  facility_id: V<string>;
  offering_kind: V<string>;
  /** The order's total (migration 1302): MET-082 compares succeeded refunds with it. */
  order_total_minor: V<number>;
}

export interface ReportingRestrictionsView {
  restriction_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_id: V<string>;
  resource_name: V<string>;
  asset_id: V<string | null>;
  task_id: V<string | null>;
  preventive_schedule_id: V<string | null>;
  kind: V<'closed' | 'limited'>;
  starts_at: V<Date>;
  ends_at: V<Date>;
  status: V<'proposed' | 'approved' | 'active' | 'released'>;
  approved_at: V<Date | null>;
  released_at: V<Date | null>;
  affected_unit_count: V<number>;
  task_status: V<string | null>;
  task_resolved_at: V<Date | null>;
}

export interface ReportingMaintenanceTasksView {
  task_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string>;
  resource_id: V<string | null>;
  asset_id: V<string | null>;
  severity: V<'low' | 'medium' | 'high' | 'critical'>;
  status: V<'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed'>;
  requires_inspection: V<boolean>;
  reported_at: V<Date>;
  due_at: V<Date | null>;
  resolved_at: V<Date | null>;
  closed_at: V<Date | null>;
}

export interface ReportingNotificationsView {
  notification_id: V<string>;
  organization_id: V<string>;
  facility_id: V<string | null>;
  kind: V<string>;
  category: V<'operational' | 'promotional'>;
  protected: V<boolean>;
  status: V<string>;
  queued_at: V<Date | null>;
  dispatched_at: V<Date | null>;
  suppressed_at: V<Date | null>;
  suppression_reason: V<string | null>;
}

export interface ReportingDeliveryAttemptsView {
  delivery_attempt_id: V<string>;
  organization_id: V<string>;
  notification_id: V<string>;
  facility_id: V<string | null>;
  notification_kind: V<string>;
  category: V<'operational' | 'promotional'>;
  channel: V<string>;
  provider: V<string>;
  status: V<string>;
  queued_at: V<Date>;
  attempted_at: V<Date | null>;
  accepted_at: V<Date | null>;
  delivered_at: V<Date | null>;
  failed_at: V<Date | null>;
  failure_code: V<string | null>;
}

export interface ReportingNotificationRecipientsView {
  recipient_id: V<string>;
  organization_id: V<string>;
  notification_id: V<string>;
  status: V<'pending' | 'authorized' | 'revoked'>;
  revoked_at: V<Date | null>;
}

export interface ReportingTables {
  metric_definitions: MetricDefinitionsTable;
  report_runs: ReportRunsTable;
  report_run_metrics: ReportRunMetricsTable;
  exports: ExportsTable;
  cost_inputs: CostInputsTable;
  reporting_persons_v: ReportingPersonsView;
  reporting_household_members_v: ReportingHouseholdMembersView;
  reporting_events_v: ReportingEventsView;
  reporting_conflict_units_v: ReportingConflictUnitsView;
  reporting_resource_units_v: ReportingResourceUnitsView;
  reporting_operating_hours_v: ReportingOperatingHoursView;
  reporting_closures_v: ReportingClosuresView;
  reporting_resource_status_changes_v: ReportingResourceStatusChangesView;
  reporting_reserved_units_v: ReportingReservedUnitsView;
  reporting_offerings_v: ReportingOfferingsView;
  reporting_sessions_v: ReportingSessionsView;
  reporting_required_forms_v: ReportingRequiredFormsView;
  reporting_acknowledgments_v: ReportingAcknowledgmentsView;
  reporting_enrollments_v: ReportingEnrollmentsView;
  reporting_session_bookings_v: ReportingSessionBookingsView;
  reporting_applications_v: ReportingApplicationsView;
  reporting_capacity_pools_v: ReportingCapacityPoolsView;
  reporting_holds_v: ReportingHoldsView;
  reporting_waitlist_entries_v: ReportingWaitlistEntriesView;
  reporting_waitlist_offers_v: ReportingWaitlistOffersView;
  reporting_seasons_v: ReportingSeasonsView;
  reporting_team_entries_v: ReportingTeamEntriesView;
  reporting_roster_memberships_v: ReportingRosterMembershipsView;
  reporting_fixtures_v: ReportingFixturesView;
  reporting_assignment_requirements_v: ReportingAssignmentRequirementsView;
  reporting_attendance_v: ReportingAttendanceView;
  reporting_session_checkins_v: ReportingSessionCheckinsView;
  reporting_visits_v: ReportingVisitsView;
  reporting_obligations_v: ReportingObligationsView;
  reporting_installments_v: ReportingInstallmentsView;
  reporting_credits_v: ReportingCreditsView;
  reporting_payment_attempts_v: ReportingPaymentAttemptsView;
  reporting_refund_attempts_v: ReportingRefundAttemptsView;
  reporting_receipts_v: ReportingReceiptsView;
  reporting_settlements_v: ReportingSettlementsView;
  reporting_order_lines_v: ReportingOrderLinesView;
  reporting_restrictions_v: ReportingRestrictionsView;
  reporting_maintenance_tasks_v: ReportingMaintenanceTasksView;
  reporting_notifications_v: ReportingNotificationsView;
  reporting_delivery_attempts_v: ReportingDeliveryAttemptsView;
  reporting_notification_recipients_v: ReportingNotificationRecipientsView;
}
