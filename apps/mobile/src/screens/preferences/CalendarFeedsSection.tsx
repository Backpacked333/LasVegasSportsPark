/**
 * SCR-C-36 private calendar feeds (SPK-COMMS-008 "stable event identities and revocable
 * authorization", SPK-IAM-006). `GET /v1/me/calendar-feeds` lists them without tokens; creating one
 * (`POST /v1/me/calendar-feeds`) returns its link once, offered through native sharing; revoking
 * (`POST /v1/me/calendar-feeds/{id}/revoke` with the expected revision) stops future fetches.
 * Wording from journeys.md section 3: "Calendar feed active"; after revocation "Feed link revoked.
 * Events already copied to your calendar are not removed."
 *
 * People in a feed: the person's own activities, plus anyone the API says they may view (the API
 * re-checks `view` on every fetch).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import {
  formatDateTime,
  personNameText,
  usePersonName,
  useMe,
} from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { CheckboxRow, Paragraph, SectionHeader, TextField } from '../account/components/forms';

type CalendarFeed = Schema<'CalendarFeed'>;
type CalendarFeedCreated = Schema<'CalendarFeedCreated'>;

const FEEDS_KEY = ['api', '/me/calendar-feeds'] as const;
export const FEED_REVOKED_TEXT =
  'Feed link revoked. Events already copied to your calendar are not removed.';

/** The API's origin plus the feed path (`/v1/calendar-feeds/<token>.ics`). */
export function feedUrl(apiBaseUrl: string, path: string): string {
  const origin = /^(https?:\/\/[^/]+)/i.exec(apiBaseUrl)?.[1] ?? '';
  return `${origin}${path}`;
}

function feedScopeText(feed: CalendarFeed): string {
  const others = feed.scope.subjectPersonIds.length;
  if (others === 0) return 'Your activities';
  return `Your activities and ${others} other ${others === 1 ? 'person' : 'people'}`;
}

export function CalendarFeedsSection() {
  const feeds = useApiQuery({ path: '/me/calendar-feeds' });
  return (
    <View>
      <SectionHeader
        title="Calendar feed"
        detail="A private link your calendar app can subscribe to. You can revoke it at any time."
      />
      <QueryBoundary
        query={feeds}
        label="calendar feeds"
        empty={{ title: 'No calendar feeds', description: '' }}
        unavailableOffline={['creating or revoking a calendar feed']}
      >
        {(data) => (
          <View>
            {data.feeds.length === 0 ? (
              <Paragraph muted>No calendar feeds yet.</Paragraph>
            ) : (
              <View accessibilityRole="list">
                {data.feeds.map((feed) => (
                  <FeedRow key={feed.id} feed={feed} />
                ))}
              </View>
            )}
            <CreateFeed />
          </View>
        )}
      </QueryBoundary>
    </View>
  );
}

function FeedRow({ feed }: { feed: CalendarFeed }) {
  const queryClient = useQueryClient();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [confirming, setConfirming] = useState(false);
  const revoke = useApiCommand('post', '/me/calendar-feeds/{id}/revoke', {
    invalidate: [FEEDS_KEY],
  });
  const revoked = feed.revokedAt !== null || revoke.data !== undefined;
  const used = feed.lastAccessedAt
    ? `Last used ${formatDateTime(feed.lastAccessedAt)}`
    : 'Not used yet';
  const submit = async () => {
    try {
      await revoke.submit({ path: { id: feed.id }, body: { expectedRevision: feed.revision } });
      setConfirming(false);
    } catch {
      // revoke.error is rendered below.
    }
  };
  return (
    <View>
      <ListRow
        title={feed.label ?? 'Calendar feed'}
        detail={`${feedScopeText(feed)}. ${used}.`}
        status={
          revoked
            ? { tone: 'neutral', label: 'Feed link revoked' }
            : { tone: 'success', label: 'Calendar feed active' }
        }
      />
      {revoked ? (
        revoke.data ? (
          <Paragraph>{FEED_REVOKED_TEXT}</Paragraph>
        ) : null
      ) : (
        <View style={styles.actions}>
          {confirming ? (
            <>
              <Paragraph inset={false}>
                Revoking stops your calendar app from getting new updates. Events already copied are
                not removed.
              </Paragraph>
              <Button
                label="Revoke now"
                onPress={() => void submit()}
                busy={revoke.isProcessing}
                disabled={offline}
              />
              <Button label="Keep feed" variant="secondary" onPress={() => setConfirming(false)} />
            </>
          ) : (
            <Button
              label={`Revoke ${feed.label ?? 'calendar feed'}`}
              variant="secondary"
              onPress={() => setConfirming(true)}
              disabled={offline}
            />
          )}
          {revoke.error ? (
            <CommandError
              error={revoke.error}
              onRetry={() => void submit()}
              onReload={() => {
                // A feed revoked or changed on another device: show its current state.
                revoke.reset();
                void queryClient.invalidateQueries({ queryKey: FEEDS_KEY });
              }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

function PersonCheckbox({
  personId,
  checked,
  disabled,
  onChange,
}: {
  personId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const name = usePersonName(personId);
  return (
    <CheckboxRow
      label={personNameText(name)}
      checked={checked}
      disabled={disabled || name.status !== 'ready'}
      onChange={onChange}
    />
  );
}

function CreateFeed() {
  const { services } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const me = useMe();
  const [label, setLabel] = useState('');
  const [people, setPeople] = useState<readonly string[]>([]);
  const create = useApiCommand('post', '/me/calendar-feeds', { invalidate: [FEEDS_KEY] });
  const viewable = (me.data?.authorities ?? []).filter((a) => a.permissions.includes('view'));
  const labelError = label.trim().length > 100 ? 'Use 100 characters or fewer.' : null;

  const submit = async () => {
    if (labelError) return;
    try {
      await create.submit({
        body: {
          ...(label.trim() ? { label: label.trim() } : {}),
          subjectPersonIds: [...people],
        },
      });
    } catch {
      // create.error is rendered below; the label and choices are kept.
    }
  };

  if (create.data) {
    return (
      <FeedCreated
        feed={create.data}
        url={feedUrl(services.config.apiBaseUrl, create.data.path)}
        onDone={() => {
          create.reset();
          setLabel('');
          setPeople([]);
        }}
      />
    );
  }
  return (
    <View style={styles.form}>
      <TextField
        label="Feed name (optional)"
        value={label}
        onChangeText={setLabel}
        error={labelError}
        editable={!create.isProcessing}
        testID="feed-label"
      />
      {viewable.length > 0 ? (
        <View style={styles.people} accessibilityRole="list" accessibilityLabel="Also include">
          <Paragraph inset={false}>Also include</Paragraph>
          {viewable.map((a) => (
            <PersonCheckbox
              key={a.subjectPersonId}
              personId={a.subjectPersonId}
              checked={people.includes(a.subjectPersonId)}
              disabled={create.isProcessing}
              onChange={(on) =>
                setPeople((current) =>
                  on
                    ? [...current, a.subjectPersonId]
                    : current.filter((id) => id !== a.subjectPersonId),
                )
              }
            />
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Create calendar feed"
          variant="secondary"
          onPress={() => void submit()}
          busy={create.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
      </View>
      {create.error ? <CommandError error={create.error} onRetry={() => void submit()} /> : null}
    </View>
  );
}

function FeedCreated({
  feed,
  url,
  onDone,
}: {
  feed: CalendarFeedCreated;
  url: string;
  onDone: () => void;
}) {
  return (
    <View style={styles.form} testID="feed-created">
      <View style={styles.actions}>
        <StatusBadge tone="success" label="Calendar feed active" />
      </View>
      <Paragraph>
        {feed.label ?? 'Your calendar feed'} is ready. Add the link to your calendar app. The link
        is shown only now; anyone who has it can see these events until you revoke it.
      </Paragraph>
      <View style={styles.actions}>
        <Button label="Share calendar link" onPress={() => void Share.share({ message: url })} />
        <Button label="Done" variant="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md, paddingTop: spacing.md },
  people: { gap: spacing.xs, paddingHorizontal: spacing.lg },
  actions: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingTop: spacing.sm },
});
