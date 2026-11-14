/**
 * Demo tour state: the role being demonstrated, the current step and whether the tour panel is
 * open. Kept for the browser tab (sessionStorage) so a reload mid-demo resumes the same step.
 * Storage can be unavailable (private windows); the tour then works for the page's lifetime.
 */
import { useSyncExternalStore } from 'react';

export interface DemoState {
  roleId: string | null;
  step: number;
  open: boolean;
}

const KEY = 'sportspark.demo';
const INITIAL: DemoState = { roleId: null, step: 0, open: true };

function read(): DemoState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<DemoState>;
    return {
      roleId: typeof parsed.roleId === 'string' ? parsed.roleId : null,
      step: typeof parsed.step === 'number' && parsed.step >= 0 ? Math.floor(parsed.step) : 0,
      open: parsed.open !== false,
    };
  } catch {
    return INITIAL;
  }
}

let state: DemoState = read();
const listeners = new Set<() => void>();

export function getDemoState(): DemoState {
  return state;
}

export function setDemoState(next: Partial<DemoState>): void {
  state = { ...state, ...next };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not persisted; the tour still works until the page is reloaded.
  }
  listeners.forEach((l) => l());
}

export function resetDemoState(): void {
  setDemoState(INITIAL);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDemoState(): DemoState {
  return useSyncExternalStore(subscribe, getDemoState, getDemoState);
}
