import { describe, expect, it } from 'vitest';
import type { AccessDeviceCommand } from '../entry.ports';
import { FakeAccessControlProvider } from './fake-access-control.provider';

const command = (commandId: string): AccessDeviceCommand => ({
  organizationId: '01a18600-0000-7000-8000-000000000001',
  deviceRef: 'turnstile-1',
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
});
