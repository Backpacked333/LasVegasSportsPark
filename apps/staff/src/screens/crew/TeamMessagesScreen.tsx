/**
 * Coach · Team messages (staff redesign Phase 8 item 4). PENDING DECISION 8 (a messaging API: team
 * threads, private replies, SMS fallback): the API has no team threads, so the screen is built as
 * designed in its proposed state and holds no messages, real or invented.
 *
 * - One thread per team the coach coaches (`GET /v1/me/team-entries`, real teams).
 * - Inside a thread: where messages, their read counts ("Read by 7 of 9") and the parents' private
 *   replies ("to you only") will appear; the composer with an event card and a poll; "Text them",
 *   the SMS fallback for families who have not opened the app. Every send control is disabled and
 *   says why (the purple "Proposed" tag, §6.7). Phone numbers are never shown, either way.
 * - The parent app's "Message the coach" (mobile M 4d) is the other end of the same thread.
 */
import { useId, useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { captainedEntries, type MyTeamEntry } from './coach-model';
import { CrewHero, ProposedTag } from './crew-ui';
import './crew.css';

/** Open decision 8: until a messaging API exists, nothing here sends. */
export const TEAM_MESSAGING_AVAILABLE = false;

function Thread({ team, onBack }: { team: MyTeamEntry; onBack: () => void }) {
  const reasonId = useId();
  const inputId = useId();
  const [draft, setDraft] = useState('');
  return (
    <div className="crew-body">
      <section className="crew-card" aria-labelledby={`${inputId}-title`}>
        <div className="crew-card-head">
          <Button variant="secondary" className="button-sm" onClick={onBack}>
            <Icon name="arrow_back" size={18} /> Teams
          </Button>
          <ProposedTag id={reasonId} label="Proposed · decision 8" />
        </div>
        <h3 id={`${inputId}-title`}>{team.teamName}</h3>
        <p className="crew-meta">
          One thread for the families of the team. Messages show how many have read them; a
          parent&apos;s reply to you is marked &ldquo;to you only&rdquo; and the rest of the team
          does not see it. Phone numbers stay hidden both ways.
        </p>
        <div className="msg-sample" aria-label="How a message will look">
          <span>
            <strong>Your message</strong> · an event card or a poll can go with it
          </span>
          <span className="crew-meta">Read by … of the families</span>
          <span>
            <strong>Private reply</strong> · to you only
          </span>
        </div>
        <p className="crew-empty">No messages yet: team messaging is not set up.</p>
      </section>

      <section className="crew-card composer" aria-label="Write to the team">
        <label className="crew-meta" htmlFor={inputId}>
          Message to {team.teamName}
        </label>
        <textarea
          id={inputId}
          className="crew-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${team.teamName} families`}
          disabled={!TEAM_MESSAGING_AVAILABLE}
          aria-describedby={reasonId}
        />
        <div className="composer-tools">
          <Button variant="secondary" disabled aria-describedby={reasonId}>
            <Icon name="event" size={18} /> Event
          </Button>
          <Button variant="secondary" disabled aria-describedby={reasonId}>
            <Icon name="bar_chart" size={18} /> Poll
          </Button>
          <Button variant="secondary" disabled aria-describedby={reasonId}>
            <Icon name="sms" size={18} /> Text them
          </Button>
          <Button disabled aria-describedby={reasonId}>
            <Icon name="send" size={18} /> Send
          </Button>
        </div>
        <p className="crew-note">
          <ProposedTag label="Pending decision 8" /> Sending waits for a messaging service. Until
          then, messages to families go through the office (Communications).
        </p>
      </section>
    </div>
  );
}

export function TeamMessagesScreen() {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const entries = useApiQuery({ path: '/me/team-entries' });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="team-messages-title" className="crew ops-screen">
      <CrewHero
        titleId="team-messages-title"
        kicker="Coach"
        title="Messages"
        aside={<ProposedTag />}
      />
      <QueryBoundary
        query={entries}
        label="your teams"
        loading={
          <SkeletonGroup label="your teams" className="crew">
            <Skeleton height={180} radius={20} />
          </SkeletonGroup>
        }
        isEmpty={(data) => captainedEntries(data, me.data?.principal.personId ?? null).length === 0}
        empty={{
          title: 'No team threads',
          description: 'Each team you coach gets one thread with its families.',
        }}
      >
        {(data) => {
          const teams = captainedEntries(data, me.data?.principal.personId ?? null);
          const current = teams.find((t) => t.teamEntry.id === open);
          if (current) return <Thread team={current} onBack={() => setOpen(null)} />;
          return (
            <section className="crew-card" aria-label="Team threads">
              {teams.map((team) => (
                <button
                  key={team.teamEntry.id}
                  type="button"
                  className="thread-row"
                  onClick={() => setOpen(team.teamEntry.id)}
                >
                  <Avatar name={team.teamName} personKey={team.teamEntry.id} size={44} decorative />
                  <span className="crew-row-text">
                    <span className="crew-row-title">{team.teamName}</span>
                    <span className="crew-meta">No messages yet</span>
                  </span>
                  <Icon name="chevron_right" size={20} />
                </button>
              ))}
            </section>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
