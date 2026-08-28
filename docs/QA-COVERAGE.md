# QA coverage

What every field and button is supposed to do, and the test that holds it to it.

This exists because the app has no backend: every button press is a Google
Sheets write made from the browser, and a control that writes the wrong cell
looks perfectly fine on screen. The only way to know a control still does what
it says is to assert on what reaches the sheet.

**Rule of the sheet.** The Google Sheet is the database. If a row is on the
sheet it shows in the app; if it is not on the sheet it does not exist in the
app. Local storage holds pointers only — ids, names, the spreadsheet link —
never layout data. Everything below is written to keep those two in agreement.

**485 tests, 34 files.** Run them with `npx vitest run`.

---

## How the layers fit together

| Layer | Question it answers | Files |
|---|---|---|
| 0 — Contract | Does the Sheets API behave the way we think it does? | `GoogleSheetsService.contract`, `LayoutPersistenceService.atomic`, `sheetTabView` |
| 1 — Fields | Does every column of every tab get written? | `__tests__/fieldMatrix` |
| 2 — Actions | Does add / update / rename / delete land correctly for every entity? | `__tests__/actionMatrix`, `ConfigSheetSyncService.*` |
| 3 — Controls | Does each on-screen control trigger the right action? | `components/__tests__/*` |
| 4 — Scenarios | Do two people on two machines see the same thing? | `useAppStore.twoClient`, `useAppStore.dataLoss` |

A control can only be trusted when all four hold. Layer 3 alone would pass
against a service that writes to the wrong column; layer 1 alone would pass
against a button wired to nothing.

---

## Layer 0 — what the Sheets API actually does

These pin the API behaviours that silently corrupt data, using an in-memory
fake (`services/__fixtures__/fakeSheets.js`) that reproduces them.

| Behaviour | Why it bites | Test |
|---|---|---|
| Reads trim trailing empty cells | A short row makes a later column read fall off the end | `readTabValues > returns rectangular rows even though Sheets trims trailing blanks` |
| `USER_ENTERED` reinterprets values | `04:00` becomes a time, `007` becomes `7`, `+lens` becomes `#ERROR!` | `writeTabValues value fidelity > round-trips values Sheets would otherwise reinterpret` |
| `update` writes only the cells supplied | A ragged payload leaves the previous row's cells in place | `… > pads a ragged payload so a short row cannot inherit stale cells` |
| RAW keeps types honest | Numbers stay numeric, strings stay literal | `… > keeps numbers numeric and strings literal under RAW` |
| A shorter payload leaves debris | Removing a row leaves the last row duplicated at the bottom | `replaceTabValues > leaves no cells behind when a row is removed and later rows shift up` |
| A narrower payload leaves orphan columns | Old values sit to the right of the new data | `replaceTabValues > clears columns to the right when the new payload is narrower` |
| Multi-request writes are not atomic | A part-way failure leaves half a snapshot | `a 20-background save > leaves the previous snapshot readable when a write fails part-way` |
| Columns are found by name, not index | A hand-inserted column shifts every positional read | `buildTabView > resolves columns from the sheet, not the schema, when they differ` |

Also covered: staging-tab cleanup after a failed save, byte-for-byte verification
before commit, the cheap two-cell revision read, legacy tabs written before the
revision columns existed, and write serialization so two saves cannot share a
staging tab.

---

## Layer 1 — every column of every tab

`src/services/__tests__/fieldMatrix.test.js` (17 tests). One test per tab,
asserting the full row rather than a sample of it, plus a sweep that fails if
any schema column is missing from any synced tab.

| Tab | Test |
|---|---|
| Customer | `Customer tab > writes every column` |
| Garages | `Garages tab > writes every column, using internalName as the key and name as the visible one` |
| GarageLevels (19 columns) | `GarageLevels tab > writes all 19 columns from the level and its config` + `covers every column in the schema` |
| Cameras | `Cameras tab > writes every column for an FLI camera`, `marks a disabled camera as disabled`, `routes an LPR camera to DetectionType LPR` |
| FLICameras / LPRCameras | `writes every column, and sends each camera to the tab for its type` |
| DisplayControllers | `DisplayControllers tab > writes every column` |
| DisplayLevels | `writes every column for a sign assigned to one level`, `writes Level = All for a sign covering the whole site` |
| DisplayGroups | `DisplayGroups tab > writes every column` |
| SensorGroups | `SensorGroups tab > writes every column` |
| Sensors | `Sensors tab > writes every column` |
| Networking | `writes every column and reads each one back`, `records DHCP when the port is not static` |
| — all tabs — | `no field is silently dropped > every schema column exists on every synced tab` |

---

## Layer 2 — add, update, rename and delete per entity

`src/services/__tests__/actionMatrix.test.js` (26 tests). Rename and delete get
their own cases because both touch rows the user never sees.

| Entity | Add | Update | Rename | Delete |
|---|---|---|---|---|
| Site | `ADD writes the site and its levels` | `UPDATE changes the visible name without adding a row` | `RENAME retargets every row that referenced the old name` | `DELETE removes the site and everything keyed to it` |
| Level | `ADD appends a level row for the site` | `UPDATE rewrites the level in place` | — | `DELETE drops the removed level and keeps the rest` |
| Camera | `ADD writes to Cameras and the type tab` | `UPDATE changes fields in place, no duplicate row` | `RENAME moves the row rather than leaving both` | `DELETE clears it from all three camera tabs` |
| Sign | `ADD writes the controller and its display levels` | `UPDATE changes the assigned display group` | `RENAME moves the controller row` | `DELETE removes it from both sign tabs` |
| Sensor | `ADD writes the sensor and its group` | `UPDATE rewrites the sensor row in place` | — | `DELETE removes the sensor and prunes a group nothing uses` |
| Display group | `ADD then UPDATE keeps one row` | ↩ | — | `DELETE drops the group the site no longer has` |
| Server | `ADD then UPDATE keeps one row` | ↩ | — | `DELETE removes the row the site no longer lists` |

Two cases exist because they were real bugs:

- `camera > TYPE CHANGE moves it from the FLI tab to the LPR tab` — a type change
  used to leave the old tab's row behind.
- `display group shared between sites > keeps a group another site still owns when one site drops it`
  — deleting a site used to remove a group a sibling site still referenced.

Also in this layer: `camera > DUAL-LENS writes one row per stream, each with its
own address`, and `sign > UNASSIGNING every level clears its DisplayLevels rows`.

### The sheet as a mirror

`ConfigSheetSyncService.resync.test.js` (12) — every real edit re-mirrors the
config tabs, so the sheet converges on what the app holds.

- Missing rows are pushed: `the app has far more devices than the sheet > pushes every missing camera to the sheet` (and the derived type tab, and all levels).
- Drifted values are repaired: `a save with damaged rows on the sheet > repairs the camera row from current state`, `repairs a value Sheets had reinterpreted`.
- Rows the app does not have are removed: `rows the app no longer has > removes a camera row the app does not have, so the two cannot disagree`.
- Nothing changed means nothing written: `cost of a save when nothing drifted > reads once and writes nothing the second time`.
- DisplaySchedules and Networking are deliberately left alone: `DisplaySchedules stays out of the write-side mirror > never rewrites the tab, so hand-edited schedules survive a save`.

### Delete paths

`ConfigSheetSyncService.delete.test.js` (8) — deletes get their own file because
they were rewritten from column indices to header names and had no coverage at
all afterwards.

- `deleteCameraFromSheet > removes only the target camera, from every tab it appears on`
- `deleteSignFromSheet > removes the sign from DisplayControllers and DisplayLevels`
- `deleteSensorFromSheet > removes the sensor rows and rebuilds the garage sensor groups`
- `deleteGarageFromSheet > removes every row for that site and leaves the other site intact`
- `deleteGarageFromSheet > keeps a display group another site still uses`
- With no writable sheet, all three fail loudly and issue no requests rather
  than returning quietly: `a customer with no Google Sheet to write to > …`

### Dual-lens streams

`ConfigSheetSyncService.rtsp.test.js` (3) — the two lenses of one camera must
not bleed into each other: stream 1 and stream 2 RTSP URLs stay independent,
`device.rtspUrl` is not copied onto an empty stream 2, and each stream carries a
distinct `streamKey` so their sheet rows stay separate.

### Hand-edited sheets

`ConfigSheetSyncService.handEdited.test.js` (9) — the team edits these tabs
directly, so a save must not undo their work: hand-added columns are preserved
across rewrites and deletes, missing schema columns are appended rather than
inserted, a generated RTSP URL never overwrites one already on the sheet, and
DisplaySchedules garage columns are followed by name.

---

## Layer 3 — every on-screen control

### Customer list — `CustomerSelector.test.jsx` (16)

| Control | Expected | Test |
|---|---|---|
| Add Customer → Friendly Name | Creates the Sheet, records id/url/title | `add a customer > creates the config sheet and records its details` |
| … seeds the first site | First site carries the sheet quick link | `> seeds a first site carrying the config sheet link` |
| … Address / City / State / Zip | Stored on the customer and its first site | `> stores the address on both the customer and its first site` |
| … submit with no name | Disabled | `> will not submit an empty name` |
| … duplicate name | Refused before anything is created on Drive | `> refuses a duplicate name before creating anything on Drive` |
| … signed out | Refused | `> refuses to create anything while signed out` |
| … Drive failure | Nothing added locally either | `> adds nothing when the sheet cannot be created` |
| Edit customer → name | Renames the Drive file and syncs the Customer tab | `rename a customer > renames the Drive file and syncs the Customer tab` |
| … name availability | Checked on Drive first, excluding this file | `> checks the new name is free on Drive first` |
| … Drive rejects | Nothing changes locally | `> changes nothing locally when Drive rejects the rename` |
| … companion .xlsx fails | Sheet name rolled back | `> rolls the Sheet name back when the companion xlsx cannot be renamed` |
| … Customer tab sync fails | Rename kept — local state matches Drive | `> keeps the rename when only the Customer tab sync fails` |
| … duplicate name | Refused | `> refuses a name another customer already uses` |
| … address only | Syncs without renaming anything | `> an address-only edit syncs without renaming anything` |
| Delete customer | Confirms; removes from the app only, never Drive | `remove a customer > asks first and removes only from the app, never from Drive` |
| … cancel | Customer stays | `> leaves the customer alone when the confirmation is dismissed` |

### Sites — `GarageSelector.test.jsx` (19)

| Control | Expected | Test |
|---|---|---|
| Add Site → Name | Creates the site, seeds `Level 1`, syncs | `add a site > creates it, seeds a first level, and syncs` |
| … empty name | Submit disabled | `> will not submit an empty name` |
| … duplicate name | Refused case-insensitively, no sync | `> refuses a duplicate name regardless of case, without syncing` |
| … address fields | Stored on the site | `> stores address fields the user typed` |
| … config sheet link | Attached when the customer has one | `> attaches the config sheet link when the customer has one` |
| … sync fails | Optimistic add rolled back, so a retry cannot duplicate | `when the sync fails while adding > rolls the new site back so a retry cannot duplicate it` |
| … rollback scope | A site added elsewhere is untouched | `> leaves a site added elsewhere untouched while rolling back` |
| Edit Site → Name | Passes the previous name so device rows are retargeted | `edit a site > renames it and hands the sync the previous name` |
| … sync fails | Local change kept, and said so — opposite of add | `> keeps the local change when the sync fails — the opposite of an add` |
| … inherited address | Saved empty so the site keeps following the customer | `> leaves an inherited address unset so the site keeps following the customer` |
| … edited address | Stored on the site | `> stores an address the user actually edited` |
| Delete Site | Confirms first | `delete a site > does nothing until the confirmation is accepted` |
| … remaining sites | Passed as `otherGarages`, sparing a shared display group | `> removes it and passes the remaining sites to the sync` |
| … selection | Cleared when the deleted site was selected | `> clears the selection when the deleted site was the selected one` |
| … sheet failure | Surfaced, not swallowed | `> says so when the sheet delete fails` |
| Quick link → URL | Malformed URL keeps submit disabled | `quick links > will not submit a malformed URL` |
| … valid link | Stored on the right site, no sheet write | `> stores a valid link on the right site, with no sheet write` |
| … delete | Confirms, removes only that link | `> deletes only the chosen link, after confirming` |
| No writable sheet | Adds locally, never calls the sync | `a customer with no writable sheet > adds the site locally and never calls the sync` |

### Levels, servers and groups — `LevelSelector.test.jsx` (17)

| Control | Expected | Test |
|---|---|---|
| Add Level | Creates and syncs | `levels > ADD creates a level and syncs it` |
| … empty name | Refused | `> ADD refuses an empty name` |
| … spot counts | Carried through | `> ADD carries the spot counts through` |
| Delete Level | Confirms, removes, syncs | `> DELETE removes the level and syncs, after confirming` |
| Add Server | Creates and syncs the Networking tab | `servers > ADD creates a server and syncs the Networking tab` |
| … empty name | Refused | `> ADD refuses an empty name` |
| Delete Server | Removes and syncs | `> DELETE removes the server and syncs` |
| Add Display Group | Creates and syncs | `display groups > ADD creates a group and syncs it` |
| … force-send seconds | Carried through | `> ADD carries the force-send seconds through` |
| Delete Display Group | Sync receives every site, so a shared group survives | `> DELETE removes the group and gives the sync every site` |
| … signs using it | Unassigned on the sheet | `> DELETE also unassigns the group from signs on the sheet` |
| Add Sensor Group | Creates and syncs | `sensor groups > ADD creates a group and syncs it` |
| … controller address and key | Carried through | `> ADD carries the controller address and key through` |
| Delete Sensor Group | Removes and syncs | `> DELETE removes the group and syncs` |
| Any sync failure | Reported, not swallowed | `when the sheet sync fails > says so rather than pretending the level was saved` |
| No writable sheet | No sync attempted | `a customer with no writable sheet > does not attempt a sync when adding a level` |

### Editor — `EditorView.test.jsx` (30)

| Control | Expected | Test |
|---|---|---|
| Add FLI / LPR / People | Opens the camera wizard rather than adding blindly | `Add toolbar > Add FLI Camera opens the camera wizard rather than adding blindly` (and LPR, People) |
| Add LED / Static / Designable Sign | Adds the sign and syncs it | `> Add LED Sign adds a sign to the level and syncs it` (and Static, Designable) |
| Add NWAVE / Parksol / Proco / Ensight Vision | Adds the sensor and syncs it | `> Add NWAVE adds a sensor to the level and syncs it` (and the other three) |
| Naming | Each added sign gets a distinct name | `> gives each added sign a distinct name` |
| Add Zone | Adds a zone | `> adds a zone` |
| Every device type has a button | Toolbar completeness | `> offers a button for every device type` |
| Device update | Written into the store | `device update and delete > UPDATE writes the change into the store` |
| … with `syncToSheet` | Pushed to the sheet | `> UPDATE with syncToSheet pushes the camera to the sheet` |
| Delete | Confirms first | `> DELETE asks for confirmation before removing anything` |
| … confirmed | Removed and cleared from the sheet | `> DELETE removes the device and clears it from the sheet once confirmed` |
| … per type | Sign deletes hit the sign tabs, sensor deletes the sensor tabs | `> a sign delete goes to the sign tabs, not the camera ones`, `> a sensor delete goes to the sensor tabs` |
| Unplace | Keeps the device, takes it off the map | `> UNPLACE keeps the device but takes it off the map` |
| Drag on the map | Position stored | `map > dragging a device stores its new position` |
| … and only that | No config row rewritten | `> moving a device on the map does not rewrite its config row` |
| Click a device | Opens it in the inspector | `> selecting a device on the map opens it in the inspector` |
| Zone edit | Updates through the canvas | `zones > updates a zone through the canvas` |
| Export | Exports when the level has devices | `toolbar > exports configs when the level has devices` |
| … empty level | Does nothing | `> does not export an empty level` |
| Settings / Report issue / Theme / Back | Each opens or toggles what it says | `> opens app settings`, `> opens the report-issue dialog`, `> toggles the theme`, `> goes back to the customer list` |

### Inspector — `InspectorPanel.test.jsx` (25)

| Control | Expected | Test |
|---|---|---|
| Fields shown | A camera shows identity, network and traffic fields | `fields shown per device type > a camera shows its identity, network and traffic fields` |
| … a sign | Display fields and a serial address, no camera fields | `> a sign shows display fields and a serial address, not camera ones` |
| … a sensor | Sensor fields, no network tab | `> a sensor shows sensor fields and no network tab` |
| IP address | Commits on blur | `fields that write to the config tabs > IP address commits on blur` |
| Port | Commits on blur | `> port commits on blur` |
| RTSP URL | Commits on blur | `> RTSP URL commits on blur` |
| Sign serial address | Commits on blur | `> a sign serial address commits on blur` |
| Server name (legacy free text) | Commits on blur | `> a legacy free-text server name commits on blur` |
| Server (picker) | Offered when there is no legacy name | `> offers the server list as a picker when there is no legacy name` |
| Disabled toggle | Syncs immediately | `> the disabled toggle syncs immediately` |
| Sign controller name | Syncs immediately | `> a sign controller name syncs immediately` |
| Sign visible name | Syncs immediately | `> a sign visible name syncs immediately` |
| X / Y / Rotation | Local only — never a sheet write | `map-only fields never touch the sheet > X updates locally without a sheet write` (and Y, Rotation) |
| Sign display name | Controller and visible names travel together while they match | `sign display name > carries the controller and visible names along while they still match` |
| … customised | A customised controller name is left alone | `> leaves a controller name the user has already customised alone` |
| Unplace | Asks the parent to unplace | `footer buttons > Unplace asks the parent to unplace` |
| … already unplaced | Disabled | `> Unplace is disabled for a device that is already unplaced` |
| Duplicate | Copies the device | `> Duplicate copies the device` |
| Delete | Asks the parent to delete | `> Delete asks the parent to delete` |
| Close | Closes the panel | `> Close closes the panel` |
| Place on map | Offered only for an unplaced device | `> Place on map is offered only for an unplaced device` |
| Sensor group | Assigning syncs it | `group assignment > assigning a sensor group syncs it` |
| No writable sheet | No sheet write, however the field is edited | `when the customer has no writable sheet > never asks for a sheet write, however the field is edited` |

### Add camera wizard — `AddCameraWizard.test.jsx` (34)

| Control | Expected | Test |
|---|---|---|
| Hardware tiles | Both offered with stream counts | `step 1 — hardware type > offers both hardware types with their stream counts` |
| … pick | Goes to the stream-type step | `> goes to the stream-type step when the type is not already known` |
| … with a type already chosen | Step 2 skipped | `> skips the stream-type step when the caller already picked one` |
| Stream-type tiles | FLI, LPR and People offered | `step 2 — stream type > offers FLI, LPR and People` |
| Back | Returns to hardware selection | `> goes back to hardware selection` |
| … pick | Applied to the emitted device | `> lands on configuration with the chosen type applied` |
| Bullet | One stream, no `stream2` | `what each hardware type emits > a bullet camera has one stream and no stream2` |
| Dual lens | Second stream defaults to the complementary type | `> a dual-lens camera defaults its second stream to the complementary type`, `> pairs LPR with FLI the other way round` |
| … People | Stays People on both | `> leaves both streams as People when that is the pick` |
| Stream tabs | Absent for a single-stream camera | `> shows no stream tabs for a single-stream camera` |
| Device Name / Friendly Name / MAC | Recorded | `step 3 — device fields > records name, friendly name and MAC address` |
| … blank name | Falls back to a placeholder | `> falls back to a placeholder name when left blank` |
| IP / Port / RTSP | Recorded on the stream and mirrored onto the device | `> records the IP, port and RTSP URL, mirroring IP/port onto the device` |
| Port default | `554` | `> defaults the port to 554` |
| Stream Type toggle | The device type follows stream 1, not the step-2 pick | `> takes the device type from stream 1 after the type is changed in step 3` |
| Stream tab switch | IP/port/RTSP per stream; name and MAC shared | `step 3 — dual-lens streams stay separate > keeps IP, port and RTSP per stream while name and MAC stay shared` |
| … type toggle | Changes only the active stream | `> changes only the active stream when the type toggle is used` |
| IN | Direction recorded, level defaults to the current one | `step 3 — traffic flow > records the IN direction and defaults the level to the current one` |
| OUT, pressed twice | Direction cleared | `> records OUT, and pressing the same button again clears the direction` |
| Flow target select | Level, or a zone on it | `> targets another level when one is chosen`, `> targets a zone on a level when one is chosen` |
| Opposite-flow switch | Ramp destinations recorded | `> records the opposite-flow destinations of a ramp camera` |
| … switched off | Destinations dropped | `> drops the destinations when the ramp switch is turned back off` |
| … own target | Never counted against itself | `> never counts the camera against its own primary target` |
| Coming from | Recorded; the camera's own level is not offered | `> records where the traffic is coming from`, `> offers other levels as a source but not the camera's own` |
| Dual-lens flow | Kept per stream | `> keeps each dual-lens stream's flow separate` |
| Server Assignment | Numeric id, null when unassigned | `step 3 — server assignment > assigns the chosen server by numeric id`, `> leaves the camera unassigned by default` |
| Footer | Absent before step 3 | `footer > has no footer buttons before the configuration step` |
| Cancel | Closes, adds nothing | `> cancel closes without adding anything` |
| Add Camera | Emits once and closes | `> adding closes the wizard too` |
| Reopen after cancel | Starts over rather than leaking the previous entry | `> starts over at step 1 after being cancelled` |

### Import — `SiteImporter.test.jsx` (39)

An .xlsx lands one of three ways, and they are not equally forgiving: `new`
creates a customer, `merge` matches sites by name and keeps the ones the file
does not mention, `replace` discards every existing site, level and device.

| Control | Expected | Test |
|---|---|---|
| File list | Lists .xlsx files; says so when empty | `the Drive file list > lists the .xlsx files it finds`, `> says so when nothing matches` |
| … signed out | Asks for sign-in, never calls Drive | `> asks for sign-in instead of calling Drive while signed out` |
| Search | Debounced — one request per pause | `> searches after the user stops typing` |
| Load more | Appends rather than replacing | `> appends the next page rather than replacing the list` |
| Drive refused | Offers re-consent, then reloads | `> offers a re-consent button when Drive refuses the folder` |
| Import | Downloads, parses, reports the counts | `the import summary > downloads, parses and reports what is in the file` |
| Friendly Name | From the file, or the existing customer's | `> prefills the friendly name from the file for an unknown customer`, `> prefills the existing customer's name when the file matches one` |
| … blank | Continue disabled | `> will not continue without a friendly name` |
| Parse failure | Reported; no dialog, no customer | `> reports a parse failure and opens nothing` |
| Unplaceable rows | Flagged in the summary | `> flags display level rows the file could not place` |
| Continue (unknown customer) | Creates it, no conflict step | `importing a customer that does not exist yet > creates it straight from the summary, with no conflict step` |
| … sheet fields | Recorded; no sheet to reuse | `> records the sheet the import created` |
| … quick links | Sheet link on every imported site | `> attaches the config sheet link to every imported site` |
| … address | From the first site in the file | `> takes the customer address from the first site in the file` |
| … navigation | Opens the imported customer | `> opens the customer it just imported` |
| … typed name | Wins over the file's | `> uses the name the user typed, not the one from the file` |
| Continue (known customer) | Asks how to import; changes nothing yet | `importing over a customer that already exists > asks how to import rather than choosing for the user` |
| … Back | Returns to the summary | `> goes back to the summary` |
| Merge | Warns first; nothing changes until accepted | `merge > warns first, and changes nothing until the warning is accepted` |
| … site matching | Keeps unmentioned sites, adds new ones, updates matches in place | `> keeps a site the file does not mention and adds the ones it does`, `> updates the matching site in place instead of adding a second one` |
| … sheet | Reuses the customer's, no second one | `> writes into the customer's existing sheet rather than making a second one` |
| … address | Filled only when the customer has none | `> fills in an address only when the customer has none`, `> leaves an address the customer already has alone` |
| … Back | Returns to the choice without merging | `> goes back to the choice without merging` |
| Replace gate 1 | Nothing replaced | `replace > does not replace anything at the first warning` |
| Replace gate 2 | Still nothing replaced; names the loss | `> does not replace anything at the second warning either`, `> names how many sites are about to be lost` |
| … Back | Returns to gate 1, not to the action | `> backs out of the last gate to the first warning, not to the action` |
| … confirmed | Every existing site dropped; config overwritten | `> drops every existing site once both gates are passed`, `> overwrites the customer address too, unlike merge` |
| … sheet failure | Sites left in place | `> leaves the sites in place when the sheet cannot be prepared` |
| After any import | Survives the load that follows it | `the import survives the load that follows it > a merge is not undone by the pre-import snapshot` (and replace) |
| Back | Returns to the customer list | `header > goes back to the customer list` |

The last row is a bug this layer found. Import rewrites the config tabs from
the workbook but never touches `SetupJson`, so for merge and replace the sheet
still held the pre-import snapshot — and `selectCustomer`, which the import
calls to open the customer, loaded it straight back over the merged state. The
import was silently undone every time. The imported layout is now written to
the sheet before navigating, and a failed write keeps the user on the importer
instead of dropping them into a view that would quietly revert.

### Recovery — `SetupSyncIndicator.test.jsx` (18), `CustomerDataGate.test.jsx` (19)

Every other entry in this layer is a write path. These two are what you press on
a bad day, and they were the last part of the app with no coverage at all.

**The conflict chip.** Two buttons decide whose work survives a collision, so
these assert on what lands on the sheet, not on which action fired — a spy would
pass with them wired backwards.

| Control | Expected | Test |
|---|---|---|
| Reload | Takes their version, drops mine, writes nothing | `a conflict > Reload takes their version and drops mine` |
| Overwrite | Puts mine on the sheet over theirs | `> Overwrite puts mine on the sheet, over theirs` |
| … forced | Does not re-raise the conflict it is resolving | `> Overwrite does not stall on the same conflict it is resolving` |
| Neither | Conflict stands; nothing written | `> leaves the conflict standing until one of them is pressed` |
| Retry (after a read) | Reads again — never turns into a write | `an error > Retry after a failed load reads again rather than writing` |
| Retry (after a write) | Writes again | `> Retry after a failed save writes again` |
| Retry (unhydrated) | Still refuses to write | `> Retry on an unhydrated customer still refuses to write` |
| Refresh | Pulls the sheet's current layout | `the refresh button > pulls the sheet's current layout` |
| Status | loading / saving / unavailable / idle / synced | `what the chip says > …` |
| Another customer's status | Ignored — no Overwrite offered on this one | `> ignores a status belonging to a different customer` |

**The gate.** The visible half of "never render a layout that was not read".

| State | Expected | Test |
|---|---|---|
| hydrated / absent | App renders | `when the layout has been read > renders the app once the customer is hydrated`, `> renders the app when the sheet genuinely has no layout yet` |
| no customer / local-only | App renders | `> renders the app when no customer is selected at all`, `> leaves a local customer with no linked file alone` |
| loading | Blocked, spinner | `when the layout has not been read > blocks with a spinner while the read is in flight` |
| not started | Blocked — unknown is not absent | `> blocks before the read has even started` |
| failed | Blocked, with the underlying reason | `> blocks with an error when the read failed`, `> shows the underlying reason when there is one` |
| another customer's error | Not borrowed | `> does not borrow another customer's error message` |
| .xlsx, no Sheet | Blocked, told how to fix it, no dead retry | `a customer linked to an .xlsx but no Google Sheet > …` |
| Try again | Reads and unblocks, or stays blocked | `Try again > reads the sheet and lets the app through when it works`, `> stays blocked when the read fails again` |
| damaged | Says damaged, not network; offers rebuild | `a SetupJson tab that will never parse > says it is damaged rather than blaming the network`, `> offers the rebuild, which an ordinary failure does not` |
| Rebuild | Warns what is lost, declines cleanly, replaces the damaged tab | `> warns what the rebuild cannot bring back, and does nothing if declined`, `> rebuilds from the config tabs and lets the app through once confirmed`, `> replaces the damaged tab so the next load is not stuck too`, `> stays blocked when the rebuild itself fails` |

Both suites were mutation-checked rather than trusted for passing: making the
gate always render its children fails 14 of its 19, and swapping Reload with
Overwrite fails 3 of the chip's 18.

### Support info — `CustomerSupportDialog.test.jsx` (25)

Four fields the downstream system reads off the Customer tab. Small, but it
patches `config` rather than replacing it, so the failure mode is not a wrong
support value — it is a support edit quietly wiping the customer's address.

| Control | Expected | Test |
|---|---|---|
| Open | Named customer, values from storage | `opening the dialog > names the customer it is editing`, `> starts from the customer's stored support settings` |
| … no customer | Renders nothing | `> renders nothing without a customer` |
| Provider | Not set / Ensight / APS / Other offered and stored | `maintenance responsibility > offers Not set, Ensight, APS and Other`, `> stores the chosen provider` |
| … Other | Reveals the free-text box; stores it trimmed | `> reveals the free-text box when Other is chosen`, `> stores the typed name, trimmed` |
| … changed away | Stale free text cleared | `> clears a stale free-text name when the provider changes away from Other` |
| … inconsistent row | Leftover text reconciled on save | `> drops leftover free text the sheet already disagrees with` |
| … Not set | Provider cleared | `> clears the provider entirely on Not set` |
| Enterprise / 24h | Toggle from the switch or the whole card | `the support toggles > turns Enterprise Site on from the switch`, `> toggles from the card as well as the switch` |
| … independence | Turning one off leaves the other | `> turns one off again without disturbing the other` |
| Save | Pushes the customer with the new values | `saving > pushes the customer to the sheet with the new support values` |
| … address | Kept locally and on the sheet write | `> keeps the customer's address — a support edit is not a config replacement` |
| … success | Closes | `> closes once the sheet has taken it` |
| Sheet failure | Stays open and says so | `when the sheet write fails > says so instead of closing as though it saved` |
| … local state | Change kept so a retry has something to send | `> keeps the local change so a retry has something to send` |
| … retry | Error cleared on success | `> clears the error when the retry succeeds` |
| No writable sheet | Saves locally, never syncs | `a customer with no writable sheet > saves locally and never calls the sync` |
| Cancel | Changes nothing, writes nothing | `cancelling > changes nothing and writes nothing` |
| … reopen | Abandoned edit not carried forward | `> does not carry the abandoned edit into the next open` |

Mutation-checked: replacing the config patch with a whole-config write, and
closing the dialog despite a failed sheet write, each fail one test. A third
mutation — dropping the save-time reconciliation of `maintenanceOther` —
initially survived, because the provider dropdown already clears that field on
change; the inconsistent-row case above was added to reach the guard, and now
kills it.

---

## Layer 4 — the scenarios that matter

### Two people, two machines, one sheet

`useAppStore.twoClient.test.js` (3) — the acceptance scenario. A edits and
saves; B opens the same customer on another machine and sees A's work; B edits;
A reloads and sees B's.

- `round-trips a full editing session in both directions`
- `flags a conflict instead of silently overwriting a newer save`
- `skips the write entirely when nothing actually changed`

### Never lose someone's layout

`useAppStore.dataLoss.test.js` (11) — the failure chain behind the original
"random issues": a failed read used to render local stubs as real data, and the
next edit auto-saved those stubs over a complete layout.

- A failed read marks the customer failed and leaves `garages` unloaded.
- No write is attempted afterwards — not the debounced one, not an explicit save.
- The sheet is left byte-for-byte intact.
- A successful retry hydrates the real layout, and only then is saving allowed.
- A sheet that genuinely has no layout is treated as absent, not failed, so a
  first save is allowed.
- A browser upgrading from the previous build does not auto-save its stale
  stubs, and replaces them on first load.
- A SetupJson tab damaged by an older build is reported as damaged (not as a
  transient failure) and recovers via a rebuild from the config tabs.

### Local storage holds pointers only

`localPersistence.test.js` (4) — a sheet-backed customer keeps ids, names and
the spreadsheet link and nothing else, so nothing can be shown that is not on
the sheet. Floor-plan backgrounds are never serialized. Customers with no
linked sheet are left as they were.

---

## Gaps

Named here so they are visible rather than assumed covered.

- **DisplaySchedules and Networking are not mirrored.** By design — the team
  hand-edits them, so a save must not rewrite them. Only tested from the
  "leave it alone" side (`DisplaySchedules stays out of the write-side mirror`),
  not from an "app is authoritative" side, because it is not.
- **Open-from-Drive conversion** (xlsx → Sheet) is exercised through
  `ExcelParserService.test.js` and `OpenConfigFromDriveService` mocks, not
  end to end against a real conversion.
- **Floor-plan image upload** is covered for the geometry
  (`floorPlanBackground.test.js`) but not for the upload control itself.
- **PDF export** is not covered; `EditorView` asserts only that the export path
  is invoked, and skipped for an empty level.
- **The dialogs mocked out of the component tests** — app settings,
  report issue, customer map — have no tests of their own. None of the three
  remaining ones writes to a config tab.
- **Presentational components** — `MapCanvas`, `CustomerMapDialog`,
  `TrafficFlowView`, `ContactsSidebar`, `Weather` — have no
  store or sync references and are not covered directly. The placement path
  through `MapCanvas` is covered from `EditorView`.

## Adding a control

If you add a field or a button, add a row above and the test behind it. The
test belongs in the layer that matches the question:

- writes a new column → layer 1 (`fieldMatrix`)
- a new entity or a new delete path → layer 2 (`actionMatrix`)
- a new control on an existing screen → layer 3 (`components/__tests__`)

Component tests assert on what reaches the service, not on what the screen
says, because the screen agreeing with itself is exactly the failure mode this
whole suite exists to catch.
