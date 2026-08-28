-- Rename the "garage" domain concept to "site": not every site is a literal
-- parking garage (some are outdoor lots, or other non-garage facilities), and
-- the app/UI language had already started drifting toward "site" in places.
-- No production data depends on the old names — safe to rename in place.

alter table garages rename to sites;

alter table display_groups rename column garage_id to site_id;
alter table sensor_groups rename column garage_id to site_id;
alter table mdf_idf_locations rename column garage_id to site_id;
alter table levels rename column garage_id to site_id;
alter table zones rename column garage_id to site_id;
alter table sign_details rename column display_garage_id to display_site_id;

alter index idx_garages_customer rename to idx_sites_customer;
alter index idx_display_groups_garage rename to idx_display_groups_site;
alter index idx_sensor_groups_garage rename to idx_sensor_groups_site;
alter index idx_mdf_idf_locations_garage rename to idx_mdf_idf_locations_site;
alter index idx_levels_garage rename to idx_levels_site;
alter index idx_zones_garage rename to idx_zones_site;

alter trigger trg_garages_updated_at on sites rename to trg_sites_updated_at;

alter policy "ensight staff can do anything with garages" on sites
  rename to "ensight staff can do anything with sites";
