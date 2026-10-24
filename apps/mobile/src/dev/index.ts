/**
 * Development-only entry points. `__DEV__` is `false` in production bundles, Metro folds the
 * conditional before collecting dependencies, and the development sign-in module is therefore not
 * in a release bundle at all (checked by the export smoke test in CI).
 */
import type { ComponentType } from 'react';
import type * as DevSignInModule from './DevSignInScreen';

export const DevSignIn: ComponentType | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DevSignInScreen') as typeof DevSignInModule).DevSignInScreen
  : null;
