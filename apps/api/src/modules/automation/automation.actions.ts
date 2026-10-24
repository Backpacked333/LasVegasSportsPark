import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

const ALL_STAFF: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'coach',
  'official',
];

/**
 * Automation actions (§3.21, docs/package-a/permission-matrix.md C.15). The assistant grants no
 * authority of its own (SPK-AUTO-004): asking only lets a person run, through the assistant, the
 * module queries their own principal already permits; every module query and command it uses is
 * authorized by the owning module exactly like a direct call. Requests and recommendations are
 * the requester's own records (self only, protected). A person other than the requester may see,
 * review and apply a recommendation only when they hold the action of its command on its target
 * (no standalone grant: the underlying command decides, SPK-AUTO-003).
 */
export const AutomationActions = defineActions({
  ask: {
    id: 'automation.ask',
    description:
      'Ask the assistant: summaries, readiness explanations, policy lookups, drafts, demand summaries and financial exception explanations bounded by the asker’s own permissions',
    staffRoles: ALL_STAFF,
    allowSelf: true,
    requirements: ['SPK-AUTO-001', 'SPK-AUTO-002', 'SPK-AUTO-004', 'SPK-AT-026'],
  },
  readRequest: {
    id: 'automation.read_request',
    description: 'Read one’s own assistant request: response, evidence, missing evidence, tool log',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-AUTO-002', '§4.10'],
  },
  reviewRecommendation: {
    id: 'automation.review_recommendation',
    description:
      'Approve or reject a recommendation produced for oneself; for anyone else the action of the recommendation’s command decides',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-AUTO-003'],
  },
  applyRecommendation: {
    id: 'automation.apply_recommendation',
    description:
      'Apply an approved recommendation one approved, through the owning module’s command with one’s own principal (that command authorizes it)',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-AUTO-003', 'SPK-AUTO-004'],
  },
});
