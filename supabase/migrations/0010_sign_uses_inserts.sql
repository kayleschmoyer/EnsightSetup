-- A sign can be in "monument / multi-insert" mode with zero inserts currently
-- added (e.g. the user just removed the last one) — that's a different state
-- from a plain single-controller sign, even though both have zero sign_inserts
-- rows. Row count alone can't distinguish them, so it needs its own flag
-- (mirrors the app's Array.isArray(device.inserts) check).
alter table sign_details add column uses_inserts boolean not null default false;
