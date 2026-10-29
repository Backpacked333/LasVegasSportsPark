import { newId } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import type { ChannelSendRequest } from '../ports';
import {
  FakeEmailProvider,
  FakeMessagingProvider,
  FakePushProvider,
} from './fake-messaging.provider';

const request = (overrides: Partial<ChannelSendRequest> = {}): ChannelSendRequest => {
  const address = overrides.address ?? overrides.addresses?.[0] ?? 'person@example.test';
  return {
    attemptId: newId(),
    organizationId: newId(),
    notificationId: newId(),
    channel: 'email',
    personId: newId(),
    title: 'Title',
    body: 'Body',
    category: 'operational',
    correlationId: null,
    ...overrides,
    address,
    addresses: overrides.addresses ?? [address],
  };
};

describe('fake messaging providers (§5.2 provider-selection gate, SPK-COMMS-004 outcomes)', () => {
  it('accepts by default with a deterministic provider message id and records every request', async () => {
    const email = new FakeEmailProvider();
    const r = request();
    const result = await email.send(r);
    expect(result).toMatchObject({
      outcome: 'accepted',
      providerMessageId: `email-${r.attemptId}`,
    });
    expect(email.sent).toEqual([r]);
  });

  it('fails or loses track by address convention or by script, and can throw like a broken adapter', async () => {
    const push = new FakePushProvider();
    expect((await push.send(request({ address: 'person:x+fail' }))).outcome).toBe('failed');
    expect((await push.send(request({ address: 'person:x+unknown' }))).outcome).toBe('unknown');
    push.scriptNext('unknown', 'failed');
    expect((await push.send(request({ address: 'person:ok' }))).outcome).toBe('unknown');
    expect((await push.send(request({ address: 'person:ok' }))).outcome).toBe('failed');
    expect((await push.send(request({ address: 'person:ok' }))).outcome).toBe('accepted');
    push.scriptAddress('person:bad', 'failed');
    expect((await push.send(request({ address: 'person:bad' }))).outcome).toBe('failed');
    push.scriptNext('throw');
    await expect(push.send(request())).rejects.toThrow(/transport failure/);
    push.reset();
    expect(push.sent).toHaveLength(0);
  });

  it('COM-01: the push fake fans out per device: accepted when any device accepted, unknown when none accepted and one is unknown, failed only when every device rejected', async () => {
    const push = new FakePushProvider();
    const mixed = request({ channel: 'push', addresses: ['tok-a', 'tok-b+fail', 'tok-c+unknown'] });
    expect(await push.send(mixed)).toMatchObject({
      outcome: 'accepted',
      providerMessageId: `push-${mixed.attemptId}`,
      response: { devices: { accepted: 1, failed: 1, unknown: 1 } },
    });
    expect(push.deviceSends.map((d) => [d.address, d.outcome])).toEqual([
      ['tok-a', 'accepted'],
      ['tok-b+fail', 'failed'],
      ['tok-c+unknown', 'unknown'],
    ]);
    expect(
      (await push.send(request({ channel: 'push', addresses: ['x+fail', 'y+unknown'] }))).outcome,
    ).toBe('unknown');
    expect(
      (await push.send(request({ channel: 'push', addresses: ['x+fail', 'y+fail'] }))).outcome,
    ).toBe('failed');
  });

  it('duplicate scenario: a second hand-off of an accepted attempt answers the same message id and reaches no device again', async () => {
    const push = new FakePushProvider();
    const first = request({ channel: 'push', addresses: ['tok-1', 'tok-2'] });
    const accepted = await push.send(first);
    const again = await push.send(first);
    expect(again).toMatchObject({
      outcome: 'accepted',
      providerMessageId: (accepted as { providerMessageId: string }).providerMessageId,
      response: { duplicate: true },
    });
    expect(push.sent).toHaveLength(2);
    expect(push.deviceSends).toHaveLength(2);
  });

  it('signs receipts so the webhook can authenticate them, independent of key order', () => {
    const email = new FakeEmailProvider();
    const { body, signature } = email.receipt(
      { attemptId: newId(), organizationId: newId() },
      'delivered',
    );
    expect(FakeMessagingProvider.verify(body, signature)).toBe(true);
    const reordered = { data: { ...body.data }, type: body.type, id: body.id };
    expect(FakeMessagingProvider.verify(reordered, signature)).toBe(true);
    expect(FakeMessagingProvider.verify({ ...body, id: 'tampered' }, signature)).toBe(false);
    expect(FakeMessagingProvider.verify(body, undefined)).toBe(false);
    expect(FakeMessagingProvider.verify(body, 'short')).toBe(false);
  });
});
