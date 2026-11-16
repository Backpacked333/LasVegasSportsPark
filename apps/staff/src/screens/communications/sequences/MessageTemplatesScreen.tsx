/**
 * Message templates (SPK-COMMS-009, proposed amendment PA-05; capability `message_sequences`,
 * DEC-099 pending): the list with a form to write a new one, and one template to change or
 * archive.
 *
 * A template is a title and a text with named placeholders, and it is essential or promotional
 * for good (SPK-COMMS-007): a message confirmed as one is never sent as the other, so the category
 * is chosen once. Changing a template never changes what was already sent, nor a copy edited for
 * one message; a message confirmed from the old text asks to be confirmed again.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { CommandButton } from '../../../ui/CommandButton';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../../ui/CommandFeedback';
import { SelectField, TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import {
  CATEGORY_LABEL,
  MANAGE_TEMPLATES_ACTION,
  SCHEDULES_KEY,
  TEMPLATES_KEY,
  type Template,
} from './labels';
import { SequencesPage, useCanDo } from './page';
import { PlaceholderHelp, TitleAndBody } from './TemplateFields';

const STILL_AVAILABLE = 'Templates that exist stay listed. Nothing new can be written.';

function CreateTemplate() {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Template['category'] | ''>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<string | null>(null);
  const create = useApiCommand('post', '/message-templates', { invalidate: [TEMPLATES_KEY] });
  const apiErrors = fieldErrorsOf(create.error);
  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Give the template a name.';
    if (!category) next.category = 'Choose essential or promotional.';
    if (!title.trim()) next.title = 'A title is required.';
    if (!body.trim()) next.body = 'A text is required.';
    setProblems(next);
    setCreated(null);
    if (Object.keys(next).length > 0 || !category) return;
    void create
      .submit({ body: { name: name.trim(), category, title: title.trim(), body: body.trim() } })
      .then((template) => {
        setCreated(`Template "${template.name}" saved.`);
        setName('');
        setTitle('');
        setBody('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="card" aria-labelledby="ms-new-template">
      <h3 id="ms-new-template">New template</h3>
      <form
        noValidate
        className="form"
        aria-label="New template"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          required
          hint="How staff find it, for example Season welcome."
          error={problems.name ?? apiErrors.name}
        />
        <SelectField
          label="Category"
          value={category}
          onChange={(value) => setCategory(value as Template['category'] | '')}
          required
          placeholder="Choose"
          options={[
            { value: 'operational', label: 'Essential operational notice' },
            { value: 'promotional', label: 'Promotional message' },
          ]}
          hint="Chosen once. Recipients choose promotional channels separately."
          error={problems.category ?? apiErrors.category}
        />
        <TitleAndBody
          title={title}
          body={body}
          onTitle={setTitle}
          onBody={setBody}
          errors={{
            title: problems.title ?? apiErrors.title,
            body: problems.body ?? apiErrors.body,
          }}
        />
        <PlaceholderHelp />
        <div className="actions-row">
          <CommandButton type="submit" busy={create.isProcessing}>
            Save template
          </CommandButton>
        </div>
        <CommandSuccess message={created} />
        <CommandError
          error={create.error}
          onRetry={() => void create.resend().catch(() => undefined)}
        />
      </form>
    </section>
  );
}

export function MessageTemplatesScreen() {
  const templates = useApiQuery({ path: '/message-templates' });
  const canManage = useCanDo(MANAGE_TEMPLATES_ACTION);
  return (
    <SequencesPage
      titleId="message-templates-title"
      title="Message templates"
      intro="Reusable messages with placeholders for the details of a season or an offering. A sequence sends them at set times, after a staff member confirms each one."
      stillAvailable={STILL_AVAILABLE}
    >
      <QueryBoundary
        query={templates}
        label="message templates"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No templates yet',
          description: 'Write the first template below, then use it in a sequence.',
        }}
        unavailableOffline={['writing and changing templates']}
      >
        {(data) => (
          <ul className="list list-card" aria-label="Message templates">
            {data.items.map((template) => (
              <li key={template.id}>
                <span className="row-text">
                  <Link className="row-title" to={`/communications/templates/${template.id}`}>
                    {template.name}
                  </Link>
                  <span className="caption">{template.title}</span>
                </span>
                <span className="ms-badges">
                  <StatusBadge
                    tone={template.category === 'operational' ? 'info' : 'neutral'}
                    label={CATEGORY_LABEL[template.category]}
                  />
                  {template.status === 'archived' ? (
                    <StatusBadge tone="neutral" label="Archived" />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      {canManage ? <CreateTemplate /> : null}
    </SequencesPage>
  );
}

function EditTemplate({
  template,
  canManage,
  onOutcome,
}: {
  template: Template;
  canManage: boolean;
  /** Announced by the screen: this form is rebuilt from the saved template after a save. */
  onOutcome: (outcome: string | null) => void;
}) {
  const [name, setName] = useState(template.name);
  const [title, setTitle] = useState(template.title);
  const [body, setBody] = useState(template.body);
  const update = useApiCommand('patch', '/message-templates/{id}', {
    // Messages confirmed from the old text ask to be confirmed again: schedules are read afresh.
    invalidate: [TEMPLATES_KEY, ['api', '/message-templates/{id}'], SCHEDULES_KEY],
  });
  const apiErrors = fieldErrorsOf(update.error);
  const send = (
    changes: { name?: string; title?: string; body?: string; status?: Template['status'] },
    done: string,
  ) => {
    onOutcome(null);
    void update
      .submit({
        path: { id: template.id },
        body: { ...changes, expectedRevision: template.revision },
      })
      .then(() => onOutcome(done))
      .catch(() => undefined);
  };
  const archived = template.status === 'archived';
  return (
    <section className="card" aria-labelledby="ms-template">
      <h3 id="ms-template">{template.name}</h3>
      <p className="ms-badges">
        <StatusBadge
          tone={template.category === 'operational' ? 'info' : 'neutral'}
          label={CATEGORY_LABEL[template.category]}
        />
        {archived ? <StatusBadge tone="neutral" label="Archived" /> : null}
      </p>
      <p className="caption">
        The category is chosen once and cannot be changed: a message confirmed as essential is never
        sent as promotional, or the other way round. Write a new template for the other category.
      </p>
      {canManage ? (
        <form
          noValidate
          className="form"
          aria-label="Change template"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !title.trim() || !body.trim()) return;
            send({ name: name.trim(), title: title.trim(), body: body.trim() }, 'Template saved.');
          }}
        >
          <TextField label="Name" value={name} onChange={setName} required error={apiErrors.name} />
          <TitleAndBody
            title={title}
            body={body}
            onTitle={setTitle}
            onBody={setBody}
            errors={{ title: apiErrors.title, body: apiErrors.body }}
          />
          <PlaceholderHelp />
          <p className="caption">
            Messages already sent keep their text. A message that was confirmed from the old text
            will ask to be confirmed again.
          </p>
          <div className="actions-row">
            <CommandButton type="submit" busy={update.isProcessing}>
              Save changes
            </CommandButton>
            <CommandButton
              variant="secondary"
              busy={update.isProcessing}
              onClick={() =>
                archived
                  ? send({ status: 'active' }, 'Template in use again.')
                  : send({ status: 'archived' }, 'Template archived.')
              }
            >
              {archived ? 'Use this template again' : 'Archive this template'}
            </CommandButton>
          </div>
          <CommandError
            error={update.error}
            onRetry={() => void update.resend().catch(() => undefined)}
            onReload={() => update.reset()}
          />
        </form>
      ) : (
        <>
          <dl className="facts">
            <div className="fact">
              <dt>Title</dt>
              <dd>{template.title}</dd>
            </div>
            <div className="fact">
              <dt>Text</dt>
              <dd className="ms-text">{template.body}</dd>
            </div>
          </dl>
          <p className="caption">Changing templates is not available to you here.</p>
        </>
      )}
    </section>
  );
}

export function MessageTemplateScreen() {
  const { templateId = '' } = useParams();
  const template = useApiQuery({
    path: '/message-templates/{id}',
    request: { path: { id: templateId } },
  });
  const canManage = useCanDo(MANAGE_TEMPLATES_ACTION);
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <SequencesPage
      titleId="message-template-title"
      title="Message template"
      intro="Change the name, title or text of a template, or archive it so it starts no new step."
      actions={
        <Link className="button button-secondary" to="/communications/templates">
          All templates
        </Link>
      }
      stillAvailable="The template stays readable. It cannot be changed."
    >
      <QueryBoundary
        query={template}
        label="the template"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the template']}
      >
        {(data) => (
          <>
            {/* Keyed by revision: after a save the form starts from the saved text. */}
            <EditTemplate
              key={`${data.id}:${data.revision}`}
              template={data}
              canManage={canManage}
              onOutcome={setOutcome}
            />
            <CommandSuccess message={outcome} />
          </>
        )}
      </QueryBoundary>
    </SequencesPage>
  );
}
