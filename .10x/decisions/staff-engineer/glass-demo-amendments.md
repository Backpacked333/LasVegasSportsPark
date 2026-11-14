# Staff engineer: glass-demo-amendments

Patterns every track follows (beyond `CLAUDE.md`, which governs):

- **Capability first.** A new command calls `capabilities.require(...)` inside its unit of work
  and its action declares `capability:`. A changed computation branches on `isEnabled` read once.
- **Ports, not tables.** Cross-module reads go through an exported port (`PolicyPort`,
  `MEMBERSHIP_PRICING_PORT`, existing lookups). No module queries another's tables.
- **Shared files are edited at integration only:** the capability lists, generated documents, the
  event handler manifest, `App.tsx` route registration, `navigation/areas.ts`,
  `navigation/destinations.ts`, root README tables. A track adds its routes in its own feature
  `routes.tsx` and lists what must be registered in its hand-off note.
- **Screens use the shared kit.** Staff: `PageHeader`, cards, `StatusBadge`, `FormFields`,
  `QueryBoundary`, `CommandButton`, `CapabilityGate`, tokens only. Mobile: `Screen`, `Card`,
  `ListRow`, `Button`, `StateView`, `makeStyles` and theme tokens only. No colour literal.
- **Wording.** Sentence case; state names as plain words; a pending rule is named with its
  decision record on staff screens, never invented.
- **Tests.** One test named after each requirement; one database test per integrity rule; the
  three gap journeys gain the on-path and keep the off-path; concurrency tests must pass under
  PostgreSQL as well as PGlite.
- **Docs.** Each module README states what is **Verified**, **Proposed**, **Pending decision**.
