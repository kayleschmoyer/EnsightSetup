# QA coverage

What every field and button is supposed to do, and the test that holds it to it.

**MySQL (RDS) is the database**, written and read through `api/customers/*`
and `CustomerRepository.js`. Floor-plan and device-photo images live in S3
under `setup_app/` (`ImageStorageService.js`, `ImageUploadService.js`). The
shared "Site-configs" Drive folder is read server-side by
`api/drive-configs/*` (a Google service account, no per-user OAuth) and
turned into a customer through `DriveConfigService.js` +
`ImportCustomerFromDriveService.js` — that is the only way a config workbook
still reaches the app. "Export to Sheets" (`api/export-to-sheets.js`,
`SheetsExportService.js`) is a one-way, on-demand mirror of the database into
the 13-tab xlsx shape downstream on-prem systems (EPIC, CameraHub, FLI) read;
nothing reads that spreadsheet back into the app.

The browser-side Google OAuth Drive/Sheets flow this doc used to describe —
`GoogleDriveService.js`, `GoogleSheetsService.js`, `ConfigSheetSyncService.js`,
`OpenConfigFromDriveService.js`, `SiteImporter.jsx`, `GoogleSessionPrompt.jsx`
— is gone. A handful of component suites below still narrate their assertions
in that vocabulary ("writes to the sheet", "no writable sheet") because they
have not been rewritten yet; see Gaps.

**435 tests, 35 files** (3 of them gated behind a local Supabase stack and
skipped by default). Run them with `npx vitest run`.

---

## How the layers fit together

| Layer | Question it answers | Files |
|---|---|---|
| 0 — API & repository contract | Does the database layer behave the way the app assumes? | `api/_customers-data`, `useAppStore.addCustomer`, `useAppStore.dataLoss`, `useAppStore.twoClient`, `rls.integration` |
| 1 — Drive import contract | Does every column of the shared workbook land in the right database field? | `importedWorkbookMapping`, `ExcelParserService.workbook`, `ExcelParserService`, `ImportCustomerFromDriveService`, `driveConfigCatalog`, `api/drive-configs` |
| 2 — Data mapping & utilities | Do the small, pure pieces the rest of the app leans on hold up on their own? | `customerRowMapping`, `configSheetSchema`, `customerUtils`, `deviceCountUtils`, `deviceNamingUtils`, `signInserts`, `trafficFlowUtils`, `zoneLevelUtils`, `floorPlanBackground`, `photoPick`, `LayoutPersistenceService`, `ImageStorageService`, `ImageUploadService`, `ClickUpFeedbackService` |
| 3 — Controls | Does each on-screen control trigger the right action? | `components/__tests__/*` |

A control can only be trusted when layers 0–3 all hold for it. A component
test alone would pass against a handler wired to nothing; a mapping test
alone would pass against a screen no button reaches.

---

## Layer 0 — the database layer

`api/_customers-data.test.js` (3) pins `saveCustomerFull`'s optimistic
concurrency guard against a mocked MySQL pool — a save that raced past a
newer `updated_at` must fail loudly, not overwrite.

`useAppStore.addCustomer.test.js` (2) — adding a customer that already has a
row must replace it in place, not append a second one (the duplicate React
key bug).

`useAppStore.dataLoss.test.js` (7) — the regression chain behind the original
data-loss bug: a failed read must never be treated as "the customer has no
layout yet" and auto-saved back over what the database actually holds. Driven
against `fakeCustomerRepository.js`, an in-memory stand-in for
`CustomerRepository.js`'s real `loadCustomerFull`/`saveCustomerFull` contract.

`useAppStore.twoClient.test.js` (3) — two machines, one MySQL row: A saves, B
(empty localStorage) sees everything A saved, edits, and A reloads and sees
B's work — or a real conflict is flagged instead of silently overwritten.

`rls.integration.test.js` (3, skipped by default) — Postgres Row Level
Security policies against a real local Supabase stack. Gated by
`describe.skipIf(!hasLocalStack)`; runs only when `RLS_TEST_SUPABASE_URL` and
`RLS_TEST_SUPABASE_ANON_KEY` are set (`supabase start` locally first).

---

## Layer 1 — the Drive import contract

The only way a config workbook becomes a customer now. `api/drive-configs/*`
lists and downloads spreadsheets from the shared folder with a service
account; the browser parses and maps the download and writes it through the
same `createCustomer`/`saveCustomerFull` path any other customer uses.

`api/drive-configs.test.js` (8) — the read-only Drive proxy: folder id
resolution, mime-type routing (native Sheet vs. `.xlsx`), file-id validation,
size cap.

`importedWorkbookMapping.test.js` (25) — the tab-by-tab contract, one block
per tab down to the split rows:

| Tab | Lands in |
|---|---|
| Customer | `customers`, `customer_addresses`, `customer_support` |
| Networking | `servers` (cloned per site; device names resolve to `devices.server_id`) |
| Garages | `sites` |
| GarageLevels | `levels` config JSON, zone rows → `zones` with a real parent floor and linked polygon |
| DisplayGroups | `display_groups` (cloned per site) |
| DisplayControllers + DisplayLevels | sign `devices`, `sign_details`, `sign_display_levels`, `sign_inserts` |
| DisplaySchedules | `display_schedules` |
| Cameras + FLICameras + LPRCameras | camera `devices`, `camera_details`, `camera_streams`, zone cameras placed on the parent floor |
| SensorGroups + Sensors | `sensor_groups`, sensor `devices`, `sensor_details`, `sensor_units` |

`ExcelParserService.workbook.test.js` (11) parses a real in-memory 13-tab
workbook (`__fixtures__/sampleWorkbook.js`) and checks one thing per tab —
`importedWorkbookMapping.test.js` owns the field-level detail.
`ExcelParserService.test.js` (8) covers the smaller parsing helpers
(`parseDisplayLevelField`, `serversFromNetworkingRows`) in isolation.

`ImportCustomerFromDriveService.test.js` (10) — the service that turns a
Drive file into database rows: no duplicate customer row on an unhydrated
import, `findCustomerForDriveFile` matches an existing customer to the file
it came from, and the guards around both.

`driveConfigCatalog.test.js` (8) — merging the Drive folder listing into the
customer list ("Available in Drive"), matching a Drive file to a local
customer, and what counts as an orphan.

---

## Layer 2 — data mapping and utilities

Small, pure pieces exercised on their own so a bug in one does not have to be
diagnosed through a rendered screen.

| Area | File | What it holds to |
|---|---|---|
| DB row ↔ device shape | `customerRowMapping.test.js` (11) | `splitLegacyDevice` → nested DB row → `dbDeviceToLegacy` round-trips for cameras, signs, sensors |
| Export/workbook row schema | `configSheetSchema.test.js` (15) | The row builders `SheetsExportService.js` uses for the 13-tab export, plus server-merge and group-pruning helpers the import path shares |
| Customer fields | `customerUtils.test.js` (13), `customerConfigUtils.test.js` (2) | `safeExternalUrl`, address fields, maps URL; whether a customer has a database row to sync against |
| Device counting & naming | `deviceCountUtils.test.js` (6), `deviceNamingUtils.test.js` (20) | Per-site device counts, sign de-duplication, auto-naming for cameras/signs/dual-lens streams |
| Signs | `signInserts.test.js` (7) | Monument grouping, display-name fallbacks, map labels |
| Traffic flow & zones | `trafficFlowUtils.test.js` (20), `zoneLevelUtils.test.js` (12) | Flow target resolution and labels; zone-level detection, auto-naming, linked polygons |
| Images | `floorPlanBackground.test.js` (11), `photoPick.test.js` (8), `ImageStorageService.test.js` (4), `ImageUploadService.test.js` (12) | Upload accept types, size caps and compression; the `setup_app/` S3 key guard; routing uploads/reads/deletes between S3 and legacy Supabase Storage paths |
| Layout snapshots | `LayoutPersistenceService.test.js` (6) | `serializeCustomerLayout`, `validateLayoutPayload`/`parseLayoutJson`, `layoutFilename` — the manual JSON backup/restore export, independent of the database |
| Feedback | `ClickUpFeedbackService.test.js` (2) | The context string built from customer/site/level/path for a ClickUp ticket |

---

## Layer 3 — every on-screen control

These assert on what reaches the service a control calls, not on what the
screen displays, because the screen agreeing with itself is exactly the
failure mode this suite exists to catch.

**Up to date with the current architecture:**

`CustomerSelector.test.jsx` (12) — the customer list: "Available in Drive"
loads as soon as there is a session and lists files not yet imported
(`Drive site-configs`), adding a customer creates the row through
`CustomerRepository.js`, editing/removing goes through the same repository
and keeps the server's timestamp.

**Still asserting against the removed sheet-sync vocabulary — pending a
rewrite (see Gaps):**

`AddCameraWizard.test.jsx` (34), `InspectorPanel.test.jsx` (22),
`EditorView.test.jsx` (19), `LevelSelector.test.jsx` (17),
`SiteSelector.test.jsx` (19), `CustomerSupportDialog.test.jsx` (25),
`SetupSyncIndicator.test.jsx` (18), `CustomerDataGate.test.jsx` (19).

Each of these mocks a `sync` object standing in for the removed
`ConfigSheetSyncService.js` and describes its assertions as "writes to the
sheet" / "no writable sheet" / "the config tabs". The mock module no longer
backs anything real — the components under test do not import it — so a
meaningful share of each file's tests already fail for reasons unrelated to
the control itself (`npx vitest run` currently reports 53 pre-existing
failures, entirely inside these eight files). Fixing a control here means
first deciding what it should actually call in the MySQL-and-Drive world,
then rewriting the test around that, not patching the sheet-era mock.

---

## Gaps

Named here so they are visible rather than assumed covered.

- **The eight stale component suites above.** They still describe screens in
  sheet-sync terms and a large share of their assertions already fail
  against the current app. Rewriting them (what should `EditorView`'s toolbar
  actually call now? what does "no writable sheet" mean for a MySQL row?) is
  a deliberate follow-up, not a small fix.
- **No test for the export path.** Neither `SheetsExportService.js` nor
  `api/export-to-sheets.js` has a test file. The 13-tab row shape it writes
  is only exercised indirectly, through `configSheetSchema.test.js`'s row
  builders.
- **No client-side test for `DriveConfigService.js`.** Only the server route
  behind it (`api/drive-configs.test.js`) is covered directly; the browser
  service itself is exercised only through `CustomerSelector.test.jsx` and
  `ImportCustomerFromDriveService.test.js`.
- **`WriteGuard.js` is untested.**
- **`api/export-to-sheets.js` still reads Supabase**, not MySQL — a known gap
  between the export path and the rest of the app, not something this suite
  can catch.
- **Floor-plan image upload** is covered for the geometry
  (`floorPlanBackground.test.js`) but not for the upload control itself.
- **PDF export** is not covered; `EditorView` asserts only that the export
  path is invoked, and skipped for an empty level.
- **The dialogs mocked out of the component tests** — app settings, report
  issue, customer map — have no tests of their own.
- **Presentational components** — `MapCanvas`, `CustomerMapDialog`,
  `TrafficFlowView`, `ContactsSidebar`, `Weather` — have no store or sync
  references and are not covered directly. The placement path through
  `MapCanvas` is covered from `EditorView`.

## Adding a control

If you add a field or a button, add a row above and the test behind it. The
test belongs in the layer that matches the question:

- a new database field or a new Drive-import mapping → layer 0 or 1
- a new pure helper → layer 2
- a new control on an existing screen → layer 3, and prefer the
  `CustomerSelector.test.jsx` style (assert on the repository/service call,
  not on removed sheet-sync mocks) over the pattern in the eight stale files

Component tests assert on what reaches the service, not on what the screen
says, because the screen agreeing with itself is exactly the failure mode
this whole suite exists to catch.
