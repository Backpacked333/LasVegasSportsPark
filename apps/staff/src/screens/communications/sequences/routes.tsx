/**
 * Routes of the message template, sequence and schedule screens (SPK-COMMS-009, proposed
 * amendment PA-05; capability `message_sequences`), registered once in App.tsx before the area
 * placeholders. Route parameters are record ids only, never names or personal data (§4.14).
 */
import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { MessageScheduleScreen } from './MessageScheduleScreen';
import { MessageSequenceScreen, MessageSequencesScreen } from './MessageSequencesScreen';
import { MessageTemplateScreen, MessageTemplatesScreen } from './MessageTemplatesScreen';

const ROUTES: readonly [path: string, element: ReactElement][] = [
  ['/communications/templates', <MessageTemplatesScreen />],
  ['/communications/templates/:templateId', <MessageTemplateScreen />],
  ['/communications/sequences', <MessageSequencesScreen />],
  ['/communications/sequences/:sequenceId', <MessageSequenceScreen />],
  ['/communications/schedules/:subjectType/:subjectId', <MessageScheduleScreen />],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function messageSequenceRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </>
  );
}
