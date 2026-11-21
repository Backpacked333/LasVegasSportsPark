/**
 * Demo-mode entry points (development builds only). `__DEV__` is `false` in release bundles, Metro
 * folds the conditional before collecting dependencies, and no demo module is bundled. Within a
 * development build the demo shows only when the app config's `appMode` is `demo`.
 */
import type { ComponentType } from 'react';
import type * as OverlayModule from './DemoOverlay';
import type * as SignInModule from './DemoSignInScreen';
import type * as WelcomeModule from './DemoWelcome';

export const DemoSignIn: ComponentType | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DemoSignInScreen') as typeof SignInModule).DemoSignInScreen
  : null;

export const DemoOverlay: ComponentType | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DemoOverlay') as typeof OverlayModule).DemoOverlay
  : null;

/** The redesigned welcome (handoff M 5a, 5b) with the demo's stand-in for the code provider. */
export const DemoWelcome: ComponentType | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DemoWelcome') as typeof WelcomeModule).DemoWelcome
  : null;
