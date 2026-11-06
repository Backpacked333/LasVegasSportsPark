/**
 * Staff player profiles on the placement board (SPK-PLACE-002 explainable placement, SPK-PLACE-005
 * staff-only, never public): the position staff recorded (goalkeeper or an outfield line) and a
 * skill rating on the API's scale, read with each team's keepers and skill average from
 * `GET /v1/seasons/{id}/player-profiles` and recorded with `POST` (expectedRevision when a profile
 * exists, §4.9). The scale is an engineering placeholder the API names (`skillScale`); the board
 * shows it and never invents one. A viewer the API refuses sees the board without balance checks,
 * said in words.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote } from '../../features/competition/feedback';
import { SelectField } from '../../features/competition/fields';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type SeasonPlayerProfiles = Schema<'SeasonPlayerProfiles'>;
type PlayerProfile = Schema<'PlayerProfile'>;
type PlayerPosition = Schema<'PlayerPosition'>;
type TeamBalance = Schema<'TeamBalance'>;

export const POSITION_LABEL: Record<PlayerPosition, string> = {
  goalkeeper: 'Goalkeeper',
  defender: 'Defender',
  midfielder: 'Midfielder',
  forward: 'Forward',
  outfield: 'Outfield',
};

export function usePlayerProfiles(seasonId: string) {
  return useApiQuery({
    path: '/seasons/{id}/player-profiles',
    request: { path: { id: seasonId } },
    enabled: !!seasonId,
  });
}

export function profileOf(
  data: SeasonPlayerProfiles | undefined,
  personId: string,
): PlayerProfile | undefined {
  return data?.profiles.find((p) => p.personId === personId);
}

/** Skill as filled dots plus words (never colour alone, SPK-UX-009). */
export function SkillDots({ rating, max }: { rating: number; max: number }) {
  return (
    <span className="skill-dots" aria-label={`Skill ${rating} of ${max}`} role="img">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="skill-dot" data-on={String(i < rating)} aria-hidden="true" />
      ))}
    </span>
  );
}

/** The keeper and skill checks of one team column. */
export function BalanceBadges({ balance }: { balance: TeamBalance | undefined }) {
  if (!balance) return null;
  return (
    <>
      {balance.goalkeepers > 0 ? (
        <StatusBadge
          tone="success"
          label={`${balance.goalkeepers} ${balance.goalkeepers === 1 ? 'keeper' : 'keepers'}`}
        />
      ) : (
        <StatusBadge tone="danger" label="No keeper" />
      )}
      <StatusBadge
        tone="neutral"
        label={
          balance.averageSkill === null
            ? 'Skill not rated'
            : `Skill ${balance.averageSkill.toFixed(1)} (${balance.rated} of ${balance.players} rated)`
        }
      />
    </>
  );
}

/** The entrant's staff profile, and a small form to record or change it. */
export function ProfileEditor({
  seasonId,
  personId,
  personName,
  profiles,
}: {
  seasonId: string;
  personId: string;
  personName: string;
  profiles: SeasonPlayerProfiles;
}) {
  const profile = profileOf(profiles, personId);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<string>(profile?.position ?? '');
  const [rating, setRating] = useState<string>(
    profile?.skillRating !== null && profile?.skillRating !== undefined
      ? String(profile.skillRating)
      : '',
  );
  const [error, setError] = useState<string | null>(null);
  const record = useApiCommand('post', '/seasons/{id}/player-profiles', {
    invalidate: keys('/seasons/{id}/player-profiles'),
  });
  const { min, max } = profiles.skillScale;
  const submit = () => {
    if (!position && !rating) {
      setError('Choose a position, a skill rating, or both.');
      return;
    }
    setError(null);
    void record
      .submit({
        path: { id: seasonId },
        body: {
          personId,
          position: (position || null) as PlayerPosition | null,
          skillRating: rating ? Number(rating) : null,
          ...(profile ? { expectedRevision: profile.revision } : {}),
        },
      })
      .then(() => setOpen(false))
      .catch(() => undefined);
  };
  return (
    <div className="place-profile" aria-label={`Staff profile of ${personName}`} role="group">
      <span className="actions-row">
        {profile?.position ? (
          <StatusBadge
            tone={profile.position === 'goalkeeper' ? 'info' : 'neutral'}
            label={POSITION_LABEL[profile.position]}
          />
        ) : null}
        {profile?.skillRating ? <SkillDots rating={profile.skillRating} max={max} /> : null}
        {!profile ? <span className="caption">No staff profile yet</span> : null}
        <Button
          variant="secondary"
          className="button-sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {profile ? 'Change profile' : 'Rate player'}
        </Button>
      </span>
      {open ? (
        <form
          className="form place-profile-form"
          noValidate
          aria-label={`Rate ${personName}`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SelectField
            label="Position"
            value={position}
            onChange={setPosition}
            options={Object.entries(POSITION_LABEL).map(([value, label]) => ({ value, label }))}
            placeholder="Not recorded"
            error={error}
          />
          <SelectField
            label={`Skill (${min} to ${max})`}
            value={rating}
            onChange={setRating}
            options={Array.from({ length: max - min + 1 }, (_, i) => ({
              value: String(min + i),
              label: String(min + i),
            }))}
            placeholder="Not rated"
          />
          <CommandButton type="submit" className="button-sm" busy={record.isProcessing}>
            Save profile
          </CommandButton>
        </form>
      ) : null}
      {record.status === 'success' && !open ? <SuccessNote>Profile saved</SuccessNote> : null}
      <CommandError error={record.error} onRetry={submit} onReload={() => record.reset()} />
    </div>
  );
}
