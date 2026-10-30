/**
 * SCR-C-31 households (SPK-IAM-001 "Households group people for billing, communication and
 * convenience, but household membership alone must not grant authority", §4.5, §4.14):
 * `GET /v1/me/households` lists the households this person belongs to, with the members they may
 * view (themselves and people they hold `view` over) named and the others only counted. The screen
 * says plainly that membership grants nothing; permissions are listed per person.
 *
 * - Create a household (`POST /v1/households`, offered when `GET /v1/me/permissions` lists
 *   `identity.create_household`): the person becomes its first member.
 * - Add a person to a household one belongs to (`POST /v1/households/{id}/members`, offered when
 *   it lists `identity.add_household_member`): only people this account holds `view` over (from
 *   `GET /v1/me` authorities) and who are not already named in it; the API re-checks both.
 * Neither command takes a revision. One idempotency key per intent; "Try again" resends the same
 * request. Adding never changes anyone's permissions, and the screen says so.
 *
 * States: loading; empty ("No household yet", saying who can create one); ready; validation
 * failure (a name is required; VALIDATION_FAILED shown with the API reason); permission
 * restriction (not offered unless listed; ACCESS_DENIED or NOT_FOUND shown as not available);
 * stale version: not applicable (no revision), the list is read again after each change; offline
 * (changes disabled, cached list with age); processing (cannot be cancelled while in flight);
 * success (the list shows the household as it is now); partial completion: not applicable;
 * recovery required: not applicable.
 */
import type { Schema } from '@sportspark/api-client';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { colors, spacing, type } from '../../ui/theme';
import { CommandError } from '../account/components/CommandError';
import { ChoiceGroup, Paragraph, SectionHeader, TextField } from '../account/components/forms';

type MyHousehold = Schema<'MyHousehold'>;
type Member = MyHousehold['members'][number];

export const HOUSEHOLDS_KEY = ['api', '/me/households'] as const;

/** A person this account may add to a household: held with `view`, named by the API. */
export interface HouseholdCandidate {
  personId: string;
  name: string;
}

function memberDetail(member: Member): string {
  const parts = [member.isSelf ? 'You' : member.kind === 'child' ? 'Child' : 'Adult'];
  if (member.label) parts.push(member.label);
  return parts.join(', ');
}

export function otherMembersText(count: number): string | null {
  if (count <= 0) return null;
  return `${count} other ${count === 1 ? 'member is' : 'members are'} not shown, because you do not have permission to view them.`;
}

const GRANTS_NOTHING = 'Being in a household gives nobody any permission.';

export function HouseholdsSection({ candidates }: { candidates: readonly HouseholdCandidate[] }) {
  const households = useApiQuery({ path: '/me/households' });
  const permissions = usePermissions();
  // Offered only when the API lists the action for this account; it re-checks every request.
  const createPermission = permissions.actionPermission('identity.create_household');
  const mayCreate = Boolean(createPermission);
  const mayAdd = Boolean(permissions.actionPermission('identity.add_household_member'));
  const emptyDescription =
    createPermission === undefined
      ? 'Households you belong to appear here.'
      : mayCreate
        ? 'You can create one below.'
        : 'The front desk can group your family into a household.';
  return (
    <View>
      <SectionHeader
        title="Households"
        detail={`A household groups people for billing and messages. ${GRANTS_NOTHING}`}
      />
      <QueryBoundary
        query={households}
        label="your households"
        isEmpty={(data) => data.items.length === 0}
        empty={{ title: 'No household yet', description: emptyDescription }}
        unavailableOffline={['creating a household', 'adding someone to a household']}
      >
        {(data) => (
          <View>
            {data.items.map((household) => (
              <HouseholdCard
                key={household.id}
                household={household}
                candidates={mayAdd ? candidates : []}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      {mayCreate ? <CreateHousehold /> : null}
    </View>
  );
}

function HouseholdCard({
  household,
  candidates,
}: {
  household: MyHousehold;
  /** People who may be added (empty when adding is not offered). */
  candidates: readonly HouseholdCandidate[];
}) {
  const [adding, setAdding] = useState(false);
  const others = otherMembersText(household.otherMemberCount);
  const addable = candidates.filter(
    (c) => !household.members.some((m) => m.personId === c.personId),
  );
  return (
    <View style={styles.card} testID={`household-${household.id}`}>
      <Text style={styles.title} accessibilityRole="header">
        {household.name}
      </Text>
      <View accessibilityRole="list" accessibilityLabel={`Members of ${household.name}`}>
        {household.members.map((member) => (
          <ListRow key={member.personId} title={member.displayName} detail={memberDetail(member)} />
        ))}
      </View>
      {others ? <Paragraph muted>{others}</Paragraph> : null}
      {addable.length > 0 && !adding ? (
        <View style={styles.inset}>
          <Button
            label={`Add someone to ${household.name}`}
            variant="secondary"
            onPress={() => setAdding(true)}
          />
        </View>
      ) : null}
      {adding ? (
        <AddMember household={household} candidates={addable} onClose={() => setAdding(false)} />
      ) : null}
    </View>
  );
}

type AddMemberRequest = { personId: string; label?: string };

function AddMember({
  household,
  candidates,
  onClose,
}: {
  household: MyHousehold;
  candidates: readonly HouseholdCandidate[];
  onClose: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [personId, setPersonId] = useState<string | null>(candidates[0]?.personId ?? null);
  const [label, setLabel] = useState('');
  const add = useApiCommand('post', '/households/{id}/members', { invalidate: [HOUSEHOLDS_KEY] });
  // The request of the intent in flight: "Try again" resends it unchanged (§4.9).
  const sent = useRef<AddMemberRequest | null>(null);
  const chosen = candidates.find((c) => c.personId === personId) ?? null;

  const send = async (request: AddMemberRequest) => {
    sent.current = request;
    try {
      await add.submit({ path: { id: household.id }, body: request });
      sent.current = null;
      onClose();
    } catch {
      // add.error is rendered below; the choice is kept.
    }
  };
  const submit = () => {
    if (!chosen) return;
    const trimmed = label.trim();
    void send({ personId: chosen.personId, ...(trimmed.length > 0 ? { label: trimmed } : {}) });
  };
  const changed = () => {
    sent.current = null;
    if (add.error) add.reset();
  };

  return (
    <View style={styles.form} testID={`household-add-${household.id}`}>
      <Paragraph>{`Adding someone to ${household.name} does not change anyone's permissions.`}</Paragraph>
      <ChoiceGroup<string>
        label="Person to add"
        value={personId}
        onChange={(next) => {
          setPersonId(next);
          changed();
        }}
        disabled={add.isProcessing}
        options={candidates.map((c) => ({ value: c.personId, label: c.name }))}
      />
      <TextField
        label="How they are related (optional)"
        hint="Shown next to their name in this household."
        value={label}
        onChangeText={(next) => {
          setLabel(next);
          changed();
        }}
        editable={!add.isProcessing}
        testID={`household-label-${household.id}`}
      />
      <View style={styles.inset}>
        <Button
          label={chosen ? `Add ${chosen.name}` : 'Add'}
          onPress={submit}
          busy={add.isProcessing}
          disabled={offline || chosen === null}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            sent.current = null;
            add.reset();
            onClose();
          }}
          disabled={add.isProcessing}
          accessibilityHint={add.isProcessing ? 'Waiting for the answer' : undefined}
        />
      </View>
      {add.error ? (
        <CommandError
          error={add.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          notFound={{
            title: 'Not available',
            description: 'This person or household is not available to you.',
          }}
          denied={{ title: 'You cannot add this person', description: add.error.message }}
        />
      ) : null}
    </View>
  );
}

function CreateHousehold() {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/households', { invalidate: [HOUSEHOLDS_KEY] });
  const sent = useRef<{ name: string } | null>(null);
  const nameError = name.trim().length === 0 ? 'Give the household a name.' : null;

  const send = async (request: { name: string }) => {
    sent.current = request;
    try {
      await create.submit({ body: request });
      sent.current = null;
      setOpen(false);
      setName('');
      setAttempted(false);
    } catch {
      // create.error is rendered below; the name is kept.
    }
  };
  const submit = () => {
    setAttempted(true);
    if (nameError) return;
    void send({ name: name.trim() });
  };

  if (!open) {
    return (
      <View style={styles.inset}>
        <Button
          label="Create a household"
          variant="secondary"
          onPress={() => setOpen(true)}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : 'You become its first member'}
        />
      </View>
    );
  }
  return (
    <View style={styles.form} testID="household-create">
      <Paragraph>{`You become the household's first member. ${GRANTS_NOTHING}`}</Paragraph>
      <TextField
        label="Household name"
        value={name}
        onChangeText={(next) => {
          setName(next);
          sent.current = null;
          if (create.error) create.reset();
        }}
        error={attempted ? nameError : null}
        editable={!create.isProcessing}
        testID="household-name"
      />
      <View style={styles.inset}>
        <Button
          label="Create household"
          onPress={submit}
          busy={create.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            sent.current = null;
            create.reset();
            setOpen(false);
          }}
          disabled={create.isProcessing}
          accessibilityHint={create.isProcessing ? 'Waiting for the answer' : undefined}
        />
      </View>
      {create.error ? (
        <CommandError
          error={create.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          denied={{ title: 'You cannot create a household', description: create.error.message }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
  },
  title: { ...type.heading, color: colors.text, paddingHorizontal: spacing.lg },
  inset: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  form: { gap: spacing.sm, paddingTop: spacing.sm },
});
