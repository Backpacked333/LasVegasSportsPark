/**
 * Development-only entry points. `import.meta.env.DEV` is `false` in `vite build`, the branch is
 * removed and the development sign-in chunk is not emitted (checked by scripts/check-release-bundle.mjs).
 * A protected staging build (`VITE_STAGING=true`, built without the release check) keeps the
 * development sign-in; its API requires a staging passcode (DEV_TOKENS_PASSCODE).
 */
import { lazy, type ComponentType } from 'react';

export const DevSignIn: ComponentType | null =
  import.meta.env.DEV || import.meta.env.VITE_STAGING === 'true'
    ? lazy(() => import('./DevSignIn').then((m) => ({ default: m.DevSignIn })))
    : null;
