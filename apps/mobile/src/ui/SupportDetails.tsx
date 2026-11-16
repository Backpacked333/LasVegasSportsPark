/**
 * SupportDetails: the collapsed "Details for support" fold (PA-11, SPK-UX-011 **Proposed**). The
 * identifiers a customer does not need to act, but that support needs to help, live here and only
 * here: decision identifiers (`DEC-###`, `POL-###`), the owner of an open decision, the API's error
 * code and the correlation reference (§4.10 requires them to be available, not prominent).
 *
 * Each is one plain "Label: value" line, selectable so it can be copied into a message to the
 * front desk. The fold is closed until the person opens it on purpose (`Disclosure`, a button with
 * an expanded state), and draws nothing when there is nothing to show.
 */
import { Text } from 'react-native';
import { Disclosure } from './Disclosure';
import { makeStyles, type } from './theme';

export const SUPPORT_DETAILS_TITLE = 'Details for support';

export interface SupportLine {
  label: string;
  value: string;
}

export interface SupportDetailsProps {
  /** Decisions the screen waits on (DEC-###, POL-###). */
  decisions?: readonly string[];
  /** Owner wording from the decision register. */
  owner?: string;
  /** The API's error code, e.g. "STALE_REVISION" or "ACCESS_DENIED (CAPABILITY_DISABLED)". */
  errorCode?: string;
  /** The correlation reference of the failed request. */
  reference?: string | null;
  /** Further lines, after the standard ones. */
  lines?: readonly SupportLine[];
  testID?: string;
}

/** The lines of the fold, in order: decisions, owner, error code, reference, then the rest. */
export function supportLines({
  decisions,
  owner,
  errorCode,
  reference,
  lines = [],
}: SupportDetailsProps): SupportLine[] {
  const out: SupportLine[] = [];
  if (decisions && decisions.length > 0) {
    out.push({
      label: decisions.length === 1 ? 'Decision' : 'Decisions',
      value: decisions.join(', '),
    });
  }
  if (owner) out.push({ label: 'Owner', value: owner });
  if (errorCode) out.push({ label: 'Error code', value: errorCode });
  if (reference) out.push({ label: 'Reference', value: reference });
  return [...out, ...lines.filter((line) => line.value !== '')];
}

export function SupportDetails(props: SupportDetailsProps) {
  const styles = useStyles();
  const lines = supportLines(props);
  if (lines.length === 0) return null;
  return (
    <Disclosure title={SUPPORT_DETAILS_TITLE} size="sm" testID={props.testID}>
      {lines.map((line) => (
        <Text key={line.label} style={styles.line} selectable>
          {`${line.label}: ${line.value}`}
        </Text>
      ))}
    </Disclosure>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  line: { ...type.footnote, color: colors.textMuted },
}));
