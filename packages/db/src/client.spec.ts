import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgliteDatabase, PGLITE_LOCK_FILE } from './client';

describe('PGlite data directory lock', () => {
  it('a data directory held by a running process is refused; closing releases it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spk-pglite-'));
    // Another running process holds it (the test runner's parent is alive).
    writeFileSync(path.join(dir, PGLITE_LOCK_FILE), String(process.ppid));
    await expect(createPgliteDatabase({ dataDir: dir })).rejects.toThrow(
      new RegExp(`is open in process ${process.ppid}`),
    );
  });

  it('a lock left by a process that no longer runs is taken over, and released on close', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spk-pglite-'));
    writeFileSync(path.join(dir, PGLITE_LOCK_FILE), '2147483646');
    const first = await createPgliteDatabase({ dataDir: dir });
    try {
      expect(existsSync(path.join(dir, PGLITE_LOCK_FILE))).toBe(true);
    } finally {
      await first.close();
    }
    expect(existsSync(path.join(dir, PGLITE_LOCK_FILE))).toBe(false);
    const second = await createPgliteDatabase({ dataDir: dir });
    await second.close();
  });
});
