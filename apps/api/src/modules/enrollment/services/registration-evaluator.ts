import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type EligibilityResult,
  type OfferingSession,
  type PolicyReferences,
  type PolicyVersion,
  type PriceSnapshot,
  type RegistrationIntent,
} from '@sportspark/contracts';
import { CLOCK, type Clock, type Trx } from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  PRICING_PORT,
  equivalenceKey,
  periodKeyForDates,
  type OfferingLookupPort,
  type OfferingSnapshot,
  type PolicyPort,
  type PricingPort,
} from '../../catalog';
import {
  ELIGIBILITY_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type EligibilityPort,
  type TeamEntryQueryPort,
} from '../../competition';
import {
  PERSON_DIRECTORY_PORT,
  type PersonDirectoryPort,
  type PersonSummary,
} from '../../identity';
import { ENROLLMENT_POLICY, requiresApproval, type EnrollmentPolicy } from '../enrollment.policy';
import {
  evaluateRegistrationEligibility,
  type EligibilityInput,
} from '../eligibility/registration-eligibility';

type EligibilityInputTeam = EligibilityInput['teamEligibility'];

export interface EvaluationContext {
  snapshot: OfferingSnapshot;
  person: PersonSummary;
  intent: RegistrationIntent;
  teamEntryId?: string | null;
  session?: OfferingSession | null;
}

export interface Evaluation {
  result: EligibilityResult;
  requiresApproval: boolean;
  approvalPolicy: PolicyVersion | null;
  missingFormIds: string[];
}

/**
 * Gathers the catalog, identity and competition facts a registration decision needs and runs the
 * pure eligibility evaluation (SPK-REG-002). Every read goes through the other module's port with
 * the caller's transaction so a command sees one consistent snapshot (§4.2).
 */
@Injectable()
export class RegistrationEvaluator {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly teamEntries: TeamEntryQueryPort,
    @Inject(ELIGIBILITY_PORT) private readonly teamEligibility: EligibilityPort,
    @Inject(ENROLLMENT_POLICY) private readonly policy: EnrollmentPolicy,
  ) {}

  async snapshot(
    trx: Trx | undefined,
    organizationId: string,
    offeringId: string,
    at: Date = this.clock.now(),
  ): Promise<OfferingSnapshot> {
    const snapshot = await this.offerings.getOffering(organizationId, offeringId, at, trx);
    if (!snapshot) throw errors.notFound('offering', offeringId);
    return snapshot;
  }

  /** The participant; merged persons resolve to their survivor so an old id never splits a household's records. */
  async participant(
    trx: Trx | undefined,
    organizationId: string,
    personId: string,
  ): Promise<PersonSummary> {
    const canonical = await this.persons.resolveCanonicalPersonId(organizationId, personId, trx);
    const person = await this.persons.findPerson(organizationId, canonical, trx);
    if (!person) throw errors.notFound('person', personId);
    return person;
  }

  async participantOrNull(
    trx: Trx | undefined,
    organizationId: string,
    personId: string,
  ): Promise<PersonSummary | null> {
    const canonical = await this.persons.resolveCanonicalPersonId(organizationId, personId, trx);
    return this.persons.findPerson(organizationId, canonical, trx);
  }

  async evaluate(
    trx: Trx | undefined,
    organizationId: string,
    ctx: EvaluationContext,
    at: Date = this.clock.now(),
  ): Promise<Evaluation> {
    const { snapshot, person } = ctx;
    const acknowledged: string[] = [];
    for (const form of snapshot.requiredForms) {
      if (await this.policies.hasAcknowledgment(organizationId, person.id, form.id, trx)) {
        acknowledged.push(form.id);
      }
    }
    let teamEntry: { id: string; status: string } | null | undefined;
    let teamEligibility: EligibilityInputTeam = null;
    if (ctx.intent === 'join_team') {
      teamEntry = ctx.teamEntryId
        ? await this.teamEntries.findTeamEntry(organizationId, ctx.teamEntryId, trx)
        : null;
      if (teamEntry && ['applied', 'approved'].includes(teamEntry.status)) {
        // SPK-AT-002, SPK-CAP-004: the competition rules decide whether this person may join this
        // entry (the same evaluation its roster commands run), before any quote or payment.
        // Reasons reach the registrant, so they are restricted (codes and limits only).
        const evaluation = await this.teamEligibility.evaluatePlayer(
          organizationId,
          teamEntry.id,
          person.id,
          at,
          { membershipStatus: 'active', actorIsStaff: false, restricted: true },
          trx,
        );
        teamEligibility = { reasons: evaluation.reasons };
      }
    }
    const result = evaluateRegistrationEligibility({
      intent: ctx.intent,
      at,
      offering: {
        id: snapshot.offering.id,
        kind: snapshot.offering.kind,
        publicationState: snapshot.offering.publicationState,
        ageBand: snapshot.offering.ageBand,
        startsOn: snapshot.offering.startsOn,
        endsOn: snapshot.offering.endsOn,
      },
      registrationOpen: snapshot.registrationOpen,
      eligibilityReferenceDate: snapshot.eligibilityReferenceDate,
      eligibilityPolicy: snapshot.eligibilityPolicy,
      requiredForms: snapshot.requiredForms,
      acknowledgedFormIds: acknowledged,
      person: {
        id: person.id,
        kind: person.kind,
        status: person.status,
        dateOfBirth: person.dateOfBirth,
      },
      teamEntry,
      teamEligibility,
      session:
        ctx.session === undefined
          ? undefined
          : ctx.session
            ? {
                id: ctx.session.id,
                status: ctx.session.status,
                scheduledStart: new Date(ctx.session.scheduledStart),
              }
            : null,
    });
    const approvalPolicy = await this.policies.currentPolicyVersion(
      organizationId,
      'approval',
      this.policy.approvalPolicyKey,
      at,
      trx,
    );
    return {
      result,
      requiresApproval: requiresApproval(
        this.policy,
        ctx.intent,
        { id: snapshot.offering.id, kind: snapshot.offering.kind },
        snapshot.eligibilityPolicy,
        approvalPolicy,
      ),
      approvalPolicy,
      missingFormIds: snapshot.requiredForms
        .map((f) => f.id)
        .filter((id) => !acknowledged.includes(id)),
    };
  }

  /** The price basis of a line, from the catalog pricing port at the instant (SPK-PAY-001). */
  async priceSnapshot(
    trx: Trx | undefined,
    organizationId: string,
    offeringId: string,
    at: Date = this.clock.now(),
  ): Promise<PriceSnapshot | null> {
    const rule = await this.pricing.effectivePriceRule(organizationId, offeringId, at, trx);
    if (!rule) return null;
    return {
      priceRuleId: rule.id,
      basePriceMinor: rule.basePriceMinor,
      currency: rule.currency,
      chargeLines: rule.chargeLines,
    };
  }

  policyReferences(
    snapshot: OfferingSnapshot,
    approvalPolicy: PolicyVersion | null,
  ): PolicyReferences {
    return {
      eligibilityPolicyVersionId: snapshot.eligibilityPolicy?.id ?? null,
      cancellationPolicyVersionId: snapshot.cancellationPolicy?.id ?? null,
      requiredFormPolicyVersionIds: snapshot.requiredForms.map((f) => f.id),
      approvalPolicyVersionId: approvalPolicy?.id ?? null,
    };
  }

  /** §4.7 invariant 2 key from the entitlement definition's equivalence scope. */
  equivalence(
    snapshot: OfferingSnapshot,
    participantPersonId: string,
    sessionId: string | null = null,
  ): string | null {
    const definition = snapshot.entitlementDefinition;
    if (!definition) return null;
    if (definition.equivalenceScope === 'session' && !sessionId) return null;
    return equivalenceKey(
      {
        kind: definition.kind,
        equivalenceScope: definition.equivalenceScope,
        equivalenceRule: definition.equivalenceRule,
      },
      {
        offeringId: snapshot.offering.id,
        programId: snapshot.offering.programId,
        participantPersonId,
        sessionId,
        periodKey: periodKeyForDates(snapshot.offering.startsOn, snapshot.offering.endsOn),
      },
    );
  }

  get configuration(): EnrollmentPolicy {
    return this.policy;
  }
}
