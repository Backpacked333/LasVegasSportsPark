/**
 * Handoff M 5a Welcome and sign in, M 5b the code and "is this your family?" (SPK-IAM-001,
 * SPK-UX-001, §4.13). The provider is a port (DEC-018): these tests drive a stand-in.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  contactKind,
  displayContact,
  resendWords,
  type CodeSignInPort,
} from '../../../features/sign-in/code-sign-in';
import { createTestApp } from '../../../testing/test-app';
import { WelcomeFlow, WRONG_CODE } from '../WelcomeFlow';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
}));
beforeEach(() => mockReplace.mockClear());

const SESSION = {
  token: 'token-1',
  expiresAt: '2026-10-25T12:00:00.000Z',
  accountId: '0192f1a0-0000-7000-8000-0000000000aa',
};

function port(): CodeSignInPort & { requested: string[]; checked: string[] } {
  const requested: string[] = [];
  const checked: string[] = [];
  return {
    hint: null,
    requested,
    checked,
    requestCode: async (contact) => {
      requested.push(contact);
      return { resendAfterSeconds: 41 };
    },
    verifyCode: async (_contact, code) => {
      checked.push(code);
      return code === '481052' ? { kind: 'signed_in', session: SESSION } : { kind: 'wrong' };
    },
  };
}

const household = (others: number) => ({
  status: 200,
  body: {
    items: [
      {
        id: '0192f1a0-0000-7000-8000-00000000a0f1',
        name: 'Ortiz household',
        members: [
          {
            personId: 'p-self',
            displayName: 'Dana Ortiz',
            kind: 'adult',
            label: null,
            isSelf: true,
          },
          ...(others > 0
            ? [
                {
                  personId: 'p-maya',
                  displayName: 'Maya Ortiz',
                  kind: 'child',
                  label: null,
                  isSelf: false,
                },
              ]
            : []),
        ],
        otherMemberCount: 0,
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
});

describe('handoff M 5a Welcome', () => {
  it('one field for phone or email; "Send me a code" is active once it looks like one; Apple and Google are proposed', async () => {
    const app = createTestApp({ session: null });
    const p = port();
    render(<WelcomeFlow port={p} />, { wrapper: app.wrapper });
    const send = screen.getByRole('button', { name: 'Send me a code' });
    expect(send).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText('Phone or email'), '702 555');
    expect(send).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText('Phone or email'), '(702) 555-0148');
    expect(screen.getByRole('button', { name: 'Send me a code' })).toBeEnabled();
    expect(screen.getByLabelText('Apple, proposed: not available yet')).toBeDisabled();
    expect(screen.getByLabelText('Google, proposed: not available yet')).toBeDisabled();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Send me a code' })));
    expect(p.requested).toEqual(['(702) 555-0148']);
    expect(await screen.findByRole('header', { name: 'Check your texts' })).toBeOnTheScreen();
    expect(screen.getByText('We sent a 6-digit code to (702) 555-0148.')).toBeOnTheScreen();
    expect(screen.getByText('Resend in 0:41')).toBeOnTheScreen();
  });

  it('pure parts: what looks like a phone or an email', () => {
    expect(contactKind('dana@example.com')).toBe('email');
    expect(contactKind('(702) 555-0148')).toBe('phone');
    expect(contactKind('+1 702 555 0148')).toBe('phone');
    expect(contactKind('702-555')).toBeNull();
    expect(contactKind('dana@')).toBeNull();
    expect(displayContact('7025550148')).toBe('(702) 555-0148');
    expect(resendWords(41)).toBe('0:41');
    expect(resendWords(61)).toBe('1:01');
  });
});

describe('handoff M 5b code and family', () => {
  async function toCode(p: CodeSignInPort, routes = {}) {
    const app = createTestApp({ session: null, routes });
    render(<WelcomeFlow port={p} />, { wrapper: app.wrapper });
    fireEvent.changeText(screen.getByLabelText('Phone or email'), 'dana@example.com');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Send me a code' })));
    expect(await screen.findByRole('header', { name: 'Check your email' })).toBeOnTheScreen();
    return app;
  }

  it('checks itself on the 6th digit; a wrong code clears the boxes and says so', async () => {
    const p = port();
    await toCode(p);
    const input = screen.getByLabelText('Code, 6 digits');
    fireEvent.changeText(input, '12345');
    expect(p.checked).toEqual([]);
    await act(async () => fireEvent.changeText(input, '123456'));
    expect(p.checked).toEqual(['123456']);
    expect(await screen.findByText(WRONG_CODE)).toBeOnTheScreen();
    expect(screen.getByLabelText('Code, 6 digits')).toHaveProp('value', '');
  });

  it('the right code signs in; a family the desk knows is offered as "We found your family"', async () => {
    const p = port();
    const app = await toCode(p, { 'GET /me/households': household(1) });
    await act(async () => fireEvent.changeText(screen.getByLabelText('Code, 6 digits'), '481052'));
    expect(
      await screen.findByRole('header', { name: 'We found your family at the park' }),
    ).toBeOnTheScreen();
    expect((await app.sessionStore.load())?.token).toBe('token-1');
    expect(screen.getByText('Maya Ortiz')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: "Yes, that's us" }));
    expect(mockReplace).toHaveBeenLastCalledWith('/');
    fireEvent.press(screen.getByRole('button', { name: "Something's wrong" }));
    expect(mockReplace).toHaveBeenLastCalledWith('/support');
  });

  it('a new family goes on to Add a child', async () => {
    const p = port();
    await toCode(p, { 'GET /me/households': household(0) });
    await act(async () => fireEvent.changeText(screen.getByLabelText('Code, 6 digits'), '481052'));
    await waitFor(() => expect(mockReplace).toHaveBeenLastCalledWith('/people/new'));
  });
});
