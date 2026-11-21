# Redesign handoff (parent app and staff app)

The designer's handoff for the redesign of `apps/mobile` and `apps/staff`, kept here as the
reference the implementation follows. These files are **design input, not specification**: where
they disagree with `docs/spec/master-specification.md`, the specification wins and the difference
is recorded in the app README.

- `README.md`: overview, tokens, global behaviour, open decisions.
- `BUILD_PLAN.md`: phases 0 to 8 and their acceptance checks.
- `SCREENS.md`: every screen id with the designer's notes.
- `INTERACTIONS.md`: per-control behaviour. Endpoints it tags "to build" are the designer's
  proposals; the implementation uses the existing API where an equivalent exists.

The HTML boards (`Mobile Redesign.dc.html`, `Staff Redesign.dc.html`, the parent prototype and
the interaction spec page) are not committed: they embed stock placeholder photos that must not
ship. They are in the handoff archive the product owner supplied.
