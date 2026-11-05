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
 *
 * Turning the assistant on or off for an organization is the kernel's `core.manage_capabilities`
 * (capability `assistant`, DEC-016; system administrator, audited). It replaces the
 * `automation.manage_assistant` action the permission matrix proposed, which is not declared.
 */
export const AutomationActions = defineActions({
  ask: {
    id: 'automation.ask',
    description:
      'Ask the assistant: summaries, readiness explanations, policy lookups, drafts, demand summaries and financial exception explanations bounded by the asker’s own permissions',
    staffRoles: ALL_STAFF,
    allowSelf: true,
    // AUT-02 (DEC-016): a new request is a new commitment of the assistant capability.
    capability: 'assistant',
    requirements: ['SPK-AUTO-001', 'SPK-AUTO-002', 'SPK-AUTO-004', 'SPK-AT-026', 'SPK-AUTO-005'],
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
    // AUT-02 (DEC-016): applying runs a change the assistant proposed, a new commitment.
    capability: 'assistant',
    requirements: ['SPK-AUTO-003', 'SPK-AUTO-004'],
  },
  /**
   * AUT-03 (§4.11 "unknown kept explicit until reconciled", §4.12): record the reconciled outcome
   * of an apply whose outcome was unknown (its operation `recovery_required`), from the owning
   * module's records. Proposed roles: the system administrator (failure owner of the assistant
   * integration) and the general manager. Never gated by the capability: a reconciliation ends
   * what was already done (K-12 capability rule).
   */
  settleApply: {
    id: 'automation.settle_apply',
    description:
      'Record the reconciled outcome (applied or not applied) of a recommendation apply whose outcome was unknown, with the evidence it rests on',
    staffRoles: ['system_administrator', 'general_manager'],
    requirements: ['SPK-AUTO-003', '§4.11', '§4.12'],
  },
});
