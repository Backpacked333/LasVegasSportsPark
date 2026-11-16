/**
 * Demo-mode entry points. Each branch tests the build-time literal `__DEMO__` (not `IS_DEMO`, which
 * folds only after chunking): in a real build it is `false`, the dynamic imports go and no demo
 * chunk is emitted (scripts/check-release-bundle.mjs checks for its markers).
 */
import { lazy, type ComponentType } from 'react';
export { APP_MODE, IS_DEMO } from './mode';

export const DemoRolePicker: ComponentType | null = __DEMO__
  ? lazy(() => import('./DemoRolePicker').then((m) => ({ default: m.DemoRolePicker })))
  : null;

export const DemoBar: ComponentType | null = __DEMO__
  ? lazy(() => import('./DemoBar').then((m) => ({ default: m.DemoBar })))
  : null;

export const TourPanel: ComponentType | null = __DEMO__
  ? lazy(() => import('./TourPanel').then((m) => ({ default: m.TourPanel })))
  : null;
