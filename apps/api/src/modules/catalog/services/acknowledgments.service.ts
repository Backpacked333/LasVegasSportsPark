import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Acknowledgment,
  type ListAcknowledgmentsQuery,
  type Principal,
  type RecordAcknowledgmentInput,
  type WithdrawAcknowledgmentInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
} from '../../../kernel';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  type AuthorityLookupPort,
  type PersonDirectoryPort,
} from '../../identity';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { organizationOf, toAcknowledgment } from '../catalog.shared';

/**
 * Policy acknowledgments (§4.4 Acknowledgment, SPK-REG-009, POL-037). The signer is always a
 * person who may sign: the adult subject themselves, or a guardian who currently holds
 * `complete_forms` over the participant (identity authority, never a staff role). A staff actor
 * who assists at the desk is recorded separately as `recorded_by` and can never be the signer;
 * the database refuses that row (acknowledgments_staff_never_signer).
 *
 * Subject-permission authorization runs before the transaction: the kernel consults the identity
 * port without a transaction handle, which would deadlock the single PGlite connection.
 */
@Injectable()
export class AcknowledgmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async record(
    principal: Principal,
    body: RecordAcknowledgmentInput,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    const organizationId = organizationOf(principal);
    const staffActor = principal.kind === 'staff' || principal.kind === 'system';
    let signedByPersonId: string;
    if (staffActor) {
      // SPK-REG-009: staff record a named signer; they never sign a guardian acknowledgment.
      if (!body.signedByPersonId) {
        throw errors.validation(
          'signedByPersonId is required when staff record an acknowledgment.',
          {
            path: 'signedByPersonId',
          },
        );
      }
      if (principal.personId !== null && body.signedByPersonId === principal.personId) {
        throw errors.accessDenied(
          'A staff actor cannot be the signer of an acknowledgment; the guardian or the adult participant signs.',
          { action: CatalogActions.recordAcknowledgment.id },
        );
      }
      await this.authorization.require(principal, CatalogActions.recordAcknowledgment, {
        type: 'acknowledgment',
        organizationId,
      });
      signedByPersonId = body.signedByPersonId;
    } else {
      if (!principal.personId) throw errors.authenticationRequired();
      if (body.signedByPersonId !== undefined && body.signedByPersonId !== principal.personId) {
        throw errors.validation('A customer records only their own signature.', {
          path: 'signedByPersonId',
        });
      }
      signedByPersonId = principal.personId;
      // Self (adult subject) or a guardian holding complete_forms over the participant.
      await this.authorization.require(principal, CatalogActions.recordAcknowledgment, {
        type: 'acknowledgment',
        organizationId,
        subjectPersonIds: [body.subjectPersonId],
        protected: true,
      });
    }

    return this.uow.run(async ({ trx }) => {
      const subject = await this.persons.findPerson(organizationId, body.subjectPersonId, trx);
      if (!subject || subject.status !== 'active') throw errors.protectedNotFound('person');
      const signer = await this.persons.findPerson(organizationId, signedByPersonId, trx);
      if (!signer || signer.status !== 'active') {
        throw errors.validation('The signer is not an active person of this organization.', {
          path: 'signedByPersonId',
        });
      }
      const policy = await trx
        .selectFrom('policy_versions')
        .select(['id', 'approval_status', 'kind'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', body.policyVersionId)
        .executeTakeFirst();
      if (!policy) throw errors.notFound('policy version', body.policyVersionId);
      if (policy.approval_status !== 'approved') {
        throw errors.validation('Only an approved policy version can be acknowledged.', {
          path: 'policyVersionId',
          approvalStatus: policy.approval_status,
        });
      }

      let basis: 'self' | 'guardian';
      if (signedByPersonId === body.subjectPersonId) {
        if (subject.kind !== 'adult') {
          throw errors.participantAuthorityRequired(
            'A child cannot acknowledge for themselves; a guardian holding complete_forms must sign.',
          );
        }
        basis = 'self';
      } else {
        const ok = await this.authority.hasPermission(
          organizationId,
          signedByPersonId,
          body.subjectPersonId,
          'complete_forms',
          trx,
        );
        if (!ok) {
          throw errors.participantAuthorityRequired(
            'The signer does not currently hold complete_forms over the participant.',
          );
        }
        basis = 'guardian';
      }

      const existing = await trx
        .selectFrom('acknowledgments')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', body.subjectPersonId)
        .where('policy_version_id', '=', body.policyVersionId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (existing) {
        throw errors.resourceConflict('An active acknowledgment of this policy already exists.', {
          acknowledgmentId: existing.id,
        });
      }

      const id = newId();
      const now = this.clock.now();
      let row;
      try {
        row = await trx
          .insertInto('acknowledgments')
          .values({
            id,
            organization_id: organizationId,
            subject_person_id: body.subjectPersonId,
            policy_version_id: body.policyVersionId,
            signed_by_person_id: signedByPersonId,
            basis,
            recorded_by: json(snapshotActor(principal)),
            recorded_by_kind:
              principal.kind === 'customer'
                ? 'customer'
                : principal.kind === 'system'
                  ? 'system'
                  : 'staff',
            recorded_by_person_id: principal.personId,
            signed_at: body.signedAt ? new Date(body.signedAt) : now,
            evidence: json(body.evidence),
            withdrawn_at: null,
            withdrawn_reason: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('An active acknowledgment of this policy already exists.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.acknowledgment_recorded',
        targetType: 'acknowledgment',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          subjectPersonId: body.subjectPersonId,
          policyVersionId: body.policyVersionId,
          signedByPersonId,
          basis,
          assistedByStaff: staffActor,
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.acknowledgmentRecorded, {
        organizationId,
        aggregateType: 'acknowledgment',
        aggregateId: id,
        payload: {
          acknowledgmentId: id,
          subjectPersonId: body.subjectPersonId,
          policyVersionId: body.policyVersionId,
          signedByPersonId,
          basis,
          assistedByStaff: staffActor,
        },
        correlationId,
      });
      return toAcknowledgment(row);
    });
  }

  /** Staff, or the signer giving up their own acknowledgment; strangers see NOT_FOUND. */
  async withdraw(
    principal: Principal,
    id: string,
    body: WithdrawAcknowledgmentInput,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    const organizationId = organizationOf(principal);
    const current = await this.db
      .selectFrom('acknowledgments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw errors.protectedNotFound('acknowledgment');
    await this.authorization.require(principal, CatalogActions.withdrawAcknowledgment, {
      type: 'acknowledgment',
      id,
      organizationId,
      subjectPersonIds: [current.signed_by_person_id],
      protected: true,
    });
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('acknowledgments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      assertExpectedRevision(body.expectedRevision, row.revision);
      if (row.status === 'withdrawn') {
        throw errors.invalidTransition('Acknowledgment', 'withdrawn', 'withdraw');
      }
      const updated = await trx
        .updateTable('acknowledgments')
        .set({
          status: 'withdrawn',
          withdrawn_at: this.clock.now(),
          withdrawn_reason: body.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.acknowledgment_withdrawn',
        targetType: 'acknowledgment',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, CatalogEvents.acknowledgmentWithdrawn, {
        organizationId,
        aggregateType: 'acknowledgment',
        aggregateId: id,
        payload: {
          acknowledgmentId: id,
          subjectPersonId: row.subject_person_id,
          policyVersionId: row.policy_version_id,
          reason: body.reason,
        },
        correlationId,
      });
      return toAcknowledgment(updated);
    });
  }

  async list(principal: Principal, query: ListAcknowledgmentsQuery): Promise<Acknowledgment[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readAcknowledgments, {
      type: 'acknowledgment',
      organizationId,
      subjectPersonIds: [query.subjectPersonId],
      protected: true,
    });
    let q = this.db
      .selectFrom('acknowledgments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', query.subjectPersonId)
      .orderBy('signed_at', 'desc')
      .orderBy('id');
    if (query.policyVersionId) q = q.where('policy_version_id', '=', query.policyVersionId);
    if (!query.includeWithdrawn) q = q.where('status', '=', 'active');
    return (await q.execute()).map(toAcknowledgment);
  }
}
