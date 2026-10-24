import { describe, expect, it } from 'vitest';
import { BackgroundWorkers } from '../workers/background-workers';

/** §4.1, §4.12: module poll loops run only where the worker process starts them. */
describe('background worker registry (§4.1, §4.12)', () => {
  const worker = (name: string, log: string[]) => ({
    name,
    start: () => log.push(`start:${name}`),
    stop: () => log.push(`stop:${name}`),
  });

  it('registers without starting; only startAll (worker.ts) starts the loops', () => {
    const log: string[] = [];
    const workers = new BackgroundWorkers();
    workers.register(worker('a.loop', log));
    workers.register(worker('b.loop', log));
    expect(log).toEqual([]);
    expect(workers.names()).toEqual(['a.loop', 'b.loop']);
    workers.startAll();
    workers.startAll();
    expect(log).toEqual(['start:a.loop', 'start:b.loop']);
    // a worker registered after start (late module) starts at once
    workers.register(worker('c.loop', log));
    expect(log.at(-1)).toBe('start:c.loop');
    workers.stopAll();
    expect(log.slice(-3)).toEqual(['stop:a.loop', 'stop:b.loop', 'stop:c.loop']);
    expect(workers.isStarted()).toBe(false);
  });

  it('refuses two workers with one name', () => {
    const workers = new BackgroundWorkers();
    workers.register(worker('a.loop', []));
    expect(() => workers.register(worker('a.loop', []))).toThrow(/already registered/);
  });
});
