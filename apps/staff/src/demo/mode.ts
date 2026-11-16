/**
 * Which mode this build runs in. `real` (the default) is the dashboard as it ships: the real sign-in
 * and whatever data the API holds. `demo` (`vite --mode demo`, `vite build --mode demo`) adds a
 * role picker that signs in as a seeded demo account, a banner that says the data is sample data,
 * and a guided tour per role. `__DEMO__` is a literal replaced at build time (vite.config.ts), so a
 * real build contains none of the demo code (checked by scripts/check-release-bundle.mjs).
 */
export type AppMode = 'real' | 'demo';

export const IS_DEMO: boolean = __DEMO__;

export const APP_MODE: AppMode = IS_DEMO ? 'demo' : 'real';
