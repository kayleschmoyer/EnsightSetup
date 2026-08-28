-- Breaks the single customers.config jsonb blob into focused tables, and adds
-- config_sheet_name: the Google Sheets export title, computed once from
-- friendly_name at customer-creation time and never recomputed afterward, so
-- renaming a customer later doesn't change which spreadsheet a later export
-- targets. Mirrors configSheetTitle() in src/lib/configSheetSchema.js.

alter table customers add column config_sheet_name text;

update customers
set config_sheet_name = trim(
  regexp_replace(trim(coalesce(nullif(friendly_name, ''), 'Customer')), '[^[:alnum:][:space:]_-]', '', 'g')
) || '-config'
where config_sheet_name is null;

alter table customers alter column config_sheet_name set not null;

create type maintenance_provider_type as enum ('ensight', 'aps', 'other');

create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references customers(id) on delete cascade,
  address text not null default '',
  city text not null default '',
  state text not null default '',
  zip text not null default '',
  maps_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table customer_support (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references customers(id) on delete cascade,
  maintenance_provider maintenance_provider_type,
  maintenance_other text not null default '',
  enterprise_site boolean not null default false,
  support_24_hour boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backfill from the jsonb blob being retired below.
insert into customer_addresses (customer_id, address, city, state, zip, maps_url)
select id,
  coalesce(config->>'address', ''),
  coalesce(config->>'city', ''),
  coalesce(config->>'state', ''),
  coalesce(config->>'zip', ''),
  coalesce(config->>'mapsUrl', '')
from customers;

insert into customer_support (customer_id, maintenance_provider, maintenance_other, enterprise_site, support_24_hour)
select id,
  nullif(config->'support'->>'maintenanceProvider', '')::maintenance_provider_type,
  coalesce(config->'support'->>'maintenanceOther', ''),
  coalesce((config->'support'->>'enterpriseSite')::boolean, false),
  coalesce((config->'support'->>'support24Hour')::boolean, false)
from customers;

alter table customers drop column config;

create trigger trg_customer_addresses_updated_at before update on customer_addresses
  for each row execute function set_updated_at();
create trigger trg_customer_support_updated_at before update on customer_support
  for each row execute function set_updated_at();

alter table customer_addresses enable row level security;
alter table customer_support enable row level security;

create policy "ensight staff can do anything with customer_addresses"
  on customer_addresses for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

create policy "ensight staff can do anything with customer_support"
  on customer_support for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

grant select, insert, update, delete on customer_addresses, customer_support
  to anon, authenticated, service_role;
