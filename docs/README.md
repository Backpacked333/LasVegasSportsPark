# Documentation index

| Document                                                     | Purpose                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [spec/master-specification.md](spec/master-specification.md) | Master specification v2.0 (source of truth)                                                                                                                                                                                              |
| [architecture/overview.md](architecture/overview.md)         | Engineering architecture, kernel, module map, data and testing conventions                                                                                                                                                               |
| [package-a/](package-a/)                                     | Package A artifacts: requirement cross-reference, role/permission matrix, decision register, integration register, authority matrix, journeys, acceptance fixtures, metric dictionary, native acceptance matrix, release evidence ledger |
| [api/openapi.json](api/openapi.json)                         | Generated OpenAPI 3.1 document (`pnpm build && pnpm openapi`)                                                                                                                                                                            |
| [runbooks/](runbooks/)                                       | Operational runbooks (cutover, recovery, outage procedures)                                                                                                                                                                              |

Every document marks its statements as **verified** (implemented and tested in this repository),
**proposed** (engineering proposal awaiting operator approval), or **pending decision** (owner named
in the decision register). "No answer yet" never means "not applicable" (spec §6.6).
