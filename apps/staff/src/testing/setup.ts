// jest-dom matchers on the runner's own `expect` (vitest), and DOM cleanup after each test.
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

expect.extend(matchers);
afterEach(() => cleanup());
