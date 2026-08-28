-- Remembers the Google Sheet a customer exports to (see api/export-to-sheets.js),
-- so repeat exports reuse the same spreadsheet instead of creating a new one
-- every time. Nullable: unset until the first export runs.

alter table customers add column spreadsheet_id text;
alter table customers add column spreadsheet_url text;
alter table customers add column last_exported_at timestamptz;
