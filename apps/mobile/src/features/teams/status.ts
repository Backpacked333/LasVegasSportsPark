/**
 * Status phrases for the team screens, from docs/package-a/journeys.md section 3 (SPK-UX-004,
 * SPK-UX-010 consistent terminology). Every phrase is shown with a glyph and text through
 * StatusBadge, never colour alone (SPK-UX-009).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatDay, formatInstant } from './format';

type TeamEntry = Schema<'TeamEntry'>;
type Fixture = Schema<'Fixture'>;
type ResultRevision = Schema<'ResultRevision'>;
type Dispute = Schema<'Dispute'>;
type TeamInvitation = Schema<'TeamInvitation'>;
type RosterMember = Schema<'RosterMember'>;
/**
 * RSVP states. The published OpenAPI component `AvailabilityState` also allows null (a nullable
 * reuse leaked into the component; reported), so null is excluded here and handled as "No response".
 */
export type RsvpState = Exclude<Schema<'AvailabilityState'>, null>;

/** TeamEntry `applied`, `approved`, `rejected`, `withdrawn` (SPK-COMP-004). */
export function teamEntryStatus(
  entry: Pick<TeamEntry, 'status' | 'rejectionReason'>,
): StatusBadgeProps {
  switch (entry.status) {
    case 'applied':
      return { tone: 'pending', label: 'Team entry awaiting approval' };
    case 'approved':
      return { tone: 'success', label: 'Team entry approved' };
    case 'rejected':
      return {
        tone: 'danger',
        label: entry.rejectionReason ? `Not approved: ${entry.rejectionReason}` : 'Not approved',
      };
    case 'withdrawn':
      return { tone: 'neutral', label: 'Withdrawn' };
  }
}

/**
 * Fixture states (journeys.md): a scheduled fixture shows its time, in the facility's zone when
 * the caller has it (`venue.timezone`, SPK-SCHED-008); readiness is separate.
 */
export function fixtureStatus(
  fixture: Pick<Fixture, 'status' | 'scheduledStart'>,
  timeZone?: string | null,
): StatusBadgeProps {
  switch (fixture.status) {
    case 'unscheduled':
      return { tone: 'neutral', label: 'Not yet scheduled' };
    case 'scheduled':
      return {
        tone: 'info',
        label: fixture.scheduledStart
          ? formatInstant(fixture.scheduledStart, timeZone)
          : 'Scheduled',
      };
    case 'postponed':
      return { tone: 'warning', label: 'Postponed' };
    case 'played':
      return { tone: 'success', label: 'Final' };
    case 'forfeit':
      return { tone: 'warning', label: 'Forfeit' };
    case 'canceled':
      return { tone: 'danger', label: 'Canceled' };
    case 'abandoned':
      return { tone: 'danger', label: 'Abandoned' };
  }
}

/** RSVP (SPK-CAP-003): never attendance, never eligibility. */
export const RSVP_LABELS: Record<RsvpState, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  tentative: 'Tentative',
  no_response: 'No response',
};

export function rsvpStatus(state: RsvpState | null | undefined): StatusBadgeProps {
  switch (state ?? 'no_response') {
    case 'available':
      return { tone: 'success', label: RSVP_LABELS.available };
    case 'unavailable':
      return { tone: 'danger', label: RSVP_LABELS.unavailable };
    case 'tentative':
      return { tone: 'pending', label: RSVP_LABELS.tentative };
    default:
      return { tone: 'neutral', label: RSVP_LABELS.no_response };
  }
}

/**
 * Counts of RSVP answers for one side of a fixture. "Tentative" is listed only when someone gave
 * that answer (whether it is offered is DEC-064). A missing answer is counted, never blocking.
 */
export function availabilitySummaryText(summary: Schema<'AvailabilitySummary'>): string {
  const parts = [
    `${RSVP_LABELS.available} ${summary.available}`,
    `${RSVP_LABELS.unavailable} ${summary.unavailable}`,
  ];
  if (summary.tentative > 0) parts.push(`${RSVP_LABELS.tentative} ${summary.tentative}`);
  parts.push(`${RSVP_LABELS.no_response} ${summary.noResponse}`);
  return parts.join(', ');
}

/** SPK-RESULT-002 classifications. */
export const CLASSIFICATION_LABELS: Record<Schema<'ResultClassification'>, string> = {
  completed: 'Completed',
  forfeit: 'Forfeit',
  canceled: 'Canceled',
  abandoned: 'Abandoned',
  postponed: 'Postponed',
  disputed: 'Disputed',
};

/**
 * Result revisions (SPK-RESULT-001, SPK-RESULT-004): "Provisional" (submitted), "Official",
 * "Corrected on <date>" (an official revision that replaced an earlier official one). A replaced
 * revision stays visible as history.
 */
export function resultStatus(revision: ResultRevision): StatusBadgeProps {
  switch (revision.status) {
    case 'draft':
    case 'submitted':
      return { tone: 'pending', label: 'Provisional' };
    case 'official':
      return revision.supersedesRevisionId && revision.publishedAt
        ? { tone: 'success', label: `Corrected on ${formatDay(revision.publishedAt)}` }
        : { tone: 'success', label: 'Official' };
    case 'superseded':
      return {
        tone: 'neutral',
        label: revision.supersededAt
          ? `Replaced by a correction on ${formatDay(revision.supersededAt)}`
          : 'Replaced by a correction',
      };
  }
}

/** Dispute states (SPK-RESULT-005); "Disputed: under review" is the inventory's success wording. */
export function disputeStatus(dispute: Pick<Dispute, 'status' | 'decision'>): StatusBadgeProps {
  switch (dispute.status) {
    case 'submitted':
    case 'under_review':
      return { tone: 'pending', label: 'Disputed: under review' };
    case 'decided':
      return dispute.decision === 'upheld'
        ? { tone: 'success', label: 'Dispute upheld' }
        : { tone: 'neutral', label: 'Dispute not upheld' };
    case 'withdrawn':
      return { tone: 'neutral', label: 'Dispute withdrawn' };
  }
}

/** The published component also allows null (reported); null means "not decided yet". */
export const PUBLICATION_CONSEQUENCE_LABELS: Record<
  Exclude<Schema<'PublicationConsequence'>, null>,
  string
> = {
  none: 'No change to the published result',
  result_stands: 'The result stands',
  correction_required: 'A corrected result will be published',
  replay_ordered: 'The game will be replayed',
};

/** Team invitations: "Open until <date>", "Accepted", "Declined", "Expired", "Revoked". */
export function invitationStatus(
  invitation: Pick<TeamInvitation, 'status' | 'expiresAt'>,
): StatusBadgeProps {
  switch (invitation.status) {
    case 'pending':
      return { tone: 'info', label: `Open until ${formatInstant(invitation.expiresAt)}` };
    case 'accepted':
      return { tone: 'success', label: 'Accepted' };
    case 'declined':
      return { tone: 'neutral', label: 'Declined' };
    case 'revoked':
      return { tone: 'neutral', label: 'Revoked' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
  }
}

const PLAYING_LABELS: Record<Schema<'RosterPlayingStatus'>, string> = {
  active: 'Player',
  guest: 'Guest player',
  substitute: 'Substitute',
};

/** A roster row with its effective dates (SPK-COMP-005: history stays visible). */
export function rosterMemberStatus(member: RosterMember, now: Date): StatusBadgeProps {
  if (member.status === 'invited') return { tone: 'info', label: 'Invited' };
  if (member.status === 'requested') return { tone: 'info', label: 'Requested to join' };
  const playing = member.status === 'removed' ? member.statusBeforeRemoval : member.status;
  const role = playing ? PLAYING_LABELS[playing] : 'Player';
  const ended = member.effectiveTo !== null && new Date(member.effectiveTo) <= now;
  if (member.status === 'removed' || ended) {
    return {
      tone: 'neutral',
      label: `${role} from ${formatDay(member.effectiveFrom)} to ${
        member.effectiveTo ? formatDay(member.effectiveTo) : 'removal'
      }`,
    };
  }
  return { tone: 'success', label: `${role} from ${formatDay(member.effectiveFrom)}` };
}

/** True while the row is on the effective roster (not pending, not ended). */
export function isCurrentPlayer(member: RosterMember, now: Date): boolean {
  if (member.status !== 'active' && member.status !== 'guest' && member.status !== 'substitute') {
    return false;
  }
  return member.effectiveTo === null || new Date(member.effectiveTo) > now;
}

/** Eligibility codes the API sends (RosterEligibilityIndicator, EligibilityReason) in customer words. */
const ELIGIBILITY_CODE_WORDS: Record<string, string> = {
  person_not_found: 'person record not found',
  person_inactive: 'person record inactive',
  entry_not_active: 'team entry not active',
  entry_pending_approval: 'team entry awaiting approval',
  season_closed: 'season closed',
  date_of_birth_unknown: 'date of birth missing',
  below_division_age: 'below the division age',
  above_division_age: 'above the division age',
  already_on_roster: 'already on the roster',
  roster_full: 'roster limit reached',
  guests_not_allowed: 'guest players not allowed',
  guest_limit_reached: 'guest limit reached',
  substitutes_not_allowed: 'substitutes not allowed',
  approval_required: 'league approval required',
  multi_team_limit: 'team limit for the season reached',
  already_in_division: 'already on a team in this division',
  cross_division_not_allowed: 'already on a team in another division',
  suspended: 'suspended',
  opposing_roster: 'on the opposing roster',
  conflicting_fixture: 'conflicting game',
};

export function eligibilityCodeWords(code: string): string {
  return ELIGIBILITY_CODE_WORDS[code] ?? code.replace(/_/g, ' ');
}

/** The captain's readiness indicator for one roster player (codes only, SPK-CAP-002). */
export function eligibilityIndicatorStatus(
  indicator: RosterMember['eligibility'],
): StatusBadgeProps | null {
  if (!indicator) return null;
  const words = indicator.codes.map(eligibilityCodeWords).join(', ');
  switch (indicator.status) {
    case 'eligible':
      return { tone: 'success', label: 'Eligible' };
    case 'ineligible':
      return { tone: 'danger', label: words ? `Not eligible: ${words}` : 'Not eligible' };
    case 'unknown':
      return {
        tone: 'warning',
        label: words ? `Eligibility unknown: ${words}` : 'Eligibility unknown',
      };
  }
}

/** Readiness and eligibility severities (SPK-READY-002). */
export function severityStatus(severity: Schema<'EligibilitySeverity'>): StatusBadgeProps {
  switch (severity) {
    case 'blocking':
      return { tone: 'danger', label: 'Blocking' };
    case 'warning':
      return { tone: 'warning', label: 'Warning' };
    case 'info':
      return { tone: 'info', label: 'For information' };
    case 'unknown':
      return { tone: 'pending', label: 'Not known yet' };
  }
}

export const OBLIGATION_MODE_LABELS: Record<Schema<'ObligationMode'>, string> = {
  individual: 'Individual player billing',
  single_team_payer: 'One responsible team payer',
  team_with_contributions: 'Team obligation with player contributions',
};

export function obligationStatus(status: Schema<'ObligationStatus'>): StatusBadgeProps {
  switch (status) {
    case 'open':
      return { tone: 'info', label: 'Open' };
    case 'settled':
      return { tone: 'success', label: 'Settled' };
    case 'written_off':
      return { tone: 'neutral', label: 'Written off' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
  }
}

export function contributionStatus(contribution: {
  status: 'requested' | 'paid' | 'canceled';
  paidAt: string | null;
}): StatusBadgeProps {
  switch (contribution.status) {
    case 'requested':
      return { tone: 'pending', label: 'Requested' };
    case 'paid':
      return {
        tone: 'success',
        label: contribution.paidAt ? `Paid on ${formatDay(contribution.paidAt)}` : 'Paid',
      };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
  }
}

/** PaymentAttempt states (journeys.md): processing and unknown are never "failed" or "paid". */
export function paymentStatus(status: Schema<'PaymentAttemptStatus'>): StatusBadgeProps {
  switch (status) {
    case 'created':
    case 'action_required':
      return { tone: 'warning', label: 'Payment needs your action' };
    case 'processing':
      return { tone: 'pending', label: 'Payment processing' };
    case 'succeeded':
      return { tone: 'success', label: 'Paid' };
    case 'failed':
      return { tone: 'danger', label: 'Payment failed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Payment canceled' };
    case 'unknown':
      return {
        tone: 'warning',
        label: 'Payment outcome being confirmed. Do not pay again.',
      };
  }
}
