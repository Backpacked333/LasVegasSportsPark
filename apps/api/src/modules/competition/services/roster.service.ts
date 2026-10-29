import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  hasStaffRole,
  newId,
  systemPrincipal,
  z,
  type AcceptTeamInvitationInput,
  type ChangeRosterInput,
  type CreateJoinRequestInput,
  type CreateTeamInvitationInput,
  type DeclineTeamInvitationInput,
  type DecideJoinRequestInput,
  type DomainEvent,
  type EligibilityEvaluation,
  type EligibilityQuery,
  type HandoverTeamRoleInput,
  type JoinRequest,
  type JoinRequestDecided,
  type ListMyTeamInvitationsQuery,
  type Page,
  type Principal,
  type RevokeTeamInvitationInput,
  type RosterMember,
  type RosterPlayingStatus,
  type RosterQuery,
  type RosterResponse,
  type RuleSetContent,
  type TeamInvitation,
  type TeamInvitationAccepted,
  type TeamInvitationIssued,
  type TeamInvitationView,
  type TeamRoleHandover,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type JoinRequestStatus,
  type RosterSource,
  type TeamInvitationsTable,
  type TeamInvitationStatus,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type HandlerContext,
  type PeriodicJobContext,
  type PeriodicJobResult,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { MERGED_ROSTER_DUPLICATE } from '../competition-matches.policy';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { TEAM_INVITATION_DEFAULT_HOURS, TEAM_INVITATION_EXPIRY_JOB } from '../competition.policy';
import {
  effectiveRoles,
  loadEntryContext,
  openRosterRow,
  rolesByPerson,
  rosterRowsEffectiveAt,
  statusAt,
  type EntryContext,
  type Reader,
  type RosterRow,
} from '../competition.queries';
import {
  hashToken,
  hoursFromNow,
  isEffectiveAt,
  isStaffLike,
  iso,
  newToken,
  organizationOf,
  toJoinRequest,
  toTeamInvitation,
  toTeamRole,
} from '../competition.shared';
import { JoinRequestMachine, TeamInvitationMachine } from '../competition.state-machines';
import type { EffectiveRosterMember, RosterPort } from '../ports';
import { EligibilityService } from './eligibility.service';
import { TeamEntriesService, indicatorOf, teammateView } from './team-entries.service';

/**
 * Rosters, invitations and join requests (SPK-COMP-005, SPK-CAP-001/002/004, SPK-AT-002/013).
 * Every addition re-evaluates eligibility at its effective instant through EligibilityService;
 * every removal closes the row (effective_to) and keeps it. Pending invitations and requests
 * are placeholder roster rows closed when resolved, so one open row per person per entry is a
 * database guarantee.
 */
@Injectable()
export class RosterService implements RosterPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly people: PeopleService,
    private readonly eligibility: EligibilityService,
    private readonly entries: TeamEntriesService,
    private readonly exceptions: OperationalExceptions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Roster changes with effective dates (SPK-COMP-005)
  // -------------------------------------------------------------------------------------------
  /**
   * Adds and removals take effect now or at a later instant. A change dated before now rewrites
   * the roster of matches already played (SPK-COMP-005: a player removed today stays on last
   * week's roster), so only league staff may make one, with a reason, and it is audited as a
   * retroactive correction (§4.7 invariant 9). A completed or archived season takes no change at
   * all: its rosters are history (SPK-AT-003).
   */
  async changeRoster(
    principal: Principal,
    teamEntryId: string,
    input: ChangeRosterInput,
    correlationId: string | null,
  ): Promise<RosterResponse> {
    const organizationId = organizationOf(principal);
    const staff = isStaffLike(principal);
    const leagueStaff =
      principal.kind === 'system' ||
      hasStaffRole(principal, ...CompetitionActions.manageRoster.staffRoles);
    const now = this.clock.now();
    const dated = input.changes.map((change) => {
      const explicit = change.action === 'add' ? change.effectiveFrom : change.effectiveTo;
      const at = explicit ? new Date(explicit) : now;
      return { change, at, retroactive: at.getTime() < now.getTime() };
    });
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, teamEntryId, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      await this.authorization.require(principal, CompetitionActions.manageRoster, {
        type: 'team_entry',
        id: teamEntryId,
        organizationId,
        teamEntryId,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, context.entry.revision);
      if (context.season.status === 'completed' || context.season.status === 'archived') {
        throw errors.invalidTransition('Season', context.season.status, 'change_roster');
      }
      for (const { change, retroactive } of dated) {
        if (!retroactive) continue;
        const field = change.action === 'add' ? 'effectiveFrom' : 'effectiveTo';
        if (!leagueStaff) {
          throw errors.validation(
            'Roster changes take effect now or later; ask league management to correct a past roster.',
            { code: 'retroactive_roster_change', personId: change.personId, field, now: iso(now) },
          );
        }
        if (!input.reason) {
          throw errors.validation('A retroactive roster correction requires a reason.', {
            code: 'correction_reason_required',
            personId: change.personId,
            field,
          });
        }
      }
      await this.lockSeasonMemberships(
        trx,
        organizationId,
        context.entry.season_id,
        dated.filter((d) => d.change.action === 'add').map((d) => d.change.personId),
      );
      for (const { change, at, retroactive } of dated) {
        const correction = retroactive ? { reason: input.reason ?? null, recordedAt: now } : null;
        if (change.action === 'add') {
          await this.addMember(trx, principal, context, {
            personId: change.personId,
            status: change.status,
            effectiveFrom: at,
            jerseyNumber: change.jerseyNumber ?? null,
            source: staff ? 'staff' : 'captain',
            actorIsStaff: staff,
            correlationId,
            correction,
          });
        } else {
          await this.removeMember(
            trx,
            principal,
            context,
            change.personId,
            at,
            change.reason,
            correlationId,
            correction,
          );
        }
      }
      await trx
        .updateTable('team_entries')
        .set({ revision: context.entry.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', teamEntryId)
        .where('revision', '=', context.entry.revision)
        .execute();
      const refreshed = await loadEntryContext(trx, organizationId, teamEntryId);
      if (!refreshed) throw errors.internal('team entry vanished');
      return this.rosterView(trx, refreshed, now, false);
    });
  }

  /** Effective roster at an instant; history includes pending and removed rows (captain or staff). */
  async listRoster(
    principal: Principal,
    teamEntryId: string,
    query: RosterQuery,
  ): Promise<RosterResponse> {
    const organizationId = organizationOf(principal);
    const context = await loadEntryContext(this.db, organizationId, teamEntryId);
    if (!context) throw errors.protectedNotFound('team_entry');
    const now = this.clock.now();
    const at = query.at ? new Date(query.at) : now;
    const playing = await rosterRowsEffectiveAt(this.db, organizationId, teamEntryId, now);
    const roles = await effectiveRoles(this.db, organizationId, teamEntryId, now);
    const viewer = await this.entries.viewerOf(principal, context, playing, roles, now);
    if (query.includeHistory && !viewer.canManage) throw errors.protectedNotFound('team_entry');
    const view = await this.rosterView(this.db, context, at, query.includeHistory);
    if (viewer.canManage) return view;
    // SPK-CAP-002 / SPK-DISC-004: ordinary viewers get no removal reasons or other players' codes
    return { ...view, members: view.members.map((m) => teammateView(m, principal.personId)) };
  }

  /** Explain a player's eligibility for the entry (captain or staff only, SPK-CAP-004). */
  async explainEligibility(
    principal: Principal,
    teamEntryId: string,
    query: EligibilityQuery,
  ): Promise<EligibilityEvaluation> {
    const organizationId = organizationOf(principal);
    const context = await loadEntryContext(this.db, organizationId, teamEntryId);
    if (!context) throw errors.protectedNotFound('team_entry');
    const now = this.clock.now();
    const playing = await rosterRowsEffectiveAt(this.db, organizationId, teamEntryId, now);
    const roles = await effectiveRoles(this.db, organizationId, teamEntryId, now);
    const viewer = await this.entries.viewerOf(principal, context, playing, roles, now);
    if (!viewer.canManage) throw errors.protectedNotFound('team_entry');
    const open = await openRosterRow(this.db, organizationId, teamEntryId, query.personId);
    return this.eligibility.evaluateInContext(
      this.db,
      context,
      query.personId,
      query.at ? new Date(query.at) : now,
      {
        membershipStatus: query.status,
        actorIsStaff: isStaffLike(principal),
        existingMembership: open !== null && statusAt(open) !== null,
        // SPK-CAP-002 / SPK-DISC-004: captains get codes, limits and dates, never restricted detail
        restricted: !isStaffLike(principal),
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Invitations (§4.8 POST /team-entries/{id}/invitations)
  // -------------------------------------------------------------------------------------------
  async invite(
    principal: Principal,
    teamEntryId: string,
    input: CreateTeamInvitationInput,
    correlationId: string | null,
  ): Promise<TeamInvitationIssued> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const id = newId();
    const token = newToken();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, teamEntryId, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      await this.authorization.require(principal, CompetitionActions.invitePlayer, {
        type: 'team_entry',
        id: teamEntryId,
        organizationId,
        teamEntryId,
        protected: true,
      });
      this.assertEntryTakesPlayers(context, 'invite');
      let recipientPersonId: string | null = null;
      let preview: TeamInvitationIssued['eligibilityPreview'] = null;
      let membershipId: string | null = null;
      if (input.recipientPersonId) {
        const recipient = await this.people.loadPerson(
          trx,
          organizationId,
          input.recipientPersonId,
        );
        if (!recipient || recipient.status !== 'active') {
          throw errors.notFound('person', input.recipientPersonId);
        }
        recipientPersonId = recipient.id;
        const evaluation = await this.eligibility.evaluateInContext(
          trx,
          context,
          recipient.id,
          now,
          {
            membershipStatus: 'active',
            actorIsStaff: isStaffLike(principal),
            restricted: !isStaffLike(principal),
          },
          trx,
        );
        preview = indicatorOf(evaluation);
        if (!evaluation.eligible) {
          // Captains learn the reason codes, never the private details behind them (SPK-CAP-002).
          throw errors.eligibility('The invited person is not eligible for this roster.', {
            personId: recipient.id,
            reasons: evaluation.reasons,
          });
        }
        membershipId = await this.openPendingRow(
          trx,
          principal,
          context,
          recipient.id,
          'invited',
          'invitation',
          now,
        );
      }
      const contact = input.recipientContact
        ? {
            kind: input.recipientContact.kind,
            value:
              input.recipientContact.kind === 'email'
                ? input.recipientContact.value.trim().toLowerCase()
                : input.recipientContact.value.trim(),
          }
        : null;
      const expiresAt = hoursFromNow(now, input.expiresInHours ?? TEAM_INVITATION_DEFAULT_HOURS);
      try {
        await trx
          .insertInto('team_invitations')
          .values({
            id,
            organization_id: organizationId,
            team_entry_id: teamEntryId,
            invited_by: json(snapshotActor(principal)),
            invited_by_person_id: principal.personId,
            recipient_person_id: recipientPersonId,
            recipient_contact_kind: contact?.kind ?? null,
            recipient_contact_value: contact?.value ?? null,
            message: input.message ?? null,
            token_hash: hashToken(token),
            expires_at: expiresAt,
            accepted_at: null,
            accepted_by_person_id: null,
            declined_at: null,
            revoked_at: null,
            revoked_by: null,
            revocation_reason: null,
            roster_membership_id: membershipId,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A pending invitation already exists for this recipient.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.invitePlayer.id,
        targetType: 'team_invitation',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          teamEntryId,
          recipientPersonId,
          recipientContactKind: contact?.kind ?? null,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamInvitationCreated, {
        organizationId,
        aggregateType: 'team_invitation',
        aggregateId: id,
        payload: {
          invitationId: id,
          teamEntryId,
          recipientPersonId,
          recipientContactKind: contact?.kind ?? null,
          expiresAt: expiresAt.toISOString(),
        },
        correlationId,
      });
      const row = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return { ...toTeamInvitation(row), token, eligibilityPreview: preview };
    });
  }

  async accept(
    principal: Principal,
    invitationId: string,
    input: AcceptTeamInvitationInput,
    correlationId: string | null,
  ): Promise<TeamInvitationAccepted> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    await this.expireIfDue(
      principal,
      organizationId,
      invitationId,
      input.token,
      now,
      correlationId,
    );
    return this.uow.run(async ({ trx }) => {
      const invitation = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitationId)
        .forUpdate()
        .executeTakeFirst();
      if (!invitation) throw errors.protectedNotFound('team_invitation');
      // The token is the secret only the recipient holds: without it nothing is revealed (§4.10).
      if (hashToken(input.token) !== invitation.token_hash) {
        throw errors.protectedNotFound('team_invitation');
      }
      if (invitation.status === 'pending' && new Date(invitation.expires_at) <= now) {
        // Expired between the pre-check and this lock; the next attempt records the expiry.
        throw errors.invalidTransition('TeamInvitation', 'expired', 'accept');
      }
      TeamInvitationMachine.next(invitation.status, 'accept');
      const personId = input.personId ?? principal.personId;
      if (!personId) throw errors.accessDenied('Link your account to a person before accepting.');
      if (invitation.recipient_person_id) {
        if (invitation.recipient_person_id !== personId)
          throw errors.protectedNotFound('team_invitation');
      } else if (invitation.recipient_contact_kind && invitation.recipient_contact_value) {
        const detail = await this.people.detail(trx, organizationId, personId);
        const holds = detail.contactPoints.some(
          (c) =>
            c.kind === invitation.recipient_contact_kind &&
            c.value === invitation.recipient_contact_value &&
            c.verifiedAt !== null,
        );
        if (!holds) {
          throw errors.accessDenied(
            'Accepting requires a verified contact point matching the invitation.',
          );
        }
      }
      await this.authorization.require(principal, CompetitionActions.acceptTeamInvitation, {
        type: 'team_invitation',
        id: invitationId,
        organizationId,
        subjectPersonIds: [personId],
        protected: true,
      });
      const context = await loadEntryContext(trx, organizationId, invitation.team_entry_id, {
        forUpdate: true,
      });
      if (!context) throw errors.protectedNotFound('team_entry');
      this.assertEntryTakesPlayers(context, 'accept_invitation');
      if (invitation.roster_membership_id) {
        await this.closePendingRow(trx, organizationId, invitation.roster_membership_id, now);
      } else {
        const open = await openRosterRow(trx, organizationId, context.entry.id, personId);
        if (open && statusAt(open) === null)
          await this.closePendingRow(trx, organizationId, open.id, now);
      }
      const membership = await this.addMember(trx, principal, context, {
        personId,
        status: 'active',
        effectiveFrom: now,
        jerseyNumber: null,
        source: 'invitation',
        actorIsStaff: false,
        correlationId,
      });
      await this.resolveInvitation(
        trx,
        principal,
        invitation.id,
        invitation.team_entry_id,
        null,
        'accept',
        { accepted_at: now, accepted_by_person_id: personId, roster_membership_id: membership.id },
        personId,
        now,
        correlationId,
      );
      const row = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow();
      return { invitation: toTeamInvitation(row), membership };
    });
  }

  async revoke(
    principal: Principal,
    invitationId: string,
    input: RevokeTeamInvitationInput,
    correlationId: string | null,
  ): Promise<TeamInvitation> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const invitation = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitationId)
        .forUpdate()
        .executeTakeFirst();
      if (!invitation) throw errors.protectedNotFound('team_invitation');
      await this.authorization.require(principal, CompetitionActions.revokeTeamInvitation, {
        type: 'team_invitation',
        id: invitationId,
        organizationId,
        teamEntryId: invitation.team_entry_id,
        protected: true,
      });
      TeamInvitationMachine.next(invitation.status, 'revoke');
      await this.resolveInvitation(
        trx,
        principal,
        invitation.id,
        invitation.team_entry_id,
        invitation.roster_membership_id,
        'revoke',
        {
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
        },
        invitation.recipient_person_id,
        now,
        correlationId,
      );
      const row = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow();
      return toTeamInvitation(row);
    });
  }

  /**
   * Pending invitations expire lazily: an acceptance attempt past `expires_at` records the expiry
   * (and closes the placeholder roster row) in its own transaction, because the attempt itself is
   * refused and rolled back. Only a caller presenting the token triggers it, so probing an id
   * reveals nothing (§4.10). No background sweeper exists yet (README "Known gaps").
   */
  // -------------------------------------------------------------------------------------------
  // Invitation reads, decline and expiry (CMP-03, CMP-07; SPK-CAP-001, §4.6, §4.10, §4.12)
  // -------------------------------------------------------------------------------------------
  /**
   * `GET /v1/team-invitations/{id}`: the recipient (or a guardian holding register for a child
   * recipient), the entry's captain and co-captains, and league staff; anyone else gets protected
   * NOT_FOUND. The token is never returned.
   */
  async getInvitation(principal: Principal, invitationId: string): Promise<TeamInvitationView> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const row = await db
      .selectFrom('team_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', invitationId)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('team_invitation');
    if (!(await this.mayReadInvitation(db, principal, row))) {
      throw errors.protectedNotFound('team_invitation');
    }
    const [view] = await this.invitationViews(db, organizationId, [row]);
    return view as TeamInvitationView;
  }

  /**
   * `GET /v1/me/team-invitations`: invitations addressed to the acting person or to one of their
   * verified contact points (the rule acceptance applies), newest first.
   */
  async listMyInvitations(
    principal: Principal,
    query: ListMyTeamInvitationsQuery,
  ): Promise<Page<TeamInvitationView>> {
    const organizationId = organizationOf(principal);
    const personId = principal.personId;
    if (!personId) return { items: [], nextCursor: null };
    await this.authorization.require(principal, CompetitionActions.readTeamInvitation, {
      type: 'team_invitation',
      organizationId,
      subjectPersonIds: [personId],
    });
    const db = executorFor(this.db);
    const contacts = await this.verifiedContacts(db, organizationId, personId);
    const cursor = decodeCursor(query.cursor, InvitationCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = db
      .selectFrom('team_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', query.status)
      .where((eb) =>
        eb.or([
          eb('recipient_person_id', '=', personId),
          ...contacts.map((c) =>
            eb.and([
              eb('recipient_contact_kind', '=', c.kind),
              eb('recipient_contact_value', '=', c.value),
            ]),
          ),
        ]),
      );
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('created_at', '<', at),
          eb.and([eb('created_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: await this.invitationViews(db, organizationId, page),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: iso(last.created_at), id: last.id })
          : null,
    };
  }

  /**
   * `POST /v1/team-invitations/{id}/decline` (CMP-03): the recipient (or a guardian holding
   * register for a child recipient) declines a pending invitation, which can then no longer be
   * accepted. Locked row, TeamInvitationMachine 'decline', declined_at, audit and
   * competition.team_invitation_resolved 'declined' naming the person.
   */
  async decline(
    principal: Principal,
    invitationId: string,
    input: DeclineTeamInvitationInput,
    correlationId: string | null,
  ): Promise<TeamInvitationView> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const invitation = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitationId)
        .forUpdate()
        .executeTakeFirst();
      if (!invitation) throw errors.protectedNotFound('team_invitation');
      const subject = await this.recipientSubject(trx, principal, invitation);
      if (!subject) throw errors.protectedNotFound('team_invitation');
      await this.authorization.require(principal, CompetitionActions.declineTeamInvitation, {
        type: 'team_invitation',
        id: invitationId,
        organizationId,
        subjectPersonIds: [subject],
        protected: true,
      });
      if (invitation.status === 'pending' && new Date(invitation.expires_at) <= now) {
        // Past its expiry: the sweep (or the next acceptance attempt) records the expiry.
        throw errors.invalidTransition('TeamInvitation', 'expired', 'decline');
      }
      TeamInvitationMachine.next(invitation.status, 'decline');
      await this.resolveInvitation(
        trx,
        principal,
        invitation.id,
        invitation.team_entry_id,
        invitation.roster_membership_id,
        'decline',
        { declined_at: now },
        subject,
        now,
        correlationId,
        { reason: input.reason ?? null },
      );
      const row = await trx
        .selectFrom('team_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow();
      const [view] = await this.invitationViews(trx, organizationId, [row]);
      return view as TeamInvitationView;
    });
  }

  /**
   * CMP-07 (IF-24, §4.12): the periodic job `competition.expire_team_invitations`. Pending
   * invitations past `expires_at` are claimed with SKIP LOCKED and expired one per transaction
   * through the TeamInvitationMachine, audited with the system-only action
   * competition.expire_team_invitation and announced (status expired, personId null). A replayed
   * run finds nothing due and changes nothing. Expiry durations are unchanged.
   */
  async expireDueInvitations({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const due = await this.db
      .selectFrom('team_invitations')
      .select(['id', 'organization_id'])
      .where('status', '=', 'pending')
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .orderBy('id')
      .limit(batchSize)
      .execute();
    let processed = 0;
    for (const candidate of due) {
      const expired = await this.uow.run(async ({ trx }) => {
        const row = await trx
          .selectFrom('team_invitations')
          .selectAll()
          .where('organization_id', '=', candidate.organization_id)
          .where('id', '=', candidate.id)
          .where('status', '=', 'pending')
          .where('expires_at', '<=', now)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return false;
        const system = systemPrincipal(row.organization_id, TEAM_INVITATION_EXPIRY_JOB.name);
        await this.authorization.require(system, CompetitionActions.expireTeamInvitation, {
          type: 'team_invitation',
          id: row.id,
          organizationId: row.organization_id,
        });
        await this.resolveInvitation(
          trx,
          system,
          row.id,
          row.team_entry_id,
          row.roster_membership_id,
          'expire',
          {},
          null,
          now,
          null,
          { auditAction: CompetitionActions.expireTeamInvitation.id },
        );
        return true;
      });
      if (expired) processed += 1;
    }
    const remaining = await this.db
      .selectFrom('team_invitations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'pending')
      .where('expires_at', '<=', now)
      .executeTakeFirstOrThrow();
    // A row another transaction holds is skipped now and found by the next run.
    return { processed, remaining: processed === 0 ? 0 : Number(remaining.n) };
  }

  /** Whether the principal may read the invitation (recipient, guardian, captains, league staff). */
  private async mayReadInvitation(
    db: Reader,
    principal: Principal,
    row: Selectable<TeamInvitationsTable>,
  ): Promise<boolean> {
    const base = {
      type: 'team_invitation',
      id: row.id,
      organizationId: row.organization_id,
      protected: true,
    };
    const action = CompetitionActions.readTeamInvitation;
    if (
      isStaffLike(principal) &&
      (await this.authorization.decide(principal, action, base)).allowed
    ) {
      return true;
    }
    const subject = await this.recipientSubject(db, principal, row);
    if (
      subject &&
      (await this.authorization.decide(principal, action, { ...base, subjectPersonIds: [subject] }))
        .allowed
    ) {
      return true;
    }
    return (
      await this.authorization.decide(principal, action, {
        ...base,
        teamEntryId: row.team_entry_id,
      })
    ).allowed;
  }

  /**
   * The recipient the principal acts for: themselves when the invitation names them or one of
   * their verified contact points, or the named child they may hold register over (decided by the
   * kernel); null when the invitation is not theirs.
   */
  private async recipientSubject(
    db: Reader,
    principal: Principal,
    row: Selectable<TeamInvitationsTable>,
  ): Promise<string | null> {
    const personId = principal.personId;
    if (!personId) return null;
    if (row.recipient_person_id) return row.recipient_person_id;
    if (row.recipient_contact_kind && row.recipient_contact_value) {
      const contacts = await this.verifiedContacts(db, row.organization_id, personId);
      const holds = contacts.some(
        (c) => c.kind === row.recipient_contact_kind && c.value === row.recipient_contact_value,
      );
      return holds ? personId : null;
    }
    return null;
  }

  private async verifiedContacts(
    db: Reader,
    organizationId: string,
    personId: string,
  ): Promise<Array<{ kind: 'email' | 'phone'; value: string }>> {
    const person = await this.people.loadPerson(db, organizationId, personId);
    if (!person) return [];
    const detail = await this.people.detail(db, organizationId, personId);
    return detail.contactPoints
      .filter((c) => c.verifiedAt !== null && (c.kind === 'email' || c.kind === 'phone'))
      .map((c) => ({ kind: c.kind as 'email' | 'phone', value: c.value }));
  }

  /** Invitations as readers see them: team and season names, inviter's name, never the token. */
  private async invitationViews(
    db: Reader,
    organizationId: string,
    rows: Array<Selectable<TeamInvitationsTable>>,
  ): Promise<TeamInvitationView[]> {
    if (rows.length === 0) return [];
    const entryIds = [...new Set(rows.map((r) => r.team_entry_id))];
    const entries = await db
      .selectFrom('team_entries')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.organization_id', '=', 'team_entries.organization_id')
          .onRef('teams.id', '=', 'team_entries.team_id'),
      )
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.organization_id', '=', 'team_entries.organization_id')
          .onRef('seasons.id', '=', 'team_entries.season_id'),
      )
      .select(['team_entries.id', 'teams.name as team_name', 'seasons.name as season_name'])
      .where('team_entries.organization_id', '=', organizationId)
      .where('team_entries.id', 'in', entryIds)
      .execute();
    const byEntry = new Map(entries.map((e) => [e.id, e]));
    const inviters = new Map<string, string>();
    for (const inviterId of new Set(rows.map((r) => r.invited_by_person_id))) {
      if (!inviterId) continue;
      const person = await this.people.loadPerson(db, organizationId, inviterId);
      if (person) inviters.set(inviterId, `${person.given_name} ${person.family_name}`.trim());
    }
    const now = this.clock.now();
    return rows.map((row) => {
      const entry = byEntry.get(row.team_entry_id);
      const inviterName = row.invited_by_person_id
        ? inviters.get(row.invited_by_person_id)
        : undefined;
      return {
        id: row.id,
        teamEntryId: row.team_entry_id,
        teamName: entry?.team_name ?? 'Unknown team',
        seasonName: entry?.season_name ?? '',
        invitedBy:
          row.invited_by_person_id && inviterName
            ? { personId: row.invited_by_person_id, displayName: inviterName }
            : null,
        message: row.message,
        status: row.status,
        effectiveStatus:
          row.status === 'pending' && new Date(row.expires_at) <= now ? 'expired' : row.status,
        expiresAt: iso(row.expires_at),
        revision: row.revision,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Person merge follow-up (CMP-08; SPK-IAM-007, SPK-COMP-005, §4.7 invariant 2, §4.2)
  // -------------------------------------------------------------------------------------------
  /**
   * `identity.persons_merged` (IF-21): competition never rewrites a person id in its history
   * (roster, role, result and discipline rows keep the id they were recorded with; reads resolve
   * merges through personIdsResolvingTo). When the survivor and the merged person both hold an
   * open roster row or an open team role on the same entry, the duplicate the roster invariants
   * forbid is surfaced once per merge to the league manager (dedupe key by merge id).
   */
  async followPersonMerge(
    event: DomainEvent<{
      mergeId: string;
      survivorPersonId: string;
      mergedPersonId: string;
      operationId: string;
    }>,
    ctx: HandlerContext,
  ): Promise<void> {
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const organizationId = event.organizationId;
    if (survivorPersonId === mergedPersonId) return;
    const now = this.clock.now();
    const holdings = async (personId: string): Promise<Set<string>> => {
      const rows = await ctx.trx
        .selectFrom('roster_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
        .execute();
      const roles = await ctx.trx
        .selectFrom('team_roles')
        .select('team_entry_id')
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
        .execute();
      return new Set([
        ...rows.filter((r) => statusAt(r) !== null).map((r) => r.team_entry_id),
        ...roles.map((r) => r.team_entry_id),
      ]);
    };
    const survivor = await holdings(survivorPersonId);
    const merged = await holdings(mergedPersonId);
    const teamEntryIds = [...survivor].filter((id) => merged.has(id)).sort();
    if (teamEntryIds.length === 0) return;
    await this.exceptions.raise(ctx.trx, {
      organizationId,
      category: MERGED_ROSTER_DUPLICATE.category,
      severity: MERGED_ROSTER_DUPLICATE.severity,
      title: 'A person merge left two roster memberships or roles on one team entry',
      affectedType: 'person_merge',
      affectedId: mergeId,
      ownerQueue: MERGED_ROSTER_DUPLICATE.ownerQueue,
      dedupeKey: `merged_roster_duplicate:${mergeId}`,
      details: { mergeId, survivorPersonId, mergedPersonId, teamEntryIds },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Team role handover (CMP-13; SPK-COMP-005, SPK-CAP-001, §4.9)
  // -------------------------------------------------------------------------------------------
  /**
   * `POST /v1/team-entries/{id}/roles/handover`: the current captain (handing over their own
   * captaincy, or a co-captaincy) or league staff passes a role to an effective active roster
   * member who is eligible under the rule set (a captain is an adult, the proposed default the
   * entry's creation applies). The outgoing row, any other open role row of the new holder, and
   * the new row change at one instant in one unit of work; roleHolders answers the new holder at
   * once.
   */
  async handoverRole(
    principal: Principal,
    teamEntryId: string,
    input: HandoverTeamRoleInput,
    correlationId: string | null,
  ): Promise<TeamRoleHandover> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, teamEntryId, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      await this.authorization.require(principal, CompetitionActions.handoverTeamRole, {
        type: 'team_entry',
        id: teamEntryId,
        organizationId,
        teamEntryId,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, context.entry.revision);
      this.assertEntryTakesPlayers(context, 'handover_role');
      if (context.season.status === 'completed' || context.season.status === 'archived') {
        throw errors.invalidTransition('Season', context.season.status, 'handover_role');
      }
      if (
        !isStaffLike(principal) &&
        input.role === 'captain' &&
        input.fromPersonId !== principal.personId
      ) {
        throw errors.accessDenied('Only the current captain hands over the captaincy.', {
          action: CompetitionActions.handoverTeamRole.id,
        });
      }
      const open = await trx
        .selectFrom('team_roles')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('team_entry_id', '=', teamEntryId)
        .where('person_id', 'in', [input.fromPersonId, input.toPersonId])
        .where('effective_to', 'is', null)
        .where('effective_from', '<=', now)
        .forUpdate()
        .execute();
      const outgoing = open.find(
        (r) => r.person_id === input.fromPersonId && r.role === input.role,
      );
      if (!outgoing) {
        throw errors.validation(`The person does not hold the ${input.role} role on this entry.`, {
          code: 'ROLE_NOT_HELD',
          personId: input.fromPersonId,
          role: input.role,
        });
      }
      const incumbent = open.find((r) => r.person_id === input.toPersonId) ?? null;
      if (incumbent && (incumbent.role === input.role || incumbent.role === 'captain')) {
        throw errors.validation('The person already holds this or a higher role on the entry.', {
          code: 'ROLE_ALREADY_HELD',
          personId: input.toPersonId,
          role: incumbent.role,
        });
      }
      const membership = await openRosterRow(trx, organizationId, teamEntryId, input.toPersonId);
      if (!membership || statusAt(membership) !== 'active' || !isEffectiveAt(membership, now)) {
        throw errors.validation('The new holder must be an active member of the roster.', {
          code: 'NOT_ON_ROSTER',
          personId: input.toPersonId,
        });
      }
      const person = await this.people.loadPerson(trx, organizationId, input.toPersonId);
      if (input.role === 'captain' && person?.kind !== 'adult') {
        // Proposed default pending the guardian/child-account policy decision (§6.6).
        throw errors.validation('A team captain must be an adult.', {
          code: 'CAPTAIN_MUST_BE_ADULT',
        });
      }
      const evaluation = await this.eligibility.evaluateInContext(
        trx,
        context,
        input.toPersonId,
        now,
        {
          membershipStatus: 'active',
          existingMembership: true,
          actorIsStaff: isStaffLike(principal),
          restricted: !isStaffLike(principal),
        },
        trx,
      );
      if (!evaluation.eligible) {
        throw errors.eligibility('The new holder is not eligible under the rule set.', {
          personId: input.toPersonId,
          reasons: evaluation.reasons,
        });
      }
      const ended = [outgoing, ...(incumbent ? [incumbent] : [])];
      for (const row of ended) {
        await trx
          .updateTable('team_roles')
          .set({
            effective_to: now,
            ended_by: json(snapshotActor(principal)),
            ended_reason: row.id === outgoing.id ? input.reason : `handover: ${input.role}`,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.id)
          .execute();
      }
      const newRoleId = newId();
      await trx
        .insertInto('team_roles')
        .values({
          id: newRoleId,
          organization_id: organizationId,
          team_entry_id: teamEntryId,
          person_id: input.toPersonId,
          role: input.role,
          effective_from: now,
          effective_to: null,
          assigned_by: json(snapshotActor(principal)),
          ended_by: null,
          ended_reason: null,
        })
        .execute();
      const entryRevision = context.entry.revision + 1;
      await trx
        .updateTable('team_entries')
        .set({ revision: entryRevision })
        .where('organization_id', '=', organizationId)
        .where('id', '=', teamEntryId)
        .where('revision', '=', context.entry.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.handoverTeamRole.id,
        targetType: 'team_entry',
        targetId: teamEntryId,
        beforeRevision: context.entry.revision,
        afterRevision: entryRevision,
        reason: input.reason,
        correlationId,
        details: {
          role: input.role,
          fromPersonId: input.fromPersonId,
          toPersonId: input.toPersonId,
          effectiveAt: now.toISOString(),
          endedRoleIds: ended.map((r) => r.id),
          newRoleId,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamRoleChanged, {
        organizationId,
        aggregateType: 'team_entry',
        aggregateId: teamEntryId,
        payload: {
          teamEntryId,
          personId: input.toPersonId,
          role: input.role,
          change: 'handed_over',
          fromPersonId: input.fromPersonId,
          toPersonId: input.toPersonId,
          effectiveAt: now.toISOString(),
        },
        correlationId,
      });
      const roles = await effectiveRoles(trx, organizationId, teamEntryId, now);
      return {
        teamEntryId,
        role: input.role,
        fromPersonId: input.fromPersonId,
        toPersonId: input.toPersonId,
        effectiveAt: now.toISOString(),
        roles: roles.map(toTeamRole),
        entryRevision,
      };
    });
  }

  private async expireIfDue(
    principal: Principal,
    organizationId: string,
    invitationId: string,
    token: string,
    now: Date,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.db
      .selectFrom('team_invitations')
      .select(['id', 'status', 'expires_at', 'token_hash', 'team_entry_id', 'roster_membership_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', invitationId)
      .executeTakeFirst();
    if (!row || row.status !== 'pending' || new Date(row.expires_at) > now) return;
    if (hashToken(token) !== row.token_hash) return;
    await this.uow.run(async ({ trx }) => {
      const locked = await trx
        .selectFrom('team_invitations')
        .select('status')
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitationId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.status !== 'pending') return;
      await this.resolveInvitation(
        trx,
        principal,
        row.id,
        row.team_entry_id,
        row.roster_membership_id,
        'expire',
        {},
        null,
        now,
        correlationId,
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Join requests
  // -------------------------------------------------------------------------------------------
  async requestToJoin(
    principal: Principal,
    teamEntryId: string,
    input: CreateJoinRequestInput,
    correlationId: string | null,
  ): Promise<JoinRequest> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, teamEntryId, { forUpdate: true });
      if (!context) throw errors.notFound('team_entry', teamEntryId);
      const personId = input.personId ?? principal.personId;
      if (!personId) throw errors.accessDenied('Link your account to a person before requesting.');
      await this.authorization.require(principal, CompetitionActions.requestToJoin, {
        type: 'join_request',
        organizationId,
        subjectPersonIds: [personId],
      });
      this.assertEntryTakesPlayers(context, 'request_to_join');
      if (context.season.status !== 'open' && context.season.status !== 'active') {
        throw errors.invalidTransition('Season', context.season.status, 'request_to_join');
      }
      const person = await this.people.loadPerson(trx, organizationId, personId);
      if (!person || person.status !== 'active') throw errors.notFound('person', personId);
      const evaluation = await this.eligibility.evaluateInContext(
        trx,
        context,
        personId,
        now,
        {
          membershipStatus: 'active',
          actorIsStaff: false,
          restricted: !isStaffLike(principal),
        },
        trx,
      );
      if (!evaluation.eligible) {
        throw errors.eligibility('The person is not eligible for this roster.', {
          personId,
          reasons: evaluation.reasons,
        });
      }
      const membershipId = await this.openPendingRow(
        trx,
        principal,
        context,
        personId,
        'requested',
        'join_request',
        now,
      );
      try {
        await trx
          .insertInto('join_requests')
          .values({
            id,
            organization_id: organizationId,
            team_entry_id: teamEntryId,
            person_id: personId,
            requested_by: json(snapshotActor(principal)),
            requested_by_person_id: principal.personId,
            message: input.message ?? null,
            decided_by: null,
            decided_by_person_id: null,
            decided_at: null,
            decision_note: null,
            roster_membership_id: membershipId,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A pending join request already exists for this person.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.requestToJoin.id,
        targetType: 'join_request',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { teamEntryId, personId },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.joinRequestCreated, {
        organizationId,
        aggregateType: 'join_request',
        aggregateId: id,
        payload: { requestId: id, teamEntryId, personId },
        correlationId,
      });
      const row = await trx
        .selectFrom('join_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toJoinRequest(row);
    });
  }

  async decide(
    principal: Principal,
    requestId: string,
    input: DecideJoinRequestInput,
    correlationId: string | null,
  ): Promise<JoinRequestDecided> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const request = await trx
        .selectFrom('join_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) throw errors.protectedNotFound('join_request');
      await this.authorization.require(principal, CompetitionActions.decideJoinRequest, {
        type: 'join_request',
        id: requestId,
        organizationId,
        teamEntryId: request.team_entry_id,
        protected: true,
      });
      const event = input.decision === 'approve' ? 'approve' : 'decline';
      // Only `pending` accepts these events, so the machine's answer is a decided state.
      const next = JoinRequestMachine.next(request.status, event) as Exclude<
        JoinRequestStatus,
        'pending'
      >;
      if (request.roster_membership_id) {
        await this.closePendingRow(trx, organizationId, request.roster_membership_id, now);
      }
      let membership: RosterMember | null = null;
      if (next === 'approved') {
        const context = await loadEntryContext(trx, organizationId, request.team_entry_id, {
          forUpdate: true,
        });
        if (!context) throw errors.protectedNotFound('team_entry');
        this.assertEntryTakesPlayers(context, 'approve_join_request');
        membership = await this.addMember(trx, principal, context, {
          personId: request.person_id,
          status: 'active',
          effectiveFrom: now,
          jerseyNumber: null,
          source: 'join_request',
          actorIsStaff: isStaffLike(principal),
          correlationId,
        });
      }
      await trx
        .updateTable('join_requests')
        .set({
          status: next,
          decided_by: json(snapshotActor(principal)),
          decided_by_person_id: principal.personId,
          decided_at: now,
          decision_note: input.note ?? null,
          roster_membership_id: membership?.id ?? request.roster_membership_id,
          revision: request.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', requestId)
        .where('revision', '=', request.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.decideJoinRequest.id,
        targetType: 'join_request',
        targetId: requestId,
        beforeRevision: request.revision,
        afterRevision: request.revision + 1,
        reason: input.note ?? input.reason ?? null,
        correlationId,
        details: {
          decision: next,
          teamEntryId: request.team_entry_id,
          personId: request.person_id,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.joinRequestDecided, {
        organizationId,
        aggregateType: 'join_request',
        aggregateId: requestId,
        payload: {
          requestId,
          teamEntryId: request.team_entry_id,
          personId: request.person_id,
          decision: next,
        },
        correlationId,
      });
      const row = await trx
        .selectFrom('join_requests')
        .selectAll()
        .where('id', '=', requestId)
        .executeTakeFirstOrThrow();
      return { request: toJoinRequest(row), membership };
    });
  }

  // -------------------------------------------------------------------------------------------
  // RosterPort
  // -------------------------------------------------------------------------------------------
  /**
   * SPK-AT-002, SPK-REG-007, §4.11 step 8: a paid and approved `join_team` registration places the
   * player on the roster, in the confirming transaction (`trx`, enrollment's confirmation inside
   * finance's finalization), so the confirmed enrollment and the roster membership commit
   * together. The competition rules are evaluated again at this instant (`addMember`); a refusal
   * (eligibility changed, roster full, entry no longer taking players) throws and the caller's
   * finalization records it as fulfillment that needs recovery, never a silent success. Idempotent:
   * a person already on the roster keeps that membership.
   */
  async addRegisteredMember(
    trx: Trx,
    input: {
      organizationId: string;
      teamEntryId: string;
      personId: string;
      enrollmentId: string;
      correlationId: string | null;
    },
  ): Promise<{ membershipId: string; created: boolean }> {
    const { organizationId, teamEntryId, personId } = input;
    const context = await loadEntryContext(trx, organizationId, teamEntryId, { forUpdate: true });
    if (!context) throw errors.notFound('team_entry', teamEntryId);
    if (context.season.status === 'completed' || context.season.status === 'archived') {
      throw errors.invalidTransition('Season', context.season.status, 'add_registered_member');
    }
    const open = await openRosterRow(trx, organizationId, teamEntryId, personId);
    if (open && statusAt(open) !== null) return { membershipId: open.id, created: false };
    this.assertEntryTakesPlayers(context, 'add_registered_member');
    const member = await this.addMember(
      trx,
      systemPrincipal(organizationId, 'competition.registration'),
      context,
      {
        personId,
        status: 'active',
        effectiveFrom: this.clock.now(),
        jerseyNumber: null,
        source: 'registration',
        // the same evaluation the registration ran before payment (SPK-AT-002)
        actorIsStaff: false,
        correlationId: input.correlationId,
        enrollmentId: input.enrollmentId,
      },
    );
    await trx
      .updateTable('team_entries')
      .set({ revision: context.entry.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', teamEntryId)
      .where('revision', '=', context.entry.revision)
      .execute();
    return { membershipId: member.id, created: true };
  }

  async effectiveRoster(
    organizationId: string,
    teamEntryId: string,
    at: Date,
    trx?: Trx,
  ): Promise<EffectiveRosterMember[]> {
    // Called from other modules' commands and handlers: read through their transaction.
    const db = trx ?? executorFor(this.db);
    const rows = await rosterRowsEffectiveAt(db, organizationId, teamEntryId, at);
    const roles = rolesByPerson(await effectiveRoles(db, organizationId, teamEntryId, at));
    const out: EffectiveRosterMember[] = [];
    for (const row of rows) {
      const status = statusAt(row);
      if (!status) continue;
      out.push({
        membershipId: row.id,
        personId: row.person_id,
        status,
        jerseyNumber: row.jersey_number,
        effectiveFrom: new Date(row.effective_from),
        effectiveTo: row.effective_to ? new Date(row.effective_to) : null,
        roles: roles.get(row.person_id) ?? [],
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private assertEntryTakesPlayers(context: EntryContext, event: string): void {
    const status = context.entry.status;
    if (status !== 'applied' && status !== 'approved') {
      throw errors.invalidTransition('TeamEntry', status, event);
    }
  }

  private async addMember(
    trx: Trx,
    principal: Principal,
    context: EntryContext,
    input: {
      personId: string;
      status: RosterPlayingStatus;
      effectiveFrom: Date;
      jerseyNumber: number | null;
      source: RosterSource;
      actorIsStaff: boolean;
      correlationId: string | null;
      /** A league-staff correction dated before now (see changeRoster). */
      correction?: RetroactiveCorrection | null;
      /** The paid registration this membership fulfils (source `registration`, SPK-AT-002). */
      enrollmentId?: string | null;
    },
  ): Promise<RosterMember> {
    const organizationId = context.entry.organization_id;
    assertJerseyInRange(context.rules, input.jerseyNumber);
    await this.lockSeasonMemberships(trx, organizationId, context.entry.season_id, [
      input.personId,
    ]);
    const open = await openRosterRow(trx, organizationId, context.entry.id, input.personId);
    if (open && statusAt(open) === null) {
      // A pending invitation or request placeholder gives way to the real membership.
      await this.closePendingRow(trx, organizationId, open.id, input.effectiveFrom);
    }
    const evaluation = await this.eligibility.evaluateInContext(
      trx,
      context,
      input.personId,
      input.effectiveFrom,
      {
        membershipStatus: input.status,
        actorIsStaff: input.actorIsStaff,
        // the 422 details reach the caller: a captain approving or adding sees codes only
        restricted: !input.actorIsStaff,
      },
      trx,
    );
    if (!evaluation.eligible) {
      throw errors.eligibility('The player is not eligible for this roster.', {
        personId: input.personId,
        membershipStatus: input.status,
        reasons: evaluation.reasons,
      });
    }
    const id = newId();
    try {
      await trx
        .insertInto('roster_memberships')
        .values({
          id,
          organization_id: organizationId,
          team_entry_id: context.entry.id,
          person_id: input.personId,
          status: input.status,
          status_before_removal: null,
          effective_from: input.effectiveFrom,
          effective_to: null,
          jersey_number: input.jerseyNumber,
          source: input.source,
          added_by: json(snapshotActor(principal)),
          added_by_person_id: principal.personId,
          eligibility_snapshot: json(evaluation.reasons),
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const constraint = pgConstraintName(error);
        throw errors.resourceConflict(
          constraint === 'roster_memberships_jersey_idx'
            ? 'That jersey number is already in use on this roster.'
            : 'The person already has an open roster row on this entry.',
          { constraint },
        );
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: CompetitionActions.manageRoster.id,
      targetType: 'roster_membership',
      targetId: id,
      afterRevision: 1,
      reason: input.correction?.reason ?? null,
      correlationId: input.correlationId,
      details: {
        teamEntryId: context.entry.id,
        personId: input.personId,
        status: input.status,
        effectiveFrom: input.effectiveFrom.toISOString(),
        source: input.source,
        reasonCodes: evaluation.reasons.map((r) => r.code),
        ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
        ...correctionDetails(input.correction),
      },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.rosterChanged, {
      organizationId,
      aggregateType: 'team_entry',
      aggregateId: context.entry.id,
      payload: {
        teamEntryId: context.entry.id,
        seasonId: context.entry.season_id,
        personId: input.personId,
        membershipId: id,
        change: 'added',
        status: input.status,
        effectiveFrom: input.effectiveFrom.toISOString(),
        effectiveTo: null,
        source: input.source,
      },
      correlationId: input.correlationId,
    });
    const row = await trx
      .selectFrom('roster_memberships')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const [member] = await this.entries.rosterMembers(trx, context, [row], input.effectiveFrom, {
      evaluate: false,
    });
    return { ...(member as RosterMember), eligibility: indicatorOf(evaluation) };
  }

  /** Removal keeps the row: effective_to is set and the status it held is preserved (SPK-COMP-005). */
  private async removeMember(
    trx: Trx,
    principal: Principal,
    context: EntryContext,
    personId: string,
    effectiveTo: Date,
    reason: string,
    correlationId: string | null,
    correction: RetroactiveCorrection | null = null,
  ): Promise<void> {
    const organizationId = context.entry.organization_id;
    const open = await openRosterRow(trx, organizationId, context.entry.id, personId);
    const status = open ? statusAt(open) : null;
    if (!open || !status) throw errors.notFound('roster_membership');
    if (effectiveTo < new Date(open.effective_from)) {
      throw errors.validation('effectiveTo cannot be before the membership started.', {
        effectiveFrom: iso(open.effective_from),
      });
    }
    const now = this.clock.now();
    await trx
      .updateTable('roster_memberships')
      .set({
        status: 'removed',
        status_before_removal: status,
        effective_to: effectiveTo,
        removed_at: now,
        removed_by: json(snapshotActor(principal)),
        removal_reason: reason,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', open.id)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: CompetitionActions.manageRoster.id,
      targetType: 'roster_membership',
      targetId: open.id,
      reason,
      correlationId,
      details: {
        teamEntryId: context.entry.id,
        personId,
        effectiveTo: effectiveTo.toISOString(),
        status,
        ...correctionDetails(correction),
      },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.rosterChanged, {
      organizationId,
      aggregateType: 'team_entry',
      aggregateId: context.entry.id,
      payload: {
        teamEntryId: context.entry.id,
        seasonId: context.entry.season_id,
        personId,
        membershipId: open.id,
        change: 'removed',
        status,
        effectiveFrom: iso(open.effective_from),
        effectiveTo: effectiveTo.toISOString(),
        source: open.source,
      },
      correlationId,
    });
  }

  /**
   * Serializes additions of one person within a season (SPK-COMP-005, SPK-COMP-002 "Multi-team
   * restrictions", §6.8 item 4). The multi-team rules read the person's memberships on other
   * entries, which the target entry's row lock does not cover, so two captains adding the same
   * person to two entries at once would each see none. A transaction-scoped advisory lock per
   * (organization, season, person) makes the second addition wait and then see the first. Locks
   * are taken in a stable order, and are re-entrant within the transaction.
   */
  private async lockSeasonMemberships(
    trx: Trx,
    organizationId: string,
    seasonId: string,
    personIds: string[],
  ): Promise<void> {
    for (const personId of [...new Set(personIds)].sort()) {
      const key = `competition.season_membership:${organizationId}:${seasonId}:${personId}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    }
  }

  private async openPendingRow(
    trx: Trx,
    principal: Principal,
    context: EntryContext,
    personId: string,
    status: 'invited' | 'requested',
    source: RosterSource,
    now: Date,
  ): Promise<string> {
    const organizationId = context.entry.organization_id;
    const open = await openRosterRow(trx, organizationId, context.entry.id, personId);
    if (open) {
      throw errors.resourceConflict(
        statusAt(open)
          ? 'The person is already on this roster.'
          : 'A pending invitation or join request already exists for this person.',
        { membershipId: open.id, status: open.status },
      );
    }
    const id = newId();
    await trx
      .insertInto('roster_memberships')
      .values({
        id,
        organization_id: organizationId,
        team_entry_id: context.entry.id,
        person_id: personId,
        status,
        status_before_removal: null,
        effective_from: now,
        effective_to: null,
        jersey_number: null,
        source,
        added_by: json(snapshotActor(principal)),
        added_by_person_id: principal.personId,
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      })
      .execute();
    return id;
  }

  private async closePendingRow(
    trx: Trx,
    organizationId: string,
    membershipId: string,
    at: Date,
  ): Promise<void> {
    const row = await trx
      .selectFrom('roster_memberships')
      .select(['id', 'effective_from', 'effective_to', 'status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', membershipId)
      .executeTakeFirst();
    if (!row || row.effective_to !== null) return;
    if (row.status !== 'invited' && row.status !== 'requested') return;
    const closeAt = at < new Date(row.effective_from) ? new Date(row.effective_from) : at;
    await trx
      .updateTable('roster_memberships')
      .set({ effective_to: closeAt })
      .where('organization_id', '=', organizationId)
      .where('id', '=', membershipId)
      .execute();
  }

  private async resolveInvitation(
    trx: Trx,
    principal: Principal,
    invitationId: string,
    teamEntryId: string,
    pendingMembershipId: string | null,
    event: 'accept' | 'decline' | 'revoke' | 'expire',
    fields: Record<string, unknown>,
    personId: string | null,
    now: Date,
    correlationId: string | null,
    options: { auditAction?: string; reason?: string | null } = {},
  ): Promise<void> {
    const organizationId = organizationOf(principal);
    // Every event leaves `pending`, so the machine's answer is one of the resolved states.
    const status = TeamInvitationMachine.next('pending', event) as Exclude<
      TeamInvitationStatus,
      'pending'
    >;
    if (pendingMembershipId)
      await this.closePendingRow(trx, organizationId, pendingMembershipId, now);
    await trx
      .updateTable('team_invitations')
      .set({ status, ...fields, revision: (eb) => eb('revision', '+', 1) })
      .where('organization_id', '=', organizationId)
      .where('id', '=', invitationId)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: options.auditAction ?? `competition.team_invitation_${status}`,
      targetType: 'team_invitation',
      targetId: invitationId,
      reason: options.reason ?? null,
      correlationId,
      details: { teamEntryId, status },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.teamInvitationResolved, {
      organizationId,
      aggregateType: 'team_invitation',
      aggregateId: invitationId,
      payload: { invitationId, teamEntryId, status, personId },
      correlationId,
    });
  }

  private async rosterView(
    db: Reader,
    context: EntryContext,
    at: Date,
    includeHistory: boolean,
  ): Promise<RosterResponse> {
    const organizationId = context.entry.organization_id;
    const rows = includeHistory
      ? await db
          .selectFrom('roster_memberships')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('team_entry_id', '=', context.entry.id)
          .orderBy('effective_from')
          .orderBy('id')
          .execute()
      : await rosterRowsEffectiveAt(db, organizationId, context.entry.id, at);
    const members = await this.entries.rosterMembers(db, context, rows, at);
    return { teamEntryId: context.entry.id, at: at.toISOString(), members };
  }
}

const InvitationCursor = z.object({ at: z.string(), id: z.uuid() });

/**
 * CMP-13 (SPK-COMP-005, DEC-002): a rule set with `roster.jerseyNumbers` refuses numbers outside
 * its range; without one only per-entry uniqueness (the database's open-row index) applies.
 */
export function assertJerseyInRange(rules: RuleSetContent, jerseyNumber: number | null): void {
  const range = rules.roster.jerseyNumbers ?? null;
  if (range === null || jerseyNumber === null) return;
  if (jerseyNumber < range.min || jerseyNumber > range.max) {
    throw errors.validation(
      `Jersey numbers run from ${range.min} to ${range.max} under this rule set.`,
      { code: 'JERSEY_OUT_OF_RANGE', jerseyNumber, min: range.min, max: range.max },
    );
  }
}

interface RetroactiveCorrection {
  reason: string | null;
  recordedAt: Date;
}

/** Audit details that mark a retroactive roster correction as such (§4.7 invariant 9). */
function correctionDetails(correction: RetroactiveCorrection | null | undefined) {
  return correction
    ? {
        retroactive: true,
        recordedAt: correction.recordedAt.toISOString(),
        correctionReason: correction.reason,
      }
    : {};
}

export type { RosterRow };
