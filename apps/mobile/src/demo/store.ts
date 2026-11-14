/**
 * Demo tour state for the app's lifetime: the current step and whether the tour card is open.
 */
import { useSyncExternalStore } from 'react';

export interface DemoState {
  active: boolean;
  step: number;
  open: boolean;
}

const INITIAL: DemoState = { active: false, step: 0, open: true };
let state: DemoState = INITIAL;
const listeners = new Set<() => void>();

export function getDemoState(): DemoState {
  return state;
}

export function setDemoState(next: Partial<DemoState>): void {
  state = { ...state, ...next };
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
