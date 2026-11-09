// Staff dashboard entry: browser services, providers, router.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRoutes } from './App';
import { AppProviders } from './providers/AppProviders';
import { consoleCrashReporter, installGlobalCrashHandlers } from './providers/crash-report';
import { createBrowserServices } from './providers/services';
import { RouteErrorBoundary } from './ui/ErrorBoundary';
// Archivo with its width axis: condensed headings and scoreboard numbers (redesign type system).
import '@fontsource-variable/archivo/wdth.css';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const services = createBrowserServices();
const reporter = services.crashReporter ?? consoleCrashReporter;
// Failures no screen caught (SPK-UX-006, §5.11): reported, never silently lost.
installGlobalCrashHandlers(window, reporter, services.now);

createRoot(root).render(
  <StrictMode>
    <AppProviders services={services}>
      <BrowserRouter>
        <RouteErrorBoundary reporter={reporter} now={services.now}>
          <AppRoutes />
        </RouteErrorBoundary>
      </BrowserRouter>
    </AppProviders>
  </StrictMode>,
);
