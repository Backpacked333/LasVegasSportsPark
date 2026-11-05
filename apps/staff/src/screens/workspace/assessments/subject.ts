/**
 * Shared shapes of SCR-W-07 (SPK-YOUTH-005, SPK-YOUTH-006): who is being assessed, in which
 * offering, and the templates known on the page. Only ids, names and the offering's facility are
 * held; nothing is stored beyond the page or put in a route (§4.14).
 */
import type { Schema } from '@sportspark/api-client';

export type Assessment = Schema<'Assessment'>;
export type AssessmentTemplate = Schema<'AssessmentTemplate'>;
export type Recommendation = Schema<'ProgressionRecommendation'>;

export interface AssessmentSubject {
  offeringId: string;
  offeringName: string;
  /** The offering's program (templates belong to a program); null when the page cannot read it. */
  programId: string | null;
  facilityId: string;
  personId: string;
  name: string;
  /**
   * Chosen from the viewer's own accepted coach session (SessionParticipants). The API answers
   * NOT_FOUND to such a coach until an assessment they may read exists, so the list then says
   * nothing is visible yet instead of "not available" (it never asserts that a record exists).
   */
  fromOwnSession?: boolean;
}

/** The capability every authoring, review and sharing command needs (DEC-016). */
export const YOUTH_CAPABILITY = 'youth_progression' as const;

export const ACTIONS = {
  manageTemplate: 'enrollment.manage_assessment_template',
  retireTemplate: 'enrollment.retire_assessment_template',
  author: 'enrollment.author_assessment',
  withdraw: 'enrollment.withdraw_assessment',
  review: 'enrollment.review_assessment',
  recommend: 'enrollment.recommend_progression',
  withdrawRecommendation: 'enrollment.withdraw_recommendation',
} as const;

/** SkillKey in the contract: a lower-case key. */
export const SKILL_KEY = /^[a-z][a-z0-9_]{0,99}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function skillLabel(templates: readonly AssessmentTemplate[], a: Assessment): string {
  const template = templates.find((t) => t.id === a.templateId);
  return template?.skillAreas.find((s) => s.key === a.skillAreaKey)?.label ?? a.skillAreaKey;
}

export function scaleLabel(templates: readonly AssessmentTemplate[], a: Assessment): string {
  const template = templates.find((t) => t.id === a.templateId);
  const level = template?.scale.levels[a.scaleValue - 1];
  return level
    ? `${level} (${a.scaleValue} of ${template.scale.levels.length})`
    : `Level ${a.scaleValue}`;
}
