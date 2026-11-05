// jest-dom matchers on the runner's own `expect` (vitest), and DOM cleanup after each test.
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

expect.extend(matchers);
afterEach(() => cleanup());
// findBy* and waitFor wait up to 5 s instead of 1 s: the suite runs on shared CI machines, where a
// slow worker must not turn a correct screen into a failed test. Still deterministic: every
// response comes from the fake API, never from real time or the network.
configure({ asyncUtilTimeout: 5_000 });
