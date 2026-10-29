import type { DeliveryChannelValue, NotificationCategoryValue } from '@sportspark/contracts';
import type { Trx } from '../../kernel';

/**
 * Ports of the communications module. Channel providers are a provider-selection gate (§5.2):
 * the module ships deterministic fakes and no vendor SDK. Team membership is read through the
 * competition module's exported ports (`services/competition-team-membership.ts`), never its tables.
 */

export type ExternalChannel = Exclude<DeliveryChannelValue, 'in_app'>;

export interface ChannelSendRequest {
  attemptId: string;
  organizationId: string;
  notificationId: string;
  channel: ExternalChannel;
  personId: string;
  /** Email address, phone number or push registration handle resolved immediately before the call. */
  address: string;
  title: string;
  body: string;
  category: NotificationCategoryValue;
  correlationId: string | null;
}

/**
 * What the provider told us, and nothing more (SPK-COMMS-004): `accepted` is not delivery; `unknown`
 * means the call did not yield a trustworthy outcome (timeout, transport error) and stays unknown
 * until a receipt arrives.
 */
export type ChannelSendResult =
  | { outcome: 'accepted'; providerMessageId: string; response?: Record<string, unknown> }
  | { outcome: 'failed'; error: string; response?: Record<string, unknown> }
  | { outcome: 'unknown'; error: string; response?: Record<string, unknown> };

export interface ChannelProviderPort {
  readonly name: string;
  readonly channel: ExternalChannel;
  /** Called OUTSIDE any database transaction (§4.11). Must never throw for a provider outcome. */
  send(request: ChannelSendRequest): Promise<ChannelSendResult>;
}
/** `ChannelProviderPort[]`, one per external channel. */
export const CHANNEL_PROVIDERS = Symbol('CHANNEL_PROVIDERS');

/**
 * Who is on a team right now (SPK-COMMS-003 "current permissions" for team audiences). Evaluated
 * at the clock on every call so a player removed from the roster stops being a recipient at once.
 */
export interface TeamMembershipPort {
  /** Current effective roster members (person ids) of a season team entry. */
  membersOf(organizationId: string, teamEntryId: string, trx?: Trx): Promise<string[]>;
  isMember(
    organizationId: string,
    teamEntryId: string,
    personId: string,
    trx?: Trx,
  ): Promise<boolean>;
  /** Team entries the person is currently on (roster row or team role), for calendar feeds. */
  teamEntriesOf(organizationId: string, personId: string, trx?: Trx): Promise<string[]>;
}
export const TEAM_MEMBERSHIP_PORT = Symbol('TEAM_MEMBERSHIP_PORT');

/** Unit-test stand-in: nobody is on any team. */
export const noTeamMembership: TeamMembershipPort = {
  membersOf: async () => [],
  isMember: async () => false,
  teamEntriesOf: async () => [],
};

/**
 * Participants of the catalog sessions behind a scheduling event (SPK-AT-009, SPK-COMMS-002): a
 * youth session event commits no person or team, yet its enrolled participants (their guardians)
 * must hear that it was canceled or changed. Implemented by enrollment (SESSION_AUDIENCE_IMPL),
 * resolved lazily so communications does not import it; without it nobody is added.
 */
export interface SessionAudiencePort {
  participantsOfSchedulingEvent(
    trx: Trx,
    organizationId: string,
    eventId: string,
  ): Promise<string[]>;
}
export const SESSION_AUDIENCE_PORT = Symbol('SESSION_AUDIENCE_PORT');
export const SESSION_AUDIENCE_IMPL = Symbol('SESSION_AUDIENCE_IMPL');

export const noSessionAudience: SessionAudiencePort = {
  participantsOfSchedulingEvent: async () => [],
};
