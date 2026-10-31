import {
  CreateRuleSetBody,
  RuleSetContentSchema,
  ruleSetFormatIssues,
  type SportFormat,
} from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { proposedRuleSetContent } from './competition.policy';
import { ageOn, isEffectiveAt, referenceDateFor } from './competition.shared';

const FORMATS: SportFormat[] = ['outdoor', 'indoor_boarded', 'futsal', 'small_sided_other'];

describe('rule sets per format (SPK-COMP-002)', () => {
  it('the proposed defaults for every format are complete and valid for that format', () => {
    for (const format of FORMATS) {
      const content = proposedRuleSetContent(format);
      expect(RuleSetContentSchema.safeParse(content).success).toBe(true);
      expect(ruleSetFormatIssues(format, content)).toEqual([]);
      const body = CreateRuleSetBody.safeParse({ name: `Default ${format}`, format, content });
      expect(body.success).toBe(true);
      // every field of the requirement is present
      for (const field of [
        'playersOnField',
        'rosterMin',
        'rosterMax',
        'matchLengthMinutes',
        'periods',
        'minimumPlayers',
        'substitutions',
        'eligibilityReferenceDate',
        'multiTeamRestrictions',
        'scoring',
        'drawsAllowed',
        'overtime',
        'shootout',
        'cards',
        'forfeit',
        'abandonment',
        'tiebreakers',
        'protestDeadlineHours',
        'resultApproval',
      ]) {
        expect(content).toHaveProperty(field);
      }
    }
  });

  it('irrelevant format sections must be null: outdoor rules are rejected under futsal and vice versa', () => {
    const futsal = proposedRuleSetContent('futsal');
    const wrongSection = { ...futsal, outdoor: { offside: true, throwIns: true } };
    const issues = ruleSetFormatIssues('futsal', wrongSection);
    expect(issues.map((i) => i.path.join('.'))).toContain('outdoor');
    const body = CreateRuleSetBody.safeParse({
      name: 'Bad futsal',
      format: 'futsal',
      content: wrongSection,
    });
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.issues.map((i) => i.path.join('.'))).toContain('content.outdoor');
    }
    // the format's own section is required
    const missing = { ...futsal, futsal: null };
    expect(ruleSetFormatIssues('futsal', missing).map((i) => i.path.join('.'))).toContain('futsal');
    // sin bins are an indoor/small-sided device, never outdoor
    const outdoor = proposedRuleSetContent('outdoor');
    expect(
      ruleSetFormatIssues('outdoor', {
        ...outdoor,
        cards: { ...outdoor.cards, sinBinMinutes: 2 },
      }).map((i) => i.path.join('.')),
    ).toContain('cards.sinBinMinutes');
  });

  it('internal consistency: roster limits, minimum players and decided matches', () => {
    const base = proposedRuleSetContent('small_sided_other');
    expect(RuleSetContentSchema.safeParse({ ...base, rosterMin: 20, rosterMax: 16 }).success).toBe(
      false,
    );
    expect(
      RuleSetContentSchema.safeParse({ ...base, minimumPlayers: base.playersOnField + 1 }).success,
    ).toBe(false);
    expect(RuleSetContentSchema.safeParse({ ...base, drawsAllowed: false }).success).toBe(false);
    expect(
      RuleSetContentSchema.safeParse({
        ...base,
        drawsAllowed: false,
        shootout: { enabled: true, kicks: 5 },
      }).success,
    ).toBe(true);
    expect(
      RuleSetContentSchema.safeParse({ ...base, tiebreakers: ['points', 'points'] }).success,
    ).toBe(false);
    expect(
      RuleSetContentSchema.safeParse({
        ...base,
        substitutions: { unlimited: true, maxPerMatch: 5, rolling: true, reEntryAllowed: true },
      }).success,
    ).toBe(false);
  });
});

describe('eligibility reference dates and ages (§4.5: never a stored age)', () => {
  const season = { starts_on: '2027-01-10' };
  const at = new Date('2027-03-15T20:00:00Z');

  it('resolves the reference date from the rule', () => {
    expect(referenceDateFor({ rule: 'season_start' }, season, at)).toBe('2027-01-10');
    expect(referenceDateFor({ rule: 'calendar_year_start' }, season, at)).toBe('2027-01-01');
    expect(referenceDateFor({ rule: 'match_date' }, season, at)).toBe('2027-03-15');
    expect(referenceDateFor({ rule: 'fixed_date', date: '2026-08-01' }, season, at)).toBe(
      '2026-08-01',
    );
  });

  it('computes whole years at the reference date, birthday inclusive', () => {
    expect(ageOn('2014-01-10', '2027-01-10')).toBe(13);
    expect(ageOn('2014-01-11', '2027-01-10')).toBe(12);
    expect(ageOn('2015-06-01', '2027-01-10')).toBe(11);
    expect(ageOn('1985-04-12', '2027-01-10')).toBe(41);
  });

  it('effectivity is half-open [from, to)', () => {
    const row = { effective_from: '2026-10-01T00:00:00Z', effective_to: '2026-10-08T00:00:00Z' };
    expect(isEffectiveAt(row, new Date('2026-10-01T00:00:00Z'))).toBe(true);
    expect(isEffectiveAt(row, new Date('2026-10-07T23:59:59Z'))).toBe(true);
    expect(isEffectiveAt(row, new Date('2026-10-08T00:00:00Z'))).toBe(false);
    expect(isEffectiveAt({ ...row, effective_to: null }, new Date('2030-01-01T00:00:00Z'))).toBe(
      true,
    );
  });
});
