# QA coverage

What every field and button is supposed to do, and the test that holds it to it.

**MySQL (RDS) is the database**, written and read through `api/customers/*`
and `CustomerRepository.js`. Floor-plan and device-photo images live in S3
under `setup_app/` (`ImageStorageService.js`, `ImageUploadService.js`).

The shared "Site-configs" Drive folder is read straight from the browser —
`src/services/GoogleDriveService.js` — with each signed-in user's own Google
OAuth token (a second, Drive-scoped consent screen for the same
`@ensight-technologies.com` account, granted via the "Grant Drive Access"
button in `CustomerSelector.jsx`; no service account, nothing server-side
reads Drive for this). `ImportCustomerFromDriveService.js` downloads and
parses a chosen file and lands it straight in the database through the same
`createCustomer`/`saveCustomerFull` path any other customer uses.
`GoogleSessionPrompt.jsx` is the global re-auth prompt when that Drive token
expires mid-session. `docs/../.env.example`'s `VITE_GOOGLE_SHARED_FOLDER_ID`
is this flow's folder id.

"Export to Sheets" (`api/export-to-sheets.js`, `SheetsExportService.js`) is a
separate, one-way, on-demand mirror of the database into the 13-tab xlsx
shape downstream on-prem systems (EPIC, CameraHub, FLI) read, using a Google
*service account* (`GOOGLE_SERVICE_ACCOUNT_KEY`) — unrelated to the sign-in
OAuth client above. Nothing reads that spreadsheet back into the app.

This is the architecture's third shape: a fully browser-OAuth Drive flow,
then a server-side/service-account import (`api/drive-configs/*` +
`DriveConfigService.js`), then back to browser-OAuth for import specifically
while export stays service-account. What that left behind —
`ConfigSheetSyncService.js`, `GoogleSheetsService.js`,
`OpenConfigFromDriveService.js`, `SiteImporter.jsx`, `sheetTabView.js`,
`LayoutPersistenceService.js` — has been removed: none of it was reachable
from anything the app renders. If you're reading an old copy of this doc that
still frames "the Google Sheet" as the database, that was a different, and
now gone, era of this app.

**439 tests, 34 files** (3 of them gated behind a local Supabase stack and
skipped by default). Run them with `npx vitest run`.

---

## How the layers fit together

| Layer | Question it answers | Files |
|---|---|---|
| 0 — Database & repository contract | Does the database layer behave the way the app assumes? | `api/_customers-data`, `useAppStore.addCustomer`, `useAppStore.dataLoss`, `useAppStore.twoClient`, `rls.integration` |
| 1 — Drive import contract | Does every column of the shared workbook land in the right database field? | `importedWorkbookMapping`, `ExcelParserService.workbook`, `ExcelParserService`, `ImportCustomerFromDriveService`, `driveConfigCatalog` |
| 2 — Export contract | Does the one-way MySQL → Sheets export write the row shape downstream systems expect? | `api/export-to-sheets`, `configSheetSchema` |
| 3 — Data mapping & utilities | Do the small, pure pieces the rest of the app leans on hold up on their own? | `customerRowMapping`, `customerUtils`, `deviceCountUtils`, `deviceNamingUtils`, `signInserts`, `trafficFlowUtils`, `zoneLevelUtils`, `floorPlanBackground`, `photoPick`, `ImageStorageService`, `ImageUploadService`, `ClickUpFeedbackService` |
| 4 — Controls | Does each on-screen control trigger the right action? | `components/__tests__/*` |

A control can only be trusted when layers 0–4 all hold for it. A component
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
Security policies against a real local Supabase stack (legacy Storage reads
still go through Supabase — see `ImageUploadService.js`). Gated by
`describe.skipIf(!hasLocalStack)`; runs only when `RLS_TEST_SUPABASE_URL` and
`RLS_TEST_SUPABASE_ANON_KEY` are set (`supabase start` locally first).

---

## Layer 1 — the Drive import contract

The only way a config workbook becomes a customer. The browser reads the
shared folder and downloads a file with the signed-in user's own Drive OAuth
token (`GoogleDriveService.js`); the parsed workbook is written through the
same `createCustomer`/`saveCustomerFull` path any other customer uses.

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

## Layer 2 — the export contract

`api/export-to-sheets.test.js` (13) — the one-way MySQL → Sheets mirror:
authorization, the service-account Drive/Sheets calls it makes, and that a
full customer's tabs come out shaped the way the downstream systems expect.
`configSheetSchema.test.js` (15) supplies the row builders this endpoint
writes with (and that the import path's mapping code shares), plus
server-merge and group-pruning helpers.

---

## Layer 3 — data mapping and utilities

Small, pure pieces exercised on their own so a bug in one does not have to be
diagnosed through a rendered screen.

| Area | File | What it holds to |
|---|---|---|
| DB row ↔ device shape | `customerRowMapping.test.js` (11) | `splitLegacyDevice` → nested DB row → `dbDeviceToLegacy` round-trips for cameras, signs, sensors |
| Customer fields | `customerUtils.test.js` (13), `customerConfigUtils.test.js` (2) | `safeExternalUrl`, address fields, maps URL; whether a customer has a database row to sync against |
| Device counting & naming | `deviceCountUtils.test.js` (6), `deviceNamingUtils.test.js` (20) | Per-site device counts, sign de-duplication, auto-naming for cameras/signs/dual-lens streams |
| Signs | `signInserts.test.js` (7) | Monument grouping, display-name fallbacks, map labels |
| Traffic flow & zones | `trafficFlowUtils.test.js` (20), `zoneLevelUtils.test.js` (12) | Flow target resolution and labels; zone-level detection, auto-naming, linked polygons |
| Images | `floorPlanBackground.test.js` (11), `photoPick.test.js` (8), `ImageStorageService.test.js` (4), `ImageUploadService.test.js` (12) | Upload accept types, size caps and compression; the `setup_app/` S3 key guard; routing uploads/reads/deletes between S3 and legacy Supabase Storage paths |
| Feedback | `ClickUpFeedbackService.test.js` (2) | The context string built from customer/site/level/path for a ClickUp ticket |

---

## Layer 4 — every on-screen control

These assert on what reaches the service a control calls, not on what the
screen displays, because the screen agreeing with itself is exactly the
failure mode this suite exists to catch.

**Up to date with the current architecture:**

`CustomerSelector.test.jsx` (17) — the customer list: "Available in Drive"
loads once there's a session *and* a Drive token (`Drive site-configs`),
adding a customer creates the row through `CustomerRepository.js`,
editing/removing goes through the same repository and keeps the server's
timestamp.

**Still asserting against a removed sheet-sync vocabulary — pending a
rewrite (see Gaps):**

`AddCameraWizard.test.jsx`, `InspectorPanel.test.jsx`, `EditorView.test.jsx`,
`LevelSelector.test.jsx`, `SiteSelector.test.jsx`,
`CustomerSupportDialog.test.jsx`, `SetupSyncIndicator.test.jsx`,
`CustomerDataGate.test.jsx`.

Each of these mocks a `sync` (and in two cases a `layout`) object standing in
for the now-deleted `ConfigSheetSyncService.js` / `LayoutPersistenceService.js`,
and describes its assertions as "writes to the sheet" / "no writable sheet" /
"the config tabs". Those mocks no longer back anything real — the components
under test never imported those modules by the time this doc was written —
so a meaningful share of each file's tests already fail for reasons unrelated
to the control itself (`npx vitest run` currently reports 53 pre-existing
failures, entirely inside these eight files). Fixing a control here means
first deciding what it should actually call in the MySQL-and-Drive-import
world, then rewriting the test around that, not patching the sheet-era mock.

---

## Gaps

Named here so they are visible rather than assumed covered.

- **The eight stale component suites above.** They still describe screens in
  sheet-sync terms and a large share of their assertions already fail
  against the current app. Rewriting them (what should `EditorView`'s toolbar
  actually call now? what does "no writable sheet" mean for a MySQL row?) is
  a deliberate follow-up, not a small fix.
- **`WriteGuard.js` is untested.**
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
- a change to the Sheets export shape → layer 2
- a new pure helper → layer 3
- a new control on an existing screen → layer 4, and prefer the
  `CustomerSelector.test.jsx` style (assert on the repository/service call,
  not on removed sheet-sync mocks) over the pattern in the eight stale files

Component tests assert on what reaches the service, not on what the screen
says, because the screen agreeing with itself is exactly the failure mode
this whole suite exists to catch.
