import {
  AssignmentEngagementSchema,
  AssignmentKindSchema,
  AssignmentStatusSchema,
  AssignmentTargetTypeSchema,
  AvailabilityKindSchema,
  defineEvent,
  FeeSubmissionStatusSchema,
  QualificationStatusSchema,
  z,
} from '@sportspark/contracts';

/**
 * Workforce domain events (§4.12). Payloads carry identifiers and scheduling facts only; names,
 * contacts and fee notes never travel in events.
 */
export const WorkforceEvents = {
  /** Every assignment transition (communications notifies the assignee of offers and changes). */
  assignmentChanged: defineEvent(
    'workforce.assignment_changed',
    z.object({
      assignmentId: z.uuid(),
      personId: z.uuid(),
      kind: AssignmentKindSchema,
      targetType: AssignmentTargetTypeSchema,
      targetId: z.uuid(),
      facilityId: z.uuid(),
      role: z.string(),
      slot: z.number().int(),
      engagement: AssignmentEngagementSchema,
      status: AssignmentStatusSchema,
      previousStatus: AssignmentStatusSchema.nullable(),
      scheduledStart: z.iso.datetime(),
      scheduledEnd: z.iso.datetime(),
      replacesAssignmentId: z.uuid().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  /** A required slot became uncovered inside the escalation window (SPK-STAFF-003, SPK-AT-012). */
  assignmentUncovered: defineEvent(
    'workforce.assignment_uncovered',
    z.object({
      assignmentId: z.uuid(),
      targetType: AssignmentTargetTypeSchema,
      targetId: z.uuid(),
      facilityId: z.uuid(),
      role: z.string(),
      slot: z.number().int(),
      startsAt: z.iso.datetime(),
      cause: z.enum(['declined', 'withdrawn', 'schedule_conflict']),
      exceptionId: z.uuid(),
    }),
  ),
  /** Time-bounded access granted, failed or ended for temporary or substitute work (SPK-STAFF-004). */
  temporaryAccessChanged: defineEvent(
    'workforce.temporary_access_changed',
    z.object({
      assignmentId: z.uuid(),
      personId: z.uuid(),
      status: z.enum(['granted', 'failed', 'ended']),
      staffMembershipId: z.uuid().nullable(),
      from: z.iso.datetime().nullable(),
      until: z.iso.datetime().nullable(),
    }),
  ),
  availabilityChanged: defineEvent(
    'workforce.availability_changed',
    z.object({
      availabilityId: z.uuid(),
      personId: z.uuid(),
      kind: AvailabilityKindSchema,
      status: z.enum(['active', 'withdrawn']),
      start: z.iso.datetime(),
      end: z.iso.datetime(),
    }),
  ),
  qualificationChanged: defineEvent(
    'workforce.qualification_changed',
    z.object({
      qualificationId: z.uuid(),
      personId: z.uuid(),
      kind: z.string(),
      status: QualificationStatusSchema,
    }),
  ),
  requirementChanged: defineEvent(
    'workforce.requirement_changed',
    z.object({
      requirementId: z.uuid(),
      targetType: AssignmentTargetTypeSchema,
      targetId: z.uuid(),
      role: z.string(),
      requiredCount: z.number().int(),
      mustBeAccepted: z.boolean(),
      /** WRK-02: set when the requirement was retired (it then never counts again). */
      retiredAt: z.iso.datetime().nullable().optional(),
    }),
  ),
  feeSubmitted: defineEvent(
    'workforce.fee_submitted',
    z.object({
      feeSubmissionId: z.uuid(),
      assignmentId: z.uuid(),
      personId: z.uuid(),
      submittedAmountMinor: z.number().int(),
      currency: z.string(),
    }),
  ),
  feeDecided: defineEvent(
    'workforce.fee_decided',
    z.object({
      feeSubmissionId: z.uuid(),
      assignmentId: z.uuid(),
      status: FeeSubmissionStatusSchema,
      approvedAmountMinor: z.number().int().nullable(),
      currency: z.string(),
      adjustmentSequence: z.number().int().nullable(),
    }),
  ),
  /** Approved fees handed to payment administration; nothing is paid by this platform (§1.7). */
  feesExported: defineEvent(
    'workforce.fees_exported',
    z.object({
      batchId: z.uuid(),
      currency: z.string(),
      submissionIds: z.array(z.uuid()),
      totalMinor: z.number().int(),
    }),
  ),
};
