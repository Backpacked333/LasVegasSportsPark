import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AddContactPointInput,
  type ContactPoint,
  type ContactPointRemoved,
  type CreatePersonInput,
  type ImportProvenance,
  type MakePrimaryContactPointInput,
  type Page,
  type PersonDetail,
  type PersonName,
  type PersonSearchResult,
  type Principal,
  type RemoveContactPointInput,
  type SearchPeopleQueryInput,
  type UpdatePersonInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type PersonSource } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  assertImportPrincipal,
  ensureUpdated,
  importContentMismatch,
  snapshotActor,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import type { PersonDirectoryPort, PersonDisplayName, PersonSummary } from '../identity.ports';
import {
  assertKindMatchesDateOfBirth,
  displayNameOf,
  escapeLike,
  isUuid,
  maskContactValue,
  normalizeContactValue,
  personColumns,
  staffAuthorityApplies,
  toContactPoint,
  toPerson,
  type PersonRow,
} from '../identity.shared';

/** IF-40 (K-13): the migration import creates a person with a stable id, create-if-absent. */
export interface CreatePersonOptions {
  importProvenance?: ImportProvenance;
}

/** Bound on the merge chain walked by the directory reads (merges are rare; chains are short). */
const MAX_MERGE_DEPTH = 32;

const SearchCursor = z.object({ f: z.string(), g: z.string(), id: z.uuid() });

/** ID-02: a search term that is an exact email address or phone number (never a prefix). */
function contactTerm(term: string): { kind: 'email' | 'phone'; value: string } | null {
  if (term.includes('@')) return { kind: 'email', value: normalizeContactValue('email', term) };
  if (/^\+?[\d\s().-]+$/.test(term) && term.replace(/\D/g, '').length >= 7) {
    return { kind: 'phone', value: normalizeContactValue('phone', term) };
  }
  return null;
}

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

  /**
   * IF-40's name for `createPerson` (the migration import calls it with `{ importProvenance }`).
   */
  create(
    principal: Principal,
    input: CreatePersonInput,
    correlationId: string | null,
    options: CreatePersonOptions = {},
  ): Promise<PersonDetail> {
    return this.createPerson(principal, input, correlationId, options);
  }

  /**
   * POST /v1/people (staff, or a self-service adult's child record) and, in process only, the
   * migration import (ID-01, IF-40): with `importProvenance` the caller must be that batch's
   * import principal (`assertImportPrincipal`, ACCESS_DENIED otherwise), the person is created
   * with `id = recordId` and source `import`, and a second call with the same record and content
   * returns the existing person with no audit, outbox or detection (different content is
   * RESOURCE_CONFLICT `IMPORT_CONTENT_MISMATCH`). The command joins the caller's unit of work.
   * The HTTP body cannot ask for source `import`.
   */
  async createPerson(
    principal: Principal,
    input: CreatePersonInput,
    correlationId: string | null,
    options: CreatePersonOptions = {},
  ): Promise<PersonDetail> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const now = this.clock.now();
    assertKindMatchesDateOfBirth(input.kind, input.dateOfBirth, now);

    const provenance = options.importProvenance;
    let source: PersonSource = 'staff';
    let createdByPersonId: string | null = null;
    if (provenance) {
      assertImportPrincipal(principal, provenance);
      source = 'import';
    } else if (
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

    const id = provenance?.recordId ?? newId();
    return runInTransaction(this.uow, async ({ trx }) => {
      if (provenance) {
        const existing = await trx
          .selectFrom('persons')
          .select(personColumns)
          .where('persons.id', '=', id)
          .executeTakeFirst();
        if (existing) {
          await this.assertSameImport(
            trx,
            organizationId,
            existing as PersonRow,
            input,
            provenance,
          );
          return this.detail(trx, organizationId, id);
        }
      }
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
        details: {
          kind: input.kind,
          source,
          ...(provenance
            ? { importBatchId: provenance.batchId, importExternalKey: provenance.externalKey }
            : {}),
        },
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

  /**
   * POST /v1/people/{id}/contact-points/{contactPointId}/make-primary (ID-06, SPK-IAM-001, §4.9):
   * in one unit of work the person's other primary contact point of the same kind loses the flag
   * and this one gains it; `contact_points_primary_idx` stays the guarantee. Contact points are
   * part of PersonDetail, so the person's revision is the one `expectedRevision` names and the
   * command bumps it (identity.person_updated carries it).
   */
  async makePrimaryContactPoint(
    principal: Principal,
    personId: string,
    contactPointId: string,
    input: MakePrimaryContactPointInput,
    correlationId: string | null,
  ): Promise<ContactPoint> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const { person, contact } = await this.lockContactPoint(
        trx,
        principal,
        organizationId,
        personId,
        contactPointId,
        input.expectedRevision,
      );
      if (contact.is_primary) return toContactPoint(contact);
      await trx
        .updateTable('contact_points')
        .set({ is_primary: false })
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where('kind', '=', contact.kind)
        .where('is_primary', '=', true)
        .execute();
      try {
        await trx
          .updateTable('contact_points')
          .set({ is_primary: true })
          .where('organization_id', '=', organizationId)
          .where('id', '=', contactPointId)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'This verified contact point already identifies another person.',
            { kind: contact.kind },
          );
        }
        throw error;
      }
      const revision = await this.bumpRevision(trx, organizationId, person);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.makePrimaryContactPoint.id,
        targetType: 'person',
        targetId: personId,
        beforeRevision: person.revision,
        afterRevision: revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'make_primary',
          contactPointId,
          kind: contact.kind,
          value: maskContactValue(contact.kind, contact.value),
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.personUpdated, {
        organizationId,
        aggregateType: 'person',
        aggregateId: personId,
        payload: { personId, revision },
        correlationId,
      });
      const row = await trx
        .selectFrom('contact_points')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', contactPointId)
        .executeTakeFirstOrThrow();
      return toContactPoint(row);
    });
  }

  /**
   * POST /v1/people/{id}/contact-points/{contactPointId}/remove (ID-06, SPK-IAM-001, §4.14): the
   * row is deleted; the audit record names its kind and a masked value only. Conservative rule
   * until verification and recovery are decided (DEC-018): the only verified contact point of a
   * person whose account is active is never removed (VALIDATION_FAILED `LAST_VERIFIED_CONTACT`),
   * so invitations, claims and recovery keep an address the person proved.
   */
  async removeContactPoint(
    principal: Principal,
    personId: string,
    contactPointId: string,
    input: RemoveContactPointInput,
    correlationId: string | null,
  ): Promise<ContactPointRemoved> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const { person, contact } = await this.lockContactPoint(
        trx,
        principal,
        organizationId,
        personId,
        contactPointId,
        input.expectedRevision,
      );
      if (contact.verified_at !== null) {
        const otherVerified = await trx
          .selectFrom('contact_points')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('person_id', '=', personId)
          .where('id', '<>', contactPointId)
          .where('verified_at', 'is not', null)
          .executeTakeFirst();
        const account = await trx
          .selectFrom('accounts')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('person_id', '=', personId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!otherVerified && account) {
          throw errors.validation(
            'The only verified contact point of a person with an account cannot be removed; verify another one first.',
            { code: 'LAST_VERIFIED_CONTACT', contactPointId },
          );
        }
      }
      await trx
        .deleteFrom('contact_points')
        .where('organization_id', '=', organizationId)
        .where('id', '=', contactPointId)
        .execute();
      const revision = await this.bumpRevision(trx, organizationId, person);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.removeContactPoint.id,
        targetType: 'person',
        targetId: personId,
        beforeRevision: person.revision,
        afterRevision: revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'remove',
          contactPointId,
          kind: contact.kind,
          value: maskContactValue(contact.kind, contact.value),
          verified: contact.verified_at !== null,
          wasPrimary: contact.is_primary,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.personUpdated, {
        organizationId,
        aggregateType: 'person',
        aggregateId: personId,
        payload: { personId, revision },
        correlationId,
      });
      return { removedContactPointId: contactPointId };
    });
  }

  /**
   * GET /v1/person-names (ID-02, SPK-IAM-002/003, §4.10, §4.14): names only, each person decided
   * with identity.read_person as a protected record. A person the caller may not view is left
   * out (never a 404 that would confirm the id). A merged person is shown when the caller may view
   * it or its surviving record, with `canonicalPersonId` naming the survivor.
   */
  async personNames(principal: Principal, ids: readonly string[]): Promise<PersonName[]> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const unique = [...new Set(ids)];
    const rows = await this.db
      .selectFrom('persons')
      .select(['id', 'given_name', 'family_name', 'kind', 'merged_into_person_id'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', unique)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: PersonName[] = [];
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) continue;
      const canonical = row.merged_into_person_id
        ? await this.resolveCanonicalPersonId(organizationId, id)
        : id;
      const visible =
        (await this.mayViewPerson(principal, organizationId, id)) ||
        (canonical !== id && (await this.mayViewPerson(principal, organizationId, canonical)));
      if (!visible) continue;
      items.push({
        personId: row.id,
        canonicalPersonId: canonical,
        givenName: row.given_name,
        familyName: row.family_name,
        displayName: displayNameOf(row.given_name, row.family_name),
        kind: row.kind,
      });
    }
    return items;
  }

  /**
   * GET /v1/people (ID-02, SPK-IAM-002/003, §4.14, SCR-S-20): staff search by a name prefix of
   * the given or family name (or "given family" prefixes), or by an exact contact value (email
   * lower-cased, phone without separators). Merged persons only with `status=merged`. Keyset
   * order (lower(family_name), lower(given_name), id). Never dates of birth, contacts or
   * households. Coaches and officials do not hold identity.lookup_person: they see names only
   * through their assigned activities (entry and competition).
   */
  async searchPeople(
    principal: Principal,
    query: SearchPeopleQueryInput,
  ): Promise<Page<PersonSearchResult>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.lookupPerson, {
      type: 'person_directory',
      organizationId,
    });
    const term = query.query.trim();
    const lowered = term.toLowerCase();
    const contact = contactTerm(term);
    const contactMatches = new Set<string>();
    if (contact) {
      const rows = await this.db
        .selectFrom('contact_points')
        .select('person_id')
        .where('organization_id', '=', organizationId)
        .where('kind', '=', contact.kind)
        .where('value', '=', contact.value)
        .execute();
      for (const row of rows) contactMatches.add(row.person_id);
    }
    const tokens = lowered.split(/\s+/).filter((t) => t.length > 0);
    const prefix = `${escapeLike(lowered)}%`;
    let rows = this.db
      .selectFrom('persons')
      .select(['id', 'given_name', 'family_name', 'kind', 'status'])
      // The keyset cursor is encoded from the database's own lowercasing, the same expressions the
      // order and the row comparison use, so a non-ASCII name never misplaces the page boundary.
      .select([
        sql<string>`lower(family_name)`.as('sort_family'),
        sql<string>`lower(given_name)`.as('sort_given'),
      ])
      .where('organization_id', '=', organizationId)
      .where((eb) => {
        const given = eb.fn<string>('lower', ['given_name']);
        const family = eb.fn<string>('lower', ['family_name']);
        const matches = [eb(given, 'like', prefix), eb(family, 'like', prefix)];
        if (tokens.length >= 2) {
          matches.push(
            eb.and([
              eb(given, 'like', `${escapeLike(tokens[0] as string)}%`),
              eb(family, 'like', `${escapeLike(tokens.slice(1).join(' '))}%`),
            ]),
          );
        }
        if (contactMatches.size > 0) matches.push(eb('id', 'in', [...contactMatches]));
        return eb.or(matches);
      });
    rows = query.status
      ? rows.where('status', '=', query.status)
      : rows.where('status', '<>', 'merged');
    if (query.kind) rows = rows.where('kind', '=', query.kind);
    const cursor = decodeCursor(query.cursor, SearchCursor);
    if (cursor) {
      rows = rows.where(
        sql<SqlBool>`(lower(family_name), lower(given_name), id) > (${cursor.f}, ${cursor.g}, ${cursor.id}::uuid)`,
      );
    }
    const found = await rows
      .orderBy(sql`lower(family_name)`)
      .orderBy(sql`lower(given_name)`)
      .orderBy('id')
      .limit(query.limit + 1)
      .execute();
    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        givenName: r.given_name,
        familyName: r.family_name,
        kind: r.kind,
        status: r.status,
        matchedOn: contactMatches.has(r.id) ? 'contact' : 'name',
      })),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({ f: last.sort_family, g: last.sort_given, id: last.id })
          : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // PersonDirectoryPort
  // -------------------------------------------------------------------------------------------
  /**
   * IF-09 (ID-01, §4.14): names only, keyed by person id; unknown, malformed and other-organization
   * ids are omitted. Reads through `trx ?? currentTransaction() ?? db`. Callers authorize their
   * context first (this is a lookup, not an authorization).
   */
  async displayNames(
    organizationId: string,
    personIds: readonly string[],
    trx?: Trx,
  ): Promise<Map<string, PersonDisplayName>> {
    const ids = [...new Set(personIds)].filter(isUuid);
    const names = new Map<string, PersonDisplayName>();
    if (ids.length === 0) return names;
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('persons')
      .select(['id', 'given_name', 'family_name', 'kind'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .execute();
    for (const row of rows) {
      names.set(row.id, {
        personId: row.id,
        givenName: row.given_name,
        familyName: row.family_name,
        displayName: displayNameOf(row.given_name, row.family_name),
        kind: row.kind,
      });
    }
    return names;
  }

  /**
   * IF-09 (ID-01, SPK-IAM-007 merge preserves history): `[canonical, ...every person merged into
   * it, transitively]`, nearest merges first. Modules holding immutable facts under an old id read
   * the survivor's history with it instead of rewriting rows. [] for an unknown, malformed or
   * other-organization id.
   */
  async personIdsResolvingTo(
    organizationId: string,
    personId: string,
    trx?: Trx,
  ): Promise<string[]> {
    if (!isUuid(personId)) return [];
    const db = trx ?? executorFor(this.db);
    const known = await db
      .selectFrom('persons')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!known) return [];
    const canonical = await this.resolveCanonicalPersonId(organizationId, personId, trx);
    const result = await sql<{ id: string; depth: number }>`
      with recursive chain (id, depth) as (
        select p.id, 0 from persons p
         where p.organization_id = ${organizationId} and p.id = ${canonical}::uuid
        union all
        select p.id, c.depth + 1 from persons p
          join chain c on p.merged_into_person_id = c.id
         where p.organization_id = ${organizationId} and c.depth < ${MAX_MERGE_DEPTH}
      )
      select id, min(depth) as depth from chain group by id order by min(depth), id
    `.execute(db);
    return result.rows.map((r) => r.id);
  }

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
  private async mayViewPerson(
    principal: Principal,
    organizationId: string,
    personId: string,
  ): Promise<boolean> {
    const decision = await this.authorization.decide(principal, IdentityActions.readPerson, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    return decision.allowed;
  }

  /**
   * ID-06: locks the person (serializing contact point changes and person updates), authorizes
   * identity.add_contact_point on them as a protected record, checks the person's revision and
   * loads the contact point, which must be theirs (anything else reads as not found, §4.10).
   */
  private async lockContactPoint(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    personId: string,
    contactPointId: string,
    expectedRevision: number | undefined,
  ) {
    const person = await trx
      .selectFrom('persons')
      .select(['id', 'status', 'revision'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', personId)
      .forUpdate()
      .executeTakeFirst();
    if (!person) throw errors.protectedNotFound('person');
    await this.authorization.require(principal, IdentityActions.addContactPoint, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const contact = await trx
      .selectFrom('contact_points')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('id', '=', contactPointId)
      .executeTakeFirst();
    if (!contact) throw errors.protectedNotFound('contact_point');
    assertExpectedRevision(expectedRevision, person.revision);
    if (person.status === 'merged') {
      throw errors.invalidTransition('Person', 'merged', 'change_contact_point');
    }
    return { person, contact };
  }

  private async bumpRevision(
    trx: Trx,
    organizationId: string,
    person: { id: string; revision: number },
  ): Promise<number> {
    const updated = await trx
      .updateTable('persons')
      .set({ revision: person.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', person.id)
      .where('revision', '=', person.revision)
      .executeTakeFirst();
    ensureUpdated(updated.numUpdatedRows, () =>
      errors.staleRevision(person.revision, person.revision + 1),
    );
    return person.revision + 1;
  }

  /** IF-40: the record already imported must carry the same content, else IMPORT_CONTENT_MISMATCH. */
  private async assertSameImport(
    trx: Trx,
    organizationId: string,
    existing: PersonRow,
    input: CreatePersonInput,
    provenance: ImportProvenance,
  ): Promise<void> {
    const mismatch = () =>
      importContentMismatch({ recordType: 'person', recordId: provenance.recordId });
    if (
      existing.organization_id !== organizationId ||
      existing.source !== 'import' ||
      existing.kind !== input.kind ||
      existing.given_name !== input.givenName ||
      existing.family_name !== input.familyName ||
      existing.date_of_birth !== (input.dateOfBirth ?? null)
    ) {
      throw mismatch();
    }
    const held = await trx
      .selectFrom('contact_points')
      .select(['kind', 'value'])
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', existing.id)
      .execute();
    const keys = new Set(held.map((c) => `${c.kind}:${c.value}`));
    for (const contact of input.contactPoints) {
      if (!keys.has(`${contact.kind}:${normalizeContactValue(contact.kind, contact.value)}`)) {
        throw mismatch();
      }
    }
  }

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
