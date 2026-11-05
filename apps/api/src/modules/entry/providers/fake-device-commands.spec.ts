import { describe, expect, it } from 'vitest';
import type { AccessDeviceCommand } from '../entry.ports';
import { FakeAccessControlProvider } from './fake-access-control.provider';

const command = (commandId: string, deviceRef = 'turnstile-1'): AccessDeviceCommand => ({
  organizationId: '01a18600-0000-7000-8000-000000000001',
  deviceRef,
  commandId,
  kind: 'revoke_credential',
  payload: { passReferenceHash: 'a'.repeat(64) },
});

describe('FakeAccessControlProvider.sendCommand (IF-38, §5.2 hardware gate, DEC-023)', () => {
  it('delivers, fails, times out with an unknown outcome, and answers a repeated command once', async () => {
    const fake = new FakeAccessControlProvider();
    expect(await fake.sendCommand(command('c1'))).toEqual({ outcome: 'delivered' });
    fake.scriptCommands('fail', 'timeout');
    // The same command again: the first outcome, the device applies it once.
    expect(await fake.sendCommand(command('c1'))).toEqual({ outcome: 'delivered' });
    expect((await fake.sendCommand(command('c2'))).outcome).toBe('failed');
    expect((await fake.sendCommand(command('c3'))).outcome).toBe('unknown');
    // A lost answer is retried and may still be delivered.
    expect(await fake.sendCommand(command('c3'))).toEqual({ outcome: 'delivered' });
    expect(fake.commandCalls).toHaveLength(5);
  });

  it('a scripted device (down or refusing) answers every command alike until cleared, without consuming the script', async () => {
    const fake = new FakeAccessControlProvider();
    fake.scriptDevice('dead-door', 'timeout');
    fake.scriptCommands('fail');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await fake.sendCommand(command('d1', 'dead-door'))).outcome).toBe('unknown');
    }
    // Another device still gets the scripted outcome; the dead door consumed none of it.
    expect((await fake.sendCommand(command('h1', 'healthy-door'))).outcome).toBe('failed');
    // Back up: the retried command is delivered.
    fake.scriptDevice('dead-door', null);
    expect(await fake.sendCommand(command('d1', 'dead-door'))).toEqual({ outcome: 'delivered' });
  });
});
