-- RLS policies (0002_storage_and_rls.sql) restrict *rows*, but PostgREST's
-- anon/authenticated roles also need the underlying SQL privilege to touch a
-- table at all — tables created via a raw migration (unlike ones created
-- through the Supabase dashboard) don't get that grant automatically. Without
-- this, every query fails with "permission denied for table X" (42501) before
-- RLS is even evaluated, regardless of how correct the policies are.
--
-- Safe to grant broadly here because RLS is what actually decides which rows
-- are visible/writable — this is the standard Supabase pattern (grant wide at
-- the SQL-privilege level, restrict with policies).

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on
  customers, display_schedules, garages, servers, display_groups,
  sensor_groups, mdf_idf_locations, levels, devices
to anon, authenticated, service_role;

-- Any table created by a later migration gets the same treatment automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
