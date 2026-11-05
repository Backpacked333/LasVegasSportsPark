/**
 * Date and time entry in facility local time (SPK-SCHED-008: "Ambiguous or nonexistent times require
 * resolution"). The value is the wall-clock date and time the user typed; `toInstant` turns it into
 * the UTC instant the API takes. When clocks go back the user picks the first or second occurrence;
 * when clocks go forward the time is refused with the time after the change offered instead. Labels
 * name the zone so the field is never read as browser time (SPK-UX-009 labelled inputs).
 */
import { useId } from 'react';
import { formatInstant, localDateOf, localTimeOf, resolveLocal, zoneName } from './time';

export interface LocalDateTime {
  date: string;
  time: string;
  /** Chosen occurrence of an ambiguous time. */
  occurrence?: 'earlier' | 'later';
}

export type InstantResult =
  | { ok: true; instant: string }
  | { ok: false; problem: 'missing' | 'invalid' | 'nonexistent' | 'ambiguous'; message: string };

export function emptyLocal(): LocalDateTime {
  return { date: '', time: '' };
}

export function localFromInstant(instant: string, timeZone: string): LocalDateTime {
  return { date: localDateOf(instant, timeZone), time: localTimeOf(instant, timeZone) };
}

export function toInstant(value: LocalDateTime, timeZone: string): InstantResult {
  if (!value.date || !value.time) {
    return { ok: false, problem: 'missing', message: 'Enter a date and a time.' };
  }
  const r = resolveLocal(value.date, value.time, timeZone);
  switch (r.kind) {
    case 'exact':
      return { ok: true, instant: r.instant };
    case 'ambiguous':
      if (value.occurrence) {
        return { ok: true, instant: value.occurrence === 'earlier' ? r.earlier : r.later };
      }
      return {
        ok: false,
        problem: 'ambiguous',
        message: `${value.time} happens twice on this date in ${timeZone} (clocks go back). Choose which one.`,
      };
    case 'nonexistent':
      return {
        ok: false,
        problem: 'nonexistent',
        message: `${value.time} does not exist on this date in ${timeZone} (clocks go forward). Choose another time, for example ${localTimeOf(r.shiftedForward, timeZone)}.`,
      };
    case 'invalid':
      return { ok: false, problem: 'invalid', message: 'Enter a valid date and time.' };
  }
}

export function LocalDateTimeField({
  label,
  value,
  onChange,
  timeZone,
  required = false,
  disabled = false,
  showErrors = false,
}: {
  label: string;
  value: LocalDateTime;
  onChange: (next: LocalDateTime) => void;
  timeZone: string;
  required?: boolean;
  disabled?: boolean;
  /** Show the missing-value message too (after a submit attempt). */
  showErrors?: boolean;
}) {
  const id = useId();
  const result = toInstant(value, timeZone);
  const ambiguous = resolveLocal(value.date, value.time, timeZone);
  const problem =
    !result.ok && (showErrors || result.problem !== 'missing') ? result.message : null;
  return (
    <fieldset className="datetime-field" disabled={disabled}>
      <legend>
        {label} ({timeZone})
      </legend>
      <span className="field-row">
        <label htmlFor={`${id}-date`}>Date</label>
        <input
          id={`${id}-date`}
          type="date"
          value={value.date}
          required={required}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => onChange({ date: e.target.value, time: value.time })}
        />
        <label htmlFor={`${id}-time`}>Time</label>
        <input
          id={`${id}-time`}
          type="time"
          value={value.time}
          required={required}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => onChange({ date: value.date, time: e.target.value })}
        />
      </span>
      {ambiguous.kind === 'ambiguous' ? (
        <span className="field-row" role="radiogroup" aria-label={`Which ${value.time}`}>
          {(['earlier', 'later'] as const).map((occurrence) => {
            const instant = occurrence === 'earlier' ? ambiguous.earlier : ambiguous.later;
            return (
              <label key={occurrence}>
                <input
                  type="radio"
                  name={`${id}-occurrence`}
                  checked={value.occurrence === occurrence}
                  onChange={() => onChange({ ...value, occurrence })}
                />{' '}
                {occurrence === 'earlier' ? 'First' : 'Second'} {value.time} (
                {zoneName(instant, timeZone)})
              </label>
            );
          })}
        </span>
      ) : null}
      {problem ? (
        <span className="error-text" id={`${id}-problem`} role="alert">
          {problem}
        </span>
      ) : result.ok ? (
        <span className="caption">{formatInstant(result.instant, timeZone)}</span>
      ) : null}
    </fieldset>
  );
}
