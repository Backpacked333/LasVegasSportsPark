import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Inbox } from '../kernel/inbox/inbox';
import { EventHandlerRegistry } from '../kernel/outbox/event-handler.registry';
import { DOMAIN_MODULES } from '../modules';
import { createTestApp, type TestApp } from '../testing';

/** Handler names by event type (outbox) and by provider (inbox), as committed. */
interface HandlerManifest {
  outbox: Record<string, string[]>;
  inbox: Record<string, string[]>;
}

const MANIFEST_PATH = path.join(__dirname, 'event-handler-manifest.json');

function sorted(map: Map<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    [...map.entries()]
      .filter(([, names]) => names.length > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, names]) => [key, [...names].sort()]),
  );
}

/**
 * §5.11, §4.7 invariant 12 (stage-7 review of R3-OPERATIONS-01): every outbox and inbox event
 * records the handler names its producing build registers, and a build that lacks one leaves the
 * event waiting for it. A handler renamed or removed without a `retire` declaration would therefore
 * leave every event recorded before the deploy waiting for good. This test compares the names the
 * application registers with the committed manifest, so such a build fails here instead:
 *
 * - a name in the manifest must be registered or retired for its event type (provider);
 * - a registered name must be in the manifest (add it with the handler's module).
 *
 * A retired name may leave the manifest together with its `retire` declaration, once no event
 * recorded with it can still be pending (at least one release later); that removal is made by
 * hand. `UPDATE_HANDLER_MANIFEST=1` adds the registered names that are missing (it never removes
 * one, so it cannot hide a vanished name); format the file afterwards (`pnpm format`).
 */
describe('event handler manifest (§5.11, §4.7 invariant 12)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ imports: DOMAIN_MODULES, principalResolver: 'module' });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§5.11 / R3-OPERATIONS-01: no committed handler name disappears without a retire declaration, and every registered handler is in the manifest', () => {
    const registry = t.app.get(EventHandlerRegistry);
    const outbox = new Map<string, string[]>();
    for (const handler of registry.list()) {
      outbox.set(handler.eventType, [...(outbox.get(handler.eventType) ?? []), handler.name]);
    }
    const outboxRetired = registry.retiredNames();
    const inbox = t.app.get(Inbox).registrations();
    const current: HandlerManifest = {
      outbox: sorted(outbox),
      inbox: sorted(inbox.registered),
    };
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as HandlerManifest;
    if (process.env['UPDATE_HANDLER_MANIFEST'] === '1') {
      for (const kind of ['outbox', 'inbox'] as const) {
        const merged = new Map(Object.entries(committed[kind]));
        for (const [key, names] of Object.entries(current[kind])) {
          merged.set(key, [...new Set([...(merged.get(key) ?? []), ...names])]);
        }
        committed[kind] = sorted(merged);
      }
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(committed, null, 2)}\n`);
    }

    const vanished: string[] = [];
    const unlisted: string[] = [];
    const compare = (
      kind: 'outbox' | 'inbox',
      registered: Record<string, string[]>,
      retired: Map<string, string[]>,
    ) => {
      for (const [key, names] of Object.entries(committed[kind])) {
        for (const name of names) {
          const known =
            (registered[key] ?? []).includes(name) || (retired.get(key) ?? []).includes(name);
          if (!known) vanished.push(`${kind} ${key}: ${name}`);
        }
      }
      for (const [key, names] of Object.entries(registered)) {
        for (const name of names) {
          if (!(committed[kind][key] ?? []).includes(name))
            unlisted.push(`${kind} ${key}: ${name}`);
        }
      }
    };
    compare('outbox', current.outbox, outboxRetired);
    compare('inbox', current.inbox, inbox.retired);

    // Renamed or removed without EventHandlerRegistry.retire / Inbox.retire: events recorded with
    // these names would wait for them forever. Declare the old name retired (with a reason).
    expect(vanished).toEqual([]);
    // New handlers: add them to event-handler-manifest.json (or run with UPDATE_HANDLER_MANIFEST=1).
    expect(unlisted).toEqual([]);
  });
});
