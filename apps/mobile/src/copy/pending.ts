/**
 * What a customer can do while a screen or value waits on an operator decision (PA-11,
 * SPK-UX-011 **Proposed**: "says what the customer can do instead, never only that a decision is
 * pending"). One plain message per decision or policy a customer can meet in the app: the
 * `pending-decision` states, the turned-off states of the capabilities customer screens use
 * (K-12, DEC-016 and each capability's own record) and the codes still written into screen text.
 * The decision itself stays in the "Details for support" fold.
 *
 * Each message is an instruction for now, and invents no rule the decision has not settled: it
 * sends the customer to the front desk, the team manager or the inbox, or to what the app already
 * shows. Screens pass it as the `message` of a `pending-decision` StateView.
 */

/** Said when a decision has no message of its own (the same words as StateView's fallback). */
export const PENDING_FALLBACK = "This isn't available in the app yet.";

/** Decision or policy id → what the customer can do now. */
export const PENDING_MESSAGES: Readonly<Record<string, string>> = {
  // Competition rules (DEC-002) and payment approval (DEC-028): team readiness.
  'DEC-002': "Ask the front desk about your league's rules and forms.",
  'DEC-028': 'Ask the front desk when this payment will be taken.',
  // Youth age bands: filtering Explore by age.
  'DEC-003': 'Check the age range on each activity before you register.',
  // Guardian and child-account policy: adding a child, other adults' permissions.
  'DEC-004': 'Ask the front desk to make this change for you.',
  // Pickup procedure and supervised pickup.
  'DEC-005': 'Tell the front desk who is collecting your child.',
  'DEC-075': 'Tell the front desk who is collecting your child.',
  // Team billing model and overpayments.
  'DEC-008': 'Ask the front desk how payments for your team work.',
  'POL-015': 'Ask the front desk if you paid more than you owe.',
  // Discipline and appeals.
  'DEC-010': 'Ask the front desk how to make an appeal.',
  // Support coverage: no support phone, email or hours yet.
  'DEC-015': 'For help, ask at the front desk.',
  // Whether the facility uses a conditional capability at all.
  'DEC-016': 'Ask the front desk whether the facility offers this.',
  // Identity provider: sign-in, recovery, verifying an email or phone.
  'DEC-018': 'Ask the front desk to help with your account for now.',
  // Payment processor: paying, paying again, the provider's own step.
  'DEC-019': 'Pay at the front desk for now.',
  // Messaging providers, device permissions and channels: push notifications.
  'DEC-020': 'Check your inbox in the app for notices.',
  'DEC-061': 'You can carry on without them. Check your inbox in the app for notices.',
  'DEC-062': 'Check your inbox in the app for notices.',
  // Hardware: a scannable pass code.
  'DEC-023': 'Give your name at the front desk when you arrive.',
  // Booking requests: whether approval reserves the time, deposits before approval.
  'DEC-029': 'Send your request and wait for the facility to approve it.',
  'DEC-030': 'Ask the front desk whether a deposit is needed.',
  // Placement model and placement information.
  'DEC-031': 'Ask the front desk how teams and groups are chosen.',
  'DEC-051': 'Tell the front desk anything the coaches should know.',
  // Youth feedback and progression.
  'DEC-054': "Ask the coach or the front desk about your child's progress.",
  'DEC-055': 'Ask the coach or the front desk which group suits your child next.',
  // Credit expiry.
  'DEC-058': 'Ask the front desk when your credit expires.',
  // RSVP: the "tentative" answer, and answering for a child.
  'DEC-064': 'Answer Available or Unavailable for now.',
  'DEC-090': 'Tell your team manager whether your child can come.',
  // Delegated permissions over a child.
  'DEC-089': 'Ask the front desk to change this for you.',
  // Membership benefits, booking terms, invitation expiry, arrival guidance.
  'POL-038': 'Ask the front desk what your membership includes.',
  'POL-040': 'Ask the front desk to book this for you.',
  'POL-044': 'Check the invitation for the date it closes.',
  'POL-046': 'Check in at the front desk when you arrive.',
  // Capabilities customer screens use, while the organization has them turned off.
  'DEC-072': 'Ask the front desk about memberships.',
  'DEC-073': 'Ask the front desk about paying in parts.',
  'DEC-074': 'Ask the front desk about class packs.',
  'DEC-076': 'Ask the front desk to book a rental.',
  'DEC-077': 'Ask the front desk to book a party.',
  'DEC-078': 'Ask the front desk about tournaments.',
  'DEC-079': 'Ask the front desk for your receipt.',
  'DEC-082': 'Ask the front desk about drop-in pickup games.',
  'DEC-095': 'Sign the waiver at the front desk.',
  'DEC-097': 'Ask the front desk about prices and extras.',
  'DEC-101': 'Ask the front desk about uniforms.',
  'DEC-103': 'Ask the front desk to add players to your rental.',
};

/** What the customer can do while `decision` (a DEC-### or POL-### id) is open. */
export function pendingMessage(decision: string): string {
  return PENDING_MESSAGES[decision.trim()] ?? PENDING_FALLBACK;
}

/**
 * The message for a state that names several decisions: the first with a message of its own,
 * skipping DEC-016 when a capability's own record follows it (["DEC-016", "DEC-072"] gives the
 * memberships message).
 */
export function pendingMessageFor(decisions: readonly string[]): string {
  const specific = decisions.filter((d) => d !== 'DEC-016');
  for (const decision of [...specific, ...decisions]) {
    const message = PENDING_MESSAGES[decision.trim()];
    if (message) return message;
  }
  return PENDING_FALLBACK;
}
