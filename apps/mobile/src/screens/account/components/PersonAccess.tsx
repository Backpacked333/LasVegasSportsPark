/**
 * What this person may do for someone else (SCR-C-02, SCR-C-31; SPK-IAM-003, SPK-IAM-005): the six
 * permissions are listed one by one with a glyph and words ("Allowed", "Not allowed", "Under
 * review", "Starts <date>"), so one permission never reads as implying another and status is never
 * colour alone (SPK-UX-009). Whether a permission is in effect comes from `GET /v1/me` `authorities`
 * only; the grants from `GET /v1/me/access-grants`, when given, add their dates, source and a
 * disputed-access review. The client infers nothing from household membership.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../../../ui/theme';
import { permissionState, type GrantView } from '../../family/grants';
import {
  GRANT_PERMISSIONS,
  listPermissions,
  personNameText,
  usePersonName,
  type Authority,
} from './account-data';

export function PersonAccessCard({
  authority,
  index,
  name: givenName,
  grants,
  children,
}: {
  authority: Authority;
  index: number;
  /** The person's name when the screen already read it; otherwise it is read here. */
  name?: string;
  /** This account's grants over the person; undefined while not loaded. */
  grants?: readonly GrantView[];
  children?: ReactNode;
}) {
  const read = personNameText(usePersonName(givenName ? '' : authority.subjectPersonId));
  const name = givenName ?? read;
  return (
    <View style={styles.card} testID={`person-access-${index}`}>
      <Text style={styles.title} accessibilityRole="header">
        {name}
      </Text>
      <View accessibilityRole="list" accessibilityLabel={`What you may do for ${name}`}>
        {GRANT_PERMISSIONS.map((g) => {
          const state = permissionState(
            g.permission,
            authority.permissions.includes(g.permission),
            grants,
          );
          const detail = state.note ? `${g.detail}. ${state.note}` : g.detail;
          return (
            <View
              key={g.permission}
              style={styles.row}
              accessible
              accessibilityLabel={`${g.label}: ${state.label.toLowerCase()}. ${detail}`}
            >
              <Text
                style={[styles.glyph, { color: colors[state.tone] }]}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {state.glyph}
              </Text>
              <View style={styles.text}>
                <Text style={styles.label}>
                  {g.label}: {state.label}
                </Text>
                <Text style={styles.caption}>{detail}</Text>
              </View>
            </View>
          );
        })}
      </View>
      {children}
    </View>
  );
}

/** One line per person: "Sam Rivera: View, Register and Pay" (SCR-C-02 restored access). */
export function PersonAccessLine({ authority }: { authority: Authority }) {
  const name = personNameText(usePersonName(authority.subjectPersonId));
  const text = `${name}: ${listPermissions(authority.permissions)}`;
  return (
    <View style={styles.line} accessible accessibilityLabel={text}>
      <Text style={styles.label}>{name}</Text>
      <Text style={styles.caption}>{listPermissions(authority.permissions)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
  },
  title: { ...type.heading, color: colors.text },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', minHeight: 32 },
  glyph: { ...type.body, fontWeight: '700', width: 20, textAlign: 'center' },
  text: { flex: 1 },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  line: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
