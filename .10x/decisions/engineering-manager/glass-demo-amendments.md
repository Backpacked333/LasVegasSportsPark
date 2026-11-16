# Engineering manager: glass-demo-amendments

Machine limits (4 cores, 15 GB) allow three build-and-test tracks at once. Each track works in its
own git worktree on its own branch, commits there, and is merged at the end of its wave.

| Wave | Tracks (parallel)                                                | Then                          |
| ---- | ---------------------------------------------------------------- | ----------------------------- |
| 0    | Foundation: merge `main`, capabilities, state files              | Base commit for all worktrees |
| 1    | A (PA-02, PA-04) · B (PA-01, PA-09) · C (PA-10, PA-06) · H glass | Integration 1                 |
| 2    | D (PA-03, PA-07) · E (PA-05) · F (PA-08) · H mobile glass        | Integration 2                 |
| 3    | G (demo mode, dataset, tours)                                    | Integration 3                 |
| 4    | Verification (tests, security review, browser pass)              | Delivery notes, pull request  |

Integration after each wave: merge the track branches, run
`node scripts/regenerate-registrations.mjs`, register routes and navigation, merge the event
handler manifest, regenerate the OpenAPI document, the client paths and the permission matrix,
then `pnpm verify`, the staff build and both mobile exports.

Risks and how they are held:

- **Shared files collide.** Tracks do not edit them (staff engineer notes); integration does.
- **Track D depends on A.** It starts from Integration 1.
- **A track runs out of room.** Each track brief is self-contained and names its files; a second
  agent can continue from the track branch and its hand-off note.
- **CI time.** The full API suite takes about 20 minutes; tracks run their module's tests, the
  full suite runs at integration.
