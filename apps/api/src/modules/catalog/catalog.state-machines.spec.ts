import { describe, expect, it } from 'vitest';
import { requiredStaffFor, staffingIncreaseNeedsReason } from './catalog.policy';
import {
  DiscountMachine,
  EDITABLE_PUBLICATION_STATES,
  OfferingPublicationMachine,
  OfferingSessionMachine,
  PolicyVersionMachine,
  ProgramMachine,
} from './catalog.state-machines';

describe('catalog lifecycles (§4.6)', () => {
  it('SPK-CAT-004: publication, registration and closure are distinct steps; archive is terminal', () => {
    const m = OfferingPublicationMachine;
    expect(m.next('draft', 'publish')).toBe('published');
    expect(m.can('draft', 'open_registration')).toBe(false);
    expect(m.next('published', 'open_registration')).toBe('registration_open');
    expect(m.next('registration_open', 'pause_registration')).toBe('registration_paused');
    expect(m.next('registration_paused', 'resume_registration')).toBe('registration_open');
    expect(m.can('registration_paused', 'open_registration')).toBe(false);
    expect(m.next('registration_open', 'close')).toBe('closed');
    expect(m.next('registration_paused', 'close')).toBe('closed');
    expect(m.next('published', 'close')).toBe('closed');
    expect(m.next('closed', 'archive')).toBe('archived');
    expect(m.next('draft', 'archive')).toBe('archived');
    expect(m.can('registration_open', 'archive')).toBe(false);
    expect(m.isTerminal('archived')).toBe(true);
    expect(() => m.next('archived', 'publish')).toThrow(/cannot publish from archived/);
    expect(EDITABLE_PUBLICATION_STATES).toEqual([
      'draft',
      'published',
      'registration_open',
      'registration_paused',
    ]);
  });

  it('§4.4 PolicyVersion: draft → approved → retired, nothing else', () => {
    expect(PolicyVersionMachine.next('draft', 'approve')).toBe('approved');
    expect(PolicyVersionMachine.next('approved', 'retire')).toBe('retired');
    expect(PolicyVersionMachine.can('draft', 'retire')).toBe(false);
    expect(PolicyVersionMachine.can('approved', 'approve')).toBe(false);
    expect(PolicyVersionMachine.eventsFrom('retired')).toEqual([]);
  });

  it('programs, sessions and discounts have the documented lifecycles', () => {
    expect(ProgramMachine.next('draft', 'activate')).toBe('active');
    expect(ProgramMachine.next('active', 'archive')).toBe('archived');
    expect(ProgramMachine.can('archived', 'activate')).toBe(false);
    expect(OfferingSessionMachine.next('scheduled', 'cancel')).toBe('canceled');
    expect(OfferingSessionMachine.next('scheduled', 'complete')).toBe('completed');
    expect(OfferingSessionMachine.can('canceled', 'complete')).toBe(false);
    expect(DiscountMachine.next('draft', 'activate')).toBe('active');
    expect(DiscountMachine.next('draft', 'retire')).toBe('retired');
    expect(DiscountMachine.next('active', 'retire')).toBe('retired');
    expect(DiscountMachine.can('retired', 'activate')).toBe(false);
  });
});

describe('SPK-YOUTH-002 staffing requirement', () => {
  it('derives the required staff from the units that carry a ratio', () => {
    expect(requiredStaffFor([{ unit: 'seats', limit: 40 }])).toBe(0);
    expect(
      requiredStaffFor([
        {
          unit: 'camp_group_places',
          limit: 25,
          groupSize: 12,
          staffingRatio: { participantsPerStaff: 12 },
        },
        { unit: 'seats', limit: 40 },
      ]),
    ).toBe(3);
  });

  it('SPK-YOUTH-002: a capacity increase that raises the requirement, or removes or relaxes a ratio, needs a reason; a plain decrease never does', () => {
    const before = [
      {
        unit: 'camp_group_places' as const,
        limit: 24,
        staffingRatio: { participantsPerStaff: 12 },
      },
    ];
    expect(staffingIncreaseNeedsReason(before, [{ ...before[0]!, limit: 36 }])).toEqual({
      requiredStaffBefore: 2,
      requiredStaffAfter: 3,
      ratiosRelaxed: [],
      needsReason: true,
    });
    expect(staffingIncreaseNeedsReason(before, [{ ...before[0]!, limit: 12 }]).needsReason).toBe(
      false,
    );
    // swapping the staffed unit for an unstaffed one lowers the computed requirement, but it
    // removes the staffing requirement and is never silent
    expect(staffingIncreaseNeedsReason(before, [{ unit: 'seats', limit: 100 }])).toEqual({
      requiredStaffBefore: 2,
      requiredStaffAfter: 0,
      ratiosRelaxed: ['camp_group_places'],
      needsReason: true,
    });
    const { staffingRatio: _dropped, ...unrated } = before[0]!;
    expect(staffingIncreaseNeedsReason(before, [{ ...unrated, limit: 200 }]).ratiosRelaxed).toEqual(
      ['camp_group_places'],
    );
    expect(
      staffingIncreaseNeedsReason(before, [
        { ...before[0]!, limit: 24, staffingRatio: { participantsPerStaff: 24 } },
      ]),
    ).toMatchObject({
      requiredStaffAfter: 1,
      ratiosRelaxed: ['camp_group_places'],
      needsReason: true,
    });
    // a tighter ratio is not a relaxation
    expect(
      staffingIncreaseNeedsReason(before, [
        { ...before[0]!, limit: 12, staffingRatio: { participantsPerStaff: 6 } },
      ]).needsReason,
    ).toBe(false);
  });
});
