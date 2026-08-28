-- Flatten servers.ports (jsonb array, max 4 per the UI's "Number of ports"
-- selector) into 4 fixed port slots — matches this project's established
-- preference for browsable flat columns over jsonb blobs (see 0009-0011's
-- device field normalization). port_count is stored explicitly rather than
-- inferred from which slots are non-empty, because an explicitly-selected
-- port with blank mac/ip is a real, reachable state (same trap as
-- sign_details.uses_inserts in 0010 — empty isn't the same as absent).
--
-- Also drops ram/ssd (not wanted) in favor of a hardware model field
-- (FLIv2 / FLIv2 Edge), and simplifies the OS field's *allowed* values in
-- app code only (Linux/Ubuntu/Windows, no version breakdown) — os stays a
-- plain text column, no schema change needed for that part.

alter table servers add column model text not null default '';
alter table servers add column port_count smallint not null default 1;

alter table servers add column port1_mac text not null default '';
alter table servers add column port1_ip text not null default '';
alter table servers add column port1_dhcp boolean not null default false;

alter table servers add column port2_mac text not null default '';
alter table servers add column port2_ip text not null default '';
alter table servers add column port2_dhcp boolean not null default false;

alter table servers add column port3_mac text not null default '';
alter table servers add column port3_ip text not null default '';
alter table servers add column port3_dhcp boolean not null default false;

alter table servers add column port4_mac text not null default '';
alter table servers add column port4_ip text not null default '';
alter table servers add column port4_dhcp boolean not null default false;

-- Backfill from the jsonb array before dropping it.
update servers set
  port_count = greatest(1, least(4, jsonb_array_length(ports))),
  port1_mac = coalesce(ports->0->>'mac', ''),
  port1_ip = coalesce(ports->0->>'ip', ''),
  port1_dhcp = coalesce((ports->0->>'dhcp')::boolean, false),
  port2_mac = coalesce(ports->1->>'mac', ''),
  port2_ip = coalesce(ports->1->>'ip', ''),
  port2_dhcp = coalesce((ports->1->>'dhcp')::boolean, false),
  port3_mac = coalesce(ports->2->>'mac', ''),
  port3_ip = coalesce(ports->2->>'ip', ''),
  port3_dhcp = coalesce((ports->2->>'dhcp')::boolean, false),
  port4_mac = coalesce(ports->3->>'mac', ''),
  port4_ip = coalesce(ports->3->>'ip', ''),
  port4_dhcp = coalesce((ports->3->>'dhcp')::boolean, false)
where jsonb_typeof(ports) = 'array' and jsonb_array_length(ports) > 0;

alter table servers drop column ports;
alter table servers drop column ram;
alter table servers drop column ssd;
