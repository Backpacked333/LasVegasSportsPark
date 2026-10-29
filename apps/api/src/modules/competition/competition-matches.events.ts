import {
  AppealStatusSchema,
  defineEvent,
  DisputeStatusSchema,
  ResultClassificationSchema,
  ResultStatusSchema,
  SolverOutcomeSchema,
  SuspensionStatusSchema,
  z,
} from '@sportspark/contracts';

/**
 * Competition domain events, part 2 (§4.12). Payloads carry identifiers only: no names, scores
 * are facts of the result record, and incident narratives never travel in an event (SPK-DISC-004).
 */
export const MatchEvents = {
  resultSubmitted: defineEvent(
    'competition.result_submitted',
    z.object({
      resultRevisionId: z.uuid(),
      fixtureId: z.uuid(),
      seasonId: z.uuid(),
      revisionNo: z.number().int(),
      classification: ResultClassificationSchema,
      isCorrection: z.boolean(),
    }),
  ),
  resultReturned: defineEvent(
    'competition.result_returned',
    z.object({ resultRevisionId: z.uuid(), fixtureId: z.uuid(), reason: z.string() }),
  ),
  /** The result is official; standings were recomputed in the same transaction (SPK-RESULT-001). */
  resultPublished: defineEvent(
    'competition.result_published',
    z.object({
      resultRevisionId: z.uuid(),
      fixtureId: z.uuid(),
      seasonId: z.uuid(),
      divisionId: z.uuid().nullable(),
      status: ResultStatusSchema,
      classification: ResultClassificationSchema,
      supersededRevisionId: z.uuid().nullable(),
      standingsProjectionId: z.uuid().nullable(),
      /** Set when the correction was published by a management review decision (SPK-RESULT-004). */
      reviewExceptionId: z.uuid().nullable(),
      /** Published bracket nodes and played games the reviewed correction affects; not rewritten. */
      affectedBracketNodeIds: z.array(z.uuid()),
      affectedFixtureIds: z.array(z.uuid()),
      operationId: z.uuid(),
    }),
  ),
  /** A correction could not be published silently (SPK-RESULT-004, SPK-AT-014). */
  resultCorrectionReviewRequired: defineEvent(
    'competition.result_correction_review_required',
    z.object({
      resultRevisionId: z.uuid(),
      fixtureId: z.uuid(),
      officialRevisionId: z.uuid(),
      exceptionId: z.uuid(),
      affectedBracketNodeIds: z.array(z.uuid()),
      affectedFixtureIds: z.array(z.uuid()),
    }),
  ),
  standingsRecomputed: defineEvent(
    'competition.standings_recomputed',
    z.object({
      standingsProjectionId: z.uuid(),
      seasonId: z.uuid(),
      divisionId: z.uuid().nullable(),
      ruleSetId: z.uuid(),
      sourceResultCount: z.number().int(),
    }),
  ),
  bracketNodeCreated: defineEvent(
    'competition.bracket_node_created',
    z.object({ bracketNodeId: z.uuid(), seasonId: z.uuid(), round: z.number().int() }),
  ),
  bracketNodePublished: defineEvent(
    'competition.bracket_node_published',
    z.object({ bracketNodeId: z.uuid(), seasonId: z.uuid(), fixtureId: z.uuid().nullable() }),
  ),
  /** CMP-10 / CMP-15: an unpublished node's slots were seeded from final standings. */
  bracketSeeded: defineEvent(
    'competition.bracket_seeded',
    z.object({
      bracketNodeId: z.uuid(),
      seasonId: z.uuid(),
      seeds: z.array(
        z.object({
          slot: z.enum(['home', 'away']),
          teamEntryId: z.uuid(),
          rank: z.number().int(),
          divisionId: z.uuid().nullable(),
          poolId: z.uuid().nullable(),
        }),
      ),
    }),
  ),
  /** CMP-15: a tournament pool was created or its entries changed. */
  poolChanged: defineEvent(
    'competition.pool_changed',
    z.object({
      poolId: z.uuid(),
      seasonId: z.uuid(),
      divisionId: z.uuid(),
      change: z.enum(['created', 'entry_added', 'entry_removed']),
      teamEntryId: z.uuid().nullable(),
      revision: z.number().int(),
    }),
  ),
  fixtureSpecificationCreated: defineEvent(
    'competition.fixture_specification_created',
    z.object({ specificationId: z.uuid(), seasonId: z.uuid(), divisionId: z.uuid() }),
  ),
  /** The solver finished; the proposal (if any) is a scheduling draft, never published here (SPK-FIX-005). */
  fixturesGenerated: defineEvent(
    'competition.fixtures_generated',
    z.object({
      solverRunId: z.uuid(),
      specificationId: z.uuid(),
      seasonId: z.uuid(),
      divisionId: z.uuid(),
      outcome: SolverOutcomeSchema,
      fixtureIds: z.array(z.uuid()),
      scheduleDraftId: z.uuid().nullable(),
      complete: z.boolean(),
      operationId: z.uuid(),
    }),
  ),
  disputeSubmitted: defineEvent(
    'competition.dispute_submitted',
    z.object({
      disputeId: z.uuid(),
      fixtureId: z.uuid(),
      resultRevisionId: z.uuid().nullable(),
      submittingTeamEntryId: z.uuid().nullable(),
    }),
  ),
  disputeChanged: defineEvent(
    'competition.dispute_changed',
    z.object({
      disputeId: z.uuid(),
      fixtureId: z.uuid(),
      status: DisputeStatusSchema,
      decision: z.string().nullable(),
      publicationConsequence: z.string().nullable(),
    }),
  ),
  incidentReported: defineEvent(
    'competition.incident_reported',
    z.object({
      incidentId: z.uuid(),
      kind: z.string(),
      severity: z.string(),
      fixtureId: z.uuid().nullable(),
      subjectPersonId: z.uuid().nullable(),
    }),
  ),
  incidentChanged: defineEvent(
    'competition.incident_changed',
    z.object({ incidentId: z.uuid(), status: z.string() }),
  ),
  disciplinaryDecisionIssued: defineEvent(
    'competition.disciplinary_decision_issued',
    z.object({
      decisionId: z.uuid(),
      subjectPersonId: z.uuid(),
      decision: z.string(),
      suspensionId: z.uuid().nullable(),
    }),
  ),
  disciplinaryDecisionOverturned: defineEvent(
    'competition.disciplinary_decision_overturned',
    z.object({ decisionId: z.uuid(), subjectPersonId: z.uuid() }),
  ),
  /** Eligibility and readiness re-evaluate (SPK-AT-013). */
  suspensionChanged: defineEvent(
    'competition.suspension_changed',
    z.object({
      suspensionId: z.uuid(),
      subjectPersonId: z.uuid(),
      status: SuspensionStatusSchema,
      previousStatus: SuspensionStatusSchema.nullable(),
      matchesServed: z.number().int(),
      servedFixtureId: z.uuid().nullable(),
    }),
  ),
  appealSubmitted: defineEvent(
    'competition.appeal_submitted',
    z.object({
      appealId: z.uuid(),
      subjectPersonId: z.uuid(),
      decisionId: z.uuid().nullable(),
      suspensionId: z.uuid().nullable(),
      disputeId: z.uuid().nullable(),
    }),
  ),
  appealChanged: defineEvent(
    'competition.appeal_changed',
    z.object({ appealId: z.uuid(), subjectPersonId: z.uuid(), status: AppealStatusSchema }),
  ),
} as const;
