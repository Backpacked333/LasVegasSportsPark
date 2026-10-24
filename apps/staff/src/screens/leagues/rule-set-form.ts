/**
 * SCR-S-08 rule-set form model (SPK-COMP-002): every field the requirement lists, with the
 * sections that do not apply to the chosen format disabled and sent as null. No rule value is
 * preset (DEC-002 is pending): a new rule set starts empty, and a next version starts from the
 * version it supersedes. The API validates the content again (`RuleSetContentSchema` plus
 * `ruleSetFormatIssues`); its field messages are mapped back onto these paths.
 */
import type { Schema } from '@sportspark/api-client';

export type SportFormat = Schema<'SportFormat'>;
export type RuleSetContent = Schema<'RuleSetContent'>;
export type Tiebreaker = RuleSetContent['tiebreakers'][number];
export type StaffRoleName = RuleSetContent['resultApproval']['submitRoles'][number];

export type Leaf =
  | {
      kind: 'int';
      path: string;
      label: string;
      hint?: string;
      /** Empty means null (for example "no limit"); the hint says what null means. */
      nullable?: boolean;
      min?: number;
    }
  | { kind: 'bool'; path: string; label: string; hint?: string }
  | { kind: 'text'; path: string; label: string; hint?: string }
  | {
      kind: 'enum';
      path: string;
      label: string;
      hint?: string;
      options: readonly { value: string; label: string }[];
    };

export interface Section {
  id: string;
  title: string;
  leaves: readonly Leaf[];
  /** Format-specific section: enabled only for this format (SPK-COMP-002). */
  format?: SportFormat;
  key?: 'outdoor' | 'indoorBoarded' | 'futsal' | 'smallSidedOther';
}

export const TIEBREAKERS: readonly { value: Tiebreaker; label: string }[] = [
  { value: 'points', label: 'Points' },
  { value: 'head_to_head', label: 'Head to head' },
  { value: 'goal_difference', label: 'Goal difference' },
  { value: 'goals_for', label: 'Goals for' },
  { value: 'goals_against', label: 'Goals against' },
  { value: 'wins', label: 'Wins' },
  { value: 'fair_play', label: 'Fair play' },
  { value: 'draw_of_lots', label: 'Drawing of lots' },
  { value: 'play_off', label: 'Play-off' },
];

export const STAFF_ROLES: readonly { value: StaffRoleName; label: string }[] = [
  { value: 'league_manager', label: 'League manager' },
  { value: 'general_manager', label: 'General manager' },
  { value: 'official', label: 'Official' },
  { value: 'coach', label: 'Coach' },
  { value: 'front_desk', label: 'Front desk' },
  { value: 'program_manager', label: 'Program manager' },
  { value: 'scheduler', label: 'Scheduler' },
  { value: 'support_operator', label: 'Support operator' },
  { value: 'system_administrator', label: 'System administrator' },
  { value: 'finance_operator', label: 'Finance operator' },
  { value: 'facilities_operator', label: 'Facilities operator' },
];

export const COMMON_SECTIONS: readonly Section[] = [
  {
    id: 'match',
    title: 'Players and match length',
    leaves: [
      { kind: 'int', path: 'playersOnField', label: 'Players on field', min: 3 },
      { kind: 'int', path: 'minimumPlayers', label: 'Minimum players to play', min: 1 },
      { kind: 'int', path: 'rosterMin', label: 'Roster minimum', min: 1 },
      { kind: 'int', path: 'rosterMax', label: 'Roster maximum', min: 1 },
      { kind: 'int', path: 'matchLengthMinutes', label: 'Match length (minutes)', min: 10 },
      { kind: 'int', path: 'periods', label: 'Periods', min: 1 },
    ],
  },
  {
    id: 'substitutions',
    title: 'Substitutions',
    leaves: [
      { kind: 'bool', path: 'substitutions.unlimited', label: 'Unlimited substitutions' },
      {
        kind: 'int',
        path: 'substitutions.maxPerMatch',
        label: 'Substitutions per match',
        hint: 'Only when substitutions are limited.',
        min: 0,
      },
      { kind: 'bool', path: 'substitutions.rolling', label: 'Rolling substitutions' },
      { kind: 'bool', path: 'substitutions.reEntryAllowed', label: 'Re-entry allowed' },
    ],
  },
  {
    id: 'eligibility',
    title: 'Eligibility reference date and multi-team restrictions',
    leaves: [
      {
        kind: 'enum',
        path: 'eligibilityReferenceDate.rule',
        label: 'Age is evaluated at',
        options: [
          { value: 'season_start', label: 'The season start' },
          { value: 'calendar_year_start', label: 'The start of the calendar year' },
          { value: 'match_date', label: 'Each match date' },
          { value: 'fixed_date', label: 'A fixed date' },
        ],
      },
      {
        kind: 'text',
        path: 'eligibilityReferenceDate.date',
        label: 'Fixed reference date (YYYY-MM-DD)',
        hint: 'Only for a fixed date.',
      },
      {
        kind: 'int',
        path: 'multiTeamRestrictions.maxEntriesPerSeason',
        label: 'Teams a person may join in one season',
        hint: 'Leave empty for no limit.',
        nullable: true,
        min: 1,
      },
      {
        kind: 'bool',
        path: 'multiTeamRestrictions.allowSameDivision',
        label: 'Two teams in the same division allowed',
      },
      {
        kind: 'bool',
        path: 'multiTeamRestrictions.allowCrossDivision',
        label: 'Teams in different divisions allowed',
      },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring, draws, overtime and shootouts',
    leaves: [
      { kind: 'int', path: 'scoring.win', label: 'Points for a win', min: 0 },
      { kind: 'int', path: 'scoring.draw', label: 'Points for a draw', min: 0 },
      { kind: 'int', path: 'scoring.loss', label: 'Points for a loss', min: 0 },
      { kind: 'int', path: 'scoring.forfeitWin', label: 'Points for a forfeit win', min: 0 },
      { kind: 'int', path: 'scoring.forfeitLoss', label: 'Points for a forfeit loss', min: 0 },
      { kind: 'bool', path: 'drawsAllowed', label: 'Draws allowed' },
      { kind: 'bool', path: 'overtime.enabled', label: 'Overtime' },
      { kind: 'int', path: 'overtime.periods', label: 'Overtime periods', min: 1 },
      {
        kind: 'int',
        path: 'overtime.periodLengthMinutes',
        label: 'Overtime period length (minutes)',
        min: 1,
      },
      { kind: 'bool', path: 'overtime.goldenGoal', label: 'Golden goal' },
      { kind: 'bool', path: 'shootout.enabled', label: 'Shootout' },
      { kind: 'int', path: 'shootout.kicks', label: 'Shootout kicks per team', min: 1 },
    ],
  },
  {
    id: 'cards',
    title: 'Cards and suspensions',
    leaves: [
      {
        kind: 'int',
        path: 'cards.yellowAccumulationThreshold',
        label: 'Yellow cards before an accumulation suspension',
        hint: 'Leave empty for no accumulation rule.',
        nullable: true,
        min: 1,
      },
      {
        kind: 'int',
        path: 'cards.yellowAccumulationSuspensionMatches',
        label: 'Matches suspended for accumulation',
        min: 0,
      },
      {
        kind: 'int',
        path: 'cards.redCardSuspensionMatches',
        label: 'Matches suspended for a red card',
        min: 0,
      },
      { kind: 'bool', path: 'cards.secondYellowIsRed', label: 'A second yellow is a red' },
      {
        kind: 'int',
        path: 'cards.sinBinMinutes',
        label: 'Sin bin (minutes)',
        hint: 'Leave empty for no sin bin. Sin bins do not apply to outdoor soccer.',
        nullable: true,
        min: 1,
      },
    ],
  },
  {
    id: 'forfeit',
    title: 'Forfeits and abandonment',
    leaves: [
      { kind: 'int', path: 'forfeit.scoreFor', label: 'Forfeit score for', min: 0 },
      { kind: 'int', path: 'forfeit.scoreAgainst', label: 'Forfeit score against', min: 0 },
      { kind: 'int', path: 'forfeit.graceMinutes', label: 'Grace period (minutes)', min: 0 },
      {
        kind: 'int',
        path: 'forfeit.minimumPlayersToStart',
        label: 'Players needed to start',
        min: 1,
      },
      {
        kind: 'enum',
        path: 'abandonment.policy',
        label: 'Abandoned match',
        options: [
          { value: 'result_stands_if_minimum_played', label: 'Result stands after a minimum' },
          { value: 'replay', label: 'Replay' },
          { value: 'replay_remaining', label: 'Replay the remaining time' },
          { value: 'league_decision', label: 'League decision' },
        ],
      },
      {
        kind: 'int',
        path: 'abandonment.minimumMinutesForResult',
        label: 'Minutes after which the result stands',
        hint: 'Leave empty for never.',
        nullable: true,
        min: 1,
      },
    ],
  },
  {
    id: 'protest',
    title: 'Protests, result approval and roster policy',
    leaves: [
      { kind: 'int', path: 'protestDeadlineHours', label: 'Protest deadline (hours)', min: 1 },
      {
        kind: 'bool',
        path: 'resultApproval.captainConfirmationRequired',
        label: 'Captains confirm results',
      },
      { kind: 'bool', path: 'roster.guestPlayersAllowed', label: 'Guest players allowed' },
      {
        kind: 'int',
        path: 'roster.guestMaxConcurrent',
        label: 'Guests on the roster at once',
        hint: 'Leave empty for no limit.',
        nullable: true,
        min: 1,
      },
      { kind: 'bool', path: 'roster.substitutesAllowed', label: 'Substitutes allowed' },
      {
        kind: 'bool',
        path: 'roster.guestOrSubstituteRequiresApproval',
        label: 'A league manager approves guests and substitutes',
      },
      {
        kind: 'bool',
        path: 'roster.coCaptainMayActAsCaptain',
        label: 'A co-captain may act as captain',
      },
    ],
  },
];

export const FORMAT_SECTIONS: readonly Section[] = [
  {
    id: 'outdoor',
    key: 'outdoor',
    format: 'outdoor',
    title: 'Outdoor soccer rules',
    leaves: [
      { kind: 'bool', path: 'outdoor.offside', label: 'Offside' },
      { kind: 'bool', path: 'outdoor.throwIns', label: 'Throw-ins' },
    ],
  },
  {
    id: 'indoorBoarded',
    key: 'indoorBoarded',
    format: 'indoor_boarded',
    title: 'Boarded indoor soccer rules',
    leaves: [
      { kind: 'bool', path: 'indoorBoarded.wallPlayAllowed', label: 'Play off the walls' },
      { kind: 'bool', path: 'indoorBoarded.ceilingOutOfPlay', label: 'Ceiling is out of play' },
      { kind: 'bool', path: 'indoorBoarded.flySubstitutions', label: 'Fly substitutions' },
    ],
  },
  {
    id: 'futsal',
    key: 'futsal',
    format: 'futsal',
    title: 'Futsal rules',
    leaves: [
      {
        kind: 'int',
        path: 'futsal.accumulatedFoulsLimit',
        label: 'Accumulated fouls limit',
        min: 1,
      },
      { kind: 'bool', path: 'futsal.secondPenaltySpot', label: 'Second penalty spot' },
      { kind: 'bool', path: 'futsal.kickIns', label: 'Kick-ins' },
      { kind: 'int', path: 'futsal.timeoutsPerHalf', label: 'Timeouts per half', min: 0 },
    ],
  },
  {
    id: 'smallSidedOther',
    key: 'smallSidedOther',
    format: 'small_sided_other',
    title: 'Other small-sided format rules',
    leaves: [
      { kind: 'text', path: 'smallSidedOther.description', label: 'Format description' },
      { kind: 'bool', path: 'smallSidedOther.offside', label: 'Offside' },
      { kind: 'bool', path: 'smallSidedOther.boards', label: 'Boards' },
    ],
  },
];

export interface RuleDraft {
  /** Leaf values by path; booleans as 'yes' / 'no', empty when not answered. */
  values: Record<string, string>;
  tiebreakers: Tiebreaker[];
  submitRoles: StaffRoleName[];
  approveRoles: StaffRoleName[];
}

export function emptyDraft(): RuleDraft {
  return { values: {}, tiebreakers: [], submitRoles: [], approveRoles: [] };
}

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

const ALL_LEAVES = [...COMMON_SECTIONS, ...FORMAT_SECTIONS].flatMap((s) => s.leaves);

/** Prefill from an existing version (the next version starts from what it supersedes). */
export function draftFromContent(content: RuleSetContent): RuleDraft {
  const values: Record<string, string> = {};
  for (const leaf of ALL_LEAVES) {
    const value = get(content, leaf.path);
    if (value === null || value === undefined) continue;
    if (leaf.kind === 'bool') values[leaf.path] = value ? 'yes' : 'no';
    else values[leaf.path] = String(value);
  }
  return {
    values,
    tiebreakers: [...content.tiebreakers],
    submitRoles: [...content.resultApproval.submitRoles],
    approveRoles: [...content.resultApproval.approveRoles],
  };
}

/** Whether a leaf is disabled for the format and the answers given so far. */
export function leafDisabled(leaf: Leaf, format: SportFormat | '', values: Record<string, string>) {
  switch (leaf.path) {
    case 'substitutions.maxPerMatch':
      return values['substitutions.unlimited'] !== 'no';
    case 'substitutions.rolling':
      // Boarded indoor soccer uses rolling substitutions by definition of the format.
      return format === 'indoor_boarded';
    case 'eligibilityReferenceDate.date':
      return values['eligibilityReferenceDate.rule'] !== 'fixed_date';
    case 'overtime.periods':
    case 'overtime.periodLengthMinutes':
    case 'overtime.goldenGoal':
      return values['overtime.enabled'] !== 'yes';
    case 'shootout.kicks':
      return values['shootout.enabled'] !== 'yes';
    case 'cards.sinBinMinutes':
      return format === 'outdoor';
    default:
      return false;
  }
}

export interface BuildResult {
  content: RuleSetContent | null;
  errors: Record<string, string>;
}

/** Builds the content the API takes, or field errors when an answer is missing or not valid. */
export function buildContent(format: SportFormat | '', draft: RuleDraft): BuildResult {
  const errors: Record<string, string> = {};
  if (!format) return { content: null, errors: { format: 'Choose the format first.' } };
  const out: Record<string, unknown> = {};
  const values = { ...draft.values };
  if (format === 'indoor_boarded') values['substitutions.rolling'] = 'yes';

  const sections = [
    ...COMMON_SECTIONS,
    ...FORMAT_SECTIONS.filter((section) => section.format === format),
  ];
  for (const section of sections) {
    for (const leaf of section.leaves) {
      const raw = (values[leaf.path] ?? '').trim();
      if (leafDisabled(leaf, format, values)) {
        if (leaf.path === 'substitutions.rolling') set(out, leaf.path, true);
        else if (leaf.kind === 'bool') set(out, leaf.path, false);
        else if (leaf.path !== 'eligibilityReferenceDate.date') set(out, leaf.path, null);
        continue;
      }
      if (leaf.kind === 'bool') {
        if (raw !== 'yes' && raw !== 'no') errors[leaf.path] = 'Choose yes or no.';
        else set(out, leaf.path, raw === 'yes');
      } else if (leaf.kind === 'int') {
        if (!raw) {
          if (leaf.nullable) set(out, leaf.path, null);
          else errors[leaf.path] = 'Enter a whole number.';
          continue;
        }
        const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(n)) errors[leaf.path] = 'Enter a whole number.';
        else if (leaf.min !== undefined && n < leaf.min)
          errors[leaf.path] = `Enter at least ${leaf.min}.`;
        else set(out, leaf.path, n);
      } else if (leaf.kind === 'text') {
        if (!raw) errors[leaf.path] = 'Enter a value.';
        else set(out, leaf.path, raw);
      } else {
        if (!raw) errors[leaf.path] = 'Choose one.';
        else set(out, leaf.path, raw);
      }
    }
  }
  // The eligibility reference date is a tagged union: the date exists only for a fixed date.
  const refRule = values['eligibilityReferenceDate.rule'];
  if (refRule === 'fixed_date') {
    const date = (values['eligibilityReferenceDate.date'] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors['eligibilityReferenceDate.date'] = 'Enter the date as YYYY-MM-DD.';
    }
  }
  if (draft.tiebreakers.length === 0) errors.tiebreakers = 'Add at least one tiebreaker.';
  if (draft.submitRoles.length === 0)
    errors['resultApproval.submitRoles'] = 'Choose at least one role.';
  if (draft.approveRoles.length === 0)
    errors['resultApproval.approveRoles'] = 'Choose at least one role.';

  for (const section of FORMAT_SECTIONS) {
    if (section.format !== format && section.key) out[section.key] = null;
  }
  set(out, 'tiebreakers', [...draft.tiebreakers]);
  set(out, 'resultApproval.submitRoles', [...draft.submitRoles]);
  set(out, 'resultApproval.approveRoles', [...draft.approveRoles]);

  if (Object.keys(errors).length > 0) return { content: null, errors };
  return { content: out as unknown as RuleSetContent, errors };
}

/** API field paths arrive as `content.cards.sinBinMinutes`; the form keys drop `content.`. */
export function contentFieldErrors(apiErrors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(apiErrors)) {
    out[path.startsWith('content.') ? path.slice('content.'.length) : path] = message;
  }
  return out;
}
