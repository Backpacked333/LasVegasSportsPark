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
});
