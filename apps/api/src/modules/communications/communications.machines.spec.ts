import { DomainError } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  DeliveryAttemptMachine,
  NotificationMachine,
  PushDeviceMachine,
  RecipientMachine,
  ScheduledMessageMachine,
} from './communications.machines';

describe('communications state machines (§4.6, SPK-COMMS-004)', () => {
  it('Notification: composed → queued → dispatched; composed/queued → suppressed; terminal states are final', () => {
    expect(NotificationMachine.next('composed', 'queue')).toBe('queued');
    expect(NotificationMachine.next('queued', 'dispatch')).toBe('dispatched');
    expect(NotificationMachine.next('composed', 'suppress')).toBe('suppressed');
    expect(NotificationMachine.next('queued', 'suppress')).toBe('suppressed');
    expect(NotificationMachine.can('composed', 'dispatch')).toBe(false);
    expect(NotificationMachine.can('dispatched', 'suppress')).toBe(false);
    expect(NotificationMachine.can('suppressed', 'queue')).toBe(false);
    expect(() => NotificationMachine.next('dispatched', 'queue')).toThrowError(DomainError);
    try {
      NotificationMachine.next('dispatched', 'queue');
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('Recipient: pending → authorized | revoked; authorized → revoked; revoked is final', () => {
    expect(RecipientMachine.next('pending', 'authorize')).toBe('authorized');
    expect(RecipientMachine.next('pending', 'revoke')).toBe('revoked');
    expect(RecipientMachine.next('authorized', 'revoke')).toBe('revoked');
    expect(RecipientMachine.can('revoked', 'authorize')).toBe(false);
    expect(RecipientMachine.can('authorized', 'authorize')).toBe(false);
  });

  it('DeliveryAttempt distinguishes queued, provider accepted, delivered, failed, unknown, read, acknowledged', () => {
    expect(DeliveryAttemptMachine.states).toEqual([
      'queued',
      'provider_accepted',
      'delivered',
      'failed',
      'unknown',
      'read',
      'acknowledged',
    ]);
    expect(DeliveryAttemptMachine.next('queued', 'accept')).toBe('provider_accepted');
    expect(DeliveryAttemptMachine.next('queued', 'lose_track')).toBe('unknown');
    expect(DeliveryAttemptMachine.next('queued', 'fail')).toBe('failed');
    expect(DeliveryAttemptMachine.next('provider_accepted', 'deliver')).toBe('delivered');
    expect(DeliveryAttemptMachine.next('provider_accepted', 'fail')).toBe('failed');
    expect(DeliveryAttemptMachine.next('unknown', 'deliver')).toBe('delivered');
    expect(DeliveryAttemptMachine.next('unknown', 'accept')).toBe('provider_accepted');
    expect(DeliveryAttemptMachine.next('unknown', 'fail')).toBe('failed');
    expect(DeliveryAttemptMachine.next('delivered', 'read')).toBe('read');
    expect(DeliveryAttemptMachine.next('delivered', 'acknowledge')).toBe('acknowledged');
    expect(DeliveryAttemptMachine.next('read', 'acknowledge')).toBe('acknowledged');
    // acceptance is not delivery and nothing resurrects a failed or acknowledged attempt
    expect(DeliveryAttemptMachine.can('provider_accepted', 'read')).toBe(false);
    expect(DeliveryAttemptMachine.can('failed', 'deliver')).toBe(false);
    expect(DeliveryAttemptMachine.can('acknowledged', 'read')).toBe(false);
    expect(DeliveryAttemptMachine.can('delivered', 'fail')).toBe(false);
    expect(DeliveryAttemptMachine.isTerminal('failed')).toBe(true);
    expect(DeliveryAttemptMachine.isTerminal('unknown')).toBe(false);
  });

  it('PushDevice (COM-01): active → revoked; a revoked registration is never reactivated', () => {
    expect(PushDeviceMachine.states).toEqual(['active', 'revoked']);
    expect(PushDeviceMachine.next('active', 'revoke')).toBe('revoked');
    expect(PushDeviceMachine.can('revoked', 'revoke')).toBe(false);
    expect(PushDeviceMachine.isTerminal('revoked')).toBe(true);
  });

  it('ScheduledMessage (SPK-COMMS-009): nothing is sent that was not confirmed; a confirmed message can return to needing confirmation; sent and canceled are final', () => {
    expect(ScheduledMessageMachine.initial).toBe('needs_confirmation');
    expect(ScheduledMessageMachine.states).toEqual([
      'needs_confirmation',
      'confirmed',
      'skipped',
      'sent',
      'canceled',
    ]);
    expect(ScheduledMessageMachine.next('needs_confirmation', 'confirm')).toBe('confirmed');
    expect(ScheduledMessageMachine.next('confirmed', 'send')).toBe('sent');
    expect(ScheduledMessageMachine.next('confirmed', 'reopen')).toBe('needs_confirmation');
    expect(ScheduledMessageMachine.next('needs_confirmation', 'skip')).toBe('skipped');
    expect(ScheduledMessageMachine.next('confirmed', 'skip')).toBe('skipped');
    expect(ScheduledMessageMachine.next('skipped', 'restore')).toBe('needs_confirmation');
    // only a confirmed message is ever sent
    expect(ScheduledMessageMachine.can('needs_confirmation', 'send')).toBe(false);
    expect(ScheduledMessageMachine.can('skipped', 'send')).toBe(false);
    expect(ScheduledMessageMachine.can('skipped', 'confirm')).toBe(false);
    for (const state of ['needs_confirmation', 'confirmed', 'skipped'] as const) {
      expect(ScheduledMessageMachine.next(state, 'cancel')).toBe('canceled');
    }
    for (const final of ['sent', 'canceled'] as const) {
      expect(ScheduledMessageMachine.isTerminal(final)).toBe(true);
      expect(ScheduledMessageMachine.eventsFrom(final)).toEqual([]);
    }
    expect(() => ScheduledMessageMachine.next('sent', 'reopen')).toThrowError(DomainError);
  });
});
