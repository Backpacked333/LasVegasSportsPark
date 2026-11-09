import { newId } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { FakeAccessControlProvider } from './fake-access-control.provider';

describe('fake access-control provider (§5.2 provider-selection gate, DEC-023)', () => {
  const base = {
    organizationId: newId(),
    facilityId: newId(),
    occurredAt: '2027-01-16T17:00:00.000Z',
  };

  it('produces granted, denied and unknown events with deterministic ids', () => {
    const device = new FakeAccessControlProvider();
    expect(device.granted(base).body).toMatchObject({
      id: 'turnstile-1-access.granted-1',
      type: 'access.granted',
    });
    expect(device.denied({ ...base, deviceId: 'gate' }).body).toMatchObject({
      id: 'gate-access.denied-2',
      type: 'access.denied',
    });
    expect(device.unknown({ ...base, eventId: 'fixed' }).body).toMatchObject({
      id: 'fixed',
      type: 'access.unknown',
    });
  });

  it('signs events so the webhook can authenticate them, independent of key order', () => {
    const { body, signature } = new FakeAccessControlProvider().granted(base);
    expect(FakeAccessControlProvider.verify(body, signature)).toBe(true);
    const reordered = { data: { ...body.data }, type: body.type, id: body.id };
    expect(FakeAccessControlProvider.verify(reordered, signature)).toBe(true);
    expect(FakeAccessControlProvider.verify({ ...body, type: 'access.denied' }, signature)).toBe(
      false,
    );
    expect(FakeAccessControlProvider.verify(body, undefined)).toBe(false);
    expect(FakeAccessControlProvider.verify(body, 'short')).toBe(false);
  });

  it('§4.14 / §5.2: a configured webhook secret replaces the published constant for device events', () => {
    const secret = 'e'.repeat(40);
    const device = new FakeAccessControlProvider({
      DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS: 3,
      DEVICE_COMMAND_RETRY_BASE_SECONDS: 30,
      DEVICE_COMMAND_RETRY_MAX_SECONDS: 300,
      FAKE_WEBHOOK_SECRET: secret,
    });
    const { body, signature } = device.granted(base);
    expect(FakeAccessControlProvider.verify(body, signature, secret)).toBe(true);
    expect(FakeAccessControlProvider.verify(body, signature)).toBe(false);
    expect(
      FakeAccessControlProvider.verify(body, FakeAccessControlProvider.sign(body), secret),
    ).toBe(false);
    const heartbeat = device.heartbeat({
      organizationId: base.organizationId,
      deviceRef: 'gate',
      at: base.occurredAt,
    });
    expect(FakeAccessControlProvider.verify(heartbeat.body, heartbeat.signature, secret)).toBe(
      true,
    );
    // Unset, the constant stays the default.
    const plain = new FakeAccessControlProvider().denied(base);
    expect(FakeAccessControlProvider.verify(plain.body, plain.signature)).toBe(true);
  });
});
