/**
 * Contains a screen that fails while rendering (SPK-UX-006 understandable error states, §4.10):
 * instead of a closed or blank app the customer sees what happened, the reference to quote to
 * support when the failure came from the API, and a way to try again. Reported once.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import { describeFailure, type CrashReporter } from '../providers/crash-report';
import { LiveRegion, sentences } from './announce';
import { Button } from './Button';
import { colors, spacing, type } from './theme';

interface BoundaryProps {
  reporter: CrashReporter;
  now: () => Date;
  children: ReactNode;
}

interface BoundaryState {
  error: unknown;
  failed: boolean;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.reporter.capture({
      source: 'render',
      ...describeFailure(error),
      fatal: false,
      at: this.props.now(),
    });
  }

  private readonly retry = () => this.setState({ error: null, failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { correlationId } = describeFailure(this.state.error);
    return (
      // Announced on iOS and a polite live region on Android (ui/announce, SPK-UX-009).
      <LiveRegion
        style={styles.container}
        accessibilityRole="alert"
        announcement={sentences('Something went wrong', 'Try again to reload the screen')}
      >
        <Text style={styles.title} accessibilityRole="header">
          Something went wrong
        </Text>
        <Text style={styles.body}>
          Nothing you submitted was lost because of this display problem. Try again to reload the
          screen.
        </Text>
        {correlationId ? (
          <Text style={styles.caption}>Reference for support: {correlationId}</Text>
        ) : null}
        <Button label="Try again" onPress={this.retry} />
      </LiveRegion>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.page,
  },
  title: { ...type.title, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
