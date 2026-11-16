# Staff engineer: index

## Discovered conventions [DISCOVERED]

- `CLAUDE.md` is the engineering rulebook: command pattern, data rules, tests, boundaries.
- Requirements are cited by id (`SPK-*`, `§`) in comments, tests and commit messages.
- Generated registration files are rewritten by `scripts/regenerate-registrations.mjs`.
- CI: format, lint, typecheck, tests on PGlite and PostgreSQL, OpenAPI and client currency,
  container image, staff browser smoke, both mobile exports.

## Features

- `customer-redesign`: `customer-redesign.md` (ADR-008, PA-11; customer app visual system v2).
- `glass-demo-amendments`: see `glass-demo-amendments.md`.
