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
  includeInCalendarFeed: {
    id: 'communications.include_in_calendar_feed',
    description: 'Include another person’s activities in a private calendar feed',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-COMMS-008', 'SPK-IAM-003', 'SPK-IAM-006'],
  },
});
