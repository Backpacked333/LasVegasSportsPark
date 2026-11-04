import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHandlerRegistry } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { financeTestApp } from './support';

/**
 * R3-DOCS-TRUTH-3-08 (CLAUDE.md: handlers subscribe in onModuleInit; an engineer changing an event
 * payload checks its consumers, overview §7.1; §6.7 documentation states verified behaviour): the
 * module README's "Durable work" list names every outbox handler finance registers, with the event
 * it consumes, so a payload change cannot miss a consumer the README leaves out.
 */
describe('finance README lists every registered outbox handler (R3-DOCS-TRUTH-3-08)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await financeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('§7.1: each finance handler and its event appear in the README', () => {
    // Whitespace (line wrapping) is not meaning: compare on single spaces.
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    const handlers = t.app
      .get(EventHandlerRegistry)
      .list()
      .filter((h) => h.name.startsWith('finance.'));
    expect(handlers.length).toBe(12);
    const missing = handlers
      .filter((h) => !readme.includes(`\`${h.name}\` on \`${h.eventType}\``))
      .filter((h) => !readme.includes(`\`${h.name}\` on its timer \`${h.eventType}\``))
      .map((h) => `${h.name} <- ${h.eventType}`);
    expect(missing).toEqual([]);
  });
});
