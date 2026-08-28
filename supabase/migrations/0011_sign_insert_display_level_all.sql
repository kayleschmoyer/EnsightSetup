-- Each insert on a monument sign has its own "display on all levels" flag,
-- independent of the sign-level one used when the sign has no inserts (see
-- createSignInsert in src/lib/signInserts.js). Same "zero rows is ambiguous"
-- problem as 0010's uses_inserts: no sign_insert_levels rows means either
-- "no levels chosen yet" or "all levels" — needs its own column.
alter table sign_inserts add column display_level_all boolean not null default false;
