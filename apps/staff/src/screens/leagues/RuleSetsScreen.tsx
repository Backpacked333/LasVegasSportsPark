/**
 * SCR-S-08 rule sets (SPK-COMP-002 configurable formats and rule sets, SPK-RESULT-003 versioned
 * rule sets, SPK-UX-008): versions are immutable; posting an existing name creates its next
 * version, never an edit. A new version starts from the version it supersedes; a new rule set
 * starts empty because the approved values are pending DEC-002. Validation failures (a rule set
 * incomplete for its format) show each field message next to its field and keep the input.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { keys, PendingNote, SuccessNote } from '../../features/competition/feedback';
import { CheckboxField, SelectField, TextField } from '../../features/competition/fields';
import { formatInstant } from '../../features/competition/format';
import { SPORT_FORMAT, humanizeCode } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { FORMAT_OPTIONS } from './LeaguesScreen';
import { RuleSetFields } from './RuleSetForm';
import {
  buildContent,
  contentFieldErrors,
  draftFromContent,
  emptyDraft,
  type RuleDraft,
  type SportFormat,
} from './rule-set-form';

type RuleSet = Schema<'RuleSet'>;

function RuleSetEditor({ base, onDone }: { base: RuleSet | null; onDone: () => void }) {
  const create = useApiCommand('post', '/rule-sets', { invalidate: keys('/rule-sets') });
  const [name, setName] = useState(base?.name ?? '');
  const [format, setFormat] = useState<SportFormat | ''>(base?.format ?? '');
  const [draft, setDraft] = useState<RuleDraft>(() =>
    base ? draftFromContent(base.content) : emptyDraft(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = contentFieldErrors(fieldErrorsOf(create.error));
  const shown = { ...apiErrors, ...errors };

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter the rule set name.';
    const built = buildContent(format, draft);
    Object.assign(next, built.errors);
    setErrors(next);
    if (Object.keys(next).length > 0 || !built.content || !format) return;
    void create
      .submit({ body: { name: name.trim(), format, content: built.content } })
      .catch(() => undefined);
  };

  const missing = Object.keys(errors).length;
  return (
    <form
      className="form rule-set-form"
      noValidate
      aria-label={base ? `New version of ${base.name}` : 'New rule set'}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Rule set name"
        required
        value={name}
        onChange={setName}
        disabled={!!base}
        hint={base ? 'A next version keeps the name of the version it supersedes.' : undefined}
        error={shown.name}
      />
      <SelectField
        label="Format"
        required
        value={format}
        onChange={(v) => setFormat(v as SportFormat | '')}
        options={FORMAT_OPTIONS}
        disabled={!!base}
        error={shown.format}
      />
      <RuleSetFields format={format} draft={draft} onChange={setDraft} errors={shown} />
      {missing > 0 ? (
        <p className="error-text" role="alert">
          {missing === 1 ? 'One answer needs attention.' : `${missing} answers need attention.`}
        </p>
      ) : null}
      <div className="actions">
        <CommandButton type="submit" busy={create.isProcessing}>
          {base ? `Save version ${base.version + 1}` : 'Create rule set'}
        </CommandButton>
        <Button variant="secondary" onClick={onDone}>
          Close
        </Button>
      </div>
      {create.status === 'success' && create.data ? (
        <SuccessNote>{`${create.data.name}, version ${create.data.version} saved`}</SuccessNote>
      ) : null}
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

function RuleSetSummary({ ruleSet }: { ruleSet: RuleSet }) {
  const c = ruleSet.content;
  return (
    <dl className="facets" aria-label={`Rules of ${ruleSet.name}, version ${ruleSet.version}`}>
      <div>
        <dt>Players</dt>
        <dd>
          {c.playersOnField} on field, minimum {c.minimumPlayers}; roster {c.rosterMin} to{' '}
          {c.rosterMax}
        </dd>
      </div>
      <div>
        <dt>Match</dt>
        <dd>
          {c.periods} periods, {c.matchLengthMinutes} minutes
        </dd>
      </div>
      <div>
        <dt>Scoring</dt>
        <dd>
          Win {c.scoring.win}, draw {c.scoring.draw}, loss {c.scoring.loss}
          {c.drawsAllowed ? '' : '; no draws'}
        </dd>
      </div>
      <div>
        <dt>Tiebreakers</dt>
        <dd>{c.tiebreakers.map(humanizeCode).join(', ')}</dd>
      </div>
      <div>
        <dt>Protest deadline</dt>
        <dd>{c.protestDeadlineHours} hours</dd>
      </div>
      <div>
        <dt>Publish results</dt>
        <dd>League manager and {c.resultApproval.approveRoles.map(humanizeCode).join(', ')}</dd>
      </div>
    </dl>
  );
}

export function RuleSetsScreen() {
  const [allVersions, setAllVersions] = useState(false);
  const [editing, setEditing] = useState<{ base: RuleSet | null } | null>(null);
  const ruleSets = useApiQuery({
    path: '/rule-sets',
    request: { query: { latestOnly: allVersions ? 'false' : 'true' } },
  });
  return (
    <section aria-labelledby="rule-sets-title">
      <h2 id="rule-sets-title">Rule sets</h2>
      <LeaguesNav />
      <PendingNote decision={PENDING.ruleSets} />
      <div className="actions">
        <CheckboxField label="Show every version" checked={allVersions} onChange={setAllVersions} />
        <Button variant="secondary" onClick={() => setEditing({ base: null })}>
          New rule set
        </Button>
      </div>
      {editing ? (
        <section className="panel" aria-labelledby="rule-set-editor-title">
          <h3 id="rule-set-editor-title">
            {editing.base ? `New version of ${editing.base.name}` : 'New rule set'}
          </h3>
          <RuleSetEditor
            key={editing.base?.id ?? 'new'}
            base={editing.base}
            onDone={() => setEditing(null)}
          />
        </section>
      ) : null}
      <QueryBoundary
        query={ruleSets}
        label="rule sets"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No rule sets',
          description:
            'Rule sets define each format’s rules. Use "New rule set" to enter the first one.',
        }}
        unavailableOffline={['creating rule sets']}
      >
        {(data) => (
          <ul className="list" aria-label="Rule sets">
            {data.map((ruleSet) => (
              <li key={ruleSet.id}>
                <div className="row-text">
                  <span className="row-title">
                    {ruleSet.name}, version {ruleSet.version}
                  </span>
                  <span className="caption">
                    {SPORT_FORMAT[ruleSet.format]} · created {formatInstant(ruleSet.createdAt)}
                  </span>
                  <RuleSetSummary ruleSet={ruleSet} />
                </div>
                <Button
                  variant="secondary"
                  aria-label={`New version of ${ruleSet.name}`}
                  onClick={() => setEditing({ base: ruleSet })}
                >
                  New version
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
