/**
 * Which standings table a season screen reads (CMP-12, SPK-RESULT-001): a divided season has one
 * table per division and the API refuses a season-wide read (VALIDATION_FAILED DIVISION_REQUIRED),
 * so its first division is shown until another is chosen; a season without divisions has the one
 * season table. `ready` stays false until the divisions read has answered, so no season-wide read
 * is sent for a season that turns out to be divided.
 */
import { useState } from 'react';

export interface StandingsDivision {
  /** The division whose table is read; empty for a season without divisions. */
  divisionId: string;
  choose: (divisionId: string) => void;
  divided: boolean;
  ready: boolean;
}

export function useStandingsDivision(
  divisions: readonly { id: string }[] | undefined,
  settled: boolean = divisions !== undefined,
): StandingsDivision {
  const [chosen, choose] = useState('');
  const first = divisions?.[0]?.id ?? '';
  const divisionId = divisions?.some((d) => d.id === chosen) ? chosen : first;
  return { divisionId, choose, divided: first !== '', ready: settled };
}
