/**
 * The title and text of a message with its placeholders (SPK-COMMS-009): used to write a template
 * and to edit the copy kept for one scheduled message. The placeholder vocabulary comes from
 * `GET /v1/message-placeholders`; a name outside it is refused by the API at the field.
 */
import { useId } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import { TextAreaField, TextField } from '../../../ui/FormFields';
import { SUBJECT_LABEL, type SubjectType } from './labels';

export function PlaceholderHelp({ subject }: { subject?: SubjectType }) {
  const titleId = useId();
  const placeholders = useApiQuery({ path: '/message-placeholders', staleTime: Infinity });
  const items = (placeholders.data?.items ?? []).filter(
    (p) => !subject || p.subjects.includes(subject),
  );
  if (items.length === 0) return null;
  return (
    <div className="ms-placeholders">
      <p className="caption" id={titleId}>
        Placeholders are filled in with the real details of each season or offering. A placeholder
        that cannot be filled is never sent as written: the message waits until it is filled or its
        text is edited.
      </p>
      <ul aria-label="Placeholders" aria-describedby={titleId}>
        {items.map((p) => (
          <li key={p.name}>
            <code>{`{{${p.name}}}`}</code>
            <span className="caption">
              {p.label}
              {subject
                ? ''
                : ` (${p.subjects.map((s) => SUBJECT_LABEL[s].toLowerCase()).join(', ')})`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TitleAndBody({
  title,
  body,
  onTitle,
  onBody,
  errors,
}: {
  title: string;
  body: string;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      <TextField label="Title" value={title} onChange={onTitle} required error={errors.title} />
      <TextAreaField
        label="Text"
        value={body}
        onChange={onBody}
        required
        rows={6}
        maxLength={4000}
        error={errors.body}
      />
    </>
  );
}
