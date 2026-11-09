import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPgliteDatabase,
  lockPgliteDirectory,
  PGLITE_LOCK_FILE,
  PGLITE_TAKEOVER_DIR,
} from './client';

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

  it('a stale lock is not taken over while another process holds the takeover', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spk-pglite-'));
    writeFileSync(path.join(dir, PGLITE_LOCK_FILE), '2147483646');
    // Another process is taking the stale lock over right now.
    mkdirSync(path.join(dir, PGLITE_TAKEOVER_DIR));
    expect(() => lockPgliteDirectory(dir, { attempts: 3, waitMs: 1 })).toThrow(
      /could not lock PGlite data directory/,
    );
    expect(readFileSync(path.join(dir, PGLITE_LOCK_FILE), 'utf8')).toBe('2147483646');
  });

  it('a takeover left by a process that stopped mid-takeover is cleared', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spk-pglite-'));
    writeFileSync(path.join(dir, PGLITE_LOCK_FILE), '2147483646');
    const takeover = path.join(dir, PGLITE_TAKEOVER_DIR);
    mkdirSync(takeover);
    const longAgo = new Date('2026-01-01T00:00:00Z');
    utimesSync(takeover, longAgo, longAgo);
    const release = lockPgliteDirectory(dir, { attempts: 3, waitMs: 1 });
    expect(readFileSync(path.join(dir, PGLITE_LOCK_FILE), 'utf8')).toBe(String(process.pid));
    expect(existsSync(takeover)).toBe(false);
    release();
    expect(existsSync(path.join(dir, PGLITE_LOCK_FILE))).toBe(false);
  });

  it('releasing removes the lock only while it still names this process', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spk-pglite-'));
    const release = lockPgliteDirectory(dir);
    // Another process holds it now (as after a takeover this process did not see).
    writeFileSync(path.join(dir, PGLITE_LOCK_FILE), String(process.ppid));
    release();
    expect(readFileSync(path.join(dir, PGLITE_LOCK_FILE), 'utf8')).toBe(String(process.ppid));
  });
});
