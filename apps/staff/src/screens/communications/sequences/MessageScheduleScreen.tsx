/**
 * The message schedule of a season or an offering (SPK-COMMS-009, proposed amendment PA-05;
 * capability `message_sequences`, DEC-099 pending).
 *
 * Each scheduled message of the record's sequences, in the order they are due, with the text as it
 * stands (the record's real details filled in) and its state. Nothing is sent until a staff member
 * confirms a message:
 *
 * - Preview shows the text and who would receive it now, by name and count, never a contact
 *   detail (SPK-COMMS-006). Recipients are resolved again when the message is sent, so the list
 *   is a preview, not a promise (SPK-COMMS-003).
 * - Edit keeps a copy of the title and text for this message only; the template is not changed.
 * - Skip means it is not sent. Confirm stores the exact text, which is sent when it is due.
 * - A detail the record cannot fill is named, and the message cannot be confirmed until it is
 *   filled or the text is edited. A raw placeholder is never sent.
 * - A message whose date moved, or whose text no longer stands, says so and asks to be confirmed
 *   again.
 * - A sent message shows what the notice it produced reports, with a link to its delivery status
 *   (SPK-COMMS-004).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { formatInstant } from '../../../features/operations/format';
import { Button } from '../../../ui/Button';
import { CommandButton } from '../../../ui/CommandButton';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../../ui/CommandFeedback';
import { TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { Toolbar } from '../../../ui/glass/GlassCard';
import {
  ATTENTION_TEXT,
  BLOCKER_TEXT,
  CANCEL_REASON,
  CATEGORY_LABEL,
  CONFIRM_ACTION,
  MANAGE_SEQUENCES_ACTION,
  MESSAGE_STATUS,
  PREVIEW_ACTION,
  PREVIEW_KEY,
  SCHEDULES_KEY,
  SKIP_ACTION,
  SUBJECT_NOUN,
  deliveryText,
  timingText,
  type MessageSchedule,
  type ScheduledMessage,
  type SubjectType,
} from './labels';
import { SequencesPage, useCanDo } from './page';
import { PlaceholderHelp, TitleAndBody } from './TemplateFields';

const INVALIDATE = [SCHEDULES_KEY, PREVIEW_KEY];

function Preview({ message, zone }: { message: ScheduledMessage; zone: string | null }) {
  const preview = useApiQuery({
    path: '/scheduled-messages/{id}/preview',
    request: { path: { id: message.id } },
  });
  return (
    <div className="ms-wide" role="group" aria-label={`Preview of ${message.title}`}>
      <QueryBoundary
        query={preview}
        label="the preview"
        empty={{ title: '', description: '' }}
        unavailableOffline={['previewing recipients']}
      >
        {(data) => (
          <>
            <div className="ms-message" aria-label="Message as it would be sent">
              <strong>{data.title}</strong>
              <p className="ms-text">{data.body}</p>
            </div>
            {data.missingPlaceholders.length > 0 ? (
              <p role="alert">
                <StatusBadge tone="warning" label="Details missing" /> This{' '}
                {SUBJECT_NOUN[message.subject.type]} cannot fill:{' '}
                {data.missingPlaceholders.map((p) => p.label).join(', ')}. Add the detail to the{' '}
                {SUBJECT_NOUN[message.subject.type]}, or edit the text of this message.
              </p>
            ) : null}
            {data.blockers
              .filter((b) => b !== 'missing_placeholder' && b !== 'not_awaiting_confirmation')
              .map((b) => (
                <p key={b} role="alert">
                  {BLOCKER_TEXT[b]}
                </p>
              ))}
            <p>
              {data.dueAt
                ? `Due ${formatInstant(data.dueAt, zone)}.`
                : 'It has no date to be sent on yet.'}{' '}
              {CATEGORY_LABEL[data.category]} message.
            </p>
            <h5>Who would receive it now</h5>
            {data.recipients.tooLarge ? (
              <p role="alert">
                More teams or people than one notice can address would receive this message, so it
                cannot be sent as one notice.
              </p>
            ) : (
              <>
                <p>
                  {data.recipients.count} {data.recipients.count === 1 ? 'person' : 'people'}
                  {data.recipients.reachableCount < data.recipients.count
                    ? `, ${data.recipients.count - data.recipients.reachableCount} with every channel switched off for this kind of message`
                    : ''}
                  .
                </p>
                {data.recipients.entries.length > 0 ? (
                  <ul className="list" aria-label="Recipients now">
                    {data.recipients.entries.map((entry) => (
                      <li key={entry.personId}>
                        <span className="row-title">{entry.displayName}</span>
                        {entry.reachable ? null : (
                          <StatusBadge tone="neutral" label="Switched this kind of message off" />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
            <p className="caption">
              Names and a count only. Recipients are worked out again from current permissions and
              preferences when the message is sent, so this list may change.
            </p>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function EditText({
  message,
  onDone,
  onCancel,
}: {
  message: ScheduledMessage;
  onDone: (outcome: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(message.sourceTitle);
  const [body, setBody] = useState(message.sourceBody);
  const edit = useApiCommand('post', '/scheduled-messages/{id}/edit', { invalidate: INVALIDATE });
  const apiErrors = fieldErrorsOf(edit.error);
  const send = (text: { title: string | null; body: string | null }, outcome: string) =>
    void edit
      .submit({
        path: { id: message.id },
        body: { ...text, expectedRevision: message.revision },
      })
      .then(() => onDone(outcome))
      .catch(() => undefined);
  return (
    <form
      noValidate
      className="form ms-wide"
      aria-label={`Edit the text of ${message.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || !body.trim()) return;
        send({ title: title.trim(), body: body.trim() }, 'Text saved for this message.');
      }}
    >
      <TitleAndBody
        title={title}
        body={body}
        onTitle={setTitle}
        onBody={setBody}
        errors={{ title: apiErrors.title, body: apiErrors.body }}
      />
      <PlaceholderHelp subject={message.subject.type} />
      <p className="caption">
        Saved for this message only. The template {message.templateName} is not changed.
        {message.status === 'confirmed' ? ' The message will need confirming again.' : ''}
      </p>
      <div className="actions-row">
        <CommandButton type="submit" busy={edit.isProcessing}>
          Save text
        </CommandButton>
        {message.edited ? (
          <CommandButton
            variant="secondary"
            busy={edit.isProcessing}
            onClick={() => send({ title: null, body: null }, 'Back to the text of the template.')}
          >
            Go back to the template
          </CommandButton>
        ) : null}
        <Button variant="secondary" onClick={onCancel}>
          Close without saving
        </Button>
      </div>
      <CommandError
        error={edit.error}
        onRetry={() => void edit.resend().catch(() => undefined)}
        onReload={() => edit.reset()}
      />
    </form>
  );
}

function SkipMessage({
  message,
  onDone,
  onCancel,
}: {
  message: ScheduledMessage;
  onDone: (outcome: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const skip = useApiCommand('post', '/scheduled-messages/{id}/skip', { invalidate: INVALIDATE });
  return (
    <div className="form ms-wide" role="group" aria-label={`Skip ${message.title}`}>
      <TextField
        label="Why is it skipped? (optional)"
        value={reason}
        onChange={setReason}
        hint="Kept with the schedule. A skipped message is not sent; it can be brought back."
      />
      <div className="actions-row">
        <CommandButton
          busy={skip.isProcessing}
          onClick={() =>
            void skip
              .submit({
                path: { id: message.id },
                body: {
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                  expectedRevision: message.revision,
                },
              })
              .then(() => onDone('Message skipped. It will not be sent.'))
              .catch(() => undefined)
          }
        >
          Skip this message
        </CommandButton>
        <Button variant="secondary" onClick={onCancel}>
          Keep it
        </Button>
      </div>
      <CommandError
        error={skip.error}
        onRetry={() => void skip.resend().catch(() => undefined)}
        onReload={() => skip.reset()}
      />
    </div>
  );
}

function MessageCard({
  message,
  zone,
  onOutcome,
}: {
  message: ScheduledMessage;
  zone: string | null;
  /** The outcome of a command, announced above the list (the card is rebuilt once it is saved). */
  onOutcome: (outcome: string | null) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'preview' | 'edit' | 'skip'>('none');
  const canConfirm = useCanDo(CONFIRM_ACTION);
  const canPreview = useCanDo(PREVIEW_ACTION, { needsCapability: false });
  const canSkip = useCanDo(SKIP_ACTION, { needsCapability: false });
  const confirm = useApiCommand('post', '/scheduled-messages/{id}/confirm', {
    invalidate: INVALIDATE,
  });
  const restore = useApiCommand('post', '/scheduled-messages/{id}/restore', {
    invalidate: INVALIDATE,
  });
  const status = MESSAGE_STATUS[message.status];
  const subject = message.subject.type;
  const open = message.status === 'needs_confirmation' || message.status === 'confirmed';
  const blocked = message.missingPlaceholders.length > 0 || message.dueAt === null;
  const done = (text: string) => {
    onOutcome(text);
    setPanel('none');
  };
  const toggle = (next: 'preview' | 'edit' | 'skip') => {
    onOutcome(null);
    setPanel((current) => (current === next ? 'none' : next));
  };
  const act = (command: typeof confirm | typeof restore, text: string) => {
    onOutcome(null);
    void command
      .submit({ path: { id: message.id }, body: { expectedRevision: message.revision } })
      .then(() => done(text))
      .catch(() => undefined);
  };
  return (
    <li className="card ms-card" aria-label={message.title}>
      <div className="ms-card-head">
        <span className="row-text">
          <span className="row-title">{message.title}</span>
          <span className="caption">
            {message.dueAt ? `Due ${formatInstant(message.dueAt, zone)}` : 'No date yet'} ·{' '}
            {timingText(message, subject)} · {message.sequenceName} · {message.templateName}
          </span>
        </span>
        <span className="ms-badges">
          <StatusBadge tone={status.tone} label={status.label} />
          <StatusBadge
            tone={message.category === 'operational' ? 'info' : 'neutral'}
            label={CATEGORY_LABEL[message.category]}
          />
          {message.edited ? <StatusBadge tone="neutral" label="Text edited" /> : null}
        </span>
      </div>
      <p className="ms-text">{message.body}</p>
      {message.attention ? (
        <p role="alert">
          <StatusBadge tone="warning" label="Needs your attention" />{' '}
          {ATTENTION_TEXT[message.attention]}
        </p>
      ) : null}
      {open && message.missingPlaceholders.length > 0 ? (
        <p role="alert">
          <StatusBadge tone="warning" label="Details missing" /> It cannot be confirmed until this{' '}
          {SUBJECT_NOUN[subject]} has what the text needs, or the text is edited. Preview it to see
          what is missing.
        </p>
      ) : null}
      {open && message.dueAt === null ? (
        <p role="alert">
          <StatusBadge tone="warning" label="No date yet" /> It gets its time when the{' '}
          {SUBJECT_NOUN[subject]} has the date it is counted from.
        </p>
      ) : null}
      {message.status === 'skipped' ? (
        <p>
          Skipped{message.skippedAt ? ` ${formatInstant(message.skippedAt, zone)}` : ''}
          {message.skipReason ? `: ${message.skipReason}` : '.'}
        </p>
      ) : null}
      {message.status === 'canceled' ? (
        <p>Canceled: {CANCEL_REASON[message.cancelReason ?? ''] ?? 'it is no longer needed'}.</p>
      ) : null}
      {message.status === 'sent' && message.delivery ? (
        <p>
          <StatusBadge
            tone={message.delivery.notificationStatus === 'suppressed' ? 'warning' : 'success'}
            label={deliveryText(message.delivery)}
          />{' '}
          {message.sentAt ? `Sent ${formatInstant(message.sentAt, zone)}. ` : ''}
          <Link to={`/communications/notifications/${message.delivery.notificationId}`}>
            Delivery status of {message.title}
          </Link>
        </p>
      ) : null}
      {open || message.status === 'skipped' ? (
        <div className="actions-row" role="group" aria-label={`Actions for ${message.title}`}>
          {open && canPreview ? (
            <Button
              variant="secondary"
              aria-expanded={panel === 'preview'}
              onClick={() => toggle('preview')}
            >
              {panel === 'preview' ? 'Close preview' : 'Preview'}
            </Button>
          ) : null}
          {open && canConfirm ? (
            <Button
              variant="secondary"
              aria-expanded={panel === 'edit'}
              onClick={() => toggle('edit')}
            >
              Edit text
            </Button>
          ) : null}
          {open && canSkip ? (
            <Button
              variant="secondary"
              aria-expanded={panel === 'skip'}
              onClick={() => toggle('skip')}
            >
              Skip
            </Button>
          ) : null}
          {message.status === 'needs_confirmation' && canConfirm ? (
            <CommandButton
              busy={confirm.isProcessing}
              disabled={blocked}
              onClick={() =>
                act(confirm, 'Confirmed. It will be sent when it is due, to the recipients then.')
              }
            >
              Confirm
            </CommandButton>
          ) : null}
          {message.status === 'skipped' && canConfirm ? (
            <CommandButton
              variant="secondary"
              busy={restore.isProcessing}
              onClick={() => act(restore, 'Brought back. It needs confirming before it is sent.')}
            >
              Bring back
            </CommandButton>
          ) : null}
        </div>
      ) : null}
      <CommandError
        error={confirm.error ?? restore.error}
        onRetry={() => void (confirm.error ? confirm : restore).resend().catch(() => undefined)}
        onReload={() => {
          confirm.reset();
          restore.reset();
        }}
      />
      {panel === 'preview' ? <Preview message={message} zone={zone} /> : null}
      {panel === 'edit' ? (
        <EditText message={message} onDone={done} onCancel={() => setPanel('none')} />
      ) : null}
      {panel === 'skip' ? (
        <SkipMessage message={message} onDone={done} onCancel={() => setPanel('none')} />
      ) : null}
    </li>
  );
}

function Produce({ schedule }: { schedule: MessageSchedule }) {
  const canManage = useCanDo(MANAGE_SEQUENCES_ACTION);
  const generate = useApiCommand('post', '/message-schedules/{subjectType}/{subjectId}/generate', {
    invalidate: INVALIDATE,
  });
  if (!canManage) return null;
  return (
    <>
      <Toolbar aria-label="Schedule actions" role="group">
        <span className="caption">
          {schedule.sequences.length === 0
            ? 'No sequence that is switched on applies.'
            : `Applies: ${schedule.sequences.map((s) => s.name).join(', ')}.`}
        </span>
        <CommandButton
          variant="secondary"
          busy={generate.isProcessing}
          disabled={schedule.sequences.length === 0}
          onClick={() =>
            void generate
              .submit({
                path: { subjectType: schedule.subject.type, subjectId: schedule.subject.id },
                body: {},
              })
              .catch(() => undefined)
          }
        >
          Produce the schedule
        </CommandButton>
      </Toolbar>
      {generate.status === 'success' ? (
        <CommandSuccess message="Schedule up to date. Messages that were already there are kept." />
      ) : null}
      <CommandError
        error={generate.error}
        onRetry={() => void generate.resend().catch(() => undefined)}
      />
    </>
  );
}

function isSubjectType(value: string | undefined): value is SubjectType {
  return value === 'season' || value === 'offering';
}

export function MessageScheduleScreen() {
  const { subjectType, subjectId = '' } = useParams();
  const [outcome, setOutcome] = useState<string | null>(null);
  const known = isSubjectType(subjectType);
  const schedule = useApiQuery({
    path: '/message-schedules/{subjectType}/{subjectId}',
    request: { path: { subjectType: known ? subjectType : 'season', subjectId } },
    enabled: known,
  });
  const back = known
    ? subjectType === 'season'
      ? { to: `/leagues/seasons/${subjectId}`, label: 'Back to the season' }
      : { to: `/programs/offerings/${subjectId}`, label: 'Back to the offering' }
    : null;
  return (
    <SequencesPage
      titleId="message-schedule-title"
      title={schedule.data ? `Message schedule: ${schedule.data.subjectName}` : 'Message schedule'}
      intro="What this record's sequences will send and when. Nothing is sent until a staff member confirms it, and a confirmed message goes to whoever may receive it at that moment."
      actions={
        back ? (
          <Link className="button button-secondary" to={back.to}>
            {back.label}
          </Link>
        ) : null
      }
      stillAvailable="The schedule stays readable and a message can still be skipped. Nothing is confirmed or sent."
    >
      {known ? (
        <QueryBoundary
          query={schedule}
          label="the message schedule"
          empty={{ title: '', description: '' }}
          unavailableOffline={['confirming, editing and skipping messages']}
        >
          {(data) => (
            <>
              <Produce schedule={data} />
              {data.messages.length === 0 ? (
                <StateView
                  variant="empty"
                  title="No scheduled messages"
                  description={`No sequence has produced messages for this ${SUBJECT_NOUN[data.subject.type]} yet. A sequence that is switched on produces them when a ${SUBJECT_NOUN[data.subject.type]} is ${data.subject.type === 'season' ? 'created' : 'published'}, or on request.`}
                />
              ) : (
                <>
                  <CommandSuccess message={outcome} />
                  <ul className="ms-schedule" aria-label="Scheduled messages">
                    {data.messages.map((message) => (
                      // Keyed by revision: after a command the card starts from the saved message.
                      <MessageCard
                        key={`${message.id}:${message.revision}`}
                        message={message}
                        zone={data.timezone}
                        onOutcome={setOutcome}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </QueryBoundary>
      ) : (
        <StateView variant="unavailable" />
      )}
    </SequencesPage>
  );
}
