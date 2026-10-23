# Facility inventory

Status legend: **Verified** = implemented and tested in this repository today (file cited). **Proposed** = engineering proposal from the specification or from this document, awaiting operator approval. **Pending decision** = needs an operator answer; the owner is named from specification §6.6. "No answer yet" never becomes "not applicable" (§6.6).

Last derived from specification v2.0 (2026-10-22). Source: `docs/spec/master-specification.md` (repository copy supplied 2026-10-23).

This is the Package A "Facility inventory" deliverable (§6.5). It is the template for the physical inventory required by SPK-SCHED-001 (§3.7) and the answer sheet for the first row of the §6.6 operator decisions table: "Actual facilities, spaces, subdivisions, hours", owner Operations, to be resolved before "Scheduling acceptance". Decision record: DEC-001 in `decision-register.md`. Companion documents: `../runbooks/cutover.md` section 9 (loading the inventory at cutover), `requirement-cross-reference.md` (SPK-SCHED-001 to SPK-SCHED-009), `acceptance-fixtures.md` (SPK-AT-008, SPK-AT-009, SPK-AT-021).

## 1. Status of this inventory

**This inventory is empty. Pending decision: Operations (DEC-001).**

| Statement                                                                                                                                                                                                                                                                                                                                       | Status                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| No facility, pitch, dimension, configuration, operating hour, closure, buffer, equipment item or staffing constraint of the complex is recorded in this repository. Every table in sections 3 to 10 has zero real rows.                                                                                                                         | **Pending decision** (DEC-001, Operations)                                                                                      |
| The rows labelled "EXAMPLE (synthetic)" are illustrations of the shape of a filled row. Their values are invented for illustration or copied from automated test fixtures. They describe no real facility and must be deleted before Operations signs the inventory.                                                                            | Synthetic; not a facility fact                                                                                                  |
| The database tables and API fields that will hold the inventory exist and are tested, so Operations' answers can be loaded without further schema work for the SPK-SCHED-001 items marked **Verified** in section 2.                                                                                                                            | **Verified** (`packages/db/migrations/0300_scheduling_core.sql`; `apps/api/src/modules/scheduling/__tests__/resources.spec.ts`) |
| The "original platform specification" (`.docx`, §1.3 item 1) and the "existing local demonstration" (§1.4) are not in this repository. §1.4 states that the demo's "Resource model" is simplified and must be replaced, and that its synthetic names and capacities "are examples, not approved policies". Nothing here is derived from either. | Statement of fact about the repository                                                                                          |
| DaySmart holds the facility's current configuration (§1.2) but is not accessible from this repository; the inventory must be collected from Operations, not inferred from an export.                                                                                                                                                            | **Pending decision** (DEC-014 for any extraction)                                                                               |

## 2. What SPK-SCHED-001 requires and where each item is stored

| SPK-SCHED-001 item                        | Section | Table and column (migration 0300 unless noted)                                                                                                                                              | API field (`packages/contracts/src/api/scheduling.ts`)                                      | Status                                                                                                                                                                                      |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facility                                  | 3       | `facilities` (`0001_core_schema.sql`): `slug`, `name`, `timezone` (IANA), `address`, `status`                                                                                               | Not exposed by an endpoint yet (seeded; `seedOrganization` in `packages/db/src/testing.ts`) | **Verified** table; facility administration endpoint **Proposed**                                                                                                                           |
| Pitch or other space                      | 4       | `resources`: `kind` in `pitch`, `subdivision`, `room`, `other`; `name`; `status` in `active`, `restricted`, `closed`                                                                        | `POST /v1/resources` `kind`, `name`, `status`                                               | **Verified** (`resources.spec.ts` "creates a pitch, its subdivisions and the unit mapping")                                                                                                 |
| Dimensions or supported configurations    | 4, 5    | `resources.dimensions` (free-form JSON); `resource_configurations` with `resource_configuration_members`                                                                                    | `dimensions` (record); `POST /v1/resource-configurations`                                   | **Verified** storage; the JSON shape of `dimensions` is **Proposed** (section 4 proposes `lengthM`, `widthM`, `surface`, `indoor`)                                                          |
| Whole-space and subdivision relationships | 4, 5    | `resources.parent_resource_id` (a subdivision always has a parent, check constraint); `conflict_units` and `resource_conflict_units` (a whole pitch maps to all of its subdivisions' units) | `parentResourceId`; `conflictUnitIds`                                                       | **Verified** (`schema-invariants.spec.ts` "a whole-pitch reservation conflicts with any overlapping half-pitch reservation", "two halves of the same pitch may be reserved simultaneously") |
| Compatible activity formats               | 4       | `resources.compatible_formats` (text array)                                                                                                                                                 | `compatibleFormats`                                                                         | **Verified** storage; the format vocabulary (for example `11v11`, `7v7`, `5v5`) is **Pending decision** (DEC-002, League manager: "Soccer formats and competition rules")                   |
| Operating hours                           | 6       | `operating_hours`: `weekday` 0 to 6 (0 = Sunday), `opens_at`, `closes_at` facility-local; `resource_id` null = whole facility                                                               | `POST /v1/operating-hours` `weekday`, `opensAt`, `closesAt`, optional `resourceId`          | **Verified** (`resources.spec.ts` "operating hours are windows per weekday"); overlapping windows are not constrained (scheduling README "Known gaps")                                      |
| Closures                                  | 7       | `closures`: `during` (tstzrange), `reason`, `source` in `manual`, `maintenance`, `holiday`, `resource_id` null = whole facility                                                             | `POST /v1/closures`, `/apply`, `/lift`                                                      | **Verified** (`closures.spec.ts`)                                                                                                                                                           |
| Setup and cleanup requirements            | 8       | `resources.default_setup_minutes`, `default_cleanup_minutes`; per event `events.setup_minutes`, `cleanup_minutes`; buffers are inside the occupied interval                                 | `defaultSetupMinutes`, `defaultCleanupMinutes`                                              | **Verified** (`schema-invariants.spec.ts` "buffers make 19:00 to 20:00 conflict with a game ending 19:00 that has a ten-minute cleanup")                                                    |
| Required equipment                        | 9       | `resources.required_equipment` (JSON array)                                                                                                                                                 | `requiredEquipment`                                                                         | **Verified** storage; descriptive only until the facilities module owns equipment assets (scheduling README "Known gaps"; `apps/api/src/modules/facilities/README.md` scaffold)             |
| Applicable staffing constraints           | 10      | `resources.staffing_constraints` (JSON object)                                                                                                                                              | `staffingConstraints`                                                                       | **Verified** storage; stored but not validated (scheduling README "Known gaps"); the workforce module is a scaffold                                                                         |

## 3. Facilities

Fill one row per physical site. `timezone` must be an IANA zone name because every event instant is stored in UTC and displayed in the facility zone (SPK-SCHED-008; **Verified** `facilities.timezone`, `events.timezone`).

| Facility name                        | Slug              | IANA timezone | Address | Status (`active`, `closed`, `archived`) | Answer status | Named owner | Effective date | Supporting evidence                             |
| ------------------------------------ | ----------------- | ------------- | ------- | --------------------------------------- | ------------- | ----------- | -------------- | ----------------------------------------------- |
| [ ]                                  | [ ]               | [ ]           | [ ]     | [ ]                                     | unknown       | Operations  | [ ]            | [ ]                                             |
| EXAMPLE (synthetic): Example Complex | `example-complex` | `Etc/UTC`     | [none]  | `active`                                | synthetic     | none        | none           | This row is an illustration and must be deleted |

## 4. Pitches and other spaces

One row per resource. A subdivision must name its parent. `dimensions` is stored as free-form JSON; the keys below are **Proposed** so that Operations fills comparable values. Compatible formats use the vocabulary the league manager approves (DEC-002).

| Resource name                      | Kind (`pitch`, `subdivision`, `room`, `other`) | Parent resource | Dimensions: length (m) | Dimensions: width (m) | Surface   | Indoor or outdoor | Compatible formats | Status (`active`, `restricted`, `closed`) | Answer status | Named owner | Effective date |
| ---------------------------------- | ---------------------------------------------- | --------------- | ---------------------- | --------------------- | --------- | ----------------- | ------------------ | ----------------------------------------- | ------------- | ----------- | -------------- |
| [ ]                                | [ ]                                            | [ ]             | [ ]                    | [ ]                   | [ ]       | [ ]               | [ ]                | [ ]                                       | unknown       | Operations  | [ ]            |
| [ ]                                | [ ]                                            | [ ]             | [ ]                    | [ ]                   | [ ]       | [ ]               | [ ]                | [ ]                                       | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Pitch 3       | `pitch`                                        | none            | 100                    | 64                    | [unknown] | [unknown]         | `11v11`            | `active`                                  | synthetic     | none        | none           |
| EXAMPLE (synthetic): Pitch 3 north | `subdivision`                                  | Pitch 3         | [unknown]              | [unknown]             | [unknown] | [unknown]         | `7v7`              | `active`                                  | synthetic     | none        | none           |
| EXAMPLE (synthetic): Pitch 3 south | `subdivision`                                  | Pitch 3         | [unknown]              | [unknown]             | [unknown] | [unknown]         | `7v7`              | `active`                                  | synthetic     | none        | none           |

The three example rows reproduce the shape of the automated test fixture in `apps/api/src/modules/scheduling/__tests__/resources.spec.ts` ("Pitch 3", 100 by 64, `11v11`, two halves `7v7`). They are test data, not facility facts, and must be deleted before sign-off.

## 5. Physical arrangements (configurations) and shared conflict units

SPK-SCHED-002: "Two compatible subdivisions may operate simultaneously only when the configured physical arrangement permits it." A configuration names the set of resources that may operate at the same time (**Verified** `resource_configurations`; `resources.spec.ts` "configurations name which resources may operate simultaneously"). A conflict unit is an atomic physical area; a whole space maps to all units of its subdivisions (**Verified**). Fill one row per arrangement, and one row per conflict unit that is shared in a way the parent relationship does not already express (for example two pitches that share a run-off area).

| Arrangement name                    | Resources that may operate simultaneously | Description                | Active | Answer status | Named owner | Effective date |
| ----------------------------------- | ----------------------------------------- | -------------------------- | ------ | ------------- | ----------- | -------------- |
| [ ]                                 | [ ]                                       | [ ]                        | [ ]    | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Pitch 3 full   | Pitch 3                                   | Whole pitch in use         | yes    | synthetic     | none        | none           |
| EXAMPLE (synthetic): Pitch 3 halves | Pitch 3 north, Pitch 3 south              | Two 7v7 games side by side | yes    | synthetic     | none        | none           |

| Shared conflict unit name | Resources that occupy it | Why it is shared                                                                      | Answer status | Named owner | Effective date |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------- | ------------- | ----------- | -------------- |
| [ ]                       | [ ]                      | [ ]                                                                                   | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): none | none                     | Illustration only: most facilities need no shared unit beyond the parent relationship | synthetic     | none        | none           |

## 6. Operating hours

One row per weekday window. Times are facility-local (`facilities.timezone`). A row without a resource applies to the whole facility; a resource without its own rows inherits the facility window (**Verified** `operating_hours.resource_id` null semantics; `CreateOperatingHoursBody` comment). Weekday 0 is Sunday. Whether hours vary by season is not stated in the specification (section 12, item 2).

| Facility                             | Resource (blank = whole facility) | Weekday (0 to 6) | Opens at (local) | Closes at (local) | Applies from | Applies until | Answer status | Named owner | Effective date |
| ------------------------------------ | --------------------------------- | ---------------- | ---------------- | ----------------- | ------------ | ------------- | ------------- | ----------- | -------------- |
| [ ]                                  | [ ]                               | [ ]              | [ ]              | [ ]               | [ ]          | [ ]           | unknown       | Operations  | [ ]            |
| [ ]                                  | [ ]                               | [ ]              | [ ]              | [ ]               | [ ]          | [ ]           | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Example Complex | (whole facility)                  | 1                | 08:00            | 22:00             | [unknown]    | [unknown]     | synthetic     | none        | none           |

"Applies from" and "Applies until" are **Proposed** columns for seasonal variation; the `operating_hours` table has no date range today, so seasonal hours would be loaded as replacements at the change date or need a schema addition (section 12).

## 7. Closures

One row per known closure: public holidays, planned maintenance, events that take the whole facility. Intervals are facility-local here and stored as UTC ranges (**Verified** `closures.during`). A closure's impact on games, programs, rentals, staff and customers is computed by the scheduling module (SPK-SCHED-009; **Verified** `closures.spec.ts` "the preview names every affected game, program and rental"); its effect on financial obligations and messages is resolved by finance and communications (**Proposed**, scaffolds).

| Facility                             | Resource (blank = whole facility) | Starts (local) | Ends (local) | Reason            | Source (`manual`, `maintenance`, `holiday`) | Recurring (yes/no and rule) | Answer status | Named owner | Effective date |
| ------------------------------------ | --------------------------------- | -------------- | ------------ | ----------------- | ------------------------------------------- | --------------------------- | ------------- | ----------- | -------------- |
| [ ]                                  | [ ]                               | [ ]            | [ ]          | [ ]               | [ ]                                         | [ ]                         | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Example Complex | (whole facility)                  | [unknown]      | [unknown]    | Illustration only | `holiday`                                   | [unknown]                   | synthetic     | none        | none           |

Recurring closures are not modelled as a rule in the `closures` table; they would be loaded as individual rows or created through preventive maintenance reservations (SPK-FAC-005, facilities module scaffold). **Proposed**.

## 8. Setup and cleanup requirements

SPK-SCHED-003: "A game ending at 19:00 with a ten-minute turnover requirement does not make its space available at 19:00." Defaults are per resource; an event may override them (**Verified** `events.setup_minutes`, `events.cleanup_minutes`). If buffers differ by format or by activity kind, state them per combination; the per-format variation is **Proposed** (today the default is per resource and the override per event).

| Resource                     | Activity kind or format (blank = all) | Setup minutes | Cleanup minutes | Who performs setup and cleanup | Answer status | Named owner | Effective date |
| ---------------------------- | ------------------------------------- | ------------- | --------------- | ------------------------------ | ------------- | ----------- | -------------- |
| [ ]                          | [ ]                                   | [ ]           | [ ]             | [ ]                            | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Pitch 3 | (all)                                 | 0             | 10              | [unknown]                      | synthetic     | none        | none           |

## 9. Required equipment

SPK-SCHED-001 "Required equipment" and SPK-FAC-001 maintainable assets (turf areas, goals, nets, boards, dividers, lighting, scoreboards). Today `resources.required_equipment` is a descriptive JSON array; equipment conflicts are expressed as `equipment` party commitments on events (**Verified** `event_commitments.party_type`), and asset tracking belongs to the facilities module (scaffold). Fill one row per equipment type a resource or format needs; movable items that cannot be in two places at once must be listed so they can become commitments.

| Resource or format                    | Equipment type   | Quantity | Movable between spaces (yes/no) | Shared with | Owner for maintenance | Answer status | Named owner | Effective date |
| ------------------------------------- | ---------------- | -------- | ------------------------------- | ----------- | --------------------- | ------------- | ----------- | -------------- |
| [ ]                                   | [ ]              | [ ]      | [ ]                             | [ ]         | [ ]                   | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Pitch 3, `11v11` | goals, full size | 2        | [unknown]                       | [unknown]   | [unknown]             | synthetic     | none        | none           |

## 10. Staffing constraints

SPK-SCHED-001 "Applicable staffing constraints" and SPK-SCHED-004 "Required staffing" as a conflict check. Today `resources.staffing_constraints` is stored but not validated (scheduling README "Known gaps"); the workforce module that would check required staffing is a scaffold. Fill one row per constraint so the shape can be fixed when validation is implemented.

| Resource or facility         | Activity kind (blank = all) | Constraint (for example minimum staff present, required qualification, supervisor ratio) | Value | Source of the rule (policy, regulation, insurance, operator practice) | Answer status | Named owner | Effective date |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------- | ------------- | ----------- | -------------- |
| [ ]                          | [ ]                         | [ ]                                                                                      | [ ]   | [ ]                                                                   | unknown       | Operations  | [ ]            |
| EXAMPLE (synthetic): Pitch 3 | (all)                       | minimum staff present                                                                    | 1     | Illustration only                                                     | synthetic     | none        | none           |

Youth supervision ratios are a separate decision (DEC-003, Program manager: "Youth eligibility, capacity, staffing, progression") and must not be entered here as facility constraints without that decision.

## 11. Open questions for Operations

Every question is **Pending decision** (DEC-001 unless another record is named). Answering them fills sections 3 to 10.

| #   | Question                                                                                                                                                                         | Decision record                                                        | Needed before                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| 1   | How many facilities (sites) does the organization operate, and what is each one's IANA timezone and address?                                                                     | DEC-001                                                                | Loading section 3                            |
| 2   | For each site: every pitch, subdivision, room or other bookable space, with kind, name and parent.                                                                               | DEC-001                                                                | Scheduling acceptance (§6.6)                 |
| 3   | For each space: dimensions, surface, indoor or outdoor.                                                                                                                          | DEC-001                                                                | Scheduling acceptance                        |
| 4   | Which arrangements are physically possible at the same time (whole pitch, halves, thirds, cross-pitch layouts), and which spaces share an area that prevents simultaneous use?   | DEC-001                                                                | SPK-AT-008 acceptance                        |
| 5   | Which activity formats each space supports (vocabulary from the league manager).                                                                                                 | DEC-001, DEC-002                                                       | Competition release                          |
| 6   | Operating hours per weekday per site, any per-space exceptions, and whether hours change by season or holiday.                                                                   | DEC-001                                                                | Scheduling acceptance                        |
| 7   | Known closures for the coming year (holidays, maintenance, whole-facility events) and any recurring closure rule.                                                                | DEC-001                                                                | Scheduling acceptance; SPK-AT-009 acceptance |
| 8   | Setup and cleanup minutes per space, and whether they differ by format or activity kind; who performs them.                                                                      | DEC-001                                                                | SPK-SCHED-003 acceptance                     |
| 9   | Required equipment per space or format, which items are movable, and who maintains them.                                                                                         | DEC-001                                                                | Facilities release (Package E "Maintenance") |
| 10  | Staffing constraints per space or activity kind, and the rule each comes from.                                                                                                   | DEC-001; DEC-003 for youth ratios; DEC-011 for official qualifications | Workforce release                            |
| 11  | Which spaces are shared with non-migrated activities at cutover, so that one scheduling authority can be assigned per pitch (§5.6).                                              | DEC-014                                                                | Cutover (`../runbooks/cutover.md` section 9) |
| 12  | Required rest between activities for teams and people, and the availability search step (scheduling README "Known gaps", engineering defaults 60 minutes and the proposed step). | DEC-001, DEC-002                                                       | Scheduling acceptance                        |

## 12. Specification ambiguities encountered

| #   | Ambiguity                                                                                                                               | Treatment                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SPK-SCHED-001 "Dimensions or supported configurations" joins two different things: physical size and the arrangements of SPK-SCHED-002. | Split into section 4 (dimensions) and section 5 (arrangements).                                                                             |
| 2   | SPK-SCHED-001 "Operating hours" does not say whether hours vary by season; the `operating_hours` table has no date range.               | "Applies from" and "Applies until" columns **Proposed** in section 6; a schema addition would be needed if Operations answers yes.          |
| 3   | SPK-SCHED-001 lists "Closures" as inventory, while SPK-SCHED-009 treats a closure as an operational event with impact and resolution.   | Section 7 records planned closures as inventory; their application follows the scheduling module's closure lifecycle.                       |
| 4   | "Applicable staffing constraints" is undefined; §3.13 youth ratios and §3.10 official qualifications are separate decisions.            | Section 10 captures the constraint and its source; youth ratios and qualifications are routed to DEC-003 and DEC-011.                       |
| 5   | "Required equipment" overlaps with SPK-FAC-001 assets and with SPK-SCHED-004 "Equipment conflicts".                                     | Section 9 asks whether an item is movable so that it can become an `equipment` commitment; asset tracking stays with the facilities module. |

## 13. Sign-off

The inventory is accepted when Operations signs each section, the example rows are deleted, and the data is loaded through the scheduling endpoints with the load evidence filed in `release-evidence-ledger.md`.

| Section | Signed by (Operations) | Date | Loaded at commit | Evidence row |
| ------- | ---------------------- | ---- | ---------------- | ------------ |
| 3       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 4       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 5       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 6       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 7       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 8       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 9       | [ ]                    | [ ]  | [ ]              | [ ]          |
| 10      | [ ]                    | [ ]  | [ ]              | [ ]          |
