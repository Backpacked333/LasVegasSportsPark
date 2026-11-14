import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Acknowledgment,
  type ListAcknowledgmentsQuery,
  type Principal,
  type RecordAcknowledgmentInput,
  type RecordWaiverAcceptanceInput,
  type WithdrawAcknowledgmentInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
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
import { WaiverStatusReader } from './waiver-status.reader';

/** What `record` and `recordWaiverAcceptance` hand to the one signing path. */
interface SignedInput {
  subjectPersonId: string;
  /** Absent only for a waiver: the version in force is taken. */
  policyVersionId?: string;
  signedByPersonId?: string;
  signedAt?: string;
  evidence: Record<string, unknown>;
  reason?: string;
}

/** SPK-REG-011: the waiver family accepted and how (digitally, or from a signed paper). */
interface WaiverAcceptanceSpec {
  policyKey: string;
  method: 'digital' | 'paper';
  paperDatedOn: string | null;
}

const HOUR = 3_600_000;
/** Why a lapsed acceptance of the same version is closed when the person accepts again. */
export const WAIVER_RENEWED_REASON =
  'Superseded by a renewed acceptance of the same waiver version.';

/**
 * Policy acknowledgments (§4.4 Acknowledgment, SPK-REG-009, POL-037). The signer is always a
 * person who may sign: the adult subject themselves, or a guardian who currently holds
 * `complete_forms` over the participant (identity authority, never a staff role). A staff actor
 * who assists at the desk is recorded separately as `recorded_by` and can never be the signer;
 * the database refuses that row (acknowledgments_staff_never_signer).
 *
 * Subject-permission authorization runs before the transaction: the kernel consults the identity
 * port without a transaction handle, which would deadlock the single PGlite connection.
 *
 * A waiver acceptance (SPK-REG-011, proposed amendment PA-01) is an acknowledgment of a `waiver`
 * version and goes through the same signing path, so every rule above holds for it. It adds the
 * method: `digital`, or `paper`, which is only ever a staff entry naming the staff member and the
 * date on the paper and so never reads as a customer's digital signature (the database refuses
 * anything else, acknowledgments_paper_is_staff_entry).
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
    private readonly capabilities: CapabilityService,
    private readonly waivers: WaiverStatusReader,
  ) {}

  record(
    principal: Principal,
    body: RecordAcknowledgmentInput,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.recordSigned(principal, body, null, correlationId);
  }

  /**
   * SPK-REG-011 (proposed amendment PA-01; capability `liability_waivers`): a digital acceptance
   * by the adult or a guardian (or at the desk, where staff name the signer), or a signed paper
   * entered by staff with the date on it. A digital acceptance is of the version in force; the
   * signing time is always the server's.
   */
  recordWaiverAcceptance(
    principal: Principal,
    body: RecordWaiverAcceptanceInput,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.recordSigned(
      principal,
      {
        subjectPersonId: body.subjectPersonId,
        policyVersionId: body.policyVersionId,
        signedByPersonId: body.signedByPersonId,
        evidence: body.evidence,
        reason: body.reason,
      },
      {
        policyKey: body.policyKey,
        method: body.method,
        paperDatedOn: body.paperDatedOn ?? null,
      },
      correlationId,
    );
  }

  private async recordSigned(
    principal: Principal,
    body: SignedInput,
    waiver: WaiverAcceptanceSpec | null,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    const organizationId = organizationOf(principal);
    const action = waiver ? CatalogActions.acceptWaiver : CatalogActions.recordAcknowledgment;
    const method = waiver?.method ?? 'digital';
    if (method === 'paper' && (principal.kind !== 'staff' || !principal.personId)) {
      // SPK-REG-009, SPK-REG-011: paper is a staff entry by a named staff member, nothing else.
      throw errors.accessDenied(
        'A waiver signed on paper is recorded by a named staff member, with the date on the paper.',
        { action: action.id, code: 'PAPER_WAIVER_STAFF_ONLY' },
      );
    }
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
          { action: action.id },
        );
      }
      await this.authorization.require(principal, action, {
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
      await this.authorization.require(principal, action, {
        type: 'acknowledgment',
        organizationId,
        subjectPersonIds: [body.subjectPersonId],
        protected: true,
      });
    }

    return this.uow.run(async ({ trx }) => {
      if (waiver) await this.capabilities.require(organizationId, 'liability_waivers', trx);
      const now = this.clock.now();
      const subject = await this.persons.findPerson(organizationId, body.subjectPersonId, trx);
      if (!subject || subject.status !== 'active') throw errors.protectedNotFound('person');
      const signer = await this.persons.findPerson(organizationId, signedByPersonId, trx);
      if (!signer || signer.status !== 'active') {
        throw errors.validation('The signer is not an active person of this organization.', {
          path: 'signedByPersonId',
        });
      }
      const inForce = waiver
        ? ((await this.waivers.families(organizationId, now, [waiver.policyKey], trx)).get(
            waiver.policyKey,
          )?.inForce ?? null)
        : null;
      const policyVersionId = body.policyVersionId ?? inForce?.ref.policyVersionId;
      if (!policyVersionId) {
        throw errors.validation('No approved version of this waiver is in force.', {
          path: 'policyKey',
          code: 'WAIVER_NOT_IN_FORCE',
        });
      }
      const policy = await trx
        .selectFrom('policy_versions')
        .select(['id', 'approval_status', 'kind', 'key', 'effective_from', 'approved_at'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', policyVersionId)
        .executeTakeFirst();
      if (!policy) throw errors.notFound('policy version', policyVersionId);
      if (!waiver && policy.kind === 'waiver') {
        // One path records a waiver acceptance, so its method and the capability are never skipped.
        throw errors.validation('A waiver is accepted through the waiver acceptance command.', {
          path: 'policyVersionId',
          code: 'USE_WAIVER_ACCEPTANCE',
        });
      }
      if (waiver && (policy.kind !== 'waiver' || policy.key !== waiver.policyKey)) {
        throw errors.validation('The policy version is not a version of this waiver.', {
          path: 'policyVersionId',
        });
      }
      if (policy.approval_status !== 'approved') {
        throw errors.validation('Only an approved policy version can be acknowledged.', {
          path: 'policyVersionId',
          approvalStatus: policy.approval_status,
        });
      }
      if (waiver?.method === 'digital' && inForce?.ref.policyVersionId !== policy.id) {
        throw errors.validation('A waiver is accepted digitally in the version in force.', {
          path: 'policyVersionId',
          code: 'WAIVER_VERSION_NOT_IN_FORCE',
        });
      }
      if (waiver?.paperDatedOn) this.assertPaperDate(waiver.paperDatedOn, policy, now);
      // A waiver acceptance is always stamped by the server; a paper one carries the paper's date.
      const signedAt = waiver ? now : this.signedAt(principal, body, policy, now);

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
        .select(['id', 'revision'])
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', body.subjectPersonId)
        .where('policy_version_id', '=', policyVersionId)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        const lapsed =
          waiver !== null &&
          (
            await this.waivers.status(
              organizationId,
              body.subjectPersonId,
              waiver.policyKey,
              now,
              trx,
            )
          ).status !== 'current';
        if (!lapsed) {
          throw errors.resourceConflict('An active acknowledgment of this policy already exists.', {
            acknowledgmentId: existing.id,
            ...(waiver ? { code: 'WAIVER_ALREADY_CURRENT' } : {}),
          });
        }
        // SPK-REG-011: a renewal of the same version. One active acknowledgment per person and
        // version is a database rule, so the lapsed one is closed (and kept) before the new one.
        await this.supersede(trx, principal, organizationId, existing, {
          subjectPersonId: body.subjectPersonId,
          policyVersionId,
          correlationId,
        });
      }

      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('acknowledgments')
          .values({
            id,
            organization_id: organizationId,
            subject_person_id: body.subjectPersonId,
            policy_version_id: policyVersionId,
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
            signed_at: signedAt,
            evidence: json(body.evidence),
            method,
            paper_dated_on: waiver?.paperDatedOn ?? null,
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
          policyVersionId,
          signedByPersonId,
          basis,
          assistedByStaff: staffActor,
          signedAt: signedAt.toISOString(),
          // a backdated (paper) signature is visible next to the true occurred_at
          retrospective: body.signedAt !== undefined || method === 'paper',
          method,
          ...(waiver
            ? { waiverPolicyKey: waiver.policyKey, paperDatedOn: waiver.paperDatedOn }
            : {}),
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.acknowledgmentRecorded, {
        organizationId,
        aggregateType: 'acknowledgment',
        aggregateId: id,
        payload: {
          acknowledgmentId: id,
          subjectPersonId: body.subjectPersonId,
          policyVersionId,
          signedByPersonId,
          basis,
          assistedByStaff: staffActor,
        },
        correlationId,
      });
      return toAcknowledgment(row);
    });
  }

  /**
   * SPK-REG-009 signer evidence: a customer's signature is timestamped by the server. Staff (or a
   * system import) may enter a paper form signed earlier, but never in the future, never before
   * the policy version existed, and only with evidence of the paper record.
   */
  private signedAt(
    principal: Principal,
    body: SignedInput,
    policy: { effective_from: Date | string; approved_at: Date | string | null },
    now: Date,
  ): Date {
    if (body.signedAt === undefined) return now;
    if (principal.kind === 'customer') {
      throw errors.validation('A customer signature is timestamped by the server.', {
        path: 'signedAt',
      });
    }
    const signedAt = new Date(body.signedAt);
    if (signedAt.getTime() > now.getTime()) {
      throw errors.validation('A signature cannot be dated in the future.', {
        path: 'signedAt',
        code: 'signed_in_future',
      });
    }
    const earliest = Math.min(
      new Date(policy.effective_from).getTime(),
      policy.approved_at ? new Date(policy.approved_at).getTime() : Number.POSITIVE_INFINITY,
    );
    if (signedAt.getTime() < earliest) {
      throw errors.validation('A signature cannot predate the policy version it acknowledges.', {
        path: 'signedAt',
        code: 'signed_before_policy',
      });
    }
    if (Object.keys(body.evidence).length === 0) {
      throw errors.validation(
        'A signature entered with an earlier signing time needs evidence of the paper record.',
        { path: 'evidence' },
      );
    }
    return signedAt;
  }

  /**
   * SPK-REG-011: the date on a paper waiver is a calendar date with no zone. It is refused only
   * when it is in the future everywhere on earth, or when that day had ended everywhere before
   * the waiver version existed (the same two bounds a backdated signature has).
   */
  private assertPaperDate(
    paperDatedOn: string,
    policy: { effective_from: Date | string; approved_at: Date | string | null },
    now: Date,
  ): void {
    const dayStartUtc = new Date(`${paperDatedOn}T00:00:00.000Z`).getTime();
    if (dayStartUtc - 14 * HOUR > now.getTime()) {
      throw errors.validation('The date on the paper cannot be in the future.', {
        path: 'paperDatedOn',
        code: 'signed_in_future',
      });
    }
    const earliest = Math.min(
      new Date(policy.effective_from).getTime(),
      policy.approved_at ? new Date(policy.approved_at).getTime() : Number.POSITIVE_INFINITY,
    );
    if (dayStartUtc + 36 * HOUR < earliest) {
      throw errors.validation('The paper cannot be dated before the waiver version it accepts.', {
        path: 'paperDatedOn',
        code: 'signed_before_policy',
      });
    }
  }

  /** Closes a lapsed acceptance that a renewal of the same version replaces; the row is kept. */
  private async supersede(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    existing: { id: string; revision: number },
    context: { subjectPersonId: string; policyVersionId: string; correlationId: string | null },
  ): Promise<void> {
    const updated = await trx
      .updateTable('acknowledgments')
      .set({
        status: 'withdrawn',
        withdrawn_at: this.clock.now(),
        withdrawn_reason: WAIVER_RENEWED_REASON,
        revision: existing.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', existing.id)
      .where('revision', '=', existing.revision)
      .returning('revision')
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: 'catalog.acknowledgment_withdrawn',
      targetType: 'acknowledgment',
      targetId: existing.id,
      beforeRevision: existing.revision,
      afterRevision: updated.revision,
      reason: WAIVER_RENEWED_REASON,
      correlationId: context.correlationId,
      details: { supersededByRenewal: true },
    });
    await this.outbox.enqueue(trx, CatalogEvents.acknowledgmentWithdrawn, {
      organizationId,
      aggregateType: 'acknowledgment',
      aggregateId: existing.id,
      payload: {
        acknowledgmentId: existing.id,
        subjectPersonId: context.subjectPersonId,
        policyVersionId: context.policyVersionId,
        reason: WAIVER_RENEWED_REASON,
      },
      correlationId: context.correlationId,
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
