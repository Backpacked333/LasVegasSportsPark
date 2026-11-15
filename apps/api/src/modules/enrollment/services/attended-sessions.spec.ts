import { describe, expect, it } from 'vitest';
import { attendedSessions, attendsSession, enrollmentAttendsSession } from './attended-sessions';

const SESSIONS = [{ id: 'mon' }, { id: 'tue' }, { id: 'wed' }];

describe('the sessions an enrollment attends (SPK-PAY-014, proposed amendment PA-03)', () => {
  it('SPK-PAY-014 (QA M-1): without a day selection an enrollment attends every session of its offering', () => {
    expect(attendedSessions(null, SESSIONS)).toEqual(SESSIONS);
    expect(attendedSessions(undefined, SESSIONS)).toEqual(SESSIONS);
    expect(attendsSession(null, 'tue')).toBe(true);
    expect(enrollmentAttendsSession({ selectedSessionIds: null }, 'tue')).toBe(true);
  });

  it('SPK-PAY-014 (QA M-1): with a day selection it attends exactly the sessions selected, in the offering order', () => {
    expect(attendedSessions(['wed', 'mon'], SESSIONS)).toEqual([{ id: 'mon' }, { id: 'wed' }]);
    expect(attendsSession(['wed', 'mon'], 'mon')).toBe(true);
    expect(attendsSession(['wed', 'mon'], 'tue')).toBe(false);
    expect(enrollmentAttendsSession({ selectedSessionIds: ['wed'] }, 'tue')).toBe(false);
    // A selected session the offering no longer lists is not attended anywhere.
    expect(attendedSessions(['gone'], SESSIONS)).toEqual([]);
  });
});
