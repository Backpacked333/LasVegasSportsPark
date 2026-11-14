# Product manager: glass-demo-amendments

Spec: `.10x/specs/2026-11-14-glass-demo-amendments-design.md`.

## Who it is for and what changes for them

| Person          | Today                                           | After                                                         |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Front desk      | Rings odd items as 1.00 lines; no waiver view   | Open-amount line with a category; waiver status at check-in   |
| Program manager | One price per term; camps priced in prose       | Per-session price, tiers, add-ons, member price, uniforms     |
| League manager  | A full division refuses a team; no public pages | Waiting list with offers; public standings; lobby display     |
| Communications  | Every message typed by hand                     | Templates and a dated sequence per season, confirmed by staff |
| Renter          | No list of who they bring                       | A roster with invitations and waiver status                   |
| Parent, player  | Full price mid-term; no waiver status           | Fair price shown with its reason; waiver signed once          |
| Anyone shown it | Empty screens                                   | Demo mode with a facility's worth of sample data and tours    |

## Success criteria

- Each amendment's requirement text (PA-01 to PA-10) is met with its switch on, and today's
  behaviour is unchanged with it off, both proven by tests.
- A person can walk every role's tour in demo mode without meeting an empty or broken screen.
- Every label on glass measures 4.5:1 or better in both themes; no screen loses readability.
- CI is green on the pull request.

## Scope cuts (not built)

Card surcharge, gift cards, stock counting for uniforms, automatic offer order for waiting teams,
live tournament displays beyond the bracket, any provider integration.
