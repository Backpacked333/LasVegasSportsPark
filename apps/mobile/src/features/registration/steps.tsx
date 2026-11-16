/**
 * The five steps of registering (journey A3 to A5; PA-11, ADR-008 visual system v2): Who →
 * Options → Forms → Review → Pay, shown with `ProgressSteps` at the top of each step screen.
 *
 * Each step keeps its own route (SCR-C-09 who and options, SCR-C-10 a player's options, SCR-C-13
 * forms, SCR-C-12 review, SCR-C-14 pay), so back navigation, the remembered checkout and recovery
 * after a restart work exactly as before (SPK-UX-001). The cart (SCR-C-11) holds the lines between
 * the steps and is not a step itself; the outcome (SCR-C-15) comes after the last one.
 */
import { ProgressSteps } from '../../ui/ProgressSteps';
import { layout, makeStyles, spacing } from '../../ui/theme';

export const REGISTRATION_STEPS = ['Who', 'Options', 'Forms', 'Review', 'Pay'] as const;
export type RegistrationStep = (typeof REGISTRATION_STEPS)[number];

/** "Step 2 of 5, Options" for screen readers; the words and the bar on screen. */
export function RegistrationSteps({ step }: { step: RegistrationStep }) {
  const styles = useStyles();
  return (
    <ProgressSteps
      steps={REGISTRATION_STEPS}
      current={REGISTRATION_STEPS.indexOf(step)}
      style={styles.steps}
      testID="registration-steps"
    />
  );
}

const useStyles = makeStyles(() => ({
  steps: { paddingHorizontal: layout.gutter, paddingTop: spacing.md },
}));
