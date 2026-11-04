import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHandlerRegistry } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { enrollmentTestApp } from './support';

/**
 * R3-DOCS-TRUTH-3-08 (CLAUDE.md: handlers subscribe in onModuleInit; an engineer changing an event
 * payload checks its consumers, overview §7.1; §6.7 documentation states verified behaviour): the
 * module README's "Outbox handlers" section names every outbox handler enrollment registers, each
 * in a bullet "- `name` on ..." that names every event the handler consumes. No count is
 * hard-coded: the list comes from the registry.
 */
describe('enrollment README lists every registered outbox handler (R3-DOCS-TRUTH-3-08)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await enrollmentTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('§7.1: each enrollment handler has a bullet in the Outbox handlers section naming its events', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const start = readme.indexOf('\n## Outbox handlers');
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf('\n## ', start + 1);
    const section = readme.slice(start, end === -1 ? undefined : end);
    // Each bullet with its wrapped continuation lines, on single spaces.
    const bullets = section
      .split(/\n(?=- )/)
      .filter((b) => b.startsWith('- '))
      .map((b) => b.replace(/\s+/g, ' '));
    const handlers = t.app
      .get(EventHandlerRegistry)
      .list()
      .filter((h) => h.name.startsWith('enrollment.'));
    expect(handlers.length).toBeGreaterThan(0);
    const missing = handlers
      .filter(
        (h) =>
          !bullets.some(
            (b) => b.startsWith(`- \`${h.name}\` on `) && b.includes(`\`${h.eventType}\``),
          ),
      )
      .map((h) => `${h.name} <- ${h.eventType}`);
    expect(missing).toEqual([]);
  });
});
