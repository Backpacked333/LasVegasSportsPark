/**
 * Development-only entry points. `import.meta.env.DEV` is `false` in `vite build`, the branch is
 * removed and the development sign-in chunk is not emitted (checked by scripts/check-release-bundle.mjs).
 */
import { lazy, type ComponentType } from 'react';

export const DevSignIn: ComponentType | null = import.meta.env.DEV
  ? lazy(() => import('./DevSignIn').then((m) => ({ default: m.DevSignIn })))
  : null;
