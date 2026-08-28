-- Supabase Storage buckets for floor-plan backgrounds and device/sign photos,
-- plus Row Level Security across every table and both buckets.
--
-- This is an internal single-org tool (no per-customer permission tiers exist in the
-- legacy app — GoogleDriveService.js gated purely on the @ensight-technologies.com
-- email domain), so RLS here is intentionally flat: any authenticated user whose JWT
-- email is on the Ensight domain can read/write everything. Buckets are private;
-- images are served via short-lived signed URLs, never public URLs.

insert into storage.buckets (id, name, public)
values ('floor-plans', 'floor-plans', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('device-photos', 'device-photos', false)
on conflict (id) do nothing;

create or replace function is_ensight_staff()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') like '%@ensight-technologies.com';
$$;

-- ---------------------------------------------------------------------------
-- Table RLS
-- ---------------------------------------------------------------------------

alter table customers enable row level security;
alter table display_schedules enable row level security;
alter table garages enable row level security;
alter table servers enable row level security;
alter table display_groups enable row level security;
alter table sensor_groups enable row level security;
alter table mdf_idf_locations enable row level security;
alter table levels enable row level security;
alter table devices enable row level security;

create policy "ensight staff can do anything with customers"
  on customers for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with display_schedules"
  on display_schedules for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with garages"
  on garages for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with servers"
  on servers for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with display_groups"
  on display_groups for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with sensor_groups"
  on sensor_groups for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with mdf_idf_locations"
  on mdf_idf_locations for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with levels"
  on levels for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with devices"
  on devices for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

-- ---------------------------------------------------------------------------
-- Storage RLS
-- ---------------------------------------------------------------------------

create policy "ensight staff can read floor plans"
  on storage.objects for select
  using (bucket_id = 'floor-plans' and is_ensight_staff());

create policy "ensight staff can write floor plans"
  on storage.objects for insert
  with check (bucket_id = 'floor-plans' and is_ensight_staff());

create policy "ensight staff can update floor plans"
  on storage.objects for update
  using (bucket_id = 'floor-plans' and is_ensight_staff())
  with check (bucket_id = 'floor-plans' and is_ensight_staff());

create policy "ensight staff can delete floor plans"
  on storage.objects for delete
  using (bucket_id = 'floor-plans' and is_ensight_staff());

create policy "ensight staff can read device photos"
  on storage.objects for select
  using (bucket_id = 'device-photos' and is_ensight_staff());

create policy "ensight staff can write device photos"
  on storage.objects for insert
  with check (bucket_id = 'device-photos' and is_ensight_staff());

create policy "ensight staff can update device photos"
  on storage.objects for update
  using (bucket_id = 'device-photos' and is_ensight_staff())
  with check (bucket_id = 'device-photos' and is_ensight_staff());

create policy "ensight staff can delete device photos"
  on storage.objects for delete
  using (bucket_id = 'device-photos' and is_ensight_staff());
