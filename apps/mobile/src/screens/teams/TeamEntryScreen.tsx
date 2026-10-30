/**
 * SCR-C-27 Create or renew team entry (SPK-REG-001, SPK-COMP-001, SPK-COMP-004, SPK-CAP-005,
 * SPK-AT-003). `POST /v1/team-entries` creates a continuing team identity and its season entry,
 * or renews from a prior season's entry (`renewFromEntryId`): the API creates new season records,
 * leaves the prior entry and its roster untouched, re-evaluates prices, eligibility, permissions
 * and roster acceptance, charges nothing, and suggests prior players. Suggested players are only
 * suggestions: each is invited (`POST /v1/team-entries/{id}/invitations` with their person id) and
 * joins by accepting, so roster acceptance is re-evaluated too.
 *
 * Open seasons come from `GET /v1/seasons?status=open` with competition names from
 * `GET /v1/competitions`; divisions (`GET /v1/divisions`) are shown for information only, because
 * the API lets only staff place an entry in a division: a customer's preferred division waits on
 * DEC-002 and DEC-028 (the API does not take one). Renewal is offered only when the prior entry's
 * workspace lists `competition.renew_team_entry` for this viewer (CMP-02); when it does not, a
 * manager of the prior entry is told renewal is not available for this team now (the API gives no
 * reason, for example an entry not approved yet), anyone else that only its captain renews it. A
 * created or renewed entry is listed on SCR-C-21 from `GET /v1/me/team-entries`. Payment, when
 * the league bills the team, is SCR-C-14, not this screen. A suggested player whose invitation was
 * created but whose link was lost (IDEMPOTENCY_SECRET_WITHHELD after "Check again") is shown as
 * created, and "Revoke and issue a new link" revokes it and invites them again under a new key;
 * one that may have been created with its answer lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE) reads "This
 * may already have been done" and is looked for among the team's open invitations. "Invite" is not
 * offered again beside either (ui/SecretWithheld) until "Start a new one".
 *
 * States: loading; empty (no open season; no prior team to renew); ready; validation failure
 * (team name rules, registration closed: the API's reasons); permission restriction (renewal only
 * by a prior captain: not available); stale version (division capacity or the season changed:
 * the API's answer, reload); offline (draft kept, submit disabled); processing; success ("Team
 * entry awaiting approval" or "Team entry approved").
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { mustNotCreateAgain } from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange, formatInstant } from '../../features/teams/format';
import {
  answeredTeamInvitationAt,
  InvitationIssued,
  WITHHELD_REVOKE_REASON,
} from '../../features/teams/InvitationIssued';
import {
  hasManagementView,
  MY_TEAMS_KEY,
  notAvailableNow,
  TEAM_ACTIONS,
  useSignedIn,
  useWorkspace,
  type Workspace,
} from '../../features/teams/queries';
import { idParam, teamRoutes } from '../../features/teams/routes';
import { teamEntryStatus } from '../../features/teams/status';
import {
  Body,
  ButtonRow,
  CommandFailure,
  Detail,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  Section,
  TextField,
  Title,
} from '../../features/teams/ui';
import { useKeyedCommands } from '../../features/teams/useKeyedCommands';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { SecretWithheld } from '../../ui/SecretWithheld';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

type Season = Schema<'Season'>;
type Division = Schema<'Division'>;
type Created = Schema<'TeamEntryCreated'>;

export function divisionCriteriaText(division: Division): string {
  const c = division.criteria;
  const parts: string[] = [];
  if (c.ageBand) {
    const { minAge, maxAge } = c.ageBand;
    if (minAge !== null && maxAge !== null) parts.push(`ages ${minAge} to ${maxAge}`);
    else if (minAge !== null) parts.push(`ages ${minAge} and over`);
    else if (maxAge !== null) parts.push(`ages up to ${maxAge}`);
  }
  if (c.level) parts.push(c.level);
  if (c.category) parts.push(c.category);
  if (c.format) parts.push(c.format);
  const capacity =
    division.capacityTeamEntries !== null
      ? `${division.entryCount} of ${division.capacityTeamEntries} team places taken`
      : `${division.entryCount} teams entered`;
  return [parts.join(', '), capacity].filter(Boolean).join('. ');
}

function registrationWindow(season: Season): string {
  const parts = [formatDateRange(season.startsOn, season.endsOn)];
  if (season.registrationOpensAt)
    parts.push(`entries open ${formatInstant(season.registrationOpensAt)}`);
  if (season.registrationClosesAt)
    parts.push(`entries close ${formatInstant(season.registrationClosesAt)}`);
  return parts.join('; ');
}

function Divisions({ seasonId }: { seasonId: string }) {
  const divisions = useApiQuery({ path: '/divisions', request: { query: { seasonId } } });
  return (
    <Section title="Divisions">
      <Body muted>
        The league places your entry in a division using these documented criteria; it cannot be
        chosen in the app.
      </Body>
      <QueryBoundary
        query={divisions}
        label="the divisions"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No divisions yet',
          description: 'The league has not set up divisions for this season yet.',
        }}
      >
        {(list) => (
          <View accessibilityRole="list">
            {list.map((d) => (
              <Detail key={d.id} label={d.name} value={divisionCriteriaText(d)} />
            ))}
          </View>
        )}
      </QueryBoundary>
    </Section>
  );
}

function SuggestedPlayers({ created, teamName }: { created: Created; teamName: string }) {
  const { reachable } = useConnectivity();
  const invite = useKeyedCommands('post', '/team-entries/{id}/invitations', {
    invalidate: [['api', '/team-entries/{id}']],
  });
  if (created.suggestedPlayers.length === 0) return null;
  const send = (personId: string) =>
    void invite.submit(personId, {
      path: { id: created.entry.id },
      body: { recipientPersonId: personId },
    });
  return (
    <Section title="Players from last season" testID="suggested-players">
      <Body>
        These are suggestions only. Nobody is added automatically: each player joins by accepting an
        invitation, and eligibility is checked again for this season.
      </Body>
      {created.suggestedPlayers.map((player) => {
        const state = invite.states[player.personId];
        const withheld = state?.status === 'failed' && mustNotCreateAgain(state.error);
        return (
          <View key={player.personId} style={styles.suggestion}>
            {state?.status === 'succeeded' ? (
              <InvitationIssued
                invitation={state.data}
                recipient={player.displayName}
                teamName={teamName}
              />
            ) : withheld ? (
              <>
                <Body>{player.displayName}</Body>
                <SecretWithheld
                  error={state.error}
                  what="invitation"
                  listName="Open invitations on the team's roster"
                  answeredShownAt={answeredTeamInvitationAt("on the new team's roster")}
                  revokePath="/team-invitations/{id}/revoke"
                  revokeReason={WITHHELD_REVOKE_REASON}
                  invalidate={[['api', '/team-entries/{id}']]}
                  onReissue={() => send(player.personId)}
                  onStartOver={() => invite.forget(player.personId)}
                  testID={`suggested-${player.personId}-withheld`}
                />
              </>
            ) : (
              <>
                <Body>{player.displayName}</Body>
                <Button
                  label={`Invite ${player.displayName}`}
                  variant="secondary"
                  onPress={() => send(player.personId)}
                  busy={state?.status === 'processing'}
                  disabled={reachable === false}
                />
              </>
            )}
            {state?.status === 'failed' && !withheld ? (
              <CommandFailure
                error={state.error}
                onRetry={() => send(player.personId)}
                unavailableText="Inviting this player is not available to you."
              />
            ) : null}
          </View>
        );
      })}
    </Section>
  );
}

function CreatedEntry({ created, prior }: { created: Created; prior: Workspace | null }) {
  const router = useRouter();
  return (
    <View testID="entry-created">
      <Section title={created.team.name}>
        <StatusBadge {...teamEntryStatus(created.entry)} testID="created-status" />
        <Body>
          Nothing has been charged. Prices, eligibility, permissions and roster acceptance are
          checked again for this season.
        </Body>
        {prior ? (
          <Body>{`Your ${prior.season.name} entry and its roster are unchanged.`}</Body>
        ) : null}
        <Button
          label="Open the new team"
          onPress={() => router.push(teamRoutes.workspace(created.entry.id))}
        />
      </Section>
      <SuggestedPlayers created={created} teamName={created.team.name} />
    </View>
  );
}

function EntryForm({
  seasons,
  competitions,
  prior,
}: {
  seasons: Season[];
  competitions: Map<string, string>;
  prior: Workspace | null;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [attempted, setAttempted] = useState(false);
  // The new entry is listed on SCR-C-21 from `GET /v1/me/team-entries` once created.
  const create = useApiCommand('post', '/team-entries', {
    invalidate: [['api', '/divisions'], MY_TEAMS_KEY],
  });
  const choices = seasons.filter((s) => s.id !== prior?.season.id);
  const nameError =
    !prior && attempted && teamName.trim().length === 0 ? 'Enter the team name.' : null;
  const seasonError = attempted && !seasonId ? 'Choose a season.' : null;

  const submit = () => {
    setAttempted(true);
    if (!seasonId || (!prior && !teamName.trim())) return;
    void create
      .submit({
        body: prior
          ? { seasonId, renewFromEntryId: prior.entry.id }
          : { seasonId, team: { name: teamName.trim() } },
      })
      .catch(() => undefined);
  };

  if (create.data) return <CreatedEntry created={create.data} prior={prior} />;
  if (choices.length === 0) {
    return (
      <StateView
        variant="empty"
        title="No season open for team entries"
        description="Team entries can be made when the league opens a season. Check Discover for upcoming leagues."
      />
    );
  }
  return (
    <View>
      {prior ? (
        <Section title="Renewing">
          <Detail label="Team" value={prior.team.name} />
          <Detail label="Last season" value={prior.season.name} />
          <Body muted>
            The team keeps its name and identity. Last season&apos;s entry and roster stay as they
            are; players are suggested, never added automatically.
          </Body>
        </Section>
      ) : (
        <Section title="Team">
          <TextField
            label="Team name"
            value={teamName}
            onChangeText={setTeamName}
            autoCapitalize="words"
            error={nameError}
          />
          <Body muted>You will be the team&apos;s captain.</Body>
        </Section>
      )}
      <Section title="Season">
        <RadioGroup label="Open seasons">
          {choices.map((season) => (
            <RadioRow
              key={season.id}
              label={`${competitions.get(season.competitionId) ?? 'League'}: ${season.name}`}
              detail={registrationWindow(season)}
              checked={seasonId === season.id}
              onSelect={() => setSeasonId(season.id)}
            />
          ))}
        </RadioGroup>
        {seasonError ? <Body>{`▲ ${seasonError}`}</Body> : null}
      </Section>
      {seasonId ? <Divisions seasonId={seasonId} /> : null}
      <Section title={prior ? 'Renew' : 'Create'}>
        <Body>
          No payment is taken now. The league reviews the entry; prices, eligibility, permissions
          and roster acceptance are evaluated for the new season.
        </Body>
        {offline ? (
          <OfflineNotice what={prior ? 'Renewing the team' : 'Creating the team entry'} />
        ) : null}
        <ButtonRow>
          <Button
            label={prior ? 'Renew the team entry' : 'Create the team entry'}
            onPress={submit}
            disabled={offline}
            busy={create.isProcessing}
          />
        </ButtonRow>
        {create.error ? (
          <CommandFailure
            error={create.error}
            onRetry={submit}
            unavailableText={
              prior
                ? 'Renewing this team is not available to you. Only a captain of the prior entry can renew it.'
                : 'Creating a team entry is not available to you.'
            }
          />
        ) : null}
      </Section>
    </View>
  );
}

function EntryContent({ prior }: { prior: Workspace | null }) {
  const signedIn = useSignedIn();
  const seasons = useApiQuery({
    path: '/seasons',
    request: { query: { status: 'open' } },
    enabled: signedIn,
  });
  const competitions = useApiQuery({ path: '/competitions', enabled: signedIn });
  const names = new Map((competitions.data ?? []).map((c) => [c.id, c.name]));
  return (
    <View>
      <Title>{prior ? `Renew ${prior.team.name}` : 'Create a team entry'}</Title>
      <QueryBoundary
        query={seasons}
        label="open seasons"
        empty={{ title: 'No seasons', description: 'No season is open.' }}
        unavailableOffline={['creating or renewing a team entry']}
      >
        {(list) => <EntryForm seasons={list} competitions={names} prior={prior} />}
      </QueryBoundary>
    </View>
  );
}

function RenewContent({ priorEntryId }: { priorEntryId: string }) {
  const prior = useWorkspace(priorEntryId);
  if (prior.data === undefined && prior.error && prior.error.isNotFound) {
    // §4.10: a protected NOT_FOUND never implies the team exists or who captains it.
    return <StateView variant="unavailable" />;
  }
  if (prior.data === undefined && prior.error && prior.error.isPermissionRestriction) {
    return (
      <StateView
        variant="unavailable"
        description="Renewing this team is not available to you. Only a captain of the prior entry can renew it."
      />
    );
  }
  return (
    <QueryBoundary
      query={prior}
      label="last season's team"
      empty={{ title: 'No prior team', description: 'There is no prior team to renew.' }}
      unavailableOffline={['renewing the team']}
    >
      {(ws) =>
        // CMP-02: renewal is offered only when the API lists it for this viewer and entry.
        ws.viewer.availableActions.includes(TEAM_ACTIONS.renew) ? (
          <EntryContent prior={ws} />
        ) : hasManagementView(ws) ? (
          // A manager of an entry the API does not list renewal for now (for example one not
          // approved yet): the API names no reason, so none is invented here.
          <StateView variant="unavailable" description={notAvailableNow('Renewing this team')} />
        ) : (
          <StateView
            variant="unavailable"
            description="Renewing this team is not available to you. Only a captain of the prior entry can renew it."
          />
        )
      }
    </QueryBoundary>
  );
}

export function TeamEntryScreen({
  renewFrom,
}: {
  /** The prior entry id, `null` to create, or `'invalid'` for a malformed renewal link. */
  renewFrom: string | null | 'invalid';
}) {
  const router = useRouter();
  return (
    <Screen>
      <RequireSession what="team entries">
        {renewFrom === 'invalid' ? (
          <StateView
            variant="empty"
            title="No prior team to renew"
            description="Open last season's team and choose Renew, or create a new team entry."
            actionLabel="Create a new team entry"
            onAction={() => router.replace(teamRoutes.newEntry())}
          />
        ) : renewFrom ? (
          <RenewContent priorEntryId={renewFrom} />
        ) : (
          <EntryContent prior={null} />
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/team/new.tsx (`?renewFrom=<prior entry id>`). */
export function TeamEntryRoute() {
  const raw = useLocalSearchParams<{ renewFrom?: string }>().renewFrom;
  const renewFrom = raw === undefined ? null : (idParam(raw) ?? 'invalid');
  return (
    <>
      <Stack.Screen options={{ title: renewFrom ? 'Renew team' : 'Create team entry' }} />
      <TeamEntryScreen renewFrom={renewFrom} />
    </>
  );
}

const styles = StyleSheet.create({
  suggestion: { gap: spacing.xs, paddingVertical: spacing.xs },
});
