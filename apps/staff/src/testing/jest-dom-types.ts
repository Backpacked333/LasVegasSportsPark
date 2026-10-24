// jest-dom matcher types for vitest 5, whose `Assertion<R, T>` takes the matcher return type
// first; jest-dom 7 ships `@testing-library/jest-dom/vitest` types for the older one-parameter
// `Assertion<T>`, which no longer merge. A .ts file (not .d.ts) so it is checked despite skipLibCheck.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- declaration merge with vitest's Assertion<R, T>
  interface Assertion<R, T> extends TestingLibraryMatchers<any, R> {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- same
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}

export {};
