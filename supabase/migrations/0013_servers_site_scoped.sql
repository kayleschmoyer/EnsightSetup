-- Servers move from customer-wide to site-scoped, matching every other child
-- table under a site (levels, zones, display_groups, sensor_groups,
-- mdf_idf_locations). Previously a server added under one site silently
-- mirrored onto every other site of the same customer (see the in-memory-only
-- applyServersToSites, still used by the legacy Drive-import Sheets sync path
-- and unaffected by this DB change — that feature works off the customer-wide
-- Networking sheet tab regardless of how the DB scopes servers).
--
-- Also adds the fields the Servers tab UI actually collects (type, os, ram,
-- ssd, ports, splashtop credentials) — these were never persisted before, so
-- editing a server always showed them blank. The original columns
-- (manufacturer, device_type, status, location, mdf_idf_location, ip, mac,
-- ip_assignment_method, subnet, gateway, dns, username, password,
-- stream_address) are kept as-is: they mirror the legacy Google Sheets
-- "Networking" tab columns 1:1 (see configSheetSchema.js's Networking tab
-- headers), which the Drive import/export feature still round-trips.

alter table servers add column site_id uuid references sites(id) on delete cascade;

update servers s
set site_id = (
  select si.id from sites si
  where si.customer_id = s.customer_id
  order by si.created_at
  limit 1
)
where s.site_id is null;

delete from servers where site_id is null;

alter table servers alter column site_id set not null;

drop index if exists idx_servers_customer;
alter table servers drop column customer_id;

create index idx_servers_site on servers(site_id);

alter table servers add column type text not null default '';
alter table servers add column os text not null default '';
alter table servers add column ram text not null default '';
alter table servers add column ssd text not null default '';
alter table servers add column ports jsonb not null default '[]'::jsonb;
alter table servers add column splashtop_user text not null default '';
alter table servers add column splashtop_password text not null default '';
alter table servers add column splashtop_url text not null default '';
