import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AddContactPointInput,
  type ContactPoint,
  type CreatePersonInput,
  type PersonDetail,
  type Principal,
  type UpdatePersonInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import type { PersonDirectoryPort, PersonSummary } from '../identity.ports';
import {
  assertKindMatchesDateOfBirth,
  normalizeContactValue,
  personColumns,
  staffAuthorityApplies,
  toContactPoint,
  toPerson,
  type PersonRow,
} from '../identity.shared';

/** Duplicate detection score for an exact name + date-of-birth match (SPK-IAM-007). */
const DUPLICATE_SCORE_NAME_DOB = 80;
const DUPLICATE_SCORE_VERIFIED_CONTACT = 70;

/**
 * Persons and contact points (SPK-IAM-001/002/007). A person is never an account, a household or
 * a relationship; this service only records who exists. Reads are object-level authorized against
 * the real subject so a stranger receives NOT_FOUND, never confirmation (§4.10).
 */
@Injectable()
export class PeopleService implements PersonDirectoryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async createPerson(
    principal: Principal,
    input: CreatePersonInput,
    correlationId: string | null,
  ): Promise<PersonDetail> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const now = this.clock.now();
    assertKindMatchesDateOfBirth(input.kind, input.dateOfBirth, now);

    let source: 'staff' | 'self_service' = 'staff';
    let createdByPersonId: string | null = null;
    if (
      !(await staffAuthorityApplies(
        this.authorization,
        principal,
        IdentityActions.createPerson,
        organizationId,
      ))
    ) {
      // Self-service: an adult may create a child record they will be guardian of. This is open
      // to any person, including a staff member whose roles do not cover creating people (a coach
      // who is also a parent, SPK-IAM acceptance example 3). Guardian verification policy is an
      // operator decision (§6.6); the default allows this.
      if (input.kind !== 'child') {
        throw errors.accessDenied(
          'Customers may only create child records for themselves to manage.',
        );
      }
      if (input.contactPoints.some((c) => c.verified)) {
        throw errors.accessDenied('Only staff may record a contact point as verified.');
      }
      if (!principal.personId) {
        throw errors.accessDenied('Link your account to a person before creating records.');
      }
      const actor = await this.loadPerson(this.db, organizationId, principal.personId);
      if (!actor || actor.status !== 'active' || actor.kind !== 'adult') {
        throw errors.accessDenied('Only an active adult may create child records.');
      }
      await this.authorization.require(principal, IdentityActions.createChildSelfService, {
        type: 'person',
        organizationId,
        subjectPersonIds: [principal.personId],
      });
      source = 'self_service';
      createdByPersonId = principal.personId;
    }

    const id = newId();
    return runInTransaction(this.uow, async ({ trx }) => {
      await trx
        .insertInto('persons')
        .values({
          id,
          organization_id: organizationId,
          kind: input.kind,
          given_name: input.givenName,
          family_name: input.familyName,
          date_of_birth: input.dateOfBirth ?? null,
          source,
          created_by: json(snapshotActor(principal)),
          created_by_person_id: createdByPersonId,
          merged_into_person_id: null,
        })
        .execute();
      for (const contact of input.contactPoints) {
        await this.insertContactPoint(trx, organizationId, id, contact);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.createPerson.id,
        targetType: 'person',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { kind: input.kind, source },
      });
      await this.outbox.enqueue(trx, IdentityEvents.personCreated, {
        organizationId,
        aggregateType: 'person',
        aggregateId: id,
        payload: { personId: id, kind: input.kind, source },
        correlationId,
      });
      await this.detectDuplicates(trx, principal, organizationId, id, correlationId);
      return this.detail(trx, organizationId, id);
    });
  }

  async getPerson(principal: Principal, id: string): Promise<PersonDetail> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const row = await this.loadPerson(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('person');
    await this.authorization.require(principal, IdentityActions.readPerson, {
      type: 'person',
      id,
      organizationId,
      subjectPersonIds: [id],
      protected: true,
    });
    return this.detail(this.db, organizationId, id);
  }

  async updatePerson(
    principal: Principal,
    id: string,
    input: UpdatePersonInput,
    correlationId: string | null,
  ): Promise<PersonDetail> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const current = await this.loadPerson(trx, organizationId, id);
      if (!current) throw errors.protectedNotFound('person');
      await this.authorization.require(principal, IdentityActions.updatePerson, {
        type: 'person',
        id,
        organizationId,
        subjectPersonIds: [id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      if (current.status === 'merged') {
        throw errors.invalidTransition('Person', 'merged', 'update');
      }
      const dateOfBirth =
        input.dateOfBirth === undefined ? current.date_of_birth : input.dateOfBirth;
      assertKindMatchesDateOfBirth(current.kind, dateOfBirth, this.clock.now());
      // A staff role that covers person updates, not staff kind alone (SPK-IAM-001).
      if (
        input.status !== undefined &&
        !(await staffAuthorityApplies(
          this.authorization,
          principal,
          IdentityActions.updatePerson,
          organizationId,
        ))
      ) {
        throw errors.accessDenied('Only staff may change a person status.');
      }
      const result = await trx
        .updateTable('persons')
        .set({
          given_name: input.givenName ?? current.given_name,
          family_name: input.familyName ?? current.family_name,
          date_of_birth: dateOfBirth,
          status: input.status ?? current.status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw errors.staleRevision(current.revision, current.revision + 1);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.updatePerson.id,
        targetType: 'person',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { fields: Object.keys(input).filter((k) => k !== 'expectedRevision') },
      });
      await this.outbox.enqueue(trx, IdentityEvents.personUpdated, {
        organizationId,
        aggregateType: 'person',
        aggregateId: id,
        payload: { personId: id, revision: current.revision + 1 },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async addContactPoint(
    principal: Principal,
    personId: string,
    input: AddContactPointInput,
    correlationId: string | null,
  ): Promise<ContactPoint> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const person = await this.loadPerson(trx, organizationId, personId);
      if (!person) throw errors.protectedNotFound('person');
      await this.authorization.require(principal, IdentityActions.addContactPoint, {
        type: 'person',
        id: personId,
        organizationId,
        subjectPersonIds: [personId],
        protected: true,
      });
      // Verified contacts address invitations and claims, so only a staff role that covers this
      // command may record one, never staff kind alone (SPK-IAM-001/002).
      if (
        input.verified &&
        !(await staffAuthorityApplies(
          this.authorization,
          principal,
          IdentityActions.addContactPoint,
          organizationId,
        ))
      ) {
        throw errors.accessDenied('Only staff may record a contact point as verified.');
      }
      const id = await this.insertContactPoint(trx, organizationId, personId, input);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.addContactPoint.id,
        targetType: 'person',
        targetId: personId,
        correlationId,
        details: { contactPointId: id, kind: input.kind, verified: input.verified },
      });
      const row = await trx
        .selectFrom('contact_points')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toContactPoint(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // PersonDirectoryPort
  // -------------------------------------------------------------------------------------------
  async findPerson(
    organizationId: string,
    personId: string,
    trx?: Trx,
  ): Promise<PersonSummary | null> {
    // Called from other modules' commands and handlers: read through their transaction.
    const row = await this.loadPerson(trx ?? executorFor(this.db), organizationId, personId);
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      status: row.status,
      dateOfBirth: row.date_of_birth,
      canonicalPersonId: await this.resolveCanonicalPersonId(organizationId, personId, trx),
    };
  }

  async resolveCanonicalPersonId(
    organizationId: string,
    personId: string,
    trx?: Trx,
  ): Promise<string> {
    const db = trx ?? executorFor(this.db);
    let current = personId;
    // Merges form a chain (A→B, later B→C); follow it with a bounded walk.
    for (let hop = 0; hop < 16; hop += 1) {
      const row = await db
        .selectFrom('persons')
        .select('merged_into_person_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', current)
        .executeTakeFirst();
      if (!row?.merged_into_person_id) return current;
      current = row.merged_into_person_id;
    }
    return current;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  async loadPerson(db: Db | Trx, organizationId: string, id: string): Promise<PersonRow | null> {
    const row = await db
      .selectFrom('persons')
      .select(personColumns)
      .where('persons.organization_id', '=', organizationId)
      .where('persons.id', '=', id)
      .executeTakeFirst();
    return (row as PersonRow | undefined) ?? null;
  }

  async detail(db: Db | Trx, organizationId: string, id: string): Promise<PersonDetail> {
    const row = await this.loadPerson(db, organizationId, id);
    if (!row) throw errors.protectedNotFound('person');
    const contacts = await db
      .selectFrom('contact_points')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', id)
      .orderBy('created_at')
      .execute();
    return { ...toPerson(row), contactPoints: contacts.map(toContactPoint) };
  }

  private async insertContactPoint(
    trx: Trx,
    organizationId: string,
    personId: string,
    input: AddContactPointInput,
  ): Promise<string> {
    const id = newId();
    const value = normalizeContactValue(input.kind, input.value);
    if (input.isPrimary) {
      await trx
        .updateTable('contact_points')
        .set({ is_primary: false })
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where('kind', '=', input.kind)
        .where('is_primary', '=', true)
        .execute();
    }
    try {
      await trx
        .insertInto('contact_points')
        .values({
          id,
          organization_id: organizationId,
          person_id: personId,
          kind: input.kind,
          value,
          is_primary: input.isPrimary,
          verified_at: input.verified ? this.clock.now() : null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict(
          'This verified contact point already identifies another person.',
          { kind: input.kind },
        );
      }
      throw error;
    }
    return id;
  }

  /**
   * SPK-IAM-007: detection only produces review candidates; nothing is merged automatically.
   * Signals: identical name + date of birth, or a verified primary contact value already held.
   */
  private async detectDuplicates(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    personId: string,
    correlationId: string | null,
  ): Promise<void> {
    const me = await this.loadPerson(trx, organizationId, personId);
    if (!me) return;
    const candidates = new Map<string, { reasons: string[]; score: number }>();
    if (me.date_of_birth) {
      const sameNameDob = await trx
        .selectFrom('persons')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '<>', personId)
        .where('status', '=', 'active')
        .where('date_of_birth', '=', me.date_of_birth)
        .where((eb) =>
          eb.and([
            eb(eb.fn('lower', ['given_name']), '=', me.given_name.toLowerCase()),
            eb(eb.fn('lower', ['family_name']), '=', me.family_name.toLowerCase()),
          ]),
        )
        .execute();
      for (const row of sameNameDob) {
        candidates.set(row.id, {
          reasons: ['same_name_and_date_of_birth'],
          score: DUPLICATE_SCORE_NAME_DOB,
        });
      }
    }
    const myContacts = await trx
      .selectFrom('contact_points')
      .select(['kind', 'value'])
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .execute();
    for (const contact of myContacts) {
      const holders = await trx
        .selectFrom('contact_points')
        .select('person_id')
        .where('organization_id', '=', organizationId)
        .where('kind', '=', contact.kind)
        .where('value', '=', contact.value)
        .where('verified_at', 'is not', null)
        .where('person_id', '<>', personId)
        .execute();
      for (const holder of holders) {
        const existing = candidates.get(holder.person_id);
        const reason = `shared_verified_${contact.kind}`;
        if (existing) {
          existing.reasons.push(reason);
          existing.score = Math.min(100, existing.score + 10);
        } else {
          candidates.set(holder.person_id, {
            reasons: [reason],
            score: DUPLICATE_SCORE_VERIFIED_CONTACT,
          });
        }
      }
    }
    for (const [otherId, signal] of candidates) {
      const [a, b] = otherId < personId ? [otherId, personId] : [personId, otherId];
      const id = newId();
      const inserted = await trx
        .insertInto('duplicate_candidates')
        .values({
          id,
          organization_id: organizationId,
          person_a_id: a,
          person_b_id: b,
          reasons: signal.reasons,
          score: signal.score,
          flagged_by: json({ kind: 'system', actorLabel: 'identity.duplicate_detection' }),
          decision: null,
          decided_by: null,
          decided_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'person_a_id', 'person_b_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (!inserted) continue;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.flagDuplicate.id,
        targetType: 'duplicate_candidate',
        targetId: id,
        correlationId,
        details: { personAId: a, personBId: b, reasons: signal.reasons, automatic: true },
      });
      await this.outbox.enqueue(trx, IdentityEvents.duplicateCandidateFlagged, {
        organizationId,
        aggregateType: 'duplicate_candidate',
        aggregateId: id,
        payload: { candidateId: id, personAId: a, personBId: b, score: signal.score },
        correlationId,
      });
    }
  }
}
