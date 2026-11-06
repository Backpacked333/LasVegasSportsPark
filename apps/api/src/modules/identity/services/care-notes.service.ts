import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CareNote,
  type PersonCareNotes,
  type Principal,
  type RecordCareNoteInput,
  type RetireCareNoteInput,
  type ScanCareNote,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { PersonCareNotesTable } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CARE_NOTE_STAFF, IdentityActions } from '../identity.actions';
import { IdentityEvents } from '../identity.events';
import { CareNoteMachine } from '../identity.machines';
import { PeopleService } from './people.service';

type CareNoteRow = Selectable<PersonCareNotesTable>;

function toCareNote(row: CareNoteRow, personId: string): CareNote {
  return {
    id: row.id,
    // A merged person's note is shown on the surviving record (SPK-IAM-007).
    personId,
    kind: row.kind,
    body: row.body,
    status: row.status,
    recordedAt: new Date(row.created_at).toISOString(),
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
    revision: row.revision,
  };
}

/** What a caller of the arrival read is told about where the notes were shown (audit details). */
export interface CareNoteReadContext {
  via: string;
  facilityId?: string | null;
  referenceType?: string;
  referenceId?: string;
}

/**
 * Operational care notes (migration 0181; §1.7 "not a medical assessment system", SPK-DISC-005,
 * §4.14 child information minimized, SPK-ENTRY-004). A note is a short, operational instruction
 * (an allergy and what to do, a care instruction): never a diagnosis, an assessment or medical
 * advice, and the two kinds are the only ones the database accepts.
 *
 * Protected: the person, a holder of `view` over them, and the staff roles in `CARE_NOTE_STAFF`
 * read them; anyone else gets NOT_FOUND (§4.10). Every read that returns a note writes an audit
 * record naming the reader and the person (§4.14 audited access to sensitive child data). A note's
 * text never changes: correcting it retires it (reason kept, revision checked) and records a new one;
 * the database refuses any rewrite or delete.
 */
@Injectable()
export class CareNotesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly people: PeopleService,
  ) {}

  /** GET /v1/people/{id}/care-notes: the active notes, audited. */
  async list(
    principal: Principal,
    personId: string,
    correlationId: string | null,
  ): Promise<PersonCareNotes> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.readCareNotes, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    return this.uow.run(async ({ trx }) => {
      const person = await this.people.findPerson(organizationId, personId, trx);
      if (!person) throw errors.protectedNotFound('person');
      const ids = await this.people.personIdsResolvingTo(organizationId, personId, trx);
      const rows = await this.activeRows(trx, organizationId, ids);
      if (rows.length > 0) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: IdentityActions.readCareNotes.id,
          targetType: 'person',
          targetId: personId,
          correlationId,
          details: { via: 'person_record', notes: rows.map((r) => r.id) },
        });
      }
      return {
        personId,
        notes: rows.map((r) => toCareNote(r, personId)),
        visibleToRoles: [...CARE_NOTE_STAFF],
        readAudited: true as const,
      };
    });
  }

  /** POST /v1/people/{id}/care-notes. */
  async record(
    principal: Principal,
    personId: string,
    input: RecordCareNoteInput,
    correlationId: string | null,
  ): Promise<CareNote> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.manageCareNotes, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    return this.uow.run(async ({ trx }) => {
      const person = await this.people.findPerson(organizationId, personId, trx);
      if (!person) throw errors.protectedNotFound('person');
      if (person.status !== 'active') {
        throw errors.validation('Care notes are recorded on an active person record.', {
          status: person.status,
          canonicalPersonId: person.canonicalPersonId,
        });
      }
      const id = newId();
      await trx
        .insertInto('person_care_notes')
        .values({
          id,
          organization_id: organizationId,
          person_id: personId,
          kind: input.kind,
          body: input.body,
          recorded_by: json(snapshotActor(principal)),
          recorded_by_person_id: principal.personId,
          retired_at: null,
          retired_by: null,
          retired_reason: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageCareNotes.id,
        targetType: 'care_note',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        // §4.14: the note's text stays out of the audit log; the note itself is the record.
        details: { operation: 'record', personId, kind: input.kind },
      });
      await this.outbox.enqueue(trx, IdentityEvents.careNoteChanged, {
        organizationId,
        aggregateType: 'care_note',
        aggregateId: id,
        payload: { noteId: id, personId, status: 'active' },
        correlationId,
      });
      const row = await this.load(trx, organizationId, id);
      return toCareNote(row!, personId);
    });
  }

  /** POST /v1/care-notes/{id}/retire. */
  async retire(
    principal: Principal,
    id: string,
    input: RetireCareNoteInput,
    correlationId: string | null,
  ): Promise<CareNote> {
    const organizationId = this.organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.protectedNotFound('care_note');
      const canonical = await this.people.resolveCanonicalPersonId(
        organizationId,
        current.person_id,
        trx,
      );
      await this.authorization.require(principal, IdentityActions.manageCareNotes, {
        type: 'care_note',
        id,
        organizationId,
        subjectPersonIds: [canonical],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = CareNoteMachine.next(current.status, 'retire');
      const updated = await trx
        .updateTable('person_care_notes')
        .set({
          status: next,
          retired_at: this.clock.now(),
          retired_by: json(snapshotActor(principal)),
          retired_reason: input.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(current.revision, current.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageCareNotes.id,
        targetType: 'care_note',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        details: { operation: 'retire', personId: canonical, kind: current.kind },
      });
      await this.outbox.enqueue(trx, IdentityEvents.careNoteChanged, {
        organizationId,
        aggregateType: 'care_note',
        aggregateId: id,
        payload: { noteId: id, personId: canonical, status: 'retired' },
        correlationId,
      });
      const row = await this.load(trx, organizationId, id);
      return toCareNote(row!, canonical);
    });
  }

  /**
   * Whether the principal may read care notes of people at the facility (the arrival desk). A
   * staff role in CARE_NOTE_STAFF within its facility scope; nobody else is shown them on a scan.
   * Decided before the caller's transaction, as the kernel authorizes (§4.14).
   */
  async mayReadAtFacility(principal: Principal, facilityId: string): Promise<boolean> {
    const organizationId = principal.organizationId;
    if (!organizationId || principal.kind !== 'staff') return false;
    const decision = await this.authorization.decide(principal, IdentityActions.readCareNotes, {
      type: 'person',
      organizationId,
      facilityId,
      protected: true,
    });
    return decision.allowed;
  }

  /**
   * The active notes of each person, for a read another module shows (the arrival scan), written
   * to the audit log in the caller's transaction: one record per person whose notes were shown.
   * The caller has established `mayReadAtFacility` first. Merged people's notes follow the survivor.
   */
  async readForArrivalIn(
    trx: Trx,
    principal: Principal,
    personIds: readonly string[],
    context: CareNoteReadContext,
    correlationId: string | null,
  ): Promise<Map<string, ScanCareNote[]>> {
    const organizationId = this.organizationOf(principal);
    const out = new Map<string, ScanCareNote[]>();
    if (personIds.length === 0) return out;
    const resolving = await this.people.personIdsResolvingToMany(organizationId, personIds, trx);
    const all = [...new Set([...resolving.values()].flat())];
    const rows = await this.activeRows(trx, organizationId, all);
    for (const personId of personIds) {
      const ids = new Set(resolving.get(personId) ?? [personId]);
      const notes = rows.filter((r) => ids.has(r.person_id));
      out.set(
        personId,
        notes.map((r) => ({ id: r.id, kind: r.kind, body: r.body })),
      );
      if (notes.length === 0) continue;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.readCareNotes.id,
        targetType: 'person',
        targetId: personId,
        correlationId,
        details: { ...context, notes: notes.map((r) => r.id) },
      });
    }
    return out;
  }

  private activeRows(trx: Trx, organizationId: string, personIds: readonly string[]) {
    if (personIds.length === 0) return Promise.resolve([] as CareNoteRow[]);
    return trx
      .selectFrom('person_care_notes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', [...personIds])
      .where('status', '=', 'active')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  private async load(trx: Trx, organizationId: string, id: string, lock = false) {
    let query = trx
      .selectFrom('person_care_notes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  private organizationOf(principal: Principal): string {
    if (!principal.organizationId) throw errors.authenticationRequired();
    return principal.organizationId;
  }
}
