-- Capability switches for the ten proposed amendments of the legacy-parity review (PA-01 to PA-10;
-- docs/package-a/proposed-specification-amendments.md). Each is off until a system administrator
-- turns it on, naming DEC-016 or the amendment's own decision record (DEC-095 to DEC-104). The two
-- checks of 0011 are replaced by the same checks over the longer catalogue; nothing else changes.

alter table organization_capabilities
  drop constraint organization_capabilities_capability_check;
alter table organization_capabilities
  add constraint organization_capabilities_capability_check check (capability in (
    'memberships',
    'session_packages',
    'rentals',
    'parties',
    'tournaments',
    'point_of_sale',
    'access_hardware',
    'accounting',
    'youth_progression',
    'pickup_sessions',
    'assistant',
    'installments',
    'supervised_pickup',
    'advanced_fairness',
    'retention_tools',
    'liability_waivers',
    'per_session_pricing',
    'price_tiers_addons',
    'member_pricing',
    'message_sequences',
    'public_schedule',
    'uniforms',
    'open_amount_lines',
    'rental_rosters',
    'team_waitlist'
  ));

alter table organization_capabilities
  drop constraint organization_capabilities_applicability;
alter table organization_capabilities
  add constraint organization_capabilities_applicability check (
    decision_reference = 'DEC-016'
      or (capability = 'memberships' and decision_reference = 'DEC-072')
      or (capability = 'session_packages' and decision_reference = 'DEC-074')
      or (capability = 'rentals' and decision_reference = 'DEC-076')
      or (capability = 'parties' and decision_reference = 'DEC-077')
      or (capability = 'tournaments' and decision_reference = 'DEC-078')
      or (capability = 'point_of_sale' and decision_reference = 'DEC-079')
      or (capability = 'access_hardware' and decision_reference = 'DEC-080')
      or (capability = 'accounting' and decision_reference = 'DEC-081')
      or (capability = 'pickup_sessions' and decision_reference = 'DEC-082')
      or (capability = 'installments' and decision_reference = 'DEC-073')
      or (capability = 'supervised_pickup' and decision_reference = 'DEC-075')
      or (capability = 'liability_waivers' and decision_reference = 'DEC-095')
      or (capability = 'per_session_pricing' and decision_reference = 'DEC-096')
      or (capability = 'price_tiers_addons' and decision_reference = 'DEC-097')
      or (capability = 'member_pricing' and decision_reference = 'DEC-098')
      or (capability = 'message_sequences' and decision_reference = 'DEC-099')
      or (capability = 'public_schedule' and decision_reference = 'DEC-100')
      or (capability = 'uniforms' and decision_reference = 'DEC-101')
      or (capability = 'open_amount_lines' and decision_reference = 'DEC-102')
      or (capability = 'rental_rosters' and decision_reference = 'DEC-103')
      or (capability = 'team_waitlist' and decision_reference = 'DEC-104')
  );
