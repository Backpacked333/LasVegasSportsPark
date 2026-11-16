/**
 * Joining a rental's group roster (SPK-COND-005, proposed amendment PA-09; capability
 * `rental_rosters`, DEC-103 pending). Routes: `/booking-roster-invitations` (the invitations
 * that name this person, and a field for an invitation code) and
 * `/booking-roster-invitations/[id]` (one invitation that names this person).
 *
 * An invitation that names the signed-in person, or a child they register for, is read and
 * answered without a code: signing in proves who they are, and only the person named joins on it.
 * An invitation sent to an email address is opened with the code the renter passed on
 * (`<invitation>.<code>`); the code stays in this screen's memory only and is forgotten when the
 * screen closes. It is sent in the body of `POST /v1/booking-roster-invitations/{id}/open` and of
 * the answer: never in a route, an address or the read cache's key (§4.13, §4.14).
 *
 * The read (`GET /v1/booking-roster-invitations/{id}`, or `.../open` with a code) says what the
 * invitation is to (the rental, when, who invited) and nothing more. Accepting (`POST .../accept`)
 * joins the person it names, or, on a code invitation, the signed-in person or a child they
 * register for; declining (`POST .../decline`) closes it. Once
 * joined, the waiver the rental asks for (SPK-REG-011) is shown for the person who joined, to
 * accept there and then. Being on the roster is only a name on the renter's list.
 *
 * States: signed out (sign in first); loading; empty (no invitations); ready; validation failure
 * (a code that is not a code); not available (a wrong code or somebody else's invitation reads
 * the same as no invitation, §4.10); stale (already answered, revoked or expired: shown as it is
 * now); offline (cannot answer); processing; success (joined, or declined).
 */
import { apiQueryKey, type ApiError, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { TextField } from '../../features/money/ui';
import { routeId } from '../../features/package-g/routes';
import { CommandError } from '../../features/registration/CommandError';
import { useMe, useParticipantNames } from '../../features/registration/participants';
import { ChoiceRow } from '../../features/registration/ui';
import { displayZone, formatRange } from '../../features/today/time';
import { WaiverCard } from '../../features/waivers/WaiverCard';
import { formatCalendarDate } from '../../features/waivers/waivers';
import { useApi, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { makeStyles, spacing, type } from '../../ui/theme';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { Section } from '../../ui/Section';
import { FieldValue as Field } from '../../ui/Field';
import { Text as UiText } from '../../ui/Text';

type InvitationView = Schema<'BookingRosterInvitationView'>;

export const ROSTER_INVITATIONS_PATH = '/booking-roster-invitations';
const MY_INVITATIONS_KEY = ['api', '/me/booking-roster-invitations'] as const;
const OPEN_PATH = '/booking-roster-invitations/{id}/open';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<InvitationView['status'], { tone: StatusTone; label: string }> = {
  pending: { tone: 'pending', label: 'Waiting for your answer' },
  accepted: { tone: 'success', label: 'Accepted' },
  declined: { tone: 'neutral', label: 'Declined' },
  revoked: { tone: 'neutral', label: 'Withdrawn by the renter' },
  expired: { tone: 'neutral', label: 'Expired' },
};

/** An invitation code is `<invitation id>.<one-time code>`, as the renter's screen shows it. */
export function parseInvitationCode(code: string): { id: string; token: string } | null {
  const trimmed = code.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 0) return null;
  const id = trimmed.slice(0, dot);
  const token = trimmed.slice(dot + 1);
  return UUID.test(id) && token.length >= 16 ? { id, token } : null;
}

function when(invitation: InvitationView): string {
  const zone = displayZone(invitation.booking.timezone);
  const range = formatRange(invitation.booking.firstStart, invitation.booking.lastEnd, zone.zone);
  return invitation.booking.occurrenceCount > 1
    ? `${invitation.booking.occurrenceCount} times, from ${range}`
    : range;
}

/** The waiver the rental asks for, for the person who just joined (SPK-REG-011). */
function JoinerWaivers({
  personId,
  personName,
  policyKeys,
  selfId,
  canAccept,
}: {
  personId: string;
  personName: string;
  policyKeys: readonly string[];
  selfId: string | null;
  canAccept: boolean;
}) {
  const { reachable } = useConnectivity();
  const waivers = useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: personId } },
  });
  return (
    <Section
      title={personName === 'You' ? 'Your waiver' : `Waiver for ${personName}`}
      testID="roster-waiver"
    >
      <QueryBoundary
        query={waivers}
        label="the waiver"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['Accepting the waiver']}
      >
        {(data) => (
          <>
            {data.waivers
              .filter((w) => policyKeys.includes(w.policyKey))
              .map((waiver) => (
                <WaiverCard
                  key={waiver.policyKey}
                  personId={personId}
                  personName={personName}
                  waiver={waiver}
                  signerName={
                    waiver.acceptance?.signedByPersonId === selfId ? 'you' : 'another adult'
                  }
                  canAccept={canAccept}
                  offline={reachable === false}
                  onAccepted={() => void waivers.refetch()}
                />
              ))}
          </>
        )}
      </QueryBoundary>
    </Section>
  );
}

function InvitationBody({
  invitation,
  token,
  reload,
}: {
  invitation: InvitationView;
  token: string | undefined;
  reload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  // A code invitation may be answered for a child the person registers for; one that names a
  // person joins that person only (themselves, or a child they answer for).
  const named = invitation.recipientPersonId;
  const children =
    named === null
      ? (me.data?.authorities ?? [])
          .filter((a) => a.permissions.includes('register'))
          .map((a) => a.subjectPersonId)
      : [];
  const names = useParticipantNames(named === null ? children : [named]);
  const [joiner, setJoiner] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const invalidate = [
    MY_INVITATIONS_KEY,
    ['api', '/booking-roster-invitations/{id}'],
    ['api', OPEN_PATH],
  ] as const;
  const accept = useApiCommand('post', '/booking-roster-invitations/{id}/accept', {
    invalidate: [...invalidate],
  });
  const decline = useApiCommand('post', '/booking-roster-invitations/{id}/decline', {
    invalidate: [...invalidate],
  });
  const who = named ?? joiner ?? selfId;
  const forSomebodyElse = named !== null && selfId !== null && named !== selfId;
  const status = STATUS[invitation.status];
  const open = invitation.status === 'pending' && joined === null && !declined;

  const submitAccept = async () => {
    if (!who) return;
    setFailure(null);
    try {
      await accept.submit({
        path: { id: invitation.id },
        // The code answers a code invitation only; an invitation that names a person names
        // its joiner already.
        body: {
          ...(token ? { token } : {}),
          ...(named === null && who !== selfId ? { personId: who } : {}),
        },
      });
      setJoined(who);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  const submitDecline = async () => {
    setFailure(null);
    try {
      await decline.submit({ path: { id: invitation.id }, body: token ? { token } : {} });
      setDeclined(true);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  return (
    <View testID={`roster-invitation-${invitation.id}`}>
      <Section title="You are invited to a rental">
        <Field label="Rental" value={invitation.booking.offeringName} />
        <Field label="When" value={when(invitation)} />
        {forSomebodyElse ? <Field label="For" value={names(named)} /> : null}
        {invitation.invitedByName ? (
          <Field label="Invited by" value={invitation.invitedByName} />
        ) : null}
        {invitation.message ? <Field label="Message" value={invitation.message} /> : null}
        <StatusBadge
          tone={joined ? 'success' : declined ? 'neutral' : status.tone}
          label={
            joined
              ? `${joined === selfId ? 'You' : names(joined)} joined the roster`
              : declined
                ? 'Declined'
                : status.label
          }
          testID="roster-invitation-status"
        />
        {open ? (
          <UiText
            variant="caption"
            tone="muted"
          >{`Open until ${formatCalendarDate(invitation.expiresAt)}.`}</UiText>
        ) : null}
        <UiText variant="caption" tone="muted">
          Joining puts a name on the renter&apos;s list of who is coming. It is not a registration
          and costs nothing.
        </UiText>
      </Section>
      {open ? (
        <Section title="Your answer">
          {children.length > 0 ? (
            <View accessibilityRole="radiogroup" accessibilityLabel="Who is joining">
              <ChoiceRow
                mode="radio"
                label="I am joining"
                checked={who === selfId}
                onToggle={() => setJoiner(selfId)}
              />
              {children.map((childId) => (
                <ChoiceRow
                  key={childId}
                  mode="radio"
                  label={`${names(childId)} is joining`}
                  checked={who === childId}
                  onToggle={() => setJoiner(childId)}
                />
              ))}
            </View>
          ) : null}
          <View style={buttonRow}>
            <Button
              label="Join the roster"
              onPress={() => void submitAccept()}
              disabled={offline || !who}
              busy={accept.isProcessing}
              accessibilityHint={offline ? 'Needs a connection' : undefined}
            />
            <Button
              label="Decline"
              variant="secondary"
              onPress={() => void submitDecline()}
              disabled={offline}
              busy={decline.isProcessing}
            />
          </View>
          {offline ? (
            <UiText variant="caption" tone="muted">
              Answering needs a connection.
            </UiText>
          ) : null}
        </Section>
      ) : null}
      <CommandError error={failure} onReload={reload} />
      {joined && invitation.requiredWaiverKeys.length > 0 ? (
        <JoinerWaivers
          personId={joined}
          personName={joined === selfId ? 'You' : names(joined)}
          policyKeys={invitation.requiredWaiverKeys}
          selfId={selfId}
          canAccept={joined === selfId ? me.data?.person?.kind === 'adult' : true}
        />
      ) : null}
    </View>
  );
}

/**
 * The invitation a code opens. The code is sent in the request body and is no part of the cache
 * key, so it is in no address, log or stored cache entry (§4.14). The read is cached like any
 * other read, under the invitation it opens.
 */
function useInvitationByCode(invitationId: string, token: string) {
  const api = useApi();
  const query = useQuery<ApiResponse<InvitationView>, ApiError>({
    queryKey: apiQueryKey(OPEN_PATH, { path: { id: invitationId } }),
    queryFn: ({ signal }) =>
      api.request('post', OPEN_PATH, {
        path: { id: invitationId },
        body: { token },
        intent: api.newIntent(),
        signal,
      }),
  });
  return { ...query, data: query.data?.data, updatedAt: query.data?.receivedAt ?? null };
}

function InvitationByCode({ invitationId, token }: { invitationId: string; token: string }) {
  const invitation = useInvitationByCode(invitationId, token);
  return (
    <QueryBoundary
      query={invitation}
      label="the invitation"
      empty={{ title: 'Not available', description: '' }}
      unavailableOffline={['Joining the roster', 'Declining']}
    >
      {(data) => (
        <InvitationBody invitation={data} token={token} reload={() => void invitation.refetch()} />
      )}
    </QueryBoundary>
  );
}

function InvitationRead({ invitationId }: { invitationId: string }) {
  const invitation = useApiQuery({
    path: '/booking-roster-invitations/{id}',
    request: { path: { id: invitationId } },
  });
  return (
    <QueryBoundary
      query={invitation}
      label="the invitation"
      empty={{ title: 'Not available', description: '' }}
      unavailableOffline={['Joining the roster', 'Declining']}
    >
      {(data) => (
        <InvitationBody
          invitation={data}
          token={undefined}
          reload={() => void invitation.refetch()}
        />
      )}
    </QueryBoundary>
  );
}

/** Opening an invitation with the code the renter passed on; the code never leaves this screen. */
function EnterCode() {
  const [code, setCode] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [opened, setOpened] = useState<{ id: string; token: string } | null>(null);
  const parsed = parseInvitationCode(code);
  if (opened) {
    return (
      <>
        <InvitationByCode invitationId={opened.id} token={opened.token} />
        <View style={buttonRow}>
          <Button
            label="Enter another code"
            variant="secondary"
            onPress={() => {
              setOpened(null);
              setCode('');
              setAttempted(false);
            }}
          />
        </View>
      </>
    );
  }
  return (
    <Section title="Have an invitation code?" testID="roster-invitation-code">
      <TextField
        label="Invitation code"
        value={code}
        onChangeText={setCode}
        hint="The renter gives it to you."
        error={attempted && !parsed ? 'That is not an invitation code.' : null}
        testID="roster-invitation-code-field"
      />
      <View style={buttonRow}>
        <Button
          label="Open invitation"
          variant="secondary"
          onPress={() => {
            setAttempted(true);
            if (parsed) setOpened(parsed);
          }}
        />
      </View>
    </Section>
  );
}

function MyInvitations() {
  const router = useRouter();
  const invitations = useApiQuery({ path: '/me/booking-roster-invitations' });
  return (
    <QueryBoundary
      query={invitations}
      label="your roster invitations"
      isEmpty={(items) => items.length === 0}
      empty={{
        title: 'No invitations waiting',
        description:
          'An invitation to a rental roster that names you, or a child you register for, appears here.',
      }}
      unavailableOffline={['Joining a roster']}
    >
      {(items) => (
        <View accessibilityRole="list" accessibilityLabel="Your roster invitations">
          {items.map((invitation) => (
            <ListRow
              key={invitation.id}
              title={invitation.booking.offeringName}
              detail={when(invitation)}
              status={STATUS[invitation.status]}
              onPress={() => router.push(`${ROSTER_INVITATIONS_PATH}/${invitation.id}`)}
              accessibilityHint="Opens the invitation"
              testID={`roster-invitation-row-${invitation.id}`}
            />
          ))}
        </View>
      )}
    </QueryBoundary>
  );
}

/** Whether rental rosters are on; while they are off the screens say so and read nothing else. */
function RostersGate({ children }: { children: React.ReactNode }) {
  const permissions = usePermissions();
  const enabled = permissions.isCapabilityEnabled('rental_rosters');
  if (enabled === undefined) return <StateView variant="loading" label="rental rosters" />;
  if (!enabled) {
    return (
      <StateView
        variant="unavailable"
        title="Rental rosters are not in use"
        description="This organization has not turned rental rosters on."
      />
    );
  }
  return <>{children}</>;
}

export function RosterInvitationsScreen() {
  const styles = useStyles();
  return (
    <Screen>
      <View testID="screen-roster-invitations">
        <RequireSession what="your roster invitations">
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Rental roster invitations
            </Text>
            <UiText variant="body">
              A renter can put you on the list of people they bring. You answer for yourself or for
              your child.
            </UiText>
          </View>
          <RostersGate>
            <MyInvitations />
            <EnterCode />
          </RostersGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

export function RosterInvitationScreen({ invitationId }: { invitationId: string | null }) {
  if (invitationId === null) return <NotFoundScreen />;
  return (
    <Screen>
      <View testID="screen-roster-invitation">
        <RequireSession what="this invitation">
          <RostersGate>
            <InvitationRead invitationId={invitationId} />
          </RostersGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

/** Route component for app/booking-roster-invitations/index.tsx. */
export function RosterInvitationsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Roster invitations' }} />
      <RosterInvitationsScreen />
    </>
  );
}

/** Route component for app/booking-roster-invitations/[id].tsx; a malformed id is not available. */
export function RosterInvitationRoute() {
  const params = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Roster invitation' }} />
      <RosterInvitationScreen invitationId={routeId(params.id)} />
    </>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  title: { ...type.title, color: colors.text },
}));

const buttonRow = { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm } as const;
