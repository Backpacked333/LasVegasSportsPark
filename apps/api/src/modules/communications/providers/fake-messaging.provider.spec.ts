import { newId } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import type { ChannelSendRequest } from '../ports';
import {
  FakeEmailProvider,
  FakeMessagingProvider,
  FakePushProvider,
} from './fake-messaging.provider';

const request = (overrides: Partial<ChannelSendRequest> = {}): ChannelSendRequest => ({
  attemptId: newId(),
  organizationId: newId(),
  notificationId: newId(),
  channel: 'email',
  personId: newId(),
  address: 'person@example.test',
  title: 'Title',
  body: 'Body',
  category: 'operational',
  correlationId: null,
  ...overrides,
});

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
