/**
 * Staff S 5c "Coach · skills assessment" (phone 390, the Assess tab; SPK-YOUTH-005 development
 * records on approved templates, SPK-YOUTH-006 progression, capability youth_progression,
 * DEC-016; templates and family visibility DEC-054, recommendation inputs DEC-055).
 *
 * - One child at a time, from the coach's class (the session on now, or the last one coached):
 *   each skill of the program's approved template with its plain-word levels ("Starting",
 *   "Getting it", "Got it": the template's ordinal scale), a short note for the family, and a
 *   suggested next class (an upcoming offering of the same program; the class this coach already
 *   suggested to others comes first).
 * - "Save, next: Mia D. →" saves drafts (`POST /v1/assessments`, or `PATCH` an existing draft with
 *   its revision; the suggestion is a draft recommendation, `POST /v1/progression-recommendations`)
 *   and moves straight on; a failed save says so with "Go back". Swipe or the arrows skip without
 *   saving.
 * - Nothing is sent until "Send all to families": each draft is submitted
 *   (`POST /v1/assessments/{id}/submit`) and each suggestion shared
 *   (`POST /v1/progression-recommendations/{id}/share`). A program manager approves the
 *   assessments before families see them (SPK-YOUTH-005), which the page says.
 * - Offline: saving and sending are disabled with "Needs a connection" (drafts are not queued).
 * - The detailed records (corrections, review, templates) stay at "All assessments".
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { useIntentSend } from '../../../api/useIntentSend';
import { activityFromAssignment, type ActivityRef } from '../../../features/operations/activity';
import { useApi, useApp, useNow } from '../../../providers/AppProviders';
import { Avatar } from '../../../ui/Avatar';
import { Icon } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { StateView } from '../../../ui/StateView';
import { useToast } from '../../../ui/Toast';
import type { WorkspaceAssignment } from '../MyAssignment';
import { activityZone } from '../WorkspaceScreen';
import { currentSession, sessionTitle, tileName } from './tile-model';
import { useSessionRoster, type RosterChild } from './useSessionRoster';
import './coach.css';

type Assessment = Schema<'Assessment'>;
type Template = Schema<'AssessmentTemplate'>;
type Recommendation = Schema<'ProgressionRecommendation'>;
type SessionRef = Extract<ActivityRef, { type: 'session' }>;

/** Statuses that count as "assessed" for a skill (a withdrawn one does not). */
const LIVE = new Set<Assessment['status']>([
  'draft',
  'submitted',
  'returned',
  'published',
  'recorded',
]);
/** Drafts the coach can still change; returned ones too. */
const EDITABLE = new Set<Assessment['status']>(['draft', 'returned']);

/** The coach's class to assess: the session on now, else the last coached session that started. */
export function assessTarget(
  items: readonly WorkspaceAssignment[],
  now: Date,
): WorkspaceAssignment | null {
  return (
    currentSession(items, now) ??
    [...items]
      .filter(
        (i) =>
          i.assignment.kind === 'coach' &&
          i.assignment.targetType === 'session' &&
          !!i.assignment.offeringId &&
          (i.assignment.status === 'accepted' || i.assignment.status === 'completed') &&
          new Date(i.activity.scheduledStart).getTime() <= now.getTime(),
      )
      .sort((a, b) => b.activity.scheduledStart.localeCompare(a.activity.scheduledStart))[0] ??
    null
  );
}

/** A child is done when every skill of the template has a live assessment for this class. */
export function isDone(template: Template, records: readonly Assessment[]): boolean {
  return template.skillAreas.every((s) =>
    records.some(
      (r) => r.templateId === template.id && r.skillAreaKey === s.key && LIVE.has(r.status),
    ),
  );
}

/** The facility's local date for an instant ("2026-11-21"). */
function localDay(at: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

export function SkillsAssessmentScreen() {
  const assignments = useApiQuery({ path: '/me/assignments' });
  const now = useNow(60 * 60_000);
  const item = useMemo(
    () => (assignments.data ? assessTarget(assignments.data.items, now) : null),
    [assignments.data, now],
  );
  const activity = item ? activityFromAssignment(item.assignment) : null;
  if (assignments.error) {
    return (
      <StateView
        variant="error"
        error={assignments.error}
        onRetry={() => void assignments.refetch()}
      />
    );
  }
  if (!assignments.data) {
    return (
      <div className="coach-flow">
        <Skeleton height={140} radius={24} />
      </div>
    );
  }
  if (!item || !activity || activity.type !== 'session') {
    return (
      <section className="coach-flow" aria-labelledby="assess-title">
        <header className="coach-hero">
          <h2 id="assess-title" className="coach-title">
            Assess
          </h2>
        </header>
        <div className="coach-flow-body">
          <StateView
            variant="empty"
            title="No class to assess"
            description="Children of a class you coach appear here once it has started."
          />
          <Link className="coach-note" to="/workspace/assessments/records">
            All assessments
          </Link>
        </div>
      </section>
    );
  }
  return <AssessClass item={item} activity={activity} />;
}

function AssessClass({ item, activity }: { item: WorkspaceAssignment; activity: SessionRef }) {
  const roster = useSessionRoster(activity);
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: activity.offeringId } },
    staleTime: 10 * 60_000,
  });
  const programId = offering.data?.programId ?? null;
  const templates = useApiQuery({
    path: '/programs/{id}/assessment-templates',
    request: { path: { id: programId ?? '' }, query: { status: 'approved' } },
    enabled: !!programId,
  });
  const template = useMemo(
    () =>
      [...(templates.data ?? [])].sort((a, b) =>
        (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''),
      )[0] ?? null,
    [templates.data],
  );
  const title = roster.offeringName ?? sessionTitle(item.activity.title);
  if (templates.error || offering.error) {
    const error = (templates.error ?? offering.error)!;
    return <StateView variant="error" error={error} onRetry={() => void templates.refetch()} />;
  }
  if (!roster.attendance.data || !templates.data || !offering.data) {
    return (
      <div className="coach-flow">
        <Skeleton height={140} radius={24} />
      </div>
    );
  }
  if (!template) {
    return (
      <section className="coach-flow" aria-labelledby="assess-title">
        <header className="coach-hero">
          <span className="coach-meta">{title}</span>
          <h2 id="assess-title" className="coach-title">
            Assess
          </h2>
        </header>
        <div className="coach-flow-body">
          <StateView
            variant="unavailable"
            title="No approved assessment template"
            description="A program manager approves the program's template first; then each child's skills are assessed here."
          />
        </div>
      </section>
    );
  }
  return (
    <AssessChildren
      item={item}
      activity={activity}
      title={title}
      template={template}
      programId={programId as string}
      children={roster.children}
    />
  );
}

interface Draft {
  levels: Record<string, number>;
  note: string;
  suggest: boolean;
}

function AssessChildren({
  item,
  activity,
  title,
  template,
  programId,
  children,
}: {
  item: WorkspaceAssignment;
  activity: SessionRef;
  title: string;
  template: Template;
  programId: string;
  children: readonly RosterChild[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { online, services } = useApp();
  const toast = useToast();
  const zone = activityZone(item);
  const { send } = useIntentSend([]);
  const records = useQueries({
    queries: children.map((c) => ({
      queryKey: [
        'api',
        '/participants/{personId}/assessments',
        { path: { personId: c.personId }, query: { offeringId: activity.offeringId, limit: 100 } },
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/participants/{personId}/assessments', {
            path: { personId: c.personId },
            query: { offeringId: activity.offeringId, limit: 100 },
            signal,
          })
        ).data,
    })),
  });
  const recs = useQueries({
    queries: children.map((c) => ({
      queryKey: [
        'api',
        '/participants/{personId}/progression-recommendations',
        { path: { personId: c.personId }, query: { offeringId: activity.offeringId, limit: 20 } },
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/participants/{personId}/progression-recommendations', {
            path: { personId: c.personId },
            query: { offeringId: activity.offeringId, limit: 20 },
            signal,
          })
        ).data,
    })),
  });
  const upcoming = useApiQuery({
    path: '/offerings',
    request: { query: { programId, limit: 50 } },
    staleTime: 10 * 60_000,
  });
  const recordsOf = (i: number): Assessment[] =>
    ((records[i]?.data as { items?: Assessment[] } | undefined)?.items ?? []).filter(
      (r) => r.templateId === template.id,
    );
  const recsOf = (i: number): Recommendation[] =>
    ((recs[i]?.data as { items?: Recommendation[] } | undefined)?.items ?? []).filter(
      (r) => r.status !== 'withdrawn',
    );
  const loaded = records.every((q) => q.isSuccess) && recs.every((q) => q.isSuccess);

  // The class to suggest: the one this coach already suggested most for this class, else the
  // first upcoming offering of the program.
  const today = localDay(services.now(), zone);
  const candidates = (upcoming.data?.items ?? [])
    .filter((o) => o.id !== activity.offeringId && o.startsOn > today)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const tally = new Map<string, number>();
  children.forEach((_, i) => {
    for (const r of recsOf(i)) {
      if (r.recommendedOfferingId) {
        tally.set(r.recommendedOfferingId, (tally.get(r.recommendedOfferingId) ?? 0) + 1);
      }
    }
  });
  const favourite = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const suggestion = candidates.find((o) => o.id === favourite) ?? candidates[0] ?? null;

  const doneFlags = children.map((_, i) => isDone(template, recordsOf(i)));
  const doneCount = doneFlags.filter(Boolean).length;
  const firstOpen = doneFlags.findIndex((d) => !d);
  const [index, setIndex] = useState<number | null>(null);
  const [summary, setSummary] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sending, setSending] = useState(false);
  const [sentCount, setSentCount] = useState<number | null>(null);
  const current = index ?? (firstOpen >= 0 ? firstOpen : 0);
  const child = children[current] ?? null;

  const draftOf = (i: number): Draft => {
    const c = children[i];
    if (!c) return { levels: {}, note: '', suggest: true };
    const own = drafts[c.personId];
    if (own) return own;
    const existing = recordsOf(i).filter((r) => LIVE.has(r.status));
    const levels: Record<string, number> = {};
    for (const r of existing) levels[r.skillAreaKey] = r.scaleValue;
    const note = existing.find((r) => r.comments)?.comments ?? '';
    return { levels, note, suggest: recsOf(i).length > 0 || existing.length === 0 };
  };
  const draft = draftOf(current);
  const setDraft = (next: Partial<Draft>) => {
    if (!child) return;
    setDrafts((d) => ({ ...d, [child.personId]: { ...draft, ...next } }));
  };
  const complete = template.skillAreas.every((s) => draft.levels[s.key] !== undefined);

  const move = (to: number) => {
    if (to < 0 || to >= children.length) return;
    setIndex(to);
  };
  const nextIndex = (() => {
    for (let k = 1; k <= children.length; k += 1) {
      const j = (current + k) % children.length;
      if (!doneFlags[j] && j !== current) return j;
    }
    return null;
  })();

  const save = async (i: number, d: Draft) => {
    const c = children[i];
    if (!c) return;
    const existing = recordsOf(i);
    const observedOn = localDay(services.now(), zone);
    const tasks: Promise<unknown>[] = [];
    template.skillAreas.forEach((skill, k) => {
      const value = d.levels[skill.key];
      if (value === undefined) return;
      const comments = k === 0 && d.note.trim() ? d.note.trim() : undefined;
      const editable = existing.find((r) => r.skillAreaKey === skill.key && EDITABLE.has(r.status));
      const live = existing.find((r) => r.skillAreaKey === skill.key && LIVE.has(r.status));
      if (editable) {
        if (
          editable.scaleValue === value &&
          (k !== 0 || (editable.comments ?? '') === (comments ?? ''))
        ) {
          return;
        }
        tasks.push(
          send(`assess|${editable.id}|${value}|${comments ?? ''}`, 'patch', '/assessments/{id}', {
            path: { id: editable.id },
            body: {
              scaleValue: value,
              ...(k === 0 ? { comments: comments ?? null } : {}),
              expectedRevision: editable.revision,
            },
          }),
        );
      } else if (!live) {
        tasks.push(
          send(`assess|${c.personId}|${skill.key}`, 'post', '/assessments', {
            body: {
              templateId: template.id,
              participantPersonId: c.personId,
              offeringId: activity.offeringId,
              skillAreaKey: skill.key,
              observedOn,
              scaleValue: value,
              ...(comments ? { comments } : {}),
              visibility: 'family',
            },
          }),
        );
      }
    });
    const existingRec = recsOf(i).find((r) => r.status === 'draft');
    if (d.suggest && suggestion && recsOf(i).length === 0) {
      tasks.push(
        send(`suggest|${c.personId}|${suggestion.id}`, 'post', '/progression-recommendations', {
          body: {
            participantPersonId: c.personId,
            fromOfferingId: activity.offeringId,
            recommendedOfferingId: suggestion.id,
            suitability: d.note.trim() || `Ready for ${suggestion.name}.`,
          },
        }),
      );
    } else if (!d.suggest && existingRec) {
      tasks.push(
        send(`unsuggest|${existingRec.id}`, 'post', '/progression-recommendations/{id}/withdraw', {
          path: { id: existingRec.id },
          body: { reason: 'The coach turned the suggestion off.' },
        }),
      );
    }
    try {
      await Promise.all(tasks);
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.show({
        tone: 'error',
        message: `${tileName(c.name)}'s assessment didn't save.${code ? ` Code ${code}` : ''}`,
        action: { label: 'Go back', onClick: () => setIndex(i) },
      });
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['api', '/participants/{personId}/assessments'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['api', '/participants/{personId}/progression-recommendations'],
        }),
      ]);
      setDrafts((all) => {
        const next = { ...all };
        delete next[c.personId];
        return next;
      });
    }
  };

  const saveAndNext = () => {
    if (!child || !complete) return;
    const at = current;
    const d = draft;
    // Optimistic: move on at once; a failure says so with "Go back".
    void save(at, d);
    if (nextIndex === null) setSummary(true);
    else setIndex(nextIndex);
  };

  const sendAll = async () => {
    setSending(true);
    let sent = 0;
    const failures: string[] = [];
    for (let i = 0; i < children.length; i += 1) {
      const c = children[i]!;
      for (const r of recordsOf(i).filter((x) => x.status === 'draft')) {
        try {
          await send(`submit|${r.id}`, 'post', '/assessments/{id}/submit', {
            path: { id: r.id },
            body: { expectedRevision: r.revision },
          });
        } catch {
          failures.push(tileName(c.name));
        }
      }
      for (const r of recsOf(i).filter((x) => x.status === 'draft')) {
        try {
          await send(`share|${r.id}`, 'post', '/progression-recommendations/{id}/share', {
            path: { id: r.id },
            body: { expectedRevision: r.revision },
          });
        } catch {
          failures.push(tileName(c.name));
        }
      }
      if (recordsOf(i).some((x) => x.status === 'draft')) sent += 1;
    }
    await queryClient.invalidateQueries({
      queryKey: ['api', '/participants/{personId}/assessments'],
    });
    setSending(false);
    setSentCount(sent);
    if (failures.length > 0) {
      toast.show({
        tone: 'error',
        message: `Not sent for ${[...new Set(failures)].join(', ')}. Try again.`,
      });
    }
  };

  const swipe = useRef<number | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    swipe.current = e.clientX;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (swipe.current === null) return;
    const dx = e.clientX - swipe.current;
    swipe.current = null;
    if (Math.abs(dx) < 60) return;
    move(dx < 0 ? current + 1 : current - 1);
  };

  const drafted = children.filter((_, i) => recordsOf(i).some((r) => r.status === 'draft')).length;
  const nextName = nextIndex !== null ? tileName(children[nextIndex]!.name) : null;
  const progress = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;

  return (
    <section className="coach-flow" aria-labelledby="assess-title">
      <header className="coach-hero">
        <span className="coach-meta">
          {title} · end of term · {doneCount} of {children.length} done
        </span>
        <h2 id="assess-title" className="coach-title">
          Assess
        </h2>
        <span
          className="coach-progress"
          role="progressbar"
          aria-label="Children assessed"
          aria-valuemin={0}
          aria-valuemax={children.length}
          aria-valuenow={doneCount}
        >
          <span style={{ width: `${progress}%` }} />
        </span>
      </header>
      <div className="coach-flow-body">
        {!loaded ? (
          <Skeleton height={260} radius={20} />
        ) : summary || children.length === 0 ? (
          <>
            <h3>{sentCount !== null ? 'Sent' : 'Ready to send'}</h3>
            <p className="coach-note">
              {sentCount !== null
                ? `${sentCount} report ${sentCount === 1 ? 'card' : 'cards'} sent. A program manager checks them, then each family sees theirs in the child's profile with the suggested class.`
                : `${drafted} of ${children.length} children have a saved assessment waiting. Nothing has been sent to families yet.`}
            </p>
            {sentCount === null ? (
              <div className="coach-actions">
                <button type="button" className="coach-secondary" onClick={() => setSummary(false)}>
                  Back
                </button>
                <button
                  type="button"
                  className="coach-primary"
                  disabled={!online || sending || drafted === 0}
                  aria-busy={sending || undefined}
                  onClick={() => void sendAll()}
                >
                  {sending ? 'Sending…' : !online ? 'Needs a connection' : 'Send all to families'}
                </button>
              </div>
            ) : null}
          </>
        ) : child ? (
          <>
            <div
              className="coach-assess-head"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
            >
              <button
                type="button"
                className="coach-round"
                aria-label="Previous child"
                disabled={current === 0}
                onClick={() => move(current - 1)}
              >
                <Icon name="chevron_left" size={22} />
              </button>
              <Avatar name={child.name} personKey={child.personId} size={64} decorative />
              <span className="coach-card-text">
                <b>{child.name}</b>
                <small>
                  {current + 1} of {children.length}
                  {doneFlags[current] ? ' · saved' : ''}
                </small>
              </span>
              <button
                type="button"
                className="coach-round"
                aria-label="Next child"
                disabled={current >= children.length - 1}
                onClick={() => move(current + 1)}
              >
                <Icon name="chevron_right" size={22} />
              </button>
            </div>
            <div className="coach-skills">
              {template.skillAreas.map((skill) => (
                <div key={skill.key} className="coach-skill">
                  <span className="coach-skill-label" id={`skill-${skill.key}`}>
                    {skill.label}
                  </span>
                  <div
                    className="coach-levels"
                    role="radiogroup"
                    aria-labelledby={`skill-${skill.key}`}
                  >
                    {template.scale.levels.map((level, k) => (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        className="coach-level"
                        aria-checked={draft.levels[skill.key] === k + 1}
                        onClick={() =>
                          setDraft({ levels: { ...draft.levels, [skill.key]: k + 1 } })
                        }
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <label className="coach-note-label">
              <h3>A note for the family</h3>
              <textarea
                className="coach-textarea"
                value={draft.note}
                maxLength={4000}
                onChange={(e) => setDraft({ note: e.target.value })}
              />
            </label>
            {suggestion ? (
              <div className="coach-suggest">
                <Icon name="arrow_upward" size={20} />
                <p id="suggest-label">
                  Suggest <b>{suggestion.name}</b> next term
                </p>
                <input
                  type="checkbox"
                  role="switch"
                  className="coach-switch"
                  aria-labelledby="suggest-label"
                  checked={draft.suggest}
                  onChange={(e) => setDraft({ suggest: e.target.checked })}
                />
              </div>
            ) : null}
            <div className="coach-actions">
              <button
                type="button"
                className="coach-primary"
                disabled={!complete || !online}
                onClick={saveAndNext}
              >
                {!online
                  ? 'Needs a connection'
                  : nextName
                    ? `Save, next: ${nextName}`
                    : 'Save and review'}
                {online ? <Icon name="arrow_forward" size={20} /> : null}
              </button>
            </div>
            <p className="coach-links">
              <button type="button" className="coach-showall" onClick={() => setSummary(true)}>
                Review and send
              </button>
              <Link to="/workspace/assessments/records">All assessments</Link>
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
