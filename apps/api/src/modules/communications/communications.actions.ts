import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Staff who may compose, preview and send notices against an authorized audience (SPK-COMMS-006). */
const COMPOSER_ROLES: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'general_manager',
  'system_administrator',
  'support_operator',
];

/** Staff who may read notices and their actual delivery states (SPK-COMMS-004, SPK-UX-006). */
const READER_ROLES: readonly StaffRole[] = [
  ...COMPOSER_ROLES,
  'finance_operator',
  'facilities_operator',
];

/**
 * Staff who may retry a single failed delivery (COM-02; permission matrix's proposed
 * communications.retry_delivery): the general manager, the system administrator and support.
 * Front desk sees the failure exception and asks one of them (DEC-020 pending: channels).
 */
const RETRY_ROLES: readonly StaffRole[] = [
  'general_manager',
  'system_administrator',
  'support_operator',
];

/**
 * Staff who may record the outcome of a delivery whose hand-off ended `unknown` (§4.11, §5.11,
 * R4-COMMS-AUTOMATION-07): the front desk, which owns the messaging adapters' reconciliation in
 * the integration register and receives the `communications.delivery_unknown` exception, and the
 * roles that may retry. Proposed roles (permission matrix).
 */
const RECONCILE_ROLES: readonly StaffRole[] = [
  'front_desk',
  'general_manager',
  'system_administrator',
  'support_operator',
];

/**
 * Staff who keep message templates and sequences and who confirm, edit and skip scheduled
 * messages (SPK-COMMS-009, proposed amendment PA-05). Proposed roles: the review observed that
 * managers hold the template and broadcast permissions; who sends is a pending decision
 * (DEC-099, K2).
 */
const SEQUENCE_MANAGER_ROLES: readonly StaffRole[] = [
  'league_manager',
  'program_manager',
  'general_manager',
  'system_administrator',
];

/**
 * Communications actions (specification §3.18). Customer-facing actions are self-only: a person
 * reads their own inbox, chooses their own channels and manages their own calendar feeds. Including
 * another person in a calendar feed requires `view` over that person (SPK-IAM-003, SPK-COMMS-008).
 */
export const CommunicationsActions = defineActions({
  compose: {
    id: 'communications.compose',
    description: 'Compose a notification against an authorized audience',
    staffRoles: COMPOSER_ROLES,
    requirements: ['SPK-COMMS-002', 'SPK-COMMS-006', 'SPK-COMMS-007'],
  },
  previewRecipients: {
    id: 'communications.preview_recipients',
    description: 'Preview the recipients a notification resolves to (names and count only)',
    staffRoles: COMPOSER_ROLES,
    requirements: ['SPK-COMMS-003', 'SPK-COMMS-006'],
  },
  send: {
    id: 'communications.send',
    description: 'Confirm a composed notification: resolve recipients and queue delivery',
    staffRoles: COMPOSER_ROLES,
    requirements: ['SPK-COMMS-003', 'SPK-COMMS-005', 'SPK-COMMS-006'],
  },
  readNotification: {
    id: 'communications.read_notification',
    description: 'Read notifications, recipients and delivery attempts with their actual states',
    staffRoles: READER_ROLES,
    requirements: ['SPK-COMMS-004', 'SPK-UX-006'],
  },
  readInbox: {
    id: 'communications.read_inbox',
    description: 'Read the in-app notices delivered to oneself',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-COMMS-001', 'SPK-UX-003'],
  },
  acknowledge: {
    id: 'communications.acknowledge',
    description: 'Mark an in-app notice read or acknowledge it',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-COMMS-004'],
  },
  managePreferences: {
    id: 'communications.manage_preferences',
    description: 'Choose delivery channels per category for oneself',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-COMMS-001', 'SPK-COMMS-007'],
  },
  manageCalendarFeeds: {
    id: 'communications.manage_calendar_feeds',
    description: 'Create, list and revoke private calendar feeds for oneself',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-COMMS-008'],
  },
  registerPushDevice: {
    id: 'communications.register_push_device',
    description: 'Register, list and revoke the push devices of the signed-in account',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-UX-001', 'SPK-COMMS-003', 'SPK-COMMS-004'],
  },
  retryDelivery: {
    id: 'communications.retry_delivery',
    description: 'Retry one failed push, email or SMS delivery as a new attempt',
    staffRoles: RETRY_ROLES,
    requirements: ['SPK-COMMS-004', 'SPK-COMMS-003', 'SPK-UX-006'],
  },
  reconcileDelivery: {
    id: 'communications.reconcile_delivery',
    description:
      'Record the outcome established for a push, email or SMS delivery whose outcome is unknown',
    staffRoles: RECONCILE_ROLES,
    requirements: ['SPK-COMMS-004', '§4.11', '§5.11', 'SPK-UX-006'],
  },
  // SPK-COMMS-009 (proposed amendment PA-05, DEC-099): message templates and sequences. The
  // commands that create something new name the capability; reads and skipping never do.
  readMessageSchedule: {
    id: 'communications.read_message_schedule',
    description:
      'Read message templates, sequences and the message schedule of a season or an offering',
    staffRoles: READER_ROLES,
    requirements: ['SPK-COMMS-009'],
  },
  manageMessageTemplates: {
    id: 'communications.manage_message_templates',
    description: 'Create, change and archive reusable message templates',
    staffRoles: SEQUENCE_MANAGER_ROLES,
    capability: 'message_sequences',
    requirements: ['SPK-COMMS-009', 'SPK-COMMS-007'],
  },
  manageMessageSequences: {
    id: 'communications.manage_message_sequences',
    description:
      'Create and change message sequences and their steps, and produce a schedule from them',
    staffRoles: SEQUENCE_MANAGER_ROLES,
    capability: 'message_sequences',
    requirements: ['SPK-COMMS-009'],
  },
  previewScheduledMessage: {
    id: 'communications.preview_scheduled_message',
    description:
      'Preview a scheduled message: the text with real details and the recipients it resolves to now (names and count only)',
    staffRoles: SEQUENCE_MANAGER_ROLES,
    requirements: ['SPK-COMMS-009', 'SPK-COMMS-003', 'SPK-COMMS-006'],
  },
  confirmScheduledMessage: {
    id: 'communications.confirm_scheduled_message',
    description:
      'Edit, confirm or restore a scheduled message; a confirmed message is sent when it is due',
    staffRoles: SEQUENCE_MANAGER_ROLES,
    capability: 'message_sequences',
    requirements: ['SPK-COMMS-009', 'SPK-COMMS-006', 'SPK-COMMS-007'],
  },
  skipScheduledMessage: {
    id: 'communications.skip_scheduled_message',
    description: 'Skip a scheduled message so it is not sent',
    staffRoles: SEQUENCE_MANAGER_ROLES,
    requirements: ['SPK-COMMS-009'],
  },
  includeInCalendarFeed: {
    id: 'communications.include_in_calendar_feed',
    description: 'Include another person’s activities in a private calendar feed',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-COMMS-008', 'SPK-IAM-003', 'SPK-IAM-006'],
  },
});
