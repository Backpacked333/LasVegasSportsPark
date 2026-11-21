/**
 * Handoff M 4d Message the coach: a pending decision (messaging API, open decision 8). The screen
 * starts with the game's card and shows quick replies and the message field as proposed, sending
 * nothing and showing no message that does not exist.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  CHILD,
  FIXTURE,
  fixtureDetail,
  HOME_ENTRY,
  me,
  names,
  ok,
  SELF_CAPTAIN,
  teamWorkspace,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { MessageCoachScreen, quickReplies } from '../MessageCoachScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

describe('handoff M 4d Message the coach (proposed)', () => {
  it('starts with the cancelled game, shows the composer as proposed and sends nothing', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me([{ subjectPersonId: CHILD, permissions: ['view'] }])),
        'GET /person-names': names({ [CHILD]: 'Maya' }),
        'GET /fixtures/{id}': ok(fixtureDetail({ status: 'canceled' })),
        'GET /team-entries/{id}': (req) =>
          req.params.id === HOME_ENTRY
            ? fakeResponse(200, {
                ...teamWorkspace('Desert Foxes U9', SELF_CAPTAIN),
                roster: [{ personId: CHILD }],
              })
            : fakeResponse(404, apiErrorBody('NOT_FOUND')),
      },
    });
    render(<MessageCoachScreen fixtureId={FIXTURE} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('message-event')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^Lions vs Tigers, cancelled, /),
    );
    expect(screen.getByText('Proposed')).toBeOnTheScreen();
    expect(await screen.findByText('Maya will be late')).toBeOnTheScreen();
    expect(screen.getByLabelText('Message, proposed: not available yet')).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Write to the desk' }));
    expect(mockPush).toHaveBeenLastCalledWith('/support');
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('quick replies name the child when there is one', () => {
    expect(quickReplies('Maya')[0]).toBe('Maya will be late');
    expect(quickReplies(null)[0]).toBe("We'll be late");
  });
});
