/**
 * Care notes as the redesign edits them (handoff M 5c; SPK-DISC-005, §4.14): the API keeps
 * operational notes of two kinds, `allergy` and `care_instruction`, each a short text. The editor
 * shows:
 *
 * - each allergy as a chip, its name and, when the text says one, its severity ("Peanuts ·
 *   severe"): the text is what staff read, so the severity is written into it in plain words;
 * - "If it happens": the first care instruction (the one a coach reads in an emergency);
 * - "Other notes for coaches": the second care instruction.
 *
 * Saving changes the notes the way the API corrects them: a note whose text changed or was removed
 * is retired (with its revision and a reason) and the new text is recorded as a new note
 * (`POST /v1/care-notes/{id}/retire`, `POST /v1/people/{id}/care-notes`). Pure: no requests here.
 */
import type { Schema } from '@sportspark/api-client';

type CareNote = Schema<'CareNote'>;

export type Severity = 'mild' | 'moderate' | 'severe';
export const SEVERITIES: readonly Severity[] = ['mild', 'moderate', 'severe'];

export interface AllergyChip {
  /** The note it came from; null for one added in the editor. */
  noteId: string | null;
  name: string;
  severity: Severity | null;
  /** The note's full text as recorded (kept unchanged when the chip is). */
  text: string;
}

/** "Peanuts · severe" or "Peanuts. Carries a pen…": the chip's name and severity. */
export function allergyChip(note: Pick<CareNote, 'id' | 'body'>): AllergyChip {
  const text = note.body.trim();
  const match = /^(.*?)\s·\s(mild|moderate|severe)\b/iu.exec(text);
  if (match) {
    return {
      noteId: note.id,
      name: (match[1] as string).trim(),
      severity: (match[2] as string).toLowerCase() as Severity,
      text,
    };
  }
  const name = (text.split(/[.;\n]/u)[0] ?? text).trim();
  return { noteId: note.id, name: name || text, severity: null, text };
}

/** The text a new allergy is recorded with: "Peanuts · severe". */
export function allergyText(name: string, severity: Severity | null): string {
  return severity ? `${name.trim()} · ${severity}` : name.trim();
}

export interface CareDraft {
  allergies: AllergyChip[];
  ifItHappens: string;
  other: string;
}

/** The active notes, oldest first, as the editor's draft. */
export function draftOf(notes: readonly CareNote[]): CareDraft {
  const active = [...notes]
    .filter((n) => n.status === 'active')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const instructions = active.filter((n) => n.kind === 'care_instruction');
  return {
    allergies: active.filter((n) => n.kind === 'allergy').map(allergyChip),
    ifItHappens: instructions[0]?.body ?? '',
    other: instructions[1]?.body ?? '',
  };
}

export function sameDraft(a: CareDraft, b: CareDraft): boolean {
  return (
    a.ifItHappens.trim() === b.ifItHappens.trim() &&
    a.other.trim() === b.other.trim() &&
    a.allergies.length === b.allergies.length &&
    a.allergies.every(
      (x, i) => x.noteId === b.allergies[i]?.noteId && x.text === b.allergies[i]?.text,
    )
  );
}

export type CareChange =
  { kind: 'retire'; note: CareNote } | { kind: 'record'; noteKind: CareNote['kind']; body: string };

/** What saving `draft` sends, in order: retirements first, then new notes. */
export function careChanges(notes: readonly CareNote[], draft: CareDraft): CareChange[] {
  const active = notes.filter((n) => n.status === 'active');
  const before = draftOf(notes);
  const retire: CareChange[] = [];
  const record: CareChange[] = [];
  const keptAllergies = new Set(draft.allergies.flatMap((a) => (a.noteId ? [a.noteId] : [])));
  for (const note of active.filter((n) => n.kind === 'allergy')) {
    if (!keptAllergies.has(note.id)) retire.push({ kind: 'retire', note });
  }
  for (const chip of draft.allergies) {
    if (!chip.noteId) record.push({ kind: 'record', noteKind: 'allergy', body: chip.text });
  }
  const instructions = active
    .filter((n) => n.kind === 'care_instruction')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const fields: [string, string, CareNote | undefined][] = [
    [before.ifItHappens, draft.ifItHappens, instructions[0]],
    [before.other, draft.other, instructions[1]],
  ];
  for (const [was, now, note] of fields) {
    if (was.trim() === now.trim()) continue;
    if (note) retire.push({ kind: 'retire', note });
    if (now.trim()) record.push({ kind: 'record', noteKind: 'care_instruction', body: now.trim() });
  }
  return [...retire, ...record];
}

/** "Peanut allergy · EpiPen in bag": one line for the child profile (M 3e). */
export function careSummary(notes: readonly CareNote[]): string {
  const draft = draftOf(notes);
  const parts = [
    ...draft.allergies.map((a) => `${a.name} allergy`),
    draft.ifItHappens ? (draft.ifItHappens.split(/[.;\n]/u)[0] ?? '').trim() : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' · ') : 'No care notes yet';
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  coach: 'coaches',
  front_desk: 'the desk',
  program_manager: 'program managers',
  league_manager: 'league managers',
  general_manager: 'managers',
  official: 'officials',
};

/** "Maya's coaches and the desk" from the roles the API says may read the notes. */
export function whoSees(givenName: string, roles: readonly string[]): string {
  const words = [...new Set(roles.flatMap((r) => (ROLE_WORDS[r] ? [ROLE_WORDS[r]] : [])))];
  if (words.length === 0) return 'the staff who need them';
  const named = words.map((w) => (w === 'coaches' ? `${givenName}'s coaches` : w));
  return named.length === 1
    ? (named[0] as string)
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}
