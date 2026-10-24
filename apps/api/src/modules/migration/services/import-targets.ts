import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type Credit,
  type GrantPermissionValue,
  type Household,
  type Obligation,
  type PersonDetail,
  type Principal,
  type Program,
} from '@sportspark/contracts';
import type { Db, MappedEntityType } from '@sportspark/db';
import { DATABASE, type Trx } from '../../../kernel';
import { CreditsService, FinanceActions, ObligationsService } from '../../finance';
import { ProgramsService } from '../../catalog';
import {
  HouseholdsService,
  IdentityActions,
  PeopleService,
  RelationshipsService,
  type PersonSummary,
} from '../../identity';
import type { Reader } from '../migration.shared';

/** What the owning module is told about one imported record. */
export interface TargetContext {
  organizationId: string;
  /** System principal labelled with the batch (`migration.import:<batchId>`). */
  principal: Principal;
  /** `migration:<mappingId>`: written on the owning module's audit record of the creation. */
  correlationId: string;
  /** Recorded as the reason on every owning-module command that accepts one (§4.9). */
  reason: string;
}

export interface PersonValues {
  kind: 'adult' | 'child';
  givenName: string;
  familyName: string;
  dateOfBirth?: string;
  email?: string;
  phone?: string;
  status?: 'active' | 'inactive';
}

export interface ProgramValues {
  name: string;
  description?: string;
  activityType: string;
  format?: string;
  status?: 'draft' | 'active';
}

/** Compares contact values the way identity stores them (lower-case email, phone without separators). */
function contactKey(kind: 'email' | 'phone', value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, '');
}

/** Whether a sync changed the internal record. */
export type SyncResult = 'updated' | 'unchanged';

/**
 * The calls this module makes into the owning modules (§4.2: a module never writes another
 * module's tables). Every creation goes through the owning module's public command with the
 * import system principal, a reason naming the batch, and a correlation id unique to the mapping.
 * None of these commands executes a payment or sends a notification: persons, households,
 * relationships and programs only record facts; obligations and credits are opening balances
 * posted to the subledger without any payment attempt or notice (§5.4).
 *
 * Commands that open their own unit of work are called outside any migration transaction (under
 * PGlite a nested connection would deadlock and on PostgreSQL it would not be atomic anyway); a
 * creation that committed before the mapping could be linked is found again through the owning
 * module's audit record of that correlation id (`recover`), so an interrupted apply never creates
 * the same record twice. Relationships go through identity's transactional `ensureAuthority`
 * inside the migration transaction, so they are linked atomically.
 */
@Injectable()
export class ImportTargets {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly people: PeopleService,
    private readonly households: HouseholdsService,
    private readonly relationships: RelationshipsService,
    private readonly programs: ProgramsService,
    private readonly obligations: ObligationsService,
    private readonly credits: CreditsService,
  ) {}

  /** The audit action and target the owning module records for each creation. */
  private static readonly CREATION_AUDIT: Record<
    Exclude<MappedEntityType, 'relationship_evidence'>,
    { action: string; targetType: string }
  > = {
    person: { action: IdentityActions.createPerson.id, targetType: 'person' },
    household: { action: IdentityActions.createHousehold.id, targetType: 'household' },
    program: { action: 'catalog.program_created', targetType: 'program' },
    open_obligation: { action: FinanceActions.manageObligations.id, targetType: 'obligation' },
    credit: { action: FinanceActions.issueCredit.id, targetType: 'credit' },
  };

  /**
   * Finds a record an earlier, interrupted apply created for this correlation id: the owning
   * module wrote its audit record in the same transaction as the record, so its absence proves
   * the creation never committed.
   */
  async recover(
    organizationId: string,
    entityType: Exclude<MappedEntityType, 'relationship_evidence'>,
    correlationId: string,
  ): Promise<string | null> {
    const anchor = ImportTargets.CREATION_AUDIT[entityType];
    const row = await this.db
      .selectFrom('audit_records')
      .select('target_id')
      .where('organization_id', '=', organizationId)
      .where('correlation_id', '=', correlationId)
      .where('action', '=', anchor.action)
      .where('target_type', '=', anchor.targetType)
      .orderBy('occurred_at')
      .executeTakeFirst();
    return row?.target_id ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Persons (identity)
  // -------------------------------------------------------------------------------------------

  async createPerson(ctx: TargetContext, values: PersonValues): Promise<string> {
    const contactPoints: Array<{
      kind: 'email' | 'phone';
      value: string;
      isPrimary: boolean;
      verified: boolean;
    }> = [];
    // Contact values are imported unverified: they are never keys and never logins (§5.3).
    if (values.email) {
      contactPoints.push({ kind: 'email', value: values.email, isPrimary: true, verified: false });
    }
    if (values.phone) {
      contactPoints.push({ kind: 'phone', value: values.phone, isPrimary: true, verified: false });
    }
    const person = await this.people.createPerson(
      ctx.principal,
      {
        kind: values.kind,
        givenName: values.givenName,
        familyName: values.familyName,
        dateOfBirth: values.dateOfBirth,
        contactPoints,
      },
      ctx.correlationId,
    );
    return person.id;
  }

  /** Brings the person to the staged values (only fields the source states; never removes). */
  async syncPerson(
    ctx: TargetContext,
    personId: string,
    values: PersonValues,
  ): Promise<SyncResult> {
    const current: PersonDetail = await this.people.getPerson(ctx.principal, personId);
    const changes: {
      givenName?: string;
      familyName?: string;
      dateOfBirth?: string;
      status?: 'active' | 'inactive';
    } = {};
    if (current.givenName !== values.givenName) changes.givenName = values.givenName;
    if (current.familyName !== values.familyName) changes.familyName = values.familyName;
    if (values.dateOfBirth && current.dateOfBirth !== values.dateOfBirth) {
      changes.dateOfBirth = values.dateOfBirth;
    }
    const status = values.status ?? 'active';
    if (current.status !== 'merged' && current.status !== status) changes.status = status;
    let changed = false;
    if (Object.keys(changes).length > 0) {
      await this.people.updatePerson(
        ctx.principal,
        personId,
        { ...changes, expectedRevision: current.revision, reason: ctx.reason },
        ctx.correlationId,
      );
      changed = true;
    }
    const held = new Set(
      current.contactPoints.map((c) => `${c.kind}:${contactKey(c.kind, c.value)}`),
    );
    const wanted: Array<{ kind: 'email' | 'phone'; value: string }> = [];
    if (values.email) wanted.push({ kind: 'email', value: values.email });
    if (values.phone) wanted.push({ kind: 'phone', value: values.phone });
    for (const contact of wanted) {
      if (held.has(`${contact.kind}:${contactKey(contact.kind, contact.value)}`)) continue;
      await this.people.addContactPoint(
        ctx.principal,
        personId,
        { kind: contact.kind, value: contact.value, isPrimary: false, verified: false },
        ctx.correlationId,
      );
      changed = true;
    }
    return changed ? 'updated' : 'unchanged';
  }

  findPerson(organizationId: string, personId: string, trx?: Trx): Promise<PersonSummary | null> {
    return this.people.findPerson(organizationId, personId, trx);
  }

  // -------------------------------------------------------------------------------------------
  // Households (identity): grouping only, never authority (§4.5)
  // -------------------------------------------------------------------------------------------

  async createHousehold(ctx: TargetContext, name: string): Promise<string> {
    const household = await this.households.createHousehold(
      ctx.principal,
      { name },
      ctx.correlationId,
    );
    return household.id;
  }

  /** Adds staged members not yet in the household; never removes a member. */
  async syncHousehold(
    ctx: TargetContext,
    householdId: string,
    memberPersonIds: readonly string[],
  ): Promise<{ result: SyncResult; notInSource: string[]; name: string }> {
    const current = await this.household(ctx.organizationId, householdId);
    const present = new Set(current.members.map((m) => m.personId));
    let added = 0;
    for (const personId of memberPersonIds) {
      if (present.has(personId)) continue;
      await this.households.addMember(ctx.principal, householdId, { personId }, ctx.correlationId);
      added += 1;
    }
    const wanted = new Set(memberPersonIds);
    return {
      result: added > 0 ? 'updated' : 'unchanged',
      notInSource: [...present].filter((id) => !wanted.has(id)),
      name: current.name,
    };
  }

  household(organizationId: string, householdId: string, db: Reader = this.db): Promise<Household> {
    return this.households.detail(db, organizationId, householdId);
  }

  // -------------------------------------------------------------------------------------------
  // Relationships (identity), inside the migration transaction
  // -------------------------------------------------------------------------------------------

  async ensureRelationship(
    trx: Trx,
    ctx: TargetContext,
    input: {
      actorPersonId: string;
      subjectPersonId: string;
      kind: 'guardian' | 'delegate' | 'caregiver';
      permissions: readonly GrantPermissionValue[];
      effectiveFrom?: Date;
      effectiveTo?: Date | null;
    },
  ): Promise<{ relationshipId: string; created: boolean; grantsCreated: number }> {
    // Provenance `import`; grants only for the permissions passed (never implied, SPK-IAM-003).
    const result = await this.relationships.ensureAuthority(
      trx,
      ctx.principal,
      ctx.organizationId,
      {
        actorPersonId: input.actorPersonId,
        subjectPersonId: input.subjectPersonId,
        kind: input.kind,
        permissions: input.permissions,
        source: 'import',
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        correlationId: ctx.correlationId,
      },
    );
    return {
      relationshipId: result.relationship.id,
      created: result.relationshipCreated,
      grantsCreated: result.createdGrantIds.length,
    };
  }

  findLiveRelationship(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    kind: 'guardian' | 'delegate' | 'caregiver',
  ) {
    return this.relationships.findLiveRelationship(
      this.db,
      organizationId,
      actorPersonId,
      subjectPersonId,
      kind,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Programs (catalog)
  // -------------------------------------------------------------------------------------------

  async createProgram(ctx: TargetContext, values: ProgramValues): Promise<string> {
    const program = await this.programs.create(
      ctx.principal,
      {
        name: values.name,
        description: values.description,
        activityType: values.activityType,
        format: values.format,
        ageBand: {},
        status: values.status ?? 'draft',
        reason: ctx.reason,
      },
      ctx.correlationId,
    );
    return program.id;
  }

  async syncProgram(
    ctx: TargetContext,
    programId: string,
    values: ProgramValues,
  ): Promise<SyncResult> {
    const current = await this.programs.get(ctx.principal, programId);
    const changes: {
      name?: string;
      description?: string;
      activityType?: string;
      format?: string;
      status?: 'active';
    } = {};
    if (current.name !== values.name) changes.name = values.name;
    if (values.description !== undefined && current.description !== values.description) {
      changes.description = values.description;
    }
    if (current.activityType !== values.activityType) changes.activityType = values.activityType;
    if (values.format !== undefined && current.format !== values.format)
      changes.format = values.format;
    if (values.status === 'active' && current.status === 'draft') changes.status = 'active';
    if (values.status === 'draft' && current.status !== 'draft') {
      throw new DomainError('INVALID_TRANSITION', 'A program never returns to draft.', {
        details: { machine: 'Program', from: current.status, event: 'revert_to_draft' },
      });
    }
    if (Object.keys(changes).length === 0) return 'unchanged';
    await this.programs.update(
      ctx.principal,
      programId,
      { ...changes, expectedRevision: current.revision, reason: ctx.reason },
      ctx.correlationId,
    );
    return 'updated';
  }

  async programNames(principal: Principal): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.programs.list(principal, { limit: 200, cursor });
      for (const program of page.items) names.set(program.name.trim().toLowerCase(), program.id);
      if (!page.nextCursor) return names;
      cursor = page.nextCursor;
    }
  }

  program(principal: Principal, programId: string): Promise<Program> {
    return this.programs.get(principal, programId);
  }

  // -------------------------------------------------------------------------------------------
  // Opening balances (finance): no payment execution, no notice (§5.4)
  // -------------------------------------------------------------------------------------------

  async createOpeningObligation(
    ctx: TargetContext,
    input: {
      mappingId: string;
      debtorPersonId: string;
      amountMinor: number;
      currency: string;
      dueAt: string;
      description: string;
    },
  ): Promise<string> {
    // The mapping id is the obligation's source fact: finance's unique index on (source, debtor)
    // refuses a second obligation for the same imported balance (§4.7 invariant 5).
    const obligation = await this.obligations.create(
      ctx.principal,
      {
        debtor: { kind: 'person', personId: input.debtorPersonId },
        mode: 'individual',
        amountMinor: input.amountMinor,
        currency: input.currency,
        dueAt: input.dueAt,
        description: input.description,
        source: { kind: 'manual', id: input.mappingId },
        reason: ctx.reason,
      },
      ctx.correlationId,
    );
    return obligation.id;
  }

  obligation(principal: Principal, obligationId: string): Promise<Obligation> {
    return this.obligations.get(principal, obligationId);
  }

  async issueOpeningCredit(
    ctx: TargetContext,
    input: {
      ownerPersonId: string;
      amountMinor: number;
      currency: string;
      expiresAt?: string;
      permittedUses: readonly ('registration' | 'obligation')[];
    },
  ): Promise<string> {
    const credit = await this.credits.issue(
      ctx.principal,
      {
        ownerPersonId: input.ownerPersonId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        permittedUses: [...input.permittedUses],
        expiresAt: input.expiresAt,
        sourceKind: 'adjustment',
        reason: ctx.reason,
      },
      ctx.correlationId,
    );
    return credit.id;
  }

  credit(principal: Principal, creditId: string): Promise<Credit> {
    return this.credits.get(principal, creditId);
  }
}
