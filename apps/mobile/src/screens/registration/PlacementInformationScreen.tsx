/**
 * SCR-C-10 Participant and placement information (SPK-PLACE-001, SPK-PLACE-005, §4.14; journey
 * A3). For an individual league entry in the basket, collects only the placement fields the
 * operator has approved and records them with `POST /v1/placement-requests`. Placement stays
 * staff-reviewed (SPK-PLACE-002): saving reserves nothing and assigns no team.
 *
 * Which fields are approved is pending DEC-051 (with DEC-031; Product and operations;
 * Operator/privacy owner): the list comes from configuration (`placementFields`), and while it is
 * unset the screen shows the pending state instead of inventing a field list. Requested teammates
 * would need other people's identities, which the app never exposes (SPK-PLACE-005): they read as
 * not available. A configured preferred competition is chosen from the organization's active
 * competitions (`GET /v1/competitions?status=active`, which a customer may read) and sent as
 * `preferredCompetitionId`; "No preference" sends nothing.
 *
 * The competition season the placement request names comes from the API:
 * `GET /v1/offerings/{id}/registration-options` `seasonId` (ENR-05, SPK-PLACE-001). An offering
 * the API links to no season reads "not available" (nothing is sent).
 *
 * States: loading (basket, then the season); empty (nothing approved to collect: pending); ready;
 * validation failure (field messages, input kept); permission restriction (no register permission
 * for this participant); offline (input kept on screen, saving disabled); processing (saving);
 * success (saved); the season read's error with its code and "Try again".
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { fieldMessages } from '../../features/registration/format';
import { useRegistrationOptions } from '../../features/registration/options';
import { useParticipantNames } from '../../features/registration/participants';
import { param, registrationRoutes } from '../../features/registration/routes';
import { Body, ButtonRow, ChoiceRow, Section, TextField } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

type Basket = Schema<'Basket'>;
type AvailabilityWindow = Schema<'AvailabilityWindow'>;

/** Fields this screen can collect, by their configuration name. */
export const COLLECTABLE_FIELDS = [
  'availability',
  'preferredCompetition',
  'declaredLevel',
  'positionPreferences',
  'notes',
] as const;
export type CollectableField = (typeof COLLECTABLE_FIELDS)[number];
const NOT_IN_APP: Record<string, string> = {
  requestedTeammates: 'Requested teammates',
};

/**
 * SPK-PLACE-001 preferred competition: one of the organization's active competitions, or no
 * preference. The list is the API's; staff weigh the preference when placing (SPK-PLACE-002).
 */
function CompetitionChoice({
  value,
  onChange,
  error,
}: {
  value: string | null;
  onChange: (competitionId: string | null) => void;
  error?: string;
}) {
  const competitions = useApiQuery({
    path: '/competitions',
    request: { query: { status: 'active' } },
  });
  return (
    <View style={styles.editor} testID="preferred-competition">
      <Text style={styles.label}>Preferred competition</Text>
      {competitions.data === undefined ? (
        competitions.error ? (
          <QueryErrorView
            error={competitions.error}
            onRetry={() => void competitions.refetch()}
            unavailable={{
              title: 'Competitions not available',
              description: 'You can still save the other answers; staff place players.',
            }}
          />
        ) : (
          <StateView variant="loading" label="the competitions" />
        )
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel="Preferred competition">
          <ChoiceRow
            mode="radio"
            label="No preference"
            checked={value === null}
            onToggle={() => onChange(null)}
          />
          {competitions.data.map((c) => (
            <ChoiceRow
              key={c.id}
              mode="radio"
              label={c.name}
              detail={c.description ?? undefined}
              checked={value === c.id}
              onToggle={() => onChange(c.id)}
            />
          ))}
          {competitions.data.length === 0 ? (
            <Body muted>No competition is open to choose from right now.</Body>
          ) : null}
        </View>
      )}
      {error ? <Text style={styles.error}>{`✕ ${error}`}</Text> : null}
    </View>
  );
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function splitPreferences(text: string): string[] {
  return text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function AvailabilityEditor({
  windows,
  onChange,
  error,
}: {
  windows: AvailabilityWindow[];
  onChange: (next: AvailabilityWindow[]) => void;
  error?: string;
}) {
  const [weekday, setWeekday] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const add = () => {
    if (weekday === null) return setProblem('Choose a day.');
    if (!TIME.test(from) || !TIME.test(to))
      return setProblem('Enter times as HH:MM, for example 18:30.');
    if (to <= from) return setProblem('The end time must be after the start time.');
    setProblem(undefined);
    onChange([...windows, { weekday, from, to }]);
    setFrom('');
    setTo('');
  };
  return (
    <View style={styles.editor}>
      <Text style={styles.label}>When can the player play?</Text>
      <View style={styles.days} accessibilityRole="radiogroup" accessibilityLabel="Day">
        {WEEKDAYS.map((day, index) => (
          <Pressable
            key={day}
            accessibilityRole="radio"
            accessibilityLabel={day}
            accessibilityState={{ checked: weekday === index }}
            onPress={() => setWeekday(index)}
            style={[styles.day, weekday === index && styles.dayOn]}
          >
            <Text style={[styles.dayText, weekday === index && styles.dayTextOn]}>
              {weekday === index ? `✓ ${day.slice(0, 3)}` : day.slice(0, 3)}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextField
        label="From (HH:MM)"
        value={from}
        onChangeText={setFrom}
        testID="availability-from"
      />
      <TextField
        label="To (HH:MM)"
        value={to}
        onChangeText={setTo}
        error={problem ?? error}
        testID="availability-to"
      />
      <Button label="Add this time" variant="secondary" onPress={add} />
      {windows.map((w, index) => (
        <View key={`${w.weekday}-${w.from}-${w.to}`} style={styles.window}>
          <Body>{`${WEEKDAYS[w.weekday]} ${w.from} to ${w.to}`}</Body>
          <Button
            label={`Remove ${WEEKDAYS[w.weekday]} ${w.from} to ${w.to}`}
            variant="secondary"
            onPress={() => onChange(windows.filter((_, i) => i !== index))}
          />
        </View>
      ))}
    </View>
  );
}

function PlacementForm({
  basket,
  lineId,
  fields,
}: {
  basket: Basket;
  lineId: string;
  fields: readonly string[];
}) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const line = basket.lines.find((l) => l.id === lineId);
  const options = useRegistrationOptions(line?.offeringId ?? '', [], line !== undefined);
  const seasonId = options.data?.seasonId ?? null;
  const names = useParticipantNames(line ? [line.participantPersonId] : []);
  const [availability, setAvailability] = useState<AvailabilityWindow[]>([]);
  const [declaredLevel, setDeclaredLevel] = useState('');
  const [positions, setPositions] = useState('');
  const [notes, setNotes] = useState('');
  const [preferredCompetitionId, setPreferredCompetitionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const save = useApiCommand('post', '/placement-requests');

  if (!line) return <StateView variant="unavailable" />;
  const name = names(line.participantPersonId);
  const collect = COLLECTABLE_FIELDS.filter((f) => fields.includes(f));
  const notInApp = fields.filter((f) => NOT_IN_APP[f]).map((f) => NOT_IN_APP[f] as string);
  if (collect.length === 0) {
    return (
      <StateView
        variant="empty"
        title="Nothing to add"
        description="No placement information is collected in the app for this activity."
      />
    );
  }
  if (options.data === undefined) {
    return options.error ? (
      <QueryErrorView error={options.error} onRetry={() => void options.refetch()} />
    ) : (
      <StateView variant="loading" label="the season of this activity" />
    );
  }
  if (!seasonId) {
    return (
      <StateView
        variant="unavailable"
        title="Not available for this activity"
        description="This activity is not linked to a league season, so placement information cannot be sent from here. Staff place individual players."
      />
    );
  }
  if (save.status === 'success') {
    return (
      <View>
        <Section title="Placement information">
          <StatusBadge tone="info" label="Placement information sent" testID="placement-saved" />
          <Body>Staff review placement. No team is assigned yet, and no place is reserved.</Body>
        </Section>
        <ButtonRow>
          <Button
            label="Back to your basket"
            onPress={() => router.push(registrationRoutes.basket(basket.id))}
          />
        </ButtonRow>
      </View>
    );
  }
  const errors = failure?.code === 'VALIDATION_FAILED' ? fieldMessages(failure.details) : {};
  const errorFor = (prefix: string) =>
    Object.entries(errors).find(([key]) => key.startsWith(prefix))?.[1];
  const submit = async () => {
    setFailure(null);
    try {
      await save.submit({
        body: {
          participantPersonId: line.participantPersonId,
          seasonId,
          offeringId: line.offeringId,
          ...(line.applicationId ? { applicationId: line.applicationId } : {}),
          availability: collect.includes('availability') ? availability : [],
          ...(collect.includes('preferredCompetition') && preferredCompetitionId
            ? { preferredCompetitionId }
            : {}),
          ...(collect.includes('declaredLevel') && declaredLevel.trim()
            ? { declaredLevel: declaredLevel.trim() }
            : {}),
          positionPreferences: collect.includes('positionPreferences')
            ? splitPreferences(positions)
            : [],
          requestedTeammatePersonIds: [],
          ...(collect.includes('notes') && notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <View>
      <Section title={name === 'You' ? 'About you as a player' : `About ${name} as a player`}>
        <Body muted>
          Only the information below is collected. It is used by staff to place players and is never
          shown publicly.
        </Body>
        {collect.includes('availability') ? (
          <AvailabilityEditor
            windows={availability}
            onChange={setAvailability}
            error={errorFor('availability')}
          />
        ) : null}
        {collect.includes('preferredCompetition') ? (
          <CompetitionChoice
            value={preferredCompetitionId}
            onChange={setPreferredCompetitionId}
            error={errorFor('preferredCompetitionId')}
          />
        ) : null}
        {collect.includes('declaredLevel') ? (
          <TextField
            label="Playing level"
            hint="In your own words"
            value={declaredLevel}
            onChangeText={setDeclaredLevel}
            error={errorFor('declaredLevel')}
            testID="declared-level"
          />
        ) : null}
        {collect.includes('positionPreferences') ? (
          <TextField
            label="Preferred positions"
            hint="Separate positions with commas"
            value={positions}
            onChangeText={setPositions}
            error={errorFor('positionPreferences')}
            testID="positions"
          />
        ) : null}
        {collect.includes('notes') ? (
          <TextField
            label="Notes for staff"
            value={notes}
            onChangeText={setNotes}
            error={errorFor('notes')}
            multiline
            testID="placement-notes"
          />
        ) : null}
        {notInApp.length > 0 ? (
          <Body muted>{`Not available in the app yet: ${notInApp.join(', ')}.`}</Body>
        ) : null}
      </Section>
      <CommandError error={failure} onRetry={() => void submit()} />
      <ButtonRow>
        <Button
          label="Save placement information"
          onPress={() => void submit()}
          busy={save.isProcessing}
          disabled={offline}
        />
        {offline ? <Body muted>Saving needs a connection. Your answers are kept.</Body> : null}
      </ButtonRow>
    </View>
  );
}

export function PlacementInformationScreen({
  basketId,
  lineId,
}: {
  basketId: string;
  lineId: string;
}) {
  const { session, services } = useApp();
  const fields = services.config.placementFields ?? null;
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: basketId } },
    enabled: session.status === 'signed_in' && fields !== null,
  });
  return (
    <Screen>
      <RequireSession what="placement information">
        {fields === null ? (
          <StateView
            variant="pending-decision"
            subject="Placement information"
            decisions={['DEC-051', 'DEC-031']}
            owner="Product and operations; Operator/privacy owner"
          />
        ) : (
          <QueryBoundary
            query={basket}
            label="your basket"
            empty={{ title: 'Not available', description: '' }}
            unavailableOffline={['Saving placement information']}
          >
            {(b) => <PlacementForm basket={b} lineId={lineId} fields={fields} />}
          </QueryBoundary>
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/placement/[lineId].tsx (`?basketId=`). */
export function PlacementInformationRoute() {
  const params = useLocalSearchParams<{ lineId: string; basketId?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Placement information' }} />
      <PlacementInformationScreen
        lineId={param(params.lineId) ?? ''}
        basketId={param(params.basketId) ?? ''}
      />
    </>
  );
}

const styles = StyleSheet.create({
  editor: { gap: spacing.sm },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  day: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  dayOn: { backgroundColor: colors.primary },
  dayText: { ...type.caption, color: colors.primary, fontWeight: '600' },
  dayTextOn: { color: colors.primaryText },
  window: { gap: spacing.xs },
  error: { ...type.caption, color: colors.danger },
});
