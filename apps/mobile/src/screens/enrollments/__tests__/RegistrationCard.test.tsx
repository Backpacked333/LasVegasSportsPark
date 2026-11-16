/**
 * SCR-C-32 registration cards (PA-11, ADR-008 visual system v2): the picture `registrationArt`
 * picks for a registration, from the activity's kind when it was read, else the registration's
 * own kind, then the words in its name (`artworkFor`).
 */
import { activityArtwork } from '../../../artwork/manifest';
import { registrationArt } from '../RegistrationCard';

describe('SCR-C-32 registrationArt', () => {
  it('PA-11 ADR-008: the activity kind decides first, when the activity was read', () => {
    expect(registrationArt('youth', 'Summer week', { kind: 'camp' })).toBe(
      activityArtwork.camp.square,
    );
  });

  it("PA-11 ADR-008: without the activity, the registration's own kind decides", () => {
    expect(registrationArt('trial', 'Free first session')).toBe(activityArtwork.trial.square);
    expect(registrationArt('membership', 'Gold')).toBe(activityArtwork.membership.square);
    expect(registrationArt('party_request', 'Birthday')).toBe(activityArtwork.party.square);
    expect(registrationArt('pickup', 'Friday night')).toBe(activityArtwork.pickup.square);
  });

  it('PA-11 ADR-008: a youth program reads as youth; the name can say futsal or a mini class', () => {
    expect(registrationArt('youth', 'Autumn U10 League')).toBe(
      activityArtwork['soccer-youth'].square,
    );
    expect(registrationArt('individual_league', 'Adult futsal')).toBe(
      activityArtwork['futsal-indoor'].square,
    );
    expect(registrationArt('youth', 'Mini kickers')).toBe(activityArtwork['kids-class'].square);
    expect(registrationArt('individual_league', 'Sunday league', null, 'wide')).toBe(
      activityArtwork['soccer-league'].wide,
    );
  });
});
