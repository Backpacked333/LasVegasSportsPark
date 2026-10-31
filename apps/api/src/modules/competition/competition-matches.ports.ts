import type { Trx } from '../../kernel';

/**
 * Ports competition consumes from modules later in the dependency order. Implementations register
 * under the `*_IMPL` tokens and are resolved lazily through the kernel's `lazyPort`: workforce
 * (ASSIGNMENT_CHECK_IMPL), enrollment over catalog's offerings and acknowledgments
 * (FORMS_CHECK_IMPL), finance (FINANCIAL_CONDITIONS_IMPL) and communications
 * (CHANGE_NOTICE_CHECK_IMPL). When an implementing module is not part of the application (for
 * example a competition-only test), a deterministic default answers: assignments are unknown, so
 * only league administration may submit results; forms, financial conditions and change notices
 * report `unknown`, never `satisfied` (SPK-READY-002 "unknown or stale evidence" is never a pass).
 */

/** Workforce: is the person an accepted official for the fixture (SPK-STAFF-002: proposed does not count)? */
export interface AssignmentCheckPort {
  isAcceptedOfficial(
    organizationId: string,
    fixtureId: string,
    personId: string,
    trx?: Trx,
  ): Promise<boolean>;
}
export const ASSIGNMENT_CHECK_PORT = Symbol('ASSIGNMENT_CHECK_PORT');
export const ASSIGNMENT_CHECK_IMPL = Symbol('ASSIGNMENT_CHECK_IMPL');
/** Default: no assignment facts exist, so no official is accepted (league administration submits). */
export const noAssignments: AssignmentCheckPort = {
  isAcceptedOfficial: async () => false,
};

export type ConditionStatus = 'satisfied' | 'unsatisfied' | 'unknown';

/** A readiness condition reported by another module (SPK-READY-003 fields). */
export interface ConditionFinding {
  status: ConditionStatus;
  code: string;
  message: string;
  source: { type: string; id: string | null };
  responsibleRole: string;
  requiredAction: string;
  deadline: string | null;
}

export interface FixtureConditionContext {
  fixtureId: string;
  seasonId: string;
  teamEntryIds: string[];
  personIds: string[];
  at: Date;
  /** The season's catalog registration offering (`seasons.registration_offering_ref`), if any. */
  registrationOfferingRef?: string | null;
}

/** Catalog/enrollment: required forms (acknowledgments) for the people on the rosters. */
export interface FormsCheckPort {
  requiredForms(
    organizationId: string,
    context: FixtureConditionContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]>;
}
export const FORMS_CHECK_PORT = Symbol('FORMS_CHECK_PORT');
export const FORMS_CHECK_IMPL = Symbol('FORMS_CHECK_IMPL');
export const formsUnknown: FormsCheckPort = {
  requiredForms: async (_organizationId, context) => [
    {
      status: 'unknown',
      code: 'required_forms_unknown',
      message:
        'No forms check is part of this application; required acknowledgments cannot be confirmed.',
      source: { type: 'fixture', id: context.fixtureId },
      responsibleRole: 'program_manager',
      requiredAction: 'Confirm required forms once the catalog forms check is registered.',
      deadline: null,
    },
  ],
};

/**
 * R2-JOURNEYS-05 (SPK-COMP-004, SPK-CAP-002): finance's answer for one team entry, from the
 * obligations that name it as debtor. `none`: no obligation that is not canceled; `clear`: every
 * such obligation is settled or written off; `outstanding`: at least one is open, with the
 * remaining amount per currency (minor units, SPK-PAY-001) and the earliest open due date;
 * `unknown`: finance cannot answer (`explanation` says why). Never a guess.
 */
export type TeamEntryFinancialStatus =
  | { status: 'none' }
  | { status: 'clear' }
  | {
      status: 'outstanding';
      openObligations: number;
      outstanding: Array<{ amountMinor: number; currency: string }>;
      nextDueAt: string | null;
    }
  | { status: 'unknown'; explanation: string };

/** Finance: applicable financial conditions (team fees, holds) for the competing entries. */
export interface FinancialConditionsPort {
  fixtureConditions(
    organizationId: string,
    context: FixtureConditionContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]>;
  /**
   * R2-JOURNEYS-05: the entry's financial status for the captain workspace and the staff entry
   * review. Optional while the finance implementation does not answer it: competition then reports
   * the status as `unknown`, never as clear.
   */
  entryFinancialStatus?(
    organizationId: string,
    teamEntryId: string,
    trx?: Trx,
  ): Promise<TeamEntryFinancialStatus>;
}
export const FINANCIAL_CONDITIONS_PORT = Symbol('FINANCIAL_CONDITIONS_PORT');
export const FINANCIAL_CONDITIONS_IMPL = Symbol('FINANCIAL_CONDITIONS_IMPL');
export const financialConditionsUnknown: FinancialConditionsPort = {
  entryFinancialStatus: async () => ({
    status: 'unknown',
    explanation: 'no finance check is part of this application',
  }),
  fixtureConditions: async (_organizationId, context) => [
    {
      status: 'unknown',
      code: 'financial_conditions_unknown',
      message:
        'No finance check is part of this application; financial conditions cannot be confirmed.',
      source: { type: 'fixture', id: context.fixtureId },
      responsibleRole: 'finance_operator',
      requiredAction: 'Confirm team obligations once the finance conditions check is registered.',
      deadline: null,
    },
  ],
};

/**
 * Communications: whether the notice of a material fixture change reached both teams
 * (SPK-READY-001 "material change notifications"). Delivery evidence is the communications
 * module's; until it registers, the notice is reported as unknown, never as delivered.
 */
export interface ChangeNoticeCheckPort {
  changeNotices(
    organizationId: string,
    context: FixtureConditionContext & {
      changedAt: Date;
      schedulingEventId: string | null;
      /** The fixture's current published time, which the change notice must describe. */
      scheduledStart?: string | null;
      scheduledEnd?: string | null;
    },
    trx?: Trx,
  ): Promise<ConditionFinding[]>;
}
export const CHANGE_NOTICE_CHECK_PORT = Symbol('CHANGE_NOTICE_CHECK_PORT');
export const CHANGE_NOTICE_CHECK_IMPL = Symbol('CHANGE_NOTICE_CHECK_IMPL');
export const changeNoticesUnknown: ChangeNoticeCheckPort = {
  changeNotices: async (_organizationId, context) => [
    {
      status: 'unknown',
      code: 'change_notification_unknown',
      message: `The fixture changed materially on ${context.changedAt.toISOString()}; delivery of the change notice is not confirmed.`,
      source: { type: 'fixture', id: context.fixtureId },
      responsibleRole: 'league_manager',
      requiredAction: 'Confirm both teams received the change notice.',
      deadline: null,
    },
  ],
};
