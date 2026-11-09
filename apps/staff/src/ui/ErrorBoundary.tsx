/**
 * Contains a screen that fails while rendering (SPK-UX-006 understandable error states, §4.10):
 * instead of a blank page the viewer sees what happened, the correlation id to quote to support
 * when the failure came from the API, and a way to retry or start again from Today. The failure is
 * reported once to the crash reporter. Navigating to another route clears it.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describeFailure, type CrashReporter } from '../providers/crash-report';

interface BoundaryProps {
  reporter: CrashReporter;
  now: () => Date;
  path: string | null;
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
      path: this.props.path,
      at: this.props.now(),
    });
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.path !== this.props.path) {
      this.setState({ error: null, failed: false });
    }
  }

  private readonly retry = () => this.setState({ error: null, failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { correlationId } = describeFailure(this.state.error);
    return (
      <main className="page-head" role="alert" aria-live="assertive">
        <h1 className="page-title">Something went wrong on this screen</h1>
        <p>
          Nothing you submitted was lost because of this display problem. Try again, or start from
          Today.
        </p>
        {correlationId ? (
          <p className="caption">
            Reference for support: <code>{correlationId}</code>
          </p>
        ) : null}
        <div className="actions-row">
          <button type="button" className="button button-primary" onClick={this.retry}>
            Try again
          </button>
          <a className="button" href="/today">
            Go to Today
          </a>
        </div>
      </main>
    );
  }
}

/** The boundary for the routed screens, cleared when the viewer navigates elsewhere. */
export function RouteErrorBoundary({
  reporter,
  now,
  children,
}: {
  reporter: CrashReporter;
  now: () => Date;
  children: ReactNode;
}) {
  const location = useLocation();
  return (
    <ErrorBoundary reporter={reporter} now={now} path={location.pathname}>
      {children}
    </ErrorBoundary>
  );
}
