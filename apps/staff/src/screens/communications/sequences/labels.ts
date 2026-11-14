/**
 * Words for message templates, sequences and schedules (SPK-COMMS-009, proposed amendment PA-05;
 * DEC-099 pending). State names are plain words (SPK-UX-010); a pending rule is named with its
 * decision record and never invented.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../../ui/StatusBadge';

export type Template = Schema<'MessageTemplate'>;
export type Sequence = Schema<'MessageSequence'>;
export type SequenceStep = Schema<'MessageSequenceStep'>;
export type ScheduledMessage = Schema<'ScheduledMessage'>;
export type MessageSchedule = Schema<'MessageSchedule'>;
export type MessagePreview = Schema<'ScheduledMessagePreview'>;
export type SubjectType = Schema<'MessageSubjectType'>;
export type Anchor = Schema<'MessageAnchor'>;

export const READ_ACTION = 'communications.read_message_schedule';
export const MANAGE_TEMPLATES_ACTION = 'communications.manage_message_templates';
export const MANAGE_SEQUENCES_ACTION = 'communications.manage_message_sequences';
export const PREVIEW_ACTION = 'communications.preview_scheduled_message';
export const CONFIRM_ACTION = 'communications.confirm_scheduled_message';
export const SKIP_ACTION = 'communications.skip_scheduled_message';

export const PROPOSED_NOTE = 'Proposed, DEC-099 pending';

export const TEMPLATES_KEY = ['api', '/message-templates'] as const;
export const SEQUENCES_KEY = ['api', '/message-sequences'] as const;
export const SCHEDULES_KEY = ['api', '/message-schedules/{subjectType}/{subjectId}'] as const;
export const PREVIEW_KEY = ['api', '/scheduled-messages/{id}/preview'] as const;

export const CATEGORY_LABEL: Record<Template['category'], string> = {
  operational: 'Essential',
  promotional: 'Promotional',
};

export const SUBJECT_LABEL: Record<SubjectType, string> = {
  season: 'Seasons',
  offering: 'Offerings',
};

export const SUBJECT_NOUN: Record<SubjectType, string> = {
  season: 'season',
  offering: 'offering',
};

const ANCHOR_PHRASE: Record<Anchor, { season: string; offering: string }> = {
  registration_opens: { season: 'registration opens', offering: 'registration opens' },
  registration_closes: { season: 'registration closes', offering: 'registration closes' },
  starts: { season: 'the season starts', offering: 'the offering starts' },
  ends: { season: 'the season ends', offering: 'the offering ends' },
  first_game: { season: 'the first game', offering: 'the first game' },
};

/** The anchors a sequence about each kind of record may count from. */
export const ANCHORS: Record<SubjectType, readonly Anchor[]> = {
  season: ['registration_opens', 'registration_closes', 'starts', 'ends', 'first_game'],
  offering: ['registration_opens', 'registration_closes', 'starts', 'ends'],
};

export function anchorLabel(anchor: Anchor, subject: SubjectType): string {
  const phrase = ANCHOR_PHRASE[anchor][subject];
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** "7 days before the season starts, at 09:00" (facility time). */
export function timingText(
  step: { anchor: Anchor; offsetDays: number; sendTimeLocal: string },
  subject: SubjectType,
): string {
  const phrase = ANCHOR_PHRASE[step.anchor][subject];
  const days = Math.abs(step.offsetDays);
  const count = `${days} ${days === 1 ? 'day' : 'days'}`;
  const when =
    step.offsetDays === 0
      ? `On the day ${phrase}`
      : step.offsetDays < 0
        ? `${count} before ${phrase}`
        : `${count} after ${phrase}`;
  return `${when}, at ${step.sendTimeLocal}`;
}

export const MESSAGE_STATUS: Record<
  ScheduledMessage['status'],
  { tone: StatusTone; label: string }
> = {
  needs_confirmation: { tone: 'pending', label: 'Needs confirmation' },
  confirmed: { tone: 'info', label: 'Confirmed, waiting for its time' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  sent: { tone: 'success', label: 'Sent' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

export const ATTENTION_TEXT: Record<NonNullable<ScheduledMessage['attention']>, string> = {
  anchor_moved:
    'Its date moved after it was confirmed, so its time moved with it. Check it and confirm it again.',
  text_changed:
    'The text that would be sent is no longer the text that was confirmed (the template, the step or the details changed). Check it and confirm it again.',
  no_audience:
    'Nobody was there to receive it when it was due, so nothing was sent. Confirm it again to send it now, or skip it.',
  audience_too_large:
    'More teams or people than one notice can address would receive it, so nothing was sent.',
};

export const CANCEL_REASON: Record<string, string> = {
  record_archived: 'archived, so nothing more is sent',
  step_removed: 'its step was removed from the sequence',
};

export const BLOCKER_TEXT: Record<MessagePreview['blockers'][number], string> = {
  missing_placeholder: 'A detail the message needs is missing.',
  no_due_time: 'It has no date to be sent on yet.',
  text_too_long: 'With its details filled in, the text is too long for a notice.',
  not_awaiting_confirmation: 'It is not waiting for a confirmation.',
};

/** What the notification a sent message produced reports (SPK-COMMS-004: never a guess). */
export function deliveryText(delivery: NonNullable<ScheduledMessage['delivery']>): string {
  const people = `${delivery.recipientCount} ${delivery.recipientCount === 1 ? 'person' : 'people'}`;
  switch (delivery.notificationStatus) {
    case 'dispatched':
      return `Sent to ${people}.`;
    case 'queued':
      return `Queued for ${people}.`;
    case 'suppressed':
      return delivery.suppressionReason === 'no_recipients'
        ? 'Not delivered: nobody could receive it when it was sent.'
        : 'Not delivered: the notice was withdrawn.';
    case 'composed':
      return 'Composed, not sent yet.';
  }
}
