/**
 * What the parent-app redesign shows that depends on an open decision (redesign handoff README
 * "Open decisions"; §6.7 wording). One switch per item, read by the screens; flipping one is the
 * whole change once the decision is recorded. Nothing here fakes data: a switch that is off hides
 * the control (where INTERACTIONS says "hidden until the decision") or shows it in the purple
 * "Proposed" state.
 *
 * - `maybeAnswer`: "Maybe" as a game answer (handoff DEC-021; decision register DEC-064). The API
 *   already records `tentative` (`POST /v1/fixtures/{id}/availability`), so the design's control
 *   is offered as drawn: **Proposed behaviour**, **Pending decision** DEC-064.
 * - `guardianAnswers`: a parent answering for a child ("Is Maya going?"). The API lets a guardian
 *   holding `register` answer (the engineering mapping recorded under DEC-090): **Proposed
 *   behaviour**, **Pending decision** DEC-090.
 * - `instalments`: "3 × $40" on the Pay sheet (handoff open decision 2). No price rule states an
 *   instalment option to a customer, so the control is hidden: **Pending decision**.
 * - `wallet`: "Add to Wallet" on the pass (DEC-023): hidden, **Pending decision**.
 * - `playersNeeded`: "Enough to play" on Game day needs a players-needed figure per game (handoff
 *   open decision 6): hidden, **Pending decision**.
 * - `teamChat`: "Team chat" on Game day needs a messaging API (handoff open decision 8): shown as
 *   a disabled "Proposed" control, **Pending decision**.
 */
export const PROPOSED = {
  maybeAnswer: true,
  guardianAnswers: true,
  instalments: false,
  wallet: false,
  playersNeeded: false,
  teamChat: false,
} as const;
