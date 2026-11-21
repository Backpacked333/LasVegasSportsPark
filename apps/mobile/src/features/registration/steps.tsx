/**
 * The three steps of registering (redesign handoff 1e, 2a, 1f; PA-11, ADR-008): Who → Options →
 * Review & pay (forms are signed and the payment made on Review). Shown by the screens that keep
 * their own route (the intent chooser for bookings, a player's placement details).
 *
 * Each step keeps its own route (SCR-C-09 who and options, SCR-C-10 a player's options, SCR-C-13
 * forms, SCR-C-12 review, SCR-C-14 pay), so back navigation, the remembered checkout and recovery
 * after a restart work exactly as before (SPK-UX-001). The cart (SCR-C-11) holds the lines between
 * the steps and is not a step itself; the outcome (SCR-C-15) comes after the last one.
 */
import { ProgressSteps } from '../../ui/ProgressSteps';
import { layout, makeStyles, spacing } from '../../ui/theme';

export const REGISTRATION_STEPS = ['Who', 'Options', 'Review'] as const;
export type RegistrationStep = (typeof REGISTRATION_STEPS)[number];

/** "Step 2 of 3, Options" for screen readers; the words and the bar on screen. */
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
