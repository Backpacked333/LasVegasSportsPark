import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  hasStaffRole,
  newId,
  type AcceptTeamInvitationInput,
  type ChangeRosterInput,
  type CreateJoinRequestInput,
  type CreateTeamInvitationInput,
  type DecideJoinRequestInput,
  type EligibilityEvaluation,
  type EligibilityQuery,
  type JoinRequest,
  type JoinRequestDecided,
  type Principal,
  type RevokeTeamInvitationInput,
  type RosterMember,
  type RosterPlayingStatus,
  type RosterQuery,
  type RosterResponse,
  type TeamInvitation,
  type TeamInvitationAccepted,
  type TeamInvitationIssued,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type JoinRequestStatus,
  type RosterSource,
  type TeamInvitationStatus,
} from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { TEAM_INVITATION_DEFAULT_HOURS } from '../competition.policy';
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
  isStaffLike,
  iso,
  newToken,
  organizationOf,
  toJoinRequest,
  toTeamInvitation,
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
    },
  ): Promise<RosterMember> {
    const organizationId = context.entry.organization_id;
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
      action: `competition.team_invitation_${status}`,
      targetType: 'team_invitation',
      targetId: invitationId,
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
