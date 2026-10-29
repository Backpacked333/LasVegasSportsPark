/**
 * SCR-C-38 Support request and case history (SPK-SUPPORT-001, SPK-SUPPORT-002, SPK-SUPPORT-003,
 * SPK-CAP-001; SUP-01).
 *
 * - "Contact the operating team": `POST /v1/me/support-requests` opens a request about the
 *   signed-in person, someone they hold `view` over (from `GET /v1/me`), or a team they captain
 *   (from `GET /v1/me/team-entries`), with a category, a title, a description and, optionally, the
 *   registrations or the record a link pointed at (`relatedRecords`). The API decides: a person or
 *   record of another household is NOT_FOUND and is shown as "not available" with no hint that it
 *   exists (§4.10); a team the person does not captain is ACCESS_DENIED. One idempotency key per
 *   request intent: "Try again" after no answer resends the same request (§4.9); the draft is kept
 *   on every failure and offline (sending needs a connection, nothing is queued, §4.15).
 * - "Your requests": `GET /v1/me/cases` (cursor pages, newest first) lists the person's own
 *   requests with their status in words; each opens `/support/<id>` (`GET /v1/me/cases/{id}`).
 *   The API never shows a customer notes, owner, queue or internal history (§4.14), and neither
 *   does the screen.
 * - How to reach the facility: the support contact from configuration
 *   (`SPORTSPARK_SUPPORT_PHONE`, `SPORTSPARK_SUPPORT_EMAIL`, `SPORTSPARK_SUPPORT_HOURS`). Contact
 *   details and coverage are facility facts (DEC-015, Technical lead/operator); unset, the screen
 *   shows that pending decision and never invents a number or hours. Service levels for requests
 *   are DEC-015 too: no response time is promised.
 * - SPK-SUPPORT-003: a request never replaces the actual change. Cancellation and transfer
 *   (Enrollments) and payments are commands of their own; a note in a case is not a refund,
 *   permission change or transfer.
 *
 * States: loading; empty (no requests yet); validation failure (category, title or description
 * missing, next to the field); permission restriction (not available); stale (the list re-reads
 * on return to the app and shows its age); offline (draft kept, sending disabled); processing;
 * success (request sent, with its status); signed out (sign in).
 */
import type { ApiError } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import type { SupportContact } from '../../config/app-config';
import { moneyRoutes } from '../../features/money/routes';
import {
  Body,
  ButtonRow,
  Caption,
  ChoiceRow,
  Field,
  Section,
  TextField,
} from '../../features/money/ui';
import {
  nameOf,
  useMe,
  useMyTeams,
  usePersonNames,
  useSignedIn,
  viewablePersonIds,
} from '../../features/today/queries';
import { enrollmentStatus } from '../../features/today/status';
import { displayZone, formatWhen } from '../../features/today/time';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  caseStatus,
  draftErrors,
  EMPTY_DRAFT,
  RELATED_TYPE_LABELS,
  relatedFromParams,
  requestBody,
  type CustomerCase,
  type DraftErrors,
  type RelatedType,
  type SupportDraft,
} from './support-model';

const CASES_KEY = ['api', '/me/cases'] as const;
const CASES_PAGE = 20;
/** Registrations offered as "what it is about": one page, newest first (a display limit). */
const ENROLLMENT_CHOICES = 20;

export const supportRoutes = {
  support: () => '/support' as const,
  request: (caseId: string) => `/support/${caseId}` as const,
};

function ContactDetails({ contact }: { contact: SupportContact }) {
  return (
    <>
      {contact.phone ? <Field label="Phone" value={contact.phone} /> : null}
      {contact.email ? <Field label="Email" value={contact.email} /> : null}
      {contact.hours ? <Field label="Hours" value={contact.hours} /> : null}
      <ButtonRow>
        {contact.phone ? (
          <Button
            label="Call the facility"
            variant="secondary"
            accessibilityHint={`Calls ${contact.phone}`}
            onPress={() => void Linking.openURL(`tel:${contact.phone?.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
        {contact.email ? (
          <Button
            label="Email the facility"
            variant="secondary"
            accessibilityHint={`Writes to ${contact.email}`}
            onPress={() => void Linking.openURL(`mailto:${contact.email}`)}
          />
        ) : null}
      </ButtonRow>
    </>
  );
}

/** How a refused request is shown: the record or person as "not available", else the code. */
function RequestError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.isNotFound) {
    return (
      <StateView
        variant="unavailable"
        title="Not available"
        description="Something this request names is not available to you. Check who and what it is about, then send it again."
      />
    );
  }
  if (error.isPermissionRestriction) {
    return (
      <StateView
        variant="unavailable"
        title="Not available"
        description="You cannot open a request about this person or team. Choose another, or contact the facility."
      />
    );
  }
  return <StateView variant="error" error={error} onRetry={onRetry} />;
}

function SupportRequestForm({ linked }: { linked: { type: RelatedType; id: string } | null }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const me = useMe();
  const selfId = me.data?.principal.personId ?? null;
  const people = viewablePersonIds(me.data);
  const names = usePersonNames(people, me.data);
  const teams = useMyTeams();
  const [draft, setDraft] = useState<SupportDraft>(() => ({
    ...EMPTY_DRAFT,
    related: linked ? [linked] : [],
  }));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [sent, setSent] = useState<CustomerCase | null>(null);
  const send = useApiCommand('post', '/me/support-requests', { invalidate: [CASES_KEY] });
  const subject = draft.subjectPersonId ?? selfId;
  const registrations = useApiQuery({
    path: '/enrollments',
    request: { query: { participantPersonId: subject ?? '', limit: ENROLLMENT_CHOICES } },
    enabled: !!subject && draft.category === 'registration',
  });
  // Teams the person holds a captain role on, as the API lists them; the API checks again.
  const captainOf = (teams.data ?? []).filter((t) =>
    t.members.some(
      (m) =>
        m.personId === selfId && (m.roles.includes('captain') || m.roles.includes('co_captain')),
    ),
  );
  const update = (patch: Partial<SupportDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSent(null);
  };
  const enrollmentRelated = draft.related.find((r) => r.type === 'enrollment')?.id ?? null;
  const otherRelated = draft.related.filter((r) => r.type !== 'enrollment');

  const submit = () => {
    const found = draftErrors(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void send
      .submit({ body: requestBody(draft, selfId) })
      .then((created) => {
        setSent(created);
        setDraft({ ...EMPTY_DRAFT });
        setErrors({});
      })
      .catch(() => undefined); // shown from send.error; the draft stays
  };

  return (
    <Section title="Contact the operating team" testID="support-request">
      {sent ? (
        <View style={styles.gap} accessibilityLiveRegion="polite" testID="support-sent">
          <StatusBadge tone="success" label="Request sent" />
          <Body>
            “{sent.title}” is with the facility team. Its status shows under Your requests.
          </Body>
          <Button
            label="View this request"
            variant="secondary"
            onPress={() => router.push(supportRoutes.request(sent.id) as Href)}
          />
        </View>
      ) : null}

      <View accessibilityRole="radiogroup" accessibilityLabel="Who is this about">
        <Caption>Who is this about</Caption>
        {people.map((personId) => (
          <ChoiceRow
            key={personId}
            mode="radio"
            label={nameOf(names, personId)}
            checked={subject === personId && !draft.teamEntryId}
            onPress={() =>
              update({
                subjectPersonId: personId === selfId ? null : personId,
                teamEntryId: null,
                related: draft.related.filter((r) => r.type !== 'enrollment'),
              })
            }
          />
        ))}
        {captainOf.map((team) => (
          <ChoiceRow
            key={team.teamEntry.id}
            mode="radio"
            label={`Your team ${team.teamName}`}
            detail={team.seasonName}
            checked={draft.teamEntryId === team.teamEntry.id}
            onPress={() =>
              update({ teamEntryId: team.teamEntry.id, subjectPersonId: null, category: 'team' })
            }
          />
        ))}
      </View>

      <View accessibilityRole="radiogroup" accessibilityLabel="What is it about">
        <Caption>What is it about</Caption>
        {CATEGORIES.map((category) => (
          <ChoiceRow
            key={category}
            mode="radio"
            label={CATEGORY_LABELS[category]}
            checked={draft.category === category}
            onPress={() => update({ category })}
            testID={`support-category-${category}`}
          />
        ))}
        {errors.category ? (
          <Caption>
            {'▲ '}
            {errors.category}
          </Caption>
        ) : null}
      </View>

      {draft.category === 'registration' ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Which registration (optional)">
          <Caption>Which registration (optional)</Caption>
          {registrations.data === undefined ? (
            registrations.error ? (
              <Caption>Registrations could not be listed; describe it in your message.</Caption>
            ) : (
              <StateView variant="loading" label="registrations" />
            )
          ) : registrations.data.items.length === 0 ? (
            <Caption>No registrations to choose from.</Caption>
          ) : (
            registrations.data.items.map((e) => (
              <ChoiceRow
                key={e.id}
                mode="radio"
                label={e.offering?.name ?? 'Registration'}
                detail={enrollmentStatus(e).label}
                checked={enrollmentRelated === e.id}
                onPress={() =>
                  update({
                    related: [
                      ...otherRelated,
                      ...(enrollmentRelated === e.id
                        ? []
                        : [{ type: 'enrollment' as const, id: e.id }]),
                    ],
                  })
                }
              />
            ))
          )}
        </View>
      ) : null}

      {otherRelated.map((r) => (
        <View key={`${r.type}:${r.id}`} style={styles.gap} testID="support-about">
          <Body>About {RELATED_TYPE_LABELS[r.type]} (from the link you followed).</Body>
          <Button
            label="Do not link it"
            variant="secondary"
            onPress={() => update({ related: draft.related.filter((x) => x !== r) })}
          />
        </View>
      ))}

      <TextField
        label="Title"
        value={draft.title}
        onChangeText={(title) => update({ title })}
        error={errors.title}
        testID="support-title"
      />
      <TextField
        label="What do you need?"
        value={draft.description}
        onChangeText={(description) => update({ description })}
        error={errors.description}
        hint="Include the reference shown with any error message in the app."
        multiline
        testID="support-description"
      />
      <Button
        label="Send request"
        busy={send.isProcessing}
        disabled={offline}
        onPress={submit}
        testID="support-send"
      />
      {offline ? (
        <Caption>Sending needs a connection. Your draft stays on this screen.</Caption>
      ) : null}
      {send.error ? <RequestError error={send.error} onRetry={submit} /> : null}
      <Caption>
        The facility team answers requests; how quickly is not set yet (DEC-015). Notes and internal
        details stay with the team.
      </Caption>
    </Section>
  );
}

function CaseHistory() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const zone = displayZone(null);
  const cases = useApiPages({
    path: '/me/cases',
    request: { query: { limit: CASES_PAGE } },
    enabled: signedIn,
  });
  return (
    <Section title="Your requests" testID="support-history">
      <QueryBoundary
        query={cases}
        label="your requests"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No requests yet',
          description: 'Requests you send to the facility team appear here with their status.',
        }}
        unavailableOffline={['sending a request']}
      >
        {(items) => (
          <View accessibilityRole="list">
            {items.map((c) => (
              <ListRow
                key={c.id}
                title={c.title}
                detail={`${CATEGORY_LABELS[c.category]}. Sent ${formatWhen(c.createdAt, zone.zone)}`}
                status={caseStatus(c.status)}
                onPress={() => router.push(supportRoutes.request(c.id) as Href)}
                accessibilityHint="Opens the request"
                testID={`support-case-${c.id}`}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={cases} label="requests" />
    </Section>
  );
}

function Support({ linked }: { linked: { type: RelatedType; id: string } | null }) {
  const router = useRouter();
  const { services } = useApp();
  const contact = services.config.supportContact ?? null;
  return (
    <View>
      <SupportRequestForm linked={linked} />
      <CaseHistory />
      <Section title="Contact the facility" testID="support-contact">
        {contact ? (
          <ContactDetails contact={contact} />
        ) : (
          <>
            <Body>Ask at the front desk.</Body>
            <StateView
              variant="pending-decision"
              subject="The facility’s support phone, email and hours"
              decisions={['DEC-015']}
              owner="Technical lead/operator"
            />
          </>
        )}
      </Section>
      <Section title="Changes are made, not noted">
        <Body>
          A conversation with support never replaces the change itself. Cancel or transfer a
          registration from Enrollments, where you see the refund, credit or charge first; refunds
          and permission changes are made by the facility as their own actions.
        </Body>
        <ButtonRow>
          <Button
            label="Open enrollments"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.enrollments())}
          />
          <Button
            label="Open payments"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.payments())}
          />
        </ButtonRow>
      </Section>
    </View>
  );
}

export function SupportScreen({
  linked = null,
}: { linked?: { type: RelatedType; id: string } | null } = {}) {
  return (
    <Screen>
      <RequireSession what="support">
        <Support linked={linked} />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/support/index.tsx (`?aboutType=<type>&aboutId=<uuid>` optional). */
export function SupportRoute() {
  const params = useLocalSearchParams<{ aboutType?: string; aboutId?: string }>();
  // Read once into the draft; a malformed parameter links nothing.
  const linked = relatedFromParams(params);
  return (
    <>
      <Stack.Screen options={{ title: 'Support' }} />
      <SupportScreen linked={linked} />
    </>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.sm },
});
