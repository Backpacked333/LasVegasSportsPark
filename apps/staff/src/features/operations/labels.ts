/**
 * Staff-visible status labels for the operations records, from docs/package-a/journeys.md section
 * 3 (staff labels use the machine state names). Every label is paired with a glyph by StatusBadge,
 * so a status is never conveyed by colour alone (SPK-UX-009). The five entry records stay apart:
 * "Arrived", "Checked in to <session>", "Attended", "Departed", "Released to <person>"
 * (SPK-ENTRY-001).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export interface Badge {
  tone: StatusTone;
  label: string;
}

export const OBSERVED_STATE: Record<Schema<'ObservedState'>, Badge> = {
  present: { tone: 'success', label: 'Present' },
  late: { tone: 'warning', label: 'Late' },
  left_early: { tone: 'warning', label: 'Left early' },
  absent: { tone: 'neutral', label: 'Absent' },
};

export const OBSERVED_STATES = ['present', 'late', 'left_early', 'absent'] as const;

export const CHECKIN_STATUS: Record<Schema<'SessionCheckin'>['status'], Badge> = {
  admitted: { tone: 'success', label: 'Checked in' },
  held: { tone: 'warning', label: 'Check-in held' },
  withdrawn: { tone: 'neutral', label: 'Check-in withdrawn' },
};

export const ISSUE_SEVERITY: Record<Schema<'ArrivalIssue'>['severity'], Badge> = {
  blocking: { tone: 'danger', label: 'Blocking' },
  warning: { tone: 'warning', label: 'Warning' },
  info: { tone: 'info', label: 'Information' },
};

/** Staff see all six assignment states, including "Proposed" (SPK-STAFF-002). */
export const ASSIGNMENT_STATUS: Record<Schema<'AssignmentStatus'>, Badge> = {
  proposed: { tone: 'info', label: 'Proposed (not covering)' },
  offered: { tone: 'pending', label: 'Offered (not covering)' },
  accepted: { tone: 'success', label: 'Accepted' },
  declined: { tone: 'neutral', label: 'Declined' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
  completed: { tone: 'success', label: 'Completed' },
};

/** "Paid" is never used: fee records support payment administration only (§1.7, SPK-STAFF-006). */
export const FEE_STATUS: Record<Schema<'FeeSubmissionStatus'>, Badge> = {
  submitted: { tone: 'pending', label: 'Submitted' },
  approved: { tone: 'success', label: 'Approved' },
  adjusted: { tone: 'success', label: 'Approved with adjustment' },
  rejected: { tone: 'danger', label: 'Rejected' },
  exported: { tone: 'info', label: 'Exported' },
};

export const QUALIFICATION_STATUS: Record<Schema<'QualificationStatus'>, Badge> = {
  pending_verification: { tone: 'pending', label: 'Awaiting verification' },
  verified: { tone: 'success', label: 'Verified' },
  rejected: { tone: 'danger', label: 'Rejected' },
  revoked: { tone: 'neutral', label: 'Revoked' },
};

export const AVAILABILITY_KIND: Record<Schema<'AvailabilityKind'>, Badge> = {
  available: { tone: 'success', label: 'Available' },
  unavailable: { tone: 'warning', label: 'Unavailable' },
};

/** SPK-COMMS-004: the exact delivery states; push is never presented as guaranteed delivery. */
export const DELIVERY_STATUS: Record<Schema<'DeliveryStatus'>, Badge> = {
  queued: { tone: 'pending', label: 'Queued' },
  provider_accepted: { tone: 'info', label: 'Provider accepted' },
  delivered: { tone: 'success', label: 'Delivered (confirmed)' },
  failed: { tone: 'danger', label: 'Failed' },
  unknown: { tone: 'warning', label: 'Unknown' },
  read: { tone: 'success', label: 'Read' },
  acknowledged: { tone: 'success', label: 'Acknowledged' },
};

export const DELIVERY_STATES = [
  'queued',
  'provider_accepted',
  'delivered',
  'failed',
  'unknown',
  'read',
  'acknowledged',
] as const;

export const RECIPIENT_STATUS: Record<Schema<'RecipientStatus'>, Badge> = {
  pending: { tone: 'pending', label: 'Recipient pending' },
  authorized: { tone: 'success', label: 'Recipient authorized' },
  revoked: { tone: 'neutral', label: 'Recipient revoked' },
};

export const NOTIFICATION_STATUS: Record<Schema<'NotificationStatus'>, Badge> = {
  composed: { tone: 'info', label: 'Composed (not sent)' },
  queued: { tone: 'pending', label: 'Queued' },
  dispatched: { tone: 'success', label: 'Dispatched' },
  suppressed: { tone: 'neutral', label: 'Suppressed' },
};

export const SUPPRESSION_REASON: Record<NonNullable<Schema<'SuppressionReason'>>, string> = {
  obsolete: 'obsolete: a newer notice about the same subject replaced it',
  no_recipients: 'no recipients: nobody currently holds permission to receive it',
  authority_revoked: 'authority revoked: recipients lost access before dispatch',
};

export const CHANNEL_LABEL: Record<Schema<'DeliveryChannel'>, string> = {
  in_app: 'In-app',
  push: 'Push',
  email: 'Email',
  sms: 'SMS',
};

export const RECIPIENT_BASIS: Record<Schema<'RecipientBasis'>, string> = {
  self: 'the person themself',
  receive_messages: 'holds receive messages',
  staff_role: 'staff role',
  team_member: 'team member',
  explicit: 'named directly',
};

export const VERIFICATION_OUTCOME: Record<Schema<'ReleaseRecord'>['verificationOutcome'], Badge> = {
  verified: { tone: 'success', label: 'Pickup authority verified' },
  denied: { tone: 'danger', label: 'Release denied: not authorised to collect' },
  escalated: { tone: 'warning', label: 'Escalated under the pickup procedure' },
  manual_outage_procedure: { tone: 'warning', label: 'Manual outage procedure' },
};

export const VISITOR_CATEGORY_LABEL: Record<
  Exclude<Schema<'VisitorCategory'>, 'unclassified'>,
  string
> = {
  participant: 'Participant',
  guardian: 'Guardian',
  spectator: 'Spectator',
  staff: 'Staff',
  contractor: 'Contractor',
};

/** SPK-YOUTH-005 assessment review states (ENR-14 AssessmentMachine). */
export const ASSESSMENT_STATUS: Record<Schema<'AssessmentStatus'>, Badge> = {
  draft: { tone: 'neutral', label: 'Draft' },
  submitted: { tone: 'pending', label: 'Submitted for review' },
  returned: { tone: 'warning', label: 'Returned for changes' },
  published: { tone: 'success', label: 'Published to the family' },
  recorded: { tone: 'info', label: 'Recorded (staff only)' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
};

/** SPK-YOUTH-005: private coaching notes and family-visible feedback stay separate. */
export const ASSESSMENT_VISIBILITY: Record<Schema<'AssessmentVisibility'>, string> = {
  staff_only: 'Staff only',
  family: 'Family-visible feedback once approved',
};

/** SPK-YOUTH-006 recommendation states (ENR-14 ProgressionRecommendationMachine). */
export const RECOMMENDATION_STATUS: Record<Schema<'ProgressionRecommendation'>['status'], Badge> = {
  draft: { tone: 'neutral', label: 'Draft (not shared)' },
  shared: { tone: 'success', label: 'Shared with the family' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
};

export const TEMPLATE_STATUS: Record<Schema<'AssessmentTemplate'>['status'], Badge> = {
  draft: { tone: 'neutral', label: 'Draft template' },
  approved: { tone: 'success', label: 'Approved template' },
  retired: { tone: 'neutral', label: 'Retired template' },
};
