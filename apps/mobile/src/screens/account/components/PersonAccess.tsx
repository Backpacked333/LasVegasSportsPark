/**
 * What this person may do for someone else (SCR-C-02, SCR-C-31; SPK-IAM-003): the six
 * permissions are listed one by one as "Allowed" or "Not allowed" with a glyph, so one permission
 * never reads as implying another and status is never colour alone (SPK-UX-009). The list comes
 * from `GET /v1/me` `authorities` only; the client infers nothing from household membership.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../../../ui/theme';
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
  children,
}: {
  authority: Authority;
  index: number;
  children?: ReactNode;
}) {
  const name = personNameText(usePersonName(authority.subjectPersonId));
  return (
    <View style={styles.card} testID={`person-access-${index}`}>
      <Text style={styles.title} accessibilityRole="header">
        {name}
      </Text>
      <View accessibilityRole="list" accessibilityLabel={`What you may do for ${name}`}>
        {GRANT_PERMISSIONS.map((g) => {
          const allowed = authority.permissions.includes(g.permission);
          return (
            <View
              key={g.permission}
              style={styles.row}
              accessible
              accessibilityLabel={`${g.label}: ${allowed ? 'allowed' : 'not allowed'}. ${g.detail}`}
            >
              <Text
                style={[styles.glyph, { color: allowed ? colors.success : colors.neutral }]}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {allowed ? '✓' : '–'}
              </Text>
              <View style={styles.text}>
                <Text style={styles.label}>
                  {g.label}: {allowed ? 'Allowed' : 'Not allowed'}
                </Text>
                <Text style={styles.caption}>{g.detail}</Text>
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
