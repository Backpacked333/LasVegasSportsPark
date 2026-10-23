# Contributing

1. Read `CLAUDE.md` (engineering conventions) and the relevant section of
   `docs/spec/master-specification.md`.
2. Branch from `main`; one module or one concern per pull request.
3. Run `pnpm verify` before pushing. CI runs the same checks plus the test suite against a
   PostgreSQL service.
4. Pull request description: requirement ids, policy decisions relied on (link the decision
   register), customer and staff behaviour, permissions, failure and recovery behaviour, acceptance
   evidence (tests), release dependency (spec §1.5).
5. Migrations are immutable once merged; add a new numbered file in your module's range.
6. Regenerate `docs/api/openapi.json` (`pnpm build && pnpm openapi`) when API contracts change.
